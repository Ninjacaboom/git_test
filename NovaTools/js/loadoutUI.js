/**
 * loadoutUI.js - orchestrator for the loadout manager UI.
 *
 * This file wires together the sub-modules and owns:
 *   - initLoadoutUI (data bootstrap + tab restore)
 *   - buildShipSelector
 *   - selectShip
 *   - renderAllSlots / renderAllSlotColumns
 *   - getSectionDefs / renderColumnSections / renderSection
 *   - renderWeaponColumn / renderSystemsColumn
 *   - bindSlotClicks / resetCategory
 *   - Tab management (snapshotCurrentTab, restoreTab, persistTabs, switchTab, addTab, closeTab)
 *   - bindSectionDrag / renderTabBar
 */

import {
  initLoadoutData, getShipConfig, getItemStats,
  getCompatibleItems, extractSlots, buildDefaultLoadout,
  calculateStats, buildPipAllocation, hasCraftingData, isLoadoutForOtherHull
} from './loadoutManager.js';
import {
  saveHash, saveLoadout, loadLoadout,
  saveShieldSelection, loadShieldSelection,
  saveDisabledPorts, loadDisabledPorts,
  saveTabs, loadTabs, saveSectionOrder, loadSectionOrder,
  createSharedBuild
} from './stateStore.js';

import * as state from './loadoutState.js';
import {
  setAllShips, setAllHardpoints, setAllVehicles, setAllItems,
  setCurrentShipName, setCurrentSlots, setCurrentLoadout,
  setCurrentQFuelCapacity, setDefaultLoadout, setCurrentPipAllocation,
  setCurrentShieldOverrides, setCurrentDisabledPorts, setTabs, setActiveTabIdx,
  setSectionOrder, setWeaponTierMap, setWeaponImmuneMap, setWeaponSustMap, setWeaponAmmoMap,
  DEFAULT_SECTION_ORDER, sectionOrder
} from './loadoutState.js';

import { getImmuneShips, TOP_TIER } from './tierEngine.js';
import { rebuildPipAllocation, setRenderCallbacks as setPipRenderCallbacks } from './pipPanel.js';
import { renderStats, injectWeaponCapBadge, renderSystemSlot, renderThrusterSlot, renderInterdictionSlot, renderSalvageSummary, setRenderCallbacks as setStatsRenderCallbacks } from './statsPanel.js';
import {
  syncModuleSubPorts, renderModuleSlot, gatherCurrentBuild,
  initLoadoutDropdown, refreshLoadoutDropdown, applyBuild, applySharedBuild,
  currentLoadoutName, setCurrentLoadoutName, showToast,
  setRenderCallbacks as setBuildRenderCallbacks
} from './buildManager.js';
import { openCraftingSummary } from './craftingSummaryUI.js';
import { openDeflectionCalc } from './deflectionCalcUI.js';
import { openTtkCalc } from './ttkCalcUI.js';
import {
  renderWeaponSlot, renderTurretGroup, renderMissileSlot,
  openPicker, rebuildSlotPorts, bindImmuneDotTooltips, classifyTurret,
  setRenderCallbacks as setWeaponRenderCallbacks
} from './weaponColumn.js';
import { setRenderCallbacks as setCraftingRenderCallbacks } from './craftingUI.js';
import { escapeHtml, bindGlobalDropdownCloser } from './utils.js';

// ── Wire up render callbacks between modules ───────────────────────────────────

function _renderWeaponColumn() { renderWeaponColumn(); }
function _renderSystemsColumn() { renderSystemsColumn(); }
function _renderAllSlots() { renderAllSlots(); }
function _renderStats() { renderStats(); }
function _persistTabs() { persistTabs(); }
function _rebuildPipAllocation(skip) { rebuildPipAllocation(skip); }
function _syncModuleSubPorts() { syncModuleSubPorts(); }

// Called once - after all function declarations are hoisted.
function wireCallbacks() {
  setPipRenderCallbacks(_renderStats, _renderWeaponColumn, _renderSystemsColumn);
  setStatsRenderCallbacks(_renderWeaponColumn, _renderSystemsColumn);
  setBuildRenderCallbacks(_rebuildPipAllocation, _renderAllSlots, _renderStats, _persistTabs);
  setWeaponRenderCallbacks(_renderAllSlots, _renderStats, _persistTabs, _syncModuleSubPorts);
  // Crafting popover triggers a full panel + stats redraw on every slider tick.
  // rebuildPipAllocation FIRST so Power Pips modifiers (which add/remove
  // segments on power plants) actually grow/shrink the pip pool before
  // the panels read from it.
  setCraftingRenderCallbacks(() => {
    _rebuildPipAllocation(true);
    _renderSystemsColumn();
    _renderWeaponColumn();
    _renderStats();
    _persistTabs();
  });
}

// ── Public entry point ─────────────────────────────────────────────────────────

export function initLoadoutUI(ships, hardpoints, items, vehicles, restoredShip, weapons, sharedBuild) {
  wireCallbacks();

  setAllShips(ships);
  setAllHardpoints(hardpoints || []);
  setAllVehicles(vehicles || []);
  setAllItems(items);

  setWeaponTierMap(new Map());
  setWeaponImmuneMap(new Map());
  setWeaponSustMap(new Map());
  setWeaponAmmoMap(new Map());
  state.setWeaponByKey(new Map());

  if (weapons) {
    for (const w of weapons) {
      const key = `${w.Name}||${w.Size}`;
      state.weaponTierMap.set(key, w._tier);
      if (w._tier && w._tier !== TOP_TIER) {
        const { immune } = getImmuneShips(w, ships);
        state.weaponImmuneMap.set(key, immune.map(s => s.Name));
      }
      if (w.Sustained != null) state.weaponSustMap.set(key, w.Sustained);
      state.weaponAmmoMap.set(key, {
        effective: w.AmmoEffective,
        total: w.AmmoCapacity,
        isEnergy: w.IsEnergy
      });
      // Snapshot the parsed base weapon record so Impact Force crafting can
      // re-derive its deflection tier per port without redoing the full
      // parse pipeline.
      state.weaponByKey.set(key, w);
    }
  }

  initLoadoutData(items);
  buildShipSelector();

  // Restore persisted section order
  const savedOrder = loadSectionOrder();
  if (Array.isArray(savedOrder) && savedOrder.length > 0) {
    const savedKeys = new Set(savedOrder.map(s => s.key));
    const merged = [...savedOrder];
    for (const def of DEFAULT_SECTION_ORDER) {
      if (!savedKeys.has(def.key)) merged.push({ ...def });
    }
    setSectionOrder(merged);
  }

  // Restore persisted tabs or start with a single empty tab
  const savedTabs = loadTabs();
  if (savedTabs) {
    setTabs(savedTabs.tabs);
    setActiveTabIdx(savedTabs.activeIdx);
    renderTabBar();
    restoreTab(state.activeTabIdx);
  } else {
    renderTabBar();
    if (restoredShip && !sharedBuild) {
      const exists = state.allHardpoints.some(h => h.Name === restoredShip);
      if (exists) selectShip(restoredShip);
    }
  }

  // A shared build always opens in a fresh tab so it doesn't clobber
  // the user's existing loadouts.
  if (sharedBuild && restoredShip) {
    addTab();
    selectShip(restoredShip);
    applySharedBuild(sharedBuild);
  }

  // Wire Share button
  initShareButton();
  // Wire Materials (crafting summary) button
  initMaterialsButton();
  // Wire Deflection (calculator) button
  initDeflectionButton();
  // Wire Time to Kill (calculator) button
  initTtkButton();
}

// ── Share button ──────────────────────────────────────────────────────────────

function initShareButton() {
  const btn = document.getElementById('loadoutShareBtn');
  if (!btn) return;
  // Property assignment, NOT addEventListener: init runs again on every build
  // switch (loadBuild -> initLoadoutUI) and the button survives in index.html,
  // so a listener would accumulate - one click then creates one shared build
  // PER init run. Same pattern for the three sibling buttons below.
  btn.onclick = async () => {
    if (!state.currentShipName) return;
    const full = gatherCurrentBuild();
    // Diff loadout against defaults - only include changed ports
    const diff = {};
    for (const [port, cls] of Object.entries(full.loadout)) {
      if (state.defaultLoadout[port] !== cls) diff[port] = cls;
    }
    const payload = { l: diff, p: full.pips, s: full.shields, d: full.disabled, c: full.crafting };
    try {
      const url = await createSharedBuild(state.currentShipName, payload);
      await navigator.clipboard.writeText(url);
      showToast('Ship loadout URL copied to clipboard');
    } catch {
      showToast('Failed to create share link', { type: 'error' });
    }
  };
}

// ── Materials button (crafting summary modal) ────────────────────────────────

function initMaterialsButton() {
  const btn = document.getElementById('loadoutMaterialsBtn');
  if (!btn) return;
  btn.onclick = () => {
    if (!state.currentShipName) return;
    openCraftingSummary();
  };
}

// ── Deflection button (find-deflection calculator modal) ─────────────────────

function initDeflectionButton() {
  const btn = document.getElementById('loadoutDeflectionBtn');
  if (!btn) return;
  btn.onclick = () => {
    if (!state.currentShipName) return;
    openDeflectionCalc();
  };
}

// ── Time to Kill button (TTK calculator modal) ───────────────────────────────

function initTtkButton() {
  const btn = document.getElementById('loadoutTtkBtn');
  if (!btn) return;
  btn.onclick = () => {
    if (!state.currentShipName) return;
    openTtkCalc();
  };
}

// ── Ship selector ──────────────────────────────────────────────────────────────

function buildShipSelector() {
  const toggle = document.getElementById('shipToggle');
  const dropdown = document.getElementById('shipDropdown');
  const search = document.getElementById('shipSearch');
  const list = document.getElementById('shipList');

  const shipNames = state.allHardpoints
    .map(h => h.Name)
    .sort();

  // Keyboard navigation state. `keynavIndex` tracks which option the user is
  // currently arrow-navigating to (-1 = none). The keynav class is rendered
  // distinctly from `.active` (which marks the currently selected ship)
  // and from `:hover` (mouse pointer); a typed filter resets it to 0 so
  // pressing Enter right after typing picks the top match.
  let keynavIndex = -1;

  function closeDropdown() {
    dropdown.classList.remove('open');
    toggle.classList.remove('open');
  }

  function applyKeynavClass() {
    const opts = list.querySelectorAll('.ms-ship-opt');
    opts.forEach((el, i) => el.classList.toggle('keynav', i === keynavIndex));
    if (keynavIndex >= 0 && opts[keynavIndex]) {
      opts[keynavIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function renderList(filter) {
    const filtered = filter
      ? shipNames.filter(n => n.toLowerCase().includes(filter.toLowerCase()))
      : shipNames;
    list.innerHTML = filtered.map(name =>
      `<div class="ms-ship-opt${name === state.currentShipName ? ' active' : ''}" data-ship="${escapeHtml(name)}">${escapeHtml(name)}</div>`
    ).join('');

    list.querySelectorAll('.ms-ship-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        selectShip(opt.dataset.ship);
        closeDropdown();
      });
    });

    // After a filter pass, default the keyboard focus to the top match so
    // `type "as" → Enter` lands on Asgard without an extra ArrowDown press.
    keynavIndex = filtered.length > 0 ? 0 : -1;
    applyKeynavClass();
  }

  toggle.onclick = () => {
    const isOpen = dropdown.classList.contains('open');
    document.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.ms-toggle.open').forEach(t => t.classList.remove('open'));
    if (!isOpen) {
      dropdown.classList.add('open');
      toggle.classList.add('open');
      search.value = '';
      renderList('');
      search.focus();
    }
  };

  // Property assignments (like toggle.onclick above): buildShipSelector re-runs
  // on every build switch and #shipSearch persists in index.html, so
  // addEventListener would stack handlers - each holding the PREVIOUS build's
  // shipNames closure. Assignment replaces the stale handler instead.
  search.oninput = () => renderList(search.value);

  // Keyboard nav on the search input: arrow keys move the highlight, Enter
  // commits, Escape closes the dropdown without changing the selection.
  search.onkeydown = (e) => {
    const opts = list.querySelectorAll('.ms-ship-opt');
    if (opts.length === 0 && e.key !== 'Escape') return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        keynavIndex = Math.min(opts.length - 1, keynavIndex + 1);
        applyKeynavClass();
        break;
      case 'ArrowUp':
        e.preventDefault();
        keynavIndex = Math.max(0, keynavIndex - 1);
        applyKeynavClass();
        break;
      case 'Enter':
        e.preventDefault();
        if (keynavIndex >= 0 && opts[keynavIndex]) {
          selectShip(opts[keynavIndex].dataset.ship);
          closeDropdown();
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeDropdown();
        break;
    }
  };

  // Outside-click closing is handled by the shared delegated closer (idempotent,
  // binds once) - #shipSelect uses the standard .ms-toggle / .ms-dropdown
  // classes it targets. A local document listener here would leak one copy per
  // build switch.
  bindGlobalDropdownCloser();

  renderList('');
}

// ── Select ship ────────────────────────────────────────────────────────────────

function selectShip(shipName) {
  setCurrentShipName(shipName);
  setCurrentLoadoutName('');
  saveHash({ ship: shipName, weapon: null });
  document.getElementById('shipToggle').innerHTML =
    `${escapeHtml(shipName)} <span class="ms-arrow">&#9662;</span>`;
  refreshLoadoutDropdown();

  const config = getShipConfig(state.allHardpoints, shipName);
  if (!config) {
    document.getElementById('loadoutPlaceholder').textContent = 'Ship hardpoint data not found';
    document.getElementById('loadoutMain').style.display = 'none';
    document.getElementById('loTopRow').style.display = 'none';
    document.getElementById('loadoutPlaceholder').style.display = '';
    return;
  }

  // Attach weapon pool size and emissions from vehicle data
  const vehicle = state.allVehicles.find(v => v.Name === shipName);
  config.weaponPoolSize = vehicle?.ResourceNetwork?.ItemPools?.WeaponPoolSize || 0;
  const wpnMods = config.Hardpoints?.Components?.Systems?.Controllers?.Weapons?.Modifiers;
  config.weaponAmmoMult = wpnMods?.MaxAmmoLoadMultiplier ?? 1;
  config.weaponRegenMult = wpnMods?.MaxRegenPerSecMultiplier ?? 1;
  config.crossSection = vehicle?.Emissions?.CrossSection || null;
  config.signalMultipliers = vehicle?.Armor?.SignalMultipliers || { Infrared: 1, Electromagnetic: 1, CrossSection: 1 };
  // Stash armor stats (Health / Damage Deflection / Durability damage modifiers)
  // for the Ship Stats Armor section. A handful of real vehicles (e.g. the
  // Greycat PTV) have no Armor block in the source data - they're not
  // armoured in the gameplay sense. Render those as zeros so the Armor row
  // is still present in Ship Details instead of dropping the whole section.
  const armorRaw = vehicle?.Armor;
  config.armor = {
    health: armorRaw?.Durability?.Health || 0,
    deflPhys: armorRaw?.DamageDeflection?.Physical || 0,
    deflEnergy: armorRaw?.DamageDeflection?.Energy || 0,
    modPhys: armorRaw?.Durability?.DamageMultipliers?.Physical ?? 1,
    modEnergy: armorRaw?.Durability?.DamageMultipliers?.Energy ?? 1
  };
  // Stash hull stats (structural HP, vital parts, dimensions, mass, damage/sig
  // modifiers, penetration) for the Ship Stats Hull section. Note that hull
  // damage modifiers come from Armor.DamageMultipliers (top-level), distinct
  // from Armor.Durability.DamageMultipliers used by the Armor section.
  const hullRaw = vehicle?.Hull;
  if (hullRaw) {
    const sumObj = (o) => Object.values(o || {}).reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);
    const vitalParts = hullRaw.StructureHealthPoints?.VitalParts || {};
    const parts = hullRaw.StructureHealthPoints?.Parts || {};
    const totalHP = sumObj(vitalParts) + sumObj(parts);
    config.hull = {
      size: vehicle.Size || 0,
      dimensions: vehicle.Dimensions || null,
      mass: vehicle.Mass || 0,
      totalHP,
      vitalParts: { ...vitalParts },
      damageModPhys: armorRaw?.DamageMultipliers?.Physical ?? 1,
      damageModEnergy: armorRaw?.DamageMultipliers?.Energy ?? 1,
      damageModDist: armorRaw?.DamageMultipliers?.Distortion ?? 1,
      sigEM: armorRaw?.SignalMultipliers?.Electromagnetic ?? 1,
      sigCS: armorRaw?.SignalMultipliers?.CrossSection ?? 1,
      sigIR: armorRaw?.SignalMultipliers?.Infrared ?? 1,
      penFuse: hullRaw.PenetrationDamageMultiplier?.Fuse ?? 1,
      penComponent: hullRaw.PenetrationDamageMultiplier?.Component ?? 1
    };
  } else {
    config.hull = null;
  }
  config.baseCargo = vehicle?.Cargo?.CargoGrid || 0;
  // Stash raw cargo triple (CargoContainers / CargoGrid / Storage) so the
  // expanded overlay's "Carrying Capacity" block can show Storage separately.
  config.cargo = vehicle?.Cargo ? {
    containers: vehicle.Cargo.CargoContainers || 0,
    grid: vehicle.Cargo.CargoGrid || 0,
    storage: vehicle.Cargo.Storage || 0
  } : null;
  // Fuel tank capacities - raw values are in µL (1 SCU == 1 M µL).
  // QD range is computed in renderStats from the currently equipped QD's
  // MicroUnitPerSec and this QuantumFuelCapacity.
  config.fuel = vehicle?.FuelManagement ? {
    hydrogenCapacity: vehicle.FuelManagement.FuelCapacity || 0,
    quantumCapacity: vehicle.FuelManagement.QuantumFuelCapacity || 0
  } : null;
  // Insurance claim times (in minutes) and expedite cost (in aUEC).
  config.insurance = vehicle?.Insurance ? {
    standardClaimMins: vehicle.Insurance.StandardClaimTime || 0,
    expeditedClaimMins: vehicle.Insurance.ExpeditedClaimTime || 0,
    expeditedCost: vehicle.Insurance.ExpeditedCost || 0
  } : null;
  const fc = vehicle?.FlightCharacteristics;
  if (fc) {
    config.flightStats = {
      scmSpeed: fc.ScmSpeed || 0,
      navSpeed: fc.MaxSpeed || 0,
      scmBoostForward: fc.MasterModes?.ScmMode?.BoostSpeedForward || 0,
      pitch: fc.Pitch || 0,
      yaw: fc.Yaw || 0,
      roll: fc.Roll || 0,
      boostPitchMult: fc.Boost?.AngularVelocityMultiplier?.Pitch || 1,
      boostYawMult: fc.Boost?.AngularVelocityMultiplier?.Yaw || 1,
      boostRollMult: fc.Boost?.AngularVelocityMultiplier?.Roll || 1,
      // Thruster (afterburner) capacitor - drives the Boost time readout.
      // A non-default flight blade overrides this in computeFlightStats.
      boostCap: fc.Capacitors ? {
        size: fc.Capacitors.ThrusterCapacitorSize || 0,
        idleCost: fc.Capacitors.CapacitorIdleCost || 0,
        usageModifier: fc.Capacitors.CapacitorUsageModifier ?? 1,
        regenPerSec: fc.Capacitors.CapacitorRegenPerSec || 0,
      } : null,
    };
  }
  const ifcsItems = config.Hardpoints?.Components?.Systems?.Controllers?.Ifcs?.InstalledItems;
  // The hull's FlightCharacteristics.Capacitors carries no usage-curve
  // reference, so resolve it from the installed IFCS controller item (the
  // same item the Flight Blade slot swaps). 259 of the 265 ships with a
  // controller resolve; the rest fall back to the default 1.0 curve.
  if (ifcsItems?.[0]?.ClassName && config.flightStats?.boostCap) {
    const curves = getItemStats(ifcsItems[0].ClassName)?.Ifcs?.AfterBurner?.Capacitor?.Curves;
    if (curves?.Usage) config.flightStats.boostCap.usageCurve = curves.Usage;
    if (curves?.Regen) config.flightStats.boostCap.regenCurve = curves.Regen;
  }
  if (ifcsItems && ifcsItems[0]?.ResourceNetwork) {
    const ifcsRN = ifcsItems[0].ResourceNetwork[0];
    const cons = ifcsRN?.Consumption;
    if (cons) {
      const pwr = cons.find(c => c.Resource === 'Power');
      if (pwr) {
        config.ifcsSegment = pwr.Segment || 0;
        config.ifcsMinFraction = pwr.MinConsumptionFraction || 0;
      }
    }
    config.ifcsPowerRanges = ifcsRN?.PowerRanges || null;
  }

  state.setCurrentShipConfig(config);
  setCurrentSlots(extractSlots(config));
  setDefaultLoadout(buildDefaultLoadout(state.currentSlots));
  setCurrentLoadout({ ...state.defaultLoadout });
  setCurrentQFuelCapacity(config.Hardpoints?.Components?.Propulsion?.QuantumFuelTanks?.TotalQuantumFuelCapacity || 0);

  // Restore saved loadout overrides from localStorage - unless they were
  // saved on another hull (see isLoadoutForOtherHull). Ignored, not cleared:
  // the next change the user makes overwrites it.
  const stored = loadLoadout(shipName);
  const saved = isLoadoutForOtherHull(stored, state.currentSlots, state.defaultLoadout) ? null : stored;
  if (saved) {
    const swappedMounts = [];
    for (const [port, className] of Object.entries(saved)) {
      if (port in state.currentLoadout) {
        const wasDefault = state.currentLoadout[port];
        state.currentLoadout[port] = className;
        if (className !== wasDefault) {
          const si = className ? getItemStats(className) : null;
          const itemType = si?.Type || '';
          const isMountOrTurret = itemType.includes('Turret') || itemType.includes('Module') || itemType.includes('MissileLauncher');
          if (isMountOrTurret && si?.Ports?.length > 0) {
            swappedMounts.push({ port, className });
          }
        }
      }
    }
    for (const { port, className } of swappedMounts) {
      rebuildSlotPorts(port, className);
    }
    for (const [port, className] of Object.entries(saved)) {
      if (port in state.currentLoadout) state.currentLoadout[port] = className;
    }
  }

  syncModuleSubPorts();

  setCurrentShieldOverrides(loadShieldSelection(state.currentShipName));
  setCurrentDisabledPorts(loadDisabledPorts(state.currentShipName) || []);
  rebuildPipAllocation();

  document.getElementById('loadoutPlaceholder').style.display = 'none';
  document.getElementById('loadoutMain').style.display = '';
  document.getElementById('loTopRow').style.display = '';

  const loadoutBar = document.getElementById('loadoutBar');
  if (loadoutBar) {
    loadoutBar.style.display = '';
    initLoadoutDropdown();
  }

  // Show the analysis cluster (Materials + Deflection) when a ship is
  // selected. Materials sub-button gates on crafting data availability.
  const cluster = document.getElementById('loadoutAnalysisCluster');
  if (cluster) cluster.style.display = '';
  const matBtn = document.getElementById('loadoutMaterialsBtn');
  if (matBtn) matBtn.style.display = hasCraftingData() ? '' : 'none';

  renderAllSlots();
  renderStats();

  if (state.tabs[state.activeTabIdx]) state.tabs[state.activeTabIdx].shipName = shipName;
  renderTabBar();
  persistTabs();
}

// ── Slot column rendering ──────────────────────────────────────────────────────

function renderAllSlots() {
  renderAllSlotColumns();
}

// Turret sub-categories shown under the TURRETS section, in render order after
// the (unlabeled) combat turrets. These weapons don't engage a ship hull, so
// they're skipped in turret DPS - the header makes that visible.
const TURRET_SUBCAT_ORDER = { combat: 0, antipersonnel: 1, pdc: 2 };
const TURRET_SUBCAT_LABEL = {
  antipersonnel: 'Anti-personnel',
  pdc: 'Point Defense (PDC)',
};

/**
 * Build the TURRETS section def: combat turrets first (unlabeled), then the
 * excluded classes grouped under a sub-header noting they're skipped in DPS.
 * The render closure tracks the last class so it emits each header exactly once.
 */
function turretSectionDef(turrets) {
  const slots = [...turrets];
  const classOf = new Map(slots.map(s => [s, classifyTurret(s)]));
  slots.sort((a, b) => TURRET_SUBCAT_ORDER[classOf.get(a)] - TURRET_SUBCAT_ORDER[classOf.get(b)]);
  let lastClass = null;
  const render = (slot) => {
    const cls = classOf.get(slot);
    let header = '';
    if (cls !== lastClass && TURRET_SUBCAT_LABEL[cls]) {
      header = `<div class="lo-turret-subcat">${TURRET_SUBCAT_LABEL[cls]}`
        + `<span class="lo-turret-subcat-note">not counted in turret DPS</span></div>`;
    }
    lastClass = cls;
    return header + renderTurretGroup(slot);
  };
  return { title: 'TURRETS', slots, render };
}

function getSectionDefs() {
  const defs = {
    weapons: { title: 'WEAPONS', slots: state.currentSlots.weapons || [], render: renderWeaponSlot },
    turrets: turretSectionDef(state.currentSlots.turrets || []),
    missiles: { title: 'MISSILES', slots: state.currentSlots.missiles || [], render: renderMissileSlot },
    emp: { title: 'EMP', slots: state.currentSlots.emp || [], render: renderInterdictionSlot, resetKey: 'emp' },
    qed: { title: 'QED', slots: state.currentSlots.qed || [], render: renderInterdictionSlot, resetKey: 'qed' },
    mining: { title: 'MINING', slots: state.currentSlots.mining || [], render: renderTurretGroup, resetKey: 'mining' },
    salvage: {
      title: 'SALVAGE',
      slots: state.currentSlots.salvage || [],
      render: renderTurretGroup,
      resetKey: 'salvage',
      summaryHtml: renderSalvageSummary(state.currentSlots.salvage || [], state.currentShipConfig?.salvageBufferSCU || 0)
    }
  };
  for (const slot of state.currentSlots.systems || []) {
    if (!defs[slot.category]) {
      defs[slot.category] = { title: slot.category.toUpperCase(), slots: [], render: renderSystemSlot, resetKey: slot.category };
    }
    defs[slot.category].slots.push(slot);
  }
  if (state.currentSlots.thrusters && state.currentSlots.thrusters.length > 0) {
    defs['Thrusters'] = { title: 'THRUSTERS', slots: state.currentSlots.thrusters, render: renderThrusterSlot, resetKey: 'Thrusters' };
  }
  if (state.currentSlots.modules && state.currentSlots.modules.length > 0) {
    defs['Modules'] = { title: 'MODULES', slots: state.currentSlots.modules, render: renderModuleSlot, resetKey: 'Module' };
  }
  return defs;
}

function renderColumnSections(col, colId) {
  const defs = getSectionDefs();
  let html = '';
  for (const entry of state.sectionOrder) {
    if (entry.col !== colId) continue;
    const def = defs[entry.key];
    if (!def || def.slots.length === 0) continue;
    const resetKey = def.resetKey || entry.key;
    html += renderSection(def.title, resetKey, def.slots, def.render, def.summaryHtml, entry.key);
  }
  // Render any sections not in sectionOrder (new from game updates)
  const orderedKeys = new Set(state.sectionOrder.map(s => s.key));
  for (const [key, def] of Object.entries(defs)) {
    if (!orderedKeys.has(key) && def.slots.length > 0) {
      const resetKey = def.resetKey || key;
      html += renderSection(def.title, resetKey, def.slots, def.render, def.summaryHtml, key);
    }
  }
  col.innerHTML = html;
  bindSlotClicks(col);
}

function renderWeaponColumn() {
  renderColumnSections(document.getElementById('loWeapons'), 'left');
  injectWeaponCapBadge();
}

function renderSystemsColumn() {
  renderColumnSections(document.getElementById('loSystems'), 'right');
}

function renderAllSlotColumns() {
  renderWeaponColumn();
  renderSystemsColumn();
  bindSectionDrag();
}

const SECTION_ICONS = {
  'WEAPONS': '<i class="spvi-weapon"></i>',
  'TURRETS': '<i class="spvi-Engineering_Icon_ItemTurret"></i>',
  'MISSILES': '<i class="spvi-missile"></i>',
  'EMP': '<i class="spvi-icon_common_EMP"></i>',
  'QED': '<i class="spvi-icon_common_QED"></i>',
  'MINING': '<i class="spvi-icon_common_mining"></i>',
  'SALVAGE': '<i class="spvi-salvage"></i>',
  'SHIELDS': '<i class="spvi-icon_common_generator_shield"></i>',
  'POWER PLANTS': '<i class="spvi-MFD-Icon-Generator"></i>',
  'COOLERS': '<i class="spvi-icon_common_coolant"></i>',
  'QUANTUM DRIVE': '<i class="spvi-icon_common_quantum"></i>',
  'RADAR': '<i class="spvi-icon_common_radar"></i>',
  'LIFE SUPPORT': '<i class="spvi-icon_common_life_support"></i>',
  'FLIGHT BLADE': '<i class="spvi-Engineering_Icon_ItemThrusters"></i>',
  'THRUSTERS': '<i class="spvi-Engineering_Icon_ItemThrusters"></i>',
  'MODULES': '<i class="spvi-modularity"></i>'
};

function renderSection(title, resetKey, slots, renderFn, summaryHtml, sectionKey) {
  const icon = SECTION_ICONS[title] || '';
  let html = `<div class="lo-section" data-section-key="${sectionKey || resetKey}">`;
  html += `<div class="lo-section-header"><i class="spvi-drag_indicator lo-drag-handle"></i><h3>${icon ? icon + ' ' : ''}${title}</h3><button class="lo-reset" data-reset="${resetKey}">Reset</button></div>`;
  if (summaryHtml) html += summaryHtml;
  for (const slot of slots) {
    html += renderFn(slot);
  }
  html += `</div>`;
  return html;
}

// ── Slot interaction ───────────────────────────────────────────────────────────

function bindSlotClicks(container) {
  container.querySelectorAll('.lo-slot:not(.uneditable)').forEach(slot => {
    slot.addEventListener('click', () => openPicker(slot));
  });

  container.querySelectorAll('.lo-reset').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetCategory(btn.dataset.reset);
    });
  });

  container.querySelectorAll('.lo-power-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();

      // --- Weapon / power-plant toggle (port-keyed) ---
      // .lo-power-toggle elements may carry data-port (single port) or
      // data-rack-ports (a JSON array - collapsed weapon group). For racks,
      // toggling powers off all if any are currently on, else turns all back on.
      const portAttr = btn.dataset.port;
      const rackAttr = btn.dataset.rackPorts;
      if (portAttr || rackAttr) {
        let ports;
        try { ports = rackAttr ? JSON.parse(rackAttr) : [portAttr]; } catch { ports = [portAttr]; }
        const anyEnabled = ports.some(p => !state.currentDisabledPorts.has(p));
        for (const p of ports) {
          if (anyEnabled) state.currentDisabledPorts.add(p);
          else state.currentDisabledPorts.delete(p);
        }
        saveDisabledPorts(state.currentShipName, state.currentDisabledPorts);
        persistTabs();
        rebuildPipAllocation(true);
        renderAllSlots();
        renderStats();
        return;
      }

      // --- Shield toggle (index-keyed) ---
      const idx = parseInt(btn.dataset.shieldIdx, 10);
      const shieldCh = state.currentPipAllocation?.channels?.find(c => c.key === 'shields');
      const shieldBreak = shieldCh?.shieldSlots || [];
      const powered = shieldBreak.filter(s => s.powered && s.max > 0).map(s => s.slotIdx);
      const isPowered = powered.includes(idx);

      if (isPowered) {
        setCurrentShieldOverrides(powered.filter(i => i !== idx));
      } else if (powered.length >= 2) {
        const equipped = shieldBreak.filter(s => s.max > 0);
        const sorted = [...equipped].sort((a, b) => (a.min - b.min) || (b.hp - a.hp) || (a.grade - b.grade) || (a.slotIdx - b.slotIdx));
        const sortOrder = sorted.map(s => s.slotIdx);
        const otherPowered = powered.filter(i => i !== idx);
        otherPowered.sort((a, b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));
        setCurrentShieldOverrides([otherPowered[0], idx]);
      } else {
        setCurrentShieldOverrides([...powered, idx]);
      }

      saveShieldSelection(state.currentShipName, state.currentShieldOverrides);
      rebuildPipAllocation(true);
      renderSystemsColumn();
      renderStats();
    });
  });

  container.querySelectorAll('.lo-chevron').forEach(chevron => {
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      const turretId = chevron.dataset.turret;
      const collapsed = document.getElementById(turretId + '_collapsed');
      const expanded = document.getElementById(turretId + '_expanded');
      if (chevron.dataset.collapse) {
        collapsed.style.display = '';
        expanded.classList.add('lo-expanded-hidden');
      } else {
        collapsed.style.display = 'none';
        expanded.classList.remove('lo-expanded-hidden');
      }
    });
  });

  bindImmuneDotTooltips(container);
}

function resetCategory(key) {
  const keyUpper = key.toUpperCase();
  const slots = key === 'weapons' ? state.currentSlots.weapons
    : key === 'turrets' ? state.currentSlots.turrets
    : key === 'missiles' ? state.currentSlots.missiles
    : key === 'emp' ? state.currentSlots.emp
    : key === 'qed' ? state.currentSlots.qed
    : key === 'mining' ? state.currentSlots.mining
    : key === 'salvage' ? state.currentSlots.salvage
    : key === 'Thrusters' ? []
    : key === 'Module' ? state.currentSlots.modules
    : state.currentSlots.systems.filter(s => s.category.toUpperCase() === keyUpper);

  function resetSlot(slot) {
    // Prefer slot.baseLoadout (from ship hardpoint tree), fall back to
    // defaultLoadout (built at ship-select time and always authoritative
    // for the ship's original configuration - see DATA_SOURCES.md
    // "Default Item Resolution").
    const defaultClass = slot.baseLoadout?.ClassName ?? state.defaultLoadout[slot.portName] ?? null;
    const currentClass = state.currentLoadout[slot.portName];
    state.currentLoadout[slot.portName] = defaultClass;
    if (currentClass !== defaultClass) {
      const si = defaultClass ? getItemStats(defaultClass) : null;
      const itemType = si?.Type || '';
      const isMountOrTurret = itemType.includes('Turret') || itemType.includes('Module') || itemType.includes('MissileLauncher');
      if (isMountOrTurret) {
        rebuildSlotPorts(slot.portName, defaultClass);
      }
    }
    for (const sub of slot.ports || []) {
      resetSlot(sub);
    }
  }

  for (const slot of (Array.isArray(slots) ? slots : [])) {
    resetSlot(slot);
  }

  if (keyUpper === 'SHIELDS') {
    setCurrentShieldOverrides(null);
    saveShieldSelection(state.currentShipName, null);
  }
  if (key === 'Module') {
    syncModuleSubPorts();
  }
  saveLoadout(state.currentShipName, state.currentLoadout);
  persistTabs();
  rebuildPipAllocation(true);
  renderAllSlots();
  renderStats();
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

function snapshotCurrentTab() {
  const pips = {};
  if (state.currentPipAllocation?.channels) {
    for (const ch of state.currentPipAllocation.channels) pips[ch.key] = ch.allocated;
  }
  // Deep-copy currentCrafting (per-port slot→quality maps) - outer + inner
  // need cloning since both layers are mutated independently.
  const crafting = {};
  for (const [port, slots] of Object.entries(state.currentCrafting || {})) {
    crafting[port] = { ...slots };
  }
  const hasCrafting = Object.keys(crafting).length > 0;
  state.tabs[state.activeTabIdx] = {
    shipName: state.currentShipName,
    loadout: { ...state.currentLoadout },
    pips,
    shields: state.currentShieldOverrides ? [...state.currentShieldOverrides] : null,
    disabled: state.currentDisabledPorts.size > 0 ? [...state.currentDisabledPorts] : null,
    crafting: hasCrafting ? crafting : null,
    loadoutName: currentLoadoutName || ''
  };
}

function restoreTab(idx) {
  const tab = state.tabs[idx];
  if (!tab) return;

  if (tab.shipName) {
    selectShip(tab.shipName);
    if (tab.loadout && Object.keys(tab.loadout).length > 0
      && !isLoadoutForOtherHull(tab.loadout, state.currentSlots, state.defaultLoadout)) {
      Object.assign(state.currentLoadout, tab.loadout);
      saveLoadout(state.currentShipName, state.currentLoadout);
    }
    if (tab.shields != null) {
      setCurrentShieldOverrides(tab.shields);
      saveShieldSelection(state.currentShipName, state.currentShieldOverrides);
    }
    if (tab.disabled != null) {
      setCurrentDisabledPorts(tab.disabled);
      saveDisabledPorts(state.currentShipName, state.currentDisabledPorts);
    }
    // Crafting payload is a per-port { slot: quality } map. Missing field
    // (legacy tabs) reads as empty → identity fast path, no behaviour change.
    state.setCurrentCrafting(tab.crafting ? { ...tab.crafting } : {});
    setCurrentLoadoutName(tab.loadoutName || '');
    rebuildPipAllocation(true);
    if (tab.pips && state.currentPipAllocation?.channels) {
      for (const ch of state.currentPipAllocation.channels) {
        if (tab.pips[ch.key] != null) ch.allocated = tab.pips[ch.key];
      }
    }
    renderAllSlots();
    renderStats();
    refreshLoadoutDropdown();
  } else {
    // Empty tab - reset to no-ship state
    setCurrentShipName(null);
    setCurrentLoadout({});
    setCurrentPipAllocation(null);
    setCurrentShieldOverrides(null);
    setCurrentDisabledPorts([]);
    state.setCurrentCrafting({});
    setCurrentLoadoutName('');
    document.getElementById('shipToggle').innerHTML = 'Select a vehicle&hellip; <span class="ms-arrow">&#9662;</span>';
    document.getElementById('loadoutPlaceholder').style.display = '';
    document.getElementById('loadoutMain').style.display = 'none';
    document.getElementById('loTopRow').style.display = 'none';
    document.getElementById('loadoutBar').style.display = 'none';
    const cluster = document.getElementById('loadoutAnalysisCluster');
    if (cluster) cluster.style.display = 'none';
  }
}

function persistTabs() {
  snapshotCurrentTab();
  saveTabs(state.tabs, state.activeTabIdx);
}

function switchTab(idx) {
  if (idx === state.activeTabIdx) return;
  snapshotCurrentTab();
  setActiveTabIdx(idx);
  restoreTab(idx);
  renderTabBar();
  saveTabs(state.tabs, state.activeTabIdx);
}

function addTab() {
  snapshotCurrentTab();
  state.tabs.push({ shipName: null, loadout: {}, pips: null, shields: null, disabled: null, loadoutName: '' });
  setActiveTabIdx(state.tabs.length - 1);
  restoreTab(state.activeTabIdx);
  renderTabBar();
  saveTabs(state.tabs, state.activeTabIdx);
}

function closeTab(idx) {
  if (state.tabs.length <= 1) return;
  state.tabs.splice(idx, 1);
  if (state.activeTabIdx >= state.tabs.length) setActiveTabIdx(state.tabs.length - 1);
  else if (idx < state.activeTabIdx) setActiveTabIdx(state.activeTabIdx - 1);
  restoreTab(state.activeTabIdx);
  renderTabBar();
  saveTabs(state.tabs, state.activeTabIdx);
}

// ── Section drag-and-drop reordering (cross-column) ───────────────────────────

let dragSectionKey = null;

function bindSectionDrag() {
  const leftCol = document.getElementById('loWeapons');
  const rightCol = document.getElementById('loSystems');
  const allSections = [
    ...(leftCol?.querySelectorAll('.lo-section') || []),
    ...(rightCol?.querySelectorAll('.lo-section') || [])
  ];

  allSections.forEach(section => {
    const handle = section.querySelector('.lo-drag-handle');
    if (!handle) return;
    const key = section.dataset.sectionKey;

    handle.addEventListener('mousedown', () => { section.setAttribute('draggable', 'true'); });
    section.addEventListener('dragend', () => { section.removeAttribute('draggable'); });

    section.addEventListener('dragstart', (e) => {
      dragSectionKey = key;
      section.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    section.addEventListener('dragend', () => {
      section.classList.remove('dragging');
      dragSectionKey = null;
      allSections.forEach(s => s.classList.remove('drag-over-top', 'drag-over-bottom'));
    });
    section.addEventListener('dragover', (e) => {
      if (!dragSectionKey || dragSectionKey === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = section.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      section.classList.toggle('drag-over-top', e.clientY < mid);
      section.classList.toggle('drag-over-bottom', e.clientY >= mid);
    });
    section.addEventListener('dragleave', () => {
      section.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    section.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragSectionKey || dragSectionKey === key) return;
      const targetCol = section.closest('#loWeapons') ? 'left' : 'right';
      const dropAfter = e.clientY >= section.getBoundingClientRect().top + section.getBoundingClientRect().height / 2;
      const fromIdx = state.sectionOrder.findIndex(s => s.key === dragSectionKey);
      if (fromIdx === -1) return;
      const [moved] = state.sectionOrder.splice(fromIdx, 1);
      moved.col = targetCol;
      const toIdx = state.sectionOrder.findIndex(s => s.key === key);
      state.sectionOrder.splice(dropAfter ? toIdx + 1 : toIdx, 0, moved);
      dragSectionKey = null;
      saveSectionOrder(state.sectionOrder);
      renderAllSlotColumns();
    });
  });

  bindColumnDrag();
}

// The column containers are persistent (only their innerHTML is replaced on
// re-render), so their dragover/drop listeners must be bound exactly once -
// bindSectionDrag runs on every renderAllSlotColumns and used to stack a new
// pair of handlers per render.
let _columnDragBound = false;

function bindColumnDrag() {
  if (_columnDragBound) return;
  _columnDragBound = true;
  const leftCol = document.getElementById('loWeapons');
  const rightCol = document.getElementById('loSystems');
  [leftCol, rightCol].forEach(col => {
    if (!col) return;
    const colId = col.id === 'loWeapons' ? 'left' : 'right';
    col.addEventListener('dragover', (e) => {
      if (!dragSectionKey || e.target.closest('.lo-section')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    col.addEventListener('drop', (e) => {
      if (!dragSectionKey || e.target.closest('.lo-section')) return;
      e.preventDefault();
      const fromIdx = state.sectionOrder.findIndex(s => s.key === dragSectionKey);
      if (fromIdx === -1) return;
      const [moved] = state.sectionOrder.splice(fromIdx, 1);
      moved.col = colId;
      state.sectionOrder.push(moved);
      dragSectionKey = null;
      saveSectionOrder(state.sectionOrder);
      renderAllSlotColumns();
    });
  });
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

let dragTabIdx = null;

function renderTabBar() {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  bar.innerHTML = '';
  for (let i = 0; i < state.tabs.length; i++) {
    const tab = state.tabs[i];
    const btn = document.createElement('button');
    btn.className = 'lo-tab' + (i === state.activeTabIdx ? ' active' : '');
    btn.draggable = true;
    btn.dataset.tabIdx = i;
    const label = tab.shipName || 'New tab';
    btn.innerHTML = `<span>${escapeHtml(label)}</span>${state.tabs.length > 1 ? '<span class="lo-tab-close" data-tip="Close tab">&times;</span>' : ''}`;
    btn.querySelector('span').addEventListener('click', () => switchTab(i));
    const closeBtn = btn.querySelector('.lo-tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
    }

    btn.addEventListener('dragstart', (e) => {
      dragTabIdx = i;
      btn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      dragTabIdx = null;
      bar.querySelectorAll('.lo-tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
    });
    btn.addEventListener('dragover', (e) => {
      if (dragTabIdx == null || dragTabIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = btn.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      btn.classList.toggle('drag-over-left', e.clientX < mid);
      btn.classList.toggle('drag-over-right', e.clientX >= mid);
    });
    btn.addEventListener('dragleave', () => {
      btn.classList.remove('drag-over-left', 'drag-over-right');
    });
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragTabIdx == null || dragTabIdx === i) return;
      const activeTab = state.tabs[state.activeTabIdx];
      const [moved] = state.tabs.splice(dragTabIdx, 1);
      let insertAt = dragTabIdx < i ? i - 1 : i;
      const rect = btn.getBoundingClientRect();
      if (e.clientX >= rect.left + rect.width / 2) insertAt++;
      state.tabs.splice(insertAt, 0, moved);
      setActiveTabIdx(state.tabs.indexOf(activeTab));
      dragTabIdx = null;
      renderTabBar();
      saveTabs(state.tabs, state.activeTabIdx);
    });

    bar.appendChild(btn);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'lo-tab-add';
  addBtn.textContent = '+';
  addBtn.dataset.tip = 'New tab';
  addBtn.addEventListener('click', addTab);
  bar.appendChild(addBtn);
}

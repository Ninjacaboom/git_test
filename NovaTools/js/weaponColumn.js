/**
 * weaponColumn.js - weapon slots, turret groups, missile slots, and item picker.
 */
import * as state from './loadoutState.js';
import { getItemStats, getCraftedItemStats, getCompatibleItems, buildDefaultLoadout, calculateStats, isLoadoutPort, findGimbalMount } from './loadoutManager.js';
import { WEAPON_TYPE_MAP } from './config.js';
import { saveLoadout, saveShieldSelection, savePipAllocation } from './stateStore.js';
import { rebuildPipAllocation } from './pipPanel.js';
import { fmtStat, getSalvageModifierStats, prettifyName } from './statsPanel.js';
import { calcSustainedDPS, computeBurstDPS, classifyFiringMode, mergeHeatParams } from './sustained.js';
import { classifyTurretWeapon } from './ttkCalc.js';
import { renderCraftingIndicator } from './craftingUI.js';
import { deriveTier, getImmuneShips, TOP_TIER, TIER_META } from './tierEngine.js';
import { escapeHtml } from './utils.js';
import { buildMultiSelect } from './uiWidgets.js';

/**
 * Deprecated items blocklist - narrow, hand-curated list of classNames
 * that should never appear in the component picker.
 *
 * BACKGROUND: SPViewer's item database contains a long tail of items
 * whose referenced sub-parts (e.g. installed cargo grids, gun barrels)
 * are missing from the DB - usually because the item itself was
 * deprecated / replaced in an earlier patch but the class file wasn't
 * scrubbed. Most of those items are still legitimately usable in-game
 * (capital-ship weapons, RSI-store-only modules, bespoke ship-specific
 * components), so a broad "hide anything with broken child refs" filter
 * would remove ~37 real items across weapons, turrets, and modules.
 *
 * Instead, we keep this list tiny and only add entries for items that
 * are CONFIRMED broken in-universe: zero ship owners, zero shop sales,
 * and a demonstrable replacement that took their role. Each entry
 * should cite the patch or observation that justified it.
 *
 * TODO: replace this hardcoded list with a data-driven filter once
 * SPViewer exposes item deprecation flags, or once we have a reliable
 * "installed-item can be resolved" check that doesn't false-positive
 * on capital-ship WIP content. See DATA_SOURCES.md for the open issue.
 *
 * ENTRIES:
 *   ANVL_Hornet_F7C_Mk2_Cargo_Mod - "Stor*All Big Box Model H"
 *     Referenced by: no ship in the 201-ship database
 *     Shop availability: sold=0 in CStone
 *     References missing: ANVL_Hornet_CargoGrid_F7C (not in items DB)
 *     Replacement: Stor*All Big Box Model H2 (ANVL_Hornet_F7C_Mk2_Cargo_Door)
 *       is the stock center-hardpoint module on Anvil F7C Hornet Mk II.
 */
const DEPRECATED_ITEMS = new Set([
  'ANVL_Hornet_F7C_Mk2_Cargo_Mod',
]);

// Persisted weapon-picker filter state. Kept across picker openings so the
// user can swap several weapon slots in a row without re-applying the same
// Type / Size / Speed filters every time. Sizes/types entries are pruned on
// open to whatever the new picker actually has available.
const _weaponPickerFilters = {
  sizes: new Set(),
  types: new Set(),
  speedMin: '',
  speedMax: ''
};

// Render callbacks set by the orchestrator
let _renderAllSlots = null;
let _renderStats = null;
let _persistTabs = null;
let _syncModuleSubPorts = null;

export function setRenderCallbacks(renderAllSlots, renderStats, persistTabs, syncModuleSubPorts) {
  _renderAllSlots = renderAllSlots;
  _renderStats = renderStats;
  _persistTabs = persistTabs;
  _syncModuleSubPorts = syncModuleSubPorts;
}

/**
 * Bind hover tooltips on deflection tier markers within a container - the
 * slot dots (.defl-dot-immune) and the picker badges (.defl-badge), both
 * carrying their immune ship list in data-immune. Creates a fixed-position
 * tooltip appended to document.body showing one immune ship name per line,
 * with multi-column layout for long lists.
 */
export function bindImmuneDotTooltips(container) {
  container.querySelectorAll('[data-immune]').forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      e.stopPropagation();
      const names = dot.dataset.immune.split('\n');
      const tip = document.createElement('div');
      tip.className = 'defl-tip';
      if (names.length > 20) tip.classList.add('cols-3');
      else if (names.length > 8) tip.classList.add('cols-2');
      tip.innerHTML = names.map(n => `<div>${escapeHtml(n)}</div>`).join('');
      document.body.appendChild(tip);
      const rect = dot.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      // Position above the dot by default; flip below if it would overflow the top
      const above = rect.top - tipRect.height - 6;
      if (above >= 0) {
        tip.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      } else {
        tip.style.top = (rect.bottom + 6) + 'px';
      }
      // Clamp horizontally so tooltip doesn't overflow right edge
      const left = Math.min(rect.left, window.innerWidth - tipRect.width - 8);
      tip.style.left = Math.max(4, left) + 'px';
      dot._deflTip = tip;
    });
    dot.addEventListener('mouseleave', () => {
      dot._deflTip?.remove();
      dot._deflTip = null;
    });
    dot.addEventListener('click', (e) => e.stopPropagation());
  });
}

/**
 * Build a deflection tier dot HTML for a weapon. The dot is coloured by tier
 * on the red-to-blue ramp (see DEFLECTION_BANDS); every tier below the top
 * one also carries the immune ship list as a hover tooltip.
 *
 * When `portName` is supplied and the port has non-default crafting
 * state, the tier + immune list are recomputed from the crafted alpha
 * instead of read from the startup cache - so e.g. pushing Impact Force
 * up can drop ships out of the immune list in real time.
 */
function getTierDotHtml(si, className, slotMaxSize, portName) {
  if (!si) return '';
  const tierKey = `${si.Name || className}||${si.Size || slotMaxSize || 0}`;
  let tier = state.weaponTierMap.get(tierKey);
  let immuneNames = tier && tier !== TOP_TIER ? (state.weaponImmuneMap.get(tierKey) || []) : [];

  // Per-port crafted recompute: only when the port has deviation from
  // default quality AND we have the base weapon record cached.
  const portCrafting = portName ? state.currentCrafting[portName] : null;
  const hasCrafting = portCrafting && Object.keys(portCrafting).length > 0;
  if (hasCrafting && state.weaponByKey?.has(tierKey)) {
    const base = state.weaponByKey.get(tierKey);
    const craftedSi = getCraftedItemStats(className, portName);
    const firing = craftedSi?.Weapon?.Firing?.[0];
    const dps = firing?.DamagePerShot || {};
    const craftedAlpha = (dps.Physical || 0) + (dps.Energy || 0) + (dps.Distortion || 0)
                       + (dps.Thermal || 0) + (dps.Biochemical || 0) + (dps.Stun || 0);
    if (craftedAlpha > 0 && base.Alpha) {
      const ratio = craftedAlpha / base.Alpha;
      const pellets = base.Pellets || 1;
      const craftedWeapon = {
        ...base,
        Alpha: craftedAlpha,
        PerPellet: pellets > 1 ? craftedAlpha / pellets : null,
        // Sustained DPS scales linearly with per-shot damage at fixed rate of
        // fire - Impact Force doesn't change RPM, ammo, or heat behaviour.
        Sustained: base.Sustained != null ? base.Sustained * ratio : null,
      };
      tier = deriveTier(craftedWeapon, state.allShips);
      if (tier !== TOP_TIER) {
        const { immune } = getImmuneShips(craftedWeapon, state.allShips);
        immuneNames = immune.map(s => s.Name);
      } else {
        immuneNames = [];
      }
    }
  }

  if (!tier) return '';
  const immuneAttr = immuneNames.length > 0 ? ` data-immune="${escapeHtml(immuneNames.join('\n'))}"` : '';
  return ` <span class="defl-dot defl-dot-immune defl-tier-${escapeHtml(tier)}"${immuneAttr}></span>`;
}

/**
 * Derive weapon type string from className and tags (mirrors weaponParser.deriveType).
 */
export function deriveWeaponType(className, tags, dpsShot, itemName) {
  // Check className for known type keys
  for (const [key, value] of Object.entries(WEAPON_TYPE_MAP)) {
    if (className.includes(key)) return value;
  }
  // Check tags
  const tagList = (tags || '').split(/\s+/);
  for (const tag of tagList) {
    if (WEAPON_TYPE_MAP[tag]) return WEAPON_TYPE_MAP[tag];
  }
  for (const tag of tagList) {
    for (const [key, value] of Object.entries(WEAPON_TYPE_MAP)) {
      if (tag.includes(key)) return value;
    }
  }
  // Fallback patterns - check both className and resolved item name
  // (some items like AMRS_AAgun_CC_S3 / "PyroBurst Scattergun" have
  // no type keyword in className or tags)
  const haystack = `${className} ${itemName || ''}`;
  if (/ScatterGun|Scattergun/i.test(haystack)) {
    if (dpsShot.Physical) return 'Ballistic Scattergun';
    if (dpsShot.Energy) return 'Laser Scattergun';
    if (dpsShot.Distortion) return 'Distortion Scattergun';
    return 'Scattergun';
  }
  if (/Cannon/i.test(className)) return 'Cannon';
  if (/Repeater/i.test(className)) return 'Repeater';
  if (/Gatling/i.test(className)) return 'Gatling';
  if (/Beam/i.test(className)) return 'Beam';
  if (dpsShot) {
    if (dpsShot.Physical) return 'Ballistic Cannon';
    if (dpsShot.Energy) return 'Laser Cannon';
    if (dpsShot.Distortion) return 'Distortion Cannon';
  }
  return 'Unknown';
}

/**
 * Get ammo info for a weapon.
 */
export function getAmmoInfo(si, count = 1) {
  const weapon = si?.Weapon;
  if (!weapon) return null;
  const firing = weapon.Firing?.[0];
  if (!firing) return null;

  const consumption = weapon.Consumption;
  const ammo = weapon.Ammunition;
  const isEnergy = classifyFiringMode(consumption, mergeHeatParams(weapon)) === 'energy';

  if (isEnergy) {
    const wpnCh = state.currentPipAllocation?.channels?.find(c => c.key === 'weapons');
    const needed = wpnCh?.needed || 0;
    const allocated = wpnCh?.allocated || 0;
    const powerFrac = needed > 0 ? Math.min(allocated, needed) / needed : 1;
    const ammoMult = state.currentShipConfig?.weaponAmmoMult ?? 1;
    const regenMult = state.currentShipConfig?.weaponRegenMult ?? 1;
    const maxAmmo = consumption.MaxAmmo;
    const maxRegen = consumption.MaxRegenPerSec || 0;
    const cooldown = consumption.Cooldown || 0;
    const effAmmo = Math.round(maxAmmo * ammoMult * powerFrac);
    const effRegen = maxRegen * regenMult * powerFrac;
    if (effAmmo <= 0) return null;
    const rechargeTime = effRegen > 0 ? effAmmo / effRegen + cooldown : 0;
    const displayAmmo = effAmmo * count;
    return { text: `<span data-tip="Energy ammo pool">load <span class="lo-val">${fmtStat(displayAmmo)}</span></span> <span data-tip="Time to fully recharge">in <span class="lo-val">${rechargeTime.toFixed(2)}s</span></span>`, isEnergy: true };
  } else {
    // Ballistic weapon
    const capacity = ammo?.Capacity || 0;
    if (capacity <= 0) return null;
    const hp = weapon.HeatParameters || {};
    const rpm = firing.RoundsPerMinute || 0;
    const heatPerShot = firing.HeatPerShot || 0;
    let roundsOH = Math.floor(capacity); // default: full capacity
    if (hp.OverheatTemp != null && heatPerShot > 0 && rpm > 0) {
      const minTemp = hp.MinTemp || 0;
      const overheatTemp = hp.OverheatTemp || 100;
      const coolingPerSec = hp.CoolingPerSecond || 0;
      const coolDelay = hp.TimeTillCoolingStarts || 0;
      const shotInterval = 60 / rpm;
      let coolingBetweenShots = 0;
      if (shotInterval > coolDelay) {
        coolingBetweenShots = coolingPerSec * (shotInterval - coolDelay);
      }
      const netHeat = heatPerShot - coolingBetweenShots;
      if (netHeat > 0) {
        roundsOH = Math.ceil((overheatTemp - minTemp) / netHeat);
      }
    }
    const totalAmmo = Math.floor(capacity);
    if (roundsOH >= totalAmmo) {
      return { text: `<span data-tip="Total ammo capacity"><span class="lo-val">${fmtStat(totalAmmo)}</span> ammo</span>`, isEnergy: false };
    }
    return { text: `<span data-tip="Rounds before overheat / total ammo"><span class="lo-val">${fmtStat(roundsOH)}</span> / <span class="lo-val">${fmtStat(totalAmmo)}</span> ammo</span>`, isEnergy: false };
  }
}

/**
 * Get pip-scaled DPS for a weapon slot.
 */
export function getSlotDps(si, className) {
  const firing = si?.Weapon?.Firing?.[0];
  if (!firing) return 0;
  // computeBurstDPS prefers `BurstRoundsPerMinute` when present so
  // burst weapons (3-shot bursts etc.) show inner-burst peak DPS
  // rather than sustained-avg-with-pauses.
  const burst = computeBurstDPS(firing);
  if (!burst) return 0;

  const wpnCh = state.currentPipAllocation?.channels?.find(c => c.key === 'weapons');
  const allocated = wpnCh?.allocated || 0;
  const needed = wpnCh?.needed || 0;
  const wpnOff = allocated === 0;

  if (wpnOff) return 0;

  if (state.dpsMode === 'sustained' && si) {
    const wpnFrac = needed > 0 ? Math.min(allocated, needed) / needed : 1;
    const ammoMult = state.currentShipConfig?.weaponAmmoMult ?? 1;
    const regenMult = state.currentShipConfig?.weaponRegenMult ?? 1;
    if (si.Weapon && (si._crafted || wpnFrac < 1 || ammoMult !== 1 || regenMult !== 1)) {
      return calcSustainedDPS(si.Weapon, si.Weapon.Consumption, wpnFrac, ammoMult, regenMult) || burst;
    }
    const key = `${si.Name || className || ''}||${si.Size || 0}`;
    return state.weaponSustMap.get(key) ?? burst;
  }
  return burst;
}

/**
 * Get weapon metadata split into left (power/EM) and right (fire time/cooldown) parts.
 */
export function getWeaponMeta(si, count) {
  if (!si?.Weapon) return { left: '', right: '' };
  const weapon = si.Weapon;
  const firing = weapon.Firing?.[0];
  if (!firing) return { left: '', right: '' };
  const n = count || 1;

  // Power draw and EM from ResourceNetwork
  let powerDraw = 0, emNom = 0;
  for (const node of si.ResourceNetwork || []) {
    if (node.Consumption) {
      for (const c of node.Consumption) {
        if (c.Resource === 'Power') powerDraw += c.UnitPerSec || c.Segment || 0;
      }
    }
    emNom += node.Signatures?.Electromagnetic?.Nominal || 0;
  }

  // Scale EM by weapon power fraction × ship signal multiplier
  const wpnCh = state.currentPipAllocation?.channels?.find(c => c.key === 'weapons');
  const needed = wpnCh?.needed || 0;
  const allocated = wpnCh?.allocated || 0;
  const powerFrac = needed > 0 ? Math.min(allocated, needed) / needed : 1;
  const emK = state.currentShipConfig?.signalMultipliers?.Electromagnetic ?? 1;
  const scaledEM = emNom * powerFrac * emK * n;

  // Left side: power draw, EM
  const leftParts = [];
  if (powerDraw > 0) leftParts.push(`<span data-tip="Power draw"><i class="spvi-powerplant"></i> <span class="lo-val">${powerDraw % 1 ? powerDraw.toFixed(1) : powerDraw}</span></span>`);
  if (emNom > 0) leftParts.push(`<span data-tip="EM signature"><i class="spvi-electric"></i> <span class="lo-val">${fmtStat(scaledEM, scaledEM % 1 ? 1 : undefined)}</span></span>`);

  // Right side: fire time, cooldown
  const consumption = weapon.Consumption;
  const mode = classifyFiringMode(consumption, mergeHeatParams(weapon));
  const rpm = firing.RoundsPerMinute || 0;
  const rate = rpm / 60;
  let fireTime = 0, cooldownTime = 0;

  if (mode === 'energy') {
    const ammoMult = state.currentShipConfig?.weaponAmmoMult ?? 1;
    const effAmmo = Math.round(consumption.MaxAmmo * ammoMult * powerFrac);
    if (rate > 0) fireTime = effAmmo / rate;
  } else if (mode === 'heat') {
    const hp = weapon.HeatParameters || {};
    const heatPerShot = firing.HeatPerShot || 0;
    if (rpm > 0) {
      const minTemp = hp.MinTemp || 0;
      const overheatTemp = hp.OverheatTemp || 100;
      const coolingPerSec = hp.CoolingPerSecond || 0;
      const coolDelay = hp.TimeTillCoolingStarts || 0;
      const shotInterval = 60 / rpm;
      let coolingBetweenShots = 0;
      if (shotInterval > coolDelay) {
        coolingBetweenShots = coolingPerSec * (shotInterval - coolDelay);
      }
      const netHeat = heatPerShot - coolingBetweenShots;
      if (netHeat > 0) {
        const roundsOH = Math.ceil((overheatTemp - minTemp) / netHeat);
        if (rate > 0) fireTime = roundsOH / rate;
      }
      cooldownTime = hp.OverheatFixTime || 0;
    }
  }

  const rightParts = [];
  const projSpeed = weapon.Ammunition?.Speed || 0;
  if (projSpeed > 0) rightParts.push(`<span data-tip="Projectile speed"><span class="lo-val">${fmtStat(projSpeed)}</span><span class="lo-stat-unit">m/s</span></span>`);
  if (fireTime > 0) rightParts.push(`<span data-tip="Continuous fire time"><i class="spvi-weapon"></i> <span class="lo-val">${fireTime.toFixed(1)}s</span></span>`);
  if (cooldownTime > 0) rightParts.push(`<span data-tip="Overheat cooldown"><i class="spvi-infrared"></i> <span class="lo-val">${cooldownTime.toFixed(1)}s</span></span>`);

  return { left: leftParts.join(' \u00b7 '), right: rightParts.join(' \u00b7 ') };
}

/**
 * Auto-fill missile sub-slots when a rack is swapped.
 */
export function autoFillRackMissiles(rackPortName, newRackClassName) {
  function findRackSlot(slots) {
    for (const slot of slots) {
      if (slot.portName === rackPortName) return slot;
      for (const sub of slot.ports || []) {
        const found = findRackSlot([sub]);
        if (found) return found;
      }
    }
    return null;
  }
  let rackSlot = findRackSlot(state.currentSlots.missiles || []);
  if (!rackSlot) rackSlot = findRackSlot(state.currentSlots.weapons || []);
  if (!rackSlot || !rackSlot.ports?.length) return;

  // Get the new rack's missile size from its item data
  const rackSi = newRackClassName ? getItemStats(newRackClassName) : null;
  const rackInfo = rackSi?.MissileRack;
  const isBomb = rackSi?.Type?.includes('BombRack') || rackSi?.Type?.includes('BombLauncher');

  if (rackInfo) {
    const missileSize = rackInfo.Size;
    const missileCount = rackInfo.Count;
    const types = isBomb ? ['Bomb'] : null;
    const missile = findDefaultMissile(missileSize, types);
    for (let i = 0; i < rackSlot.ports.length; i++) {
      state.currentLoadout[rackSlot.ports[i].portName] = i < missileCount ? (missile?.className || null) : null;
    }
  } else {
    // No rack selected - clear all sub-ports
    for (const sub of rackSlot.ports) {
      state.currentLoadout[sub.portName] = null;
    }
  }
}

/**
 * Rebuild a slot's sub-ports when its mount/turret is swapped.
 */
export function rebuildSlotPorts(slotPortName, newClassName) {
  function findSlot(slots) {
    for (const slot of slots) {
      if (slot.portName === slotPortName) return slot;
      for (const sub of slot.ports || []) {
        const found = findSlot([sub]);
        if (found) return found;
      }
    }
    return null;
  }
  let slot = null;
  for (const group of Object.values(state.currentSlots)) {
    slot = findSlot(group);
    if (slot) break;
  }
  if (!slot) return;

  // Remove old sub-port loadout entries
  function clearSubPorts(ports) {
    for (const sub of ports) {
      delete state.currentLoadout[sub.portName];
      if (sub.ports) clearSubPorts(sub.ports);
    }
  }
  clearSubPorts(slot.ports || []);

  // Get new item's Ports from stdItem. Some items (e.g. cargo modules like
  // Stor*All Big Box) expose dozens of cosmetic / mechanical sub-ports -
  // door panels, charge handles, close buttons, proximity sensors, light
  // groups, decals - that are physical box machinery, not loadout slots.
  // These are filtered globally by isLoadoutPort. On re-pick we additionally
  // hide locked Mining/Salvage modifier submounts (e.g. a pre-installed
  // ATLS GEO module on a mining laser) so they don't surface as UI noise.
  function isVisibleLoadoutPort(p) {
    if (!isLoadoutPort(p)) return false;
    const types = p.Types || [];
    const isLockedModule = (p.Uneditable || (p.Flags || []).includes('uneditable'))
      && types.every(t => /^(Mining|Salvage)Modifier/i.test(t));
    return !isLockedModule;
  }
  const si = newClassName ? getItemStats(newClassName) : null;
  const newPorts = (si?.Ports || []).filter(isVisibleLoadoutPort);

  // Rebuild sub-port structure (mirrors flattenPort from loadoutManager).
  // Fall back to p.InstalledItem.Ports when the port itself doesn't pre-declare
  // children - that's where a pre-installed gimbal exposes its gun slot
  // (hardpoint_class_2), and where a missile rack exposes its nested missile
  // mounts. WeaponAttachment ports (Barrel/FiringMechanism/PowerArray/Ventilation)
  // on a regular gun would also surface here, but isVisibleLoadoutPort filters
  // them out so we don't render them as empty sub-weapon rows.
  function buildPort(p, parentPath) {
    const uniqueName = parentPath ? `${parentPath}/${p.PortName}` : p.PortName;
    // Extractor formats:
    //  - Legacy:  p.InstalledItem = { ClassName, Name, Type, Ports }
    //  - Current: p.BaseLoadout    = { ClassName, Name, Type, Grade, Class }
    //             (no nested Ports - child slots live on p.Ports)
    // Support both so we don't break on extractor drops mid-flight.
    const installed = p.BaseLoadout || p.InstalledItem;
    const rawChildPorts = (p.Ports && p.Ports.length > 0)
      ? p.Ports
      : (p.InstalledItem?.Ports || []);
    const childPorts = rawChildPorts.filter(isVisibleLoadoutPort);
    const built = {
      portName: uniqueName,
      minSize: p.MinSize,
      maxSize: p.MaxSize,
      types: p.Types || [],
      uneditable: p.Uneditable || false,
      loadout: p.Loadout || installed?.ClassName,
      baseLoadout: installed ? {
        ClassName: installed.ClassName,
        Name: installed.Name,
        Type: installed.Type,
        Grade: installed.Grade,
        Class: installed.Class
      } : null,
      portTags: p.PortTags || [],
      requiredTags: p.RequiredTags || [],
      ports: childPorts.map(sub => buildPort(sub, uniqueName))
    };
    return built;
  }

  slot.ports = newPorts.map(p => buildPort(p, slotPortName));

  // Apply an auto-default pick to a sub-port: write currentLoadout, sync the
  // slot's loadout / baseLoadout fields, and rebuild its child sub-ports from
  // the picked item's stdItem.Ports (filtered through isVisibleLoadoutPort
  // so weapon attachment ports don't surface as visible slots).
  function installPick(sub, pickItem) {
    const className = pickItem.className;
    state.currentLoadout[sub.portName] = className;
    const si = getItemStats(className);
    sub.loadout = className;
    sub.baseLoadout = { ClassName: className, Name: si?.Name, Type: si?.Type };
    sub.ports = (si?.Ports || []).filter(isVisibleLoadoutPort).map(p => buildPort(p, sub.portName));
  }

  // Set default loadout for new sub-ports, auto-equip missile racks
  function setDefaults(ports) {
    for (const sub of ports) {
      if (sub.loadout) {
        state.currentLoadout[sub.portName] = sub.baseLoadout?.ClassName || sub.loadout;
      } else if (sub.uneditable && (sub.types || []).length > 0) {
        // Locked sub-port with no defined item - auto-pick a sensible default
        // so the user isn't stuck with an empty unchangeable slot.
        //
        // For an Uneditable WeaponGun.Gun port (e.g. AEGS_Idris_SCItem_Turret_Large_P /
        // IFR-W57): try a passthrough Mount_Gimbal_S<size> first. The ship
        // hardpoint data installs a gimbal here even though the gimbal's own
        // type (`Turret.GunTurret`) doesn't satisfy isCompatible against
        // `WeaponGun.Gun` - without this the auto-default would lock a bare
        // gun into the port and there'd be no way to change it.
        const isGunPort = (sub.types || []).every(t => t === 'WeaponGun.Gun' || t.startsWith('WeaponGun.Gun.'));
        let pick = null;
        if (isGunPort && sub.maxSize >= 2) {
          const gimbal = findGimbalMount(sub.maxSize, sub.portTags, sub.requiredTags);
          if (gimbal) pick = gimbal;
        }
        if (!pick) {
          const hardpoint = { MinSize: sub.minSize, MaxSize: sub.maxSize, Types: sub.types, PortTags: sub.portTags, RequiredTags: sub.requiredTags };
          const candidates = getCompatibleItems(hardpoint).filter(item => {
            if (/^Default_Fixed_Mount/i.test(item.className)) return false;
            if (item.subType === 'UNDEFINED' && (item.type === 'WeaponGun' || item.type === 'Missile')) return false;
            return true;
          });
          pick = candidates[0] || null;
        }
        if (pick) {
          installPick(sub, pick);
        } else {
          state.currentLoadout[sub.portName] = null;
        }
      } else {
        if (!(sub.portName in state.currentLoadout)) state.currentLoadout[sub.portName] = null;
        // Auto-equip gimbal on turret weapon sub-ports
        const isWeaponSlot = sub.types.some(t => t.includes('WeaponGun'));
        const acceptsTurret = sub.types.some(t => t.includes('Turret'));
        if (isWeaponSlot && acceptsTurret && sub.maxSize >= 2) {
          const hardpoint = { MinSize: sub.minSize, MaxSize: sub.maxSize, Types: sub.types, PortTags: sub.portTags, RequiredTags: sub.requiredTags };
          const gimbals = getCompatibleItems(hardpoint).filter(item =>
            /Gimbal|Mount_Gimbal/i.test(item.className) && !/Default_Fixed/i.test(item.className)
          );
          if (gimbals.length > 0) installPick(sub, gimbals[0]);
        }
        // Auto-equip missile rack slots with compatible rack
        const isMissileRack = sub.types.some(t => t.includes('MissileLauncher') || t.includes('MissileRack'));
        if (isMissileRack) {
          const hardpoint = { MinSize: sub.minSize, MaxSize: sub.maxSize, Types: sub.types, PortTags: sub.portTags, RequiredTags: sub.requiredTags };
          const racks = getCompatibleItems(hardpoint);
          if (racks.length > 0) {
            const rack = racks[0];
            installPick(sub, rack);
            autoFillRackMissiles(sub.portName, rack.className);
          }
        }
      }
      if (sub.ports) setDefaults(sub.ports);
    }
  }
  setDefaults(slot.ports);
}

/**
 * Find the default EM missile for a given size, or default bomb for bomb slots.
 */
export function findDefaultMissile(size, types) {
  const isBomb = types?.some(t => t.toLowerCase().includes('bomb'));
  if (isBomb) {
    return state.allItems.find(item => item.size === size && item.type === 'Bomb') || null;
  }
  const emMissiles = state.allItems.filter(item => {
    if (item.size !== size || item.type !== 'Missile') return false;
    if (item.subType === 'GroundVehicleMissile') return false;
    if (!item.className.startsWith('MISL_')) return false;
    return item.className.includes('_EM_') || (item.tags && item.tags.includes('EM'));
  });
  emMissiles.sort((a, b) => {
    const aSi = a.stdItem?.Missile || {};
    const bSi = b.stdItem?.Missile || {};
    const aDmg = aSi.Explosion ? Object.values(aSi.Explosion.Damage || {}).reduce((x, y) => x + y, 0) : 0;
    const bDmg = bSi.Explosion ? Object.values(bSi.Explosion.Damage || {}).reduce((x, y) => x + y, 0) : 0;
    if (bDmg !== aDmg) return bDmg - aDmg;
    if ((aSi.LockTime || 0) !== (bSi.LockTime || 0)) return (aSi.LockTime || 0) - (bSi.LockTime || 0);
    return (aSi.ArmTime || 0) - (bSi.ArmTime || 0);
  });
  return emMissiles[0] || null;
}

export function renderCollapsedGroup(leaves, parentId) {
  if (leaves.length <= 1) {
    return leaves.map(l => renderSubWeaponSlot(l)).join('');
  }

  const firstLeaf = leaves[0];
  const firstName = firstLeaf.portName in state.currentLoadout ? state.currentLoadout[firstLeaf.portName] : firstLeaf.baseLoadout?.ClassName;
  const allSame = leaves.every(l => {
    const cn = l.portName in state.currentLoadout ? state.currentLoadout[l.portName] : l.baseLoadout?.ClassName;
    return cn === firstName;
  });

  const allPorts = leaves.map(l => l.portName);
  const turretId = parentId || ('grp_' + firstLeaf.portName.replace(/[^a-zA-Z0-9]/g, '_'));

  let html = '';

  if (allSame) {
    // Collapsed view. Use the first leaf's crafted stats so the displayed
    // DPS / meta / ammo react to Impact Force on a grouped weapon
    // (bulk-crafting fans out the same quality to every leaf, so the
    // first leaf is a faithful proxy for the group).
    const si = firstName ? getCraftedItemStats(firstName, firstLeaf.portName) : null;
    const isEmpty = (firstLeaf.portName in state.currentLoadout) && !firstName;
    const name = isEmpty ? 'Empty' : prettifyName(si?.Name || firstLeaf.baseLoadout?.Name || 'Empty');
    const disabledCount = allPorts.reduce((n, p) => n + (state.currentDisabledPorts?.has(p) ? 1 : 0), 0);
    const groupDisabled = disabledCount === allPorts.length;
    const weapDps = groupDisabled ? 0 : getSlotDps(si, firstName);
    const liveCount = allPorts.length - disabledCount;
    const meta = getWeaponMeta(si, leaves.length);
    const ammoInfo = getAmmoInfo(si, leaves.length);
    const editable = !firstLeaf.uneditable;
    const cls = editable ? 'lo-slot' : 'lo-slot uneditable';

    const rightParts = [meta.right, ammoInfo?.text].filter(Boolean);
    const rightStr = rightParts.join(' \u00b7 ');

    const isWeapon = !!si?.Weapon?.Firing?.[0];
    const togglePowered = isWeapon && !isEmpty && disabledCount < allPorts.length;
    const powerToggle = (isWeapon && !isEmpty)
      ? `<button class="lo-power-toggle ${togglePowered ? 'active' : ''}" data-rack-ports='${JSON.stringify(allPorts)}' data-tip="${togglePowered ? 'Powered \u2014 click to turn off' : 'Unpowered \u2014 click to turn on'}"><i class="spvi-power_button"></i></button>`
      : '';
    const slotCls = powerToggle ? cls + ' has-toggle' : cls;
    const metaLeft = groupDisabled ? '<span class="lo-unpowered">Unpowered</span>' : meta.left;
    const metaRightStr = groupDisabled ? '' : rightStr;

    html += `<div class="lo-turret-weapons" id="${turretId}_collapsed">`;
    html += `<div class="lo-slot-row">`;
    html += `<span class="lo-chevron" data-turret="${turretId}" data-tip="Expand">&#9662;</span>`;
    const tagAttr = firstLeaf.portTags?.length ? ` data-port-tags='${JSON.stringify(firstLeaf.portTags)}'` : '';
    const reqTagAttr = firstLeaf.requiredTags?.length ? ` data-required-tags='${JSON.stringify(firstLeaf.requiredTags)}'` : '';
    // Crafting indicator on the collapsed group row. Bulk-crafting:
    // slider edits fan out to every port in `allPorts` so an x4 / x8
    // turret stays in lockstep. Single-weapon mounts behave as before
    // (allPorts is just `[firstLeaf.portName]`).
    const groupCraftIndicator = isEmpty || !firstName ? '' : renderCraftingIndicator(firstLeaf.portName, firstName, allPorts);
    html += `<div class="${slotCls}" data-port="${firstLeaf.portName}" data-min="${firstLeaf.minSize}" data-max="${firstLeaf.maxSize}" data-types='${JSON.stringify(firstLeaf.types)}' data-rack-ports='${JSON.stringify(allPorts)}'${tagAttr}${reqTagAttr}>
      ${powerToggle ? '<div class="lo-slot-content">' : ''}
        <div class="lo-slot-top">
          <span class="lo-size">S${firstLeaf.maxSize}</span>
          <span class="lo-name">${name} <span class="lo-count">x${leaves.length}</span>${getTierDotHtml(si, firstName, firstLeaf.maxSize, firstLeaf.portName)}${groupCraftIndicator}</span>
          ${weapDps > 0 ? `<span class="lo-stat">${fmtStat(weapDps * liveCount)}<span class="lo-stat-unit">DPS</span></span>` : ''}
        </div>
        ${(metaLeft || metaRightStr) ? `<div class="lo-meta"><span>${metaLeft}</span>${metaRightStr ? `<span class="lo-ammo">${metaRightStr}</span>` : ''}</div>` : ''}
      ${powerToggle ? '</div>' : ''}
      ${powerToggle}
    </div>`;
    html += `</div></div>`;
  }

  // Expanded view (hidden if collapsed, shown if mixed weapons)
  html += `<div class="lo-turret-weapons${allSame ? ' lo-expanded-hidden' : ''}" id="${turretId}_expanded">`;
  if (allSame) {
    html += `<div class="lo-collapse-row"><span class="lo-chevron" data-turret="${turretId}" data-collapse="1" data-tip="Collapse">&#9652;</span></div>`;
  }
  for (const leaf of leaves) {
    html += renderSubWeaponSlot(leaf);
  }
  html += `</div>`;

  return html;
}

// Renders the editable mount-header row at the top of a turret / weapon /
// missile-rack group. The header is the click target that opens the swap
// picker. Variants:
//   - opts.rackSwap     : emit data-rack-swap="1" (missile-rack swap mode)
//   - opts.size         : size badge to show instead of the port's maxSize
//                         (a rack port's range can exceed the installed rack)
function renderMountHeader(slot, displayName, opts = {}) {
  const tagAttr = slot.portTags?.length ? ` data-port-tags='${JSON.stringify(slot.portTags)}'` : '';
  const reqTagAttr = slot.requiredTags?.length ? ` data-required-tags='${JSON.stringify(slot.requiredTags)}'` : '';
  const rackSwapAttr = opts.rackSwap ? ' data-rack-swap="1"' : '';
  return `<div class="lo-slot lo-mount-header" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}${rackSwapAttr}>
    <div class="lo-slot-top">
      <span class="lo-size">S${opts.size ?? slot.maxSize}</span>
      <span class="lo-name">${displayName}</span>
    </div>
  </div>`;
}

export function renderSubMountLabel(sub, mountName) {
  const editable = !sub.uneditable && sub.types?.length > 0;
  if (editable) return renderMountHeader(sub, mountName);
  return `<div class="lo-turret-label"><span class="lo-size">S${sub.maxSize}</span>${mountName}</div>`;
}

export function renderWeaponSlot(slot) {
  // Pilot-controlled missile / torpedo launchers (e.g. Idris-P nose
  // HMF-T12) live in the WEAPONS column but ARE missile racks. Delegate
  // to renderMissileSlot so they get the rich rack rendering (count,
  // total damage, lock range, speed) and the rack-swap picker rather
  // than a flat "Torpedo x20" sub-row.
  const installedClass = slot.portName in state.currentLoadout
    ? state.currentLoadout[slot.portName]
    : slot.baseLoadout?.ClassName;
  const installedSi = installedClass ? getItemStats(installedClass) : null;
  const installedType = installedSi?.Type || slot.baseLoadout?.Type || '';
  if (/MissileLauncher|MissileRack/i.test(installedType)) {
    return renderMissileSlot(slot);
  }

  // If slot has sub-ports (gimbal mount or turret), render the mount + sub-weapons
  if (slot.ports.length > 0) {
    const currentMountClass = state.currentLoadout[slot.portName];
    const mountSi = currentMountClass ? getItemStats(currentMountClass) : null;
    const mountName = prettifyName(mountSi?.Name || slot.baseLoadout?.Name || 'Mount');
    const seatSuffix = slot.seatLabel ? ` <span class="lo-seat-label">- ${slot.seatLabel}</span>` : '';
    const mountEditable = !slot.uneditable && slot.types.length > 0;

    // Storage-module short-circuit: if the mounted item is a module whose
    // only sub-ports are Cargo-type (e.g. Stor*All Big Box), collapse the
    // child rows into a single inline SCU stat on the parent row. The
    // user doesn't need to see or configure the interior cargo grid -
    // it's just storage. An untyped sub-port is not cargo: `[].every()` is
    // true, so without the length check a turret whose gimbal ports carry
    // Tags but no Types collapsed into a bare row with its guns hidden.
    const allCargoSubs = slot.ports.every(sub => {
      const types = sub.types || [];
      return types.length > 0 && types.every(t => t === 'Cargo' || t.startsWith('Cargo.'));
    });
    const isStorageModule = mountSi && allCargoSubs && slot.ports.length > 0;
    if (isStorageModule) {
      // Sum SCU from the module's nested CargoGrid capacities.
      function sumCargoGrids(item) {
        let scu = 0;
        if (item?.CargoGrid?.Capacity) scu += item.CargoGrid.Capacity;
        for (const p of (item?.Ports || [])) scu += sumCargoGrids(p.InstalledItem);
        return scu;
      }
      const scu = sumCargoGrids(mountSi);
      const tagAttr = slot.portTags?.length ? ` data-port-tags='${JSON.stringify(slot.portTags)}'` : '';
      const reqTagAttr = slot.requiredTags?.length ? ` data-required-tags='${JSON.stringify(slot.requiredTags)}'` : '';
      const editableAttr = mountEditable ? '' : ' style="cursor:default"';
      return `<div class="lo-slot" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}${editableAttr}>
        <div class="lo-slot-top">
          <span class="lo-size">S${slot.maxSize}</span>
          <span class="lo-name">${mountName}${seatSuffix}</span>
          ${scu > 0 ? `<span class="lo-stat">${fmtStat(scu)}<span class="lo-stat-unit">SCU</span></span>` : ''}
        </div>
      </div>`;
    }

    let html = `<div class="lo-turret-group">`;
    if (mountEditable) {
      html += renderMountHeader(slot, `${mountName}${seatSuffix}`);
    } else {
      html += `<div class="lo-turret-label"><span class="lo-size">S${slot.maxSize}</span>${mountName}${seatSuffix}</div>`;
    }

    const directWeapons = [];
    const subMounts = [];
    const missileRacks = [];
    for (const sub of slot.ports) {
      const isMissileRack = sub.types.some(t => t.includes('MissileLauncher') || t.includes('MissileRack'));
      if (isMissileRack) {
        missileRacks.push(sub);
      } else if (sub.ports && sub.ports.length > 0) {
        subMounts.push(sub);
      } else {
        directWeapons.push(sub);
      }
    }

    if (directWeapons.length > 0) {
      html += renderCollapsedGroup(directWeapons, 'wpn_' + slot.portName.replace(/[^a-zA-Z0-9]/g, '_'));
    }

    if (subMounts.length > 0) {
      const allSubLeaves = [];
      const subMountInfo = [];
      for (const sub of subMounts) {
        const leaves = collectLeafSlots(sub);
        const subMountClass = sub.portName in state.currentLoadout ? state.currentLoadout[sub.portName] : sub.baseLoadout?.ClassName;
        const subMountSi = subMountClass ? getItemStats(subMountClass) : null;
        const mName = prettifyName(subMountSi?.Name || sub.baseLoadout?.Name || 'Mount');
        subMountInfo.push({ name: mName, size: sub.maxSize, leaves, slot: sub });
        allSubLeaves.push(...leaves);
      }

      if (allSubLeaves.length > 0) {
        const turretId = 'sub_' + slot.portName.replace(/[^a-zA-Z0-9]/g, '_');
        const firstCn = allSubLeaves[0].portName in state.currentLoadout ? state.currentLoadout[allSubLeaves[0].portName] : allSubLeaves[0].baseLoadout?.ClassName;
        const allSame = allSubLeaves.length > 1 && allSubLeaves.every(l =>
          (l.portName in state.currentLoadout ? state.currentLoadout[l.portName] : l.baseLoadout?.ClassName) === firstCn
        );

        if (allSame) {
          const si = firstCn ? getCraftedItemStats(firstCn, allSubLeaves[0].portName) : null;
          const isEmpty = (allSubLeaves[0].portName in state.currentLoadout) && !firstCn;
          const name = isEmpty ? 'Empty' : prettifyName(si?.Name || allSubLeaves[0].baseLoadout?.Name || 'Empty');
          const allPorts = allSubLeaves.map(l => l.portName);
          const disabledCount = allPorts.reduce((n, p) => n + (state.currentDisabledPorts?.has(p) ? 1 : 0), 0);
          const groupDisabled = disabledCount === allPorts.length;
          const liveCount = allPorts.length - disabledCount;
          const weapDps = groupDisabled ? 0 : getSlotDps(si, firstCn);
          const meta = getWeaponMeta(si, allSubLeaves.length);
          const ammoInfo = getAmmoInfo(si, allSubLeaves.length);
          const rightParts2 = [meta.right, ammoInfo?.text].filter(Boolean);
          const rightStr2 = rightParts2.join(' \u00b7 ');
          const firstLeaf = allSubLeaves[0];
          const tagAttr = firstLeaf.portTags?.length ? ` data-port-tags='${JSON.stringify(firstLeaf.portTags)}'` : '';
          const reqTagAttr = firstLeaf.requiredTags?.length ? ` data-required-tags='${JSON.stringify(firstLeaf.requiredTags)}'` : '';

          const isWeapon = !!si?.Weapon?.Firing?.[0];
          const togglePowered = isWeapon && !isEmpty && disabledCount < allPorts.length;
          const powerToggle = (isWeapon && !isEmpty)
            ? `<button class="lo-power-toggle ${togglePowered ? 'active' : ''}" data-rack-ports='${JSON.stringify(allPorts)}' data-tip="${togglePowered ? 'Powered \u2014 click to turn off' : 'Unpowered \u2014 click to turn on'}"><i class="spvi-power_button"></i></button>`
            : '';
          const slotCls = powerToggle ? 'lo-slot has-toggle' : 'lo-slot';
          const metaLeft = groupDisabled ? '<span class="lo-unpowered">Unpowered</span>' : meta.left;
          const metaRightStr = groupDisabled ? '' : rightStr2;

          // Bulk crafting across all sub-mount leaves - same fan-out
          // pattern as the top-level allSame branch above (ball turret
          // x2/x4 etc).
          const subGroupCraftIndicator = isEmpty || !firstCn
            ? ''
            : renderCraftingIndicator(firstLeaf.portName, firstCn, allPorts);
          html += `<div class="lo-turret-weapons" id="${turretId}_collapsed">`;
          html += `<div class="lo-slot-row">`;
          html += `<span class="lo-chevron" data-turret="${turretId}" data-tip="Expand">&#9662;</span>`;
          html += `<div class="${slotCls}" data-port="${firstLeaf.portName}" data-min="${firstLeaf.minSize}" data-max="${firstLeaf.maxSize}" data-types='${JSON.stringify(firstLeaf.types)}' data-rack-ports='${JSON.stringify(allPorts)}'${tagAttr}${reqTagAttr}>
            ${powerToggle ? '<div class="lo-slot-content">' : ''}
              <div class="lo-slot-top">
                <span class="lo-size">S${firstLeaf.maxSize}</span>
                <span class="lo-name">${name} <span class="lo-count">x${allSubLeaves.length}</span>${getTierDotHtml(si, firstCn, firstLeaf.maxSize, firstLeaf.portName)}${subGroupCraftIndicator}</span>
                ${weapDps > 0 ? `<span class="lo-stat">${fmtStat(weapDps * liveCount)}<span class="lo-stat-unit">DPS</span></span>` : ''}
              </div>
              ${(metaLeft || metaRightStr) ? `<div class="lo-meta"><span>${metaLeft}</span>${metaRightStr ? `<span class="lo-ammo">${metaRightStr}</span>` : ''}</div>` : ''}
            ${powerToggle ? '</div>' : ''}
            ${powerToggle}
          </div>`;
          html += `</div></div>`;

          html += `<div class="lo-turret-weapons lo-expanded-hidden" id="${turretId}_expanded">`;
          html += `<div class="lo-collapse-row"><span class="lo-chevron" data-turret="${turretId}" data-collapse="1" data-tip="Collapse">&#9652;</span></div>`;
          for (const { name: mName, size, leaves, slot: sub } of subMountInfo) {
            html += `<div class="lo-turret-sub">`;
            html += renderSubMountLabel(sub, mName);
            for (const leaf of leaves) {
              html += renderSubWeaponSlot(leaf);
            }
            html += `</div>`;
          }
          html += `</div>`;
        } else {
          for (const { name: mName, size, leaves, slot: sub } of subMountInfo) {
            html += `<div class="lo-turret-sub">`;
            html += renderSubMountLabel(sub, mName);
            for (const leaf of leaves) {
              html += renderSubWeaponSlot(leaf);
            }
            html += `</div>`;
          }
        }
      }
    }

    for (const rack of missileRacks) {
      html += `<div class="lo-turret-sub">`;
      html += renderMissileSlot(rack);
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  return renderSubWeaponSlot(slot);
}

export function renderSubWeaponSlot(slot) {
  const explicitly = slot.portName in state.currentLoadout;
  const className = explicitly ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  // Crafted - Impact Force flows into Firing[].DamagePerSecond + DamagePerShot
  // so the per-weapon DPS / alpha labels track the slider.
  const si = className ? getCraftedItemStats(className, slot.portName) : null;
  const isEmpty = explicitly && !className;
  const name = isEmpty ? 'Empty' : prettifyName(si?.Name || slot.baseLoadout?.Name || 'Empty');

  const editable = !slot.uneditable;
  const cls = editable ? 'lo-slot' : 'lo-slot uneditable';
  const tagAttr = slot.portTags?.length ? ` data-port-tags='${JSON.stringify(slot.portTags)}'` : '';
  const reqTagAttr = slot.requiredTags?.length ? ` data-required-tags='${JSON.stringify(slot.requiredTags)}'` : '';

  // Salvage modifier sub-port - render scaled Speed / Radius / Efficiency / Rate
  // on the meta line. Tractors keep the Speed value (so the difference between
  // tractors and scrapers is visible) but omit Radius/Efficiency/Rate.
  const salvageStats = getSalvageModifierStats(si);
  if (salvageStats) {
    const { speed, radius, efficiency, rate, isTractor } = salvageStats;
    const metaParts = [];
    if (speed > 0) metaParts.push(`<span data-tip="Speed (SpeedMultiplier × 10)"><span class="lo-val">${fmtStat(speed, speed % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">x Speed</span></span>`);
    if (!isTractor && radius > 0) metaParts.push(`<span data-tip="Effective scrape radius"><span class="lo-val">${fmtStat(radius, radius % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">m Radius</span></span>`);
    if (!isTractor && efficiency > 0) metaParts.push(`<span data-tip="Extraction efficiency"><span class="lo-val">${fmtStat(efficiency, efficiency % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">x Eff</span></span>`);
    if (!isTractor && rate > 0) metaParts.push(`<span data-tip="Scrape rate (RPM / Efficiency)"><span class="lo-val">${fmtStat(rate, rate % 1 ? 1 : undefined)}</span><span class="lo-stat-unit">rate</span></span>`);
    return `<div class="${cls}" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}>
      <div class="lo-slot-top">
        <span class="lo-size">S${slot.maxSize}</span>
        <span class="lo-name">${name}</span>
      </div>
      ${metaParts.length ? `<div class="lo-meta"><span class="lo-ammo">${metaParts.join(' \u00b7 ')}</span></div>` : ''}
    </div>`;
  }

  const isDisabled = state.currentDisabledPorts?.has(slot.portName) ?? false;
  const weapDps = isDisabled ? 0 : getSlotDps(si, className);
  const meta = getWeaponMeta(si);
  const ammoInfo = getAmmoInfo(si);
  const rightParts = [meta.right, ammoInfo?.text].filter(Boolean);
  const rightStr = rightParts.join(' \u00b7 ');

  const tierDot = isEmpty ? '' : getTierDotHtml(si, className, slot.maxSize, slot.portName);

  // Power toggle for any weapon-bearing slot (skips empty / non-weapon slots).
  const isWeapon = !!si?.Weapon?.Firing?.[0];
  const powerToggle = (isWeapon && !isEmpty)
    ? `<button class="lo-power-toggle ${isDisabled ? '' : 'active'}" data-port="${slot.portName}" data-tip="${isDisabled ? 'Unpowered \u2014 click to turn on' : 'Powered \u2014 click to turn off'}"><i class="spvi-power_button"></i></button>`
    : '';
  const slotCls = powerToggle ? cls + ' has-toggle' : cls;
  const metaLeft = isDisabled ? '<span class="lo-unpowered">Unpowered</span>' : meta.left;
  const metaRightStr = isDisabled ? '' : rightStr;

  // Module sub-ports (mining/salvage modifier slots on a head) rendered
  // inline under the host row so the user can pick modules directly.
  const moduleSubs = (slot.ports || []).filter(sub =>
    (sub.types || []).every(t => /^(Mining|Salvage)Modifier|^JumpDrive/i.test(t))
  );
  const modulesHtml = moduleSubs.length > 0
    ? `<div class="lo-module-subs">${moduleSubs.map(sub => {
        const subExplicit = sub.portName in state.currentLoadout;
        const subClass = subExplicit ? state.currentLoadout[sub.portName] : sub.baseLoadout?.ClassName;
        const subSi = subClass ? getItemStats(subClass) : null;
        const subName = (subExplicit && !subClass) ? 'Empty' : prettifyName(subSi?.Name || sub.baseLoadout?.Name || 'Empty');
        const subTags = sub.portTags?.length ? ` data-port-tags='${JSON.stringify(sub.portTags)}'` : '';
        const subReqTags = sub.requiredTags?.length ? ` data-required-tags='${JSON.stringify(sub.requiredTags)}'` : '';
        return `<div class="lo-slot lo-module-sub" data-port="${sub.portName}" data-min="${sub.minSize}" data-max="${sub.maxSize}" data-types='${JSON.stringify(sub.types)}'${subTags}${subReqTags}>
          <div class="lo-slot-top">
            <span class="lo-size">S${sub.maxSize}</span>
            <span class="lo-name">${subName}</span>
          </div>
        </div>`;
      }).join('')}</div>`
    : '';

  const craftIndicator = !isEmpty && className ? renderCraftingIndicator(slot.portName, className) : '';
  return `<div class="${slotCls}" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}>
    ${powerToggle ? '<div class="lo-slot-content">' : ''}
      <div class="lo-slot-top">
        <span class="lo-size">S${slot.maxSize}</span>
        <span class="lo-name">${name}${tierDot}${craftIndicator}</span>
        ${weapDps > 0 ? `<span class="lo-stat">${fmtStat(weapDps)}<span class="lo-stat-unit">DPS</span></span>` : ''}
      </div>
      ${(metaLeft || metaRightStr) ? `<div class="lo-meta"><span>${metaLeft}</span>${metaRightStr ? `<span class="lo-ammo">${metaRightStr}</span>` : ''}</div>` : ''}
    ${powerToggle ? '</div>' : ''}
    ${powerToggle}
  </div>${modulesHtml}`;
}

// A slot is a "module host" if its children are all module modifier ports
// (e.g. a mining/salvage laser with MiningModifier consumable slots). In that
// case the slot itself is the leaf weapon - its module sub-ports are
// rendered inline underneath via renderSubWeaponSlot.
//
// A mining laser or salvage head only ever hosts module ports, so the host's
// own type decides too: built-in laser modules can sit on ports typed
// `UNDEFINED.Gun` or left untyped, which the port-type check alone misses
// (the laser then vanished and its modules rendered as the mount's weapons).
function hasOnlyModuleChildren(slot) {
  const subs = slot.ports || [];
  if (subs.length === 0) return false;
  const hostCls = slot.portName in state.currentLoadout ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  const hostType = (hostCls && getItemStats(hostCls)?.Type) || slot.baseLoadout?.Type || '';
  if (/^(WeaponMining|SalvageHead)(\.|$)/.test(hostType)) return true;
  return subs.every(sub =>
    (sub.types || []).every(t => /^(Mining|Salvage)Modifier|^JumpDrive/i.test(t))
  );
}

export function collectLeafSlots(slot) {
  const leaves = [];
  if (slot.ports && slot.ports.length > 0 && !hasOnlyModuleChildren(slot)) {
    for (const sub of slot.ports) leaves.push(...collectLeafSlots(sub));
  } else {
    leaves.push(slot);
  }
  return leaves;
}

/**
 * Classify a whole turret by whether it engages a ship hull, mirroring the TTK
 * exclusion rule (ttkCalc.classifyTurretWeapon). A turret is 'pdc' or
 * 'antipersonnel' only when EVERY mounted weapon classifies that way; otherwise
 * 'combat'. Drives the sub-category headers under the TURRETS section so the
 * user can see which turrets are skipped in turret DPS (and why).
 *
 * @returns {'combat'|'antipersonnel'|'pdc'}
 */
export function classifyTurret(slot) {
  const leaves = collectLeafSlots(slot);
  if (!leaves.length) return 'combat';
  let allPdc = true;
  let allAntiPersonnel = true;
  for (const leaf of leaves) {
    const cn = state.currentLoadout[leaf.portName] || leaf.baseLoadout?.ClassName;
    const si = cn ? getItemStats(cn) : null;
    const d = si?.Weapon?.Firing?.[0]?.DamagePerShot;
    const role = classifyTurretWeapon(
      slot.category,
      si?.Size || 0,
      d ? { phys: d.Physical || 0, energy: d.Energy || 0, dist: d.Distortion || 0 } : {},
    );
    if (role !== 'pdc') allPdc = false;
    if (role !== 'antipersonnel') allAntiPersonnel = false;
  }
  if (allPdc) return 'pdc';
  if (allAntiPersonnel) return 'antipersonnel';
  return 'combat';
}

export function renderTurretGroup(slot) {
  const currentMountClass = state.currentLoadout[slot.portName];
  const mountSi = currentMountClass ? getItemStats(currentMountClass) : null;
  const mountName = prettifyName(mountSi?.Name || slot.baseLoadout?.Name || 'Turret');
  const posSuffix = slot.position ? ` <span class="lo-seat-label">(${slot.position})</span>` : '';
  const seatSuffix = slot.seatLabel ? ` <span class="lo-seat-label">- ${slot.seatLabel}</span>` : '';
  const mountEditable = !slot.uneditable && slot.types.length > 0;
  let html = `<div class="lo-turret-group">`;
  if (mountEditable) {
    html += renderMountHeader(slot, `${mountName}${posSuffix}${seatSuffix}`);
  } else {
    html += `<div class="lo-turret-label"><span class="lo-size">S${slot.maxSize}</span>${mountName}${posSuffix}${seatSuffix}</div>`;
  }

  // Slot is itself a weapon with no sub-ports (e.g. static gatlings).
  // Use crafted stats so the DPS line below reacts to Impact Force.
  const weaponSi = currentMountClass
    ? getCraftedItemStats(currentMountClass, slot.portName)
    : (slot.baseLoadout?.ClassName ? getItemStats(slot.baseLoadout.ClassName) : null);
  if ((!slot.ports || slot.ports.length === 0) && weaponSi?.Weapon?.Firing?.[0]) {
    const weapCls = currentMountClass || slot.baseLoadout?.ClassName;
    const isDisabled = state.currentDisabledPorts?.has(slot.portName) ?? false;
    const weapDps = isDisabled ? 0 : getSlotDps(weaponSi, weapCls);
    const meta = getWeaponMeta(weaponSi, 1);
    const ammoInfo = getAmmoInfo(weaponSi, 1);
    const rightParts = [meta.right, ammoInfo?.text].filter(Boolean);
    const rightStr = rightParts.join(' \u00b7 ');
    const metaLeft = isDisabled ? '<span class="lo-unpowered">Unpowered</span>' : meta.left;
    const metaRightStr = isDisabled ? '' : rightStr;
    const powerToggle = `<button class="lo-power-toggle ${isDisabled ? '' : 'active'}" data-port="${slot.portName}" data-tip="${isDisabled ? 'Unpowered \u2014 click to turn on' : 'Powered \u2014 click to turn off'}"><i class="spvi-power_button"></i></button>`;
    html += `<div class="lo-turret-weapons"><div class="lo-slot-row"><div class="lo-slot uneditable has-toggle">
      <div class="lo-slot-content">
        <div class="lo-slot-top">
          <span class="lo-size">S${weaponSi.Size || slot.maxSize}</span>
          <span class="lo-name">${mountName}${getTierDotHtml(weaponSi, weapCls, slot.maxSize, slot.portName)}</span>
          ${weapDps > 0 ? `<span class="lo-stat">${fmtStat(weapDps)}<span class="lo-stat-unit">DPS</span></span>` : ''}
        </div>
        ${(metaLeft || metaRightStr) ? `<div class="lo-meta"><span>${metaLeft}</span>${metaRightStr ? `<span class="lo-ammo">${metaRightStr}</span>` : ''}</div>` : ''}
      </div>
      ${powerToggle}
    </div></div></div>`;
    html += `</div>`;
    return html;
  }

  const directWeapons = [];
  const missileRacks = [];
  for (const sub of slot.ports || []) {
    const isMissileRack = sub.types.some(t => t.includes('MissileLauncher') || t.includes('MissileRack'));
    if (isMissileRack) {
      missileRacks.push(sub);
    } else {
      const leaves = collectLeafSlots(sub);
      directWeapons.push(...leaves);
    }
  }

  if (directWeapons.length > 0) {
    html += renderCollapsedGroup(directWeapons, 'turret_' + slot.portName.replace(/[^a-zA-Z0-9]/g, '_'));
  }

  for (const rack of missileRacks) {
    html += `<div class="lo-turret-sub">`;
    html += renderMissileSlot(rack);
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

export function renderMissileSlot(slot) {
  const rackExplicit = slot.portName in state.currentLoadout;
  const rackClassName = rackExplicit ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  const rackSi = rackClassName ? getItemStats(rackClassName) : null;
  const rackName = (rackExplicit && !rackClassName) ? 'Empty' : prettifyName(rackSi?.Name || slot.baseLoadout?.Name || 'Missile Rack');
  const rackEditable = !slot.uneditable;
  const rackSize = rackSi?.Size || slot.maxSize;

  let html = `<div class="lo-turret-group">`;

  if (rackEditable) {
    html += renderMountHeader(slot, rackName, { rackSwap: true, size: rackSize });
  } else {
    html += `<div class="lo-turret-label"><span class="lo-size">S${rackSize}</span>${rackName}</div>`;
  }

  const rackMissileInfo = rackSi?.MissileRack;
  const missileCount = rackMissileInfo?.Count || slot.ports.length;
  const missileSize = rackMissileInfo?.Size || slot.ports[0]?.maxSize;

  if (slot.ports.length > 0 && missileCount > 0) {
    const firstSub = slot.ports[0];
    const subExplicit = firstSub.portName in state.currentLoadout;
    const className = subExplicit ? state.currentLoadout[firstSub.portName] : (firstSub.baseLoadout?.ClassName || null);
    const si = className ? getItemStats(className) : null;
    const name = (subExplicit && !className) ? 'Empty' : prettifyName(si?.Name || firstSub.baseLoadout?.Name || 'Empty');
    const editable = !firstSub.uneditable;
    const cls = editable ? 'lo-slot' : 'lo-slot uneditable';
    const allPorts = slot.ports.slice(0, missileCount).map(s => s.portName);
    const pickerSize = missileSize || firstSub.maxSize;

    const missile = si?.Missile || {};
    const bomb = si?.Bomb || {};
    const isBombItem = !!si?.Bomb;
    const explosionData = isBombItem ? bomb.Explosion : missile.Explosion;
    let unitDmg = explosionData ? Object.values(explosionData.Damage || {}).reduce((a, b) => a + b, 0) : 0;
    if (!isBombItem && si?.Ports) {
      for (const port of si.Ports) {
        const subM = port.InstalledItem?.Missile;
        if (subM?.Explosion?.Damage) unitDmg += Object.values(subM.Explosion.Damage).reduce((a, b) => a + b, 0);
      }
    }
    const totalDmg = unitDmg * missileCount;

    const dmgHtml = totalDmg > 0 ? `<span class="lo-stat">${fmtStat(totalDmg)}<span class="lo-stat-unit">DMG</span></span>` : '';
    const typeLabel = !isBombItem && missile.TrackingSignal ? `<span class="lo-val">${missile.TrackingSignal}</span>` : '';
    let metaRight = '';
    if (isBombItem) {
      const radius = explosionData?.Radius || 0;
      if (radius > 0) metaRight = `<span class="lo-val">${fmtStat(radius)}</span> m radius`;
    } else {
      const metaParts = [];
      if (missile.LockRangeMin > 0 || missile.LockRangeMax > 0) metaParts.push(`<span class="lo-val">${fmtStat(missile.LockRangeMin || 0)}</span> - <span class="lo-val">${fmtStat(missile.LockRangeMax || 0)}</span> m`);
      if (missile.Speed > 0) metaParts.push(`<span class="lo-val">${fmtStat(missile.Speed)}</span> m/s`);
      metaRight = metaParts.join(' \u00b7 ');
    }

    html += `<div class="lo-turret-weapons">`;
    html += `<div class="${cls}" data-port="${firstSub.portName}" data-min="${pickerSize}" data-max="${pickerSize}" data-types='${JSON.stringify(firstSub.types)}' data-rack-ports='${JSON.stringify(allPorts)}'>
      <div class="lo-slot-top">
        <span class="lo-size">S${pickerSize}</span>
        <span class="lo-name">${name}${missileCount > 1 ? ` <span class="lo-count">x${missileCount}</span>` : ''}</span>
        ${dmgHtml}
      </div>
      ${(typeLabel || metaRight) ? `<div class="lo-meta"><span>${typeLabel}</span>${metaRight ? `<span class="lo-ammo">${metaRight}</span>` : ''}</div>` : ''}
    </div>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function extractRowData(item) {
  const si = item.stdItem || {};
  const rn = si.ResourceNetwork || [];

  let power = 0, powerDraw = 0, cooling = 0, em = 0, ir = 0;
  let powerMax = 0, powerMin = 0;
  for (const node of rn) {
    if (node.Generation) for (const g of node.Generation) {
      if (g.Resource === 'Power') power += g.Segment || 0;
    }
    if (node.Conversion) for (const c of node.Conversion) {
      if (c.Generation?.Resource === 'Coolant') cooling += c.Generation.UnitPerSec || 0;
      if (c.Consumption?.Resource === 'Power') {
        const seg = c.Consumption.Segment || 0;
        const minFrac = c.MinConsumptionFraction || 0;
        powerDraw += seg;
        powerMax = seg;
        powerMin = Math.round(seg * minFrac);
      }
    }
    if (node.Consumption) for (const c of node.Consumption) {
      if (c.Resource === 'Power') {
        const seg = c.Segment || c.UnitPerSec || 0;
        powerDraw += seg;
        if (seg > 0 && powerMax === 0) {
          powerMax = seg;
          powerMin = Math.round(seg * (c.MinConsumptionFraction || 0));
        }
      }
    }
    if (node.Signatures) {
      // Max, not sum - QDs ship with two ResourceNetwork entries (spool /
      // cruise modes) carrying identical EM nominals. Only one mode is
      // active at a time. Single-node items collapse to their own value.
      const emN = node.Signatures.Electromagnetic?.Nominal || 0;
      const irN = node.Signatures.Infrared?.Nominal || 0;
      if (emN > em) em = emN;
      if (irN > ir) ir = irN;
    }
  }

  const shield = si.Shield || {};
  const qd = si.QuantumDrive?.StandardJump || {};
  const radar = si.Radar || {};
  const aim = radar.AimAssist || {};
  const firing = si.Weapon?.Firing?.[0] || {};
  const dpsObj = firing.DamagePerSecond || {};
  const dpsShot = firing.DamagePerShot || {};
  const ammo = si.Weapon?.Ammunition || {};
  const missile = si.Missile || {};
  // Bombs carry their stats under `Bomb` (Explosion.Radius, not MaxRadius), so
  // the Missile columns read zero for them unless this is folded in.
  const bombExp = si.Bomb?.Explosion;
  const bombDmg = bombExp ? Object.values(bombExp.Damage || {}).reduce((a, b) => a + b, 0) : 0;

  return {
    className: item.className,
    sold: item.sold ?? null,
    name: prettifyName(si.Name || item.className),
    size: item.size || si.Size || 0,
    class: si.Class || '',
    grade: si.Grade ?? 0,
    gradeLabel: si.Grade != null ? String.fromCharCode(64 + si.Grade) : '',
    manufacturer: si.Manufacturer?.Name || '',
    mass: si.Mass || 0,
    health: si.Durability?.Health || 0,
    // Distortion HP - separate pool from regular Health, depleted by
    // distortion damage. Path: Durability.Distortion.MaximumDamage.
    distHp: si.Durability?.Distortion?.MaximumDamage || 0,
    // Grace period before a distortion-filled pool starts bleeding back off.
    // Any distortion hit restarts it, so an attacker holding fire for less
    // than this loses nothing.
    distDecayDelay: si.Durability?.Distortion?.DecayDelay || 0,
    // How long the plant stays down once the pool is saturated: the delay plus
    // the full drain at DecayRate. That is exactly Durability.Distortion
    // .RecoveryTime - verified equal to DecayDelay + MaximumDamage / DecayRate
    // on all 77 plants in both Live 4.9 and PTU 4.10 - so the shipped field is
    // used rather than recomputing it.
    distShutdown: si.Durability?.Distortion?.RecoveryTime || 0,
    // Shield
    hp: shield.Health || 0,
    regen: shield.RegenRate || 0,
    downDelay: shield.DownedDelay || 0,
    dmgDelay: shield.DamagedDelay || 0,
    resPhys: shield.Resistance?.Physical ? Math.round(shield.Resistance.Physical.Maximum * 100) : 0,
    resEnergy: shield.Resistance?.Energy ? Math.round(shield.Resistance.Energy.Maximum * 100) : 0,
    resDist: shield.Resistance?.Distortion ? Math.round(shield.Resistance.Distortion.Maximum * 100) : 0,
    // Power
    power,
    powerDraw,
    powerMin,
    powerMax,
    cooling,
    em, ir,
    // QD
    speed: qd.Speed ? qd.Speed / 1000000 : 0,
    speedKm: qd.Speed ? Math.round(qd.Speed / 1000) : 0,
    spool: qd.SpoolUpTime || 0,
    cooldown: qd.Cooldown || 0,
    qdRange: (() => {
      for (const node of rn) {
        if (!node.Consumption) continue;
        for (const c of node.Consumption) {
          if (c.Resource === 'QuantumFuel' && c.MicroUnitPerSec) {
            return Math.round(state.currentQFuelCapacity / (c.MicroUnitPerSec / 1000) * 100) / 100;
          }
        }
      }
      return 0;
    })(),
    // JumpDrive (sub-item on modern Quantum Drives - tuning/alignment/fuel)
    jdTuningRate: si.JumpDrive?.TuningRate || 0,
    jdAlignmentRate: si.JumpDrive?.AlignmentRate || 0,
    jdFuelMult: si.JumpDrive?.FuelUsageEfficiencyMultiplier || 0,
    // Radar
    aimMin: aim.DistanceMin || aim.DistanceMinAssignment || 0,
    aimMax: aim.DistanceMax || aim.DistanceMaxAssignment || 0,
    aimBuffer: aim.OutsideRangeBufferDistance || 0,
    detIR: radar.IR?.Sensitivity ?? 0,
    detEM: radar.EM?.Sensitivity ?? 0,
    detCS: radar.CS?.Sensitivity ?? 0,
    detRS: radar.RS?.Sensitivity ?? 0,
    emAtMin: (() => {
      if (!em || !powerMin || !powerMax) return 0;
      let mod = 0;
      for (const node of rn) {
        if (!node.PowerRanges) continue;
        const ranges = Object.values(node.PowerRanges).filter(r => r.RegisterRange).sort((a, b) => a.Start - b.Start);
        for (const r of ranges) { if (powerMin >= r.Start) mod = r.Modifier; }
        break;
      }
      return Math.round(em * mod * (powerMin / powerMax));
    })(),
    // Weapon
    alpha: Object.values(dpsShot).reduce((a, b) => a + b, 0) || 0,
    // computeBurstDPS uses BurstRoundsPerMinute when present so the
    // picker's "Burst DPS" column shows inner-burst peak rather than
    // sustained-avg-with-pauses (matches Erkul/SPViewer).
    burstDps: computeBurstDPS(firing) || 0,
    dps: Object.values(dpsObj).reduce((a, b) => a + b, 0) || 0,
    weapSpeed: ammo.Speed || 0,
    range: ammo.Range || 0,
    penetration: ammo.Penetration?.BasePenetrationDistance ?? 0,
    // Explosive ammunition: the round detonates for area damage on top of its
    // impact hit. Keyed off DetonationDamage rather than ExplosionRadius so a
    // hypothetical radius-without-damage entry doesn't read as explosive. In
    // Live 4.9.0.12344265 exactly 21 guns carry it (the Distortion repeaters /
    // Suckerpunch line, the Jericho / Liberator / Yebira families, the
    // Salvation-class distortion scatterguns and the Slayer Cannon).
    explosive: Object.values(ammo.DetonationDamage || {}).some(v => v > 0),
    rpm: firing.RoundsPerMinute || 0,
    weapType: si.Weapon ? deriveWeaponType(item.className || '', item.tags || '', dpsShot, si.Name || '') : '',
    deflTier: state.weaponTierMap.get(`${si.Name || item.className}||${item.size || si.Size || 0}`) || null,
    sustDps: state.weaponSustMap.get(`${si.Name || item.className}||${item.size || si.Size || 0}`) || null,
    ammoInfo: state.weaponAmmoMap.get(`${si.Name || item.className}||${item.size || si.Size || 0}`) || null,
    type: si.Type?.split('.')?.pop() || '',
    // Missile
    missileType: missile.TrackingSignal || '',
    missileDmg: (() => {
      let dmg = missile.Explosion ? Object.values(missile.Explosion.Damage || {}).reduce((a, b) => a + b, 0) : 0;
      if (si.Ports) {
        for (const port of si.Ports) {
          const subMissile = port.InstalledItem?.Missile;
          if (subMissile?.Explosion?.Damage) {
            dmg += Object.values(subMissile.Explosion.Damage).reduce((a, b) => a + b, 0);
          }
        }
      }
      return dmg + bombDmg;
    })(),
    missileSpeed: missile.Speed || 0,
    missileAcq: missile.LockRate ? Math.round(1 / missile.LockRate * 100) / 100 : 0,
    missileArm: missile.ArmTime || si.Bomb?.ArmTime || 0,
    missileLock: missile.LockTime || 0,
    missileIgnite: missile.IgniteTime || 0,
    missileLockAngle: missile.LockAngle || 0,
    missileLockMin: missile.LockRangeMin || 0,
    missileLockMax: missile.LockRangeMax || 0,
    missileRadius: missile.Explosion?.MaxRadius || bombExp?.Radius || 0,
    // Mount/Turret
    mountPorts: si.Ports ? si.Ports.filter(p => p.Types?.some(t => t.includes('WeaponGun'))).length : 0,
    mountPortSize: si.Ports ? (() => {
      const weapPorts = si.Ports.filter(p => p.Types?.some(t => t.includes('WeaponGun')));
      return weapPorts.length > 0 ? weapPorts[0].MaxSize : 0;
    })() : 0,
    // Mining laser module slots - count editable MiningModifier ports
    miningModules: si.Ports ? si.Ports.filter(p =>
      (p.Types || []).some(t => t.startsWith('MiningModifier')) &&
      !(p.Uneditable || (p.Flags || []).includes('uneditable'))
    ).length : 0,
    // Tractor beam stats (TractorBeam items). Force is stored in Newtons;
    // divide by 1000 for the kN display used in-game and in the picker.
    ...(() => {
      const tb = si.TractorBeam;
      const t = tb?.Tractor?.[0];
      if (!t) return {};
      return {
        tbMaxForce: (t.MaxForce || 0) / 1000,
        tbMinForce: (t.MinForce || 0) / 1000,
        tbMaxDistance: t.MaxDistance || 0,
        tbMaxAngle: t.MaxAngle || 0,
        tbMaxVolume: t.MaxVolume || 0
      };
    })(),
    // Mining head stats (WeaponMining items). Pulled from MiningLaser: the
    // laser-mode Firing entry carries beam power and the optimal/min damage
    // distances; the parent object carries the stone-interaction modifiers.
    ...(() => {
      const ml = si.MiningLaser;
      if (!ml) return {};
      const laser = (ml.Firing || []).find(f => f.Mode === 'laser') || {};
      const maxPow = laser.LaserPower || 0;
      return {
        miningMaxPower: maxPow,
        miningMinPower: Math.round(maxPow * (ml.ThrottleMinimum || 0)),
        miningMaxPwrRange: laser.FullDamageDistance || 0,
        miningMinPwrRange: laser.MinDamageDistance || 0,
        miningResistance: ml.ResistanceModifier || 0,
        miningInstability: ml.LaserInstability || 0,
        miningChargeZone: ml.OptimalChargeWindowModifier || 0,
        miningChargeRate: ml.OptimalWindowRateModifier || 0,
        miningInertMaterials: ml.InertMaterialsFilter || 0
      };
    })(),
    // Mining module (MiningModifier item) - flatten the four-layer Modifiers array.
    // Layer 0 = fracture power, 1 = extract power, 2 = rock stats, 3 = inert filter.
    ...(() => {
      const modObj = si.Module;
      if (!modObj) return {};
      const layers = modObj.Modifiers || [];
      const stone = layers[2] || {};
      const toPct = v => (v == null || v === 1) ? 0 : Math.round((v - 1) * 1000) / 10;
      return {
        modCharges: modObj.Charges || 0,
        // null when no Duration on the stone layer → rendered as "Passive"
        modDuration: stone.Duration ? stone.Duration : null,
        modFracturePower: toPct(layers[0]?.LaserPowerModifier),
        modExtractPower: toPct(layers[1]?.LaserPowerModifier),
        modResistance: stone.ResistanceModifier || 0,
        modInstability: stone.LaserInstability || 0,
        modOptimalRate: stone.OptimalChargeWindowRateModifier || 0,
        modOverchargeRate: stone.CatastrophicChargeWindowRateModifier || 0,
        modWindowSize: stone.OptimalChargeWindowSizeModifier || 0,
        modShatterDmg: stone.ShatterDamageModifier || 0,
        // InertMaterialsFilter is stored positive in data but represents reduction.
        modInertMaterials: layers[3]?.InertMaterialsFilter ? -layers[3].InertMaterialsFilter : 0
      };
    })(),
    isMountItem: item.type === 'Turret',
    // Raw item type from loadoutManager - used by the picker to group
    // rows into visual sections when a port accepts multiple categories
    // (e.g. Super Hornet Mk II center hardpoint: Turret.BallTurret + Module).
    itemType: item.type || '',
    // Salvage modifier - scaled stats from SalvageModifier[0] via head base constants.
    // Tractors keep their Speed value (so the difference between tractors and
    // scrapers is visible in the picker) but omit Radius / Efficiency / Rate.
    ...(() => {
      const sm = getSalvageModifierStats(si);
      if (!sm) return { modSpeed: 0, modRadius: 0, modEfficiency: 0, modRate: 0 };
      return {
        modSpeed: sm.speed,
        modRadius: sm.isTractor ? 0 : sm.radius,
        modEfficiency: sm.isTractor ? 0 : sm.efficiency,
        modRate: sm.isTractor ? 0 : sm.rate
      };
    })(),
    // FlightBlade (Ifcs)
    ...(() => {
      const ifcs = si.Ifcs;
      if (!ifcs) return {};
      const av = ifcs.AngularVelocity || {};
      const mm = ifcs.MasterModes || {};
      const ab = ifcs.AfterBurner || {};
      const avm = ab.AngVelocityMultiplier || {};
      return {
        fbScm: ifcs.SCMSpeed || 0,
        fbBoost: mm.BoostSpeedForward || 0,
        fbPitch: av.Pitch || 0,
        fbYaw: av.Yaw || 0,
        fbRoll: av.Roll || 0,
        fbBPitch: Math.round((av.Pitch || 0) * (avm.x || 1)),
        fbBYaw: Math.round((av.Yaw || 0) * (avm.y || 1)),
        fbBRoll: Math.round((av.Roll || 0) * (avm.z || 1))
      };
    })()
  };
}

// Column definitions per component type
const PICKER_COLUMNS = {
  Shield: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class', sortFn: (a, b) => a.class.localeCompare(b.class) },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'hp', label: 'HP', num: true },
    { key: 'regen', label: 'Regen/s', num: true },
    { key: 'downDelay', label: 'Down Delay', num: true, unit: 's' },
    { key: 'dmgDelay', label: 'Dmg Delay', num: true, unit: 's' },
    { key: 'powerMin', label: 'Pwr Min', num: true },
    { key: 'powerMax', label: 'Pwr Max', num: true },
    { key: 'em', label: 'EM', num: true },
    { key: 'distHp', label: 'Dist HP', num: true },
    { key: 'health', label: 'Health', num: true },
    { key: 'mass', label: 'Mass', num: true }
  ],
  PowerPlant: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class', sortFn: (a, b) => a.class.localeCompare(b.class) },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'power', label: 'Power', num: true },
    { key: 'em', label: 'EM', num: true },
    { key: 'distHp', label: 'Dist HP', num: true },
    { key: 'distDecayDelay', label: 'Decay Delay', num: true, unit: 's', decimals: 1 },
    { key: 'distShutdown', label: 'Shutdown', num: true, unit: 's', decimals: 1 },
    { key: 'health', label: 'Health', num: true },
    { key: 'mass', label: 'Mass', num: true }
  ],
  Cooler: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class', sortFn: (a, b) => a.class.localeCompare(b.class) },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'cooling', label: 'Cooling', num: true },
    { key: 'powerMin', label: 'Pwr Min', num: true },
    { key: 'powerMax', label: 'Pwr Max', num: true },
    { key: 'em', label: 'EM', num: true },
    { key: 'ir', label: 'IR', num: true },
    { key: 'distHp', label: 'Dist HP', num: true },
    { key: 'health', label: 'Health', num: true },
    { key: 'mass', label: 'Mass', num: true }
  ],
  QuantumDrive: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class', sortFn: (a, b) => a.class.localeCompare(b.class) },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'speedKm', label: 'Speed (km/s)', num: true },
    { key: 'qdRange', label: 'Max Range (Gm)', num: true, decimals: 2 },
    { key: 'spool', label: 'Spool', num: true, unit: 's' },
    { key: 'cooldown', label: 'Cooldown', num: true, unit: 's' },
    { key: 'powerDraw', label: 'Power Draw', num: true },
    { key: 'em', label: 'EM', num: true },
    { key: 'distHp', label: 'Dist HP', num: true },
    { key: 'health', label: 'Health', num: true },
    { key: 'mass', label: 'Mass', num: true }
  ],
  Radar: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class', sortFn: (a, b) => a.class.localeCompare(b.class) },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'aimMin', label: 'Aim Min', num: true },
    { key: 'aimMax', label: 'Aim Max', num: true },
    { key: 'aimBuffer', label: 'Aim Buffer', num: true },
    { key: 'detIR', label: 'IR', num: true, decimals: 2 },
    { key: 'detEM', label: 'EM', num: true, decimals: 2 },
    { key: 'detCS', label: 'CS', num: true, decimals: 2 },
    { key: 'detRS', label: 'RS', num: true, decimals: 2 },
    { key: 'powerMin', label: 'Min Power', num: true },
    { key: 'powerMax', label: 'Max Power', num: true },
    { key: 'emAtMin', label: 'EM Min', num: true },
    { key: 'em', label: 'EM Max', num: true },
    { key: 'distHp', label: 'Dist HP', num: true },
    { key: 'health', label: 'Health', num: true }
  ],
  Module: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) }
  ],
  Missile: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'missileType', label: 'Type' },
    { key: 'missileDmg', label: 'Damage', num: true },
    { key: 'missileSpeed', label: 'Speed', num: true },
    { key: 'missileAcq', label: 'Acquisition', num: true, unit: 's', decimals: 2 },
    { key: 'missileArm', label: 'Arm', num: true, unit: 's', decimals: 2 },
    { key: 'missileLock', label: 'Lock', num: true, unit: 's', decimals: 2 },
    { key: 'missileIgnite', label: 'Ignite', num: true, unit: 's', decimals: 1 },
    { key: 'missileLockAngle', label: 'Lock \u00b0', num: true },
    { key: 'missileLockMin', label: 'Lock Min', num: true },
    { key: 'missileLockMax', label: 'Lock Max', num: true },
    { key: 'health', label: 'Health', num: true }
  ],
  WeaponGun: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'deflTier', label: 'Defl', custom: true },
    { key: 'weapType', label: 'Type', sortFn: (a, b) => (a.weapType || '').localeCompare(b.weapType || '') },
    { key: 'alpha', label: 'Alpha', num: true },
    { key: 'burstDps', label: 'Burst DPS', num: true },
    { key: 'sustDps', label: 'Sust DPS', num: true },
    { key: 'weapSpeed', label: 'Speed', num: true },
    { key: 'ammoInfo', label: 'Ammo', custom: true },
    { key: 'penetration', label: 'Pen Dist', num: true, decimals: 1 },
    { key: 'rpm', label: 'RPM', num: true },
    { key: 'range', label: 'Range', num: true },
    { key: 'powerDraw', label: 'Power', num: true, decimals: 1 },
    { key: 'em', label: 'EM', num: true },
    { key: 'health', label: 'Health', num: true },
    // Ascending puts non-explosive first, matching the numeric columns'
    // smallest-first convention; a second click groups the explosive guns.
    { key: 'explosive', label: 'Explosive', custom: true, sortFn: (a, b) => (a.explosive ? 1 : 0) - (b.explosive ? 1 : 0) }
  ],
  Default: [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'class', label: 'Class' },
    { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
    { key: 'health', label: 'Health', num: true },
    { key: 'mass', label: 'Mass', num: true }
  ]
};
PICKER_COLUMNS.JumpDrive = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'class', label: 'Class' },
  { key: 'gradeLabel', label: 'Grade', sortFn: (a, b) => a.grade - b.grade },
  { key: 'jdTuningRate', label: 'Tuning Rate', num: true, decimals: 2 },
  { key: 'jdAlignmentRate', label: 'Alignment Rate', num: true, decimals: 2 },
  { key: 'jdFuelMult', label: 'Fuel Usage', num: true, decimals: 1, prefix: 'x' },
  { key: 'health', label: 'Health', num: true }
];
PICKER_COLUMNS.FlightController = [
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'fbScm', label: 'SCM', num: true },
  { key: 'fbBoost', label: 'Boost', num: true },
  { key: 'fbPitch', label: 'Pitch', num: true },
  { key: 'fbYaw', label: 'Yaw', num: true },
  { key: 'fbRoll', label: 'Roll', num: true }
];
PICKER_COLUMNS.Bomb = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'missileDmg', label: 'Damage', num: true },
  { key: 'missileRadius', label: 'Radius', num: true },
  { key: 'missileArm', label: 'Arm', num: true, unit: 's', decimals: 2 },
  { key: 'health', label: 'Health', num: true }
];
PICKER_COLUMNS.MiningModifier = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'modCharges', label: 'Charges', num: true, hideZero: true },
  { key: 'modDuration', label: 'Duration', custom: true },
  { key: 'modFracturePower', label: 'Fracture Power', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modExtractPower', label: 'Extract Power', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modResistance', label: 'Resistance', num: true, pct: true, hideZero: true, signed: true, decimals: 1 },
  { key: 'modInstability', label: 'Instability', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modOptimalRate', label: 'Optimal Rate', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modOverchargeRate', label: 'Overch. Rate', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modWindowSize', label: 'Window Size', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modShatterDmg', label: 'Shatter dmg', num: true, pct: true, hideZero: true, signed: true },
  { key: 'modInertMaterials', label: 'Inert Materials', num: true, pct: true, hideZero: true, signed: true, decimals: 1 }
];
PICKER_COLUMNS.WeaponMining = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'miningModules', label: 'Module Slots', num: true },
  { key: 'miningMaxPower', label: 'Max Power', num: true },
  { key: 'miningMinPower', label: 'Min Power', num: true },
  { key: 'miningMaxPwrRange', label: 'Max Pwr Range', num: true },
  { key: 'miningMinPwrRange', label: 'Min Pwr Range', num: true },
  { key: 'miningResistance', label: 'Resistance', num: true, pct: true, hideZero: true, signed: true },
  { key: 'miningInstability', label: 'Instability', num: true, pct: true, hideZero: true, signed: true },
  { key: 'miningChargeZone', label: 'Charge Zone', num: true, pct: true, hideZero: true, signed: true },
  { key: 'miningChargeRate', label: 'Charge Rate', num: true, pct: true, hideZero: true, signed: true },
  { key: 'miningInertMaterials', label: 'Inert Materials', num: true, pct: true, hideZero: true, signed: true }
];
PICKER_COLUMNS.TractorBeam = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'tbMaxForce', label: 'Max Force', num: true },
  { key: 'tbMinForce', label: 'Min Force', num: true, decimals: 1 },
  { key: 'tbMaxDistance', label: 'Max Distance', num: true },
  { key: 'tbMaxAngle', label: 'Max Angle', num: true },
  { key: 'tbMaxVolume', label: 'Max Volume', num: true }
];
PICKER_COLUMNS.SalvageModifier = [
  { key: 'size', label: 'Size', num: true },
  { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
  { key: 'modSpeed', label: 'Speed', num: true, hideZero: true },
  { key: 'modRadius', label: 'Radius', num: true, decimals: 2, hideZero: true },
  { key: 'modEfficiency', label: 'Extraction Efficiency', num: true, decimals: 2, hideZero: true }
];

// ClassName fragments of items that never belong in a picker (alien and
// event-only hardware, dev leftovers). Matched against the whole className,
// so a fragment naming a ship also hides that ship's own flight blades and
// mounts - keep ship names out of this list. Ship-integrated missile racks
// are handled by findShipIntegratedRacks in loadoutManager instead.
export const BESPOKE_PATTERNS = /Fury|VNCL|Vanduul|SanTokYai|Cyclone_MT|_TEMP_|_CitCon|BANU_EnergyRepeater|Bengal_Turret/i;

export function openPicker(slotEl) {
  const port = slotEl.dataset.port;
  const min = parseInt(slotEl.dataset.min) || 0;
  const max = parseInt(slotEl.dataset.max) || 99;
  let types = [];
  try { types = JSON.parse(slotEl.dataset.types); } catch { }
  let rackPorts = null;
  try { rackPorts = JSON.parse(slotEl.dataset.rackPorts); } catch { }
  const isRackSwap = slotEl.dataset.rackSwap === '1';
  let portTags = [];
  try { portTags = JSON.parse(slotEl.dataset.portTags); } catch { }
  let portRequiredTags = [];
  try { portRequiredTags = JSON.parse(slotEl.dataset.requiredTags); } catch { }

  const hardpoint = { MinSize: min, MaxSize: max, Types: types, PortTags: portTags, RequiredTags: portRequiredTags };
  let compatible = getCompatibleItems(hardpoint);
  compatible = compatible.filter(item => {
    const si = item.stdItem || {};
    const name = si.Name || item.className || '';
    const cls = si.Class || '';
    if (name === 'Radar' || cls.includes('@LOC_') || name.includes('@LOC_')) return false;
    // Drop hand-curated deprecated items (see DEPRECATED_ITEMS at the top
    // of this file for the blocklist and rationale).
    if (DEPRECATED_ITEMS.has(item.className)) return false;
    return true;
  });
  const currentClass = state.currentLoadout[port];

  const primaryType = types[0]?.split('.')[0] || 'Default';
  const columns = PICKER_COLUMNS[primaryType] || PICKER_COLUMNS.Default;

  const PICKER_LABELS = {
    Shield: 'Shield', PowerPlant: 'Power Plant', Cooler: 'Cooler',
    QuantumDrive: 'Quantum Drive', JumpDrive: 'Quantum Drive',
    Radar: 'Radar', WeaponGun: 'Weapon',
    WeaponMining: 'Mining Laser', MiningModifier: 'Mining Module',
    Turret: 'Turret', UtilityTurret: 'Utility Turret', Module: 'Module',
    Missile: 'Missile', Bomb: 'Bomb',
    MissileLauncher: 'Missile Rack', MissileRack: 'Missile Rack',
    BombLauncher: 'Bomb Rack', BombRack: 'Bomb Rack',
    SalvageHead: 'Salvage Head', SalvageModifier: 'Salvage Module',
    TractorBeam: 'Tractor Beam', TowingBeam: 'Towing Beam',
    EMP: 'EMP', WeaponDefensive: 'Countermeasure',
    FlightController: 'Flight Blade'
  };
  const pickerLabel = isRackSwap ? 'Missile Rack' : (PICKER_LABELS[primaryType] || 'Component');

  const rows = compatible
    .filter(item => {
      if (BESPOKE_PATTERNS.test(item.className)) return false;
      if (item.subType === 'GroundVehicleMissile') return false;
      if (item.subType === 'Rocket') return false;
      const isWeaponType = item.type === 'WeaponGun' || item.type === 'Missile' || item.type === 'MissileLauncher' || item.type === 'BombLauncher' || item.type === 'Bomb';
      if (item.subType === 'UNDEFINED' && isWeaponType) return false;
      const si = item.stdItem;
      if (si && si.Name === si.ClassName) return false;
      const turretOnly = primaryType === 'Turret' && types.every(t => t.startsWith('Turret'));
      if (turretOnly && item.type !== 'Turret') return false;
      if (!turretOnly && item.type === 'Turret' && !/Gimbal|Mount/i.test(item.className) && !item.requiredTags) return false;
      if (/^Default_Fixed_Mount/i.test(item.className)) return false;
      // Tag matching is handled by getCompatibleItems → isCompatible.
      return true;
    })
    .map(item => extractRowData(item));

  // Deduplicate: same Name+Size, or for weapons / salvage modifiers same stats
  const seenNames = new Map();
  const seenStats = new Set();
  const dedupedRows = [];
  for (const row of rows) {
    const nameKey = `${row.name}||${row.size}`;
    if (seenNames.has(nameKey)) {
      if (primaryType === 'WeaponGun' && row.burstDps > 0) {
        const prev = seenNames.get(nameKey);
        if (prev.burstDps === 0) {
          const idx = dedupedRows.indexOf(prev);
          if (idx >= 0) dedupedRows[idx] = row;
          seenNames.set(nameKey, row);
        }
      }
      // Salvage modifier variants with different stats are kept separately -
      // multiple Cinch Scraper Modules with distinct Speed/Radius/Eff are real
      // game variants and should all be selectable.
      if (primaryType === 'SalvageModifier') {
        const r = v => Math.round((v || 0) * 1000);
        const statKey = `${row.size}||${r(row.modSpeed)}||${r(row.modRadius)}||${r(row.modEfficiency)}`;
        if (!seenStats.has(statKey)) {
          seenStats.add(statKey);
          dedupedRows.push(row);
        }
      }
      continue;
    }
    if (primaryType === 'WeaponGun' && row.className !== currentClass) {
      const r = v => Math.round(v * 100);
      const statKey = `${row.size}||${row.weapType}||${r(row.burstDps)}||${r(row.alpha)}||${row.rpm}||${row.weapSpeed}||${row.range}||${r(row.penetration)}||${row.health}`;
      if (seenStats.has(statKey)) continue;
      seenStats.add(statKey);
    }
    if (primaryType === 'SalvageModifier') {
      const r = v => Math.round((v || 0) * 1000);
      const statKey = `${row.size}||${r(row.modSpeed)}||${r(row.modRadius)}||${r(row.modEfficiency)}`;
      seenStats.add(statKey);
    }
    seenNames.set(nameKey, row);
    dedupedRows.push(row);
  }

  rows.length = 0;
  rows.push(...dedupedRows);


  const defaultSorts = {
    Shield: (a, b) => (b.hp - a.hp) || (a.grade - b.grade),
    PowerPlant: (a, b) => (b.power - a.power) || a.name.localeCompare(b.name),
    Cooler: (a, b) => (b.cooling - a.cooling) || (a.powerMax - b.powerMax) || a.name.localeCompare(b.name),
    QuantumDrive: (a, b) => (b.speedKm - a.speedKm) || a.name.localeCompare(b.name),
    JumpDrive: (a, b) => (b.jdTuningRate - a.jdTuningRate) || (b.size - a.size) || a.name.localeCompare(b.name),
    Radar: (a, b) => (b.aimMax - a.aimMax) || (b.aimMin - a.aimMin) || a.name.localeCompare(b.name),
    WeaponGun: (a, b) => (b.burstDps - a.burstDps) || (b.sustDps - a.sustDps) || (b.size - a.size),
    Missile: (a, b) => (b.missileDmg - a.missileDmg) || (b.size - a.size) || a.name.localeCompare(b.name),
    Bomb: (a, b) => (b.missileDmg - a.missileDmg) || (b.size - a.size) || a.name.localeCompare(b.name),
    SalvageModifier: (a, b) => (b.modEfficiency - a.modEfficiency) || (b.modSpeed - a.modSpeed) || a.name.localeCompare(b.name),
    WeaponMining: (a, b) => (b.miningMaxPower - a.miningMaxPower) || (b.size - a.size) || a.name.localeCompare(b.name),
    TractorBeam: (a, b) => (b.tbMaxForce - a.tbMaxForce) || (b.size - a.size) || a.name.localeCompare(b.name)
  };
  const defaultSort = defaultSorts[primaryType] || ((a, b) => a.name.localeCompare(b.name));

  let hasMixedTypes = types.some(t => t.startsWith('Turret')) && types.some(t => t.startsWith('WeaponGun'));
  let mountRows = [];
  let weaponRows = [];
  if (hasMixedTypes) {
    const allMounts = rows.filter(r => r.isMountItem);
    mountRows = allMounts;
    weaponRows = rows.filter(r => !r.isMountItem);
    if (mountRows.length === 0) hasMixedTypes = false;
    mountRows.sort((a, b) => a.name.localeCompare(b.name));
    weaponRows.sort(defaultSorts.WeaponGun || defaultSort);
  } else {
    rows.sort(defaultSort);
  }

  // Category grouping for multi-type ports (e.g. Super Hornet Mk II center
  // hardpoint: `Turret.BallTurret` + `Module`). When the port accepts more
  // than one item category AND we're not already using the mount/weapon
  // split above, we render section labels ("Turrets" / "Modules") between
  // category groups in the main table so it's obvious these are distinct
  // kinds of items, not all turrets.
  const CATEGORY_LABELS = {
    Turret: 'Turrets',
    Module: 'Modules',
    WeaponGun: 'Weapons',
    MissileLauncher: 'Missile Racks',
    BombLauncher: 'Bomb Racks',
    Missile: 'Missiles',
    Bomb: 'Bombs'
  };
  // Build ordered list of categories that actually have rows, preserving
  // the order declared by the port's Types array so primary intent wins.
  const portCategories = [...new Set(types.map(t => t.split('.')[0]))];
  const categoryOrder = portCategories.filter(cat => rows.some(r => r.itemType === cat));
  const hasCategoryGroups = !hasMixedTypes && categoryOrder.length > 1;
  if (hasCategoryGroups) {
    // Sort each category independently, then concatenate in port order so
    // filtering/search still operates on a flat row list.
    const grouped = [];
    for (const cat of categoryOrder) {
      const catRows = rows.filter(r => r.itemType === cat);
      catRows.sort(defaultSort);
      grouped.push(...catRows);
    }
    rows.length = 0;
    rows.push(...grouped);
  }

  const mountColumns = [
    { key: 'size', label: 'Size', num: true },
    { key: 'name', label: 'Name', sortFn: (a, b) => a.name.localeCompare(b.name) },
    { key: 'mountPorts', label: 'Ports', num: true },
    { key: 'mountPortSize', label: 'Port Size', num: true },
    { key: 'health', label: 'HP', num: true }
  ];

  const overlay = document.createElement('div');
  overlay.className = 'lo-picker';

  const mountTableHTML = hasMixedTypes ? `
      <table class="lo-picker-table lo-picker-mount-table">
        <thead><tr>${mountColumns.map(c => `<th data-key="${c.key}">${c.label}</th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>` : '';

  const isWeaponPicker = primaryType === 'WeaponGun';
  let weaponFilterHTML = '';
  // Reuse the module-level Sets so checkbox toggles persist across openings.
  const pickerCheckedSizes = _weaponPickerFilters.sizes;
  const pickerCheckedTypes = _weaponPickerFilters.types;
  let pickerAvailSizes = [];
  let pickerAvailTypes = [];
  if (isWeaponPicker) {
    const srcRows = hasMixedTypes ? weaponRows : rows;
    pickerAvailSizes = [...new Set(srcRows.map(r => r.size))].sort((a, b) => a - b);
    pickerAvailTypes = [...new Set(srcRows.map(r => r.weapType).filter(Boolean))].sort();
    // Drop persisted sizes / types that aren't relevant for this picker so a
    // stored "S5" filter doesn't blank out an S1 picker.
    const availSizeStrs = new Set(pickerAvailSizes.map(String));
    for (const s of [...pickerCheckedSizes]) if (!availSizeStrs.has(s)) pickerCheckedSizes.delete(s);
    const availTypeSet = new Set(pickerAvailTypes);
    for (const t of [...pickerCheckedTypes]) if (!availTypeSet.has(t)) pickerCheckedTypes.delete(t);
    weaponFilterHTML = `
      <div class="lo-picker-filters">
        <div class="ms-wrap"><button class="ms-toggle" id="pickerSizeToggle">All Sizes <span class="ms-arrow">&#9662;</span></button><div class="ms-dropdown" id="pickerSizeDropdown"></div></div>
        <div class="ms-wrap"><button class="ms-toggle" id="pickerTypeToggle">All Types <span class="ms-arrow">&#9662;</span></button><div class="ms-dropdown" id="pickerTypeDropdown"></div></div>
        <input type="number" id="pickerFilterSpeedMin" placeholder="Min Speed" class="lo-picker-speed">
        <input type="number" id="pickerFilterSpeedMax" placeholder="Max Speed" class="lo-picker-speed">
      </div>`;
  }

  overlay.innerHTML = `<div class="lo-picker-panel lo-picker-wide">
    <div class="lo-picker-header">
      <h3>Select ${pickerLabel} (S${min}${min !== max ? '-S' + max : ''})</h3>
      <button class="lo-picker-close">&times;</button>
    </div>
    <div class="lo-picker-actions"${primaryType === 'FlightController' ? ' style="display:none"' : ''}>
      <button class="lo-picker-empty" id="pickerEmpty">Leave empty</button>
      <input type="text" class="search-box" placeholder="Search&hellip;" id="pickerSearch" style="flex:1">
    </div>
    ${weaponFilterHTML}
    <div class="lo-picker-list">
      ${mountTableHTML}
      <table class="lo-picker-table">
        <thead><tr>${columns.map(c => `<th data-key="${c.key}">${c.label}</th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>`;

  document.body.appendChild(overlay);

  const mountTbody = hasMixedTypes ? overlay.querySelector('.lo-picker-mount-table tbody') : null;
  const weaponTbody = overlay.querySelector('.lo-picker-table:last-of-type tbody');
  let sortKey = null, sortAsc = true;

  function renderTableRows(targetTbody, rowData, cols) {
    // When the port has multiple category groups (e.g. Turret + Module),
    // inject a section header <tr> before each category's first row so
    // users can tell turrets from modules at a glance.
    let lastCategory = null;
    targetTbody.innerHTML = rowData.map(row => {
      let sectionHeader = '';
      if (hasCategoryGroups && row.itemType !== lastCategory) {
        lastCategory = row.itemType;
        const label = CATEGORY_LABELS[row.itemType] || row.itemType;
        sectionHeader = `<tr class="lo-picker-group-header"><td colspan="${cols.length}">${label}</td></tr>`;
      }
      const isCurrent = row.className === currentClass;
      const notSold = row.sold === 0;
      return `${sectionHeader}<tr class="${isCurrent ? 'current' : ''}${notSold ? ' loot-only' : ''}" data-class="${row.className}">
        ${cols.map(c => {
          if (c.custom && c.key === 'deflTier') {
            const tier = row.deflTier;
            if (!tier) return `<td></td>`;
            const meta = TIER_META.get(tier);
            if (!meta) return `<td></td>`;
            const tierKey = `${row.name}||${row.size}`;
            const immuneNames = tier !== TOP_TIER ? (state.weaponImmuneMap.get(tierKey) || []) : [];
            const immuneAttr = immuneNames.length > 0 ? ` data-immune="${immuneNames.join('\n').replace(/"/g, '&quot;')}"` : '';
            // The picker spells the tier out - eight ramp colours are more than
            // a 0.5em dot can carry, and the column has room for two letters.
            // Immune count is skipped at the top tier, where nothing is immune.
            const countSuffix = immuneNames.length > 0 ? ` <span class="defl-count">${immuneNames.length}</span>` : '';
            return `<td><span class="defl-badge defl-tier-${escapeHtml(tier)}"${immuneAttr}>${escapeHtml(meta.badge)}</span>${countSuffix}</td>`;
          }
          if (c.custom && c.key === 'ammoInfo') {
            const a = row.ammoInfo;
            if (!a) return '<td>\u2014</td>';
            if (a.isEnergy) {
              return `<td>${fmtStat(a.effective)}/\u221E</td>`;
            }
            if (a.effective === a.total) {
              return `<td>${fmtStat(a.total)}</td>`;
            }
            return `<td>${fmtStat(a.effective)}/${fmtStat(a.total)}</td>`;
          }
          if (c.custom && c.key === 'explosive') {
            // Tick / cross rather than a blank-vs-mark column so "no explosive
            // ammo" reads as a deliberate answer instead of missing data.
            return row.explosive
              ? '<td class="lo-explosive yes" title="Explosive ammunition (detonates for area damage)">✓</td>'
              : '<td class="lo-explosive no" title="No explosive ammunition">✗</td>';
          }
          if (c.custom && c.key === 'modDuration') {
            // Mining module Duration: numeric seconds for active modules,
            // "Passive" for modules with no duration entry.
            const d = row.modDuration;
            if (d == null) return '<td class="lo-passive">Passive</td>';
            return `<td>${fmtStat(d)}s</td>`;
          }
          let val = row[c.key];
          if (c.hideZero && (val == null || val === 0)) return `<td></td>`;
          const rawNum = (c.num && typeof val === 'number') ? val : null;
          if (c.pct && val != null) val = val + '%';
          else if (c.num && val != null) val = typeof val === 'number' ? fmtStat(val, c.decimals ?? (c.unit ? 1 : undefined)) : val;
          if (c.unit && val != null && val !== '\u2014') val = val + c.unit;
          if (c.prefix && val != null && val !== '\u2014') val = c.prefix + val;
          // Show explicit sign for signed percent/numeric columns (e.g. "+35%")
          if (c.signed && rawNum != null && rawNum > 0 && typeof val === 'string' && val[0] !== '+' && val[0] !== '-') {
            val = '+' + val;
          }
          return `<td>${val ?? '\u2014'}</td>`;
        }).join('')}
      </tr>`;
    }).join('');
  }

  function renderRows(filteredRows) {
    if (hasMixedTypes) {
      const fMounts = filteredRows.filter(r => r.isMountItem);
      const fWeapons = filteredRows.filter(r => !r.isMountItem);
      renderTableRows(mountTbody, fMounts, mountColumns);
      renderTableRows(weaponTbody, fWeapons, columns);
    } else {
      renderTableRows(weaponTbody, filteredRows, columns);
    }

    bindImmuneDotTooltips(overlay);

    overlay.querySelectorAll('.lo-picker-table tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const newClass = tr.dataset.class;
        // Re-picking the same item is a no-op for the rebuild path. Without
        // this guard, swapping a turret to itself wipes the ship-data
        // sub-port enrichments (e.g. the pre-installed Mount_Gimbal that
        // the SHIP hardpoint declares but the turret stdItem doesn't), and
        // the auto-default ends up picking a bare gun into the locked
        // WeaponGun.Gun port - surfacing the gun's WeaponAttachment ports
        // as visible slots.
        const isSameClass = (newClass || null) === (state.currentLoadout[port] || null);
        const ports = rackPorts || [port];
        for (const p of ports) {
          state.currentLoadout[p] = newClass;
          // Reset per-port crafting state on item swap - each component
          // starts at default quality (q=500 on every slot). Per-port
          // semantics, not per-className, so two ports with the same item
          // stay independent.
          if (!isSameClass) state.clearPortCrafting(p);
        }
        if (isRackSwap) {
          autoFillRackMissiles(port, newClass);
        }
        const newSi = newClass ? getItemStats(newClass) : null;
        const newItemType = newSi?.Type || '';
        // Items whose Ports list defines sub-loadout slots that depend on
        // the equipped item itself - turrets / modules / missile / bomb
        // racks, plus mining lasers (MiningModifier slots) and salvage
        // heads (SalvageModifier slots). Swapping any of these has to
        // rebuild the slot's children to match the new item's spec.
        // E.g. Lancet MH1 has 1 module slot but Helix I has 2; without
        // this branch the slot kept the original count.
        const HOST_TYPE_RE = /Turret|Module|MissileLauncher|BombLauncher|WeaponMining|SalvageHead/;
        if (!isSameClass) {
          if (HOST_TYPE_RE.test(newItemType)) {
            rebuildSlotPorts(port, newClass);
          } else if (HOST_TYPE_RE.test(primaryType)) {
            rebuildSlotPorts(port, null);
          }
        }
        if (primaryType === 'Shield') {
          state.setCurrentShieldOverrides(null);
          saveShieldSelection(state.currentShipName, null);
        }
        if (newItemType.includes('Module') || primaryType === 'Module') {
          if (_syncModuleSubPorts) _syncModuleSubPorts();
        }
        saveLoadout(state.currentShipName, state.currentLoadout);
        if (_persistTabs) _persistTabs();
        rebuildPipAllocation(true);
        overlay.remove();
        if (_renderAllSlots) _renderAllSlots();
        if (_renderStats) _renderStats();
      });
    });
  }

  const allRows = hasMixedTypes ? [...mountRows, ...weaponRows] : rows;
  renderRows(allRows);

  // Lock the initial height as a floor so the panel doesn't visually
  // shrink/jump when the user types into the search box, but still allow
  // it to grow (up to the CSS max-height: 80vh) when a filter is cleared
  // and the row count goes back up. setTimeout (not rAF) so the lock
  // still applies if the tab is in the background.
  setTimeout(() => {
    const panel = overlay.querySelector('.lo-picker-panel');
    if (panel) panel.style.minHeight = panel.offsetHeight + 'px';
  }, 0);

  overlay.querySelector('#pickerEmpty').addEventListener('click', () => {
    const ports = rackPorts || [port];
    for (const p of ports) {
      state.currentLoadout[p] = null;
      state.clearPortCrafting(p);
    }
    if (isRackSwap) autoFillRackMissiles(port, null);
    if (primaryType === 'Turret' || primaryType === 'Module') {
      rebuildSlotPorts(port, null);
    }
    if (primaryType === 'Module') {
      if (_syncModuleSubPorts) _syncModuleSubPorts();
    }
    if (primaryType === 'Shield') {
      state.setCurrentShieldOverrides(null);
      saveShieldSelection(state.currentShipName, null);
    }
    saveLoadout(state.currentShipName, state.currentLoadout);
    if (_persistTabs) _persistTabs();
    rebuildPipAllocation(true);
    overlay.remove();
    if (_renderAllSlots) _renderAllSlots();
    if (_renderStats) _renderStats();
  });

  overlay.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = true; }
      const col = columns.find(c => c.key === key) || mountColumns.find(c => c.key === key);
      if (!col) return;
      const sk = col.sortKey || key;
      const isMountTable = th.closest('.lo-picker-mount-table');
      const targetRows = isMountTable ? mountRows : (hasMixedTypes ? weaponRows : rows);
      targetRows.sort((a, b) => {
        if (col.sortFn) return sortAsc ? col.sortFn(a, b) : col.sortFn(b, a);
        if (col.num || col.sortKey) return sortAsc ? (a[sk] || 0) - (b[sk] || 0) : (b[sk] || 0) - (a[sk] || 0);
        return sortAsc ? String(a[sk]).localeCompare(String(b[sk])) : String(b[sk]).localeCompare(String(a[sk]));
      });
      applyFilters();
      th.closest('thead').querySelectorAll('th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(sortAsc ? 'sorted-asc' : 'sorted-desc');
    });
  });

  overlay.querySelector('.lo-picker-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const searchInput = overlay.querySelector('#pickerSearch');
  searchInput.focus();

  const filterSpeedMin = overlay.querySelector('#pickerFilterSpeedMin');
  const filterSpeedMax = overlay.querySelector('#pickerFilterSpeedMax');

  if (isWeaponPicker) {
    // Restore persisted speed filter values before wiring the multi-selects
    // so the initial applyFilters() call sees the right state.
    if (filterSpeedMin) filterSpeedMin.value = _weaponPickerFilters.speedMin;
    if (filterSpeedMax) filterSpeedMax.value = _weaponPickerFilters.speedMax;
    buildPickerMultiSelect(overlay, 'pickerSizeToggle', 'pickerSizeDropdown', pickerAvailSizes.map(String), pickerCheckedSizes, 'All Sizes', 'Sizes', applyFilters, s => 'S' + s);
    buildPickerMultiSelect(overlay, 'pickerTypeToggle', 'pickerTypeDropdown', pickerAvailTypes, pickerCheckedTypes, 'All Types', 'Types', applyFilters);
    // Apply once so the initial render reflects any restored filters.
    applyFilters();
  }

  function applyFilters() {
    const q = searchInput.value.toLowerCase();
    const fSpeedMin = filterSpeedMin?.value ? parseInt(filterSpeedMin.value) : 0;
    const fSpeedMax = filterSpeedMax?.value ? parseInt(filterSpeedMax.value) : 0;

    const searchAll = hasMixedTypes ? [...mountRows, ...weaponRows] : rows;
    const filtered = searchAll.filter(r => {
      if (q && !r.name.toLowerCase().includes(q) && !r.class.toLowerCase().includes(q) && !r.manufacturer.toLowerCase().includes(q)) return false;
      if (!r.isMountItem && isWeaponPicker) {
        if (pickerCheckedSizes.size > 0 && !pickerCheckedSizes.has(String(r.size))) return false;
        if (pickerCheckedTypes.size > 0 && !pickerCheckedTypes.has(r.weapType)) return false;
        if (fSpeedMin && r.weapSpeed < fSpeedMin) return false;
        if (fSpeedMax && r.weapSpeed > fSpeedMax) return false;
      }
      return true;
    });
    renderRows(filtered);
  }

  searchInput.addEventListener('input', applyFilters);
  if (filterSpeedMin) filterSpeedMin.addEventListener('input', () => {
    _weaponPickerFilters.speedMin = filterSpeedMin.value;
    applyFilters();
  });
  if (filterSpeedMax) filterSpeedMax.addEventListener('input', () => {
    _weaponPickerFilters.speedMax = filterSpeedMax.value;
    applyFilters();
  });
}

function buildPickerMultiSelect(container, toggleId, dropdownId, values, checkedSet, allLabel, pluralLabel, onChange, labelFn) {
  buildMultiSelect({
    scope: container, toggleId, dropdownId, values, checkedSet,
    allLabel, pluralLabel, onChange, labelFn,
  });
}

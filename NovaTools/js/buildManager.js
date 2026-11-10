/**
 * buildManager.js - named builds UI and module sub-port management.
 */
import * as state from './loadoutState.js';
import { getItemStats, getCompatibleItems, isLoadoutForOtherHull } from './loadoutManager.js';
import { saveNamedBuild, getNamedBuilds, deleteNamedBuild, renameNamedBuild, saveLoadout, saveShieldSelection, saveDisabledPorts, savePipAllocation } from './stateStore.js';
import { escapeHtml } from './utils.js';

// Render callbacks set by the orchestrator
let _rebuildPipAllocation = null;
let _renderAllSlots = null;
let _renderStats = null;
let _persistTabs = null;

export function setRenderCallbacks(rebuildPipAllocation, renderAllSlots, renderStats, persistTabs) {
  _rebuildPipAllocation = rebuildPipAllocation;
  _renderAllSlots = renderAllSlots;
  _renderStats = renderStats;
  _persistTabs = persistTabs;
}

/**
 * Sync module sub-ports into the main systems/missiles arrays.
 * When a module is equipped, its shield ports are injected into currentSlots.systems
 * and its missile ports are injected into currentSlots.missiles.
 * When a module is removed/changed, old injected ports are cleaned up.
 */
export function syncModuleSubPorts() {
  // Remove previously injected module ports
  state.currentSlots.systems = state.currentSlots.systems.filter(s => !s.fromModule);
  state.currentSlots.missiles = state.currentSlots.missiles.filter(s => !s.fromModule);

  // Scan all module slots for equipped modules
  for (const moduleSlot of (state.currentSlots.modules || [])) {
    const moduleClass = moduleSlot.portName in state.currentLoadout ? state.currentLoadout[moduleSlot.portName] : moduleSlot.baseLoadout?.ClassName;
    if (!moduleClass) continue;

    const moduleSi = getItemStats(moduleClass);
    if (!moduleSi?.Ports) continue;

    // Find shield ports in the module
    for (const port of moduleSi.Ports) {
      if (port.Types?.some(t => t.includes('Shield'))) {
        const portName = `${moduleSlot.portName}/${port.PortName}`;
        const defaultClass = port.InstalledItem?.ClassName || null;
        state.currentSlots.systems.push({
          category: 'Shields',
          portName,
          minSize: port.MinSize,
          maxSize: port.MaxSize,
          types: port.Types || [],
          uneditable: false,
          loadout: defaultClass,
          baseLoadout: port.InstalledItem ? { ClassName: defaultClass, Name: port.InstalledItem.Name } : null,
          ports: [],
          fromModule: true
        });
        // Set default loadout if not already set
        if (!(portName in state.currentLoadout)) {
          state.currentLoadout[portName] = defaultClass;
        }
      }
    }

    // Find missile rack ports in the module - create individual rack entries
    const missilePorts = moduleSi.Ports.filter(p =>
      p.Types?.some(t => t.includes('Missile'))
    );
    for (const mPort of missilePorts) {
      const rackPortName = `${moduleSlot.portName}/${mPort.PortName}`;
      const defaultRackClass = mPort.InstalledItem?.ClassName || null;
      const rackSi = defaultRackClass ? getItemStats(defaultRackClass) : null;

      // Build sub-ports from the module's port tree (has InstalledItem with default missiles),
      // falling back to the item DB entry (which may lack defaults)
      const rackPortSource = mPort.InstalledItem?.Ports || rackSi?.Ports || [];
      const rackSubPorts = rackPortSource.map(p => {
        const subPortName = `${rackPortName}/${p.PortName}`;
        return {
          portName: subPortName,
          minSize: p.MinSize,
          maxSize: p.MaxSize,
          types: p.Types || [],
          uneditable: false,
          loadout: p.InstalledItem?.ClassName || null,
          baseLoadout: p.InstalledItem ? { ClassName: p.InstalledItem.ClassName, Name: p.InstalledItem.Name } : null,
          ports: []
        };
      });

      state.currentSlots.missiles.push({
        category: 'Missile Rack',
        portName: rackPortName,
        minSize: mPort.MinSize,
        maxSize: mPort.MaxSize,
        types: mPort.Types || [],
        uneditable: true, // rack itself is not swappable, only missiles are
        loadout: defaultRackClass,
        baseLoadout: mPort.InstalledItem ? { ClassName: defaultRackClass, Name: mPort.InstalledItem.Name } : null,
        ports: rackSubPorts,
        fromModule: true
      });

      // Set default loadout for the rack and its missile sub-ports
      if (!(rackPortName in state.currentLoadout)) {
        state.currentLoadout[rackPortName] = defaultRackClass;
      }
      for (const sub of rackSubPorts) {
        if (!(sub.portName in state.currentLoadout)) {
          state.currentLoadout[sub.portName] = sub.baseLoadout?.ClassName || null;
        }
      }
    }
  }

  // Reset shield overrides when module changes shield count
  state.setCurrentShieldOverrides(null);
  saveShieldSelection(state.currentShipName, null);
}

export function renderModuleSlot(slot) {
  const explicitly = slot.portName in state.currentLoadout;
  const className = explicitly ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  const si = className ? getItemStats(className) : null;
  const isEmpty = !className;
  const name = isEmpty ? 'Empty' : (si?.Name || 'Unknown Module');

  // Build sub-port summary
  let moduleMeta = '';
  if (si?.Ports && si.Ports.length > 0) {
    const shieldPorts = si.Ports.filter(p => p.Types?.some(t => t.includes('Shield')));
    const missilePorts = si.Ports.filter(p => p.Types?.some(t => t.includes('Missile')));
    const cargoPorts = si.Ports.filter(p => p.InstalledItem?.Type?.includes('Door') || p.PortName?.toLowerCase().includes('cargo'));

    const parts = [];
    if (missilePorts.length > 0) parts.push(`<span class="lo-val">${missilePorts.length}</span>x missile slots`);
    if (shieldPorts.length > 0) parts.push(`<span class="lo-val">${shieldPorts.length}</span>x shield`);
    if (cargoPorts.length > 0) {
      // Sum SCU from CargoGrid.Capacity in all nested sub-ports
      let totalSCU = 0;
      function findCargoGrids(item) {
        if (!item) return;
        if (item.CargoGrid?.Capacity) totalSCU += item.CargoGrid.Capacity;
        for (const p of (item.Ports || [])) {
          findCargoGrids(p.InstalledItem);
        }
      }
      findCargoGrids(si);
      parts.push(totalSCU > 0 ? `+<span class="lo-val">${totalSCU}</span> scu cargo` : '+cargo');
    }
    if (parts.length > 0) {
      moduleMeta = `<div class="lo-meta"><span class="lo-meta-text">${parts.join(' · ')}</span></div>`;
    }
  }

  return `<div class="lo-slot" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}' data-port-tags='${JSON.stringify(slot.portTags || [])}' data-required-tags='${JSON.stringify(slot.requiredTags || [])}'>
    <div class="lo-slot-top">
      <span class="lo-size">S${slot.maxSize}</span>
      <span class="lo-name${isEmpty ? ' lo-empty' : ''}">${name}</span>
    </div>
    ${moduleMeta}
  </div>`;
}

export function gatherCurrentBuild() {
  // Collect current pip allocations as key→allocated map
  const pips = {};
  if (state.currentPipAllocation?.channels) {
    for (const ch of state.currentPipAllocation.channels) pips[ch.key] = ch.allocated;
  }
  // Deep-copy per-port crafting state. Omit when empty so legacy consumers
  // (named builds, share-API payloads) keep a stable shape.
  const crafting = {};
  for (const [port, slots] of Object.entries(state.currentCrafting || {})) {
    crafting[port] = { ...slots };
  }
  return {
    loadout: { ...state.currentLoadout },
    pips,
    shields: state.currentShieldOverrides ? [...state.currentShieldOverrides] : null,
    disabled: state.currentDisabledPorts.size > 0 ? [...state.currentDisabledPorts] : null,
    crafting: Object.keys(crafting).length > 0 ? crafting : null
  };
}

export function showToast(message, { type = 'info', duration = 2200 } = {}) {
  let layer = document.querySelector('.lo-toast-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'lo-toast-layer';
    document.body.appendChild(layer);
  }
  const el = document.createElement('div');
  el.className = 'lo-toast' + (type === 'error' ? ' error' : '');
  el.textContent = message;
  layer.appendChild(el);
  void el.offsetWidth; // force reflow so the transition runs from the initial state
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/**
 * Show a modal confirm dialog.
 * @param {string} title - Dialog heading. Will be HTML-escaped automatically.
 * @param {string} message - Body HTML. May contain trusted markup; callers MUST
 *   escapeHtml() any user-supplied value interpolated into it.
 * @param {Function} onConfirm - Called when the user clicks OK.
 * @param {{ okText?: string, cancelText?: string }} [opts]
 */
export function showConfirmDialog(title, message, onConfirm, { okText = 'OK', cancelText = 'Cancel' } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'lo-confirm-overlay';
  overlay.innerHTML = `<div class="lo-confirm-panel">
    <div class="lo-section-header lo-confirm-header"><h3>${escapeHtml(title)}</h3></div>
    <div class="lo-confirm-message">${message}</div>
    <div class="lo-confirm-actions">
      <button class="lo-confirm-ok">${okText}</button>
      <button class="lo-confirm-cancel">${cancelText}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.lo-confirm-ok').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
  overlay.querySelector('.lo-confirm-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.lo-confirm-ok').focus();
}

// currentLoadoutName lives here since it's managed by the build dropdown
export let currentLoadoutName = '';
export function setCurrentLoadoutName(v) { currentLoadoutName = v; }

let _dropdownInited = false;

export function initLoadoutDropdown() {
  const input = document.getElementById('loadoutNameInput');
  const list = document.getElementById('loadoutList');
  const saveBtn = document.getElementById('loadoutSaveBtn');
  if (!input || !list || !saveBtn) return;
  if (_dropdownInited) {
    // Called on every ship/tab switch - just refresh the input, don't rebind.
    input.value = currentLoadoutName;
    return;
  }
  _dropdownInited = true;

  function getShipBuilds() {
    if (!state.currentShipName) return [];
    return Object.keys(getNamedBuilds(state.currentShipName)).sort((a, b) => a.localeCompare(b));
  }

  // Button label stays "Save" regardless of state; the confirm dialog
  // handles the "name already exists" case.

  function renderList() {
    const builds = getShipBuilds();
    const filtered = builds;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="lo-build-list-empty">No saved loadouts</div>';
    } else {
      list.innerHTML = filtered.map(name => `
        <div class="lo-build-list-item${name === currentLoadoutName ? ' selected' : ''}" data-name="${escapeHtml(name)}">
          <span>${escapeHtml(name)}</span>
          <button class="lo-build-item-delete" data-tip="Delete">&times;</button>
        </div>
      `).join('');
    }

    // Bind clicks
    list.querySelectorAll('.lo-build-list-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.lo-build-item-delete')) return;
        const name = el.dataset.name;
        loadBuild(name);
      });
    });

    // Bind deletes
    list.querySelectorAll('.lo-build-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.closest('.lo-build-list-item').dataset.name;
        showConfirmDialog('Delete loadout', `Are you sure you want to delete the loadout <span class="lo-val">${escapeHtml(name)}</span>?<br>This is a permanent action that can not be undone.`, () => {
          deleteNamedBuild(state.currentShipName, name);
          if (currentLoadoutName === name) {
            currentLoadoutName = '';
            input.value = '';
          }
          renderList();
          showToast(`Loadout "${name}" deleted`);
        });
      });
    });
  }

  function loadBuild(name) {
    const builds = getNamedBuilds(state.currentShipName);
    const build = builds[name];
    if (!build) return;
    currentLoadoutName = name;
    input.value = name;
    list.classList.remove('open');
    applyBuild(build);
  }

  function openList() {
    renderList();
    list.classList.add('open');
  }

  function closeList() {
    list.classList.remove('open');
  }

  // Toggle dropdown on arrow/input click
  input.addEventListener('focus', openList);
  input.addEventListener('input', () => {
    currentLoadoutName = ''; // typing a new name clears selection
    renderList();
    list.classList.add('open');
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lo-build-dropdown')) closeList();
  });

  function doSave(name) {
    saveNamedBuild(state.currentShipName, name, gatherCurrentBuild());
    currentLoadoutName = name;
    renderList();
  }

  saveBtn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name || !state.currentShipName) return;
    const existing = getShipBuilds().some(b => b === name);
    if (existing) {
      showConfirmDialog(
        'Loadout already exists',
        `A loadout named <span class="lo-val">${escapeHtml(name)}</span> already exists for this ship. Do you want to overwrite it?`,
        () => { doSave(name); showToast(`Loadout "${name}" updated`); },
        { okText: 'Overwrite', cancelText: 'Choose another name' }
      );
    } else {
      doSave(name);
      showToast(`Loadout "${name}" saved`);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { saveBtn.click(); closeList(); }
    if (e.key === 'Escape') closeList();
  });

  // Set initial state
  input.value = currentLoadoutName;
}

export function refreshLoadoutDropdown() {
  const input = document.getElementById('loadoutNameInput');
  if (input) {
    input.value = currentLoadoutName;
  }
}

export function applyBuild(build) {
  // A build saved on the hull this ship Name used to point at would lay that
  // hull's stock items over the current one (see isLoadoutForOtherHull).
  if (isLoadoutForOtherHull(build.loadout, state.currentSlots, state.defaultLoadout)) {
    showToast('This build was saved for an older version of this ship and cannot be applied', { type: 'error', duration: 4000 });
    return;
  }
  // Restore loadout (components). gatherCurrentBuild saves the FULL loadout
  // map, so this is a replacement - merging over the working loadout let
  // ports absent from the saved build (e.g. sub-ports of a different module)
  // bleed through from the previous state.
  if (build.loadout) {
    state.setCurrentLoadout({ ...build.loadout });
    saveLoadout(state.currentShipName, state.currentLoadout);
    if (_persistTabs) _persistTabs();
  }
  // Restore shield overrides
  if (build.shields != null) {
    state.setCurrentShieldOverrides(build.shields);
    saveShieldSelection(state.currentShipName, state.currentShieldOverrides);
  } else {
    state.setCurrentShieldOverrides(null);
    saveShieldSelection(state.currentShipName, null);
  }
  // Restore disabled ports (weapons / power plants powered off by user)
  state.setCurrentDisabledPorts(build.disabled || []);
  saveDisabledPorts(state.currentShipName, state.currentDisabledPorts);
  // Restore component crafting. Missing field = no crafting (identity fast
  // path) - keeps legacy named builds working without migration.
  state.setCurrentCrafting(build.crafting ? { ...build.crafting } : {});
  // Rebuild pips first (need fresh allocation structure)
  if (_rebuildPipAllocation) _rebuildPipAllocation(true);
  // Then restore pip allocation if saved
  if (build.pips && state.currentPipAllocation?.channels) {
    for (const ch of state.currentPipAllocation.channels) {
      if (build.pips[ch.key] != null) ch.allocated = build.pips[ch.key];
    }
    savePipAllocation(state.currentShipName, state.currentPipAllocation.channels);
  }
  // Re-render everything
  if (_renderAllSlots) _renderAllSlots();
  if (_renderStats) _renderStats();
}

// Keys that must never be copied from parsed JSON onto live objects -
// assigning "__proto__" via Object.assign rewires the target's prototype.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanRecord(obj, valueOk) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(k) || !valueOk(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Sanitize a shared-build payload before it touches live state. Shared
 * builds come from the server but are attacker-suppliable (anyone can POST
 * /api/share and send the link), so every field is type-checked and unsafe
 * keys are dropped. Returns null for a payload that isn't an object at all.
 */
export function sanitizeSharedBuild(build) {
  if (!build || typeof build !== 'object' || Array.isArray(build)) return null;
  return {
    // l is a DIFF against the ship's default loadout: portName → className
    // (string) or null (explicitly emptied port).
    l: cleanRecord(build.l, v => typeof v === 'string' || v === null),
    s: Array.isArray(build.s) ? build.s : null,
    d: Array.isArray(build.d) ? build.d.filter(x => typeof x === 'string') : [],
    // c: portName → { craftSlotName: quality number }
    c: (() => {
      const ports = cleanRecord(build.c, v => v && typeof v === 'object' && !Array.isArray(v));
      for (const port of Object.keys(ports)) {
        ports[port] = cleanRecord(ports[port], v => typeof v === 'number' && Number.isFinite(v));
      }
      return ports;
    })(),
    p: cleanRecord(build.p, v => typeof v === 'number' && Number.isFinite(v)),
  };
}

/** Apply a shared build as a temporary view (no localStorage writes). */
export function applySharedBuild(build) {
  build = sanitizeSharedBuild(build);
  if (!build) return;
  Object.assign(state.currentLoadout, build.l);
  if (build.s != null) {
    state.setCurrentShieldOverrides(build.s);
  }
  state.setCurrentDisabledPorts(build.d);
  // Crafting: shared builds use the compact `c` key; missing = no crafting.
  state.setCurrentCrafting(build.c);
  if (_rebuildPipAllocation) _rebuildPipAllocation(true);
  if (build.p && state.currentPipAllocation?.channels) {
    for (const ch of state.currentPipAllocation.channels) {
      if (build.p[ch.key] != null) ch.allocated = build.p[ch.key];
    }
  }
  if (_renderAllSlots) _renderAllSlots();
  if (_renderStats) _renderStats();
}

/**
 * craftingUI.js - inline popover for per-component material-quality crafting.
 *
 * Owns:
 *  - The crafting indicator (FA screwdriver-wrench icon + mean-quality badge)
 *    embedded on each loadout slot row by `renderCraftingIndicator(port, cn)`.
 *  - The inline popover that opens when the indicator is clicked: per-slot
 *    sliders (0-1000), numeric input, ± buttons, Min/Reset/Max actions, and
 *    a live Base → Crafted display per affected stat.
 *  - The resource-name lookup used to label slot costs.
 *
 * Update strategy: when a slider moves we mutate the live DOM in place
 * (slider element survives, only labels + base/crafted text rewrite). A full
 * innerHTML swap would destroy the slider mid-drag and break dragging.
 *
 * Math + state stay in:
 *  - js/craftingModifiers.js (lerp, composition, stat-path mutation)
 *  - js/loadoutState.js     (currentCrafting per port)
 *  - js/loadoutManager.js   (blueprint lookup, getCraftedItemStats)
 */

import {
  getItemStats, getCraftedItemStats, getBlueprint, hasCraftingData,
} from './loadoutManager.js';
import {
  currentCrafting, currentLoadout, setPortCrafting, currentQFuelCapacity,
} from './loadoutState.js';
import {
  DEFAULT_QUALITY, MIN_QUALITY, MAX_QUALITY, normalizeQuality,
  computeSlotModifier, getPropertyKind, isLowerBetter,
} from './craftingModifiers.js';
import { gradeLetter } from './utils.js';

// ─── Resource lookup ───────────────────────────────────────────────────────

let _resourcesByGuid = new Map();

/** Wire the resources.json lookup. Empty `resources` is fine (Live build). */
export function initCraftingResources(resources) {
  _resourcesByGuid = new Map();
  if (Array.isArray(resources)) {
    for (const r of resources) if (r && r.GUID) _resourcesByGuid.set(r.GUID, r);
  }
}

/** Look up a resource record by GUID. Returns null if not found. */
export function getResource(guid) {
  return _resourcesByGuid.get(guid) || null;
}

// ─── Re-render plumbing (callback-injected to avoid circular imports) ──────

let _onChange = null;
/** Called after any popover state change so the surrounding panels redraw. */
export function setRenderCallbacks(onChange) { _onChange = onChange; }

// ─── Display helpers ───────────────────────────────────────────────────────

/**
 * Friendlier short labels for PropertyName values in per-slot labels
 * ("+10.22% health"). Falls back to lower-cased PropertyName when unmapped.
 */
const PROPERTY_DISPLAY = {
  'Integrity':            'health',
  'Max. Shield Strength': 'pool health',
  'Coolant Rating':       'coolant rating',
  'Quantum Speed':        'speed',
  'Quantum Fuel Burn':    'fuel burn',
  'Min. Assist Distance': 'min assist dist',
  'Max. Assist Distance': 'max assist dist',
  'Beam Force':           'beam force',
  'Full Strength Dist.':  'full-strength dist',
  'Max. Distance':        'max distance',
  'Max. Volume':          'max volume',
  'Efficiency':           'efficiency',
  'Radius':               'radius',
  'Speed':                'speed',
  'Impact Force':         'impact force',
  'Power Pips':           'power pips',
};

/**
 * Title-case labels for the popover's top crafted-value summary
 * ("Shield 3 375 hp (+12.5%)"). Shorter / cleaner than the inline form.
 */
const PROPERTY_SUMMARY = {
  'Integrity':            'Health',
  'Max. Shield Strength': 'Shield',
  'Coolant Rating':       'Cooling',
  'Quantum Speed':        'QD Speed',
  'Quantum Fuel Burn':    'QD Fuel Burn',
  'Min. Assist Distance': 'Min Aim Assist',
  'Max. Assist Distance': 'Max Aim Assist',
  'Beam Force':           'Beam Force',
  'Full Strength Dist.':  'Full-Strength Dist.',
  'Max. Distance':        'Max Distance',
  'Max. Volume':          'Max Volume',
  'Efficiency':           'Efficiency',
  'Radius':               'Radius',
  'Speed':                'Speed',
  'Impact Force':         'Impact Force',
  'Power Pips':           'Power Pips',
};

/**
 * PropertyName → reader producing { value, unit }. Reads from a stdItem
 * (raw or crafted - same shape). Mirrors PROPERTY_SETTERS in
 * craftingModifiers.js so they stay paired: every modifier we apply has
 * a corresponding reader so the popover can display its effect.
 */
const PROPERTY_READER = {
  'Integrity':            si => ({ value: si.Durability?.Health, unit: 'hp' }),
  'Max. Shield Strength': si => ({ value: si.Shield?.Health, unit: 'hp' }),
  'Coolant Rating':       si => {
    let total = 0;
    for (const node of si.ResourceNetwork || []) {
      for (const conv of node.Conversion || []) {
        if (conv.Generation?.Resource === 'Coolant') total += conv.Generation.UnitPerSec || 0;
      }
    }
    return { value: total, unit: 'cool' };
  },
  'Quantum Speed':        si => ({ value: si.QuantumDrive?.StandardJump?.Speed, unit: 'm/s' }),
  'Quantum Fuel Burn':    si => ({ value: readQuantumFuelBurn(si), unit: 'µL/s' }),
  'Min. Assist Distance': si => ({ value: si.Radar?.AimAssist?.DistanceMin, unit: 'm' }),
  'Max. Assist Distance': si => ({ value: si.Radar?.AimAssist?.DistanceMax, unit: 'm' }),
  'Beam Force':           si => ({ value: si.TractorBeam?.Tractor?.[0]?.MaxForce, unit: 'N' }),
  'Full Strength Dist.':  si => ({ value: si.TractorBeam?.Tractor?.[0]?.FullStrengthDistance, unit: 'm' }),
  'Max. Distance':        si => ({ value: si.TractorBeam?.Tractor?.[0]?.MaxDistance, unit: 'm' }),
  'Max. Volume':          si => ({ value: si.TractorBeam?.Tractor?.[0]?.MaxVolume, unit: '' }),
  'Efficiency':           si => ({ value: si.SalvageModifier?.[0]?.ExtractionEfficiency, unit: '' }),
  'Radius':               si => ({ value: si.SalvageModifier?.[0]?.RadiusMultiplier, unit: 'x' }),
  'Speed':                si => ({ value: si.SalvageModifier?.[0]?.SpeedMultiplier, unit: 'x' }),
  'Impact Force':         si => {
    const id = si.Weapon?.Ammunition?.ImpactDamage;
    if (!id) return { value: 0, unit: 'dmg' };
    const total = Object.values(id).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0);
    return { value: total, unit: 'dmg' };
  },
  'Power Pips':           si => ({ value: si.ResourceNetwork?.[0]?.Generation?.[0]?.Segment, unit: 'segments' }),
};

/**
 * Read a QD's fuel-burn rate from a stdItem. Prefers the QuantumFuel
 * consumption rate (MicroUnitPerSec) used by current data, falling back to
 * StandardJump.QuantumFuelRequirement for older shapes. Paired with the
 * 'Quantum Fuel Burn' setter in craftingModifiers.js. Returns undefined
 * when the item has no fuel-burn field.
 */
function readQuantumFuelBurn(si) {
  for (const node of si.ResourceNetwork || []) {
    for (const conv of node.Consumption || []) {
      if (conv.Resource === 'QuantumFuel' && typeof conv.MicroUnitPerSec === 'number') {
        return conv.MicroUnitPerSec;
      }
    }
  }
  return si.QuantumDrive?.StandardJump?.QuantumFuelRequirement;
}

/**
 * Derive a QD's max jump range (gigameters) from the ship's quantum fuel
 * capacity divided by the drive's fuel-burn rate. Mirrors the formula in
 * statsPanel.renderStats / weaponColumn.extractRowData. Returns null when
 * capacity or burn rate is unavailable. Because the fuel-burn modifier
 * scales MicroUnitPerSec, passing a crafted stdItem yields the crafted range.
 */
function qdRangeGm(si, qfuelCap) {
  if (!si || !(qfuelCap > 0)) return null;
  for (const node of si.ResourceNetwork || []) {
    for (const conv of node.Consumption || []) {
      if (conv.Resource === 'QuantumFuel' && conv.MicroUnitPerSec) {
        return qfuelCap / (conv.MicroUnitPerSec / 1000);
      }
    }
  }
  return null;
}

/**
 * Build the derived "Range" summary row for a QD blueprint: the crafted max
 * jump range plus its percent change vs base. Lower fuel burn -> longer range,
 * so this row is where the fuel-burn slider's payoff shows up. Returns '' when
 * range can't be derived (no QD / no fuel capacity loaded).
 */
function buildRangeRow(baseStdItem, craftedStdItem) {
  const cap = currentQFuelCapacity || 0;
  const base = qdRangeGm(baseStdItem, cap);
  const crafted = qdRangeGm(craftedStdItem, cap);
  if (base == null || crafted == null || !(base > 0)) return '';
  const pct = (crafted / base - 1) * 100;
  const cls = deltaClass('Range', pct, Math.abs(pct) > 0.005);
  const pctStr = `<span class="${cls}">(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
  return `<div class="cc-summary-row" data-cc-summary="Range">
      <span class="cc-summary-label">Range</span>
      <span class="cc-summary-val"><strong>${formatValue(crafted)} Gm</strong> ${pctStr}</span>
    </div>`;
}

/**
 * CSS class for a signed delta, honouring per-property polarity. `delta` is
 * the signed change (crafted − base, or modifier − identity). Higher-is-better
 * properties colour a positive delta green; lower-is-better ones (e.g. Quantum
 * Fuel Burn) invert so a reduction reads green. Unchanged → neutral.
 */
function deltaClass(propertyName, delta, changed) {
  if (!changed) return 'cc-pct-zero';
  const good = isLowerBetter(propertyName) ? delta < 0 : delta > 0;
  return good ? 'cc-pct-pos' : 'cc-pct-neg';
}

function displayProperty(name) {
  return PROPERTY_DISPLAY[name] || (name || '').toLowerCase();
}

function summaryProperty(name) {
  return PROPERTY_SUMMARY[name] || name || '';
}

/** "+10.22%" / "-5.00%" / "+0.00%" - signed two-decimal modifier delta. */
function formatPercent(modifier) {
  const pct = (modifier - 1) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/** "+2" / "-1" / "+0" - signed integer for additive-kind modifiers. */
function formatAddDelta(modifier) {
  const sign = modifier >= 0 ? '+' : '';
  return `${sign}${modifier}`;
}

/**
 * Format a slot's modifier for the inline percent label, picking +N for
 * additive properties (Power Pips) and +N.NN% for the default
 * multiplicative ones. Identity values render as +0% / +0 respectively.
 */
function formatSlotDelta(propertyName, modifier) {
  if (getPropertyKind(propertyName) === 'additive') return formatAddDelta(modifier);
  return formatPercent(modifier);
}

/** Numeric value formatter - integers for whole, two decimals otherwise. */
function formatValue(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 100 || Math.round(v) === v) return Math.round(v).toLocaleString('sv-SE').replace(/ /g, ' ');
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** "Gold 0.24 SCU" / "Beradom 20 Items" - resolve cost via resourcesByGuid. */
function formatCost(cost) {
  if (!cost || !cost.GUID) return '';
  const res = _resourcesByGuid.get(cost.GUID);
  const name = res?.Name || '???';
  const qty = cost.Quantity;
  const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
  const unit = res?.UnitType === 'SCU' ? 'SCU' : 'Items';
  return `${name} ${qtyStr} ${unit}`;
}

// ─── Port crafting state helpers ───────────────────────────────────────────

function getPortQualityMap(portName) {
  return { ...(currentCrafting[portName] || {}) };
}

function commitPortQualityMap(portName, slots, qualityMap) {
  const compact = {};
  for (const s of slots) {
    const q = qualityMap[s.Name];
    if (q != null && normalizeQuality(q) !== DEFAULT_QUALITY) compact[s.Name] = normalizeQuality(q);
  }
  setPortCrafting(portName, compact);
}

/**
 * Mean integer quality across all slots - used by the indicator badge
 * and the popover header. Returns DEFAULT_QUALITY when the port has no
 * deviation (the common case).
 */
export function getMeanQuality(portName, className) {
  const bp = getBlueprint(className);
  if (!bp || !Array.isArray(bp.Tiers) || bp.Tiers.length === 0) return DEFAULT_QUALITY;
  const slots = bp.Tiers[0].Slots || [];
  if (slots.length === 0) return DEFAULT_QUALITY;
  const map = currentCrafting[portName] || {};
  let sum = 0;
  for (const s of slots) {
    const q = map[s.Name];
    sum += (q == null ? DEFAULT_QUALITY : normalizeQuality(q));
  }
  return Math.round(sum / slots.length);
}

// ─── Public: indicator HTML ────────────────────────────────────────────────

/**
 * @param peerPorts optional array of port names that share the same
 * crafting state - used for grouped weapons (turret racks) so sliders
 * fan out to every weapon in the group. Single-port slots can omit it.
 */
export function renderCraftingIndicator(portName, className, peerPorts) {
  if (!className || !portName || !hasCraftingData()) return '';
  const bp = getBlueprint(className);
  if (!bp) return '';
  const mean = getMeanQuality(portName, className);
  // Quality colour: red below the 500 default, green above, neutral at exactly 500.
  const qCls = mean < DEFAULT_QUALITY ? ' cc-q-low' : mean > DEFAULT_QUALITY ? ' cc-q-high' : '';
  const cls = `cc-indicator${qCls}`;
  const peers = Array.isArray(peerPorts) && peerPorts.length > 1
    ? ` data-craft-peers='${JSON.stringify(peerPorts)}'`
    : '';
  const tip = peers
    ? `Component crafting (applies to ${peerPorts.length} grouped weapons)`
    : 'Component crafting';
  return `<button class="${cls}" data-craft-port="${portName}"${peers} data-tip="${tip}"><i class="fa-solid fa-wrench"></i><span class="cc-quality-badge">${mean}</span></button>`;
}

// ─── Popover building (initial render, full innerHTML) ────────────────────

let _currentPopover = null;
let _currentPopoverPort = null;
let _currentPopoverClass = null;
let _currentPopoverPeers = null; // [port1, port2, ...] for grouped-weapon bulk crafting (null for singles)

function closePopover() {
  if (_currentPopover) {
    _currentPopover.remove();
    _currentPopover = null;
    _currentPopoverPort = null;
    _currentPopoverClass = null;
    _currentPopoverPeers = null;
  }
}

/**
 * Unique PropertyName list for a slot (deduped - a slot's two-piece curve
 * lists the same PropertyName twice, once per quality range).
 */
function slotProperties(slot) {
  const set = new Set();
  for (const m of slot.Modifiers || []) {
    if (m.PropertyName) set.add(m.PropertyName);
  }
  return [...set];
}

/**
 * Build the contents of a single slot's % label (per-property percentage
 * deltas at the slot's current quality).
 */
function buildSlotPercentLabel(slot, quality) {
  const slotMods = computeSlotModifier(slot, quality);
  const parts = [];
  for (const [prop, m] of slotMods) {
    const isAdd = getPropertyKind(prop) === 'additive';
    const identity = isAdd ? 0 : 1;
    const cls = deltaClass(prop, m - identity, m !== identity);
    parts.push(`<span class="${cls}">${formatSlotDelta(prop, m)} <span class="cc-pct-prop">${displayProperty(prop)}</span></span>`);
  }
  if (parts.length === 0) return '<span class="cc-pct-zero">+0.00%</span>';
  return parts.join(' · ');
}

function buildSlotHTML(slot, q) {
  const costHtml = (slot.Costs || []).map(formatCost).filter(Boolean).join(' · ');
  return `
    <div class="cc-slot" data-cc-slot-row="${slot.Name}">
      <div class="cc-slot-head">
        <span class="cc-slot-title">${slot.DisplayName || slot.Name}</span>
        ${costHtml ? `<span class="cc-slot-cost">${costHtml}</span>` : ''}
      </div>
      <div class="cc-slot-pct" data-cc-pct="${slot.Name}">${buildSlotPercentLabel(slot, q)}</div>
      <div class="cc-slot-controls">
        <span class="cc-bound">MIN</span>
        <input type="range" class="cc-slider" min="${MIN_QUALITY}" max="${MAX_QUALITY}" step="1" value="${q}" data-cc-slot="${slot.Name}">
        <span class="cc-bound">MAX</span>
        <button class="cc-step" data-cc-step="${slot.Name}" data-dir="-1" data-tip="−10">−</button>
        <input type="number" class="cc-num" min="${MIN_QUALITY}" max="${MAX_QUALITY}" step="1" value="${q}" data-cc-num="${slot.Name}">
        <button class="cc-step" data-cc-step="${slot.Name}" data-dir="1" data-tip="+10">+</button>
      </div>
    </div>`;
}

/**
 * Collect every unique PropertyName affected by any slot in the blueprint,
 * in first-appearance order. Used to build the top crafted-value summary.
 */
function blueprintProperties(blueprint) {
  const seen = new Set();
  const out = [];
  for (const slot of (blueprint.Tiers?.[0]?.Slots || [])) {
    for (const prop of slotProperties(slot)) {
      if (!seen.has(prop)) { seen.add(prop); out.push(prop); }
    }
  }
  return out;
}

/**
 * Top-of-popover summary: one row per unique affected property showing
 * the current crafted value + delta vs base. Replaces the per-slot
 * Base → Crafted block from the previous iteration - same information,
 * deduplicated across slots that affect the same property.
 */
function buildSummaryHTML(blueprint, baseStdItem, craftedStdItem) {
  const props = blueprintProperties(blueprint);
  // Derived QD range row is injected right after the Quantum Speed row so it
  // reads "QD Speed / Range" like the top of the loadout stats panel. If the
  // blueprint touches QD fuel/speed but has no Quantum Speed slot, it's
  // appended at the end instead (see fallback below).
  const isQd = props.includes('Quantum Speed') || props.includes('Quantum Fuel Burn');
  let rangeInjected = false;
  const rows = props.map(prop => {
    const reader = PROPERTY_READER[prop];
    if (!reader) return '';
    const base = reader(baseStdItem);
    const crafted = reader(craftedStdItem);
    if (base.value == null || !Number.isFinite(base.value)) return '';
    const unit = base.unit ? ` ${base.unit}` : '';
    // Additive properties show a raw delta (Power Pips: +3) instead of
    // the percent change - matches how the underlying step modifiers
    // are encoded.
    const isAdd = getPropertyKind(prop) === 'additive';
    const delta = crafted.value - base.value;
    let pctStr;
    if (isAdd) {
      const isChanged = Math.abs(delta) >= 0.5; // integer steps; 0.5 threshold avoids float noise
      const cls = deltaClass(prop, delta, isChanged);
      pctStr = `<span class="${cls}">(${delta >= 0 ? '+' : ''}${Math.round(delta)})</span>`;
    } else {
      const ratio = base.value !== 0 ? crafted.value / base.value : 1;
      const pct = (ratio - 1) * 100;
      const isChanged = Math.abs(pct) > 0.005;
      const cls = deltaClass(prop, pct, isChanged);
      pctStr = `<span class="${cls}">(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
    }
    const row = `<div class="cc-summary-row" data-cc-summary="${prop}">
      <span class="cc-summary-label">${summaryProperty(prop)}</span>
      <span class="cc-summary-val"><strong>${formatValue(crafted.value)}${unit}</strong> ${pctStr}</span>
    </div>`;
    // Slot the derived Range row directly beneath QD Speed.
    if (prop === 'Quantum Speed') {
      const rangeRow = buildRangeRow(baseStdItem, craftedStdItem);
      if (rangeRow) { rangeInjected = true; return row + rangeRow; }
    }
    return row;
  }).filter(Boolean);
  // Fallback: QD blueprint without a Quantum Speed row - append Range at the end.
  if (isQd && !rangeInjected) {
    const rangeRow = buildRangeRow(baseStdItem, craftedStdItem);
    if (rangeRow) rows.push(rangeRow);
  }
  return rows.join('');
}

function buildPopoverHTML(portName, blueprint, className) {
  const baseStdItem = getItemStats(className);
  const craftedStdItem = getCraftedItemStats(className, portName);
  const name = baseStdItem?.Name || className;
  const cls = baseStdItem?.Class || '';
  // "Civilian A" style - match the rest of the app (gradeLabel in
  // weaponColumn, Grade A formatting in statsPanel renderThrusterSlot).
  const subtitle = [cls, gradeLetter(baseStdItem?.Grade)].filter(Boolean).join(' ');
  const mean = getMeanQuality(portName, className);
  const slots = blueprint.Tiers[0].Slots || [];
  const portMap = currentCrafting[portName] || {};

  const slotHtml = slots.map(slot => {
    const q = portMap[slot.Name] != null ? normalizeQuality(portMap[slot.Name]) : DEFAULT_QUALITY;
    return buildSlotHTML(slot, q);
  }).join('');

  return `
    <div class="cc-pop-head">
      <div class="cc-pop-title">${name}${subtitle ? ` <span class="cc-pop-subtitle">${subtitle}</span>` : ''}</div>
      <div class="cc-pop-mean" data-tip="Mean quality across all slots">${mean}</div>
    </div>
    <div class="cc-pop-summary" data-cc-summary-root>${buildSummaryHTML(blueprint, baseStdItem, craftedStdItem)}</div>
    <div class="cc-pop-body">${slotHtml}</div>
    <div class="cc-pop-foot">
      <button class="cc-bulk cc-bulk-min" data-cc-bulk="min">Min<br>quality</button>
      <button class="cc-bulk cc-bulk-reset" data-cc-bulk="reset">Reset<br>quality</button>
      <button class="cc-bulk cc-bulk-max" data-cc-bulk="max">Max<br>quality</button>
    </div>
  `;
}

// ─── Surgical in-place update (drag-safe) ──────────────────────────────────

/**
 * After committing a quality change, refresh only the affected DOM
 * fragments - slider/number values, the slot's % label, the Base→Crafted
 * block, and the header mean. The slider element itself is left
 * untouched so an in-progress drag keeps working.
 */
function refreshInPlace(root, portName, className, blueprint) {
  const baseStdItem = getItemStats(className);
  const craftedStdItem = getCraftedItemStats(className, portName);
  const slots = blueprint.Tiers[0].Slots || [];
  const portMap = currentCrafting[portName] || {};

  for (const slot of slots) {
    const q = portMap[slot.Name] != null ? normalizeQuality(portMap[slot.Name]) : DEFAULT_QUALITY;
    const pctEl = root.querySelector(`[data-cc-pct="${slot.Name}"]`);
    if (pctEl) pctEl.innerHTML = buildSlotPercentLabel(slot, q);
    // Sync slider + numeric input only if they don't already hold the
    // committed value - avoids interrupting the user's active control.
    const slider = root.querySelector(`.cc-slider[data-cc-slot="${slot.Name}"]`);
    if (slider && +slider.value !== q) slider.value = String(q);
    const num = root.querySelector(`.cc-num[data-cc-num="${slot.Name}"]`);
    if (num && document.activeElement !== num && +num.value !== q) num.value = String(q);
  }

  // Top crafted-value summary - re-render the whole block (no controls
  // inside, so destroying + rebuilding is safe and survives drags).
  const summaryEl = root.querySelector('[data-cc-summary-root]');
  if (summaryEl) summaryEl.innerHTML = buildSummaryHTML(blueprint, baseStdItem, craftedStdItem);

  const meanEl = root.querySelector('.cc-pop-mean');
  if (meanEl) meanEl.textContent = String(getMeanQuality(portName, className));
}

// ─── Event binding (once per popover) ──────────────────────────────────────

function bindPopoverEvents(root, portName, blueprint, className, peers) {
  const slots = blueprint.Tiers[0].Slots || [];
  // For grouped weapons, fan the mutation out to every peer port so the
  // popover edits all of them in lockstep. The indicator's own port is
  // always in this list (we guarantee it at open time).
  const targets = Array.isArray(peers) && peers.length > 0 ? peers : [portName];

  function commitAndRefresh(qualityMap) {
    for (const tgt of targets) commitPortQualityMap(tgt, slots, qualityMap);
    refreshInPlace(root, portName, className, blueprint);
    if (_onChange) _onChange();
  }

  function setSlotQuality(slotName, rawQ) {
    const map = getPortQualityMap(portName);
    map[slotName] = normalizeQuality(rawQ);
    commitAndRefresh(map);
  }

  root.querySelectorAll('.cc-slider').forEach(el => {
    el.addEventListener('input', e => setSlotQuality(e.target.dataset.ccSlot, +e.target.value));
  });
  root.querySelectorAll('.cc-num').forEach(el => {
    el.addEventListener('change', e => setSlotQuality(e.target.dataset.ccNum, +e.target.value));
  });
  root.querySelectorAll('.cc-step').forEach(el => {
    el.addEventListener('click', e => {
      const slotName = e.currentTarget.dataset.ccStep;
      const dir = +e.currentTarget.dataset.dir;
      const cur = (currentCrafting[portName] || {})[slotName];
      const base = cur == null ? DEFAULT_QUALITY : normalizeQuality(cur);
      setSlotQuality(slotName, base + 10 * dir);
    });
  });
  root.querySelectorAll('.cc-bulk').forEach(el => {
    el.addEventListener('click', e => {
      const mode = e.currentTarget.dataset.ccBulk;
      const value = mode === 'min' ? MIN_QUALITY : mode === 'max' ? MAX_QUALITY : DEFAULT_QUALITY;
      const map = {};
      for (const s of slots) map[s.Name] = value;
      commitAndRefresh(map);
    });
  });
}

// ─── Positioning ───────────────────────────────────────────────────────────

function positionPopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const popWidth = pop.offsetWidth || 360;
  const popHeight = pop.offsetHeight || 400;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.right + 8;
  if (left + popWidth > vw - 8) left = Math.max(8, rect.left - popWidth - 8);
  let top = rect.top + (rect.height / 2) - (popHeight / 2);
  if (top + popHeight > vh - 8) top = vh - popHeight - 8;
  if (top < 8) top = 8;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

// ─── Public: open / close ──────────────────────────────────────────────────

export function openCraftingPopover(portName, anchorEl, peerPorts) {
  const className = currentLoadout[portName];
  const bp = className ? getBlueprint(className) : null;
  if (!bp) return;
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'crafting-popover';
  pop.dataset.craftingPort = portName;
  pop.innerHTML = buildPopoverHTML(portName, bp, className);
  document.body.appendChild(pop);
  _currentPopover = pop;
  _currentPopoverPort = portName;
  _currentPopoverClass = className;
  // Normalize peers - always include the anchor port, dedupe, drop falsy.
  _currentPopoverPeers = Array.isArray(peerPorts) && peerPorts.length > 1
    ? [...new Set([portName, ...peerPorts.filter(Boolean)])]
    : null;
  positionPopover(pop, anchorEl);
  bindPopoverEvents(pop, portName, bp, className, _currentPopoverPeers);
  // Stop click events bubbling so the outside-click handler doesn't close.
  pop.addEventListener('click', e => e.stopPropagation());
  // Stop mousedown too - protects slider drag from any pointer-watching
  // close-on-blur logic that might land in the future.
  pop.addEventListener('mousedown', e => e.stopPropagation());
}

// ─── Global event delegation (registered once) ────────────────────────────

let _wired = false;
export function wireCraftingEvents() {
  if (_wired) return;
  _wired = true;

  // CAPTURE phase: indicator click handled here so it beats the slot's
  // own bubble-phase click handler (which would otherwise open the
  // component picker). stopPropagation prevents both the slot's listener
  // and the outside-click close handler below from firing on this event.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.cc-indicator');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const port = btn.dataset.craftPort;
    if (!port) return;
    let peers = null;
    if (btn.dataset.craftPeers) {
      try { peers = JSON.parse(btn.dataset.craftPeers); } catch { /* malformed → single port */ }
    }
    openCraftingPopover(port, btn, peers);
  }, true);

  // Bubble phase: outside-click closes the popover.
  document.addEventListener('click', e => {
    if (_currentPopover && !_currentPopover.contains(e.target)) {
      closePopover();
    }
  });

  // ESC closes too.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _currentPopover) closePopover();
  });

  // Re-position on scroll/resize while open.
  window.addEventListener('scroll', () => {
    if (!_currentPopover) return;
    const anchor = document.querySelector(`.cc-indicator[data-craft-port="${_currentPopoverPort}"]`);
    if (anchor) positionPopover(_currentPopover, anchor);
    else closePopover();
  }, true);
}

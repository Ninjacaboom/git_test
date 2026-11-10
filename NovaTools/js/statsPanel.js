/**
 * statsPanel.js - ship stats card rendering.
 */
import * as state from './loadoutState.js';
import { getItemStats, getCraftedItemStats, calculateStats, calculateEMSignature, calculateCoolingStats, distributeShieldPipsTop2, calculateBoostTime, calculateBoostRegenTime, scaleCrossSection } from './loadoutManager.js';
import { renderCraftingIndicator } from './craftingUI.js';
import { WEAPON_TYPE_MAP } from './config.js';
import { renderPipPanel, renderCoolingBar, renderSignatures, bindPipInteraction } from './pipPanel.js';
import { calcSustainedDPS } from './sustained.js';
import { classifyTurretWeapon } from './ttkCalc.js';
import { thouSep, fmtStat } from './utils.js';
import { calcCombatStats } from './combatCalc.js';

// Render callbacks set by orchestrator (avoid circular imports)
let _renderWeaponColumn = null;
let _renderSystemsColumn = null;

export function setRenderCallbacks(renderWeaponColumn, renderSystemsColumn) {
  _renderWeaponColumn = renderWeaponColumn;
  _renderSystemsColumn = renderSystemsColumn;
}

// Re-export for back-compat with weaponColumn.js which imports from this module.
// Canonical definitions live in ./utils.js.
export { thouSep, fmtStat };

/**
 * Some items in the SPViewer data don't have a human-friendly Name and
 * end up showing their raw className (e.g. "Controller_Flight_DRAK_Buccaneer").
 * Replace underscores with spaces so it at least reads like a phrase.
 */
export function prettifyName(s) {
  return s ? s.replace(/_/g, ' ') : s;
}

/**
 * Convert a raw VitalParts key from the game data into a human-friendly
 * display name. Raw keys come straight from the ship model's asset
 * pipeline, so they're inconsistent - some ships use clean Title Case
 * ("Body", "Nose", "Tail"), others use asset-engine prefixes ("geo_body"),
 * underscore-joined compounds ("body_main", "wing_base_left"), or
 * modifier flags ("M_Body").
 *
 * The pipeline:
 *   1. Strip leading asset prefixes: geo_, dmg_, mesh_, aegs_, M_
 *   2. Strip trailing cosmetic suffixes: _geo, _mesh, _main, _exterior
 *   3. Extract a trailing directional marker (left/right/front/back/rear)
 *      and surface it as a parenthesized qualifier
 *   4. Split the remainder on underscores and Title Case each word
 *
 * Examples:
 *   geo_body                 -> Body
 *   body_main                -> Body
 *   body_mesh                -> Body
 *   M_Body                   -> Body
 *   Cargo_Container_Exterior -> Cargo Container
 *   aegs_escape_pod_exterior -> Escape Pod
 *   geo_main_wings           -> Main Wings
 *   rollcage_main            -> Rollcage
 *   tail_geo                 -> Tail
 *   body_front               -> Body (Front)
 *   body_back                -> Body (Rear)
 *   hull_rear                -> Hull (Rear)
 *   wing_base_left           -> Wing Base (Left)
 *   Body_Front               -> Body (Front)
 *
 * Keys that are already clean pass through unchanged (modulo Title Case):
 *   Body, Nose, Tail, Front, Rear, Bridge, middle, neck
 */
export function humanizeVitalPartName(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return rawKey;
  let s = rawKey.trim();
  if (!s) return rawKey;

  // 1. Strip asset-engine prefixes. Longer tokens first in the alternation
  //    so "mesh_" isn't eaten by "M_".
  s = s.replace(/^(geo|dmg|mesh|aegs|M)_/, '');

  // 2. Strip trailing cosmetic/internal suffixes that add no info.
  s = s.replace(/_(geo|mesh|main|exterior)$/i, '');

  // 3. Extract a trailing directional marker and hold it for later so we
  //    can render it as a parenthesized qualifier after the main name.
  let qualifier = '';
  const dirMatch = s.match(/_(left|right|front|back|rear)$/i);
  if (dirMatch) {
    const word = dirMatch[1].toLowerCase();
    const label = word === 'back' ? 'Rear'
      : word.charAt(0).toUpperCase() + word.slice(1);
    qualifier = ` (${label})`;
    s = s.slice(0, dirMatch.index);
  }

  // 4. Split on underscores and Title Case each word.
  const titled = s
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Fall back to the raw key if we stripped everything (defensive).
  return (titled ? titled + qualifier : rawKey);
}

// Per-head base constants. SPViewer scales raw modifier values for display:
//   displayed_speed       = SpeedMultiplier      × base.speed       (Trawler 0.05 × 10  = 0.5)
//   displayed_radius_m    = RadiusMultiplier     × base.radius      (Trawler 6    × 2.18 = 13.08)
//   displayed_efficiency  = ExtractionEfficiency × base.efficiency  (Trawler 0.6  × 0.55 = 0.33)
// The `efficiency` constant also represents the head's intrinsic extraction
// loss - the salvage rate formula divides by it once to model the "going
// through the head" loss.
// Source field is named `RadiusMultiplier` (SPViewer mislabels as "Diameter").
// SpeedMultiplier appears to be SPS (shots/sec) - × 60 → RPM for rate calcs.
const SALVAGE_HEAD_BASES = {
  Salvage_Head_standard: { radius: 2.18, speed: 10, efficiency: 0.55 },
  Salvage_Head_Salvation: { radius: 2.18, speed: 10, efficiency: 0.55 }
};
const DEFAULT_SALVAGE_HEAD_BASE = { radius: 2.18, speed: 10, efficiency: 0.55 };
const SALVAGE_SPS_TO_RPM = 60;

function getSalvageHeadBase(headClassName) {
  return (headClassName && SALVAGE_HEAD_BASES[headClassName]) || DEFAULT_SALVAGE_HEAD_BASE;
}

// Compute display + computed stats for one SalvageModifier item.
// Returns null if the item isn't a salvage modifier. The optional `headClassName`
// argument selects the head base constants - falls back to Baler defaults.
export function getSalvageModifierStats(si, headClassName) {
  const mod = si?.SalvageModifier?.[0];
  if (!mod) return null;
  const base = getSalvageHeadBase(headClassName);
  const speed = (mod.SpeedMultiplier || 0) * base.speed;
  const radius = (mod.RadiusMultiplier || 0) * base.radius;
  const efficiency = (mod.ExtractionEfficiency || 0) * base.efficiency;
  // Treat raw SpeedMultiplier as SPS, multiply by 60 to get RPM,
  // then divide by raw ExtractionEfficiency for the per-scraper scrape rate.
  const rpm = (mod.SpeedMultiplier || 0) * SALVAGE_SPS_TO_RPM;
  const rate = (mod.ExtractionEfficiency || 0) > 0 ? rpm / mod.ExtractionEfficiency : 0;
  // Tractor modules don't really scrape - flag so the section summary can ignore them
  const isTractor = (si.ClassName || '').toLowerCase().includes('tractor');
  return { speed, radius, efficiency, rpm, rate, isTractor, raw: mod, headBase: base };
}

/**
 * Aggregate salvage section stats by walking each salvage slot's sub-port tree.
 *
 *  - Min Speed / Efficiency across SCRAPER modifiers (tractors excluded) - the
 *    slowest/least-efficient scraper is the bottleneck.
 *  - Min Radius across scrapers; falls back to tractor radius when no scrapers
 *    are equipped (so the row always has a value when any modifier exists).
 *  - `salvageRate = sum(rpm × eff_i) / slowest_scraper_eff / head_base_eff`
 *    The per-scraper eff inside the sum models the head's scraping yield, the
 *    /slowest_eff models the bottleneck slowing the rig down, and /head_base_eff
 *    models the loss of going through the head itself.
 *    Tractors don't contribute - a salvage rig can scrape OR tractor at any
 *    given moment, never both.
 */
export function getSalvageSummary(salvageSlots) {
  let scraperCount = 0, tractorCount = 0, modCount = 0;
  let minScraperSpeed = Infinity, minScraperRadius = Infinity, minScraperEff = Infinity;
  let minAnyRadius = Infinity;
  let sumScraperRpmTimesEff = 0;
  // The head base used for /head_base_eff in the rate. Pulled from the first
  // scraper's parent head so we can support different heads later.
  let primaryHeadBase = DEFAULT_SALVAGE_HEAD_BASE;
  let primaryHeadSet = false;
  function walk(slot, headClassName) {
    // If this slot itself is a salvage head, use its className for descendants
    const cn = slot.portName in state.currentLoadout ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
    const si = cn ? getCraftedItemStats(cn, slot.portName) : null;
    if (si?.Type && /SalvageHead/i.test(si.Type)) {
      headClassName = cn;
    }
    const stats = getSalvageModifierStats(si, headClassName);
    if (stats) {
      modCount += 1;
      if (stats.raw.RadiusMultiplier < minAnyRadius) minAnyRadius = stats.raw.RadiusMultiplier;
      if (stats.isTractor) {
        tractorCount += 1;
      } else {
        scraperCount += 1;
        sumScraperRpmTimesEff += stats.rpm * (stats.raw.ExtractionEfficiency || 0);
        if (!primaryHeadSet) { primaryHeadBase = stats.headBase; primaryHeadSet = true; }
        if (stats.raw.SpeedMultiplier < minScraperSpeed) minScraperSpeed = stats.raw.SpeedMultiplier;
        if (stats.raw.RadiusMultiplier < minScraperRadius) minScraperRadius = stats.raw.RadiusMultiplier;
        if (stats.raw.ExtractionEfficiency < minScraperEff) minScraperEff = stats.raw.ExtractionEfficiency;
      }
    }
    for (const sub of slot.ports || []) walk(sub, headClassName);
  }
  for (const slot of salvageSlots || []) walk(slot, null);
  // Radius falls back to any-modifier min when no scrapers are equipped
  const radiusMult = scraperCount > 0 ? minScraperRadius : (tractorCount > 0 ? minAnyRadius : 0);
  if (scraperCount === 0 && tractorCount === 0) {
    return { modCount: 0, scraperCount: 0, tractorCount: 0, speed: 0, radius: 0, efficiency: 0, salvageRate: 0 };
  }
  // sum(rpm * eff) / slowest_eff / head_base_eff
  const salvageRate = (scraperCount > 0 && minScraperEff > 0)
    ? sumScraperRpmTimesEff / minScraperEff / primaryHeadBase.efficiency
    : 0;
  return {
    modCount,
    scraperCount,
    tractorCount,
    speed: scraperCount > 0 ? minScraperSpeed * primaryHeadBase.speed : 0,
    radius: radiusMult * primaryHeadBase.radius,
    efficiency: scraperCount > 0 ? minScraperEff * primaryHeadBase.efficiency : 0,
    salvageRate
  };
}

/**
 * Render the SPViewer-style summary header rows for the salvage section
 * (Storage Buffer + Modifiers). Returns empty string if there's nothing to show.
 */
export function renderSalvageSummary(salvageSlots, bufferSCU) {
  const { speed, radius, efficiency, scraperCount, tractorCount, salvageRate, modCount } = getSalvageSummary(salvageSlots);
  const rows = [];
  if (bufferSCU > 0) {
    rows.push(`<div class="lo-summary-row">
      <span class="lo-summary-label"><i class="spvi-icon_common_3D_cargo_boxes"></i> Storage Buffer</span>
      <span class="lo-summary-value">${fmtStat(bufferSCU)}<span class="lo-stat-unit">SCU</span></span>
    </div>`);
  }
  if (modCount > 0) {
    const parts = [];
    if (scraperCount > 0) {
      parts.push(`<span class="lo-val">${fmtStat(speed, speed % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">x Speed</span>`);
    }
    if (radius > 0) {
      parts.push(`<span class="lo-val">${fmtStat(radius, radius % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">m Radius</span>`);
    }
    if (scraperCount > 0) {
      parts.push(`<span class="lo-val">${fmtStat(efficiency, efficiency % 1 ? 2 : undefined)}</span><span class="lo-stat-unit">x Efficiency</span>`);
    }
    rows.push(`<div class="lo-summary-row">
      <span class="lo-summary-label"><i class="spvi-salvage"></i> Modifiers</span>
      <span class="lo-summary-value">${parts.join(' &nbsp; ')}</span>
    </div>`);
  }
  if (scraperCount > 0) {
    rows.push(`<div class="lo-summary-row">
      <span class="lo-summary-label"><i class="spvi-icon_common_warning_overheat"></i> Salvage Rate</span>
      <span class="lo-summary-value">${fmtStat(salvageRate, salvageRate % 1 ? 1 : undefined)}<span class="lo-stat-unit">/min</span></span>
    </div>`);
  }
  return rows.join('');
}

/**
 * EMP / QED slot row.
 *  - EMP: Damage shown as the primary lo-stat (top right, weapon DPS style).
 *    Radius / charge / cooldown shown in the meta line.
 *  - QED: Jammer + Snare ranges as primary stats. If both available they stack
 *    on two lines (lo-stat-stack); if only one is available it's the single
 *    primary stat. Charge / cooldown shown in the meta line.
 *  - Power draw appears on the meta line (left side, with powerplant icon).
 */
export function renderInterdictionSlot(slot) {
  const explicitly = slot.portName in state.currentLoadout;
  const className = explicitly ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  const si = className ? getCraftedItemStats(className, slot.portName) : null;
  const isEmpty = explicitly && !className;
  const name = isEmpty ? 'Empty' : prettifyName(si?.Name || slot.baseLoadout?.Name || 'Empty');

  const editable = !slot.uneditable && (slot.types?.length > 0);
  const cls = editable ? 'lo-slot' : 'lo-slot uneditable';

  // Power draw (UnitPerSec for EMP, Segment for QED)
  let pw = 0;
  const rn = si?.ResourceNetwork?.[0];
  if (rn) {
    for (const c of rn.Consumption || []) {
      if (c.Resource === 'Power') pw += c.UnitPerSec || c.Segment || 0;
    }
    for (const c of rn.Conversion || []) {
      if (c.Consumption?.Resource === 'Power') pw += c.Consumption.Segment || 0;
    }
  }

  // Primary stat (top right, weapon DPS style)
  let primaryStat = '';
  if (si?.Emp) {
    const dmg = si.Emp.Damage || 0;
    if (dmg > 0) {
      primaryStat = `<span class="lo-stat">${fmtStat(dmg)}<span class="lo-stat-unit">DMG</span></span>`;
    }
  } else if (si?.QuantumInterdiction) {
    const q = si.QuantumInterdiction;
    const hasJammer = q.JammingRange > 0;
    // Snare sentinel (1) used by non-snaring QEDs (Burke/Captor/Tidelock) - skip below 100
    const hasSnare = q.InterdictionRange && q.InterdictionRange >= 100;
    const jammerHtml = hasJammer ? `<span class="lo-stat" data-tip="Jammer range">${fmtStat(q.JammingRange)}<span class="lo-stat-unit">m jam</span></span>` : '';
    const snareHtml = hasSnare ? `<span class="lo-stat" data-tip="Snare range">${fmtStat(q.InterdictionRange)}<span class="lo-stat-unit">m snare</span></span>` : '';
    if (jammerHtml && snareHtml) {
      primaryStat = `<span class="lo-stat-stack">${jammerHtml}${snareHtml}</span>`;
    } else {
      primaryStat = jammerHtml || snareHtml;
    }
  }

  // Metadata line (power on the left, secondary stats on the right)
  const leftParts = [];
  if (pw > 0) leftParts.push(`<span data-tip="Power draw"><i class="spvi-powerplant"></i> <span class="lo-val">${fmtStat(pw, pw % 1 ? 1 : undefined)}</span></span>`);

  const rightParts = [];
  if (si?.Emp) {
    const e = si.Emp;
    if (e.MaxRadius) rightParts.push(`<span data-tip="Effective radius"><span class="lo-val">${fmtStat(e.MaxRadius)}</span> m</span>`);
    if (e.ChargeTime) rightParts.push(`<span data-tip="Charge time"><span class="lo-val">${fmtStat(e.ChargeTime, e.ChargeTime % 1 ? 1 : undefined)}</span>s CT</span>`);
    if (e.CooldownTime) rightParts.push(`<span data-tip="Cooldown"><span class="lo-val">${fmtStat(e.CooldownTime, e.CooldownTime % 1 ? 1 : undefined)}</span>s CD</span>`);
  }
  if (si?.QuantumInterdiction) {
    const q = si.QuantumInterdiction;
    if (q.ChargeTime) rightParts.push(`<span data-tip="Charge time"><span class="lo-val">${fmtStat(q.ChargeTime, q.ChargeTime % 1 ? 1 : undefined)}</span>s CT</span>`);
    if (q.CooldownTime) rightParts.push(`<span data-tip="Cooldown"><span class="lo-val">${fmtStat(q.CooldownTime, q.CooldownTime % 1 ? 1 : undefined)}</span>s CD</span>`);
  }

  const leftStr = leftParts.join(' \u00b7 ');
  const rightStr = rightParts.join(' \u00b7 ');
  const tagAttr = slot.portTags?.length ? ` data-port-tags='${JSON.stringify(slot.portTags)}'` : '';
  const reqTagAttr = slot.requiredTags?.length ? ` data-required-tags='${JSON.stringify(slot.requiredTags)}'` : '';

  const craftIndicator = !isEmpty && className ? renderCraftingIndicator(slot.portName, className) : '';
  return `<div class="${cls}" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}>
    <div class="lo-slot-top">
      <span class="lo-size">S${slot.maxSize}</span>
      <span class="lo-name">${name}${craftIndicator}</span>
      ${primaryStat}
    </div>
    ${(leftStr || rightStr) ? `<div class="lo-meta"><span>${leftStr}</span>${rightStr ? `<span class="lo-ammo">${rightStr}</span>` : ''}</div>` : ''}
  </div>`;
}

/**
 * Read-only thruster row. Thrusters in SPViewer data are flat stat blobs without
 * PortName/Types/BaseLoadout, so they can't go through the picker. Display as
 * an aggregated summary: "Main x2 - 200 MN".
 */
export function renderThrusterSlot(slot) {
  const gradeChar = slot.grade ? String.fromCharCode(64 + slot.grade) : '';
  const sizeStr = slot.size != null ? `S${slot.size}` : '';
  const countStr = slot.count > 1 ? `<span class="lo-count">x${slot.count}</span>` : '';
  const thrustStr = slot.totalThrust > 0
    ? `<span class="lo-stat">${fmtStat(slot.totalThrust / 1000, slot.totalThrust >= 100000 ? 0 : 1)}<span class="lo-stat-unit">MN</span></span>`
    : '';
  const fuelStr = slot.totalFuelPerSec > 0
    ? `<span data-tip="Total fuel use at full throttle"><span class="lo-val">${fmtStat(slot.totalFuelPerSec, slot.totalFuelPerSec % 1 ? 1 : undefined)}</span> fuel/s</span>`
    : '';
  const metaParts = [];
  if (gradeChar) metaParts.push(`Grade ${gradeChar}`);
  if (fuelStr) metaParts.push(fuelStr);
  const meta = metaParts.join(' \u00b7 ');
  return `<div class="lo-slot uneditable">
    <div class="lo-slot-top">
      <span class="lo-size">${sizeStr}</span>
      <span class="lo-name">${slot.thrusterLabel} ${countStr}</span>
      ${thrustStr}
    </div>
    ${meta ? `<div class="lo-meta">${meta}</div>` : ''}
  </div>`;
}

// Compute pip channel values (myPips, myMax, myMod, isPowered) for a system slot.
function resolveSlotPipState(slot, channels, rn) {
  let myPips = 0, myMax = 1, myMod = 0, isPowered = true;
  if (slot.category === 'Shields') {
    const shieldCh = channels.find(c => c.key === 'shields');
    const shieldBreakdown = shieldCh?.shieldSlots || [];
    const shieldSystemSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Shields');
    const shieldIdx = shieldSystemSlots.indexOf(slot);
    const totalShieldPips = shieldCh?.allocated || 0;
    myMax = shieldBreakdown[shieldIdx]?.max || 1;
    // IR demand uses the powered-shield distribution (matches cooling formula):
    // unpowered generators are off, so they have 0 pips and 0 IR contribution.
    const poweredDist = distributeShieldPipsTop2(shieldBreakdown, totalShieldPips);
    myPips = poweredDist[shieldIdx] || 0;
    isPowered = shieldBreakdown[shieldIdx]?.powered ?? (myPips > 0);
  } else if (slot.category === 'Power Plants') {
    // PP scales with total load - for shields, only powered shields draw power
    let totalPips = 0;
    for (const c of channels) {
      if (c.key === 'shields' && c.poweredMax != null) {
        totalPips += Math.min(c.allocated, c.poweredMax);
      } else {
        totalPips += c.allocated || 0;
      }
    }
    myPips = totalPips;
    myMax = state.currentPipAllocation.powerOutput || 1;
  } else {
    // Find matching channel
    const catKeyMap = { 'Coolers': 'cooler_', 'Radar': 'radar', 'Life Support': 'lifeSupport', 'Quantum Drive': 'quantumDrive' };
    const prefix = catKeyMap[slot.category];
    if (prefix) {
      if (prefix === 'cooler_') {
        const coolerSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Coolers');
        const coolerIdx = coolerSlots.indexOf(slot);
        const ch = channels.find(c => c.key === `cooler_${coolerIdx}`);
        if (ch) { myPips = ch.allocated || 0; myMax = ch.max || 1; }
      } else {
        const ch = channels.find(c => c.key === prefix);
        if (ch) { myPips = ch.allocated || 0; myMax = ch.max || 1; }
      }
    }
  }
  // Compute modifier from PowerRanges (using RegisterRange=true entries)
  if (isPowered && myPips > 0 && slot.category !== 'Power Plants') {
    const pr = rn.PowerRanges;
    if (pr) {
      const ranges = Object.values(pr).filter(r => r.RegisterRange).sort((a, b) => a.Start - b.Start);
      for (const r of ranges) {
        if (myPips >= r.Start) myMod = r.Modifier;
      }
    }
  }
  return { myPips, myMax, myMod, isPowered };
}

// Build the meta line HTML for a Shield slot.
function renderShieldSlotBody(slot, si, rn, channels, emNom, emK, myPips, myMax, isPowered) {
  const shieldCh_ = channels.find(c => c.key === 'shields');
  const shieldBreak_ = shieldCh_?.shieldSlots || [];
  const shieldSysSlots_ = (state.currentSlots.systems || []).filter(s => s.category === 'Shields');
  const shieldIdx_ = shieldSysSlots_.indexOf(slot);
  const totalSPips_ = shieldCh_?.allocated || 0;
  const conv = rn.Conversion?.[0] || {};
  const pw = conv.Consumption?.Segment || 0;
  const pipFrac = myMax > 0 ? myPips / myMax : 0;
  const leftParts = [];
  // Shield: power draw (all-3 dist), EM (top-2 dist), charge time (top-2 by regen)
  if (isPowered) {
    const actualPw = myPips > 0 ? pw * pipFrac : 0;
    if (pw > 0) leftParts.push(`<span data-tip="Power draw"><i class="spvi-powerplant"></i> <span class="lo-val">${fmtStat(actualPw, 1)}</span></span>`);
    if (emNom > 0) {
      // EM uses top-2 by segment distribution
      const top2Dist = distributeShieldPipsTop2(shieldBreak_, totalSPips_);
      const emPips = top2Dist[shieldIdx_] || 0;
      const emFrac = myMax > 0 ? emPips / myMax : 0;
      const emModVal = emPips > 0 ? (() => {
        const pr2 = rn.PowerRanges;
        if (!pr2) return 0;
        const ranges = Object.values(pr2).filter(r => r.RegisterRange).sort((a, b) => a.Start - b.Start);
        let m = 0; for (const r of ranges) { if (emPips >= r.Start) m = r.Modifier; } return m;
      })() : 0;
      const actualEM = emModVal > 0 ? emNom * emModVal * emFrac * emK : 0;
      leftParts.push(`<span data-tip="EM signature"><i class="spvi-electric"></i> <span class="lo-val">${fmtStat(actualEM, actualEM % 1 ? 1 : undefined)}</span></span>`);
    }
  } else {
    leftParts.push(`<span class="lo-unpowered">Unpowered</span>`);
  }

  // Charge time (system-wide, same rate for all shields including unpowered)
  let chargeStr = '';
  {
    const shieldCh2 = channels.find(c => c.key === 'shields');
    const shieldBreak2 = shieldCh2?.shieldSlots || [];
    const shieldSystemSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Shields');
    const totalSPips = shieldCh2?.allocated || 0;

    // Collect all equipped shields with powered state
    const shieldData = [];
    for (let si2 = 0; si2 < shieldSystemSlots.length; si2++) {
      const portName = shieldSystemSlots[si2].portName;
      const cn = portName in state.currentLoadout ? state.currentLoadout[portName] : shieldSystemSlots[si2].baseLoadout?.ClassName;
      const sSi = cn ? getCraftedItemStats(cn, portName) : null;
      if (!sSi?.Shield) continue;
      shieldData.push({ hp: sSi.Shield.Health || 0, regen: sSi.Shield.RegenRate || 0, max: shieldBreak2[si2]?.max || 0, powered: shieldBreak2[si2]?.powered ?? false });
    }

    if (shieldData.length > 0) {
      // HP from ALL equipped shield generators (full pool must recharge)
      const totalHP = shieldData.reduce((sum, s) => sum + s.hp, 0);
      // Only powered shields provide regeneration
      const poweredShields = shieldData.filter(s => s.powered);
      const top2ByRegen = [...poweredShields].sort((a, b) => b.regen - a.regen).slice(0, 2);
      // Use powered shields' max as the effective pip pool for charge calculation
      const poweredMax2 = shieldCh2?.poweredMax || top2ByRegen.reduce((s, r) => s + r.max, 0);
      const effectivePips = Math.min(totalSPips, poweredMax2);
      let combinedRegen = 0;
      // Distribute effective pips among top 2 by regen
      if (top2ByRegen.length > 0 && effectivePips > 0) {
        let remaining = effectivePips;
        const top2Pips = top2ByRegen.map(() => 0);
        for (let t = 0; t < top2ByRegen.length; t++) {
          if (remaining <= 0) break;
          top2Pips[t] = Math.min(1, remaining);
          remaining -= top2Pips[t];
        }
        if (remaining > 0) {
          const active = top2ByRegen.map((s, t) => ({ idx: t, room: s.max - top2Pips[t] })).filter(a => a.room > 0);
          while (remaining > 0.001 && active.length > 0) {
            const share = remaining / active.length;
            for (let a = active.length - 1; a >= 0; a--) {
              const add = Math.min(share, active[a].room);
              top2Pips[active[a].idx] += add;
              remaining -= add;
              active[a].room -= add;
              if (active[a].room <= 0.001) active.splice(a, 1);
            }
          }
        }
        for (let t = 0; t < top2ByRegen.length; t++) {
          const frac = top2ByRegen[t].max > 0 ? top2Pips[t] / top2ByRegen[t].max : 0;
          combinedRegen += top2ByRegen[t].regen * frac;
        }
      }
      const chargeTime = combinedRegen > 0 ? totalHP / combinedRegen : 0;
      if (chargeTime > 0) chargeStr = `<span class="lo-val">${chargeTime.toFixed(1)}s</span> to charge`;
    }
  }
  const leftStr = leftParts.join(' \u00b7 ');
  if (leftStr || chargeStr) {
    return `<div class="lo-meta"><span>${leftStr}</span>${chargeStr ? `<span class="lo-ammo">${chargeStr}</span>` : ''}</div>`;
  }
  return '';
}

// Build the meta line HTML for a Power Plant slot.
function renderPowerPlantSlotBody(slot, emNom, emK, myPips, myMax) {
  const pipFrac = myMax > 0 ? myPips / myMax : 0;
  const leftParts = [];
  // PP: show EM based on load (disabled PPs contribute nothing)
  if (state.currentDisabledPorts?.has(slot.portName)) {
    leftParts.push(`<span class="lo-unpowered">Unpowered</span>`);
  } else if (emNom > 0) {
    const actualEM = emNom * pipFrac * emK;
    leftParts.push(`<span data-tip="EM signature"><i class="spvi-electric"></i> <span class="lo-val">${fmtStat(actualEM, actualEM % 1 ? 1 : undefined)}</span></span>`);
  }
  const leftStr = leftParts.join(' \u00b7 ');
  if (leftStr) return `<div class="lo-meta"><span>${leftStr}</span></div>`;
  return '';
}

// Build the meta line HTML for a Cooler slot.
function renderCoolerSlotBody(rn, channels, emNom, irNom, emK, irK, myPips, myMax, myMod) {
  const pipFrac = myMax > 0 ? myPips / myMax : 0;
  const conv = rn.Conversion?.[0] || {};
  const pw = conv.Consumption?.Segment || 0;
  const leftParts = [];
  // Cooler: power draw, EM, IR
  if (pw > 0) leftParts.push(`<span data-tip="Power draw"><i class="spvi-powerplant"></i> <span class="lo-val">${fmtStat(pw * pipFrac, 1)}</span></span>`);
  if (emNom > 0) {
    const actualEM = myMod > 0 ? emNom * myMod * pipFrac * emK : 0;
    leftParts.push(`<span data-tip="EM signature"><i class="spvi-electric"></i> <span class="lo-val">${fmtStat(actualEM, actualEM % 1 ? 1 : undefined)}</span></span>`);
  }
  if (irNom > 0) {
    let myShare = 0;
    if (myPips > 0) {
      // IR per cooler from cooling demand model
      const cooling = calculateCoolingStats(channels, state.currentLoadout, state.currentSlots);
      const coolerSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Coolers');
      let totalCoolOutput = 0;
      for (const cs of coolerSlots) {
        const cn = cs.portName in state.currentLoadout ? state.currentLoadout[cs.portName] : cs.baseLoadout?.ClassName;
        if (!cn) continue;
        // Crafted - Coolant Rating modifier flows into UnitPerSec.
        const csi = getCraftedItemStats(cn, cs.portName);
        const crn = csi?.ResourceNetwork?.[0];
        const cconv = crn?.Conversion?.find(c => c.Generation?.Resource === 'Coolant');
        if (cconv) totalCoolOutput += cconv.Generation.UnitPerSec || 0;
      }
      const totalIRNom = coolerSlots.reduce((sum, cs) => {
        const cn = cs.portName in state.currentLoadout ? state.currentLoadout[cs.portName] : cs.baseLoadout?.ClassName;
        // IR signature is not crafting-modifiable - raw is fine.
        const csi = cn ? getItemStats(cn) : null;
        return sum + (csi?.ResourceNetwork?.[0]?.Signatures?.Infrared?.Nominal || 0);
      }, 0);
      if (totalCoolOutput > 0 && totalIRNom > 0) {
        const totalIR = cooling.coolingDemand * totalIRNom / totalCoolOutput * irK;
        myShare = (irNom / totalIRNom) * totalIR;
      }
    }
    leftParts.push(`<span data-tip="IR signature"><i class="spvi-infrared"></i> <span class="lo-val">${fmtStat(myShare, myShare % 1 ? 1 : undefined)}</span></span>`);
  }
  const leftStr = leftParts.join(' \u00b7 ');
  if (leftStr) return `<div class="lo-meta"><span>${leftStr}</span></div>`;
  return '';
}

// Build the meta line HTML for Radar, Life Support, and Quantum Drive slots.
function renderGenericSystemSlotBody(slot, si, rn, emNom, emK, myPips, myMax, myMod) {
  const pipFrac = myMax > 0 ? myPips / myMax : 0;
  const leftParts = [];
  // Radar, Life Support, QD: power draw + EM
  let pw = 0;
  for (const c of rn.Consumption || []) { if (c.Resource === 'Power') pw += c.Segment || c.UnitPerSec || 0; }
  for (const c of rn.Conversion || []) { if (c.Consumption?.Resource === 'Power') pw += c.Consumption.Segment || 0; }
  if (pw > 0) leftParts.push(`<span data-tip="Power draw"><i class="spvi-powerplant"></i> <span class="lo-val">${fmtStat(pw * pipFrac, 1)}</span></span>`);
  if (emNom > 0) {
    const actualEM = myMod > 0 ? emNom * myMod * pipFrac * emK : 0;
    leftParts.push(`<span data-tip="EM signature"><i class="spvi-electric"></i> <span class="lo-val">${fmtStat(actualEM, actualEM % 1 ? 1 : undefined)}</span></span>`);
  }
  // QD: add spool + cooldown + range on the right side of the meta line.
  // Range is computed from the ship's quantum fuel capacity divided by
  // the QD's MicroUnitPerSec consumption \u2014 same formula as renderStats.
  let qdRightStr = '';
  if (slot.category === 'Quantum Drive') {
    const jump = si.QuantumDrive?.StandardJump || {};
    const spool = jump.SpoolUpTime;
    const cd = jump.Cooldown;
    const qdParts = [];
    if (spool > 0) qdParts.push(`<span data-tip="Spool up time"><span class="lo-val">${fmtStat(spool, spool % 1 ? 1 : undefined)}</span>s spool</span>`);
    if (cd > 0) qdParts.push(`<span data-tip="Cooldown"><span class="lo-val">${fmtStat(cd, cd % 1 ? 1 : undefined)}</span>s CD</span>`);
    const qfuelCap = state.currentQFuelCapacity || 0;
    let rangeGm = 0;
    for (const node of (si.ResourceNetwork || [])) {
      for (const c of (node.Consumption || [])) {
        if (c.Resource === 'QuantumFuel' && c.MicroUnitPerSec && qfuelCap > 0) {
          rangeGm = qfuelCap / (c.MicroUnitPerSec / 1000);
          break;
        }
      }
      if (rangeGm > 0) break;
    }
    if (rangeGm > 0) qdParts.push(`<span data-tip="Max range"><span class="lo-val">${fmtStat(rangeGm, rangeGm < 10 ? 2 : (rangeGm < 100 ? 1 : undefined))}</span> Gm</span>`);
    qdRightStr = qdParts.join(' \u00b7 ');
  }
  const leftStr = leftParts.join(' \u00b7 ');
  if (leftStr || qdRightStr) {
    return `<div class="lo-meta"><span>${leftStr}</span>${qdRightStr ? `<span class="lo-ammo">${qdRightStr}</span>` : ''}</div>`;
  }
  return '';
}

export function renderSystemSlot(slot) {
  const explicitly = slot.portName in state.currentLoadout;
  const className = explicitly ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
  const si = className ? getCraftedItemStats(className, slot.portName) : null;
  const isEmpty = explicitly && !className;
  const name = isEmpty ? 'Empty' : prettifyName(si?.Name || slot.baseLoadout?.Name || 'Empty');
  const grade = si?.Grade;
  const cls = si?.Class || '';

  const editable = !slot.uneditable && !state.LOCKED_CATEGORIES.has(slot.category);
  const slotCls = editable ? 'lo-slot' : 'lo-slot uneditable';

  // Get key stat based on component type
  const keyStat = getKeyStatDisplay(si, slot.category, slot);

  // Build component meta line with dynamic power/EM/IR values
  let componentMeta = '';
  if (!isEmpty && si?.ResourceNetwork && state.currentPipAllocation) {
    const channels = state.currentPipAllocation.channels;
    const rn = si.ResourceNetwork[0] || {};
    const emNom = rn.Signatures?.Electromagnetic?.Nominal || 0;
    const irNom = rn.Signatures?.Infrared?.Nominal || 0;
    const sigMult = state.currentShipConfig?.signalMultipliers || {};
    const emK = sigMult.Electromagnetic ?? 1;
    const irK = sigMult.Infrared ?? 1;

    const { myPips, myMax, myMod, isPowered } = resolveSlotPipState(slot, channels, rn);

    if (slot.category === 'Shields') {
      componentMeta = renderShieldSlotBody(slot, si, rn, channels, emNom, emK, myPips, myMax, isPowered);
    } else if (slot.category === 'Power Plants') {
      componentMeta = renderPowerPlantSlotBody(slot, emNom, emK, myPips, myMax);
    } else if (slot.category === 'Coolers') {
      componentMeta = renderCoolerSlotBody(rn, channels, emNom, irNom, emK, irK, myPips, myMax, myMod);
    } else {
      componentMeta = renderGenericSystemSlotBody(slot, si, rn, emNom, emK, myPips, myMax, myMod);
    }
  }

  // Fallback to class/grade if no dynamic meta
  if (!componentMeta && !isEmpty && grade != null) {
    componentMeta = `<div class="lo-meta">${cls} grade ${String.fromCharCode(64 + grade)}</div>`;
  }

  // Power toggle button (shields and power plants)
  let powerToggle = '';
  if (slot.category === 'Shields' && si && !isEmpty && state.currentPipAllocation) {
    const shieldCh = state.currentPipAllocation.channels.find(c => c.key === 'shields');
    const shieldBreak = shieldCh?.shieldSlots || [];
    const shieldSysSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Shields');
    const sIdx = shieldSysSlots.indexOf(slot);
    const powered = shieldBreak[sIdx]?.powered ?? false;
    powerToggle = `<button class="lo-power-toggle ${powered ? 'active' : ''}" data-shield-idx="${sIdx}" data-tip="${powered ? 'Powered - click to turn off' : 'Unpowered - click to turn on'}"><i class="spvi-power_button"></i></button>`;
  } else if (slot.category === 'Power Plants' && si && !isEmpty) {
    const powered = !state.currentDisabledPorts?.has(slot.portName);
    powerToggle = `<button class="lo-power-toggle ${powered ? 'active' : ''}" data-port="${slot.portName}" data-tip="${powered ? 'Powered - click to turn off' : 'Unpowered - click to turn on'}"><i class="spvi-power_button"></i></button>`;
  }

  const finalCls = powerToggle ? slotCls + ' has-toggle' : slotCls;
  const tagAttr = slot.portTags?.length ? ` data-port-tags='${JSON.stringify(slot.portTags)}'` : '';
  const reqTagAttr = slot.requiredTags?.length ? ` data-required-tags='${JSON.stringify(slot.requiredTags)}'` : '';

  // Sub-ports rendered inline under the host row (e.g. a Quantum Drive's
  // JumpDrive slot). Same visual treatment as mining-head module sub-slots.
  const subPorts = (slot.ports || []).filter(sub =>
    (sub.types || []).some(t => /^JumpDrive/i.test(t))
  );
  const subPortsHtml = subPorts.length > 0
    ? `<div class="lo-module-subs">${subPorts.map(sub => {
        const subExplicit = sub.portName in state.currentLoadout;
        const subClass = subExplicit ? state.currentLoadout[sub.portName] : sub.baseLoadout?.ClassName;
        const subSi = subClass ? getItemStats(subClass) : null;
        const subName = (subExplicit && !subClass) ? 'Empty' : prettifyName(subSi?.Name || sub.baseLoadout?.Name || 'Empty');
        const subTags = sub.portTags?.length ? ` data-port-tags='${JSON.stringify(sub.portTags)}'` : '';
        const subReqTags = sub.requiredTags?.length ? ` data-required-tags='${JSON.stringify(sub.requiredTags)}'` : '';
        const subMeta = subSi ? `${subSi.Class || ''} grade ${subSi.Grade != null ? String.fromCharCode(64 + subSi.Grade) : ''}`.trim() : '';
        return `<div class="lo-slot lo-module-sub" data-port="${sub.portName}" data-min="${sub.minSize}" data-max="${sub.maxSize}" data-types='${JSON.stringify(sub.types)}'${subTags}${subReqTags}>
          <div class="lo-slot-top">
            <span class="lo-size">S${sub.maxSize}</span>
            <span class="lo-name">${subName}</span>
          </div>
          ${subMeta ? `<div class="lo-meta">${subMeta}</div>` : ''}
        </div>`;
      }).join('')}</div>`
    : '';

  const craftIndicator = !isEmpty && className ? renderCraftingIndicator(slot.portName, className) : '';
  return `<div class="${finalCls}" data-port="${slot.portName}" data-min="${slot.minSize}" data-max="${slot.maxSize}" data-types='${JSON.stringify(slot.types)}'${tagAttr}${reqTagAttr}>
    ${powerToggle ? '<div class="lo-slot-content">' : ''}
      <div class="lo-slot-top">
        <span class="lo-size">S${slot.maxSize}</span>
        <span class="lo-name">${name}${craftIndicator}</span>
        ${keyStat}
      </div>
      ${componentMeta}
    ${powerToggle ? '</div>' : ''}
    ${powerToggle}
  </div>${subPortsHtml}`;
}

export function getKeyStatDisplay(si, category, slot) {
  if (!si) return '';

  if (category === 'Shields' && si.Shield) {
    const shCh = state.currentPipAllocation?.channels?.find(c => c.key === 'shields');
    const shHp = (shCh?.allocated || 0) === 0 ? 0 : si.Shield.Health;
    return `<span class="lo-stat">${fmtStat(shHp)}<span class="lo-stat-unit">HP</span></span>`;
  }

  const rn = si.ResourceNetwork;
  if (!Array.isArray(rn)) return '';

  for (const node of rn) {
    if (node.Generation) {
      for (const gen of node.Generation) {
        if (gen.Resource === 'Power') {
          return `<span class="lo-stat">${fmtStat(gen.Segment)}<span class="lo-stat-unit">pw</span></span>`;
        }
      }
    }
    if (node.Conversion) {
      for (const conv of node.Conversion) {
        if (conv.Generation?.Resource === 'Coolant') {
          const baseOutput = conv.Generation.UnitPerSec || 0;
          // Apply pip scaling: output × PowerRanges modifier × pip fraction
          const coolerSlots = (state.currentSlots?.systems || []).filter(s => s.category === 'Coolers');
          const coolerIdx = slot ? coolerSlots.indexOf(slot) : -1;
          const ch = coolerIdx >= 0 ? state.currentPipAllocation?.channels?.find(c => c.key === `cooler_${coolerIdx}`) : null;
          let scaledOutput = baseOutput;
          if (ch) {
            const pips = ch.allocated || 0;
            const maxPips = ch.max || 1;
            const pr = node.PowerRanges;
            let mod = 0;
            if (pr && pips > 0) {
              const ranges = Object.values(pr).sort((a, b) => a.Start - b.Start);
              for (const r of ranges) { if (pips >= r.Start) mod = r.Modifier; }
            }
            scaledOutput = baseOutput * mod * (pips / maxPips);
          }
          return `<span class="lo-stat">${fmtStat(scaledOutput)}<span class="lo-stat-unit">cool</span></span>`;
        }
      }
    }
  }

  if (si.QuantumDrive) {
    const speed = si.QuantumDrive.StandardJump?.Speed;
    if (speed) {
      return `<span class="lo-stat">${fmtStat(speed / 1000)}<span class="lo-stat-unit">km/s</span></span>`;
    }
  }

  if (si.Radar) {
    const aim = si.Radar.AimAssist;
    const minRange = aim?.DistanceMin || 0;
    const maxRange = aim?.DistanceMax || 0;
    if (maxRange > 0) {
      // Interpolate range between DistanceMin (at min pips) and DistanceMax (at max pips)
      const radarCh = state.currentPipAllocation?.channels?.find(c => c.key === 'radar');
      const allocated = radarCh?.allocated || 0;
      const minPips = radarCh?.min || 0;
      const maxPips = radarCh?.max || 1;
      const pipRange = maxPips - minPips;
      const frac = pipRange > 0 ? Math.max(0, allocated - minPips) / pipRange : (allocated > 0 ? 1 : 0);
      const effectiveRange = Math.round(minRange + (maxRange - minRange) * frac);
      return `<span class="lo-stat lo-stat-text">Aim assist at <span class="lo-val">${fmtStat(allocated > 0 ? effectiveRange : 0)}</span> m</span>`;
    }
    return '';
  }

  return '';
}

// Module-level: banner expanded state persists across re-renders
// (re-renders happen on pip change / loadout change - we don't want to
// collapse the detail overlay every time the user clicks a pip).
let _bannerExpanded = false;
// Singleton guard so global click/keydown listeners are only installed once.
let _bannerGlobalListenersInstalled = false;

// Compute pip-scaled IR/EM signatures; updates state.currentSignatures as side-effect.
function computeAndSetSignatures(stats) {
  let scaledIR = 0;
  let scaledEM = stats.emSignature;
  let pipCoolingSupply = stats.cooling; // fallback to static if no pip allocation
  if (state.currentPipAllocation) {
    const channels = state.currentPipAllocation.channels;
    const cooling = calculateCoolingStats(channels, state.currentLoadout, state.currentSlots);
    pipCoolingSupply = cooling.coolingSupply;

    const coolerSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Coolers');
    let totalIRNom = 0, totalCoolOutput = 0;
    for (const slot of coolerSlots) {
      const cn = slot.portName in state.currentLoadout ? state.currentLoadout[slot.portName] : slot.baseLoadout?.ClassName;
      if (!cn) continue;
      const si = getItemStats(cn);
      const rn = si?.ResourceNetwork?.[0];
      if (!rn) continue;
      totalIRNom += rn.Signatures?.Infrared?.Nominal || 0;
      const conv = rn.Conversion?.find(c => c.Generation?.Resource === 'Coolant');
      if (conv) totalCoolOutput += conv.Generation.UnitPerSec || 0;
    }

    const sigMult = state.currentShipConfig?.signalMultipliers || {};
    const irMult = sigMult.Infrared ?? 1;
    const emMult = sigMult.Electromagnetic ?? 1;

    if (totalCoolOutput > 0) {
      scaledIR = cooling.coolingDemand * totalIRNom / totalCoolOutput * irMult;
    }
    scaledEM = calculateEMSignature(channels, stats.ppEM, stats.ppSeg) * emMult;
  }
  // Cross-section is static per ship (no pip term) but carries its own signal
  // multiplier just like IR and EM, so it is scaled outside the pip block.
  const scaledCS = scaleCrossSection(
    state.currentShipConfig?.crossSection,
    state.currentShipConfig?.signalMultipliers?.CrossSection ?? 1
  );
  state.setCurrentSignatures({ em: Math.round(scaledEM), ir: Math.round(scaledIR), cs: scaledCS });
}

// Compute shield pip state (resFactor, scaledRegen, chargeTime, resistances) from pip allocation.
function computeShieldData(stats) {
  const shieldCh = state.currentPipAllocation?.channels.find(c => c.key === 'shields');
  const shieldAllocated = shieldCh?.allocated || 0;
  const shieldPoweredMax = shieldCh?.poweredMax || 0;
  const shieldOff = shieldAllocated === 0;

  // Shield resistance: per-shield PowerRanges modifier × effective pip fraction,
  // averaged across powered shields.
  let shieldResFactor = 0;
  if (shieldCh?.shieldSlots && !shieldOff) {
    const powered = shieldCh.shieldSlots.map((s, i) => ({ ...s, idx: i })).filter(s => s.powered && s.max > 0);
    if (powered.length > 0) {
      // Greedy pip distribution to powered shields
      const resPips = new Array(shieldCh.shieldSlots.length).fill(0);
      let remaining = Math.min(shieldAllocated, shieldPoweredMax);
      // Step 1: give min pips to each powered shield
      for (const s of powered) {
        const give = Math.min(s.min, remaining);
        resPips[s.idx] = give;
        remaining -= give;
      }
      // Step 2: fill shields one at a time to max
      for (const s of powered) {
        if (remaining <= 0) break;
        const room = s.max - resPips[s.idx];
        const give = Math.min(room, remaining);
        resPips[s.idx] += give;
        remaining -= give;
      }
      // Per-shield contribution: modifier(pips) × pips / max.
      // NOT (pips - min) / (max - min) - the min pips carry their share of the
      // resistance like any other pip, so the fraction is over the full segment.
      let contribSum = 0;
      for (const s of powered) {
        const pips = resPips[s.idx];
        let mod = 0;
        if (s.powerRanges && pips > 0) {
          const ranges = Object.values(s.powerRanges).sort((a, b) => a.Start - b.Start);
          for (const r of ranges) { if (pips >= r.Start) mod = r.Modifier; }
        }
        const effFrac = s.max > 0 ? pips / s.max : 0;
        contribSum += mod * effFrac;
      }
      shieldResFactor = contribSum / powered.length;
    }
  }

  // Shield resistance: interpolated using per-shield power factor
  const interpRes = (min, max) => {
    if (shieldOff) return 0;
    return +(((min + (max - min) * shieldResFactor)) * 100).toFixed(1);
  };

  // Shield HP: 0 when shields have no pips
  const effectiveShieldHP = shieldOff ? 0 : stats.shieldHP;

  // Shield regen, charge time, and resistances: from POWERED shields only
  let scaledShieldRegen = 0;
  let totalShieldChargeTime = 0;
  let powResPhysMin = 0, powResPhysMax = 0, powResEnergyMin = 0, powResEnergyMax = 0, powResDistMin = 0, powResDistMax = 0;
  let poweredCount = 0;
  if (stats.shieldHP > 0 && !shieldOff) {
    const shieldBreakStats = shieldCh?.shieldSlots || [];
    const shieldSystemSlots = (state.currentSlots.systems || []).filter(s => s.category === 'Shields');
    const poweredRegens = [];
    for (let si2 = 0; si2 < shieldSystemSlots.length; si2++) {
      const cn = shieldSystemSlots[si2].portName in state.currentLoadout ? state.currentLoadout[shieldSystemSlots[si2].portName] : shieldSystemSlots[si2].baseLoadout?.ClassName;
      const sSi = cn ? getItemStats(cn) : null;
      if (!sSi?.Shield) continue;
      if (shieldBreakStats[si2]?.powered) {
        poweredRegens.push(sSi.Shield.RegenRate || 0);
        const res = sSi.Shield.Resistance || {};
        powResPhysMin += (res.Physical?.Minimum || 0);
        powResPhysMax += (res.Physical?.Maximum || 0);
        powResEnergyMin += (res.Energy?.Minimum || 0);
        powResEnergyMax += (res.Energy?.Maximum || 0);
        powResDistMin += (res.Distortion?.Minimum || 0);
        powResDistMax += (res.Distortion?.Maximum || 0);
        poweredCount++;
      }
    }
    if (poweredCount > 0) {
      powResPhysMin /= poweredCount; powResPhysMax /= poweredCount;
      powResEnergyMin /= poweredCount; powResEnergyMax /= poweredCount;
      powResDistMin /= poweredCount; powResDistMax /= poweredCount;
    }
    const shieldPipFrac = shieldPoweredMax > 0 ? Math.min(shieldAllocated, shieldPoweredMax) / shieldPoweredMax : 0;
    scaledShieldRegen = poweredRegens.reduce((sum, r) => sum + r * shieldPipFrac, 0);
    totalShieldChargeTime = scaledShieldRegen > 0 ? stats.shieldHP / scaledShieldRegen : 0;
  }

  const shResPhys = poweredCount > 0 ? interpRes(powResPhysMin, powResPhysMax) : 0;
  const shResEnergy = poweredCount > 0 ? interpRes(powResEnergyMin, powResEnergyMax) : 0;
  const shResDist = poweredCount > 0 ? interpRes(powResDistMin, powResDistMax) : 0;

  return { effectiveShieldHP, scaledShieldRegen, totalShieldChargeTime, shResPhys, shResEnergy, shResDist };
}

// Compute totalCargo (base + module grids) and storageRawScu from current state.
function computeCargoData() {
  const storageRawScu = state.currentShipConfig?.cargo?.storage || 0;
  let totalCargo = state.currentShipConfig?.baseCargo || 0;
  for (const moduleSlot of state.currentSlots.modules || []) {
    const moduleClass = state.currentLoadout[moduleSlot.portName] || moduleSlot.baseLoadout?.ClassName;
    if (!moduleClass) continue;
    const moduleSi = getItemStats(moduleClass);
    if (!moduleSi?.Ports) continue;
    function sumCargoGrids(item) {
      let scu = 0;
      if (item?.CargoGrid?.Capacity) scu += item.CargoGrid.Capacity;
      for (const p of (item?.Ports || [])) scu += sumCargoGrids(p.InstalledItem);
      return scu;
    }
    totalCargo += sumCargoGrids(moduleSi);
  }
  return { totalCargo, storageRawScu };
}

// Compute QD range in Gm from the equipped QD and current quantum fuel capacity.
function computeQdRange() {
  // ── Quantum Drive range (gigameters) ──
  // Uses the currently equipped QD's QuantumFuel consumption rate divided
  // into the ship's quantum fuel tank capacity. Matches the formula already
  // used in weaponColumn.extractRowData (picker Range column).
  //
  // NOTE on units: we use state.currentQFuelCapacity here (sourced from
  // `QuantumFuelTanks.TotalQuantumFuelCapacity`) which is already in the
  // M unit scale. The picker formula is calibrated against this value and
  // returns GM. Using `config.fuel.quantumCapacity` from FuelManagement
  // would be off by 1e6 since that's the raw µL value.
  let qdRangeGm = 0;
  const qdSlot = (state.currentSlots.systems || []).find(s => s.category === 'Quantum Drive');
  if (qdSlot) {
    const qdCn = state.currentLoadout[qdSlot.portName] || qdSlot.baseLoadout?.ClassName;
    // Crafted - Quantum Speed + Quantum Fuel Burn modifiers feed into the
    // QD range derivation below.
    const qdSi = qdCn ? getCraftedItemStats(qdCn, qdSlot.portName) : null;
    const qfuelCap = state.currentQFuelCapacity || 0;
    if (qdSi?.ResourceNetwork && qfuelCap > 0) {
      for (const node of qdSi.ResourceNetwork) {
        if (!node.Consumption) continue;
        for (const c of node.Consumption) {
          if (c.Resource === 'QuantumFuel' && c.MicroUnitPerSec) {
            qdRangeGm = qfuelCap / (c.MicroUnitPerSec / 1000);
            break;
          }
        }
        if (qdRangeGm > 0) break;
      }
    }
  }
  return qdRangeGm;
}

// Restructure the rendered pip panel into a horizontal body-row layout.
function restructurePipCard(pipMount, pipHtml) {
  // ── Pip card: render existing pip panel then restructure into a
  //    horizontal body-row (channels on the left, cooling + sigs on the right). ──
  pipMount.innerHTML = pipHtml;
  const pipPanelEl = pipMount.querySelector('.pip-panel');
  if (pipPanelEl) {
    const cols = pipPanelEl.querySelector('.pip-columns');
    const coolEl = pipPanelEl.querySelector('.cooling-bar-panel');
    const sigEl = pipPanelEl.querySelector('.sig-panel');
    if (cols && (coolEl || sigEl)) {
      const bodyRow = document.createElement('div');
      bodyRow.className = 'pip-body-row';
      const sidebar = document.createElement('div');
      sidebar.className = 'pip-sidebar';
      if (coolEl) sidebar.appendChild(coolEl);
      if (sigEl) sidebar.appendChild(sigEl);
      pipPanelEl.insertBefore(bodyRow, cols);
      bodyRow.appendChild(cols);
      bodyRow.appendChild(sidebar);
    }
  }
  bindPipInteraction(pipMount);
}

// Compute flight stats, applying any equipped flight blade overrides.
function computeFlightStats(engineCh) {
  let fs = state.currentShipConfig?.flightStats;

  // Override flight stats if a non-default flight blade is equipped
  const fbSlot = (state.currentSlots?.systems || []).find(s => s.category === 'Flight Blade');
  if (fbSlot && fs) {
    const fbClass = fbSlot.portName in state.currentLoadout
      ? state.currentLoadout[fbSlot.portName]
      : fbSlot.baseLoadout?.ClassName;
    const fbSi = fbClass ? getItemStats(fbClass) : null;
    const ifcs = fbSi?.Ifcs;
    if (ifcs) {
      const av = ifcs.AngularVelocity || {};
      const mm = ifcs.MasterModes || {};
      const ab = ifcs.AfterBurner || {};
      const avm = ab.AngVelocityMultiplier || {};
      // Blade capacitors carry no usage modifier of their own - keep the
      // hull's (1.0 on every ship in the current data).
      const cap = ab.Capacitor;
      fs = {
        ...fs,
        scmSpeed: ifcs.SCMSpeed || fs.scmSpeed,
        navSpeed: ifcs.MaxSpeed || fs.navSpeed,
        scmBoostForward: mm.BoostSpeedForward || fs.scmBoostForward,
        pitch: av.Pitch || fs.pitch,
        yaw: av.Yaw || fs.yaw,
        roll: av.Roll || fs.roll,
        boostPitchMult: avm.x || fs.boostPitchMult,
        boostYawMult: avm.y || fs.boostYawMult,
        boostRollMult: avm.z || fs.boostRollMult,
        boostCap: cap ? {
          size: cap.Size || 0,
          idleCost: cap.IdleCost || 0,
          usageModifier: fs.boostCap?.usageModifier ?? 1,
          regenPerSec: cap.RegenPerSec || 0,
          usageCurve: cap.Curves?.Usage || fs.boostCap?.usageCurve,
          regenCurve: cap.Curves?.Regen || fs.boostCap?.regenCurve,
        } : fs.boostCap,
      };
    }
  }

  // Boosted rotation (engine-pip scaled)
  const engAllocated = engineCh?.allocated ?? 0;
  const engMin = engineCh?.min ?? 0;
  const engMax = engineCh?.max ?? 1;
  const engFrac = engMax > engMin ? Math.max(0, Math.min(1, (engAllocated - engMin) / (engMax - engMin))) : 0;
  const bPitch = fs?.pitch ? (fs.pitch * (1 + (fs.boostPitchMult - 1) * engFrac)) : null;
  const bYaw   = fs?.yaw   ? (fs.yaw   * (1 + (fs.boostYawMult   - 1) * engFrac)) : null;
  const bRoll  = fs?.roll  ? (fs.roll  * (1 + (fs.boostRollMult  - 1) * engFrac)) : null;

  // Both capacitor figures scale with the engine power assignment, the same
  // engFrac that drives the boosted rotation rates above.
  return {
    fs, bPitch, bYaw, bRoll,
    boostTime: calculateBoostTime(fs?.boostCap, engFrac),
    boostRegen: calculateBoostRegenTime(fs?.boostCap, engFrac),
  };
}

// Build the OFFENSE collapsed banner cell.
function buildOffenseCell(combat, row, val) {
  // ── OFFENSE - Pilot / Turret / Missile / Bomb ──
  return `<div class="stats-group-cell"><div class="group-rows">
    ${row('Pilot', val(fmtStat(combat.pilotDps), 'DPS', 'cyan'))}
    ${combat.turretDps > 0
      ? row('Turret', val(fmtStat(combat.turretDps), 'DPS'))
      : row('Turret', val('-', 'DPS', 'dim'))}
    ${combat.totalMissileDmg > 0
      ? row('Missile', val(fmtStat(combat.totalMissileDmg), 'DMG'))
      : row('Missile', val('-', 'DMG', 'dim'))}
    ${combat.totalBombDmg > 0
      ? row('Bomb', val(fmtStat(combat.totalBombDmg), 'DMG'))
      : row('Bomb', val('-', 'DMG', 'dim'))}
  </div></div>`;
}

// Build the SHIELD collapsed banner cell.
function buildShieldCell(shieldData, stats, row, val) {
  const { effectiveShieldHP, shResPhys, shResEnergy, shResDist } = shieldData;
  const shielded = stats.shieldCount > 0;
  const resClass = (r) => r > 0 ? ' green' : r < 0 ? ' red' : '';
  // ── SHIELD - HP / Ballistic / Energy / Distortion resistances ──
  return `<div class="stats-group-cell"><div class="group-rows">
    ${row('Shield', val(fmtStat(effectiveShieldHP), 'HP', 'cyan'))}
    ${shielded
      ? row('Ballistic', val(shResPhys, '%', resClass(shResPhys).trim()))
      : row('Ballistic', val('-', '%', 'dim'))}
    ${shielded
      ? row('Energy', val(shResEnergy, '%', resClass(shResEnergy).trim()))
      : row('Energy', val('-', '%', 'dim'))}
    ${shielded
      ? row('Distortion', val(shResDist, '%', resClass(shResDist).trim()))
      : row('Distortion', val('-', '%', 'dim'))}
  </div></div>`;
}

// Build the ARMOR collapsed banner cell.
function buildArmorCell(armor, row, val) {
  const fmtMod = (m) => {
    if (m == null || isNaN(m)) return null;
    const pct = Math.round((m - 1) * 100);
    const sign = pct > 0 ? '+' : '';
    const cls = pct < 0 ? 'green' : pct > 0 ? 'red' : '';
    return { text: `${sign}${pct}`, cls };
  };
  const dPhys = armor?.deflPhys ?? 0;
  const dEnergy = armor?.deflEnergy ?? 0;
  const durPhys = fmtMod(armor?.modPhys);
  const durEnergy = fmtMod(armor?.modEnergy);
  const deflHtml = `<span class="g-val">${fmtStat(dPhys)}</span><span class="g-unit">phys</span><span class="g-sep">/</span><span class="g-val">${fmtStat(dEnergy)}</span><span class="g-unit">energy</span>`;
  const durPhysHtml = durPhys
    ? val(durPhys.text, '%', durPhys.cls)
    : val('-', '%', 'dim');
  const durEnergyHtml = durEnergy
    ? val(durEnergy.text, '%', durEnergy.cls)
    : val('-', '%', 'dim');
  // ── ARMOR - HP / Deflection (phys/energy) / Physical dur / Energy dur ──
  // Always render - some real vehicles (Greycat PTV etc.) have no Armor
  // block in the source; those still get an Armor cell with zeros instead
  // of dropping the whole cell and breaking the column layout.
  return `<div class="stats-group-cell"><div class="group-rows">
      ${row('Armor', val(fmtStat(armor?.health || 0), 'HP', 'cyan'))}
      ${row('Deflection', deflHtml)}
      ${row('Physical dur', durPhysHtml)}
      ${row('Energy dur', durEnergyHtml)}
    </div></div>`;
}

// Build the HULL collapsed banner cell; returns '' if hull has no data.
function buildHullCell(hull, cargoData, row, val) {
  const { totalCargo, storageRawScu } = cargoData;
  // ── HULL - HP / Mass / Cargo ──
  // Dimensions moved to the expanded overlay only - not useful at a glance.
  if (hull?.totalHP || hull?.mass > 0) {
    return `<div class="stats-group-cell"><div class="group-rows">
      ${row('Hull', val(fmtStat(hull?.totalHP || 0), 'HP', 'cyan'))}
      ${hull?.mass > 0 ? row('Mass', val(fmtStat(hull.mass, hull.mass % 1 ? 1 : undefined), 'kg')) : row('Mass', val('-', 'kg', 'dim'))}
      ${totalCargo > 0 ? row('Cargo', val(fmtStat(totalCargo), 'SCU')) : row('Cargo', val('-', 'SCU', 'dim'))}
      ${storageRawScu > 0 ? row('Storage', val(fmtStat(storageRawScu * 1000, (storageRawScu * 1000) % 1 ? 1 : 0), 'K μSCU')) : row('Storage', val('-', 'K μSCU', 'dim'))}
    </div></div>`;
  }
  return '';
}

// Build the FLIGHT collapsed banner cell; returns '' if no flight stats.
function buildFlightCell(flightData, row, val) {
  const { fs, bPitch, bYaw, bRoll } = flightData;
  // ── FLIGHT - SCM/Boost / Nav / P/Y/R / Boosted ──
  if (fs?.scmSpeed || fs?.navSpeed) {
    const scmBoostHtml = fs?.scmSpeed && fs?.scmBoostForward
      ? `<span class="g-val">${Math.round(fs.scmSpeed)}</span><span class="g-sep">/</span><span class="g-val">${Math.round(fs.scmBoostForward)}</span><span class="g-unit">m/s</span>`
      : fs?.scmSpeed
        ? val(Math.round(fs.scmSpeed), 'm/s')
        : val('-', 'm/s', 'dim');
    const pyrHtml = (fs?.pitch || fs?.yaw || fs?.roll)
      ? `<span class="g-val">${Math.round(fs.pitch || 0)}/${Math.round(fs.yaw || 0)}/${Math.round(fs.roll || 0)}</span><span class="g-unit">°/s</span>`
      : val('-', '°/s', 'dim');
    // Boosted P/Y/R is the engine-pip-scaled version computed above.
    const bpyrHtml = (bPitch != null || bYaw != null || bRoll != null)
      ? `<span class="g-val">${bPitch != null ? bPitch.toFixed(0) : '-'}/${bYaw != null ? bYaw.toFixed(0) : '-'}/${bRoll != null ? bRoll.toFixed(0) : '-'}</span><span class="g-unit">°/s</span>`
      : val('-', '°/s', 'dim');
    return `<div class="stats-group-cell"><div class="group-rows">
      ${row('SCM/Boost', scmBoostHtml)}
      ${fs?.navSpeed ? row('Nav', val(Math.round(fs.navSpeed), 'm/s')) : row('Nav', val('-', 'm/s', 'dim'))}
      ${row('P/Y/R', pyrHtml)}
      ${row('Boosted', bpyrHtml)}
    </div></div>`;
  }
  return '';
}

// Build the expanded Hull column HTML for the 3-col overlay.
function buildHullColHtml(hull, cargoData, fmtModPct) {
  const { totalCargo, storageRawScu } = cargoData;
  const vitalRows = hull?.vitalParts
    ? Object.entries(hull.vitalParts).map(([name, hp]) =>
        `<div class="stats-row"><span class="label indent">${humanizeVitalPartName(name)}</span><span class="value">${fmtStat(hp)}</span></div>`).join('')
    : '';
  const dimStr = hull?.dimensions
    ? `(S${hull.size}) ${fmtStat(hull.dimensions.Length, 1)} × ${fmtStat(hull.dimensions.Width, 1)} × ${fmtStat(hull.dimensions.Height, 1)} <span class="mini">m</span>`
    : '';

  // ── Carrying Capacity derived values ──
  // `storageRawScu` is computed earlier (near totalCargo) and reused here.
  // Display scaled up into K μSCU (thousand micro-SCU) which gives
  // whole-number readouts for most ships.
  // Conversion: 1 SCU = 1 000 000 μSCU = 1 000 K μSCU, so K μSCU = raw × 1000.
  const fmtStorage = (scu) => {
    if (!scu) return null;
    const kMicro = scu * 1000; // K μSCU
    const decimals = kMicro % 1 ? 1 : 0;
    return { num: fmtStat(kMicro, decimals), unit: 'K μSCU' };
  };
  const storageFmt = fmtStorage(storageRawScu);

  return `
    <div class="stats-group">
      <h4><i class="spvi-shield"></i> Hull</h4>
      ${dimStr ? `<div class="stats-row"><span class="label">Dimensions</span><span class="value">${dimStr}</span></div>` : ''}
      ${hull?.mass > 0 ? `<div class="stats-row"><span class="label">Mass</span><span class="value">${fmtStat(hull.mass, hull.mass % 1 ? 1 : undefined)} <span class="mini">kg</span></span></div>` : ''}
      ${hull?.totalHP ? `<div class="stats-row"><span class="label">Total HP</span><span class="value cyan">${fmtStat(hull.totalHP)}</span></div>` : ''}
      ${vitalRows ? `<div class="stats-sublabel">Vital Parts</div>${vitalRows}` : ''}
      ${hull ? `
        <div class="stats-sublabel">Damage Modifiers</div>
        <div class="stats-row"><span class="label indent">Physical</span>${fmtModPct(hull.damageModPhys)}</div>
        <div class="stats-row"><span class="label indent">Energy</span>${fmtModPct(hull.damageModEnergy)}</div>
        <div class="stats-row"><span class="label indent">Distortion</span>${fmtModPct(hull.damageModDist)}</div>
        <div class="stats-sublabel">Penetration Modifiers</div>
        <div class="stats-row"><span class="label indent">Fuse</span>${fmtModPct(hull.penFuse)}</div>
        <div class="stats-row"><span class="label indent">Component</span>${fmtModPct(hull.penComponent)}</div>
        <div class="stats-sublabel">Signature Modifiers</div>
        <div class="stats-row"><span class="label indent">Electromagnetic</span>${fmtModPct(hull.sigEM)}</div>
        <div class="stats-row"><span class="label indent">Cross Section</span>${fmtModPct(hull.sigCS)}</div>
        <div class="stats-row"><span class="label indent">Infrared</span>${fmtModPct(hull.sigIR)}</div>
      ` : ''}
      <h4 class="h4-sub"><i class="spvi-icon_common_3D_cargo_boxes"></i> Carrying Capacity</h4>
      <div class="stats-row"><span class="label">Cargo Grid</span><span class="value${totalCargo > 0 ? ' cyan' : ' dim'}">${fmtStat(totalCargo)} <span class="mini">SCU</span></span></div>
      ${storageFmt ? `<div class="stats-row"><span class="label">Storage</span><span class="value">${storageFmt.num} <span class="mini">${storageFmt.unit}</span></span></div>` : ''}
    </div>`;
}

// Build the expanded Weaponry column HTML for the 3-col overlay.
function buildWeaponryColHtml(combat, shieldData, stats, armor, fmtModPct, dpsMode) {
  const { effectiveShieldHP, scaledShieldRegen, totalShieldChargeTime, shResPhys, shResEnergy, shResDist } = shieldData;
  return `
    <div class="stats-group">
      <h4><i class="spvi-weapon"></i> Weaponry</h4>
      <div class="stats-row"><span class="label">Pilot DPS <span class="mini">${dpsMode}</span></span><span class="value cyan">${fmtStat(combat.pilotDps)}</span></div>
      ${combat.pilotPhys > 0 ? `<div class="stats-row"><span class="label indent">Ballistic</span><span class="value">${fmtStat(combat.pilotPhys)}</span></div>` : ''}
      ${combat.pilotEnergy > 0 ? `<div class="stats-row"><span class="label indent">Energy</span><span class="value">${fmtStat(combat.pilotEnergy)}</span></div>` : ''}
      ${combat.pilotDist > 0 ? `<div class="stats-row"><span class="label indent">Distortion</span><span class="value">${fmtStat(combat.pilotDist)}</span></div>` : ''}
      ${combat.turretDps > 0 ? `<div class="stats-row"><span class="label">Turret DPS <span class="mini">${dpsMode}</span></span><span class="value cyan">${fmtStat(combat.turretDps)}</span></div>` : ''}
      ${combat.turretPhys > 0 ? `<div class="stats-row"><span class="label indent">Ballistic</span><span class="value">${fmtStat(combat.turretPhys)}</span></div>` : ''}
      ${combat.turretEnergy > 0 ? `<div class="stats-row"><span class="label indent">Energy</span><span class="value">${fmtStat(combat.turretEnergy)}</span></div>` : ''}
      ${combat.turretDist > 0 ? `<div class="stats-row"><span class="label indent">Distortion</span><span class="value">${fmtStat(combat.turretDist)}</span></div>` : ''}
      ${combat.pdcDps > 0 ? `<div class="stats-row"><span class="label">PDC DPS <span class="mini">${dpsMode}</span></span><span class="value cyan">${fmtStat(combat.pdcDps)}</span></div>` : ''}
      ${combat.pdcPhys > 0 ? `<div class="stats-row"><span class="label indent">Ballistic</span><span class="value">${fmtStat(combat.pdcPhys)}</span></div>` : ''}
      ${combat.pdcEnergy > 0 ? `<div class="stats-row"><span class="label indent">Energy</span><span class="value">${fmtStat(combat.pdcEnergy)}</span></div>` : ''}
      ${combat.pdcDist > 0 ? `<div class="stats-row"><span class="label indent">Distortion</span><span class="value">${fmtStat(combat.pdcDist)}</span></div>` : ''}
      ${combat.apDps > 0 ? `<div class="stats-row"><span class="label">Anti-personnel DPS <span class="mini">${dpsMode}</span></span><span class="value cyan">${fmtStat(combat.apDps)}</span></div>` : ''}
      ${combat.apPhys > 0 ? `<div class="stats-row"><span class="label indent">Ballistic</span><span class="value">${fmtStat(combat.apPhys)}</span></div>` : ''}
      ${combat.apEnergy > 0 ? `<div class="stats-row"><span class="label indent">Energy</span><span class="value">${fmtStat(combat.apEnergy)}</span></div>` : ''}
      ${combat.apDist > 0 ? `<div class="stats-row"><span class="label indent">Distortion</span><span class="value">${fmtStat(combat.apDist)}</span></div>` : ''}
      ${combat.totalMissileDmg > 0 ? `<div class="stats-row"><span class="label">Missile Damage</span><span class="value cyan">${fmtStat(combat.totalMissileDmg)}</span></div>` : ''}
      ${combat.totalBombDmg > 0 ? `<div class="stats-row"><span class="label">Bomb Damage</span><span class="value cyan">${fmtStat(combat.totalBombDmg)}</span></div>` : ''}
      <h4 class="h4-sub"><i class="spvi-icon_common_generator_shield"></i> Shields</h4>
      <div class="stats-row"><span class="label">Shield HP</span><span class="value cyan">${fmtStat(effectiveShieldHP)}</span></div>
      <div class="stats-row"><span class="label">Shield Regen</span><span class="value">${fmtStat(scaledShieldRegen)} <span class="mini">/s</span></span></div>
      ${totalShieldChargeTime > 0 ? `<div class="stats-row"><span class="label">Shield Charge</span><span class="value">${totalShieldChargeTime.toFixed(1)} <span class="mini">s</span></span></div>` : ''}
      ${stats.shieldCount > 0 ? `
        <div class="stats-sublabel">Resistance</div>
        <div class="stats-row"><span class="label indent">Physical</span><span class="value${shResPhys > 0 ? ' green' : shResPhys < 0 ? ' red' : ''}">${shResPhys}<span class="mini">%</span></span></div>
        <div class="stats-row"><span class="label indent">Energy</span><span class="value${shResEnergy > 0 ? ' green' : shResEnergy < 0 ? ' red' : ''}">${shResEnergy}<span class="mini">%</span></span></div>
        <div class="stats-row"><span class="label indent">Distortion</span><span class="value${shResDist > 0 ? ' green' : shResDist < 0 ? ' red' : ''}">${shResDist}<span class="mini">%</span></span></div>
      ` : ''}
      <h4 class="h4-sub"><i class="spvi-Engineering_Icon_ItemShields"></i> Armor</h4>
      <div class="stats-row"><span class="label">HP</span><span class="value cyan">${fmtStat(armor?.health || 0)}</span></div>
      <div class="stats-row"><span class="label indent">Deflection <span class="mini">phys / energy</span></span><span class="value">${fmtStat(armor?.deflPhys || 0)} / ${fmtStat(armor?.deflEnergy || 0)}</span></div>
      <div class="stats-sublabel">Durability Damage Modifiers</div>
      <div class="stats-row"><span class="label indent">Physical</span>${fmtModPct(armor?.modPhys)}</div>
      <div class="stats-row"><span class="label indent">Energy</span>${fmtModPct(armor?.modEnergy)}</div>
    </div>`;
}

// Build the expanded Flight/Fuel/Insurance column HTML for the 3-col overlay.
function buildFlightColHtml(flightData, qdRangeGm) {
  const { fs, bPitch, bYaw, bRoll, boostTime, boostRegen } = flightData;
  const fmtSecs = (s) => s >= 100 ? Math.round(s) : s.toFixed(1);
  // ── Fuel / Insurance helpers ──
  // Fuel capacities are stored in µL. Display as "X.XX M (X.L SCU)" -
  // the "M" and "SCU" numbers are the same magnitude (raw / 1e6).
  const fuelInfo = state.currentShipConfig?.fuel;
  const fmtFuel = (raw) => {
    if (!raw) return null;
    const scu = raw / 1000000;
    const decimals = scu < 10 ? 2 : scu < 100 ? 1 : 0;
    return `${scu.toFixed(decimals)} <span class="mini">SCU</span>`;
  };
  // Insurance claim times come from the vehicle as minutes (decimal).
  // Format as "Xm YYs" for compact display.
  const fmtClaimTime = (mins) => {
    if (!mins) return null;
    const totalSec = Math.round(mins * 60);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  };
  const ins = state.currentShipConfig?.insurance;

  return `
    <div class="stats-group">
      <h4><i class="spvi-standard_control"></i> Flight Performance</h4>
      ${fs?.scmSpeed ? `<div class="stats-row"><span class="label">SCM / Boost</span><span class="value">${Math.round(fs.scmSpeed)} / ${Math.round(fs.scmBoostForward)} <span class="mini">m/s</span></span></div>` : ''}
      ${boostTime ? `<div class="stats-row" title="Continuous boost from a full thruster capacitor at the current engine pips, with no strafe or rotation input"><span class="label indent">Boost time</span><span class="value">${fmtSecs(boostTime)} <span class="mini">s</span></span></div>` : ''}
      ${boostRegen ? `<div class="stats-row" title="Refill a fully drained thruster capacitor at the current engine pips"><span class="label indent">Boost regen</span><span class="value">${fmtSecs(boostRegen)} <span class="mini">s</span></span></div>` : ''}
      ${fs?.navSpeed ? `<div class="stats-row"><span class="label">Nav</span><span class="value">${Math.round(fs.navSpeed)} <span class="mini">m/s</span></span></div>` : ''}
      ${fs?.pitch ? `
        <div class="stats-sublabel">Angular Velocity</div>
        <div class="stats-row"><span class="label indent">Pitch</span><span class="value">${Math.round(fs.pitch)}${bPitch != null ? ` / ${bPitch.toFixed(1)}` : ''} <span class="mini">°/s</span></span></div>
        <div class="stats-row"><span class="label indent">Yaw</span><span class="value">${Math.round(fs.yaw)}${bYaw != null ? ` / ${bYaw.toFixed(1)}` : ''} <span class="mini">°/s</span></span></div>
        <div class="stats-row"><span class="label indent">Roll</span><span class="value">${Math.round(fs.roll)}${bRoll != null ? ` / ${bRoll.toFixed(1)}` : ''} <span class="mini">°/s</span></span></div>
      ` : ''}
      ${fuelInfo ? `
        <h4 class="h4-sub"><i class="spvi-fuelpump"></i> Fuel</h4>
        <div class="stats-row"><span class="label">Hydrogen</span><span class="value">${fmtFuel(fuelInfo.hydrogenCapacity) || '-'}</span></div>
        <div class="stats-row"><span class="label">Quantum</span><span class="value">${fmtFuel(fuelInfo.quantumCapacity) || '-'}</span></div>
        ${qdRangeGm > 0 ? `<div class="stats-row"><span class="label indent">Range</span><span class="value">${qdRangeGm >= 100 ? Math.round(qdRangeGm) : qdRangeGm.toFixed(2)} <span class="mini">Gm</span></span></div>` : ''}
      ` : ''}
      ${ins && (ins.standardClaimMins > 0 || ins.expeditedCost > 0) ? `
        <h4 class="h4-sub"><i class="spvi-insurance"></i> Insurance</h4>
        <div class="stats-row"><span class="label">Claim / Expedite</span><span class="value">${fmtClaimTime(ins.standardClaimMins) || '-'} → ${fmtClaimTime(ins.expeditedClaimMins) || '-'}</span></div>
        ${ins.expeditedCost > 0 ? `<div class="stats-row"><span class="label">Expedite cost</span><span class="value">${fmtStat(ins.expeditedCost)} <span class="mini">aUEC</span></span></div>` : ''}
      ` : ''}
    </div>`;
}

export function renderStats() {
  const stats = calculateStats(state.currentLoadout, state.currentDisabledPorts);
  const combat = calcCombatStats();
  const pipMount = document.getElementById('loPipMount');
  const bannerMount = document.getElementById('loStatsBanner');
  if (!pipMount || !bannerMount) return;

  computeAndSetSignatures(stats);

  const pipHtml = renderPipPanel();

  // Engine channel for boost pip scaling
  const engineCh = state.currentPipAllocation?.channels.find(c => c.key === 'engine');

  // Weapon power draw vs capacitor
  const wpnCh = state.currentPipAllocation?.channels.find(c => c.key === 'weapons');
  const wpnDraw = wpnCh?.allocated > 0 ? (wpnCh?.needed ?? 0) : 0;
  const wpnCap = wpnCh?.max ?? 0;

  const shieldData = computeShieldData(stats);
  const cargoData = computeCargoData();
  const qdRangeGm = computeQdRange();
  const flightData = computeFlightStats(engineCh);

  restructurePipCard(pipMount, pipHtml);

  // ── Ship stats banner: collapsed grouped cells + toolbar + expanded overlay ──
  const shipName = state.currentShipName || '';
  const fmtModPct = (m) => {
    // Damage / sig / penetration modifier: 1.0 = neutral, <1 good, >1 bad.
    // <1  = green (less damage / signature / penetration - good for the owner)
    // >1  = red   (more damage taken - bad)
    // == 1 = default white (no effect)
    // Green/red matches the collapsed banner strip and the mitigation table in
    // the Deflection Calculator so the whole app reads the same way for
    // "good vs bad for the owner".
    const pct = Math.round((m - 1) * 100);
    const sign = pct > 0 ? '+' : '';
    const cls = pct < 0 ? 'green' : pct > 0 ? 'red' : '';
    return `<span class="value${cls ? ' ' + cls : ''}">${sign}${pct}<span class="mini">%</span></span>`;
  };
  const bannerExpanded = _bannerExpanded;
  const dpsMode = state.dpsMode === 'sustained' ? 'sust' : 'burst';
  const shieldRegenTxt = shieldData.scaledShieldRegen > 0 ? `${thouSep(shieldData.scaledShieldRegen)}` : '0';
  const armor = state.currentShipConfig?.armor;
  const hull = state.currentShipConfig?.hull;

  // Tooltip map for every abbreviation rendered in the collapsed banner.
  // Applied as `data-tip="…"` on the <span> containing the abbreviation so
  // hovering any tight label reveals the full term without cluttering
  // the row with explanatory text.
  const ABBR = {
    DPS: 'Damage per second',
    HP: 'Hit points',
    DMG: 'Damage',
    'm/s': 'Meters per second',
    '°/s': 'Degrees per second',
    SCU: 'Standard Cargo Unit',
    Pilot: 'Pilot weapons',
    Turret: 'Turret weapons',
    Missile: 'Total missile damage',
    Bomb: 'Total bomb damage',
    Shield: 'Shield HP (powered only)',
    Ballistic: 'Ballistic resistance',
    Energy: 'Energy resistance',
    Distortion: 'Distortion resistance',
    Armor: 'Armor durability HP',
    Deflection: 'Damage below this threshold is fully blocked',
    'Physical dur': 'Physical durability modifier',
    'Energy dur': 'Energy durability modifier',
    Hull: 'Total hull HP',
    Mass: 'Ship mass',
    Cargo: 'Cargo capacity',
    Storage: 'Personal storage',
    'SCM/Boost': 'SCM / boost speed',
    Nav: 'Navigation speed',
    'P/Y/R': 'Pitch / Yaw / Roll',
    Boosted: 'P/Y/R at full engine pips'
  };
  const tt = (key) => ABBR[key] ? ` data-tip="${ABBR[key].replace(/"/g, '&quot;')}"` : '';

  // Collapsed cells: 5 cells - Offense / Shield / Armor / Hull / Flight.
  // Row layout is label-first: the category word (Pilot, Shield, Deflection)
  // sits on the left in muted text, and the value (+ unit) is right-
  // aligned in the cell. Cells top-align, no wrap.

  // ── Helper: build a row with label left, value group right ──
  // Accepts either a pre-built valueHtml string or separate val+unit.
  function row(label, valueHtml, opts = {}) {
    const dim = opts.dim ? ' dim' : '';
    const labelTitle = tt(label);
    return `<div class="g-row"><span class="g-label${dim}"${labelTitle}>${label}</span><span class="g-val-wrap">${valueHtml}</span></div>`;
  }
  function val(value, unit, cls = '') {
    const valCls = cls ? ` ${cls}` : '';
    const unitHtml = unit ? `<span class="g-unit"${tt(unit)}>${unit}</span>` : '';
    return `<span class="g-val${valCls}">${value}</span>${unitHtml}`;
  }

  const cells = [
    buildOffenseCell(combat, row, val),
    buildShieldCell(shieldData, stats, row, val),
    buildArmorCell(armor, row, val),
    buildHullCell(hull, cargoData, row, val),
    buildFlightCell(flightData, row, val),
  ].filter(Boolean);

  const hullColHtml = buildHullColHtml(hull, cargoData, fmtModPct);
  const weaponryColHtml = buildWeaponryColHtml(combat, shieldData, stats, armor, fmtModPct, dpsMode);
  const flightColHtml = buildFlightColHtml(flightData, qdRangeGm);

  bannerMount.innerHTML = `
    <div class="ship-stats-banner${bannerExpanded ? ' expanded' : ''}" id="statsBanner">
      <div class="stats-banner-header">
        <h3><i class="spvi-standard_control"></i> Ship Details</h3>
        <button class="stats-tag-btn" data-stats-toggle="1" data-tip="Toggle detailed stats">
          Details <span class="chevron">▼</span>
        </button>
      </div>
      <div class="stats-collapsed">
        ${cells.join('<div class="stats-sep"></div>')}
      </div>
      <div class="stats-expanded">
        <div class="stats-grid-3col">
          ${hullColHtml}
          ${weaponryColHtml}
          ${flightColHtml}
        </div>
      </div>
    </div>
  `;

  // Details toggle - drops the 3-col overlay down from the banner
  const bannerEl = bannerMount.querySelector('.ship-stats-banner');
  const expandBtn = bannerMount.querySelector('[data-stats-toggle]');
  if (expandBtn && bannerEl) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _bannerExpanded = !_bannerExpanded;
      bannerEl.classList.toggle('expanded', _bannerExpanded);
    });
  }

  // Install global click-outside + ESC-to-close listeners exactly once.
  if (!_bannerGlobalListenersInstalled) {
    document.addEventListener('click', (e) => {
      if (!_bannerExpanded) return;
      const banner = document.getElementById('statsBanner');
      if (banner && !banner.contains(e.target)) {
        _bannerExpanded = false;
        banner.classList.remove('expanded');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _bannerExpanded) {
        _bannerExpanded = false;
        const banner = document.getElementById('statsBanner');
        if (banner) banner.classList.remove('expanded');
      }
    });
    _bannerGlobalListenersInstalled = true;
  }

  injectWeaponCapBadge(wpnDraw, wpnCap);
}
export function injectWeaponCapBadge(wpnDraw, wpnCap) {
  // Find the WEAPONS section header (scan all since other sections have h3 too)
  const allHeaders = document.querySelectorAll('.lo-section-header h3');
  let weaponHeader = null;
  for (const h of allHeaders) {
    if (h.textContent.includes('WEAPONS')) { weaponHeader = h; break; }
  }
  if (!weaponHeader) return;
  const headerEl = weaponHeader.parentElement;

  // Clear previous injections
  headerEl.querySelectorAll('.lo-weapon-power, .lo-weapon-dpsmode').forEach(el => el.remove());

  const wpnCh = state.currentPipAllocation?.channels?.find(c => c.key === 'weapons');
  if (wpnDraw == null) {
    wpnDraw = wpnCh?.allocated > 0 ? (wpnCh?.needed ?? 0) : 0;
    wpnCap = wpnCh?.max ?? 0;
  }
  const allocated = wpnCh?.allocated || 0;
  const needed = wpnCh?.needed || 0;
  const off = allocated === 0;
  const pct = off ? 0 : (needed > 0 ? Math.min(1, allocated / needed) * 100 : 100);
  const pctRound = Math.round(pct);
  const st = off ? 'off' : (pct >= 100 ? 'full' : 'partial');

  // Power efficiency bar
  const wrap = document.createElement('span');
  wrap.className = `lo-weapon-power ${st}`;
  const neededFmt = needed % 1 ? needed.toFixed(1) : needed;
  wrap.dataset.tip = `Weapon power: ${neededFmt} needed / ${allocated} assigned`;
  wrap.innerHTML = `<span class="lo-wpn-bar"><span class="lo-wpn-bar-fill" style="width:${pct}%"></span></span><span class="lo-header-stat">${pctRound} %</span>`;

  // Burst / Sustained DPS-mode toggle - moved from Display Settings into the
  // Weapons header so the weapon column's DPS numbers have an adjacent control.
  const dpsToggle = document.createElement('span');
  dpsToggle.className = 'lo-weapon-dpsmode';
  dpsToggle.innerHTML = `
    <button type="button" class="lo-dpsmode-btn${state.dpsMode === 'burst' ? ' active' : ''}" data-mode="burst" data-tip="Burst DPS">Burst</button>
    <button type="button" class="lo-dpsmode-btn${state.dpsMode === 'sustained' ? ' active' : ''}" data-mode="sustained" data-tip="Sustained DPS">Sust</button>
  `;
  dpsToggle.querySelectorAll('.lo-dpsmode-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.setDpsMode(btn.dataset.mode);
      localStorage.setItem('sc-dps-mode', state.dpsMode);
      renderStats();
      if (_renderWeaponColumn) _renderWeaponColumn();
    });
  });

  const resetBtn = headerEl.querySelector('.lo-reset');
  if (resetBtn) {
    resetBtn.insertAdjacentElement('beforebegin', wrap);
    resetBtn.insertAdjacentElement('beforebegin', dpsToggle);
  } else {
    headerEl.appendChild(wrap);
    headerEl.appendChild(dpsToggle);
  }
}

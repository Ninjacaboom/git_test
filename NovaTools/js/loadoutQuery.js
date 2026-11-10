/**
 * loadoutQuery.js - pure data-query helpers for opponent/loadout lookups.
 *
 * Extracted from ttkCalcUI.js. No DOM access - pure queries over state.allItems,
 * state.allHardpoints, state.allVehicles.
 */
import * as state from './loadoutState.js';
import { isCompatible } from './loadoutManager.js';

/** Total power a power plant generates - sum of the Power-resource Generation
 *  segments across its resource network. Used to order the PP dropdown. */
function powerPlantOutput(si) {
  let power = 0;
  for (const node of (si?.ResourceNetwork || [])) {
    for (const gen of (node.Generation || [])) {
      if (gen.Resource === 'Power') power += gen.Segment || 0;
    }
  }
  return power;
}

/**
 * Equippable shields. When `port` is provided (the opponent's shield port from
 * its hardpoints tree), filters by size/tag compatibility - same rule the
 * loadout-manager picker uses, so an Arrow only sees S1 shields it could
 * actually mount. When `port` is null, returns every shield (legacy fallback).
 *
 * Sort order: by default sorts by HP descending (strongest first). Pass
 * `sortBySize: true` to sort by size ascending instead (used by the
 * deflection calculator, which groups by size rather than strength).
 */
export function listShieldItems(port = null, { sortBySize = false } = {}) {
  const shields = [];
  for (const it of state.allItems || []) {
    if (it.type !== 'Shield') continue;
    if (it.cosmeticVariantOf) continue;
    const si = it.stdItem;
    if (!si?.Shield?.Health) continue;
    if (port && !isCompatible(it, port)) continue;
    shields.push({
      className: it.className,
      name: si.Name || it.className,
      size: si.Size || it.size || 0,
      hp: si.Shield.Health,
      cls: si.Class || '',
      grade: si.Grade ?? null,
    });
  }
  if (sortBySize) {
    shields.sort((a, b) => (a.size - b.size) || a.name.localeCompare(b.name));
  } else {
    // Order by shield HP descending (strongest first); equal-HP shields (e.g. all
    // the military S2s) break by grade A->D, then name.
    shields.sort((a, b) =>
      (b.hp - a.hp)
      || ((a.grade ?? 99) - (b.grade ?? 99))
      || a.name.localeCompare(b.name));
  }
  return shields;
}

/**
 * Equippable power plants. Same opponent-port filtering as listShieldItems -
 * an S1-fighter PP slot won't list S4/S5 capital-ship plants. Test/edge stubs
 * (e.g. satellite_power_plant_test, Health ~1) are filtered separately by the
 * < 10 HP guard.
 */
export function listPowerPlants(port = null) {
  const plants = [];
  for (const it of state.allItems || []) {
    if (it.type !== 'PowerPlant') continue;
    if (it.cosmeticVariantOf) continue;
    const si = it.stdItem;
    const hp = si?.Durability?.Health || 0;
    if (hp < 10) continue; // skip 1-HP test items
    if (port && !isCompatible(it, port)) continue;
    plants.push({
      className: it.className,
      name: si.Name || it.className,
      size: si.Size || it.size || 0,
      hp,
      distortionMax: si?.Durability?.Distortion?.MaximumDamage || 0,
      cls: si.Class || '',
      grade: si.Grade ?? null,
      power: powerPlantOutput(si),
    });
  }
  // Order by power output descending (strongest first); equal-power plants break
  // by grade A->D, then name. Mirrors the shield dropdown.
  plants.sort((a, b) =>
    (b.power - a.power)
    || ((a.grade ?? 99) - (b.grade ?? 99))
    || a.name.localeCompare(b.name));
  return plants;
}

/**
 * Find the className of the first installed item of a given equipment `type`
 * anywhere under a hardpoints tree. CIG nests components inconsistently: a
 * fighter's shield sits directly at Components.Systems.Shields.InstalledItems,
 * but its power plant lives at Components.Systems.Controllers[0].['Power Plants']
 * .InstalledItems. Rather than hard-code every spelling, walk the tree and match
 * each InstalledItem's BaseLoadout.ClassName against an item of the wanted type.
 */
export function findInstalledByType(hardpoints, wantType) {
  const byClass = new Map((state.allItems || []).map(it => [it.className, it.type]));
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const cn = node?.BaseLoadout?.ClassName;
    if (cn && byClass.get(cn) === wantType) { found = cn; return; }
    for (const k of Object.keys(node)) {
      if (k === 'BaseLoadout') continue;
      walk(node[k]);
    }
  })(hardpoints);
  return found;
}

/**
 * Count installed items of a given equipment `type` anywhere under a
 * hardpoints tree (same tree-walk as findInstalledByType). Used to sum the
 * power-plant pool across all generators - a ship with 3 power plants needs
 * all 3 destroyed / overloaded to go offline, so its effective HP and
 * distortion pools are 3x a single unit.
 */
export function countInstalledByType(hardpoints, wantType) {
  const byClass = new Map((state.allItems || []).map(it => [it.className, it.type]));
  let count = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const cn = node?.BaseLoadout?.ClassName;
    if (cn && byClass.get(cn) === wantType) count++;
    for (const k of Object.keys(node)) {
      if (k === 'BaseLoadout') continue;
      walk(node[k]);
    }
  })(hardpoints);
  return count;
}

/**
 * Find the first port node whose `Types` array includes `wantType` (e.g.
 * 'Shield', 'PowerPlant'). Returns the node itself (carrying MinSize/MaxSize/
 * Types/PortTags/RequiredTags) so isCompatible() can filter equippable items
 * against the opponent's slot.
 *
 * Returns null when no such port exists - which means we can't constrain the
 * pick (capital ships have shields scattered across multiple ports, but for
 * our v1 opponent picker the first one is representative).
 */
export function findPortByType(hardpoints, wantType) {
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (Array.isArray(node.Types) && node.Types.includes(wantType)) {
      found = node; return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(hardpoints);
  return found;
}

/** Resolve a vehicle config + default installed shield/PP for a chosen ship. */
export function lookupOpponentShip(name) {
  const hp = state.allHardpoints.find(h => h.Name === name);
  const vehicle = state.allVehicles.find(v => v.Name === name);
  const ship = { ...(vehicle || {}), Hardpoints: hp?.Hardpoints };
  const shieldSlots = hp?.Hardpoints?.Components?.Systems?.Shields?.InstalledItems || [];
  return {
    ship,
    shieldCount: Math.max(1, shieldSlots.length),
    defaultShieldCn: shieldSlots[0]?.BaseLoadout?.ClassName
      || findInstalledByType(hp?.Hardpoints, 'Shield'),
    defaultPpCn: findInstalledByType(hp?.Hardpoints, 'PowerPlant'),
    // All power plants must be downed to disable the ship - the pools sum.
    ppCount: Math.max(1, countInstalledByType(hp?.Hardpoints, 'PowerPlant')),
    // Port specs the picker filters against. shieldSlots[0] is the standard
    // path; PP lives deeper and has to be walked.
    shieldPort: shieldSlots[0] || findPortByType(hp?.Hardpoints, 'Shield'),
    ppPort: findPortByType(hp?.Hardpoints, 'PowerPlant'),
  };
}

/**
 * Default power-plant reach (metres) by opponent hull size. Bigger ships bury
 * the power plant deeper, so a round needs more penetration to reach it. The
 * user can still override the value per opponent. Size 0 / unknown disables the
 * gate (returns 0) so we never gate a ship whose size we can't read.
 */
export function ppReachForSize(size) {
  const s = Math.round(Number(size) || 0);
  if (s <= 0) return 0;
  if (s === 1) return 0.2;
  if (s === 2) return 0.4;
  if (s === 3) return 1;
  if (s === 4) return 2.5;
  if (s === 5) return 5;
  return 8; // size 6+
}

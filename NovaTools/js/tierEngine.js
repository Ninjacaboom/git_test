import { DEFLECTION_BANDS, DEFLECTION_NO_TIER } from './config.js';

export function categorize(type) {
  if (/ballistic|mass\s*driver/i.test(type)) return 'Ballistic';
  if (/laser|plasma|tachyon|neutron/i.test(type)) return 'Energy';
  if (/distortion/i.test(type)) return 'Distortion';
  return 'Other';
}

/** Key of the top band - the tier at which no ship is immune. */
export const TOP_TIER = DEFLECTION_BANDS[DEFLECTION_BANDS.length - 1].key;
const TIER_ORDER = [DEFLECTION_NO_TIER.key, ...DEFLECTION_BANDS.map(b => b.key)];

/**
 * Lowest tier that still out-damages every fighter-class hull. Used by the
 * deflection tool to decide between a "partial" and a "warn" banner - the old
 * three-tier code drew that line at "all fighters defeated" and this keeps it
 * in the same place.
 */
export const CLEARS_FIGHTERS_TIER = 'hf';

/** Meta (label, badge) for every tier key including 'none'. */
export const TIER_META = new Map(
  [DEFLECTION_NO_TIER, ...DEFLECTION_BANDS].map(b => [b.key, { label: b.label, badge: b.badge }])
);

/**
 * Position of a tier key on the ladder - 0 for 'none' up to 7 for the top
 * band. Unknown keys return -1 so callers can treat them as "worse than
 * anything". Lets UI code compare tiers without hardcoding key names.
 */
export function tierRank(key) {
  return TIER_ORDER.indexOf(key);
}

// Get the effective damage value for deflection comparison.
// For multi-pellet weapons (scatterguns), use per-pellet damage.
// For beam weapons (no alpha), use sustained DPS.
// For everything else, use alpha.
function getDeflectionDamage(w) {
  if (w.PerPellet != null) return w.PerPellet;
  if (w.Alpha != null && w.Alpha > 0) return w.Alpha;
  return w.Sustained;
}

/**
 * Build the deflection ladder from live ship data: for every band in
 * DEFLECTION_BANDS, the physical and energy deflection a weapon must meet to
 * clear it. Ceilings are running maxima, so the ladder never steps backwards
 * even where the anchor ships disagree between damage types (Hammerhead tops
 * physical, Reclaimer tops energy).
 *
 * A band whose ceiling matches the band below it is unreachable for that
 * damage type - the higher band wins in tierForDamage. That is a data fact
 * (two bands genuinely equally tough), not an error.
 */
export function computeDeflectionLadder(ships) {
  const list = ships || [];
  const byName = new Map();
  for (const s of list) {
    if (s && s.Name && !byName.has(s.Name)) byName.set(s.Name, s);
  }

  const globalPhys = Math.max(0, ...list.map(s => s['Deflection physical'] || 0));
  const globalEnergy = Math.max(0, ...list.map(s => s['Deflection energy'] || 0));

  let physical = 0;
  let energy = 0;
  return DEFLECTION_BANDS.map(band => {
    if (band.anchors.length === 0) {
      // Top band: "every ship in the data", so read the global maxima rather
      // than an anchor. Survives CIG adding a hull tougher than the Idris.
      physical = Math.max(physical, globalPhys);
      energy = Math.max(energy, globalEnergy);
    } else {
      for (const name of band.anchors) {
        const ship = byName.get(name);
        if (!ship) {
          // Renamed or removed anchor. Leaving the ceiling at the band below
          // makes this band unreachable rather than silently too easy.
          console.warn(`tierEngine: deflection anchor "${name}" not found in ship data`);
          continue;
        }
        physical = Math.max(physical, ship['Deflection physical'] || 0);
        energy = Math.max(energy, ship['Deflection energy'] || 0);
      }
    }
    return { key: band.key, label: band.label, badge: band.badge, physical, energy };
  });
}

/**
 * Highest band a weapon clears, given a prebuilt ladder. Distortion and
 * non-damage categories bypass deflection entirely and always sit at the top.
 */
function tierForDamage(dmg, category, ladder) {
  if (category === 'Distortion' || category === 'Other') return TOP_TIER;
  if (dmg == null || isNaN(dmg)) return DEFLECTION_NO_TIER.key;

  const key = category === 'Ballistic' ? 'physical' : 'energy';
  let tier = DEFLECTION_NO_TIER.key;
  for (const band of ladder) {
    if (dmg < band[key]) break;
    tier = band.key;
  }
  return tier;
}

export function computeTiers(weapons, ships) {
  const ladder = computeDeflectionLadder(ships);

  weapons.forEach(w => {
    w._category = categorize(w.Type);
    w._tier = tierForDamage(getDeflectionDamage(w), w._category, ladder);
  });
}

export function getImmuneShips(weapon, ships) {
  const cat = weapon._category;
  const dmg = getDeflectionDamage(weapon);

  if (cat === 'Distortion' || cat === 'Other') {
    return { immune: [], bypass: true };
  }

  const key = cat === 'Ballistic' ? 'Deflection physical' : 'Deflection energy';
  const immune = ships.filter(s => {
    const def = s[key];
    return def != null && !isNaN(def) && dmg != null && !isNaN(dmg) && dmg < def;
  });

  // Toughest first, on the deflection that actually applies to this weapon -
  // physical for ballistic, energy for everything else. Ties fall back to name
  // so the order is stable across renders. filter() already gave us a fresh
  // array, so this never reorders the caller's roster.
  immune.sort((a, b) =>
    (Number(b[key]) || 0) - (Number(a[key]) || 0) ||
    String(a.Name || '').localeCompare(String(b.Name || ''))
  );

  return { immune, bypass: false };
}

// The ladder only changes when the ship roster does, but deriveTier runs once
// per crafted weapon port on every re-render. Cache on the ships array
// identity - callers always pass the same state.allShips reference.
let _ladderShips = null;
let _ladderCache = null;

/**
 * Derive a single tier key from a weapon's effective damage vs the supplied
 * ship list. Same thresholds as computeTiers, but lets a caller re-run the
 * check for a mutated weapon record (e.g. after Impact Force crafting scales
 * alpha) without recomputing tiers for every weapon.
 */
export function deriveTier(weapon, ships) {
  if (_ladderShips !== ships) {
    _ladderShips = ships;
    _ladderCache = computeDeflectionLadder(ships);
  }
  const cat = weapon._category != null ? weapon._category : categorize(weapon.Type);
  return tierForDamage(getDeflectionDamage(weapon), cat, _ladderCache);
}

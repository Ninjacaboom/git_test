import {
  EXCLUDED_CLASS_PATTERNS,
  EXCLUDED_WEAPON_NAMES,
  EXCLUDED_SUBTYPES,
  WEAPON_TYPE_MAP
} from './config.js';
import { calcSustainedDPS, computeBurstDPS, effectiveAmmo } from './sustained.js';
import { isCompatible } from './loadoutManager.js';

/**
 * Walk a ship's Hardpoints tree and collect every port whose `Types` array
 * contains a weapon-mount classification. Ship-level `PortTags` are merged
 * into each port's `PortTags` (same convention as `flattenPort` in
 * loadoutManager) so that an item's `requiredTags` like `RSI_Meteor` is
 * satisfied by the Meteor's ship-level tag and not just per-port tags.
 *
 * The "weapon-mount" predicate is broad on purpose: gun ports nested inside
 * turret/mount layers (`Turret.GunTurret`, `TurretBase.MannedTurret`,
 * `MissileLauncher.MissileRack`) are walked but only the leaf-level
 * `WeaponGun.*` ports are returned, since those are what physical guns slot
 * into. The intermediate turret/mount slots accept turret/mount items, not
 * the weapons themselves.
 */
function collectWeaponPorts(node, shipTags, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectWeaponPorts(x, shipTags, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const types = node.Types;
  if (Array.isArray(types) && types.some(t => typeof t === 'string' && t.startsWith('WeaponGun'))) {
    out.push({
      Types: types,
      MinSize: node.MinSize,
      MaxSize: node.MaxSize,
      RequiredTags: node.RequiredTags,
      PortTags: [...(node.PortTags || []), ...shipTags],
      Tags: node.Tags,
    });
  }

  for (const k of Object.keys(node)) {
    if (k === 'Hull') continue;
    collectWeaponPorts(node[k], shipTags, out);
  }
}

/**
 * Compute the set of weapon classNames that no port on any ship can accept.
 * These are orphan items - present in `vehicle_equipment.json` but with no
 * physical home in the game. CIG ships future / dev / cut weapons in the
 * data routinely; this filter keeps the deflection picker honest by reusing
 * Loadout Manager's `isCompatible` as ground truth.
 *
 * Sold-in-shop exception: if `item.sold === 1` (set by mergeSoldStatus from
 * CStone's GetSWeapons feed) the item is shipped for sale somewhere, so it's
 * player-purchasable even when the data has no host port yet - typical of
 * S6 BEHR/Attrition/Omnisky/Deadbolt/etc. that CIG sells ahead of bigger
 * ships releasing. Keep these out of the orphan set so the deflection page
 * still shows them.
 *
 * Returns an empty Set if `hardpoints` is empty/missing - fail-open so the
 * page still renders something if the data isn't available yet.
 */
function findOrphanWeapons(items, hardpoints) {
  const orphans = new Set();
  if (!Array.isArray(hardpoints) || hardpoints.length === 0) return orphans;

  // Pre-flatten every ship's weapon-bearing ports once.
  const allPorts = [];
  for (const ship of hardpoints) {
    const shipTags = ship.PortTags || [];
    collectWeaponPorts(ship.Hardpoints, shipTags, allPorts);
  }
  if (allPorts.length === 0) return orphans;

  for (const item of items) {
    if (item.type !== 'WeaponGun') continue;
    if (item.sold === 1) continue;  // shop-purchasable → never orphan
    let fits = false;
    for (const port of allPorts) {
      if (isCompatible(item, port)) { fits = true; break; }
    }
    if (!fits) orphans.add(item.className);
  }
  return orphans;
}

function prefixByDamage(damagePerShot, weaponClass) {
  if (damagePerShot) {
    if (damagePerShot.Physical) return 'Ballistic ' + weaponClass;
    if (damagePerShot.Energy) return 'Laser ' + weaponClass;
    if (damagePerShot.Distortion) return 'Distortion ' + weaponClass;
  }
  return weaponClass;
}

function deriveType(className, tags, damagePerShot, weaponName) {
  const tagList = (tags || '').split(/\s+/);

  // Check className first (most reliable source)
  for (const [key, value] of Object.entries(WEAPON_TYPE_MAP)) {
    if (className.includes(key)) return value;
  }

  // Check tags for known weapon type keywords
  for (const tag of tagList) {
    if (WEAPON_TYPE_MAP[tag]) return WEAPON_TYPE_MAP[tag];
  }

  // Check compound tags (e.g., "BANU_TachyonCannon", "ANVL_BallisticGatling_Bespoke")
  for (const tag of tagList) {
    for (const [key, value] of Object.entries(WEAPON_TYPE_MAP)) {
      if (tag.includes(key)) return value;
    }
  }

  // Last resort: infer from className/weaponName patterns
  const isScattergun = /ScatterGun|Scattergun/i.test(className) || (weaponName && /Scattergun/i.test(weaponName));
  if (isScattergun) return prefixByDamage(damagePerShot, 'Scattergun');

  // FOOT-GUN: these bare fallbacks carry no damage prefix, so
  // tierEngine.categorize() would classify them as 'Other' → bypass tier
  // (no deflection dot). No current Live item reaches this path (the
  // WEAPON_TYPE_MAP / tag checks above catch everything as of 4.8.3), but a
  // future item that lands here should probably use prefixByDamage like the
  // scattergun branch. See TODOS.md.
  if (/Cannon/i.test(className)) return 'Cannon';
  if (/Repeater/i.test(className)) return 'Repeater';
  if (/Gatling/i.test(className)) return 'Gatling';
  if (/Beam/i.test(className)) return 'Beam';

  if (weaponName) {
    if (/Cannon/i.test(weaponName)) return 'Cannon';
    if (/Repeater/i.test(weaponName)) return 'Repeater';
    if (/Gatling/i.test(weaponName)) return 'Gatling';
  }

  // Final fallback: infer from damage type
  if (damagePerShot) {
    if (damagePerShot.Physical) return 'Ballistic Cannon';
    if (damagePerShot.Energy) return 'Laser Cannon';
    if (damagePerShot.Distortion) return 'Distortion Cannon';
  }

  return 'Unknown';
}

// Counts all damage types including FPS-only (Thermal/Biochemical/Stun).
// sustained.js's sumShipDamage intentionally omits those three types.
function sumDamage(dmgObj) {
  if (!dmgObj) return 0;
  return (dmgObj.Physical || 0) + (dmgObj.Energy || 0) + (dmgObj.Distortion || 0)
    + (dmgObj.Thermal || 0) + (dmgObj.Biochemical || 0) + (dmgObj.Stun || 0);
}

function isExcludedClass(className) {
  return EXCLUDED_CLASS_PATTERNS.some(p => p.test(className));
}

const VEHICLE_INDICATORS = [
  { pattern: /\$TMBL_Nova|_Nova_/i, label: 'Tumbril Nova' },
  { pattern: /TMBL_Storm|_Storm_/i, label: 'Tumbril Storm' },
  { pattern: /_ATLS/i, label: 'ATLS' }
];

function getVehicleLabel(className, tags) {
  const combined = className + ' ' + tags;
  for (const { pattern, label } of VEHICLE_INDICATORS) {
    if (pattern.test(combined)) return label;
  }
  return null;
}

// Ship-specific or variant suffixes that indicate a bespoke/alternate mount
const VARIANT_SUFFIXES = [
  /_SecurityNetwork/i,
  /_fps_balance/i,
  /_ATLS/i,
  /_Collector/i,
  /_Idris/i,
  /^Bengal_/i,             // Bengal carrier specific weapons
  /_Bengal/i,
  /_Cutlass/i,
  /Javelin.*Cannon/i,
  /_Turret/i,              // Turret-mounted variants (anywhere in name)
  /_PDC_/i,
  /BANU_EnergyRepeater/i,  // Placeholder item with 0 stats
  /_TSG/i                  // CIG-internal destructible-state/placeholder twins
                           // (e.g. Vanduul_LaserBeam_S12_TSG, a 200K-DPS
                           // dev-placeholder twin of HRST_LaserBeam_Bespoke
                           // - both share the localized name "Exodus-10
                           // Laser Beam" and Idris-Nose RequiredTags)
];

function isVariant(className) {
  return VARIANT_SUFFIXES.some(p => p.test(className));
}

export function parseWeapons(items, hardpoints = []) {
  // Compute orphan weapons - items that no port on any ship can accept.
  // Catches CIG dev/future/cut weapons left in the data (e.g. NONE_LaserRepeater
  // "Ardor Salvaged" placeholders, BEHR_LaserCannon_S8/S9/S12 capital-class
  // M9A entries with no S8+ ports anywhere, PRAR distortion scatterguns
  // S4-S6 with no Banu-Defender-style host) without a hand-curated blocklist.
  const orphans = findOrphanWeapons(items, hardpoints);

  const guns = items.filter(item => {
    if (item.type !== 'WeaponGun') return false;
    if (EXCLUDED_SUBTYPES.has(item.subType)) return false;
    if (isExcludedClass(item.className || '')) return false;
    // Hide cosmetic-variant weapons (paint-only twins) from the Weapon
    // Deflection picker too - same rule as the in-configurator picker.
    // `cosmeticVariantOf` carries the base item's className (truthy = is cosmetic).
    if (item.cosmeticVariantOf) return false;
    if (orphans.has(item.className)) return false;
    return true;
  });

  const weapons = [];

  for (const item of guns) {
    const si = item.stdItem;
    if (!si) continue;

    const rawName = si.Name || item.itemName || '';
    if (!rawName) continue;
    // Items shipped without a localised name (`stdItem.Name === className`) are
    // CIG dev/placeholder records - APAR_BallisticScatterGun_S6, BRRA's
    // automated turret, the three VNCL Gen2 placeholders, etc. Skip them
    // entirely; they don't belong in the deflection picker even with the
    // underscores humanised, since they all lack proper UI strings and are
    // not player-mountable.
    if (rawName === item.className) continue;
    const name = rawName;
    if (EXCLUDED_WEAPON_NAMES.has(name)) continue;

    const weapon = si.Weapon;
    if (!weapon) continue;

    const ammo = weapon.Ammunition || {};
    const firing = weapon.Firing?.[0] || {};

    const dps = firing.DamagePerShot || {};

    const alpha = sumDamage(dps);
    // computeBurstDPS prefers `BurstRoundsPerMinute` (inner-burst rate)
    // over `DamagePerSecond` (sustained avg) when the extractor emits
    // it, so Erkul-style burst DPS shows up for 3-shot bursts etc.
    const burstDPS = computeBurstDPS(firing);
    const rpm = firing.RoundsPerMinute || 0;

    const type = deriveType(item.className || '', item.tags || '', dps, name);

    // Sustained (60s) DPS - accounts for heat/ammo/regen cycles
    const consumption = weapon.Consumption || null;
    const sustained60 = calcSustainedDPS(weapon, consumption);

    // For multi-pellet weapons (scatterguns), per-pellet damage drives the
    // deflection math. Derive it from `alpha / PelletsPerShot` rather than
    // reading `Ammunition.ImpactDamage` directly - CIG's data is occasionally
    // inconsistent (e.g. PRAR_DistortionScatterGun_S4 has DamagePerShot
    // {Distortion: 480} with PelletsPerShot 8, but ImpactDamage {Energy: 0.0001},
    // which would round to 0 per pellet). On well-formed weapons the two
    // sources agree (DamagePerShot = ImpactDamage × pellets), so this only
    // changes behaviour where CIG's ImpactDamage is junk.
    const pellets = firing.PelletsPerShot || 1;
    const perPellet = pellets > 1 ? alpha / pellets : null;

    const vehicleLabel = getVehicleLabel(item.className || '', item.tags || '');

    // Rounds before a forced pause. For magazine-fed (ballistic) guns the
    // heat model can report more rounds than the gun carries - including the
    // 999999 "never overheats" sentinel (e.g. C-788: cooling outpaces
    // HeatPerShot) - so clamp the display value to the magazine. Energy
    // weapons (Consumption.MaxAmmo pool) are untouched: their Capacity field
    // is unrelated to the regenerating pool.
    let ammoEffective = effectiveAmmo(weapon, consumption) || null;
    if (ammoEffective != null && !consumption?.MaxAmmo && ammo.Capacity) {
      ammoEffective = Math.min(ammoEffective, Math.floor(ammo.Capacity));
    }

    weapons.push({
      Size: item.size || 0,
      Name: name,
      Vehicle: vehicleLabel,
      Manufacturer: si.Manufacturer?.Name || '',
      Type: type,
      Sustained: sustained60 || null,
      Burst: burstDPS || null,
      Alpha: alpha || null,
      Pellets: pellets > 1 ? pellets : null,
      PerPellet: perPellet,
      AlphaPhys: dps.Physical || 0,
      AlphaEnergy: dps.Energy || 0,
      AlphaDistortion: dps.Distortion || 0,
      RPM: rpm || null,
      Speed: ammo.Speed || null,
      Range: ammo.Range || null,
      PenDist: ammo.Penetration?.BasePenetrationDistance ?? null,
      AmmoCapacity: ammo.Capacity || null,
      AmmoMax: consumption?.MaxAmmo || null,
      AmmoEffective: ammoEffective,
      IsEnergy: !!consumption?.MaxAmmo,
      IsCharged: firing.FireType === 'charged',
      Health: si.Durability?.Health || null,
      sold: item.sold ?? null,
      _className: item.className || ''
    });
  }

  // Deduplicate: group by Name+Size, prefer non-variant (generic) items.
  // For items with the same Name+Size, keep the generic version.
  // If all are variants or all are generic, keep the one with highest sustained DPS.
  const groups = new Map();
  for (const w of weapons) {
    const key = `${w.Name}||${w.Size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }

  const deduped = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    // Prefer non-variant items
    const generic = group.filter(w => !isVariant(w._className));
    if (generic.length >= 1) {
      // Among generic items, pick highest sustained DPS
      generic.sort((a, b) => (b.Sustained || 0) - (a.Sustained || 0));
      deduped.push(generic[0]);
    } else {
      // All are variants - pick highest sustained DPS
      group.sort((a, b) => (b.Sustained || 0) - (a.Sustained || 0));
      deduped.push(group[0]);
    }
  }

  // Merge sold status across dedup groups: if any variant is sold, mark the winner sold
  for (const [, group] of groups) {
    const winner = deduped.find(d => d._className && group.some(g => g._className === d._className));
    if (winner) {
      const anySold = group.some(g => g.sold === 1);
      const anyKnown = group.some(g => g.sold != null);
      if (anySold) winner.sold = 1;
      else if (anyKnown) winner.sold = 0;
    }
  }

  // Clean up internal field
  deduped.forEach(w => { delete w._className; });

  // Sort by sustained DPS descending
  deduped.sort((a, b) => (b.Sustained || 0) - (a.Sustained || 0));

  return deduped;
}

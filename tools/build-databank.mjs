#!/usr/bin/env node
/**
 * Builds the data bank used by the API (src/MyApp.Api/Data) from NovaSCDataExtractor output.
 *
 * Usage:
 *   node tools/build-databank.mjs "<folder with the extractor's JSON files>"
 *
 * Reads from that folder:  blueprints.json, resources.json, fps_equipment.json, vehicle_equipment.json,
 *                           missions.json (optional: used to ignore missions that are not released)
 * Writes to Data/:         resources.json, recipes.json
 * Reads from Data/:        materials.json (the hand-entered ore/mineral quality tiers)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) {
  console.error('Usage: node tools/build-databank.mjs "<extractor output folder>"');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(process.argv[2]);
const OUT = resolve(here, '..', 'src', 'MyApp.Api', 'Data');
mkdirSync(OUT, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const asArray = (x) => (Array.isArray(x) ? x : Object.values(x));

const blueprints = readJson(`${SRC}/blueprints.json`);
const resources = readJson(`${SRC}/resources.json`);
const equipment = [
  ...asArray(readJson(`${SRC}/fps_equipment.json`)),
  ...asArray(readJson(`${SRC}/vehicle_equipment.json`)),
];
const ownMaterials = readJson(`${OUT}/materials.json`);
const ownNames = new Set(ownMaterials.map((m) => m.name));
const materialByName = new Map(ownMaterials.map((m) => [m.name, m]));

// F tier materials are only offered for these recipe types (mining lasers).
// Every other recipe is limited to E tier and above.
const F_TIER_ALLOWED_TYPES = new Set(['WeaponMining']);
const tiersFor = (materialName, recipeType) => {
  const material = materialByName.get(materialName);
  if (!material) return [];
  return material.tiers.filter((t) => t.tier !== 'F' || F_TIER_ALLOWED_TYPES.has(recipeType));
};

// The game data spells a few materials differently from the tier table.
const ALIASES = {
  Aluminium: 'Aluminum',
  Quantanium: 'Quantainium',
  'Saldynium (Ore)': 'Saldynium',
};
const canonical = (name) => {
  const c = ALIASES[name] ?? name;
  return ownNames.has(c) ? c : null;
};

// ---- resources ----
const resById = Object.fromEntries(resources.map((r) => [r.GUID, r]));
const resourcesOut = resources
  .map((r) => ({
    id: r.GUID,
    name: r.Name,
    category: r.Category,
    unitType: r.UnitType, // "SCU" (mined ore) or "Units" (harvested items)
    material: canonical(r.Name), // name in materials.json, or null if it has no tier table
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ---- item lookups (weapons and ship components) ----
const itemByClass = new Map(equipment.map((e) => [e.className, e]));
const variantOf = (e) => e.stdItem?.CosmeticVariantOf ?? null;
const skinsByBase = new Map();
for (const e of equipment) {
  const base = variantOf(e);
  if (!base) continue;
  if (!skinsByBase.has(base)) skinsByBase.set(base, []);
  skinsByBase.get(base).push({ className: e.className, name: e.stdItem?.Name ?? null });
}

const manufacturerOf = (item) => {
  if (!item) return null;
  const m = item.stdItem?.Manufacturer;
  if (typeof m === 'string' && m) return m;
  return m?.Name ?? m?.Code ?? item.manufacturer ?? null;
};
const cleanText = (t) => (t ? String(t).replace(/\\n/g, '\n').trim() : null);

// ---- recipes ----
// Recipes we leave out of the store. A rule matches when every field it lists matches.
const EXCLUDED = [
  { type: 'WeaponAttachment', subType: 'Magazine' }, // weapon ammo (magazines and batteries)
  { className: 'Carryable_2H_FL_MissionItem_prototype_ship_component_2_a' }, // TH-01 Propulsor
];
const isExcluded = (b) =>
  EXCLUDED.some(
    (e) =>
      (e.type === undefined || e.type === b.TargetType) &&
      (e.subType === undefined || e.subType === b.TargetSubType) &&
      (e.className === undefined || e.className === b.TargetClassName),
  );

// Blueprints with no mission that can reward them cannot be obtained, so they are left out.
// Set to false to list every blueprint again.
const REQUIRE_MISSION_SOURCE = true;
// Missions the game marks as work-in-progress or not-for-release cannot be played, so they do not count.
const unreleasedMissions = new Set();
if (existsSync(`${SRC}/missions.json`)) {
  for (const m of readJson(`${SRC}/missions.json`)) {
    if (m.NotForRelease || m.WorkInProgress) unreleasedMissions.add(m.ClassName);
  }
} else {
  console.warn('missions.json not found: not-for-release missions are NOT being ignored');
}
const hasMissionSource = (b) =>
  Array.isArray(b.RewardSources) &&
  b.RewardSources.some((s) => s.Kind !== 'Contract' || !unreleasedMissions.has(s.MissionClassName));

const named = blueprints.filter(
  (b) => b.TargetName && !isExcluded(b) && (!REQUIRE_MISSION_SOURCE || hasMissionSource(b)),
);
for (const b of named) {
  if (b.Tiers.length !== 1) throw new Error(`Unexpected tier count on ${b.TargetName}`);
}

// Weapon numbers that the item's description text does not give: damage per hit and fire rate.
const round2 = (n) => Number(n.toFixed(2));
function weaponStats(item) {
  const w = item?.stdItem?.Weapon;
  if (!w) return [];
  const out = [];
  const impact = w.Ammunition?.ImpactDamage ?? {};
  const kinds = Object.entries(impact).filter(([, v]) => v > 0);
  const firing = (w.Firing ?? []).find((f) => f.RoundsPerMinute > 0) ?? null;
  if (kinds.length > 0) {
    const total = kinds.reduce((n, [, v]) => n + v, 0);
    const pellets = firing?.PelletsPerShot > 1 ? ` x ${firing.PelletsPerShot} pellets` : '';
    out.push({ label: 'Damage', value: `${round2(total)} ${kinds.map(([k]) => k).join('/')}${pellets}` });
  }
  if (firing) out.push({ label: 'Rate Of Fire', value: `${round2(firing.RoundsPerMinute)} rpm` });
  return out;
}

const recipes = named.map((b) => {
  const tier = b.Tiers[0];
  const item = itemByClass.get(b.TargetClassName) ?? null;
  return {
    id: b.TargetGUID,
    className: b.TargetClassName,
    name: b.TargetName,
    description: cleanText(b.TargetDescription),
    type: b.TargetType,
    subType: b.TargetSubType,
    size: b.TargetSize,
    grade: item ? item.grade : null,
    manufacturer: manufacturerOf(item),
    craftTimeSeconds: tier.CraftTimeSeconds,
    variantOf: item ? variantOf(item) : null, // className of the base item if this is a skin
    skins: [], // filled in below
    baseStats: weaponStats(item),
    slots: tier.Slots.map((s) => ({
      name: s.Name,
      displayName: s.DisplayName,
      // Qualities this slot's material can be used at (F tier left out except for mining lasers).
      tiers: tiersFor(s.Costs[0] ? canonical(resById[s.Costs[0].GUID].Name) : null, b.TargetType),
      costs: s.Costs.map((c) => {
        const r = resById[c.GUID];
        if (!r) throw new Error(`Cost GUID ${c.GUID} not found in resources (${b.TargetName})`);
        return {
          resourceId: c.GUID,
          material: canonical(r.Name) ?? r.Name,
          unitType: r.UnitType,
          quantity: c.Quantity,
        };
      }),
      modifiers: s.Modifiers.map((m) => ({
        stat: m.PropertyName,
        kind: m.Kind,
        qualityMin: m.QualityRange[0],
        qualityMax: m.QualityRange[1],
        valueMin: m.ModifierRange[0],
        valueMax: m.ModifierRange[1],
      })),
    })),
  };
});

// Armour Damage Mitigation always runs from -15% at 0 quality to +15% at 1000 (0% at 500). The extractor gives
// the third material of most 3-material armours no stat effect, so that material makes up the difference:
// whatever the other materials do not cover of the -15% / +15% goes on the empty (last) slot.
// (Two-material armours already cover the full range by themselves.)
const DM_TARGET = 0.15;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
let armourFixed = 0;
const armourNotFull = [];
for (const r of recipes) {
  if (!r.type.startsWith('Char_Armor_')) continue;
  if (/superheavy/i.test(r.className)) continue; // the BUL-H4 juggernaut suit works differently: left as the extractor gave it
  const dm = r.slots.flatMap((sl) => sl.modifiers).filter((m) => m.stat === 'Damage Mitigation');
  if (dm.length === 0) continue;
  const low = dm.reduce((n, m) => n + (m.valueMin - 1), 0);
  const high = dm.reduce((n, m) => n + (m.valueMax - 1), 0);
  if (Math.abs(low + DM_TARGET) < 1e-6 && Math.abs(high - DM_TARGET) < 1e-6) continue; // already -15% / +15%
  const empty = r.slots.filter((sl) => sl.modifiers.length === 0);
  const valueMin = round4(1 + (-DM_TARGET - low));
  const valueMax = round4(1 + (DM_TARGET - high));
  if (empty.length === 0 && dm.length === 1 && Math.abs(high - DM_TARGET) < 1e-6) {
    dm[0].valueMin = 1 - DM_TARGET; // the data's low end (e.g. Venture Legs 0.8) is out of line: all armour is -15%
    armourFixed++;
    continue;
  }
  if (empty.length === 0 || valueMin > 1 || valueMax < 1) {
    armourNotFull.push(`${r.name} (${round4(low * 100)}% to +${round4(high * 100)}%)`);
    continue;
  }
  empty[empty.length - 1].modifiers.push({
    stat: 'Damage Mitigation',
    kind: 'multiplier',
    qualityMin: 0,
    qualityMax: 1000,
    valueMin,
    valueMax,
  });
  armourFixed++;
}
console.log(`armour given the missing Damage Mitigation on its empty slot: ${armourFixed}`);
if (armourNotFull.length) console.log(`armour NOT at -15%/+15% and nothing to fill: ${armourNotFull.join('; ')}`);

// Armour colour/pattern variants are separate items in the game data (not marked as cosmetic variants).
// Group them by class name ("qrt_specialist_heavy_arms_01_01_12" -> family "qrt_specialist_heavy_arms_01"),
// pick one as the base and treat the rest as its skins, so the list shows one entry per armour.
const armourFamilies = new Map();
for (const r of recipes) {
  if (!r.type.startsWith('Char_Armor_') || r.variantOf) continue;
  const m = /^(.*)_[^_]+_[^_]+$/.exec(r.className);
  if (!m) continue;
  if (!armourFamilies.has(m[1])) armourFamilies.set(m[1], []);
  armourFamilies.get(m[1]).push(r);
}
let armourGroups = 0;
let armourSkins = 0;
for (const members of armourFamilies.values()) {
  if (members.length < 2) continue;
  // The base is the standard "_01_01_01" version if it is listed, otherwise the one with the shortest name.
  const base =
    members.find((r) => r.className.endsWith('_01_01_01')) ??
    [...members].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
  armourGroups++;
  for (const r of members) {
    if (r === base) continue;
    r.variantOf = base.className;
    if (!skinsByBase.has(base.className)) skinsByBase.set(base.className, []);
    skinsByBase.get(base.className).push({ className: r.className, name: r.name });
    armourSkins++;
  }
}
console.log(`armour variants grouped: ${armourSkins} variants under ${armourGroups} base armours`);

const recipeByClass = new Map(recipes.map((r) => [r.className, r]));
for (const r of recipes) {
  r.skins = (skinsByBase.get(r.className) ?? [])
    .map((s) => ({ ...s, recipeId: recipeByClass.get(s.className)?.id ?? null }))
    .sort((a, b) => a.className.localeCompare(b.className));
}
// A skin lists the base item and its sibling skins, so you can keep switching between variants from any of them.
const recipeByClassAll = new Map(recipes.map((r) => [r.className, r]));
for (const r of recipes) {
  if (!r.variantOf) continue;
  const base = recipeByClassAll.get(r.variantOf);
  const baseEntry = { className: r.variantOf, name: base?.name ?? itemByClass.get(r.variantOf)?.stdItem?.Name ?? null, recipeId: base?.id ?? null };
  const siblings = (skinsByBase.get(r.variantOf) ?? [])
    .filter((x) => x.className !== r.className)
    .map((x) => ({ ...x, recipeId: recipeByClassAll.get(x.className)?.id ?? null }))
    .sort((a, b) => a.className.localeCompare(b.className));
  r.skins = [baseEntry, ...siblings];
}
recipes.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

writeFileSync(`${OUT}/resources.json`, JSON.stringify(resourcesOut, null, 2) + '\n');
writeFileSync(`${OUT}/recipes.json`, JSON.stringify(recipes) + '\n');

// ---- summary ----
const costs = recipes.flatMap((r) => r.slots.flatMap((s) => s.costs));
const noTier = [...new Set(costs.filter((c) => !ownNames.has(c.material)).map((c) => c.material))];
console.log(`resources: ${resourcesOut.length} | recipes: ${recipes.length}`);
console.log(`costs: ${costs.length} (SCU: ${costs.filter((c) => c.unitType === 'SCU').length}, Units: ${costs.filter((c) => c.unitType === 'Units').length})`);
console.log(`costs using a material with no tier table: ${noTier.join(', ') || 'none'}`);
console.log(`recipes linked to item data: ${recipes.filter((r) => r.manufacturer || r.grade !== null).length}`);
console.log(`recipes with skin variants listed: ${recipes.filter((r) => r.skins.length).length} (${recipes.reduce((n, r) => n + r.skins.length, 0)} skins)`);
console.log(`recipes that are themselves skins: ${recipes.filter((r) => r.variantOf).length}`);

#!/usr/bin/env node
/**
 * Builds the data bank used by the API (src/MyApp.Api/Data) from NovaSCDataExtractor output.
 *
 * Usage:
 *   node tools/build-databank.mjs "<folder with the extractor's JSON files>"
 *
 * Reads from that folder:  blueprints.json, resources.json, fps_equipment.json, vehicle_equipment.json
 * Writes to Data/:         resources.json, recipes.json
 * Reads from Data/:        materials.json (the hand-entered ore/mineral quality tiers)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
// Recipes we leave out of the store: weapon ammo (magazines and batteries).
const EXCLUDED = [{ type: 'WeaponAttachment', subType: 'Magazine' }];
const isExcluded = (b) => EXCLUDED.some((e) => e.type === b.TargetType && e.subType === b.TargetSubType);

const named = blueprints.filter((b) => b.TargetName && !isExcluded(b));
for (const b of named) {
  if (b.Tiers.length !== 1) throw new Error(`Unexpected tier count on ${b.TargetName}`);
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

const recipeByClass = new Map(recipes.map((r) => [r.className, r]));
for (const r of recipes) {
  r.skins = (skinsByBase.get(r.className) ?? [])
    .map((s) => ({ ...s, recipeId: recipeByClass.get(s.className)?.id ?? null }))
    .sort((a, b) => a.className.localeCompare(b.className));
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

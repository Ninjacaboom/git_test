// Builds web/public/tradeable-items.json: the names of items that can be traded but are not in the
// crafting catalogue (FPS weapons, railguns, weapon attachments, ship weapons and components).
// The market's "Other item" form suggests names from it as you type.
//
// Usage: node tools/build-tradeable.mjs <fps_equipment.json> <vehicle_equipment.json> [out.json]
// (both files come from the NovaSCDataExtractor output folder)
import { readFileSync, writeFileSync } from 'node:fs';

const [fpsPath, vehiclePath, outPath = 'web/public/tradeable-items.json'] = process.argv.slice(2);
if (!fpsPath || !vehiclePath) {
  console.error('Usage: node tools/build-tradeable.mjs <fps_equipment.json> <vehicle_equipment.json> [out.json]');
  process.exit(1);
}

const SHIP_COMPONENT_TYPES = new Set([
  'PowerPlant', 'Cooler', 'Shield', 'QuantumDrive', 'Radar', 'JumpDrive',
  'QuantumInterdictionGenerator', 'LifeSupportGenerator', 'MiningModifier', 'WeaponMining',
]);
const SHIP_WEAPON_TYPES = new Set(['WeaponGun', 'MissileLauncher', 'Missile', 'BombLauncher', 'Bomb']);

/** Category for an item, or null if it should not be offered. Keep the names in step with CUSTOM_CATEGORIES. */
function categoryOf(item, fromFps) {
  if (fromFps) {
    if (item.type === 'WeaponPersonal') return /railgun/i.test(item.stdItem?.Name ?? '') ? 'Railgun' : 'FPS weapon';
    if (item.type === 'WeaponAttachment') return 'Weapon attachment';
    return null;
  }
  if (SHIP_WEAPON_TYPES.has(item.type)) return 'Ship weapon';
  if (SHIP_COMPONENT_TYPES.has(item.type)) return 'Ship component';
  return null;
}

/** The in-game name, tidied. Null for entries that only have an internal class name. */
function cleanName(item) {
  const raw = item.stdItem?.Name;
  if (!raw) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.startsWith('@') || name.includes('_')) return null;
  if (name.toLowerCase() === String(item.className).toLowerCase()) return null;
  return name;
}

const seen = new Set();
const out = [];
for (const [path, fromFps] of [[fpsPath, true], [vehiclePath, false]]) {
  for (const item of JSON.parse(readFileSync(path, 'utf8'))) {
    const category = categoryOf(item, fromFps);
    const name = category && cleanName(item);
    if (!name) continue;
    const size = Number.isInteger(item.size) && item.size > 0 ? item.size : undefined;
    const key = `${category}|${name}|${size ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { n: name, c: category };
    const maker = item.stdItem?.Manufacturer?.Name;
    if (maker) entry.m = maker;
    if (size) entry.s = size;
    out.push(entry);
  }
}

out.sort((a, b) => a.n.localeCompare(b.n));
writeFileSync(outPath, JSON.stringify(out));
const counts = {};
for (const e of out) counts[e.c] = (counts[e.c] ?? 0) + 1;
console.log(`Wrote ${out.length} items to ${outPath}`, counts);

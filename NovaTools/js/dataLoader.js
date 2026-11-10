import { ZIP_FILES } from './config.js';

const DB_NAME = 'NovaTools';
const DB_VERSION = 10;
const STORE_NAME = 'cache';
// Cache is keyed by `${build}_${gameVersion}_${extractionTimestamp}` - no TTL needed.
// A new game version OR a re-extract within the same version produces a new
// key; old entries are pruned from this store on each successful load.
//
// Bumping DB_VERSION wipes existing entries on next open via onupgradeneeded.
// Do this whenever the cached data shape changes (new top-level field, etc.) so
// returning users don't get stuck on a stale cache entry that's missing the
// new field - and whenever the dataLoader's static filters change so the
// pre-filtered cached data doesn't keep the user on outdated output.
//   v5: added `blueprints` + `resources` for component crafting.
//   v6: expanded cosmetic-variant filter (Touring / Executive_Edition heuristic).
//   v7: VariantOf-driven skin filter + dev/test vehicle drop.
//   v8: Heartseeker Mk I/II back in the roster (own loadout, not a repaint).
//   v9: showroom `_Display` hulls dropped with the dev/test vehicles.
//   v10: Gold Standard hulls shown, the pre-rework hulls they replace dropped.

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop existing store on schema change - simpler than per-field migrations,
      // and the cache rebuilds from the local ZIPs on next load.
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(cacheKey) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(cacheKey);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCache(cacheKey, data) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ data }, cacheKey);
  } catch {
    // Cache failure is non-critical
  }
}

// Drop every cache entry for `build` except `keepKey`. Called after a fresh
// load lands so a re-extract within the same gameVersion doesn't pile up
// orphaned snapshots in IndexedDB.
async function pruneOtherEntries(build, keepKey) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result || []) {
        if (typeof k === 'string' && k.startsWith(`${build}_`) && k !== keepKey) {
          store.delete(k);
        }
      }
    };
  } catch {
    // Best-effort - never block a load on cleanup.
  }
}

async function readJsonEntry(byName, filename) {
  const entry = byName.get(filename);
  if (!entry) throw new Error(`Missing ${filename} in archive`);
  const { TextWriter } = window.zip;
  const text = await entry.getData(new TextWriter());
  return JSON.parse(text);
}

export async function loadGameData(onProgress, build, gameVersion, extractionTimestamp) {
  build = build || 'live';
  // Include extractionTimestamp so a re-extract within the same gameVersion
  // (common during Extractor development and small data fixes) busts the
  // cache automatically on reload.
  const versionToken = [gameVersion, extractionTimestamp].filter(Boolean).join('_');
  const cacheKey = versionToken ? `${build}_${versionToken}` : build;

  // Check cache
  const cached = await getCached(cacheKey);
  if (cached) {
    onProgress?.('Using cached data...');
    await mergeSoldStatus(cached.items);
    return cached;
  }

  // Fetch ZIP
  const zipPath = ZIP_FILES[build];
  onProgress?.('Downloading game data...');
  const resp = await fetch(zipPath);
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`${zipPath} not found - NovaSCDataExtractor has not produced data for this channel yet`);
    }
    throw new Error(`Could not load ${zipPath} (HTTP ${resp.status})`);
  }
  const blob = await resp.blob();

  // Open ZIP (plain, no password)
  onProgress?.('Reading archive...');
  const { ZipReader, BlobReader } = window.zip;
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const byName = new Map(entries.map(e => [e.filename, e]));

  // Read named entries from NovaSCDataExtractor output
  onProgress?.('Extracting data...');
  let vehicles = await readJsonEntry(byName, 'vehicle_stats.json');
  let hardpoints = await readJsonEntry(byName, 'vehicle_hardpoints.json');
  const items = await readJsonEntry(byName, 'vehicle_equipment.json');
  // vehicle_metadata.json is the only file carrying CosmeticVariantOf
  // references (ship-level). Best-effort load - if the archive is missing
  // it (older Extractor build), fall through with an empty cosmetic set
  // rather than failing the whole load.
  let metadata = [];
  try {
    metadata = await readJsonEntry(byName, 'vehicle_metadata.json');
  } catch { /* missing metadata file is non-fatal */ }
  // blueprints.json + resources.json carry component crafting data (per-slot
  // material quality modifiers). Currently PTU-only - best-effort load so the
  // feature simply stays dark on Live until CIG ships the data there.
  let blueprints = [];
  let resources = [];
  try {
    blueprints = await readJsonEntry(byName, 'blueprints.json');
  } catch { /* no crafting data → crafting UI hides itself */ }
  try {
    resources = await readJsonEntry(byName, 'resources.json');
  } catch { /* same */ }

  await reader.close();

  if (!Array.isArray(vehicles) || vehicles.length === 0) {
    throw new Error('vehicle_stats.json is empty - NovaSCDataExtractor produced no ship data');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('vehicle_equipment.json is empty - NovaSCDataExtractor produced no item data');
  }

  // Drop cosmetic-variant ships (paint/edition skins of an existing chassis)
  // from every consumer's view. Two-stage detection:
  //
  //   1. vehicle_metadata.json's `CosmeticVariantOf` field - truthy when
  //      the ship is a cosmetic skin of another (the field's value is the
  //      base ship's ClassName). CIG currently only populates this on a
  //      small handful of explicitly-flagged variants (Showdown BIS line);
  //      the majority of marketing reskins (Wikelo Special, Teach's
  //      Special, Touring, Executive_Edition) ship with the field
  //      missing despite having stats identical to the base ship.
  //
  //   2. ClassName heuristic - match the suffix conventions CIG uses for
  //      cosmetic-only releases. Conservative pattern list; only catches
  //      well-known marketing tokens, won't accidentally hide legitimate
  //      variants like *_M (Military) or *_Stealth which carry distinct
  //      stats. Each pattern documented inline. Remove this layer once
  //      the Extractor properly populates CosmeticVariantOf across the
  //      board.
  //
  // Filter is applied by ClassName so vehicles + hardpoints stay aligned.
  const cosmeticClasses = new Set(
    (Array.isArray(metadata) ? metadata : [])
      .filter(m => m && m.CosmeticVariantOf)
      .map(m => m.ClassName)
  );
  const COSMETIC_PATTERNS = [
    /_Collector_/i,        // Wikelo skins (_Collector_Civ, _Collector_Military, _Collector_Stealth, _Collector_Indust, _Collector_Mod, _Collector_Industrial, _Collector_Medic, _Collector_Competition)
    /_Teach$/i,            // Teach's Special (in-game NPC tie-in skin)
    /_Showdown$/i,         // 2949 Best In Show Edition
    /_PYAM_BIS$/i,         // Alternate BIS naming convention
    /_Touring$/i,          // Origin luxury reskin - ORIG_600i_Touring shares stats with ORIG_600i
    /_Executive_Edition$/i, // Origin luxury reskin - ORIG_600i_Executive_Edition shares stats with ORIG_600i
  ];
  for (const v of (Array.isArray(vehicles) ? vehicles : [])) {
    if (v && v.ClassName && COSMETIC_PATTERNS.some(re => re.test(v.ClassName))) {
      cosmeticClasses.add(v.ClassName);
    }
  }
  // Pre-rework hulls replaced by a Gold Standard build go the same way, and
  // before stage 3 so a skin resolves to the Gold Standard hull, not the old one.
  for (const cn of findSupersededByGoldStandard(vehicles)) cosmeticClasses.add(cn);

  //   3. vehicle_stats.json's `VariantOf` field - CIG's own link from a
  //      variant to its base ClassName, and far better populated than
  //      metadata's CosmeticVariantOf. It marks SHARED CHASSIS, not "skin":
  //      MISC_Freelancer_MAX, MRAI_Guardian_QI and AEGS_Sabre_Comet all carry
  //      it despite being ships a player picks on purpose, and
  //      RSI_Constellation_Andromeda points at the Aquila, which would drop
  //      the better-known hull of the pair. So VariantOf alone is not enough -
  //      it is intersected with a skin-suffix pattern AND with the base having
  //      identical deflection, which is what makes the variant redundant in
  //      the immune-ship lists this filter exists to keep readable.
  const SKIN_SUFFIX_PATTERNS = [
    /_Exec_/i,                      // PYAM Exec liveries (_Exec_Military, _Exec_Stealth, _Exec_StealthIndustrial)
    /_(Military|Civilian|Stealth)$/i, // Wikelo War/Sneak/Special under CIG's other naming convention
    /_BTALA$/i,                     // People's Alliance reskins (MOLE / Golem / Prospector Alliance)
    /_PIR$/i,                       // Pirate liveries (AEGS_Gladius_PIR)
    /_(Dunlevy|Valiant)$/i,         // Gladius commemorative liveries
    /_Renegade$/i,                  // Avenger Titan Renegade
    /_Wildfire$/i,                  // F7C Hornet Wildfire
    // NOT the F7C-M Heartseeker (Mk I or Mk II): it is a separately sold
    // variant with its own default loadout, not a repaint. The Mk II also
    // owns the only hardpoints in the data gated on
    // `ANVL_BallisticGatling_Bespoke` (its TMSB-5 ball turret), so dropping
    // the hull orphaned the TMSB-5 Gatling out of parseWeapons and blanked
    // its Defl / Sust DPS / Ammo columns in the picker.
  ];
  // Dev/test hulls CIG leaves in the export (Eclipse/Gladiator BMBRCK bomb-rack
  // rigs, Mantis and Defender "Bomb Test"). Never player-obtainable. Being
  // fixed upstream in NovaSCDataExtractor so they stop shipping at all; this
  // stays as a second line of defence and simply matches nothing once that
  // lands - see TODOS.md.
  // `_Display` hulls are the showroom/hangar display copies of a real ship.
  // They share its Name and are never flown, so they only add a confusing
  // "(Display)" duplicate to every ship list.
  const DEV_PATTERNS = [/_TEST$/i, /_Bomb_Test$/i, /_Display$/i];

  const vehicleList = Array.isArray(vehicles) ? vehicles : [];
  // Stages 1-2 are complete, so exclude what they already condemned - a skin
  // must resolve to a hull that survives, not to another skin.
  const byClassName = new Map(
    vehicleList.filter(v => v?.ClassName && !cosmeticClasses.has(v.ClassName))
      .map(v => [v.ClassName, v])
  );
  const deflOf = v => [
    v?.Armor?.DamageDeflection?.Physical ?? null,
    v?.Armor?.DamageDeflection?.Energy ?? null
  ];
  // CIG sometimes points VariantOf at an intermediate ClassName that is not
  // itself exported (ANVL_Lightning_F8C_Exec_Military → ANVL_Lightning_F8C_Exec,
  // which does not ship). Fall back to the longest exported ClassName that is a
  // prefix of the missing link, so the chain still resolves to the real hull.
  const resolveBase = (className) => {
    const direct = byClassName.get(className);
    if (direct) return direct;
    let best = null;
    for (const [cn, v] of byClassName) {
      if (className.startsWith(cn + '_') && (!best || cn.length > best.ClassName.length)) best = v;
    }
    return best;
  };
  for (const v of vehicleList) {
    if (!v?.ClassName) continue;
    if (DEV_PATTERNS.some(re => re.test(v.ClassName))) {
      cosmeticClasses.add(v.ClassName);
      continue;
    }
    if (!v.VariantOf) continue;
    if (!SKIN_SUFFIX_PATTERNS.some(re => re.test(v.ClassName))) continue;
    const base = resolveBase(v.VariantOf);
    if (!base || base === v) continue;
    const [p, e] = deflOf(v);
    const [bp, be] = deflOf(base);
    if (p === bp && e === be) cosmeticClasses.add(v.ClassName);
  }

  if (cosmeticClasses.size > 0) {
    vehicles = vehicles.filter(v => !cosmeticClasses.has(v.ClassName));
    hardpoints = hardpoints.filter(h => !cosmeticClasses.has(h.ClassName));
  }

  // Merge sold status from CStone data
  await mergeSoldStatus(items);

  // CIG ships in different loadout variants share the same displayName (e.g.
  // "Cutlass Black PYAM Exec" exists as both _Exec_Military and _Exec_Stealth
  // ClassNames). The front-end keys on Name, so without disambiguation only
  // one variant is selectable. Suffix the Name with a variant tag so they
  // become distinct entries in the picker.
  disambiguateShipNames(vehicles, hardpoints);

  const data = { vehicles, items, hardpoints, blueprints, resources };

  // Cache
  onProgress?.('Caching data...');
  await setCache(cacheKey, data);
  pruneOtherEntries(build, cacheKey);

  return data;
}

/**
 * ClassNames of hulls that a Gold Standard build has replaced.
 *
 * `_GS` marks CIG's reworked build of a ship - the one players own. The
 * pre-rework hull stays in the export under the same display Name with the
 * old stats and loadout, so where both exist the old one must not be shown.
 * The pairing is by ClassName with the `_GS` token removed, which also pairs
 * suffixed variants (`<Ship>_GS_Military` replaces `<Ship>_Military`). A Gold
 * Standard hull with no old twin replaces nothing.
 */
export function findSupersededByGoldStandard(vehicles) {
  const classNames = new Set((Array.isArray(vehicles) ? vehicles : []).map(v => v?.ClassName).filter(Boolean));
  const superseded = new Set();
  for (const cn of classNames) {
    if (!/_GS(_|$)/.test(cn)) continue;
    const old = cn.replace(/_GS(?=_|$)/, '');
    if (classNames.has(old)) superseded.add(old);
  }
  return superseded;
}

// Map a ClassName-suffix variant token (e.g. "Stealth", "Plat",
// "Collector_Indust") to a human-readable label for the picker.
const VARIANT_LABELS = {
  'Plat': 'Platinum',
  'StealthIndustrial': 'Stealth Industrial',
  'Collector_Indust': 'Collector Industrial',
  'Collector_Military': 'Collector Military',
};

function humanizeVariant(suffix) {
  if (suffix in VARIANT_LABELS) return VARIANT_LABELS[suffix];
  // Generic fallback: split underscores, Title Case each token.
  return suffix.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function commonPrefix(strs) {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

function disambiguateShipNames(vehicles, hardpoints) {
  const byName = new Map();   // Name → [ClassName, ...]
  for (const v of vehicles) {
    if (!v.Name || !v.ClassName) continue;
    if (!byName.has(v.Name)) byName.set(v.Name, []);
    byName.get(v.Name).push(v.ClassName);
  }
  const renames = new Map();  // ClassName → newName
  for (const [name, classes] of byName) {
    if (classes.length < 2) continue;
    const prefix = commonPrefix(classes);
    for (const cn of classes) {
      // Strip any leading underscores left over from prefix slicing.
      const suffix = cn.slice(prefix.length).replace(/^_+/, '');
      // The class whose suffix is empty IS the base variant - leave its Name
      // alone so the picker shows e.g. "RSI Zeus Mk II CL" (no "(Base)").
      if (!suffix) continue;
      renames.set(cn, `${name} (${humanizeVariant(suffix)})`);
    }
  }
  for (const arr of [vehicles, hardpoints]) {
    for (const v of arr) {
      const newName = renames.get(v.ClassName);
      if (newName) v.Name = newName;
    }
  }
}

async function mergeSoldStatus(items) {
  try {
    const resp = await fetch('data/sold_status.json');
    if (!resp.ok) return;
    const soldMap = await resp.json();
    for (const item of items) {
      if (item.className in soldMap) {
        item.sold = soldMap[item.className];
      }
    }
  } catch {
    // sold_status.json missing or malformed - non-critical
  }
}

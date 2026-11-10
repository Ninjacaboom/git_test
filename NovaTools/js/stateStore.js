/**
 * State persistence - URL hash for navigation, localStorage for loadout data.
 */

const LOADOUT_KEY = 'sc-loadouts';

// ── URL hash ──

export function saveHash(params) {
  const cur = loadHash();
  const merged = { ...cur, ...params };
  // Remove null/undefined values
  for (const k of Object.keys(merged)) {
    if (merged[k] == null) delete merged[k];
  }
  const str = Object.entries(merged)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  history.replaceState(null, '', str ? '#' + str : location.pathname);
}

export function loadHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return {};
  const result = {};
  for (const pair of hash.split('&')) {
    const [k, v] = pair.split('=');
    if (k && v != null) result[k] = decodeURIComponent(v);
  }
  return result;
}

// ── localStorage loadouts ──

function readAll() {
  try { return JSON.parse(localStorage.getItem(LOADOUT_KEY)) || {}; }
  catch { return {}; }
}

export function saveLoadout(shipName, loadout) {
  const all = readAll();
  all[shipName] = loadout;
  localStorage.setItem(LOADOUT_KEY, JSON.stringify(all));
}

export function loadLoadout(shipName) {
  return readAll()[shipName] || null;
}

export function clearLoadout(shipName) {
  const all = readAll();
  delete all[shipName];
  localStorage.setItem(LOADOUT_KEY, JSON.stringify(all));
}

// ── Pip allocation persistence ──

const PIP_KEY = 'sc-pip-allocations';

function readAllPips() {
  try { return JSON.parse(localStorage.getItem(PIP_KEY)) || {}; }
  catch { return {}; }
}

export function savePipAllocation(shipName, channels) {
  const all = readAllPips();
  // Store only key→allocated pairs
  const saved = {};
  for (const ch of channels) saved[ch.key] = ch.allocated;
  all[shipName] = saved;
  localStorage.setItem(PIP_KEY, JSON.stringify(all));
}

export function loadPipAllocation(shipName) {
  return readAllPips()[shipName] || null;
}

// ── Shield selection persistence ──

const SHIELD_SEL_KEY = 'sc-shield-selections';

function readAllShieldSel() {
  try { return JSON.parse(localStorage.getItem(SHIELD_SEL_KEY)) || {}; }
  catch { return {}; }
}

export function saveShieldSelection(shipName, poweredIndices) {
  const all = readAllShieldSel();
  if (poweredIndices == null) {
    delete all[shipName];
  } else {
    all[shipName] = poweredIndices;
  }
  localStorage.setItem(SHIELD_SEL_KEY, JSON.stringify(all));
}

export function loadShieldSelection(shipName) {
  return readAllShieldSel()[shipName] || null;
}

// ── Disabled (powered-off) port persistence ──

const DISABLED_KEY = 'sc-disabled-ports';

function readAllDisabled() {
  try { return JSON.parse(localStorage.getItem(DISABLED_KEY)) || {}; }
  catch { return {}; }
}

export function saveDisabledPorts(shipName, ports) {
  const all = readAllDisabled();
  const arr = ports instanceof Set ? [...ports] : (ports || []);
  if (arr.length === 0) {
    delete all[shipName];
  } else {
    all[shipName] = arr;
  }
  localStorage.setItem(DISABLED_KEY, JSON.stringify(all));
}

export function loadDisabledPorts(shipName) {
  return readAllDisabled()[shipName] || null;
}

// ── Build selection persistence ──

const BUILD_KEY = 'sc-build';

export function saveBuildSelection(build) {
  localStorage.setItem(BUILD_KEY, build);
}

export function loadBuildSelection() {
  return localStorage.getItem(BUILD_KEY) || null;
}

// ── Named builds persistence ──

const NAMED_BUILDS_KEY = 'sc-named-builds';

function readAllNamedBuilds() {
  try { return JSON.parse(localStorage.getItem(NAMED_BUILDS_KEY)) || {}; }
  catch { return {}; }
}

/**
 * Save a named build for a ship.
 * @param {string} shipName
 * @param {string} buildName
 * @param {object} buildData - { loadout, pips, shields }
 */
export function saveNamedBuild(shipName, buildName, buildData) {
  const all = readAllNamedBuilds();
  if (!all[shipName]) all[shipName] = {};
  all[shipName][buildName] = { ...buildData, savedAt: Date.now() };
  localStorage.setItem(NAMED_BUILDS_KEY, JSON.stringify(all));
}

/**
 * Get all named builds for a ship.
 * @returns {object} { buildName: { loadout, pips, shields, savedAt } }
 */
export function getNamedBuilds(shipName) {
  return readAllNamedBuilds()[shipName] || {};
}

/**
 * Delete a named build.
 */
export function deleteNamedBuild(shipName, buildName) {
  const all = readAllNamedBuilds();
  if (all[shipName]) {
    delete all[shipName][buildName];
    if (Object.keys(all[shipName]).length === 0) delete all[shipName];
    localStorage.setItem(NAMED_BUILDS_KEY, JSON.stringify(all));
  }
}

/**
 * Rename a named build.
 */
export function renameNamedBuild(shipName, oldName, newName) {
  const all = readAllNamedBuilds();
  if (all[shipName]?.[oldName]) {
    all[shipName][newName] = all[shipName][oldName];
    delete all[shipName][oldName];
    localStorage.setItem(NAMED_BUILDS_KEY, JSON.stringify(all));
  }
}

// ── Tab persistence ──

const TABS_KEY = 'sc-tabs';

export function saveTabs(tabs, activeIdx) {
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeIdx }));
}

export function loadTabs() {
  try {
    const data = JSON.parse(localStorage.getItem(TABS_KEY));
    if (data?.tabs?.length > 0) return data;
  } catch {}
  return null;
}

// ── Section order persistence ──

const SECTION_ORDER_KEY = 'sc-section-order';

export function saveSectionOrder(order) {
  localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
}

export function loadSectionOrder() {
  try {
    return JSON.parse(localStorage.getItem(SECTION_ORDER_KEY));
  } catch {}
  return null;
}

// ── Deflection dialog prefs ──
//
// Remembers the user's last opponent ship/shield, slider positions and
// the armor-durability toggle so re-opening the dialog doesn't reset every
// choice. Global (not per-ship) - users typically pick one opponent profile
// and compare loadouts against it.

const DEFLECTION_PREFS_KEY = 'sc-deflection-prefs';

export function saveDeflectionPrefs(prefs) {
  try { localStorage.setItem(DEFLECTION_PREFS_KEY, JSON.stringify(prefs)); }
  catch {}
}

export function loadDeflectionPrefs() {
  try { return JSON.parse(localStorage.getItem(DEFLECTION_PREFS_KEY)) || null; }
  catch { return null; }
}

// ── Time-to-Kill dialog prefs ──
//
// Same rationale as the deflection prefs above: remember the last opponent
// ship / shield / power plant, the armor-durability toggle, AND the pause-
// length slider so re-opening the TTK dialog doesn't reset the user's
// comparison target. Global, not per-ship.
// Shape: { opponentShipName, opponentShieldCn, opponentPpCn,
//          applyArmorDurability, pauseLen }

const TTK_PREFS_KEY = 'sc-ttk-prefs';

export function saveTtkPrefs(prefs) {
  try { localStorage.setItem(TTK_PREFS_KEY, JSON.stringify(prefs)); }
  catch {}
}

export function loadTtkPrefs() {
  try { return JSON.parse(localStorage.getItem(TTK_PREFS_KEY)) || null; }
  catch { return null; }
}

// ── Shared builds API ──

export function getShareIdFromPath() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

export async function createSharedBuild(shipName, build) {
  const resp = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ship: shipName, build }),
  });
  if (!resp.ok) throw new Error('Failed to create shared build');
  const { id } = await resp.json();
  return `${location.origin}/s/${id}`;
}

export async function fetchSharedBuild(id) {
  const resp = await fetch(`/api/shared/${encodeURIComponent(id)}`);
  if (!resp.ok) return null;
  return resp.json();
}

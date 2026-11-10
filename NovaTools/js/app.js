import { loadGameData } from './dataLoader.js';
import { parseShips } from './shipParser.js';
import { parseWeapons } from './weaponParser.js';
import { computeTiers } from './tierEngine.js';
import { initUI, restoreTab } from './ui.js';
import { initLoadoutUI } from './loadoutUI.js';
import { initCraftingData } from './loadoutManager.js';
import { initCraftingResources, wireCraftingEvents } from './craftingUI.js';
import { VERSIONS_URL } from './config.js';
import { compareGameVersions } from './utils.js';
import { loadHash, saveBuildSelection, loadBuildSelection, getShareIdFromPath, fetchSharedBuild } from './stateStore.js';

let currentBuild = 'live';
let buildAvailability = {};

function updateLoading(msg) {
  const el = document.querySelector('#loading .load-status');
  if (el) el.textContent = msg;
}

function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  const el = document.getElementById('error');
  el.style.display = '';
  el.textContent = msg;
}

function showLoading() {
  document.getElementById('loading').style.display = '';
  document.getElementById('error').style.display = 'none';
  document.getElementById('app').style.display = 'none';
}

async function loadBuild(build) {
  currentBuild = build;
  showLoading();

  try {
    const gameVersion = buildAvailability[build]?.version;
    const extractionTimestamp = buildAvailability[build]?.extractionTimestamp;
    const { vehicles, items, hardpoints, blueprints, resources } = await loadGameData(updateLoading, build, gameVersion, extractionTimestamp);

    // Component-crafting data - PTU-only at the moment. Empty arrays on Live
    // keep the feature dark (hasCraftingData() returns false → no UI).
    initCraftingData(blueprints || []);
    initCraftingResources(resources || []);
    wireCraftingEvents();

    updateLoading('Processing ships...');
    const ships = parseShips(vehicles);

    updateLoading('Processing weapons...');
    // Pass hardpoints so parseWeapons can filter "orphan" weapons - items
    // with no ship port that can mount them (CIG dev/future/cut weapons left
    // floating in the data).
    const weapons = parseWeapons(items, hardpoints);

    updateLoading('Computing tiers...');
    computeTiers(weapons, ships);

    console.log(`Loaded ${ships.length} ships, ${weapons.length} weapons (${build})`);

    const hash = loadHash();

    // If the URL is /s/<id>, resolve the shared build before showing the app
    // so the user lands directly on the shared loadout (and failures surface).
    let sharedBuild = null;
    let restoredShip = hash.ship;
    const shareId = getShareIdFromPath();
    if (shareId) {
      updateLoading('Loading shared build...');
      try {
        const data = await fetchSharedBuild(shareId);
        if (!data) throw new Error('Shared build not found');
        if (!hardpoints.some(h => h.Name === data.ship)) {
          throw new Error(`Ship "${data.ship}" not in current data`);
        }
        sharedBuild = data.build;
        restoredShip = data.ship;
        history.replaceState(null, '', `/#ship=${encodeURIComponent(data.ship)}`);
      } catch (err) {
        console.warn('Shared build load failed:', err);
        history.replaceState(null, '', '/');
      }
    }

    initUI(weapons, ships, hash.weapon);
    initLoadoutUI(ships, hardpoints, items, vehicles, restoredShip, weapons, sharedBuild);
    restoreTab(hash.tab);
  } catch (e) {
    console.error('Failed to load:', e);
    showError(e.message);
  }
}

/** Format the gameVersion string from NovaSCDataExtractor for display.
 *  Recent extractor output is 4-part `<major>.<minor>.<patch>.<p4Change>`
 *  (e.g. "4.8.0.11812390"). Legacy `sc-(alpha|live|ptu)-X.Y.Z` strings strip
 *  the prefix and keep their first three parts. */
function shortVersion(v) {
  if (!v) return '';
  return v.replace(/^sc-(?:alpha|beta|live|ptu)-/i, '');
}

async function determineBuildAvailability() {
  try {
    const resp = await fetch(VERSIONS_URL);
    if (!resp.ok) return { ptu: { available: false }, live: { available: true }, defaultBuild: 'live' };
    const versions = await resp.json();

    const liveEntry = versions['Live.zip'] || {};
    const ptuEntry = versions['PTU.zip'] || {};
    const liveVersion = liveEntry.gameVersion || '';
    const ptuVersion = ptuEntry.gameVersion || '';

    // PTU is available when its version is newer than Live. Compared
    // numerically part-by-part: 4.10 PTU is newer than 4.9 Live, which a
    // string comparison reads the other way round.
    const ptuAvailable = !!(ptuVersion && compareGameVersions(ptuVersion, liveVersion) > 0);
    const liveAvailable = !!liveVersion;

    // Default to saved preference if that build is still available
    const saved = loadBuildSelection();
    let defaultBuild = 'live';
    if (saved === 'ptu' && ptuAvailable) defaultBuild = 'ptu';
    else if (saved === 'live' && liveAvailable) defaultBuild = 'live';
    else if (ptuAvailable && !liveAvailable) defaultBuild = 'ptu';

    return {
      ptu: { available: ptuAvailable, version: ptuVersion, extractionTimestamp: ptuEntry.extractionTimestamp || '' },
      live: { available: liveAvailable, version: liveVersion, extractionTimestamp: liveEntry.extractionTimestamp || '' },
      defaultBuild
    };
  } catch {
    return { ptu: { available: false }, live: { available: true }, defaultBuild: 'live' };
  }
}

async function initBuildToggle() {
  const toggle = document.getElementById('buildToggle');
  toggle.style.display = '';

  const availability = await determineBuildAvailability();
  buildAvailability = availability;

  toggle.querySelectorAll('.build-btn').forEach(btn => {
    const build = btn.dataset.build;
    const info = availability[build];

    // Set button text with version
    const label = build.toUpperCase();
    btn.textContent = info?.version ? `${label} ${shortVersion(info.version)}` : label;

    // Set availability state
    if (!info?.available) {
      btn.classList.add('disabled');
      btn.dataset.tip = build === 'ptu' ? 'PTU is not currently active' : 'Live data not available';
    } else {
      btn.classList.remove('disabled');
      delete btn.dataset.tip;
    }

    // Set active state
    if (build === availability.defaultBuild) {
      btn.classList.add('active');
    }

    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) return;
      if (build === currentBuild) return;

      toggle.querySelectorAll('.build-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      saveBuildSelection(build);
      loadBuild(build);
    });
  });

  return availability.defaultBuild;
}

async function checkForUpdates() {
  try {
    const resp = await fetch('/api/check-updates');
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.hasUpdates) return;

    const names = Object.keys(data.updates).map(n => n.replace('.zip', '')).join(' & ');
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = `
      <span><i class="spvi-icon_common_radar"></i> Game data update available (${names})</span>
      <button class="update-btn" id="updateBtn">Update</button>
    `;
    document.body.prepend(bar);
    document.getElementById('updateBtn').addEventListener('click', async () => {
      const btn = document.getElementById('updateBtn');
      btn.disabled = true;
      btn.textContent = 'Updating...';

      try {
        const resp = await fetch('/api/update-data');
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
        }
        btn.textContent = 'Reloading...';
        // Clear IndexedDB cache so fresh data is loaded, then auto-refresh
        indexedDB.deleteDatabase('NovaTools');
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        btn.textContent = 'Failed';
      }
    });
  } catch {
    // Update check is non-critical
  }
}

(async () => {
  if (navigator.storage?.persist) {
    navigator.storage.persist().then(granted => {
      if (granted) console.log('Persistent storage granted');
    });
  }
  const defaultBuild = await initBuildToggle();
  currentBuild = defaultBuild;
  loadBuild(currentBuild);
  checkForUpdates();
})();

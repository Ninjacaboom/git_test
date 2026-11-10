/**
 * Time to Kill calculator - modal dialog.
 *
 * Opens from the loadout build bar. Lets the user pick an opponent vehicle +
 * shield + power plant and see how long the active loadout (all weapons firing
 * at once) takes to break shields, kill the ship, or disable it - either by
 * destroying the power plant or by filling its distortion pool.
 *
 * Pure rendering layer over `ttkCalc.js`. Mounts on document.body, rebuilds on
 * each open. Mirrors the deflection dialog's structure and reuses its
 * searchable-dropdown pattern. Selection state persists via stateStore.
 *
 * Synchronized-fire model (see PLAN_TTK_PILOT_FIRE.md, Phase 1): the dictator
 * weapon (shortest CF among finite-magazine groups) drives a pause cycle. The
 * pause slider controls how long all groups stay silent between bursts.
 * Opponent shield regen is modeled per shield item's DamagedDelay + RegenRate,
 * so the slider has real meaning: short pauses prevent regen, long pauses let
 * it kick in. Distortion still fires alongside other weapons in Phase 1; the
 * Mode-A "hold distortion" policy ships in Phase 2.
 */

import * as state from './loadoutState.js';
import { getItemStats } from './loadoutManager.js';
import { saveTtkPrefs, loadTtkPrefs } from './stateStore.js';
import {
  enumerateLoadoutWeaponsForTtk,
  buildTtkOpponentProfile,
  simulateTtk,
  DEFAULT_PAUSE_LEN,
  computeIdealBurstDuration,
  computeOptimalPauseLen,
  computeMinUsefulPause,
} from './ttkCalc.js';
import { escapeHtml, fmtNum, gradeLetter } from './utils.js';
import { attachSearchableDropdown } from './uiWidgets.js';
import {
  listShieldItems,
  listPowerPlants,
  findInstalledByType,
  countInstalledByType,
  findPortByType,
  lookupOpponentShip,
  ppReachForSize,
} from './loadoutQuery.js';

const fmt = fmtNum;

/** Format a seconds value: ∞, "-" (n/a), or a clock time (1 dp under 10s). */
function timeCell(secs) {
  if (secs === Infinity) return '∞';
  if (secs == null || !Number.isFinite(secs)) return '-';
  if (secs === 0) return '0 s';
  return (secs < 10 ? secs.toFixed(1) : fmt(Math.round(secs))) + ' s';
}

/** Dropdown option label: "FR-76 (Military B)" - name + class/type + grade
 *  letter. Falls back to just the name when there's no class/grade. Shared by
 *  the shield and power-plant dropdowns. */
function formatTypeGradeLabel(item) {
  if (!item) return null;
  const tg = [item.cls, gradeLetter(item.grade)].filter(Boolean).join(' ');
  return tg ? `${item.name} (${tg})` : item.name;
}

function shieldLabelFor(className, shields) {
  if (!className) return null;
  const s = shields.find(x => x.className === className);
  return s ? formatTypeGradeLabel(s) : className;
}

function ppLabelFor(className, plants) {
  if (!className) return null;
  const p = plants.find(x => x.className === className);
  return p ? formatTypeGradeLabel(p) : className;
}

// ─── Picker data ─────────────────────────────────────────────────────────────

/** Sorted list of opponent vehicles (every ship in the hardpoints DB). */
function listOpponentShips() {
  return [...state.allHardpoints]
    .map(h => h.Name)
    .sort((a, b) => a.localeCompare(b));
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const OUTCOME_ROWS = [
  // Icons mirror the Ship Details banner: Shields uses the shield-generator
  // glyph, Armor uses the plating glyph (same classes statsPanel.js renders).
  { key: 'breakShields', label: 'Break shields', icon: 'spvi-icon_common_generator_shield' },
  { key: 'breakArmor', label: 'Break armor', icon: 'spvi-Engineering_Icon_ItemShields' },
  { key: 'killVital', label: 'Destroy (vital)', icon: 'spvi-weapon' },
  // Two distinct ways to take the power plant offline: physical HP to 0
  // ("Destroy") vs filling its distortion pool ("Distort"). Named explicitly
  // so they don't read as the same "Disable" outcome.
  { key: 'disablePowerplant', label: 'Disable power plant', icon: 'spvi-powerplant' },
  // distortionOnly: only shown when the loadout carries a distortion weapon.
  { key: 'disableDistortion', label: 'Distort power plant', icon: 'spvi-icon_common_EMP', distortionOnly: true },
];

/**
 * Render a defender-state cell: "HP (pct%)" for the layer (shield or armor)
 * remaining at the instant the outcome landed, or "-" when not applicable
 * (outcome never reached, or the layer doesn't exist on this target).
 */
function stateCell(snap, which) {
  if (!snap) return '<span class="ttk-note">-</span>';
  const hp = which === 'shield' ? snap.shieldHp : snap.armorHp;
  const pct = which === 'shield' ? snap.shieldPct : snap.armorPct;
  if (pct == null) return '<span class="ttk-note">-</span>';
  return `${fmt(hp)} <span class="ttk-note">(${Math.round(pct * 100)}%)</span>`;
}

function renderResults(result, hasDistortion) {
  const rows = OUTCOME_ROWS.filter(o => !o.distortionOnly || hasDistortion).map(o => {
    const secs = result[o.key];
    const snap = result.snapshot?.[o.key];
    const reason = result.reasons?.[o.key];
    const cycles = result.cyclesAt?.[o.key];
    const valueCls = secs === Infinity ? 'ttk-val-inf' : 'ttk-val';
    // Outcomes are computed independently (the sim no longer stops at the hull
    // kill), so an Infinity always carries a mechanical reason (no shield, all
    // deflected, below reach, can't deplete, etc.) - show it.
    const reasonHtml = (secs === Infinity && reason)
      ? `<div class="ttk-reason">${escapeHtml(reason)}</div>` : '';
    // Cycles column: how many sync pauses were completed before the outcome
    // landed. 0 = resolved in initial burst; higher = pilot needed multiple
    // burst-pause rounds. "-" when the outcome was never reached.
    const cyclesCell = secs === Infinity ? '<span class="ttk-note">-</span>' : `${cycles ?? 0}`;
    // Effective DPS for this outcome (total damage dealt up to it / its time).
    const dps = effDpsFor(result, o.key);
    const dpsCell = dps ? `${fmt(dps)}` : '<span class="ttk-note">-</span>';
    return `<tr>
      <td class="ttk-outcome"><i class="${o.icon}"></i> ${o.label}${reasonHtml}</td>
      <td class="${valueCls}">${timeCell(secs)}</td>
      <td class="ttk-dps">${dpsCell}</td>
      <td class="ttk-state">${cyclesCell}</td>
      <td class="ttk-state">${stateCell(snap, 'shield')}</td>
      <td class="ttk-state">${stateCell(snap, 'armor')}</td>
    </tr>`;
  }).join('');
  // "Cycles" = sync pauses completed before the outcome (0 = initial burst).
  // "Shield left" / "Armor left" = how much of each layer was still standing
  // when the outcome was reached. They differ by damage type: a distortion
  // disable can land with shields near full; a ballistic vital kill only after
  // armor is gone.
  return `<table class="ttk-results-table">
    <thead><tr><th></th><th>Time</th><th>DPS</th><th>Cycles</th><th>Shield left</th><th>Armor left</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Effective DPS for a given outcome = total damage delivered to all layers
 * up to the outcome timestamp, divided by that timestamp. Captures pause /
 * trickle / overheat cycling exactly as the sim ran it. Returns null when the
 * outcome was never reached.
 */
function effDpsFor(result, key) {
  const t = result?.[key];
  const dmg = result?.damageAt?.[key];
  if (!t || !Number.isFinite(t) || !(dmg > 0)) return null;
  return dmg / t;
}

/**
 * Compact per-cycle verification log. One row per cycle event (init,
 * burst-end, pause-end). Captures shield / armor / hull / PP / distortion
 * state at the moment the row is recorded so a tester can step through and
 * diff against expectations. The same rows are reused by the downloadable
 * HTML report.
 */
// Friendly display labels for the internal log phase keys. The raw keys stay as
// logic identifiers in ttkCalc.js (and the phase checks below) - only the shown
// text changes here. Any new phase added there should get a label here too.
const LOG_PHASE_LABELS = {
  'init': 'Initial burst',
  'burst-end': 'Burst end',
  'pause-end': 'Pause end',
  'end': 'End',
  'outcome: shield broke': 'Shield broke',
  'outcome: armor broke': 'Armor broke',
  'outcome: vital killed': 'Vital destroyed',
  'outcome: PP disabled': 'PP disabled',
  'outcome: distortion disabled': 'PP distorted',
};

function renderLogRows(result, { interactive = false } = {}) {
  if (!result?.log?.length) return '';
  // Group per-shot detail by cycle so a burst-end row can expand into the
  // shots that produced it.
  const shotsByCycle = new Map();
  for (const s of (result.shotLog || [])) {
    if (!shotsByCycle.has(s.cycle)) shotsByCycle.set(s.cycle, []);
    shotsByCycle.get(s.cycle).push(s);
  }
  return result.log.map(e => {
    const shieldPct = e.shieldPct != null ? `(${Math.round(e.shieldPct * 100)}%)` : '';
    const armorPct = e.armorPct != null ? `(${Math.round(e.armorPct * 100)}%)` : '';
    const ppPct = e.ppMaxHp > 0 ? `(${Math.round(e.ppHp / e.ppMaxHp * 100)}%)` : '';
    const distPct = e.distortionMax > 0 ? `(${Math.round(Math.min(1, e.distortionPool / e.distortionMax) * 100)}%)` : '';
    const armorThr = `phys ${fmt(e.armorThreshold?.phys, 0)} / energy ${fmt(e.armorThreshold?.energy, 0)} / dist ${fmt(e.armorThreshold?.dist, 0)}`;
    // Burst-end AND the terminal 'end' row get an expand toggle (interactive
    // dialog only - the downloaded HTML shows shots inline below instead).
    // The 'end' row covers the final burst, which has no burst-end row but is
    // where the decisive outcomes (kill etc.) land.
    const shots = (e.phase === 'burst-end' || e.phase === 'end') ? shotsByCycle.get(e.cycle) : null;
    const expandable = interactive && shots && shots.length;
    const cycleCell = expandable
      ? `<span class="ttk-shot-toggle" data-cycle="${e.cycle}">▸ ${e.cycle}</span>`
      : `${e.cycle}`;
    let html = `<tr${expandable ? ` class="ttk-log-burstrow" data-cycle="${e.cycle}"` : ''}>
      <td>${cycleCell}</td>
      <td>${LOG_PHASE_LABELS[e.phase] || e.phase}</td>
      <td>${e.t.toFixed(2)} s</td>
      <td>${fmt(e.shieldHp)} ${shieldPct}</td>
      <td>${fmt(e.armorHp)} ${armorPct}</td>
      <td>${fmt(e.vitalHp)}</td>
      <td>${fmt(e.ppHp)} ${ppPct}</td>
      <td>${fmt(e.distortionPool)} ${distPct}</td>
      <td class="ttk-log-thr">${armorThr}</td>
      <td>${fmt(e.totalDamage)}</td>
    </tr>`;
    if (shots && shots.length) {
      const hidden = interactive ? ' hidden' : '';
      html += shots.map(sh => {
        const dmgCell = (label, dmg) => dmg > 0 ? `${label}${fmt(dmg, 0)}` : '';
        return `<tr class="ttk-shot-row ttk-shot-c${e.cycle}"${hidden}>
          <td></td>
          <td class="ttk-shot-wpn">↳ ${escapeHtml(sh.weapon)}</td>
          <td>${sh.t.toFixed(2)} s</td>
          <td>${dmgCell('−', sh.shieldDmg)} <span class="ttk-note">${fmt(sh.shieldHp)}</span></td>
          <td>${dmgCell('−', sh.armorDmg)} <span class="ttk-note">${fmt(sh.armorHp)}</span></td>
          <td>${dmgCell('−', sh.hullDmg)} <span class="ttk-note">${fmt(sh.vitalHp)}</span></td>
          <td>${dmgCell('−', sh.componentDmg)} <span class="ttk-note">${fmt(sh.ppHp)}</span></td>
          <td>${dmgCell('+', sh.distortionDmg)} <span class="ttk-note">${fmt(sh.distortionPool)}</span></td>
          <td></td><td></td>
        </tr>`;
      }).join('');
    }
    return html;
  }).join('');
}

function renderLog(result) {
  if (!result?.log?.length) return '<div class="defl-empty">No log captured.</div>';
  return `<table class="ttk-log-table">
    <thead><tr>
      <th>Cycle</th><th>Phase</th><th>t</th>
      <th>Shield HP</th><th>Armor HP</th><th>Vital HP</th><th>PP HP</th><th>Dist pool</th>
      <th>Armor deflection</th><th>Total dmg</th>
    </tr></thead>
    <tbody>${renderLogRows(result, { interactive: true })}</tbody>
  </table>`;
}

/** Opponent ship's defensive pools - belongs under the Opponent section. */
function renderOpponentStats(opponent) {
  const sh = opponent.shield;
  const shieldTxt = sh.faceCount > 1
    ? `${fmt(sh.maxHp)} hp/face ×${sh.faceCount}`
    : `${fmt(sh.maxHp)} hp`;
  const pp = opponent.powerplant || {};
  const hull = opponent.hull?.smallestVitalHp || 0;
  return `<div class="ttk-summary ttk-opp-stats">
    <span>Shield <span class="ttk-summary-val">${shieldTxt}</span></span>
    <span>Armor <span class="ttk-summary-val">${fmt(opponent.armor.maxHp)} hp</span></span>
    <span>Vital <span class="ttk-summary-val">${fmt(hull)} hp</span></span>
    <span>Power plant <span class="ttk-summary-val">${fmt(pp.maxHp)} hp</span></span>
    <span>Distortion <span class="ttk-summary-val">${fmt(pp.distortionMax)}</span></span>
  </div>`;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export function openTtkCalc() {
  if (!state.currentShipName) return;
  if (!state.allHardpoints || state.allHardpoints.length === 0) return;

  const opponentShips = listOpponentShips();

  let selectedShipName = opponentShips[0];
  let selectedShieldCn = null;
  let selectedPpCn = null;
  let applyArmorDurability = true;
  let pauseLen = DEFAULT_PAUSE_LEN;
  let shieldPct = 1; // 0..1
  let armorPct = 1;  // 0..1
  let distortionMode = 'hold'; // 'hold' (optimal) | 'always'
  let ppReach = 0; // metres of penetration required to reach the power plant; 0 = off
  let includeTurrets = false; // false = pilot guns only; true = + remote/manned turrets

  // Default to the active ship's own type.
  if (opponentShips.includes(state.currentShipName)) selectedShipName = state.currentShipName;
  let opponentMeta = lookupOpponentShip(selectedShipName);
  // Filtered lists update when the opponent ship changes - an Arrow only sees
  // S1 shields, a Polaris sees S3+. Mirrors the loadout picker's behavior.
  let shields = listShieldItems(opponentMeta.shieldPort);
  let plants = listPowerPlants(opponentMeta.ppPort);
  selectedShieldCn = opponentMeta.defaultShieldCn || (shields[0]?.className ?? null);
  selectedPpCn = opponentMeta.defaultPpCn || (plants[0]?.className ?? null);

  // Restore saved choices when still valid in current data. If the saved ship
  // changes, refresh opponentMeta + filtered shield/PP lists before validating
  // those - the saved S5 shield is gone if user is now looking at a fighter.
  const saved = loadTtkPrefs();
  if (saved) {
    if (saved.opponentShipName && opponentShips.includes(saved.opponentShipName)) {
      selectedShipName = saved.opponentShipName;
      opponentMeta = lookupOpponentShip(selectedShipName);
      shields = listShieldItems(opponentMeta.shieldPort);
      plants = listPowerPlants(opponentMeta.ppPort);
      selectedShieldCn = opponentMeta.defaultShieldCn || (shields[0]?.className ?? null);
      selectedPpCn = opponentMeta.defaultPpCn || (plants[0]?.className ?? null);
    }
    if (saved.opponentShieldCn && shields.some(s => s.className === saved.opponentShieldCn)) selectedShieldCn = saved.opponentShieldCn;
    if (saved.opponentPpCn && plants.some(p => p.className === saved.opponentPpCn)) selectedPpCn = saved.opponentPpCn;
    if (typeof saved.applyArmorDurability === 'boolean') applyArmorDurability = saved.applyArmorDurability;
    if (typeof saved.pauseLen === 'number' && saved.pauseLen > 0) pauseLen = saved.pauseLen;
    if (typeof saved.shieldPct === 'number') shieldPct = Math.max(0, Math.min(1, saved.shieldPct));
    if (typeof saved.armorPct === 'number') armorPct = Math.max(0, Math.min(1, saved.armorPct));
    if (saved.distortionMode === 'always' || saved.distortionMode === 'hold') distortionMode = saved.distortionMode;
    if (typeof saved.includeTurrets === 'boolean') includeTurrets = saved.includeTurrets;
  }

  // Power-plant reach defaults to the opponent ship's hull size (deeper plant on
  // bigger ships). A persisted positive override wins so a manual value survives
  // reopen; a persisted 0 does NOT suppress the size default (the size-based
  // default is the baseline - turning the gate off is session-only).
  ppReach = (saved && typeof saved.ppReach === 'number' && saved.ppReach > 0)
    ? saved.ppReach
    : ppReachForSize(opponentMeta.ship?.Size);

  function persistPrefs() {
    saveTtkPrefs({
      opponentShipName: selectedShipName,
      opponentShieldCn: selectedShieldCn,
      opponentPpCn: selectedPpCn,
      applyArmorDurability,
      pauseLen,
      shieldPct,
      armorPct,
      distortionMode,
      ppReach,
      includeTurrets,
    });
  }

  const allWeapons = enumerateLoadoutWeaponsForTtk(
    state.currentLoadout, state.currentSlots, state.currentDisabledPorts,
  );
  // Drop turrets that never engage a ship hull (PDC point-defense + bespoke S1
  // ballistic anti-personnel door guns). They're excluded from BOTH toggle
  // states - they auto-target missiles/boarders, not the opponent we simulate.
  const fireable = allWeapons.filter(w => !w.turretExcluded);
  // Whether the loadout has any usable (combat) turret - gates the "Include
  // turrets" toggle (no point offering it with no fireable turrets).
  const hasTurrets = fireable.some(w => w.isTurret);
  const pilotGuns = fireable.filter(w => !w.isTurret);
  // Turret-only ships (Hammerhead, Redeemer, ...) have nothing to simulate with
  // the toggle off, so the dialog would open on "no weapons" for a fully armed
  // ship. Force the turrets in for this session; NOT persisted, so the saved
  // preference still applies to ships that do have pilot guns.
  if (pilotGuns.length === 0 && hasTurrets) includeTurrets = true;
  // Active weapon set the sim fires: pilot guns only, or + combat turrets when
  // the user opts in. Reassigned by the toggle; closures below read it at call time.
  let weapons = includeTurrets ? fireable : pilotGuns;
  // Whether the loadout carries any distortion damage - gates the distortion-mode
  // toggle + the Distort row. Based on the full fireable set so it stays stable
  // across the turret toggle (no need to re-render the dialog when turrets flip).
  const hasDistortion = fireable.some(w => (w.dmgByType?.dist || 0) > 0);

  /**
   * Upper bound for the pause slider: the longest full-cooldown across equipped
   * weapons that actually reload (continuous-fire weapons are excluded - their
   * fullCooldown is Infinity). Falls back to 30 s when every weapon is
   * continuous-fire, so the slider always has a meaningful range.
   */
  function computeSliderMax() {
    let max = 0;
    for (const w of fireable) {
      const c = w.cadence;
      if (!Number.isFinite(c.magazine) || c.reloadTime <= 0) continue;
      const full = c.magazine * c.shotInterval + c.reloadTime;
      if (full > max) max = full;
    }
    return max > 0 ? Math.max(max, 5) : 30;
  }
  const sliderMax = computeSliderMax();
  // Lower bound: shortest pause at which at least one weapon recovers enough
  // state for one more shot. Below this, every weapon is still locked, so the
  // pause delivers no benefit. Rounded UP to the 0.1 grid so the slider's
  // selectable values (min + 0.1 steps) and the optimal-pause search grid
  // (minPause + 0.1 steps) line up exactly - otherwise the search evaluates
  // off-grid points the user can't select and can miss the true optimum.
  const sliderMin = Math.ceil(computeMinUsefulPause(fireable) * 10) / 10;

  /**
   * Pause-slider default: pick the pauseLen that maximizes effective DPS
   * against the current opponent profile. Searches across [2, sliderMax] at
   * 0.5 s granularity (~16 sim runs, <50 ms total). Falls back to the simple
   * heuristic (damagedDelay - 0.25) when the search produces no candidate
   * (no weapons, degenerate loadout, etc.).
   */
  function defaultPauseFor(shieldCn) {
    if (weapons.length > 0) {
      const tmpOpp = buildOpponentFor(shieldCn);
      if (tmpOpp) {
        const optimal = computeOptimalPauseLen(weapons, tmpOpp, {
          applyArmorDurability,
          distortionMode,
          ppReach,
          minPause: sliderMin,
          maxPause: Math.min(sliderMax, 10),
          step: 0.1,
        });
        if (optimal != null) return optimal;
      }
    }
    // Heuristic fallback when search can't find an optimum.
    const si = shieldCn ? getItemStats(shieldCn) : null;
    const dd = si?.Shield?.DamagedDelay || 0;
    if (dd <= 0) return Math.min(DEFAULT_PAUSE_LEN, sliderMax);
    return Math.max(sliderMin, Math.min(sliderMax, dd - 0.25));
  }

  /**
   * Helper for defaultPauseFor: build a tentative opponent profile for a
   * candidate shield className. Mirrors rebuildOpponent() but takes the shield
   * as a parameter so the search can run BEFORE selectedShieldCn is committed.
   */
  function buildOpponentFor(shieldCn) {
    const { ship, shieldCount, ppCount } = lookupOpponentShip(selectedShipName);
    if (!ship) return null;
    const shieldItem = shieldCn ? getItemStats(shieldCn) : null;
    const ppItem = selectedPpCn ? getItemStats(selectedPpCn) : null;
    return buildTtkOpponentProfile(ship, shieldItem, ppItem, shieldCount, shieldPct, armorPct, ppCount);
  }

  /** Shield's regen-onset time, shown in the slider readout for context. */
  function regenOnsetFor(shieldCn) {
    const si = shieldCn ? getItemStats(shieldCn) : null;
    return si?.Shield?.DamagedDelay || 0;
  }

  // If the saved pauseLen is missing or stale, fall back to the opponent's
  // damagedDelay-derived default for THIS shield (rather than the constant).
  if (!saved || typeof saved.pauseLen !== 'number' || saved.pauseLen <= 0) {
    pauseLen = defaultPauseFor(selectedShieldCn);
  } else {
    // A restored pause can sit outside THIS loadout's slider range - different
    // guns than when it was saved, or a value persisted while a cadence bug
    // inflated the range. `<input type="range">` silently clamps its own value
    // to [min,max], so without this the readout and the sim would keep running
    // on a number the slider no longer displays.
    pauseLen = Math.min(sliderMax, Math.max(sliderMin, pauseLen));
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'lo-build-dialog';
  overlay.innerHTML = `<div class="lo-build-dialog-panel lo-build-wide ttk-panel">
    <div class="ttk-main">
    <div class="lo-build-dialog-header">
      <h3><i class="fa-solid fa-crosshairs"></i> Time to Kill</h3>
      <button class="lo-build-dialog-close" aria-label="Close">&times;</button>
    </div>

    <div class="ttk-section-body">
      <div class="defl-opponent-row">
        <div class="defl-field" id="ttkShipField">
          <span class="defl-field-label">Vehicle</span>
          <div class="ms-toggle defl-toggle" id="ttkShipToggle">
            <span class="defl-toggle-label" id="ttkShipToggleLabel">${escapeHtml(selectedShipName || 'Select a ship…')}</span>
            <span class="ms-arrow">&#9662;</span>
          </div>
          <div class="ms-dropdown defl-dropdown" id="ttkShipDropdown">
            <input type="text" class="search-box ms-search" id="ttkShipSearch" placeholder="Search ships…" autocomplete="off">
            <div class="ms-list defl-list" id="ttkShipList"></div>
          </div>
        </div>
        <div class="defl-field" id="ttkShieldField">
          <span class="defl-field-label">Shield</span>
          <div class="ms-toggle defl-toggle" id="ttkShieldToggle">
            <span class="defl-toggle-label" id="ttkShieldToggleLabel">${escapeHtml(shieldLabelFor(selectedShieldCn, shields) || 'Select a shield…')}</span>
            <span class="ms-arrow">&#9662;</span>
          </div>
          <div class="ms-dropdown defl-dropdown" id="ttkShieldDropdown">
            <input type="text" class="search-box ms-search" id="ttkShieldSearch" placeholder="Search shields…" autocomplete="off">
            <div class="ms-list defl-list" id="ttkShieldList"></div>
          </div>
        </div>
        <div class="defl-field" id="ttkPpField">
          <span class="defl-field-label">Power plant</span>
          <div class="ms-toggle defl-toggle" id="ttkPpToggle">
            <span class="defl-toggle-label" id="ttkPpToggleLabel">${escapeHtml(ppLabelFor(selectedPpCn, plants) || 'Select a power plant…')}</span>
            <span class="ms-arrow">&#9662;</span>
          </div>
          <div class="ms-dropdown defl-dropdown" id="ttkPpDropdown">
            <input type="text" class="search-box ms-search" id="ttkPpSearch" placeholder="Search power plants…" autocomplete="off">
            <div class="ms-list defl-list" id="ttkPpList"></div>
          </div>
        </div>
        <div class="defl-field" id="ttkReachField">
          <span class="defl-field-label" title="Minimum weapon penetration distance (Pen dist) to reach the power plant. Weapons below this can't disable it. Distortion is exempt - it works by aiming at the component section, not by penetration.">Distance to power plant</span>
          <div class="ttk-reach-wrap">
            <input type="number" class="ttk-reach-input" id="ttkPpReach" min="0" step="0.1" value="${ppReach > 0 ? ppReach : ''}" placeholder="0">
            <span class="ttk-reach-unit">m</span>
          </div>
        </div>
      </div>

      <div class="ttk-srow-pair">
        <div class="ttk-stack">
          <span class="ttk-srow-label" title="Starting shield HP - drag to 0% to simulate a shield a teammate already stripped">Shield charge</span>
          <div class="ttk-stack-ctrl">
            <input type="range" class="app-slider" id="ttkShieldSlider" min="0" max="100" step="1" value="${Math.round(shieldPct * 100)}">
            <span class="ttk-srow-val" id="ttkShieldVal">${Math.round(shieldPct * 100)}%</span>
          </div>
        </div>
        <div class="ttk-stack">
          <span class="ttk-srow-label" title="Starting armor HP - drag to 0% to simulate armor that's already been stripped">Armor integrity</span>
          <div class="ttk-stack-ctrl">
            <input type="range" class="app-slider" id="ttkArmorSlider" min="0" max="100" step="1" value="${Math.round(armorPct * 100)}">
            <span class="ttk-srow-val" id="ttkArmorVal">${Math.round(armorPct * 100)}%</span>
          </div>
        </div>
      </div>

      <label class="defl-checkbox ttk-opt-check">
        <input type="checkbox" id="ttkArmorDurChk" class="app-check"${applyArmorDurability ? ' checked' : ''}>
        <span>Apply armor durability</span>
        <a href="https://issue-council.robertsspaceindustries.com/projects/STAR-CITIZEN/issues/STARC-198632"
           target="_blank" rel="noopener" class="defl-options-link"
           title="STARC-198632 - armor durability bug in flux upstream">
          <i class="fa-solid fa-circle-info"></i>
        </a>
      </label>

      <div class="ttk-opp-stats-host"></div>
    </div>

    <div class="lo-section-header"><h3><i class="spvi-gear"></i> Settings</h3>
      <button type="button" class="lo-reset ttk-log-toggle" id="ttkLogToggle">Details ▾</button></div>
    <div class="ttk-section-body">
      <div class="ttk-srow-pair ttk-burst-row">
        <div class="ttk-stack">
          <span class="ttk-srow-label" title="How long the pilot rests between bursts so weapons cool / reload - also the window enemy shields could start regenerating">Cooling / reloading time <span class="ttk-pause-optimal" id="ttkPauseOptimal"></span></span>
          <div class="ttk-stack-ctrl">
            <input type="range" class="app-slider" id="ttkPauseSlider"
                   min="${sliderMin.toFixed(1)}" max="${sliderMax.toFixed(1)}" step="0.1" value="${pauseLen.toFixed(1)}">
            <span class="ttk-srow-val" id="ttkPauseVal">${pauseLen.toFixed(1)} s</span>
          </div>
        </div>
        <div class="ttk-burst-info">
          <div class="ttk-srow-hint" id="ttkPauseHint"></div>
          <div class="ttk-srow-hint" id="ttkBurstHint"></div>
        </div>
      </div>

      ${hasTurrets ? `<label class="defl-checkbox ttk-opt-check" title="Off = pilot guns only (what a solo pilot fires). On = also fire the ship's remote and manned turrets (needs crew).">
        <input type="checkbox" id="ttkTurretsChk" class="app-check"${includeTurrets ? ' checked' : ''}>
        <span>Include manned turrets</span>
      </label>` : ''}
      ${hasDistortion ? `<label class="defl-checkbox ttk-opt-check" title="Optimal play holds distortion until the shield drops (it's 100% absorbed by a live shield). Uncheck to fire distortion from the opening salvo.">
        <input type="checkbox" id="ttkDistHoldChk" class="app-check"${distortionMode === 'hold' ? ' checked' : ''}>
        <span>Hold distortion until shields drop</span>
      </label>` : ''}
    </div>

    <div class="ttk-results-host"></div>
    </div>
    <div class="ttk-log-host" id="ttkLogHost" hidden></div>
  </div>`;
  document.body.appendChild(overlay);

  const oppStatsHost = overlay.querySelector('.ttk-opp-stats-host');
  const resultsHost = overlay.querySelector('.ttk-results-host');

  function rebuildOpponent() {
    const { ship, shieldCount, ppCount } = lookupOpponentShip(selectedShipName);
    const shieldItem = selectedShieldCn ? getItemStats(selectedShieldCn) : null;
    const ppItem = selectedPpCn ? getItemStats(selectedPpCn) : null;
    return buildTtkOpponentProfile(ship, shieldItem, ppItem, shieldCount, shieldPct, armorPct, ppCount);
  }

  function updatePauseHint() {
    const hintEl = overlay.querySelector('#ttkPauseHint');
    const valEl = overlay.querySelector('#ttkPauseVal');
    if (valEl) valEl.textContent = `${pauseLen.toFixed(1)} s`;
    if (!hintEl) return;
    const onset = regenOnsetFor(selectedShieldCn);
    if (onset <= 0) { hintEl.textContent = ''; return; }
    // Tell the user whether their pause prevents shield regen for THIS shield.
    // Pilots don't get this number in-game, so showing it next to the slider is
    // a real design hint - they can move the slider until it dips below onset.
    const safe = pauseLen < onset;
    // Same wording in both states; the colour (green = your pause stays under it,
    // gold = your pause triggers regen) carries the safe/active distinction.
    hintEl.textContent = `Shield regen starts after ${onset.toFixed(2)} s`;
    hintEl.style.color = safe ? 'var(--green-soft)' : 'var(--gold)';
  }

  function updateBurstHint(result) {
    const hintEl = overlay.querySelector('#ttkBurstHint');
    if (!hintEl) return;
    // The warning only fires when the loadout achieves NOTHING - no kill and
    // no disable by any route. A ballistic loadout that never fully breaks the
    // shield but still penetrates to destroy the ship / power plant is working
    // fine; showing a shield warning there is misleading. So gate on "can't
    // kill AND can't disable", not merely "can't break shield".
    const achievesNothing = result
      && result.killVital === Infinity
      && result.disablePowerplant === Infinity
      && result.disableDistortion === Infinity;
    if (achievesNothing && result.breakShields === Infinity) {
      const reason = result.reasons?.breakShields;
      if (reason === 'no shield') {
        hintEl.textContent = '';
        return;
      }
      // Distinguish the failure causes:
      //  1. Pause >= DamagedDelay → regen is plausibly the culprit; a shorter
      //     pause may help.
      //  2. Held distortion + a loadout that can't break the shield with the
      //     rest → distortion's small flat shield damage (it ignores the
      //     absorption taper that throttles ballistics near 0) could tip it.
      //     Suggest firing distortion instead of an absolute "can't".
      //  3. Otherwise → shield damage genuinely too low to deplete it.
      const onset = regenOnsetFor(selectedShieldCn);
      let msg;
      if (onset > 0 && pauseLen >= onset) {
        msg = '⚠ shield out-regens this loadout - shorten the pause';
      } else if (hasDistortion && distortionMode === 'hold') {
        msg = '⚠ shield damage too low - try firing distortion (uncheck Hold)';
      } else {
        msg = '⚠ shield damage too low to deplete it';
      }
      hintEl.textContent = msg;
      hintEl.style.color = 'var(--gold)';
      return;
    }
    // Ideal sustained burst: how long the most-constrained weapon can fire
    // before the next sync pause without entering trickle/overheat, given how
    // much regen/cooling the chosen pause provides. After the initial full
    // burst this is how long each subsequent burst lasts at steady state.
    const ideal = computeIdealBurstDuration(weapons, pauseLen);
    if (ideal == null) { hintEl.textContent = ''; return; }
    hintEl.textContent = `Ideal burst time ${ideal.toFixed(1)} s`;
    hintEl.style.color = 'var(--text2)';
  }

  // Last-rendered sim result, kept so the log section can re-render its
  // table when the user expands it without re-running the sim.
  let lastResult = null;

  function updateOptimalLabel(opponent) {
    const el = overlay.querySelector('#ttkPauseOptimal');
    if (!el || weapons.length === 0 || !opponent) {
      if (el) el.textContent = '';
      return;
    }
    const search = {
      applyArmorDurability,
      distortionMode,
      ppReach,
      minPause: sliderMin,
      maxPause: Math.min(sliderMax, 10),
      step: 0.1,
    };
    const optimal = computeOptimalPauseLen(weapons, opponent, search);
    // The two goals disagree: the kill wants the pause that sustains the most
    // damage, the soft-disable wants one under the enemy generator's decay
    // delay so the pool never bleeds between bursts. Print both rather than
    // making the user pick a mode - the second only when the loadout can
    // actually reach the distortion outcome.
    const distOptimal = hasDistortion
      ? computeOptimalPauseLen(weapons, opponent, { ...search, optimizeFor: 'distortion' })
      : null;
    // Always show the optimal (no hide-when-matched) so the label width is fixed
    // and dragging the slider toward it doesn't make the text pop in and out.
    if (optimal == null) {
      el.textContent = '';
    } else if (distOptimal == null || Math.abs(distOptimal - optimal) < 0.05) {
      el.textContent = `(optimal: ${optimal.toFixed(1)} s)`;
    } else {
      el.textContent = `(optimal: ${optimal.toFixed(1)} s damage · ${distOptimal.toFixed(1)} s distortion)`;
    }
  }

  function refresh() {
    const opponent = rebuildOpponent();
    updatePauseHint();
    oppStatsHost.innerHTML = renderOpponentStats(opponent);
    if (weapons.length === 0) {
      updateBurstHint(null);
      // With turrets available but switched off, the loadout IS armed - say so
      // instead of the flat "no weapons", which reads as a bug on a gunship.
      resultsHost.innerHTML = `<div class="defl-empty">${hasTurrets
        ? 'No pilot-fired weapons on the active loadout - tick "Include manned turrets" to simulate its turret guns.'
        : 'No weapons equipped on the active loadout.'}</div>`;
      const logHost = overlay.querySelector('#ttkLogHost');
      if (logHost) logHost.innerHTML = '';
      lastResult = null;
      return;
    }
    const result = simulateTtk(weapons, opponent, { applyArmorDurability, pauseLen, distortionMode, ppReach, captureLog: true });
    updateBurstHint(result);
    resultsHost.innerHTML = renderResults(result, hasDistortion);
    updateOptimalLabel(opponent);
    lastResult = result;
    // Re-render log only when it's visible (cheap, but no reason to do it
    // when the section is collapsed).
    const logHost = overlay.querySelector('#ttkLogHost');
    if (logHost && !logHost.hidden) {
      logHost.innerHTML = renderLog(result);
    }
  }

  // ── Searchable dropdowns (same pattern as the deflection dialog) ───────────
  function closeAllDropdowns() {
    overlay.querySelectorAll('.defl-dropdown.open').forEach(d => d.classList.remove('open'));
    overlay.querySelectorAll('.defl-toggle.open').forEach(t => t.classList.remove('open'));
  }

  attachSearchableDropdown({
    closeAll: closeAllDropdowns,
    toggle: overlay.querySelector('#ttkShipToggle'),
    dropdown: overlay.querySelector('#ttkShipDropdown'),
    search: overlay.querySelector('#ttkShipSearch'),
    list: overlay.querySelector('#ttkShipList'),
    labelEl: overlay.querySelector('#ttkShipToggleLabel'),
    items: opponentShips.map(n => ({ value: n, label: n, searchText: n })),
    isSelected: (v) => v === selectedShipName,
    onPick: (v) => {
      selectedShipName = v;
      // Recompute opponent meta + filtered shield/PP lists. The Arrow's S1
      // slot won't list capital-ship S5 shields anymore.
      opponentMeta = lookupOpponentShip(selectedShipName);
      shields = listShieldItems(opponentMeta.shieldPort);
      plants = listPowerPlants(opponentMeta.ppPort);
      // Auto-pick this opponent's defaults. If the previously-selected shield
      // / PP is no longer compatible with the new ship, fall back to the
      // first compatible item.
      selectedShieldCn = opponentMeta.defaultShieldCn
        && shields.some(s => s.className === opponentMeta.defaultShieldCn)
        ? opponentMeta.defaultShieldCn
        : (shields.some(s => s.className === selectedShieldCn) ? selectedShieldCn : (shields[0]?.className ?? null));
      selectedPpCn = opponentMeta.defaultPpCn
        && plants.some(p => p.className === opponentMeta.defaultPpCn)
        ? opponentMeta.defaultPpCn
        : (plants.some(p => p.className === selectedPpCn) ? selectedPpCn : (plants[0]?.className ?? null));
      overlay.querySelector('#ttkShieldToggleLabel').textContent = shieldLabelFor(selectedShieldCn, shields) || 'Select a shield…';
      overlay.querySelector('#ttkPpToggleLabel').textContent = ppLabelFor(selectedPpCn, plants) || 'Select a power plant…';
      // New opponent: re-apply the size-based power-plant reach default and sync
      // the input (a different hull size buries its power plant at a different
      // depth). Done before the pause retune so the optimal search sees it.
      ppReach = ppReachForSize(opponentMeta.ship?.Size);
      const reachInput = overlay.querySelector('#ttkPpReach');
      if (reachInput) reachInput.value = ppReach > 0 ? ppReach : '';
      // Retune pause-slider to the new shield's DamagedDelay too.
      pauseLen = defaultPauseFor(selectedShieldCn);
      const slider = overlay.querySelector('#ttkPauseSlider');
      if (slider) slider.value = pauseLen.toFixed(1);
      persistPrefs();
      refresh();
    },
  });

  attachSearchableDropdown({
    closeAll: closeAllDropdowns,
    toggle: overlay.querySelector('#ttkShieldToggle'),
    dropdown: overlay.querySelector('#ttkShieldDropdown'),
    search: overlay.querySelector('#ttkShieldSearch'),
    list: overlay.querySelector('#ttkShieldList'),
    labelEl: overlay.querySelector('#ttkShieldToggleLabel'),
    // Function form: re-evaluated each time the dropdown opens, so it reflects
    // the current opponent's compatible shields.
    items: () => shields.map(s => ({ value: s.className, label: formatTypeGradeLabel(s), searchText: `${s.name} ${s.cls} ${gradeLetter(s.grade)} S${s.size}` })),
    isSelected: (v) => v === selectedShieldCn,
    onPick: (v) => {
      selectedShieldCn = v;
      // Retune pause-slider default to the new opponent shield. We treat this
      // as a fresh recommendation - the user can override afterwards.
      pauseLen = defaultPauseFor(selectedShieldCn);
      const slider = overlay.querySelector('#ttkPauseSlider');
      if (slider) slider.value = pauseLen.toFixed(1);
      persistPrefs(); refresh();
    },
  });

  attachSearchableDropdown({
    closeAll: closeAllDropdowns,
    toggle: overlay.querySelector('#ttkPpToggle'),
    dropdown: overlay.querySelector('#ttkPpDropdown'),
    search: overlay.querySelector('#ttkPpSearch'),
    list: overlay.querySelector('#ttkPpList'),
    labelEl: overlay.querySelector('#ttkPpToggleLabel'),
    items: () => plants.map(p => ({ value: p.className, label: formatTypeGradeLabel(p), searchText: `${p.name} ${p.cls} ${gradeLetter(p.grade)} S${p.size}` })),
    isSelected: (v) => v === selectedPpCn,
    onPick: (v) => { selectedPpCn = v; persistPrefs(); refresh(); },
  });

  overlay.addEventListener('click', (e) => {
    if (!e.target.closest('.defl-field')) closeAllDropdowns();
  });

  overlay.querySelector('#ttkArmorDurChk').addEventListener('change', (e) => {
    applyArmorDurability = e.target.checked;
    persistPrefs();
    refresh();
  });

  if (hasDistortion) {
    overlay.querySelector('#ttkDistHoldChk').addEventListener('change', (e) => {
      distortionMode = e.target.checked ? 'hold' : 'always';
      // Switching policy can shift the optimal pause - retune the default.
      pauseLen = defaultPauseFor(selectedShieldCn);
      const slider = overlay.querySelector('#ttkPauseSlider');
      if (slider) slider.value = pauseLen.toFixed(1);
      persistPrefs();
      refresh();
    });
  }

  if (hasTurrets) {
    overlay.querySelector('#ttkTurretsChk').addEventListener('change', (e) => {
      includeTurrets = e.target.checked;
      // Swap the active firing set, then retune the pause to the new set's
      // optimum (more guns -> different cooling rhythm).
      weapons = includeTurrets ? fireable : pilotGuns;
      pauseLen = defaultPauseFor(selectedShieldCn);
      const slider = overlay.querySelector('#ttkPauseSlider');
      if (slider) slider.value = pauseLen.toFixed(1);
      persistPrefs();
      refresh();
    });
  }

  // Slider recompute is debounced: dragging fires `input` per pixel, and each
  // refresh runs the sim + an ~80-run optimal-pause search. We update the
  // readout label immediately (responsive feel) but defer the heavy recompute
  // until the user pauses for 150 ms.
  let refreshTimer = null;
  function debouncedRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 150);
  }

  overlay.querySelector('#ttkPauseSlider').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    pauseLen = v;
    overlay.querySelector('#ttkPauseVal').textContent = `${v.toFixed(1)} s`;
    persistPrefs();
    debouncedRefresh();
  });

  overlay.querySelector('#ttkShieldSlider').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    shieldPct = v / 100;
    overlay.querySelector('#ttkShieldVal').textContent = `${v}%`;
    persistPrefs();
    debouncedRefresh();
  });

  overlay.querySelector('#ttkArmorSlider').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    armorPct = v / 100;
    overlay.querySelector('#ttkArmorVal').textContent = `${v}%`;
    persistPrefs();
    debouncedRefresh();
  });

  // Power-plant reach: weapons whose penetration distance is below this value
  // can't disable the power plant. Empty / blank = off (0). Debounced like the
  // sliders since typing fires per keystroke and each refresh re-runs the sim.
  overlay.querySelector('#ttkPpReach').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    ppReach = Number.isFinite(v) && v > 0 ? v : 0;
    persistPrefs();
    debouncedRefresh();
  });

  overlay.querySelector('#ttkLogToggle').addEventListener('click', () => {
    const logHost = overlay.querySelector('#ttkLogHost');
    const toggle = overlay.querySelector('#ttkLogToggle');
    const panel = overlay.querySelector('.ttk-panel');
    if (logHost.hidden) {
      logHost.hidden = false;
      panel.classList.add('ttk-panel-with-log');
      toggle.textContent = 'Details ▴';
      if (lastResult) logHost.innerHTML = renderLog(lastResult);
    } else {
      logHost.hidden = true;
      panel.classList.remove('ttk-panel-with-log');
      toggle.textContent = 'Details ▾';
    }
  });

  // Delegated: clicking a burst-end row's "▸ N" toggle expands/collapses the
  // per-shot rows for that cycle. Bound once on the host so it survives log
  // re-renders.
  overlay.querySelector('#ttkLogHost').addEventListener('click', (e) => {
    const toggle = e.target.closest('.ttk-shot-toggle');
    if (!toggle) return;
    const cycle = toggle.dataset.cycle;
    const rows = overlay.querySelectorAll(`.ttk-shot-c${cycle}`);
    const willShow = rows.length > 0 && rows[0].hidden;
    rows.forEach(r => { r.hidden = !willShow; });
    toggle.textContent = `${willShow ? '▾' : '▸'} ${cycle}`;
  });

  // ── Close handlers ─────────────────────────────────────────────────────────
  function close() {
    overlay.removeEventListener('click', onOverlayClick);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onOverlayClick(e) { if (e.target === overlay) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.querySelector('.lo-build-dialog-close').addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKey);

  refresh();
}

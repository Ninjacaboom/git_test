/**
 * Find Deflection calculator - modal dialog.
 *
 * Opens from the loadout build bar. Lets the user pick an opponent vehicle
 * + shield, scale current shield/armor HP via sliders, and see how each
 * weapon in the active loadout fares through the damage chain.
 *
 * Pure rendering layer over `deflectionCalc.js`. Mounts on document.body,
 * rebuilds on each open. State (opponent selection + slider positions) is
 * local to the open dialog instance - no persistence across opens.
 */

import * as state from './loadoutState.js';
import { getItemStats } from './loadoutManager.js';
import { saveDeflectionPrefs, loadDeflectionPrefs } from './stateStore.js';
import {
  enumerateLoadoutWeapons,
  buildOpponentProfile,
  effectiveMitigation,
  simulateShot,
  computeAmmoToBreak,
  shotsToSeconds,
} from './deflectionCalc.js';
import { escapeHtml, fmtNum } from './utils.js';
import { attachSearchableDropdown } from './uiWidgets.js';
import { listShieldItems, lookupOpponentShip } from './loadoutQuery.js';

const fmt = fmtNum;

function pct(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '-';
  return (n * 100).toFixed(digits) + ' %';
}

/** Format a stage-result: a finite shot count, "∞" (Infinity), or "-" (n/a). */
function ammoCell(v) {
  if (v === Infinity) return '∞';
  if (v === 0) return '0';
  return fmt(v);
}

function shieldLabelFor(className, shields) {
  if (!className) return null;
  const s = shields.find(x => x.className === className);
  return s ? `${s.name} (S${s.size})` : className;
}

// ─── Opponent picker data ────────────────────────────────────────────────────

/** Sorted list of opponent vehicles (every ship in the hardpoints DB). */
function listOpponentShips() {
  return [...state.allHardpoints]
    .map(h => h.Name)
    .sort((a, b) => a.localeCompare(b));
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderMitigationTable(opponent) {
  if (!opponent) return '';
  // Shield rows + the deflection threshold reflect the CURRENT shield/armor
  // slider state (absorption scaling, shield-down step, threshold × armorFrac)
  // so the table agrees with the per-weapon chain. Armor durability zeroes out
  // at 0% armor. Hull and component penetration are flat ship properties.
  const eff = effectiveMitigation(opponent);
  const cell = (v, decimals = 0) => fmt(v, decimals);
  // Threshold scales with armor, so it lands on fractional values (41 × 0.75 =
  // 30.75 → "30.8"). Show 1 decimal, but trim a trailing ".0" so whole values
  // read "41" not "41.0" (matches SPViewer).
  const thr = (v) => {
    if (!Number.isFinite(v)) return '-';
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  // Shield resistance: % the shield absorbs. Positive = good for the
  // defender, no negative case in practice but match Stats banner colour
  // convention all the same (green = good for the owner, red = bad).
  const pcell = (v) => {
    if (!Number.isFinite(v) || v === 0) return pct(v, 0);
    const cls = v > 0 ? 'green' : 'red';
    return `<span class="${cls}">${pct(v, 0)}</span>`;
  };
  // Damage-multiplier deltas (durability, hull): displayed as +/-XX%.
  // From the defender's perspective: NEGATIVE delta = less damage taken
  // (green, good). POSITIVE delta = more damage taken (red, bad).
  const sign = (v) => {
    if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return pct(0, 0);
    const txt = (v > 0 ? '+' : '') + pct(v, 0);
    const cls = v < 0 ? 'green' : 'red';
    return `<span class="${cls}">${txt}</span>`;
  };
  // Armor durability only applies while armor remains. Once it's fully
  // stripped (0% armor) there's no armor to carry a durability multiplier,
  // so the row reads 0% (neutral) - matches the gated durMult in the sim.
  const hasArmor = opponent.armor.hp > 0;
  const dur = (mult) => sign((hasArmor ? mult : 1) - 1);
  return `<table class="defl-mitig-table">
    <thead>
      <tr><th></th><th>Physical</th><th>Energy</th><th>Distortion</th></tr>
    </thead>
    <tbody>
      <tr><td>Deflection Threshold</td>
        <td>${thr(eff.threshold.phys)}</td>
        <td>${thr(eff.threshold.energy)}</td>
        <td>${thr(eff.threshold.dist)}</td></tr>
      <tr><td>Shield Resistance</td>
        <td>${pcell(eff.resistance.phys)}</td>
        <td>${pcell(eff.resistance.energy)}</td>
        <td>${pcell(eff.resistance.dist)}</td></tr>
      <tr><td>Shield Absorption</td>
        <td>${pcell(eff.absorption.phys)}</td>
        <td>${pcell(eff.absorption.energy)}</td>
        <td>${pcell(eff.absorption.dist)}</td></tr>
      <tr><td>Armor Durability</td>
        <td>${dur(opponent.armor.durabilityMult.phys)}</td>
        <td>${dur(opponent.armor.durabilityMult.energy)}</td>
        <td>${dur(opponent.armor.durabilityMult.dist)}</td></tr>
      <tr><td>Hull</td>
        <td>${sign(opponent.hull.damageMult.phys - 1)}</td>
        <td>${sign(opponent.hull.damageMult.energy - 1)}</td>
        <td>${sign(opponent.hull.damageMult.dist - 1)}</td></tr>
      <tr><td>Component Penetration</td>
        <td>${sign(opponent.hull.penetration.component - 1)}</td>
        <td>${sign(opponent.hull.penetration.component - 1)}</td>
        <td>${sign(opponent.hull.penetration.component - 1)}</td></tr>
    </tbody>
  </table>`;
}

/**
 * Render the per-weapon rows (one header band + two data rows) for use
 * inside the shared loadout table. The wrapping table (with column
 * headers Shield / Armor / Hull / Components) lives in renderWeaponsTable
 * below - this just emits <tr>s.
 */
function renderWeaponTableRows(w, opponent, simOptions) {
  const shot = simulateShot(w, opponent, simOptions);
  const ammo = computeAmmoToBreak(w, opponent, simOptions);
  const deflectedCls = shot.deflected ? 'defl-weapon-deflected' : '';

  // Distortion-only weapons route their leak through the Component column
  // (with a "dist" suffix) since the powerplant HP pool they target is
  // conceptually a component. We still surface a footnote so the user
  // knows the PP HP isn't tracked in v1, but armor / hull cells show real
  // 0.0 values instead of "-" (distortion just doesn't damage them).
  const isDistortionOnly =
    (w.dmgByType.dist > 0) &&
    (w.dmgByType.phys === 0) &&
    (w.dmgByType.energy === 0);

  const naCell = `<span class="defl-stage-na">-</span>`;
  const deflectedMark =
    `<span class="defl-stage-deflected-val">DEFLECTED</span>`;
  const valCell = (v) => `<span class="defl-stage-val">${fmt(v, 1)}</span>`;

  // Damage cells
  const dmgShield = valCell(shot.shieldDmg);
  const dmgArmor = shot.deflected ? deflectedMark : valCell(shot.armorDmg);
  const dmgHull = valCell(shot.hullDmg);
  // Component cell: regular component penetration damage, or the
  // distortion leak with a "dist" suffix tag for distortion weapons.
  const distLabel = isDistortionOnly && shot.componentDmg > 0
    ? '<span class="defl-stage-unit"> dist</span>'
    : '';
  const dmgComponent = valCell(shot.componentDmg) + distLabel;
  // Penetration distance gets its own column so the Components cell stays
  // a single number (consistent with the other stage cells).
  const dmgPen = shot.penDistance > 0
    ? `<span class="defl-stage-val">${fmt(shot.penDistance, 1)}</span><span class="defl-stage-unit"> m</span>`
    : naCell;

  // Ammo cells (shots to break each stage). Components / Penetration aren't tracked.
  const ammoShield = `<span class="defl-stage-val">${ammoCell(ammo.shield)}</span>`;
  const ammoArmor = isDistortionOnly ? naCell : `<span class="defl-stage-val">${ammoCell(ammo.armor)}</span>`;
  const ammoHull = isDistortionOnly ? naCell : `<span class="defl-stage-val">${ammoCell(ammo.hull)}</span>`;

  // Time-to-break cells: shots ÷ sustained shots-per-second. "-" when the
  // weapon has no usable sustained rate (sustainedDPS 0). Seconds shown with
  // 1 decimal under 10s, whole seconds above.
  const timeCell = (shots) => {
    const secs = shotsToSeconds(shots, w.sustainedDPS, w.alpha);
    if (secs === Infinity) return `<span class="defl-stage-val">∞</span>`;
    if (secs == null) return naCell;
    const txt = secs === 0 ? '0' : (secs < 10 ? secs.toFixed(1) : fmt(Math.round(secs)));
    return `<span class="defl-stage-val">${txt}</span><span class="defl-stage-unit"> s</span>`;
  };
  const timeShield = timeCell(ammo.shield);
  const timeArmor = isDistortionOnly ? naCell : timeCell(ammo.armor);
  const timeHull = isDistortionOnly ? naCell : timeCell(ammo.hull);

  // Crafting quality badge. Reuses the .cc-indicator look from the loadout
  // panel so the badge here reads as the same UI primitive. Rendered as a
  // <span> (not <button>) and without a data-craft-port attribute so the
  // global crafting-popover click handler doesn't pick it up - this is a
  // display-only readout inside the deflection dialog.
  const qCls = w.meanQuality < 500 ? ' cc-q-low' : w.meanQuality > 500 ? ' cc-q-high' : '';
  const qualityBadge = `<span class="cc-indicator${qCls} defl-quality-badge"><i class="fa-solid fa-wrench"></i><span class="cc-quality-badge">${w.meanQuality}</span></span>`;

  return `
    <tr class="defl-weapon-head ${deflectedCls}">
      <td colspan="6">
        <div class="defl-weapon-head-inner">
          <span class="lo-name">${escapeHtml(w.name)}</span>
          ${qualityBadge}
          <span class="defl-row-alpha"><span class="defl-row-alpha-val">${fmt(w.alpha, 1)}</span> alpha</span>
        </div>
      </td>
    </tr>
    <tr class="defl-weapon-cols ${deflectedCls}">
      <th></th>
      <th>Shield</th>
      <th>Armor</th>
      <th>Hull</th>
      <th>Components</th>
      <th>Penetration</th>
    </tr>
    <tr class="defl-weapon-data ${deflectedCls}">
      <td class="defl-chain-row-label">Damage/shot</td>
      <td>${dmgShield}</td>
      <td>${dmgArmor}</td>
      <td>${dmgHull}</td>
      <td>${dmgComponent}</td>
      <td>${dmgPen}</td>
    </tr>
    <tr class="defl-weapon-data ${deflectedCls}">
      <td class="defl-chain-row-label">Shots to break</td>
      <td>${ammoShield}</td>
      <td>${ammoArmor}</td>
      <td>${ammoHull}</td>
      <td>${naCell}</td>
      <td>${naCell}</td>
    </tr>
    <tr class="defl-weapon-data ${deflectedCls}">
      <td class="defl-chain-row-label">Time to break</td>
      <td>${timeShield}</td>
      <td>${timeArmor}</td>
      <td>${timeHull}</td>
      <td>${naCell}</td>
      <td>${naCell}</td>
    </tr>`;
}

/** Build the per-weapon table. Each weapon gets its own column-header
    row (Shield / Armor / Hull / Components / Penetration) so the user
    can read the stage names next to the data without scrolling back
    up to a shared thead. */
function renderWeaponsTable(weapons, opponent, simOptions) {
  if (weapons.length === 0) {
    return `<div class="defl-empty">No weapons equipped on the active loadout.</div>`;
  }
  return `<table class="defl-weapons-table">
    <tbody>
      ${weapons.map(w => renderWeaponTableRows(w, opponent, simOptions)).join('')}
    </tbody>
  </table>`;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export function openDeflectionCalc() {
  if (!state.currentShipName) return;
  if (!state.allHardpoints || state.allHardpoints.length === 0) return;

  // ── Local mutable state for this dialog ────────────────────────────────
  const opponentShips = listOpponentShips();
  let selectedShipName = opponentShips[0];
  let selectedShieldCn = null;
  let shieldPct = 1.0;
  let armorPct = 1.0;
  // Armor durability multiplier is in flux upstream (STARC-198632). Default
  // on (game-realistic if the fix has landed). Toggle off to match the reference
  // mitigation display, which still treats durability as unused.
  let applyArmorDurability = true;

  // Default selection: the active ship's own type so the user sees something
  // sensible immediately. They can switch via the dropdown.
  if (opponentShips.includes(state.currentShipName)) selectedShipName = state.currentShipName;
  const initial = lookupOpponentShip(selectedShipName);
  // Filtered to the opponent's shield port (an M80 only lists S2 shields),
  // same as the TTK dialog. sortBySize: true preserves the deflection
  // dialog's original sort order (size ascending) vs TTK's HP descending.
  let shields = listShieldItems(initial.shieldPort, { sortBySize: true });
  selectedShieldCn = initial.defaultShieldCn || (shields[0]?.className ?? null);

  // Restore the user's previous choices if any. Falls back to the defaults
  // above when a saved value no longer exists in the current game data
  // (e.g. ship was renamed by a patch).
  const savedPrefs = loadDeflectionPrefs();
  if (savedPrefs) {
    if (savedPrefs.opponentShipName && opponentShips.includes(savedPrefs.opponentShipName)) {
      selectedShipName = savedPrefs.opponentShipName;
      // Refresh the filtered shield list for the restored ship BEFORE
      // validating the saved shield - the saved S3 shield is gone if the
      // saved opponent is a fighter.
      const meta = lookupOpponentShip(selectedShipName);
      shields = listShieldItems(meta.shieldPort, { sortBySize: true });
      selectedShieldCn = meta.defaultShieldCn || (shields[0]?.className ?? null);
    }
    if (savedPrefs.opponentShieldCn && shields.some(s => s.className === savedPrefs.opponentShieldCn)) {
      selectedShieldCn = savedPrefs.opponentShieldCn;
    }
    if (typeof savedPrefs.shieldPct === 'number') shieldPct = savedPrefs.shieldPct;
    if (typeof savedPrefs.armorPct === 'number') armorPct = savedPrefs.armorPct;
    if (typeof savedPrefs.applyArmorDurability === 'boolean') {
      applyArmorDurability = savedPrefs.applyArmorDurability;
    }
  }

  function persistPrefs() {
    saveDeflectionPrefs({
      opponentShipName: selectedShipName,
      opponentShieldCn: selectedShieldCn,
      shieldPct,
      armorPct,
      applyArmorDurability,
    });
  }

  const weapons = enumerateLoadoutWeapons(state.currentLoadout, state.currentSlots, state.currentDisabledPorts);

  // ── DOM ───────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'lo-build-dialog';
  overlay.innerHTML = `<div class="lo-build-dialog-panel lo-build-wide defl-panel">
    <div class="lo-build-dialog-header">
      <h3><i class="spvi-Engineering_Icon_ItemShields"></i> Deflection Calculator</h3>
      <button class="lo-build-dialog-close" aria-label="Close">&times;</button>
    </div>

    <div class="defl-opponent-row">
      <div class="defl-field" id="deflShipField">
        <span class="defl-field-label">Opponent vehicle</span>
        <div class="ms-toggle defl-toggle" id="deflShipToggle">
          <span class="defl-toggle-label" id="deflShipToggleLabel">${escapeHtml(selectedShipName || 'Select a ship…')}</span>
          <span class="ms-arrow">&#9662;</span>
        </div>
        <div class="ms-dropdown defl-dropdown" id="deflShipDropdown">
          <input type="text" class="search-box ms-search" id="deflShipSearch" placeholder="Search ships…" autocomplete="off">
          <div class="ms-list defl-list" id="deflShipList"></div>
        </div>
      </div>
      <div class="defl-field" id="deflShieldField">
        <span class="defl-field-label">Opponent shield</span>
        <div class="ms-toggle defl-toggle" id="deflShieldToggle">
          <span class="defl-toggle-label" id="deflShieldToggleLabel">${escapeHtml(shieldLabelFor(selectedShieldCn, shields) || 'Select a shield…')}</span>
          <span class="ms-arrow">&#9662;</span>
        </div>
        <div class="ms-dropdown defl-dropdown" id="deflShieldDropdown">
          <input type="text" class="search-box ms-search" id="deflShieldSearch" placeholder="Search shields…" autocomplete="off">
          <div class="ms-list defl-list" id="deflShieldList"></div>
        </div>
      </div>
    </div>

    <div class="defl-mitig-host"></div>

    <div class="defl-options-row">
      <label class="defl-checkbox">
        <input type="checkbox" id="deflArmorDurChk" class="app-check"${applyArmorDurability ? ' checked' : ''}>
        <span>Apply armor durability</span>
        <a href="https://issue-council.robertsspaceindustries.com/projects/STAR-CITIZEN/issues/STARC-198632"
           target="_blank" rel="noopener" class="defl-options-link"
           title="STARC-198632 - armor durability bug in flux upstream">
          <i class="fa-solid fa-circle-info"></i>
        </a>
      </label>
    </div>

    <div class="defl-sliders">
      <div class="defl-slider-row">
        <span class="defl-slider-label">Shields</span>
        <input type="range" min="0" max="100" value="${Math.round(shieldPct * 100)}" class="defl-slider" id="deflShieldSlider">
        <span class="defl-slider-val" id="deflShieldVal">${Math.round(shieldPct * 100)}%</span>
        <span class="defl-slider-total" id="deflShieldTotal"></span>
      </div>
      <div class="defl-slider-row">
        <span class="defl-slider-label">Armor</span>
        <input type="range" min="0" max="100" value="${Math.round(armorPct * 100)}" class="defl-slider" id="deflArmorSlider">
        <span class="defl-slider-val" id="deflArmorVal">${Math.round(armorPct * 100)}%</span>
        <span class="defl-slider-total" id="deflArmorTotal"></span>
      </div>
    </div>

    <div class="lo-section-header defl-loadout-header"><h3><i class="spvi-weapon"></i> My loadout</h3></div>
    <div class="defl-weapons-host"></div>
  </div>`;
  document.body.appendChild(overlay);

  const mitigHost = overlay.querySelector('.defl-mitig-host');
  const weaponsHost = overlay.querySelector('.defl-weapons-host');
  const shieldSlider = overlay.querySelector('#deflShieldSlider');
  const armorSlider = overlay.querySelector('#deflArmorSlider');
  const shieldVal = overlay.querySelector('#deflShieldVal');
  const armorVal = overlay.querySelector('#deflArmorVal');
  const shieldTotalEl = overlay.querySelector('#deflShieldTotal');
  const armorTotalEl = overlay.querySelector('#deflArmorTotal');

  function rebuildOpponent() {
    const { ship, shieldCount } = lookupOpponentShip(selectedShipName);
    const shieldItem = selectedShieldCn ? getItemStats(selectedShieldCn) : null;
    return buildOpponentProfile(ship, shieldItem, shieldCount, shieldPct, armorPct);
  }

  function refresh() {
    const opponent = rebuildOpponent();
    mitigHost.innerHTML = renderMitigationTable(opponent);
    const sh = opponent.shield;
    shieldTotalEl.textContent = sh.faceCount > 1
      ? `${fmt(sh.hp)} / ${fmt(sh.maxHp)} hp per face (×${sh.faceCount})`
      : `${fmt(sh.hp)} / ${fmt(sh.maxHp)} hp`;
    armorTotalEl.textContent = `${fmt(opponent.armor.hp)} / ${fmt(opponent.armor.maxHp)} hp`;
    const simOptions = { applyArmorDurability };
    weaponsHost.innerHTML = renderWeaponsTable(weapons, opponent, simOptions);
  }

  // ── Searchable dropdowns ──────────────────────────────────────────────
  // Reuses the .ms-toggle / .ms-dropdown / .ms-search / .ms-list pattern
  // from the main ship selector for filter behaviour and keyboard nav.
  // Shared close behaviour: clicking outside any defl-toggle closes all
  // dropdowns inside this overlay.
  function closeAllDropdowns() {
    overlay.querySelectorAll('.defl-dropdown.open').forEach(d => d.classList.remove('open'));
    overlay.querySelectorAll('.defl-toggle.open').forEach(t => t.classList.remove('open'));
  }

  attachSearchableDropdown({
    closeAll: closeAllDropdowns,
    toggle: overlay.querySelector('#deflShipToggle'),
    dropdown: overlay.querySelector('#deflShipDropdown'),
    search: overlay.querySelector('#deflShipSearch'),
    list: overlay.querySelector('#deflShipList'),
    labelEl: overlay.querySelector('#deflShipToggleLabel'),
    items: opponentShips.map(n => ({ value: n, label: n, searchText: n })),
    isSelected: (v) => v === selectedShipName,
    onPick: (v) => {
      selectedShipName = v;
      // Recompute the filtered shield list and auto-pick the opponent's
      // default shield so we don't end up showing a mismatched
      // Shimmer-on-Polaris combo. If the previous selection is no longer
      // compatible, fall back to the first compatible shield.
      const meta = lookupOpponentShip(selectedShipName);
      shields = listShieldItems(meta.shieldPort, { sortBySize: true });
      selectedShieldCn = meta.defaultShieldCn && shields.some(s => s.className === meta.defaultShieldCn)
        ? meta.defaultShieldCn
        : (shields.some(s => s.className === selectedShieldCn) ? selectedShieldCn : (shields[0]?.className ?? null));
      overlay.querySelector('#deflShieldToggleLabel').textContent =
        shieldLabelFor(selectedShieldCn, shields) || 'Select a shield…';
      persistPrefs();
      refresh();
    },
  });

  attachSearchableDropdown({
    closeAll: closeAllDropdowns,
    toggle: overlay.querySelector('#deflShieldToggle'),
    dropdown: overlay.querySelector('#deflShieldDropdown'),
    search: overlay.querySelector('#deflShieldSearch'),
    list: overlay.querySelector('#deflShieldList'),
    labelEl: overlay.querySelector('#deflShieldToggleLabel'),
    // Function form: re-evaluated each time the dropdown opens, so it
    // reflects the current opponent's compatible shields.
    items: () => shields.map(s => ({
      value: s.className,
      label: `${s.name} (S${s.size})`,
      searchText: `${s.name} S${s.size}`,
    })),
    isSelected: (v) => v === selectedShieldCn,
    onPick: (v) => {
      selectedShieldCn = v;
      persistPrefs();
      refresh();
    },
  });

  // Click anywhere outside a dropdown closes them.
  overlay.addEventListener('click', (e) => {
    if (!e.target.closest('.defl-field')) closeAllDropdowns();
  });

  shieldSlider.addEventListener('input', (e) => {
    shieldPct = e.target.value / 100;
    shieldVal.textContent = `${e.target.value}%`;
    persistPrefs();
    refresh();
  });
  armorSlider.addEventListener('input', (e) => {
    armorPct = e.target.value / 100;
    armorVal.textContent = `${e.target.value}%`;
    persistPrefs();
    refresh();
  });

  overlay.querySelector('#deflArmorDurChk').addEventListener('change', (e) => {
    applyArmorDurability = e.target.checked;
    persistPrefs();
    refresh();
  });

  // ── Close handlers ────────────────────────────────────────────────────
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

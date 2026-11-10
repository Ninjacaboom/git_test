/**
 * pipPanel.js - pip allocation panel rendering and interaction.
 */
import * as state from './loadoutState.js';
import {
  buildPipAllocation, calculateCoolingStats,
  calculateStats
} from './loadoutManager.js';
import { savePipAllocation, loadPipAllocation, saveShieldSelection } from './stateStore.js';
import { fmtStat } from './utils.js';

const PIP_TOOLTIPS = {
  weapons: 'Weapons',
  engine: 'Engine / boost',
  shields: 'Shields',
  quantumDrive: 'Quantum drive',
  utility: 'Utility',
  interdiction: 'Interdiction (EMP / QED)',
  mining: 'Mining',
  salvage: 'Salvage',
  radar: 'Radar',
  lifeSupport: 'Life support'
};

// Imported lazily to avoid circular dependencies - assigned by the orchestrator.
// renderStats and renderWeaponColumn/renderSystemsColumn are called from bindPipInteraction;
// they live in statsPanel.js and loadoutUI.js respectively.
// We use a callback pattern set by the orchestrator.
let _renderStats = null;
let _renderWeaponColumn = null;
let _renderSystemsColumn = null;

export function setRenderCallbacks(renderStats, renderWeaponColumn, renderSystemsColumn) {
  _renderStats = renderStats;
  _renderWeaponColumn = renderWeaponColumn;
  _renderSystemsColumn = renderSystemsColumn;
}

export function rebuildPipAllocation(skipRestore) {
  const stats = calculateStats(state.currentLoadout, state.currentDisabledPorts);
  const alloc = buildPipAllocation(state.currentLoadout, state.currentSlots, state.currentShipConfig, stats.powerOutput, state.currentShieldOverrides, state.currentDisabledPorts);

  // Restore saved allocations unless told to skip (e.g. after loadout change)
  if (!skipRestore) {
    const saved = loadPipAllocation(state.currentShipName);
    if (saved) {
      // Validate saved keys match current channels (reject stale saves)
      const currentKeys = new Set(alloc.channels.filter(c => !c.fixed).map(c => c.key));
      const savedKeys = new Set(Object.keys(saved));
      const keysMatch = [...currentKeys].every(k => savedKeys.has(k));

      if (keysMatch) {
        for (const ch of alloc.channels) {
          if (ch.fixed) continue;
          if (saved[ch.key] != null) {
            const cap = ch.needed != null ? Math.min(Math.ceil(ch.needed), ch.max) : ch.max;
            let v = Math.round(Math.min(saved[ch.key], cap));
            // Binary channels (QD) snap to 0 or max - handles legacy saves
            // that may have stored a partial value from before this guard.
            if (ch.binary) v = v > 0 ? cap : 0;
            // A running cooler always draws at least MinConsumptionFraction of
            // its segment, so anything between 1 and min-1 is unreachable.
            // Legacy saves can hold such a value from before the default
            // allocation became min-aware; snap it up to min.
            else if (ch.key.startsWith('cooler_') && v > 0 && v < ch.min) v = Math.min(ch.min, cap);
            ch.allocated = v;
          }
        }
        // Validate total budget (both over and under) - shields only count powered pips
        const total = alloc.channels.reduce((s, c) => {
          if (c.key === 'shields') return s + Math.min(c.allocated, (c.shieldSlots || []).filter(x => x.powered).reduce((sum, x) => sum + x.max, 0));
          return s + c.allocated;
        }, 0);
        if (total > alloc.powerOutput || total < alloc.channels.reduce((s, c) => s + c.min, 0)) {
          // Invalid budget - reset to defaults
          const fresh = buildPipAllocation(state.currentLoadout, state.currentSlots, state.currentShipConfig, stats.powerOutput, state.currentShieldOverrides, state.currentDisabledPorts);
          alloc.channels = fresh.channels;
        }
      }
    }
  }

  state.setCurrentPipAllocation(alloc);
}

export function renderPipPanel() {
  if (!state.currentPipAllocation) return '';
  const { channels, powerOutput } = state.currentPipAllocation;
  // Budget display: for shields, only powered pips consume the power budget
  const totalAllocated = channels.reduce((s, c) => {
    if (c.key === 'shields') {
      // Only powered shields' allocated pips count toward budget
      const poweredPips = (c.shieldSlots || []).filter(s => s.powered).reduce((sum, s) => sum + s.max, 0);
      return s + Math.min(c.allocated, poweredPips);
    }
    return s + c.allocated;
  }, 0);

  let columnsHtml = '';
  for (const ch of channels) {
    const isEmpty = ch.max === 0;
    // Skip empty cooler slots entirely (no icon in power distribution)
    if (isEmpty && ch.key.startsWith('cooler_')) continue;
    const isFixed = ch.fixed;
    const iconKey = ch.key.startsWith('cooler_') ? 'cooler' : ch.key;
    const icon = state.PIP_ICONS[iconKey] || '';

    // Shields↔QD mutual exclusion visual
    const shieldsOn = channels.find(c => c.key === 'shields')?.allocated > 0;
    const qdDisabled = ch.key === 'quantumDrive' && shieldsOn;
    const shieldsDisabled = ch.key === 'shields' && channels.find(c => c.key === 'quantumDrive')?.allocated > 0;

    let colClass = 'pip-column';
    if (isEmpty) colClass += ' empty';
    if (isFixed) colClass += ' fixed';
    if (qdDisabled || shieldsDisabled) colClass += ' mutual-off';
    else if (!isEmpty && !isFixed && ch.allocated === 0) colClass += ' powered-off';

    // Build segments: [{pipValue, pipEnd}] - pipEnd is the cumulative pip at the top of that segment
    // For shields, interleave per-shield min blocks + optional pips
    // For others, one min block (if min > 1) + individual 1-pip blocks
    const segments = [];
    if (ch.binary) {
      // Binary channel (QD): single tall block representing the full segment.
      // Clicking anywhere on it toggles 0/max - no fractional pips.
      segments.push({ pipValue: ch.max, pipEnd: ch.max });
    } else if (ch.key === 'shields' && ch.shieldSlots) {
      // Show ALL shields: powered shields first, then unpowered
      const powered = ch.shieldSlots.filter(s => s.max > 0 && s.powered);
      let cumPip = 0;
      // Powered shields: min blocks + optional individual pips
      for (const s of powered) {
        if (s.min > 0) { cumPip += s.min; segments.push({ pipValue: s.min, pipEnd: cumPip, shieldHp: true }); }
      }
      for (const s of powered) {
        const optional = s.max - s.min;
        for (let i = 0; i < optional; i++) { cumPip++; segments.push({ pipValue: 1, pipEnd: cumPip, shieldHp: false }); }
      }
      // Unpowered shields: hidden from pip view to keep allocation clean
    } else {
      const chMin = ch.min || 0;
      let cumPip = 0;
      if (chMin > 1) { cumPip = chMin; segments.push({ pipValue: chMin, pipEnd: cumPip }); }
      else if (chMin === 1) { cumPip = 1; segments.push({ pipValue: 1, pipEnd: 1 }); }
      const effective = ch.needed != null ? Math.min(Math.ceil(ch.needed), ch.max) : ch.max;
      for (let p = chMin + 1; p <= effective; p++) { cumPip = p; segments.push({ pipValue: 1, pipEnd: p }); }
    }

    // Build pip blocks - pip-stack has fixed height and flex-end alignment
    let blocksHtml = '';
    // Render segments top-to-bottom (reverse order since top segment = highest pip)
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const isActive = seg.pipEnd <= ch.allocated;
      const heightPx = seg.pipValue > 1 ? `style="height:${seg.pipValue * 10 - 2}px"` : '';
      let cls = 'pip-block';
      if (seg.unpowerable) cls += ' unpowerable';
      else if (isActive) cls += seg.shieldHp === true ? ' active shield-hp' : seg.shieldHp === false ? ' active shield-bonus' : ' active';
      blocksHtml += `<div class="${cls}" data-pip="${seg.pipEnd}" ${heightPx}></div>`;
    }

    columnsHtml += `<div class="${colClass}" data-key="${ch.key}">
      <div class="pip-stack">${blocksHtml}</div>
      <div class="pip-icon" data-tip="${PIP_TOOLTIPS[ch.key] || (ch.key.startsWith('cooler_') ? 'Cooler ' + (parseInt(ch.key.split('_')[1]) + 1) : ch.label)}">${icon}</div>
    </div>`;
  }

  const coolingHtml = renderCoolingBar();
  const sigHtml = renderSignatures();

  return `<div class="pip-panel">
    <div class="pip-header">
      <h3 data-tip="Power distribution"><i class="spvi-electric"></i> Power Distribution</h3>
      <span class="pip-budget${totalAllocated > powerOutput ? ' over-budget' : ''}" data-tip="Allocated / total pips">${totalAllocated} / ${powerOutput}</span>
    </div>
    <div class="pip-columns">${columnsHtml}</div>
    ${coolingHtml}
    ${sigHtml}
  </div>`;
}

export function renderCoolingBar() {
  if (!state.currentPipAllocation || !state.currentSlots) return '';
  const { channels } = state.currentPipAllocation;
  const cooling = calculateCoolingStats(channels, state.currentLoadout, state.currentSlots);
  const pct = cooling.coolingPercent;
  const capped = pct === Infinity ? 150 : Math.min(pct, 150);

  const toTrack = v => (Math.min(v, 150) / 150) * 100;
  const blueEnd = toTrack(Math.min(capped, 100));
  const redStart = toTrack(100);
  const redWidth = capped > 100 ? toTrack(capped) - redStart : 0;

  const pctColor = (pct > 100 || pct === Infinity) ? '#e04040' : '#3b9dd9';
  const fanIcon = '<i class="spvi-icon_common_coolant"></i>';
  const markerLeft = toTrack(100);

  return `<div class="cooling-bar-panel" data-supply="${cooling.coolingSupply}" data-demand="${cooling.coolingDemand}">
    <div class="cooling-bar-row">
      <span class="cooling-bar-icon" style="color:${pctColor}">${fanIcon}</span>
      <div class="cooling-bar-track">
        <div class="cooling-bar-fill" style="width:${blueEnd}%;background:#3b9dd9"></div>
        ${redWidth > 0 ? `<div class="cooling-bar-fill cooling-bar-seg" style="left:${redStart}%;width:${redWidth}%;background:#e04040"></div>` : ''}
        <div class="cooling-bar-marker" style="left:${markerLeft}%"></div>
      </div>
      <span class="cooling-bar-pct" style="color:${pctColor}">${pct === Infinity ? '\u221E' : pct.toFixed(1)} %</span>
    </div>
  </div>`;
}

export function renderSignatures() {
  const { em, ir, cs } = state.currentSignatures;
  const csText = cs ? `${fmtStat(cs.Front)} x ${fmtStat(cs.Side)} x ${fmtStat(cs.Top)}` : '\u2014';
  return `<div class="sig-panel">
    <div class="sig-row">
      <div class="sig-item" data-tip="EM signature">
        <i class="spvi-electric sig-icon"></i>
        <span class="sig-value">${fmtStat(em)}</span><span class="sig-label" data-tip="EM signature">EM</span>
      </div>
      <div class="sig-item" data-tip="IR signature">
        <i class="spvi-infrared sig-icon"></i>
        <span class="sig-value">${fmtStat(ir)}</span><span class="sig-label" data-tip="IR signature">IR</span>
      </div>
    </div>
    <div class="sig-row">
      <div class="sig-item" data-tip="Cross-section">
        <i class="spvi-icon_common_cross_section sig-icon"></i>
        <span class="sig-value">${csText}</span><span class="sig-label" data-tip="Cross-section">CS</span>
      </div>
    </div>
  </div>`;
}

export function bindPipInteraction(container) {
  if (!state.currentPipAllocation) return;
  const { channels, powerOutput } = state.currentPipAllocation;
  const byKey = {};
  for (const ch of channels) byKey[ch.key] = ch;

  container.querySelectorAll('.pip-column:not(.empty):not(.fixed)').forEach(col => {
    const key = col.dataset.key;
    const ch = byKey[key];
    if (!ch) return;

    // Click on pip block
    col.querySelectorAll('.pip-block[data-pip]').forEach(block => {
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        if (block.classList.contains('unpowerable')) return;
        const pip = parseInt(block.dataset.pip);
        const oldAlloc = ch.allocated;
        const effectiveMax = ch.poweredMax != null ? ch.poweredMax : ch.max;
        const cap = ch.needed != null ? Math.min(Math.ceil(ch.needed), effectiveMax) : effectiveMax;
        // Binary channels (QD): clicking the block toggles 0/max instead of
        // accepting fractional pip counts.
        const newAlloc = ch.binary
          ? (ch.allocated > 0 ? 0 : cap)
          : Math.min(pip, cap);

        // Shield↔QD exclusion
        if (key === 'shields' && newAlloc > 0 && byKey['quantumDrive']) byKey['quantumDrive'].allocated = 0;
        if (key === 'quantumDrive' && newAlloc > 0 && byKey['shields']) byKey['shields'].allocated = 0;

        ch.allocated = newAlloc;
        savePipAllocation(state.currentShipName, channels);
        if (_renderStats) _renderStats();
        if (key === 'weapons' && oldAlloc !== newAlloc && _renderWeaponColumn) _renderWeaponColumn();
        if (oldAlloc !== newAlloc && _renderSystemsColumn) _renderSystemsColumn();
      });
    });

    // Click on icon: toggle off/on
    const icon = col.querySelector('.pip-icon');
    if (icon) {
      icon.addEventListener('click', () => {
        const oldAlloc = ch.allocated;
        if (ch.allocated > 0) {
          ch._prevAlloc = ch.allocated;
          ch.allocated = 0;
        } else {
          const cap = ch.needed != null ? Math.min(Math.ceil(ch.needed), ch.max) : ch.max;
          const restore = ch._prevAlloc || cap;
          ch.allocated = Math.min(restore, cap);

          // Shield↔QD exclusion
          if (key === 'shields' && ch.allocated > 0 && byKey['quantumDrive']) byKey['quantumDrive'].allocated = 0;
          if (key === 'quantumDrive' && ch.allocated > 0 && byKey['shields']) byKey['shields'].allocated = 0;
        }
        savePipAllocation(state.currentShipName, channels);
        if (_renderStats) _renderStats();
        // Re-render slots when pips change (affects energy ammo / radar range)
        if (key === 'weapons' && oldAlloc !== ch.allocated && _renderWeaponColumn) _renderWeaponColumn();
        if (oldAlloc !== ch.allocated && _renderSystemsColumn) _renderSystemsColumn();
      });
    }
  });
}

/**
 * Crafting summary modal - opens a shopping-list view of every craftable
 * component on the current loadout with aggregated material costs. Per-row
 * checkbox lets the user opt rows in/out; totals recompute live.
 *
 * Pure rendering layer over `craftingSummary.js`. Mounts on document.body,
 * cleans up on close. No persistent state - the modal is rebuilt each time
 * it opens.
 */

import * as state from './loadoutState.js';
import { buildSummary, aggregateTotals } from './craftingSummary.js';
import { hasCraftingData } from './loadoutManager.js';
import { getResource } from './craftingUI.js';
import { escapeHtml } from './utils.js';

/** Format `Quantity` per the resource's UnitType. SCU keeps decimals, Units rounds. */
function formatQty(qty, unitType) {
  if (qty == null) return '';
  if (unitType === 'SCU') return qty.toFixed(2);
  // "Units" / "Item" / falsy → integer display
  return String(Math.round(qty));
}

function unitLabel(unitType) {
  return unitType === 'SCU' ? 'SCU' : 'Items';
}

function resourceRowHtml(guid, qty, { compact = false } = {}) {
  const res = getResource(guid);
  const name = res?.Name || 'Unknown';
  const ut = res?.UnitType;
  const pillCls = ut === 'SCU' ? 'craft-pill craft-pill-scu' : 'craft-pill craft-pill-units';
  if (compact) {
    return `<span class="${pillCls}">${escapeHtml(name)} ${formatQty(qty, ut)} ${unitLabel(ut)}</span>`;
  }
  return `<div class="lo-summary-row">
    <span>${escapeHtml(name)}</span>
    <span class="craft-total-qty">${formatQty(qty, ut)} <span class="craft-total-unit">${unitLabel(ut)}</span></span>
  </div>`;
}

function renderTotalsList(items, includedSet) {
  const totals = aggregateTotals(items, includedSet);
  if (totals.size === 0) {
    return `<div class="craft-total-empty">No items selected.</div>`;
  }
  // Sort totals by resource name (alpha) for predictable order.
  const sorted = [...totals.entries()].sort((a, b) => {
    const aName = getResource(a[0])?.Name || '';
    const bName = getResource(b[0])?.Name || '';
    return aName.localeCompare(bName);
  });
  return sorted.map(([guid, qty]) => resourceRowHtml(guid, qty)).join('');
}

function renderRow(item, included) {
  // Resource pills, sorted by name within each component.
  const sortedCosts = [...item.costs.entries()].sort((a, b) => {
    const aName = getResource(a[0])?.Name || '';
    const bName = getResource(b[0])?.Name || '';
    return aName.localeCompare(bName);
  });
  const pillsHtml = sortedCosts.map(([guid, qty]) => resourceRowHtml(guid, qty, { compact: true })).join(' ');
  const checked = included ? 'checked' : '';
  // <div>, not <label>, because the global `label{}` rule applies
  // text-transform:uppercase that would override the .lo-name styling. Click
  // anywhere on the row toggles the checkbox via the bound handler.
  return `<div class="lo-slot craft-summary-row" data-cn="${escapeHtml(item.className)}">
    <input type="checkbox" class="craft-summary-check app-check" ${checked}>
    <span class="lo-name">${escapeHtml(item.name)} <span class="lo-count">x${item.count}</span></span>
    <div class="craft-summary-resources">${pillsHtml}</div>
  </div>`;
}

export function openCraftingSummary() {
  if (!hasCraftingData()) return; // no blueprint data, nothing to show

  const items = buildSummary(state.currentLoadout, state.currentSlots, state.currentCrafting);

  // Initial checkbox set: components flagged as customized (user swap or
  // non-default quality). Stock-default-only rows start unchecked but the user
  // can opt in via the checkbox or the "All" toolbar button.
  const included = new Set(items.filter(i => i.defaultIncluded).map(i => i.className));

  const overlay = document.createElement('div');
  // Re-use the established dialog frame: .lo-build-dialog (overlay) +
  // .lo-build-dialog-panel.lo-build-wide (560px panel) so the modal inherits
  // the same z-index/border/header styling as the Save/Load loadout dialog.
  // Title is the feature name only - the active ship is visible behind the
  // overlay in the loadout panel, no need to repeat it here. Same convention
  // as the Deflection Calculator dialog.
  overlay.className = 'lo-build-dialog';
  overlay.innerHTML = `<div class="lo-build-dialog-panel lo-build-wide">
    <div class="lo-build-dialog-header">
      <h3><i class="fa-solid fa-wrench"></i> Crafting Summary</h3>
      <button class="lo-build-dialog-close" aria-label="Close">&times;</button>
    </div>
    ${items.length === 0
      ? `<div class="craft-summary-empty">No craftable components on this loadout.</div>`
      : `<div class="lo-build-dialog-actions">
          <button class="lo-reset craft-summary-all">Select all</button>
          <button class="lo-reset craft-summary-none">Select none</button>
        </div>
        <div class="lo-build-dialog-list">
          ${items.map(it => renderRow(it, included.has(it.className))).join('')}
        </div>
        <div class="craft-summary-totals">
          <div class="lo-section-header"><h3><i class="spvi-icon_common_3D_cargo_boxes"></i> Total Resources</h3></div>
          <div class="craft-summary-totals-list">${renderTotalsList(items, included)}</div>
        </div>`}
  </div>`;

  document.body.appendChild(overlay);

  // ── Close handlers ────────────────────────────────────────────────────────
  function close() {
    overlay.removeEventListener('click', onOverlayClick);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onOverlayClick(e) {
    if (e.target === overlay) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  overlay.querySelector('.lo-build-dialog-close')?.addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKey);

  if (items.length === 0) return;

  // ── Checkbox toggles ──────────────────────────────────────────────────────
  const totalsList = overlay.querySelector('.craft-summary-totals-list');
  function refreshTotals() {
    totalsList.innerHTML = renderTotalsList(items, included);
  }

  // Click anywhere on the row toggles the checkbox (we use <div>, not <label>,
  // to avoid the global label{text-transform} rule clobbering inner text).
  overlay.querySelectorAll('.craft-summary-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const cb = row.querySelector('.craft-summary-check');
      if (!cb) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      const cn = row.dataset.cn;
      if (cb.checked) included.add(cn);
      else included.delete(cn);
      refreshTotals();
    });
  });

  // ── Toolbar: select all / none ────────────────────────────────────────────
  overlay.querySelector('.craft-summary-all')?.addEventListener('click', () => {
    for (const it of items) included.add(it.className);
    overlay.querySelectorAll('.craft-summary-check').forEach(cb => cb.checked = true);
    refreshTotals();
  });
  overlay.querySelector('.craft-summary-none')?.addEventListener('click', () => {
    included.clear();
    overlay.querySelectorAll('.craft-summary-check').forEach(cb => cb.checked = false);
    refreshTotals();
  });
}

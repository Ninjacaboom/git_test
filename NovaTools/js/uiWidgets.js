/**
 * uiWidgets.js - shared dropdown widgets.
 *
 * Replaces four near-identical per-file implementations: the checkbox
 * multi-selects in ui.js (weapon finder filters) and weaponColumn.js
 * (picker filters), and the searchable single-selects in ttkCalcUI.js and
 * deflectionCalcUI.js (opponent/shield/power-plant pickers).
 */
import { escapeHtml, bindGlobalDropdownCloser } from './utils.js';

/**
 * Checkbox multi-select over a .ms-toggle / .ms-dropdown pair.
 *
 * An empty checkedSet means "all" - ticking every box clears the set back
 * to that state. Persisted state in checkedSet is reflected when the widget
 * is (re)built.
 *
 * @param {Object} opts
 * @param {Document|Element} [opts.scope] - where to resolve the ids and
 *   which subtree "close other dropdowns" applies to. Defaults to document;
 *   the weapon picker passes its overlay so its two filters only affect
 *   each other.
 */
export function buildMultiSelect({ scope = document, toggleId, dropdownId, values, checkedSet, allLabel, pluralLabel, onChange, labelFn }) {
  const toggle = scope.querySelector('#' + toggleId);
  const dropdown = scope.querySelector('#' + dropdownId);
  if (!toggle || !dropdown) return;
  dropdown.innerHTML = '';

  function updateToggleText() {
    if (checkedSet.size === 0 || checkedSet.size === values.length) {
      toggle.innerHTML = `${allLabel} <span class="ms-arrow">&#9662;</span>`;
    } else if (checkedSet.size === 1) {
      const val = [...checkedSet][0];
      toggle.innerHTML = `${labelFn ? labelFn(val) : val} <span class="ms-arrow">&#9662;</span>`;
    } else {
      toggle.innerHTML = `${checkedSet.size} ${pluralLabel} <span class="ms-arrow">&#9662;</span>`;
    }
  }

  values.forEach(val => {
    const opt = document.createElement('div');
    opt.className = 'ms-option';
    if (checkedSet.has(val)) opt.classList.add('checked');
    const label = document.createElement('span');
    label.textContent = labelFn ? labelFn(val) : val;
    opt.appendChild(label);
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkedSet.has(val)) checkedSet.delete(val);
      else checkedSet.add(val);
      opt.classList.toggle('checked', checkedSet.has(val));
      // If all are checked, clear to mean "all"
      if (checkedSet.size === values.length) checkedSet.clear();
      updateToggleText();
      onChange();
    });
    dropdown.appendChild(opt);
  });

  // Reflect any pre-populated set on the toggle button label (e.g. "2 Sizes"
  // instead of "All Sizes" when the picker reopens with persisted filters).
  updateToggleText();

  toggle.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('open');
    scope.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
    scope.querySelectorAll('.ms-toggle.open').forEach(t => t.classList.remove('open'));
    if (!isOpen) {
      dropdown.classList.add('open');
      toggle.classList.add('open');
    }
  };

  bindGlobalDropdownCloser();
}

/**
 * Searchable single-select dropdown with keyboard navigation.
 *
 * `items` may be an array OR a function `() => array` evaluated fresh each
 * time the list renders - the function form is used by the shield/PP
 * dropdowns so they always reflect the current opponent's compatible items
 * rather than a stale snapshot taken at mount. Items are shaped
 * { value, label, searchText }.
 *
 * `closeAll` is the caller's "close every dropdown in my dialog" routine,
 * invoked before opening this one.
 */
export function attachSearchableDropdown({ toggle, dropdown, search, list, labelEl, items, isSelected, onPick, closeAll }) {
  const getItems = typeof items === 'function' ? items : () => items;
  let keynav = -1;

  function applyKeynavClass() {
    const opts = list.querySelectorAll('.ms-ship-opt');
    opts.forEach((el, i) => el.classList.toggle('keynav', i === keynav));
    if (keynav >= 0 && opts[keynav]) opts[keynav].scrollIntoView({ block: 'nearest' });
  }

  function renderList(filter) {
    const allItems = getItems();
    const q = (filter || '').toLowerCase();
    const filtered = q ? allItems.filter(it => it.searchText.toLowerCase().includes(q)) : allItems;
    list.innerHTML = filtered.map(it =>
      `<div class="ms-ship-opt${isSelected(it.value) ? ' active' : ''}" data-value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</div>`
    ).join('');
    list.querySelectorAll('.ms-ship-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        const v = opt.dataset.value;
        labelEl.textContent = allItems.find(it => it.value === v)?.label || v;
        dropdown.classList.remove('open');
        toggle.classList.remove('open');
        onPick(v);
      });
    });
    keynav = filtered.length > 0 ? 0 : -1;
    applyKeynavClass();
  }

  toggle.addEventListener('click', () => {
    const wasOpen = dropdown.classList.contains('open');
    if (closeAll) closeAll();
    if (!wasOpen) {
      dropdown.classList.add('open');
      toggle.classList.add('open');
      search.value = '';
      renderList('');
      search.focus();
    }
  });
  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('keydown', (e) => {
    const opts = list.querySelectorAll('.ms-ship-opt');
    if (opts.length === 0 && e.key !== 'Escape') return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        keynav = Math.min(opts.length - 1, keynav + 1);
        applyKeynavClass();
        break;
      case 'ArrowUp':
        e.preventDefault();
        keynav = Math.max(0, keynav - 1);
        applyKeynavClass();
        break;
      case 'Enter':
        e.preventDefault();
        if (keynav >= 0 && opts[keynav]) opts[keynav].click();
        break;
      case 'Escape':
        e.preventDefault();
        dropdown.classList.remove('open');
        toggle.classList.remove('open');
        break;
    }
  });
}

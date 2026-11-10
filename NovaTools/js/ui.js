import { getImmuneShips, tierRank, CLEARS_FIGHTERS_TIER } from './tierEngine.js';
import { saveHash } from './stateStore.js';
import { escapeHtml } from './utils.js';
import { buildMultiSelect } from './uiWidgets.js';

let selectedWeapon = null;
let sortCol = null;
let sortAsc = true;
let allShips = [];
let allWeapons = [];

const TABLE_COLS = [
  { key: 'Name', label: 'Ship Name' },
  { key: 'Role', label: 'Role' },
  { key: 'Size', label: 'Size' },
  { key: 'Deflection physical', label: 'Defl. Physical', num: true },
  { key: 'Deflection energy', label: 'Defl. Energy', num: true },
  { key: 'Resist physical', label: 'Phys. Resist', num: true, pct: true },
  { key: 'Resist energy', label: 'Energy Resist', num: true, pct: true }
];

function thouSep(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function fmt(v) {
  if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return '\u2014';
  if (typeof v === 'number') {
    const n = Math.round(v);
    if (n >= 1000) {
      const k = n / 1000;
      return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
    }
    return thouSep(n);
  }
  return String(v);
}

function fmtFull(v) {
  if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return '\u2014';
  if (typeof v === 'number') return thouSep(Math.round(v));
  return String(v);
}

function fmtDps(v) {
  if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return '\u2014';
  if (typeof v === 'number') {
    const s = v % 1 === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  return String(v);
}

let checkedTypes = new Set();
let checkedSizes = new Set();

function renderWeaponList() {
  const search = document.getElementById('weaponSearch').value.toLowerCase();
  const minSpeed = parseFloat(document.getElementById('filterSpeed').value) || 0;
  const maxSpeed = parseFloat(document.getElementById('filterSpeedMax').value) || 0;

  const filtered = allWeapons.filter(w => {
    if (search && !((w.Name || '').toLowerCase().includes(search) || (w.Type || '').toLowerCase().includes(search))) return false;
    if (checkedTypes.size > 0 && !checkedTypes.has(w.Type)) return false;
    if (checkedSizes.size > 0 && !checkedSizes.has(String(w.Size))) return false;
    if (minSpeed && (Number(w.Speed) || 0) < minSpeed) return false;
    if (maxSpeed && (Number(w.Speed) || 0) > maxSpeed) return false;
    return true;
  });

  document.getElementById('weaponCount').textContent = filtered.length;
  const list = document.getElementById('weaponList');
  list.innerHTML = '';

  filtered.forEach(w => {
    const div = document.createElement('div');
    div.className = 'weapon-item' +
      (selectedWeapon === w ? ' active' : '') +
      (w._tier ? ' tier-' + w._tier : '') +
      (w.sold === 0 ? ' loot-only' : '');
    const dmgType = (w.Type || '').replace(/\s*(Cannon|Repeater|Gatling|Scattergun|Beam)$/i, '');
    const veh = w.Vehicle ? ` (${escapeHtml(w.Vehicle)})` : '';
    div.innerHTML = `<div class="wi-name">${escapeHtml(w.Name)}${veh}</div>` +
      `<div class="wi-meta">S${w.Size} \u00b7 ${dmgType} \u00b7 Alpha ${fmt(w.Alpha)} \u00b7 Sustained ${fmt(w.Sustained)} \u00b7 Speed ${fmtFull(w.Speed)}</div>`;
    div.onclick = () => selectWeapon(w);
    list.appendChild(div);
  });
}

function selectWeapon(w) {
  selectedWeapon = w;
  saveHash({ weapon: w.Name + (w.Vehicle ? '|' + w.Vehicle : ''), ship: null });
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('results').classList.add('visible');
  renderWeaponList();
  renderStatCard(w);
  renderResults(w);
}

function renderStatCard(w) {
  const alphaDisplay = w.Pellets
    ? `${fmtFull(w.Alpha)} / ${fmtFull(w.PerPellet)} (x${w.Pellets})`
    : fmtFull(w.Alpha);
  const alphaLabel = w.Pellets ? 'Alpha / Per Pellet' : 'Alpha';

  const singleShot = w.Pellets || w.IsCharged;
  const ammoDisplay = singleShot
    ? (w.IsEnergy ? `1 / \u221E` : `1 / ${fmtFull(w.AmmoCapacity)}`)
    : (w.IsEnergy ? `${fmtFull(w.AmmoMax)} / \u221E` : `${fmtFull(w.AmmoEffective)} / ${fmtFull(w.AmmoCapacity)}`);

  const fields = [
    ['Name', escapeHtml(w.Name), true, true],
    ['Manufacturer', w.Manufacturer ? escapeHtml(w.Manufacturer) : w.Manufacturer, false, true],
    ['Type', w.Type],
    ['Size', w.Size],
    [alphaLabel, alphaDisplay, true],
    ['Burst DPS', fmtDps(w.Burst), true],
    ['Sustained DPS', fmtDps(w.Sustained), true],
    ['Speed', fmtFull(w.Speed), true],
    ['Ammo', ammoDisplay],
    ['RPM', fmt(w.RPM)],
    ['Range', fmtFull(w.Range)],
    ['Pen dist', w.PenDist != null ? w.PenDist : '\u2014'],
    ['Health', fmtFull(w.Health)]
  ];
  document.getElementById('statCard').innerHTML =
    '<h2><i class="spvi-weaponturret"></i> Selected Weapon</h2><div class="stat-grid">' +
    fields.map(([l, v, hi, wide]) =>
      `<div class="stat-item${wide ? ' wide' : ''}"><div class="sl">${l}</div><div class="sv${hi ? ' cyan' : ''}">${v || '\u2014'}</div></div>`
    ).join('') +
    '</div>';
}

function renderResults(w) {
  const { immune, bypass } = getImmuneShips(w, allShips);
  const banner = document.getElementById('immunityBanner');
  const tableWrap = document.getElementById('tableWrap');

  if (bypass) {
    banner.className = 'immunity-banner safe';
    banner.textContent = 'This weapon can damage all ships \u2014 deflection does not apply';
    tableWrap.style.display = 'none';
    return;
  }

  tableWrap.style.display = '';
  if (immune.length === 0) {
    banner.className = 'immunity-banner safe';
  } else if (tierRank(w._tier) >= tierRank(CLEARS_FIGHTERS_TIER)) {
    banner.className = 'immunity-banner partial';
  } else {
    banner.className = 'immunity-banner warn';
  }
  banner.textContent = `${immune.length} of ${allShips.length} ships are immune to this weapon`;

  sortCol = null;
  sortAsc = true;
  document.getElementById('shipFilter').value = '';
  renderTable(immune);
}

function renderTable(immuneShips) {
  const filter = document.getElementById('shipFilter').value.toLowerCase();
  let rows = immuneShips;
  if (filter) rows = rows.filter(s => (s.Name || '').toLowerCase().includes(filter));

  if (sortCol !== null) {
    const col = TABLE_COLS[sortCol];
    rows = [...rows].sort((a, b) => {
      let va = a[col.key], vb = b[col.key];
      if (col.num) { va = Number(va) || 0; vb = Number(vb) || 0; return sortAsc ? va - vb : vb - va; }
      va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase();
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }
  // No explicit column sort: keep the order getImmuneShips returned, which is
  // toughest-first on the deflection that applies to this weapon. The previous
  // default always led with physical, which read wrong for energy weapons.

  document.getElementById('tableHead').innerHTML = '<tr>' +
    TABLE_COLS.map((c, i) => {
      const cls = sortCol === i ? (sortAsc ? ' class="sorted-asc"' : ' class="sorted-desc"') : '';
      return `<th data-col="${i}"${cls}>${c.label}</th>`;
    }).join('') + '</tr>';

  document.getElementById('tableBody').innerHTML = rows.map(s =>
    '<tr>' + TABLE_COLS.map(c => {
      const v = s[c.key];
      const raw = `${fmt(v)}${c.pct && v != null ? '%' : ''}`;
      const display = c.num ? raw : escapeHtml(raw);
      const color = c.pct && v != null ? (v >= 0 ? ' style="color:var(--green)"' : ' style="color:var(--red)"') : '';
      return `<td${color}>${display}</td>`;
    }).join('') + '</tr>'
  ).join('');

  // Bind sort handlers
  document.querySelectorAll('#tableHead th').forEach(th => {
    th.onclick = () => {
      const idx = parseInt(th.dataset.col);
      if (sortCol === idx) sortAsc = !sortAsc;
      else { sortCol = idx; sortAsc = true; }
      const { immune } = getImmuneShips(selectedWeapon, allShips);
      renderTable(immune);
    };
  });
}

let initialized = false;

export function initUI(weapons, ships, restoredWeapon) {
  allWeapons = weapons;
  allShips = ships;
  selectedWeapon = null;
  sortCol = null;
  sortAsc = true;

  // Reset results view
  document.getElementById('placeholder').style.display = '';
  document.getElementById('results').classList.remove('visible');

  // Reset filters
  document.getElementById('weaponSearch').value = '';
  document.getElementById('filterSpeed').value = '';
  document.getElementById('filterSpeedMax').value = '';
  document.getElementById('shipFilter').value = '';

  // Build type multi-select
  const types = [...new Set(weapons.map(w => w.Type))].filter(Boolean).sort();
  checkedTypes = new Set(); // empty = all shown
  buildMultiSelect({
    toggleId: 'typeToggle', dropdownId: 'typeDropdown', values: types,
    checkedSet: checkedTypes, allLabel: 'All Types', pluralLabel: 'Types',
    onChange: renderWeaponList,
  });

  // Build size multi-select
  const sizes = [...new Set(weapons.map(w => w.Size))].filter(Boolean).sort((a, b) => a - b);
  checkedSizes = new Set(); // empty = all shown
  buildMultiSelect({
    toggleId: 'sizeToggle', dropdownId: 'sizeDropdown', values: sizes.map(String),
    checkedSet: checkedSizes, allLabel: 'All Sizes', pluralLabel: 'Sizes',
    onChange: renderWeaponList, labelFn: s => 'Size ' + s,
  });

  // Bind filter events and tab nav (only once)
  if (!initialized) {
    document.getElementById('weaponSearch').addEventListener('input', renderWeaponList);
    document.getElementById('filterSpeed').addEventListener('input', renderWeaponList);
    document.getElementById('filterSpeedMax').addEventListener('input', renderWeaponList);
    document.getElementById('shipFilter').addEventListener('input', () => {
      if (!selectedWeapon) return;
      const { immune } = getImmuneShips(selectedWeapon, allShips);
      renderTable(immune);
    });
    initTabNav();
    initialized = true;
  }

  // Show app
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = '';
  document.getElementById('tabNav').style.display = '';
  renderWeaponList();

  // Restore weapon selection from hash
  if (restoredWeapon) {
    const [name, vehicle] = restoredWeapon.split('|');
    const match = allWeapons.find(w =>
      w.Name === name && (!vehicle || w.Vehicle === vehicle)
    );
    if (match) selectWeapon(match);
  }
}

function initTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.tab + 'Panel').classList.add('active');
      saveHash({ tab: btn.dataset.tab });
    });
  });
}

export function restoreTab(tab) {
  if (!tab) return;
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.click();
}

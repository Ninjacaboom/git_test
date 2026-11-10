/**
 * utils.js - tiny shared helpers with no dependencies on other modules.
 */

/**
 * Escape a string for safe interpolation into HTML markup (element content
 * and double/single-quoted attribute values). Use on EVERY value that ends
 * up inside an innerHTML template - user input (build names, tab names),
 * localStorage-restored strings, and game-data names alike.
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

let _dropdownCloserBound = false;

/**
 * Close every open .ms-dropdown / .ms-toggle when the user clicks outside
 * one. Delegated and bound ONCE for the whole document - widget builders
 * that run on re-render (weapon finder filters, picker filters) call this
 * instead of stacking a fresh document listener per invocation.
 */
export function bindGlobalDropdownCloser() {
  if (_dropdownCloserBound) return;
  _dropdownCloserBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ms-toggle') || e.target.closest('.ms-dropdown')) return;
    document.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.ms-toggle.open').forEach(t => t.classList.remove('open'));
  });
}

/** Format a number with thousands-separator spaces (rounds to integer). */
export function thouSep(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Format a stat value for display. Returns an em-dash for null/NaN.
 * With `decimals` applies toFixed + thousands-separator; without, rounds.
 */
export function fmtStat(v, decimals) {
  if (v == null || isNaN(v)) return '—';
  if (decimals != null) return v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return thouSep(v);
}

/**
 * Format a number with thousands-separator spaces, supporting decimal places.
 * Used by ttkCalcUI and deflectionCalcUI for display values. Returns '-' for
 * non-finite inputs.
 */
export function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Order two extractor `gameVersion` strings numerically, part by part.
 * Returns -1 / 0 / 1 like a sort comparator.
 *
 * String comparison gets this backwards as soon as a part goes double-digit:
 * "4.10.0.12368639" < "4.9.0.12344265" lexically, which is how the PTU build
 * toggle went dark the day 4.10 PTU landed against 4.9 Live. Legacy
 * `sc-(alpha|beta|live|ptu)-X.Y.Z` prefixes are stripped first. Missing or
 * non-numeric parts count as 0, so a malformed string sorts oldest rather
 * than throwing.
 */
export function compareGameVersions(a, b) {
  const parts = v => String(v || '')
    .replace(/^sc-(?:alpha|beta|live|ptu)-/i, '')
    .split('.')
    .map(p => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Convert a numeric grade (1=A, 2=B, 3=C, …) to its letter.
 * Returns '' when grade is null, non-positive, or missing.
 */
export function gradeLetter(grade) {
  return (grade != null && grade > 0) ? String.fromCharCode(64 + grade) : '';
}

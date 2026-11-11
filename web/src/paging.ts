/**
 * Which page buttons to show: always the first and last page, the current page and its
 * neighbours, and "gap" for the skipped stretches, e.g. 1 gap 5 6 7 gap 66.
 * A gap that would hide just one page shows that page's number instead.
 */
export function pageList(page: number, total: number): (number | 'gap')[] {
  if (total <= 1) return [1];

  const wanted = new Set<number>([1, total, page - 1, page, page + 1]);
  // Near either end, show a few extra pages so the row keeps a steady length.
  if (page <= 3) [2, 3, 4].forEach((p) => wanted.add(p));
  if (page >= total - 2) [total - 1, total - 2, total - 3].forEach((p) => wanted.add(p));

  const sorted = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);

  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0) {
      const gap = p - sorted[i - 1];
      if (gap === 2) out.push(p - 1);
      else if (gap > 2) out.push('gap');
    }
    out.push(p);
  });
  return out;
}

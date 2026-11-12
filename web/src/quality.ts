import type { MaterialTier, Modifier, Slot } from './api';

export const BASELINE = 500; // NPC-store quality
export const MAX_QUALITY = 1000;

export type Band = { from: number; to: number; color: string };

/** The sections the quality slider is split into. 1000 (Perfect) is a section of its own. */
export const BANDS: Band[] = [
  { from: 0, to: 399, color: 'hsl(215 40% 24%)' },
  { from: 400, to: 599, color: 'hsl(215 42% 31%)' },
  { from: 600, to: 699, color: 'hsl(215 44% 38%)' },
  { from: 700, to: 799, color: 'hsl(215 46% 45%)' },
  { from: 800, to: 899, color: 'hsl(215 48% 52%)' },
  { from: 900, to: 949, color: 'hsl(215 52% 60%)' },
  { from: 950, to: 999, color: 'hsl(215 58% 68%)' },
  { from: 1000, to: 1000, color: 'hsl(215 80% 88%)' },
];

export const bandRange = (b: Band, min = 0): string => {
  const from = Math.max(b.from, min);
  return from === b.to ? `${from}` : `${from}–${b.to}`;
};

export function bandOf(quality: number): Band {
  const q = Math.min(Math.max(Math.round(quality), 0), MAX_QUALITY);
  return BANDS.find((b) => q >= b.from && q <= b.to) ?? BANDS[BANDS.length - 1];
}

/** Where the slider starts: 500 when the material has nothing below it, otherwise 0. */
export function sliderMin(tiers: MaterialTier[]): number {
  return tiers.length > 0 && tiers.every((t) => t.quality >= BASELINE) ? BASELINE : 0;
}

/** The sections that are visible when the slider starts at `min`. */
export const visibleBands = (min: number): Band[] => BANDS.filter((b) => b.to >= min);

/** Position along the slider as a percentage, 0 to 100. */
export const percent = (quality: number, min = 0): number => ((quality - min) / (MAX_QUALITY - min)) * 100;

/** Left edge and width (as percentages) of a section. The single-point 1000 section has no width. */
export function bandBox(b: Band, min = 0): { left: number; width: number } {
  if (b.from === MAX_QUALITY) return { left: 100, width: 0 };
  const from = Math.max(b.from, min);
  return { left: percent(from, min), width: percent(b.to + 1, min) - percent(from, min) };
}

/** A tier that gives nothing more than a lower tier of the same slot: its quality -> the lower tier's quality. */
export type Redundant = ReadonlyMap<number, number>;

/** Stat effects at one quality: same rule as the backend (QualityMath.SlotEffects). */
function effectsAt(modifiers: Modifier[], q: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of modifiers) {
    const additive = m.kind === 'additive';
    if (!(m.stat in out)) out[m.stat] = additive ? 0 : 1;
    if (q < m.qualityMin || q > m.qualityMax) continue;
    const span = m.qualityMax - m.qualityMin;
    const x = m.valueMin + (span > 0 ? (q - m.qualityMin) / span : 0) * (m.valueMax - m.valueMin);
    out[m.stat] = additive ? out[m.stat] + x : out[m.stat] * x;
  }
  return out;
}

/**
 * Tiers that are not worth using because a lower tier of the same slot already gives exactly the same
 * stat effects (e.g. power pips that stop going up at 900). Using them would waste better materials.
 */
export function redundantTiers(slot: Pick<Slot, 'tiers' | 'modifiers'>): Redundant {
  const redundant = new Map<number, number>();
  if (slot.modifiers.length === 0) return redundant;
  const seen = new Map<string, number>();
  for (const t of [...slot.tiers].sort((a, b) => a.quality - b.quality)) {
    const e = effectsAt(slot.modifiers, t.quality);
    const key = JSON.stringify(Object.keys(e).sort().map((k) => [k, Math.round(e[k] * 1e4) / 1e4]));
    const lower = seen.get(key);
    if (lower === undefined) seen.set(key, t.quality);
    else redundant.set(t.quality, lower);
  }
  return redundant;
}

/**
 * The quality you actually get for a slider position: anywhere inside a section gives that
 * section's material quality. 500 (NPC store) is always itself. With no tiers the position is used as is.
 * A tier that adds nothing (see redundantTiers) gives the lower tier it matches instead.
 */
export function qualityAt(position: number, tiers: MaterialTier[], redundant?: Redundant): number {
  const own = sectionQuality(position, tiers);
  return redundant?.get(own) ?? own;
}

/** The tier quality for the section a position is in, before any redundant tier is swapped out. */
export function sectionQuality(position: number, tiers: MaterialTier[]): number {
  if (tiers.length === 0 || position === BASELINE) return position;
  const band = bandOf(position);
  const hit = tiers.find((t) => bandOf(t.quality) === band);
  if (hit) return hit.quality;
  // No material in this section: use the nearest one.
  return tiers.reduce((best, t) => (Math.abs(t.quality - position) < Math.abs(best.quality - position) ? t : best)).quality;
}

/** The qualities the slider can be nudged between with the keyboard. */
export function stops(tiers: MaterialTier[], redundant?: Redundant): number[] {
  return [...new Set([BASELINE, ...tiers.map((t) => t.quality).filter((q) => !redundant?.has(q))])].sort((a, b) => a - b);
}

/** Short text under the slider: which section the value is in, and what it matches. */
export function describeQuality(quality: number, tiers: MaterialTier[], min = 0): { band: string; note: string } {
  const band = bandRange(bandOf(quality), min);
  if (tiers.length === 0) return { band, note: '' };
  const exact = tiers.find((t) => t.quality === quality);
  if (exact) return { band, note: `${exact.tier} tier` };
  if (quality === BASELINE) return { band, note: 'NPC store' };
  return { band, note: 'no material in this section' };
}

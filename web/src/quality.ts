import type { MaterialTier } from './api';

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

export const bandRange = (b: Band): string => (b.from === b.to ? `${b.from}` : `${b.from}–${b.to}`);

export function bandOf(quality: number): Band {
  const q = Math.min(Math.max(Math.round(quality), 0), MAX_QUALITY);
  return BANDS.find((b) => q >= b.from && q <= b.to) ?? BANDS[BANDS.length - 1];
}

/** Position along the slider as a percentage, 0 to 100. */
export const percent = (quality: number): number => (quality / MAX_QUALITY) * 100;

/** Left edge and width (as percentages) of a section. The single-point 1000 section has no width. */
export function bandBox(b: Band): { left: number; width: number } {
  if (b.from === MAX_QUALITY) return { left: 100, width: 0 };
  return { left: percent(b.from), width: percent(b.to + 1) - percent(b.from) };
}

/** Short text under the slider: which section the value is in, and what it matches. */
export function describeQuality(quality: number, tiers: MaterialTier[]): { band: string; note: string } {
  const band = bandRange(bandOf(quality));
  if (tiers.length === 0) return { band, note: '' };
  const exact = tiers.find((t) => t.quality === quality);
  if (exact) return { band, note: `${exact.tier} tier` };
  if (quality === BASELINE) return { band, note: 'NPC store' };
  return { band, note: 'no material at this quality' };
}

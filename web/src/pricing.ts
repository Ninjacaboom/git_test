/**
 * Material pricing from how rare each quality is.
 *
 * Ship-mined ore rolls its quality from a bell curve (min 501, max 1000, mean 500) whose spread
 * depends on the ore's rarity class. The spreads come from the game files
 * (crafting/qualitydistribution/shipmineables). Which ore belongs to which class is NOT in those
 * files, so every ore except Copper (confirmed against SCMDB) and Torite (named in the files) is a
 * best guess, flagged `confirmed: false`. Check one against SCMDB's quality popup (it shows σ) and
 * flip the flag.
 *
 * Base prices are placeholders for the org to set.
 */

export type ClassId = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type Region = 'stanton' | 'pyro';

export type QualityClass = {
  id: ClassId;
  label: string;
  /** Spread of the bell curve in normal space, and in Pyro (a little wider). */
  stddev: Record<Region, number>;
  /** Placeholder base price (aUEC per SCU) at baseline quality. */
  basePrice: number;
};

export const QUALITY_MIN = 501;
export const QUALITY_MAX = 1000;
export const QUALITY_MEAN = 500;

export const CLASSES: Record<ClassId, QualityClass> = {
  common: { id: 'common', label: 'Common', stddev: { stanton: 143, pyro: 149 }, basePrice: 1000 },
  uncommon: { id: 'uncommon', label: 'Uncommon', stddev: { stanton: 150, pyro: 159 }, basePrice: 1500 },
  rare: { id: 'rare', label: 'Rare', stddev: { stanton: 163, pyro: 173 }, basePrice: 2500 },
  epic: { id: 'epic', label: 'Epic', stddev: { stanton: 190, pyro: 207 }, basePrice: 4000 },
  legendary: { id: 'legendary', label: 'Legendary', stddev: { stanton: 203, pyro: 225 }, basePrice: 6000 },
};

export type Ore = {
  name: string;
  classId: ClassId;
  /** True once the class has been checked against the game or SCMDB; false for a guess. */
  confirmed: boolean;
  /** This ore's own base price (aUEC per SCU at baseline quality). Falls back to the class placeholder. */
  basePrice?: number;
};

/** The base price to use for an ore: a price set in the guide, then the ore's own, then the class placeholder. */
export function baseFor(ore: Ore, overrides: Record<string, number> = {}): number {
  return overrides[ore.name] ?? ore.basePrice ?? CLASSES[ore.classId].basePrice;
}

/** True when the ore has a price someone set, rather than the class placeholder. */
export function hasOwnBase(ore: Ore, overrides: Record<string, number> = {}): boolean {
  return overrides[ore.name] !== undefined || ore.basePrice !== undefined;
}

export const ORES: Ore[] = [
  { name: 'Copper', classId: 'common', confirmed: true },
  { name: 'Iron', classId: 'common', confirmed: false },
  { name: 'Aluminium', classId: 'common', confirmed: false },
  { name: 'Tin', classId: 'common', confirmed: false },
  { name: 'Titanium', classId: 'common', confirmed: false },
  { name: 'Tungsten', classId: 'common', confirmed: false },
  { name: 'Quartz', classId: 'common', confirmed: false },
  { name: 'Silicon', classId: 'common', confirmed: false },
  { name: 'Corundum', classId: 'common', confirmed: false },
  { name: 'Torite', classId: 'uncommon', confirmed: true },
  { name: 'Borase', classId: 'uncommon', confirmed: false },
  { name: 'Beryl', classId: 'uncommon', confirmed: false },
  { name: 'Agricium', classId: 'uncommon', confirmed: false },
  { name: 'Gold', classId: 'rare', confirmed: false },
  { name: 'Laranite', classId: 'rare', confirmed: false },
  { name: 'Bexalite', classId: 'rare', confirmed: false },
  { name: 'Taranite', classId: 'rare', confirmed: false },
  { name: 'Hephaestanite', classId: 'rare', confirmed: false },
  { name: 'Aslarite', classId: 'epic', confirmed: false },
  { name: 'Ouratite', classId: 'epic', confirmed: false },
  { name: 'Sileron', classId: 'epic', confirmed: false },
  { name: 'Riccite', classId: 'legendary', confirmed: false },
  { name: 'Lindinium', classId: 'legendary', confirmed: false },
  { name: 'Savrilium', classId: 'legendary', confirmed: false },
  { name: 'Quantanium', classId: 'legendary', confirmed: false },
];

/** Quality steps shown in the price guide. 500 is the baseline (everything rolls at least this). */
export const GUIDE_QUALITIES = [500, 600, 700, 800, 900, 950] as const;

/** Largest multiplier any quality can reach, so a one-in-a-thousand roll is not priced absurdly. */
export const MAX_MULTIPLIER = 6;

/** Error function (Abramowitz and Stegun 7.1.26, accurate to about 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * Chance that one rock rolls this quality or better. The bell curve is cut off at the minimum
 * (501), so the chance is measured against everything that can roll.
 */
export function chanceAtLeast(quality: number, classId: ClassId, region: Region = 'stanton'): number {
  const sd = CLASSES[classId].stddev[region];
  const lo = phi((QUALITY_MIN - QUALITY_MEAN) / sd);
  const hi = phi((QUALITY_MAX - QUALITY_MEAN) / sd);
  const q = Math.min(Math.max(quality, QUALITY_MIN), QUALITY_MAX);
  return Math.max(0, (hi - phi((q - QUALITY_MEAN) / sd)) / (hi - lo));
}

/** 1 for anything common, then 1 + k per factor of ten rarer, capped. */
export function rarityMultiplier(chance: number, k = 1): number {
  if (chance >= 1) return 1;
  if (chance <= 0) return MAX_MULTIPLIER;
  return Math.min(MAX_MULTIPLIER, 1 + k * Math.log10(1 / chance));
}

export function materialPrice(basePrice: number, quality: number, classId: ClassId, region: Region = 'stanton', k = 1): number {
  const m = rarityMultiplier(chanceAtLeast(quality, classId, region), k);
  return Math.round((basePrice * m) / 10) * 10;
}

export function formatChance(chance: number): string {
  const pct = chance * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  return '<0.1%';
}

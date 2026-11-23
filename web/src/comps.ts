import type { MarketListing } from './api';

/** Lower case, letters and numbers only, single spaces: "Gallant  Rifle!" -> "gallant rifle". */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Listings whose title mentions the item. Titles are free text typed by sellers, so this is a
 * simple "title contains the item name" match; an item named differently by the seller is missed.
 */
export function listingsFor(itemName: string, listings: MarketListing[]): MarketListing[] {
  const wanted = normalise(itemName);
  if (wanted.length < 4) return [];
  return listings.filter((l) => normalise(l.title).includes(wanted));
}

export type Comps = {
  /** The listings nearest in quality, closest first. */
  nearest: MarketListing[];
  /** Median asking price of those. */
  median: number | null;
  /** True when some of the listings had no quality, so they were included without being compared. */
  includesUnrated: boolean;
};

const COMP_COUNT = 5;

/** The listings closest in quality to the one being listed, and their median price. */
export function compsFor(matches: MarketListing[], quality: number): Comps {
  const rated = matches.filter((l) => l.quality !== null && l.quality > 1);
  const pool = rated.length >= 3 ? rated : matches;
  const nearest = [...pool]
    .sort((a, b) => Math.abs((a.quality ?? -9999) - quality) - Math.abs((b.quality ?? -9999) - quality))
    .slice(0, COMP_COUNT);
  if (nearest.length === 0) return { nearest, median: null, includesUnrated: false };

  const prices = nearest.map((l) => l.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  return { nearest, median, includesUnrated: nearest.some((l) => l.quality === null || l.quality <= 1) };
}

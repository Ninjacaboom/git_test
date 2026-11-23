export type MaterialTier = { tier: string; quality: number };
export type Material = { name: string; category: string; tiers: MaterialTier[] };

export type Cost = {
  resourceId: string;
  material: string;
  unitType: string;
  quantity: number;
};

export type Modifier = {
  stat: string;
  kind: 'multiplier' | 'additive';
  qualityMin: number;
  qualityMax: number;
  valueMin: number;
  valueMax: number;
};

export type Slot = {
  name: string;
  displayName: string;
  /** Qualities this slot's material can be used at (F tier left out except for mining lasers). */
  tiers: MaterialTier[];
  costs: Cost[];
  modifiers: Modifier[];
};

export type Skin = { className: string; name: string | null; recipeId: string | null };

export type Recipe = {
  id: string;
  className: string;
  name: string;
  description: string | null;
  type: string;
  subType: string;
  size: number;
  grade: number | null;
  manufacturer: string | null;
  craftTimeSeconds: number;
  variantOf: string | null;
  skins: Skin[];
  slots: Slot[];
  baseStats?: { label: string; value: string }[] | null;
  armourWeight?: string | null;
  weaponCategory?: string | null;
};

export type RecipeSummary = {
  id: string;
  name: string;
  type: string;
  subType: string;
  size: number;
  grade: number | null;
  manufacturer: string | null;
  isSkin: boolean;
  armourWeight?: string | null;
  weaponCategory?: string | null;
  /** The top of the item description (its stat lines). */
  description?: string | null;
  baseStats?: { label: string; value: string }[] | null;
  weaponClass?: string | null;
};

export type TypeCount = { type: string; count: number };

export type StatEffect = { kind: 'multiplier' | 'additive'; value: number };
export type StatEffects = Record<string, StatEffect>;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const getMaterials = () => request<Material[]>('/api/materials');

export const getRecipeTypes = () => request<TypeCount[]>('/api/recipe-types');

export function searchRecipes(search: string, types: string[], includeSkins: boolean, weights: string[] = [], ammo: string[] = []) {
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (types.length > 0) params.set('type', types.join(','));
  if (weights.length > 0) params.set('weight', weights.join(','));
  if (ammo.length > 0) params.set('ammo', ammo.join(','));
  params.set('includeSkins', String(includeSkins));
  return request<RecipeSummary[]>(`/api/recipes?${params.toString()}`);
}

export const getRecipe = (id: string) =>
  request<Recipe>(`/api/recipes/${encodeURIComponent(id)}`);

/** qualities: slot name -> quality (0-1000). Slots left out count as 500. */
export const getStats = (id: string, qualities: Record<string, number>) =>
  request<StatEffects>(`/api/recipes/${encodeURIComponent(id)}/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qualities }),
  });

// ---- Members, squadrons and stock lots (stand-ins until the NOVA portal supplies members) ----

export type Squadron = { id: string; name: string; division: string };
export type Member = { id: string; name: string; squadronId: string | null; division: string };

export type LotStage = 'Squadron' | 'Priority' | 'Public' | 'Claimed' | 'Sold';

export type Lot = {
  id: string;
  recipeId: string;
  itemName: string;
  itemType: string;
  quality: number;
  quantity: number;
  ownerKind: 'member' | 'squadron';
  ownerId: string;
  madeByMemberId: string;
  stage: LotStage;
  priceAuec: number | null;
  createdAt: string;
  releaseAt: string | null;
};

export type NewLot = {
  recipeId: string;
  quality: number;
  quantity: number;
  madeByMemberId: string;
  forSquadron: boolean;
  priceAuec: number | null;
};

export const getMembers = () => request<Member[]>('/api/members');
export const getSquadrons = () => request<Squadron[]>('/api/squadrons');

export function getLots(filter: { stage?: string; ownerKind?: string; ownerId?: string; recipeId?: string } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  return request<Lot[]>(`/api/lots?${params.toString()}`);
}

export const createLot = (lot: NewLot) =>
  request<Lot>('/api/lots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lot),
  });

// ---- Commodity prices from UEX (what terminals pay per SCU) ----

export type CommodityPrice = {
  name: string;
  bestSell: number | null;
  avgSell: number | null;
  terminals: number;
  /** Unix seconds of the latest report. */
  updated: number | null;
};

export type PriceSnapshot = { fetchedAt: string; source: string; prices: CommodityPrice[] };

export const getPrices = () => request<PriceSnapshot>('/api/prices');

// ---- Player listings from the UEX marketplace (asking prices) ----

export type MarketListing = {
  title: string;
  itemId: number | null;
  categoryId: number | null;
  quality: number | null;
  price: number;
  stock: number;
  /** Unix seconds when the listing was added. */
  added: number | null;
};

export type ListingSnapshot = { fetchedAt: string; source: string; listings: MarketListing[] };

export const getMarketListings = () => request<ListingSnapshot>('/api/market-listings');

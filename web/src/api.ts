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

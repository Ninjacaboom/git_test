import { useEffect, useState } from 'react';
import {
  getMaterials,
  getRecipeTypes,
  searchRecipes,
  type Material,
  type RecipeSummary,
  type TypeCount,
} from './api';
import { prettyType } from './format';
import RecipeDetail from './RecipeDetail';

const MAX_SHOWN = 200;

export default function App() {
  const [types, setTypes] = useState<TypeCount[]>([]);
  const [materials, setMaterials] = useState<Map<string, Material>>(new Map());
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [includeSkins, setIncludeSkins] = useState(false);
  const [results, setResults] = useState<RecipeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the lookup data once.
  useEffect(() => {
    Promise.all([getRecipeTypes(), getMaterials()])
      .then(([t, m]) => {
        setTypes(t);
        setMaterials(new Map(m.map((x) => [x.name, x])));
        setError(null);
      })
      .catch(() => setError('Could not reach the API. Is the backend running?'));
  }, []);

  // Search whenever the filters change (with a short delay while typing).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      searchRecipes(search, type, includeSkins)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setError(null);
          }
        })
        .catch(() => {
          if (!cancelled) setError('Could not reach the API. Is the backend running?');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, type, includeSkins]);

  const shown = results.slice(0, MAX_SHOWN);

  return (
    <div className="app">
      <header>
        <h1>Crafting Store</h1>
        <p className="muted">Browse craftable items and see how material quality changes their stats.</p>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="layout">
        <aside className="browser">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or manufacturer"
            aria-label="Search recipes"
          />
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {prettyType(t.type)} ({t.count})
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={includeSkins} onChange={(e) => setIncludeSkins(e.target.checked)} />
            Include skin variants
          </label>

          <p className="muted small">
            {results.length} found{results.length > MAX_SHOWN ? `, showing the first ${MAX_SHOWN}` : ''}
          </p>

          <ul className="results">
            {shown.map((r) => (
              <li key={r.id}>
                <button
                  className={r.id === selectedId ? 'result selected' : 'result'}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span>{r.name}</span>
                  <span className="muted small">
                    {prettyType(r.type)}
                    {r.manufacturer ? ` · ${r.manufacturer}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="panel">
          {selectedId ? (
            <RecipeDetail recipeId={selectedId} materials={materials} onSelect={setSelectedId} />
          ) : (
            <p className="muted">Pick an item on the left to see its materials and stats.</p>
          )}
        </main>
      </div>
    </div>
  );
}

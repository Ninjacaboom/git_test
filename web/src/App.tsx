import { useEffect, useState } from 'react';
import { getRecipeTypes, searchRecipes, type RecipeSummary, type TypeCount } from './api';
import { prettyType } from './format';
import Pagination from './Pagination';
import RecipeDetail from './RecipeDetail';

// Cards per page. 24 fills whole rows whether the grid has 1, 2, 3 or 4 columns.
const PAGE_SIZE = 24;

export default function App() {
  const [types, setTypes] = useState<TypeCount[]>([]);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [includeSkins, setIncludeSkins] = useState(false);
  const [results, setResults] = useState<RecipeSummary[] | null>(null);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the type list once.
  useEffect(() => {
    getRecipeTypes()
      .then((t) => {
        setTypes(t);
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

  // Go back to page 1 whenever the results change (new search or filter).
  useEffect(() => {
    setPage(1);
  }, [results]);

  const total = results?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const firstShown = (currentPage - 1) * PAGE_SIZE;
  const pageItems = (results ?? []).slice(firstShown, firstShown + PAGE_SIZE);

  // Switch page and jump back to the top so the new page starts in view.
  const goToPage = (p: number) => {
    setPage(Math.min(Math.max(p, 1), totalPages));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Close the pop-up with Escape, and stop the page scrolling behind it.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedId]);

  const filtersActive = search !== '' || type !== '' || includeSkins;
  const clearFilters = () => {
    setSearch('');
    setType('');
    setIncludeSkins(false);
  };

  return (
    <div className="app">
      <header>
        <h1>Crafting Store</h1>
        <p className="muted">Browse craftable items and see how material quality changes their stats.</p>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="layout">
        <aside className="filters">
          <h2 className="filter-title">Search</h2>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or manufacturer"
            aria-label="Search recipes"
          />

          <h2 className="filter-title">Type</h2>
          <ul className="type-list">
            <li>
              <button className={type === '' ? 'type-btn active' : 'type-btn'} onClick={() => setType('')}>
                All types
              </button>
            </li>
            {types.map((t) => (
              <li key={t.type}>
                <button
                  className={type === t.type ? 'type-btn active' : 'type-btn'}
                  onClick={() => setType(t.type)}
                >
                  {prettyType(t.type)}
                </button>
              </li>
            ))}
          </ul>

          <h2 className="filter-title">Options</h2>
          <label className="check">
            <input type="checkbox" checked={includeSkins} onChange={(e) => setIncludeSkins(e.target.checked)} />
            Include skin variants
          </label>

          {filtersActive && (
            <button className="clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </aside>

        <main className="results-area">
          {results && results.length > 0 && (
            <p className="count">
              {results.length <= PAGE_SIZE
                ? `${results.length} items`
                : `Showing ${firstShown + 1}–${firstShown + pageItems.length} of ${results.length} items`}
            </p>
          )}
          {results === null && !error && <p className="count">Loading...</p>}
          {results && results.length === 0 && <p className="count">No items match your filters.</p>}

          <ul className="cards">
            {pageItems.map((r) => {
              const subtitle = [prettyType(r.type), r.manufacturer].filter(Boolean).join(' · ');
              return (
                <li key={r.id}>
                  <button className="card" onClick={() => setSelectedId(r.id)}>
                    <span className="card-name">{r.name}</span>
                    <span className="muted small">{subtitle}</span>
                    <span className="badges">
                      {r.size > 0 && <span className="badge">Size {r.size}</span>}
                      {r.grade ? <span className="badge">Grade {r.grade}</span> : null}
                      {r.isSkin && <span className="badge skin">Skin</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Pagination page={currentPage} totalPages={totalPages} onChange={goToPage} />
        </main>
      </div>

      {selectedId && (
        <div className="modal-backdrop" onClick={() => setSelectedId(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedId(null)} aria-label="Close">
              ×
            </button>
            <RecipeDetail recipeId={selectedId} onSelect={setSelectedId} />
          </div>
        </div>
      )}
    </div>
  );
}

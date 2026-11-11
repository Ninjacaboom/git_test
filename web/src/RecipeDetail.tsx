import { useEffect, useMemo, useState } from 'react';
import { getRecipe, getStats, type Recipe, type StatEffects } from './api';
import { formatAmount, formatDuration, formatEffect, prettyType } from './format';
import QualitySlider from './QualitySlider';
import { BASELINE } from './quality';

type Props = {
  recipeId: string;
  onSelect: (id: string) => void;
};

export default function RecipeDetail({ recipeId, onSelect }: Props) {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qualities, setQualities] = useState<Record<string, number>>({});
  const [effects, setEffects] = useState<StatEffects | null>(null);

  // Load the recipe and reset the quality choices whenever a different recipe is picked.
  useEffect(() => {
    let cancelled = false;
    setRecipe(null);
    setError(null);
    setQualities({});
    setEffects(null);
    getRecipe(recipeId)
      .then((r) => {
        if (!cancelled) setRecipe(r);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this recipe.');
      });
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  // Ask the backend for the stat changes whenever the quality choices change.
  // The short delay stops a request per pixel while a slider is being dragged.
  useEffect(() => {
    if (!recipe) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getStats(recipe.id, qualities)
        .then((e) => {
          if (!cancelled) setEffects(e);
        })
        .catch(() => {
          if (!cancelled) setEffects(null);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipe, qualities]);

  const totals = useMemo(() => {
    if (!recipe) return [];
    const map = new Map<string, { material: string; unitType: string; quantity: number }>();
    for (const slot of recipe.slots) {
      for (const cost of slot.costs) {
        const key = `${cost.material}|${cost.unitType}`;
        const existing = map.get(key);
        if (existing) existing.quantity += cost.quantity;
        else map.set(key, { material: cost.material, unitType: cost.unitType, quantity: cost.quantity });
      }
    }
    return [...map.values()].sort((a, b) => a.material.localeCompare(b.material));
  }, [recipe]);

  if (error) return <p className="error">{error}</p>;
  if (!recipe) return <p className="muted">Loading...</p>;

  const meta = [
    prettyType(recipe.type),
    recipe.subType && recipe.subType !== 'UNDEFINED' ? recipe.subType : null,
    recipe.size ? `Size ${recipe.size}` : null,
    recipe.grade ? `Grade ${recipe.grade}` : null,
    recipe.manufacturer,
  ].filter(Boolean);

  return (
    <article className="detail">
      <h2>{recipe.name}</h2>
      <p className="meta">{meta.join(' · ')}</p>
      <p className="meta">Craft time: {formatDuration(recipe.craftTimeSeconds)}</p>
      {recipe.description && <p className="description">{recipe.description}</p>}

      {recipe.skins.length > 0 && (
        <section>
          <h3>Skins ({recipe.skins.length})</h3>
          <ul className="chips">
            {recipe.skins.map((s) => (
              <li key={s.className}>
                {s.recipeId ? (
                  <button className="chip" onClick={() => onSelect(s.recipeId as string)}>
                    {s.name ?? s.className}
                  </button>
                ) : (
                  <span className="chip static">{s.name ?? s.className}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Materials and quality</h3>
        <p className="muted small">
          Set the material quality for each part with the slider or the list. The{' '}
          <span className="key-mark">coloured lines</span> are the qualities that material is found at, and the
          dashed line is 500, the quality of NPC-store items.
        </p>
        <div className="slots">
          {recipe.slots.map((slot) => {
            const current = qualities[slot.name] ?? BASELINE;
            const options = [
              ...slot.tiers.map((t) => ({ quality: t.quality, label: `${t.tier} tier · ${t.quality}` })),
              { quality: BASELINE, label: `NPC store · ${BASELINE}` },
            ];
            // A value between real tiers (dragged there with the slider) gets its own entry.
            if (!options.some((o) => o.quality === current)) {
              options.push({ quality: current, label: `Custom · ${current}` });
            }
            options.sort((a, b) => a.quality - b.quality);
            const affects = [...new Set(slot.modifiers.map((m) => m.stat))];

            return (
              <div className="slot" key={slot.name}>
                <div className="slot-head">
                  <strong>{slot.displayName}</strong>
                  <span className="muted small">
                    {slot.costs.map((c) => `${formatAmount(c.quantity, c.unitType)} ${c.material}`).join(', ')}
                  </span>
                </div>
                <p className="muted small">{affects.length ? `Affects: ${affects.join(', ')}` : 'No stat effect'}</p>
                {affects.length > 0 && (
                  <>
                    <QualitySlider
                      value={current}
                      tiers={slot.tiers}
                      label={slot.displayName}
                      onChange={(q) => setQualities({ ...qualities, [slot.name]: q })}
                    />
                    {slot.tiers.length > 0 && (
                      <select
                        value={current}
                        onChange={(e) => setQualities({ ...qualities, [slot.name]: Number(e.target.value) })}
                        aria-label={`Material tier for ${slot.displayName}`}
                      >
                        {options.map((o) => (
                          <option key={o.quality} value={o.quality}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Stat changes</h3>
        {effects && Object.keys(effects).length > 0 ? (
          <table className="stats">
            <tbody>
              {Object.entries(effects).map(([stat, effect]) => {
                const f = formatEffect(effect);
                return (
                  <tr key={stat}>
                    <td>{stat}</td>
                    <td className={`value ${f.direction}`}>{f.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted small">This item has no quality-based stat changes.</p>
        )}
      </section>

      <section>
        <h3>Total materials</h3>
        <ul className="totals">
          {totals.map((t) => (
            <li key={`${t.material}|${t.unitType}`}>
              {formatAmount(t.quantity, t.unitType)} {t.material}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

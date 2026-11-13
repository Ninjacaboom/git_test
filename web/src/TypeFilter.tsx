import { useMemo, useState } from 'react';
import type { TypeCount } from './api';
import { prettyType } from './format';
import { buildGroups } from './typeGroups';
import WeightFilter from './WeightFilter';

type Props = {
  types: TypeCount[];
  /** The ticked types. Empty means every type. */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** The ticked armour weights (light, medium, heavy, superheavy). Shown inside the Armour group. */
  weights: string[];
  onWeightsChange: (weights: string[]) => void;
};

/** Drop-down check lists: one group each for armour, FPS weapons and ship components. */
export default function TypeFilter({ types, selected, onChange, weights, onWeightsChange }: Props) {
  const groups = useMemo(() => buildGroups(types, prettyType), [types]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const chosen = new Set(selected);

  const toggleType = (type: string) => {
    const next = new Set(chosen);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onChange([...next]);
  };

  const toggleGroup = (all: string[], everyChosen: boolean) => {
    const next = new Set(chosen);
    for (const t of all) {
      if (everyChosen) next.delete(t);
      else next.add(t);
    }
    onChange([...next]);
  };

  return (
    <div className="type-groups">
      {groups.map((g) => {
        const all = g.items.map((i) => i.type);
        const typeCount = all.filter((t) => chosen.has(t)).length;
        const weightCount = g.id === 'armour' ? weights.length : 0;
        const count = typeCount + weightCount;
        const isOpen = open[g.id] ?? count > 0;
        return (
          <div className="type-group" key={g.id}>
            <div className="type-group-head">
              <input
                type="checkbox"
                checked={typeCount === all.length}
                ref={(el: HTMLInputElement | null) => {
                  if (el) el.indeterminate = typeCount > 0 && typeCount < all.length;
                }}
                onChange={() => toggleGroup(all, typeCount === all.length)}
                aria-label={`All ${g.title}`}
              />
              <button
                type="button"
                className="type-group-toggle"
                aria-expanded={isOpen}
                onClick={() => setOpen({ ...open, [g.id]: !isOpen })}
              >
                <span>{g.title}</span>
                {count > 0 && <span className="type-group-count">{count}</span>}
                <span className={isOpen ? 'chevron open' : 'chevron'} aria-hidden="true">
                  ▾
                </span>
              </button>
            </div>
            {isOpen && (
              <ul className="type-checks">
                {g.items.map((i) => (
                  <li key={i.type}>
                    <label className="check">
                      <input type="checkbox" checked={chosen.has(i.type)} onChange={() => toggleType(i.type)} />
                      {i.label}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {isOpen && g.id === 'armour' && (
              <>
                <p className="type-subtitle">Weight</p>
                <WeightFilter selected={weights} onChange={onWeightsChange} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Props = {
  /** The ticked weight classes. Empty means every weight. */
  selected: string[];
  onChange: (selected: string[]) => void;
};

// The weight classes of armour. "Super heavy" is the juggernaut suit.
const WEIGHTS = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'heavy', label: 'Heavy' },
  { id: 'superheavy', label: 'Super heavy' },
];

export default function WeightFilter({ selected, onChange }: Props) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((w) => w !== id) : [...selected, id]);

  return (
    <ul className="type-checks weight-checks">
      {WEIGHTS.map((w) => (
        <li key={w.id}>
          <label className="check">
            <input type="checkbox" checked={selected.includes(w.id)} onChange={() => toggle(w.id)} />
            {w.label}
          </label>
        </li>
      ))}
    </ul>
  );
}

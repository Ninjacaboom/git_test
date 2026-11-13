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
    <div className="ammo-pills">
      {WEIGHTS.map((x) => (
        <button
          key={x.id}
          type="button"
          className={selected.includes(x.id) ? 'pill active' : 'pill'}
          aria-pressed={selected.includes(x.id)}
          onClick={() => toggle(x.id)}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

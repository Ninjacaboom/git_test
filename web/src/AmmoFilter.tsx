type Props = {
  /** The ticked ammo types. Empty means every type. */
  selected: string[];
  onChange: (selected: string[]) => void;
};

const AMMO = [
  { id: 'ballistic', label: 'Ballistic' },
  { id: 'energy', label: 'Energy' },
];

/** Two toggle boxes: ballistic and energy weapons. */
export default function AmmoFilter({ selected, onChange }: Props) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((a) => a !== id) : [...selected, id]);

  return (
    <div className="ammo-pills">
      {AMMO.map((a) => (
        <button
          key={a.id}
          type="button"
          className={selected.includes(a.id) ? 'pill active' : 'pill'}
          aria-pressed={selected.includes(a.id)}
          onClick={() => toggle(a.id)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

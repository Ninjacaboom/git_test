import type { MaterialTier } from './api';
import { BANDS, BASELINE, MAX_QUALITY, bandBox, bandRange, describeQuality, percent } from './quality';

type Props = {
  value: number;
  /** The qualities the material is found at; each is marked with a coloured line. */
  tiers: MaterialTier[];
  label: string;
  onChange: (quality: number) => void;
};

/**
 * A 0-1000 quality slider split into sections. Coloured lines mark the qualities the
 * material really comes in, and a dashed white line marks 500 (NPC store).
 */
export default function QualitySlider({ value, tiers, label, onChange }: Props) {
  const info = describeQuality(value, tiers);

  return (
    <div className="qslider">
      <div className="qreadout">
        <span>
          <strong>{value}</strong> <span className="muted">· section {info.band}</span>
        </span>
        {info.note && <span className="muted small">{info.note}</span>}
      </div>

      <div className="qrow">
        <div className="qtrack">
          <div className="qbands">
            {BANDS.map((b) => {
              if (b.from === MAX_QUALITY) {
                return <span key={b.from} className="qband qcap" style={{ background: b.color }} />;
              }
              const box = bandBox(b);
              return (
                <span
                  key={b.from}
                  className="qband"
                  style={{ left: `${box.left}%`, width: `${box.width}%`, background: b.color }}
                />
              );
            })}
          </div>
          <span className="qbase" style={{ left: `${percent(BASELINE)}%` }} />
          {tiers.map((t) => (
            <span key={t.tier} className="qmark" style={{ left: `${percent(t.quality)}%` }} />
          ))}
        </div>

        <input
          className="qinput"
          type="range"
          min={0}
          max={MAX_QUALITY}
          step={1}
          value={value}
          aria-label={`Quality for ${label}`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>

      <div className="qlabels" aria-hidden="true">
        {BANDS.map((b) => (
          <span
            key={b.from}
            // 900, 950 and 1000 are too close together, so 950 sits on a second row.
            className={b.from === 950 ? 'qlabel low' : 'qlabel'}
            style={{ left: `${percent(b.from)}%` }}
            title={bandRange(b)}
          >
            {b.from}
          </span>
        ))}
      </div>
    </div>
  );
}

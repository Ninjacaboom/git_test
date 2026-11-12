import type { KeyboardEvent } from 'react';
import type { MaterialTier } from './api';
import {
  BASELINE,
  MAX_QUALITY,
  bandBox,
  bandOf,
  bandRange,
  describeQuality,
  percent,
  qualityAt,
  sectionQuality,
  type Redundant,
  sliderMin,
  stops,
  visibleBands,
} from './quality';

type Props = {
  /** Where the thumb is. The quality used is worked out from the section it is in. */
  position: number;
  /** The qualities the material is found at; each is marked with a coloured line. */
  tiers: MaterialTier[];
  label: string;
  /** Tiers that give nothing more than a lower tier; they are greyed out and not used. */
  redundant?: Redundant;
  onChange: (position: number) => void;
};

/**
 * A quality slider split into sections. Put the thumb anywhere inside a section and you get that
 * section's real material quality. Coloured lines mark the real qualities, and a dashed white
 * line marks 500 (NPC store). If the material has nothing below 500 the slider starts at 500.
 */
export default function QualitySlider({ position, tiers, label, redundant, onChange }: Props) {
  const min = sliderMin(tiers);
  const shown = Math.max(position, min);
  const quality = qualityAt(shown, tiers, redundant);
  const own = sectionQuality(shown, tiers);
  const skipped = redundant?.has(own) ? tiers.find((t) => t.quality === own) : undefined;
  const info = { ...describeQuality(quality, tiers, min), band: bandRange(bandOf(shown), min) };
  const active = bandOf(shown);
  const bands = visibleBands(min);

  // Arrow keys jump between the real qualities instead of moving one point at a time.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (tiers.length === 0) return;
    const list = stops(tiers, redundant);
    const i = list.indexOf(quality);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = list[Math.min(i + 1, list.length - 1)];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = list[Math.max(i - 1, 0)];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div className="qslider">
      <div className="qreadout">
        <span>
          Quality <strong>{quality}</strong> <span className="muted">· section {info.band}</span>
        </span>
        {info.note && <span className="muted small">{info.note}</span>}
      </div>
      {skipped && (
        <p className="qskip small">
          {skipped.tier} tier adds nothing over {info.note || `quality ${quality}`}, so it uses that instead. Save the better
          material for another item.
        </p>
      )}

      <div className="qrow">
        <div className="qtrack">
          <div className="qbands">
            {bands.map((b) => {
              if (b.from === MAX_QUALITY) {
                return (
                  <span
                    key={b.from}
                    className={b === active ? 'qband qcap active' : 'qband qcap'}
                    style={{ background: b.color }}
                  />
                );
              }
              const box = bandBox(b, min);
              return (
                <span
                  key={b.from}
                  className={b === active ? 'qband active' : 'qband'}
                  style={{ left: `${box.left}%`, width: `${box.width}%`, background: b.color }}
                />
              );
            })}
          </div>
          <span className="qbase" style={{ left: `${percent(BASELINE, min)}%` }} />
          {tiers.map((t) => (
            <span key={t.tier} className={redundant?.has(t.quality) ? 'qmark off' : 'qmark'} style={{ left: `${percent(t.quality, min)}%` }} />
          ))}
        </div>

        <input
          className="qinput"
          type="range"
          min={min}
          max={MAX_QUALITY}
          step={1}
          value={shown}
          aria-label={`Quality for ${label}`}
          aria-valuetext={`${quality}${info.note ? `, ${info.note}` : ''}`}
          onChange={(e) => onChange(Number(e.target.value))}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="qlabels" aria-hidden="true">
        {bands.map((b) => {
          const from = Math.max(b.from, min);
          // 900, 950 and 1000 are too close together, so 950 sits on a second row,
          // and on a phone the 900 label is dropped when the slider starts at 0.
          const cls = b.from === 950 ? 'qlabel low' : b.from === 900 && min === 0 ? 'qlabel hide-sm' : 'qlabel';
          return (
            <span key={b.from} className={cls} style={{ left: `${percent(from, min)}%` }} title={bandRange(b, min)}>
              {from}
            </span>
          );
        })}
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  CLASSES,
  GUIDE_QUALITIES,
  ORES,
  chanceAtLeast,
  formatChance,
  materialPrice,
  type Region,
} from './pricing';

/** Suggested prices for ship-mined ore at each quality, from how rare that quality is. */
export default function PriceGuide() {
  const [region, setRegion] = useState<Region>('stanton');

  return (
    <div className="price-guide">
      <div className="price-head">
        <p className="muted">
          Suggested price per SCU. It rises with how rare the quality is: ten times rarer adds one base price, capped at 6x. Base
          prices are starting values for the org to set. Quality is "this or better".
        </p>
        <div className="market-tabs" role="tablist">
          {(['stanton', 'pyro'] as Region[]).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={region === r}
              className={region === r ? 'on' : undefined}
              onClick={() => setRegion(r)}
            >
              {r === 'stanton' ? 'Stanton and elsewhere' : 'Pyro'}
            </button>
          ))}
        </div>
      </div>

      <div className="price-scroll">
        <table className="price-table">
          <thead>
            <tr>
              <th>Ore</th>
              <th>Class</th>
              {GUIDE_QUALITIES.map((q) => (
                <th key={q}>{q === 500 ? 'Base' : `${q}+`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORES.map((ore) => {
              const cls = CLASSES[ore.classId];
              return (
                <tr key={ore.name}>
                  <td>{ore.name}</td>
                  <td>
                    {cls.label}
                    {!ore.confirmed && (
                      <span className="guess" title="Class is a best guess, not yet checked against the game">
                        {' '}
                        ?
                      </span>
                    )}
                  </td>
                  {GUIDE_QUALITIES.map((q) => (
                    <td key={q}>
                      {materialPrice(cls.basePrice, q, ore.classId, region).toLocaleString()}
                      <span className="chance">{q === 500 ? '' : formatChance(chanceAtLeast(q, ore.classId, region))}</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">A "?" means the ore's rarity class is a guess. Copper and Torite are confirmed.</p>
    </div>
  );
}

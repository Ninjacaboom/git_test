import { useEffect, useState } from 'react';
import { getPrices, type PriceSnapshot } from './api';
import {
  CLASSES,
  GUIDE_QUALITIES,
  ORES,
  chanceAtLeast,
  DEFAULT_STEEPNESS,
  baseInfo,
  findMarketPrice,
  formatChance,
  materialPrice,
  type Region,
} from './pricing';

/** Suggested prices for ship-mined ore at each quality, from how rare that quality is. */
const KEY = 'nova.basePrices';
const STEEP_KEY = 'nova.steepness';

function loadSteepness(): number {
  try {
    const n = Number(localStorage.getItem(STEEP_KEY));
    return n > 0 && n <= 1 ? n : DEFAULT_STEEPNESS;
  } catch {
    return DEFAULT_STEEPNESS;
  }
}

function loadOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export default function PriceGuide() {
  const [region, setRegion] = useState<Region>('stanton');
  const [steepness, setSteepness] = useState<number>(loadSteepness);

  function chooseSteepness(value: string) {
    const n = Number(value);
    if (!(n > 0 && n <= 1)) return;
    setSteepness(n);
    try {
      localStorage.setItem(STEEP_KEY, String(n));
    } catch {
      // storage unavailable: the choice lasts until the page is reloaded
    }
  }
  // Base prices typed in here. Kept in this browser for now; sharing them across the org needs the backend.
  const [overrides, setOverrides] = useState<Record<string, number>>(loadOverrides);

  // What commodity terminals pay, from the backend (which refreshes it from UEX once a day).
  const [market, setMarket] = useState<PriceSnapshot | null>(null);
  const [marketError, setMarketError] = useState(false);

  useEffect(() => {
    getPrices()
      .then(setMarket)
      .catch(() => setMarketError(true));
  }, []);

  function setBase(name: string, value: string) {
    const next = { ...overrides };
    const n = Math.round(Number(value));
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) delete next[name];
    else next[name] = n;
    setOverrides(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: prices last until the page is reloaded
    }
  }

  return (
    <div className="price-guide">
      <div className="price-head">
        <p className="muted">
          Suggested price per SCU. The price is the base price times (1 / chance) to the power of the steepness, capped at
          200x. The Base column starts from what commodity terminals pay (UEX), and you can type your own over it. Grey numbers
          are placeholders from the ore's rarity class. Quality is "this or better".
        </p>
        <label className="steepness">
          Steepness
          <input
            type="number"
            min={0.05}
            max={1}
            step={0.05}
            value={steepness}
            onChange={(e) => chooseSteepness(e.target.value)}
          />
          <span className="muted">0.5 = the square root of how many times rarer it is. 1 = price follows rarity exactly.</span>
        </label>
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
              const found = market ? findMarketPrice(ore.name, market.prices) : null;
              const { value: base, source } = baseInfo(ore, overrides, found);
              const own = source !== 'class';
              const title =
                source === 'market' && found
                  ? `Average of ${found.terminals} terminal${found.terminals === 1 ? '' : 's'} paying for ${found.name} (UEX)`
                  : source === 'typed'
                    ? 'Typed by you'
                    : 'Placeholder from the rarity class';
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
                  {GUIDE_QUALITIES.map((q) =>
                    q === 500 ? (
                      <td key={q}>
                        <input
                          type="number"
                          min={0}
                          className={own ? 'base-input' : 'base-input placeholder'}
                          aria-label={`${ore.name} base price`}
                          title={title}
                          value={own ? base : ''}
                          placeholder={String(base)}
                          onChange={(e) => setBase(ore.name, e.target.value)}
                        />
                      </td>
                    ) : (
                      <td key={q}>
                        {materialPrice(base, q, ore.classId, region, steepness).toLocaleString()}
                        <span className="chance">{formatChance(chanceAtLeast(q, ore.classId, region))}</span>
                      </td>
                    ),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        A "?" means the ore's rarity class is a guess. Copper and Torite are confirmed.{' '}
        {market
          ? `Terminal prices from UEX, last fetched ${new Date(market.fetchedAt).toLocaleString()}.`
          : marketError
            ? 'Terminal prices are not available right now, so the base prices are placeholders.'
            : 'Loading terminal prices…'}
      </p>
    </div>
  );
}

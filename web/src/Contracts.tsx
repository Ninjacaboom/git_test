import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  cancelContract,
  claimContract,
  completeContract,
  createContract,
  getContracts,
  getPrices,
  getResources,
  releaseContract,
  type CommodityPrice,
  type Contract,
  type Member,
  type Resource,
} from './api';
import { findMarketPrice } from './pricing';

type Props = { current: Member | null; members: Member[] };

/** A short code for a material, like the 4-letter tickers on a commodity board. Kept unique. */
function makeCodes(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const name of names) {
    const letters = name.replace(/\(.*?\)/g, '').replace(/[^A-Za-z ]/g, '').trim();
    const words = letters.split(/\s+/);
    let code = words.length > 1 ? words.map((w) => w[0]).join('').padEnd(4, words[words.length - 1].slice(1)) : letters;
    code = code.slice(0, 4).toUpperCase();
    let i = 4;
    while (used.has(code) && i < letters.length) code = (code.slice(0, 3) + letters[i++]).toUpperCase();
    used.add(code);
    out.set(name, code);
  }
  return out;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function Contracts({ current, members }: Props) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [prices, setPrices] = useState<CommodityPrice[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = () =>
    getContracts()
      .then(setContracts)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    getResources().then(setResources).catch((e: Error) => setError(e.message));
    getPrices().then((s) => setPrices(s.prices)).catch(() => undefined);
    void load();
  }, []);

  const codes = useMemo(() => makeCodes(resources.map((r) => r.name)), [resources]);
  const memberName = (id: string | null) => (id ? (members.find((m) => m.id === id)?.name ?? id) : '');
  const active = contracts.filter((c) => c.status !== 'Done');
  const countFor = (m: string) => active.filter((c) => c.material === m).length;
  const unit = (m: string) => (resources.find((r) => r.name === m)?.unitType ?? 'SCU');

  const shown = picked ? active.filter((c) => c.material === picked) : active;
  const hot = shown.filter((c) => c.hot);
  const needed = shown.filter((c) => !c.hot);

  const run = (fn: () => Promise<unknown>) => fn().then(load).catch((e: Error) => setError(e.message));

  const card = (c: Contract) => {
    const mine = current?.id === c.postedByMemberId;
    const claimedByMe = current?.id === c.claimedByMemberId;
    return (
      <div key={c.id} className={`card contract-card${c.hot ? ' hot' : ''}`}>
        <div className="contract-top">
          <strong>{c.material}</strong>
          {c.hot && <span className="badge hot-badge">HOT</span>}
          <span className="muted">{c.status}</span>
        </div>
        <div>
          {c.quantity} {unit(c.material)} · {c.minQuality > 0 ? `${c.minQuality}+ quality` : 'any quality'}
        </div>
        <div>{c.rewardPerUnit ? `${c.rewardPerUnit.toLocaleString()} aUEC per ${unit(c.material)}` : 'Reward by agreement'}</div>
        {c.notes && <div className="muted">{c.notes}</div>}
        <div className="muted">
          Posted by {memberName(c.postedByMemberId)}
          {c.claimedByMemberId && ` · picked up by ${memberName(c.claimedByMemberId)}`}
        </div>
        {current && (
          <div className="contract-actions">
            {c.status === 'Open' && !mine && <button onClick={() => run(() => claimContract(c.id, current.id))}>I can supply this</button>}
            {c.status === 'Claimed' && claimedByMe && <button onClick={() => run(() => releaseContract(c.id, current.id))}>Put back</button>}
            {c.status === 'Claimed' && mine && <button onClick={() => run(() => completeContract(c.id, current.id))}>Mark delivered</button>}
            {mine && <button onClick={() => run(() => cancelContract(c.id, current.id))}>Cancel</button>}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="market contracts">
      <h2>Crafting materials</h2>
      <div className="tile-grid">
        {resources.map((r) => {
          const mp = findMarketPrice(r.name, prices);
          const n = countFor(r.name);
          return (
            <button
              key={r.id}
              className={`tile${picked === r.name ? ' on' : ''}${n ? ' wanted' : ''}`}
              onClick={() => setPicked(picked === r.name ? null : r.name)}
              title={`${r.name}${mp ? ` · ${Math.round(mp.price).toLocaleString()} aUEC avg` : ''}${n ? ` · ${n} open` : ''}`}
            >
              <span className="tile-code">{codes.get(r.name)}</span>
              <span className="tile-val">{mp ? compact(mp.price) : '–'}</span>
              {n > 0 && <span className="tile-count">{n}</span>}
            </button>
          );
        })}
      </div>
      <p className="muted">
        Values are the average price terminals pay per SCU (UEX). Click a material to filter the cards below.
        {picked && ' Showing: ' + picked + '.'}
      </p>

      {error && <p className="error">{error}</p>}

      <div className="contracts-head">
        <h2>Hot acquisitions</h2>
        {current && <button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : 'Post a request'}</button>}
      </div>
      {showForm && current && (
        <RequestForm
          resources={resources}
          member={current}
          initial={picked}
          onDone={() => {
            setShowForm(false);
            void load();
          }}
          onError={setError}
        />
      )}
      <div className="card-grid">{hot.length ? hot.map(card) : <p className="muted">Nothing marked hot.</p>}</div>

      <h2>Needed acquisitions</h2>
      <div className="card-grid">{needed.length ? needed.map(card) : <p className="muted">No open requests.</p>}</div>
    </section>
  );
}

function RequestForm(props: {
  resources: Resource[];
  member: Member;
  initial: string | null;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [material, setMaterial] = useState(props.initial ?? props.resources[0]?.name ?? '');
  const [quantity, setQuantity] = useState('10');
  const [minQuality, setMinQuality] = useState('0');
  const [reward, setReward] = useState('');
  const [hot, setHot] = useState(false);
  const [notes, setNotes] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    createContract({
      material,
      quantity: Number(quantity),
      minQuality: Number(minQuality) || 0,
      rewardPerUnit: reward ? Number(reward) : null,
      postedByMemberId: props.member.id,
      hot,
      notes: notes.trim() || null,
    })
      .then(props.onDone)
      .catch((err: Error) => props.onError(err.message));
  };

  return (
    <form className="contract-form" onSubmit={submit}>
      <select value={material} onChange={(e) => setMaterial(e.target.value)}>
        {props.resources.map((r) => (
          <option key={r.id}>{r.name}</option>
        ))}
      </select>
      <input type="number" min="0.01" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" />
      <input type="number" min="0" max="1000" value={minQuality} onChange={(e) => setMinQuality(e.target.value)} placeholder="Min quality (0 = any)" />
      <input type="number" min="0" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="aUEC per unit (optional)" />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" />
      <label>
        <input type="checkbox" checked={hot} onChange={(e) => setHot(e.target.checked)} /> Hot (urgent)
      </label>
      <button type="submit">Post request</button>
    </form>
  );
}

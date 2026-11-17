import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createLot,
  getLots,
  searchRecipes,
  type Lot,
  type Member,
  type RecipeSummary,
  type Squadron,
} from './api';
import { prettyType } from './format';
import { bandOf } from './quality';

type Tab = 'public' | 'squadron' | 'mine';

const TABS: { id: Tab; label: string }[] = [
  { id: 'public', label: 'Public market' },
  { id: 'squadron', label: 'My squadron' },
  { id: 'mine', label: 'My items' },
];

type Props = {
  current: Member | null;
  members: Member[];
  squadrons: Squadron[];
};

/** Market page: browse lots and list new ones. Which lots a member sees depends on the tab. */
export default function Market({ current, members, squadrons }: Props) {
  const [tab, setTab] = useState<Tab>('public');
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(() => {
    getLots()
      .then((l) => {
        setLots(l);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  const visible = useMemo(() => {
    if (!lots) return [];
    switch (tab) {
      case 'public':
        return lots.filter((l) => l.stage === 'Public');
      case 'squadron':
        return current?.squadronId
          ? lots.filter((l) => l.ownerKind === 'squadron' && l.ownerId === current.squadronId)
          : [];
      case 'mine':
        return current ? lots.filter((l) => l.ownerKind === 'member' && l.ownerId === current.id) : [];
    }
  }, [lots, tab, current]);

  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const ownerName = (l: Lot) =>
    l.ownerKind === 'squadron'
      ? (squadrons.find((s) => s.id === l.ownerId)?.name ?? l.ownerId)
      : memberName(l.ownerId);

  return (
    <section className="market">
      <div className="market-bar">
        <div className="market-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="market-add"
          disabled={!current}
          title={current ? undefined : 'Pick who you are viewing as (top right) to list an item'}
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? 'Close' : 'List an item'}
        </button>
      </div>

      {showForm && current && (
        <ListForm
          member={current}
          onDone={() => {
            setShowForm(false);
            reload();
          }}
        />
      )}

      {error && <p className="error">{error}</p>}

      {tab !== 'public' && !current && <p className="muted">Pick who you are viewing as (top right) to see this.</p>}
      {tab === 'squadron' && current && !current.squadronId && (
        <p className="muted">{current.name} is not in a squadron.</p>
      )}

      {lots === null && !error && <p className="muted">Loading…</p>}
      {lots !== null && visible.length === 0 && (tab === 'public' || current) && (
        <p className="muted">Nothing here yet.</p>
      )}

      <div className="lot-grid">
        {visible.map((l) => {
          const band = bandOf(l.quality);
          return (
            <article key={l.id} className="lot-card">
              <div className="lot-head">
                <span className="type-tag">{prettyType(l.itemType)}</span>
                <div className="lot-name">{l.itemName}</div>
              </div>
              <div className="lot-quality" style={{ color: band.color }}>
                Q{l.quality}
              </div>
              <dl>
                <dt>Quantity</dt>
                <dd>{l.quantity}</dd>
                <dt>{l.ownerKind === 'squadron' ? 'Squadron' : 'Seller'}</dt>
                <dd>{ownerName(l)}</dd>
                {l.ownerKind === 'squadron' && (
                  <>
                    <dt>Made by</dt>
                    <dd>{memberName(l.madeByMemberId)}</dd>
                  </>
                )}
                <dt>Stage</dt>
                <dd>{l.stage}</dd>
              </dl>
              <div className="lot-price">{l.priceAuec == null ? 'Price on request' : `${l.priceAuec.toLocaleString()} aUEC`}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ListForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<RecipeSummary[]>([]);
  const [picked, setPicked] = useState<RecipeSummary | null>(null);
  const [quality, setQuality] = useState(500);
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [forSquadron, setForSquadron] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (picked || search.trim().length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      searchRecipes(search, [], false)
        .then((r) => setMatches(r.slice(0, 8)))
        .catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search, picked]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await createLot({
        recipeId: picked.id,
        quality,
        quantity,
        madeByMemberId: member.id,
        forSquadron,
        priceAuec: price.trim() === '' ? null : Math.max(0, Math.round(Number(price))),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="list-form" onSubmit={submit}>
      <div className="form-title">List an item as {member.name}</div>

      <label>
        Item
        {picked ? (
          <span className="picked">
            {picked.name}
            <button type="button" onClick={() => setPicked(null)}>
              Change
            </button>
          </span>
        ) : (
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the catalogue…" />
        )}
      </label>
      {!picked && matches.length > 0 && (
        <ul className="list-matches">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  setPicked(m);
                  setSearch('');
                }}
              >
                {m.name} <span className="muted">{prettyType(m.type)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="list-row">
        <label>
          Quality (0–1000)
          <input type="number" min={0} max={1000} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
        </label>
        <label>
          Quantity
          <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))} />
        </label>
        <label>
          Price (aUEC)
          <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={forSquadron}
          disabled={!member.squadronId}
          onChange={(e) => setForSquadron(e.target.checked)}
        />
        Made for my squadron (goes to the squadron armoury first)
      </label>

      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={!picked || busy}>
        {busy ? 'Listing…' : 'List item'}
      </button>
    </form>
  );
}

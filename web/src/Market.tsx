import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createLot,
  getLots,
  getMarketListings,
  type LotKind,
  type MarketListing,
  searchRecipes,
  type Lot,
  type Member,
  type RecipeSummary,
  type Squadron,
} from './api';
import { prettyType } from './format';
import { compsFor, listingsFor } from './comps';
import LotCard from './LotCard';
import PriceGuide from './PriceGuide';

type Tab = 'public' | 'squadron' | 'mine' | 'prices';

const KINDS: { id: LotKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'WTS', label: 'WTS' },
  { id: 'WTB', label: 'WTB' },
  { id: 'WTT', label: 'WTT' },
];

const TABS: { id: Tab; label: string }[] = [
  { id: 'public', label: 'Public market' },
  { id: 'squadron', label: 'My squadron' },
  { id: 'mine', label: 'My items' },
  { id: 'prices', label: 'Price guide' },
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
  const [kindFilter, setKindFilter] = useState<LotKind | 'all'>('all');

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
    const byKind = kindFilter === 'all' ? lots : lots.filter((l) => l.kind === kindFilter);
    switch (tab) {
      case 'public':
        return byKind.filter((l) => l.stage === 'Public');
      case 'squadron':
        return current?.squadronId
          ? byKind.filter((l) => l.ownerKind === 'squadron' && l.ownerId === current.squadronId)
          : [];
      case 'prices':
        return [];
      case 'mine':
        return current ? byKind.filter((l) => l.ownerKind === 'member' && l.ownerId === current.id) : [];
    }
  }, [lots, tab, current, kindFilter]);

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
          title={current ? undefined : 'Pick who you are viewing as (top right) to post'}
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? 'Close' : 'New post'}
        </button>
      </div>

      {tab !== 'prices' && (
        <div className="kind-filter" role="group" aria-label="Post type">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kindFilter === k.id}
              className={kindFilter === k.id ? 'on' : undefined}
              onClick={() => setKindFilter(k.id)}
              title={k.id === 'WTS' ? 'Want to sell' : k.id === 'WTB' ? 'Want to buy' : k.id === 'WTT' ? 'Want to trade' : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}

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

      {tab !== 'public' && tab !== 'prices' && !current && <p className="muted">Pick who you are viewing as (top right) to see this.</p>}
      {tab === 'squadron' && current && !current.squadronId && (
        <p className="muted">{current.name} is not in a squadron.</p>
      )}

      {tab !== 'prices' && lots === null && !error && <p className="muted">Loading…</p>}
      {tab !== 'prices' && lots !== null && visible.length === 0 && (tab === 'public' || current) && (
        <p className="muted">Nothing here yet.</p>
      )}

      {tab === 'prices' && <PriceGuide />}

      <div className="lot-grid">
        {visible.map((l) => (
          <LotCard key={l.id} lot={l} ownerName={ownerName(l)} madeBy={memberName(l.madeByMemberId)} />
        ))}
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
  const [kind, setKind] = useState<LotKind>('WTS');
  const [wanted, setWanted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<MarketListing[] | null>(null);
  const [listingsError, setListingsError] = useState(false);

  // Player listings from the UEX marketplace, for comparing prices. Loaded when the form opens.
  useEffect(() => {
    getMarketListings()
      .then((s) => setListings(s.listings))
      .catch(() => setListingsError(true));
  }, []);

  const comps = picked && listings ? compsFor(listingsFor(picked.name, listings), quality) : null;

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
        forSquadron: kind === 'WTS' && forSquadron,
        priceAuec: price.trim() === '' ? null : Math.max(0, Math.round(Number(price))),
        kind,
        wanted: kind === 'WTT' ? wanted.trim() : null,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="list-form" onSubmit={submit}>
      <div className="form-title">Post as {member.name}</div>

      <div className="kind-filter" role="group" aria-label="Post type">
        {(
          [
            ['WTS', 'WTS: selling'],
            ['WTB', 'WTB: buying'],
            ['WTT', 'WTT: trading'],
          ] as [LotKind, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'on' : undefined} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>

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
          {kind === 'WTB' ? 'Minimum quality (0–1000)' : 'Quality (0–1000)'}
          <input type="number" min={0} max={1000} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
        </label>
        <label>
          Quantity
          <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))} />
        </label>
        <label>
          {kind === 'WTB' ? 'Most you will pay (aUEC)' : kind === 'WTT' ? 'Plus aUEC (optional)' : 'Price (aUEC)'}
          <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="optional" />
        </label>
      </div>

      {picked && (
        <div className="comps">
          <div className="comps-title">What players are asking on UEX</div>
          {listingsError && <p className="muted">Marketplace prices are not available right now.</p>}
          {!listingsError && listings === null && <p className="muted">Loading listings…</p>}
          {comps && comps.nearest.length === 0 && (
            <p className="muted">No listings found with "{picked.name}" in the title.</p>
          )}
          {comps && comps.nearest.length > 0 && (
            <>
              <ul>
                {comps.nearest.map((l, i) => (
                  <li key={i}>
                    <span>{l.quality !== null && l.quality > 1 ? `Q${l.quality}` : 'no quality'}</span>
                    <span>{l.price.toLocaleString()} aUEC</span>
                    <span className="muted">{l.title}</span>
                  </li>
                ))}
              </ul>
              <div className="comps-median">
                Middle asking price: <strong>{comps.median?.toLocaleString()} aUEC</strong>
                <button type="button" onClick={() => setPrice(String(comps.median))}>
                  Use this price
                </button>
              </div>
              {comps.includesUnrated && (
                <p className="muted">Some listings have no quality, so they are not matched to yours.</p>
              )}
              <p className="muted">These are asking prices, not sales, so they run higher than what items actually sell for.</p>
            </>
          )}
        </div>
      )}

      {kind === 'WTT' && (
        <label>
          What you want in exchange
          <input value={wanted} onChange={(e) => setWanted(e.target.value)} placeholder="e.g. a 900Q Gallant, or 2 SCU of 850Q Agricium" />
        </label>
      )}

      {kind === 'WTS' && (
        <label className="check">
          <input
            type="checkbox"
            checked={forSquadron}
            disabled={!member.squadronId}
            onChange={(e) => setForSquadron(e.target.checked)}
          />
          Made for my squadron (goes to the squadron armoury first)
        </label>
      )}

      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={!picked || busy || (kind === 'WTT' && wanted.trim() === '')}>
        {busy ? 'Posting…' : `Post ${kind}`}
      </button>
    </form>
  );
}

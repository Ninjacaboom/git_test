import { useEffect, useState } from 'react';
import { getLots, type Lot, type Member, type Squadron } from './api';
import LotCard from './LotCard';

type Props = { current: Member | null; members: Member[]; squadrons: Squadron[] };

/**
 * "My orders": everything that involves the picked member in one place. For now that is the items
 * they are selling and the squadron items they made. Claims and requests are added with the
 * release ladder and the contracts board.
 */
export default function Orders({ current, members, squadrons }: Props) {
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLots()
      .then(setLots)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!current) {
    return (
      <section className="market">
        <p className="muted">Pick who you are viewing as (top right) to see your orders.</p>
      </section>
    );
  }

  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const ownerName = (l: Lot) =>
    l.ownerKind === 'squadron'
      ? (squadrons.find((s) => s.id === l.ownerId)?.name ?? l.ownerId)
      : memberName(l.ownerId);

  const selling = (lots ?? []).filter((l) => l.ownerKind === 'member' && l.ownerId === current.id);
  const madeForSquadron = (lots ?? []).filter((l) => l.ownerKind === 'squadron' && l.madeByMemberId === current.id);

  const section = (title: string, items: Lot[], empty: string) => (
    <div className="orders-section">
      <div className="orders-title">
        {title} <span className="muted">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="lot-grid">
          {items.map((l) => (
            <LotCard key={l.id} lot={l} ownerName={ownerName(l)} madeBy={memberName(l.madeByMemberId)} />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="market">
      {error && <p className="error">{error}</p>}
      {lots === null && !error && <p className="muted">Loading…</p>}
      {lots !== null && (
        <>
          {section('Items I am selling', selling, 'You have nothing listed. Use "List an item" on the Market page.')}
          {section('Made for my squadron', madeForSquadron, 'You have not made anything for your squadron yet.')}
          <div className="orders-section">
            <div className="orders-title">Claims and requests</div>
            <p className="muted">Items you claim and contracts you post or pick up will show here. Coming soon.</p>
          </div>
        </>
      )}
    </section>
  );
}

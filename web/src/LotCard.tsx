import type { Lot } from './api';
import { prettyType } from './format';
import { bandOf } from './quality';

/** One stock lot: used by the Market and My orders pages. */
export default function LotCard({ lot: l, ownerName, madeBy }: { lot: Lot; ownerName: string; madeBy: string }) {
  const band = l.quality === null ? null : bandOf(l.quality);
  return (
    <article className="lot-card">
      <div className="lot-head">
        <span className={`kind-tag kind-${l.kind.toLowerCase()}`}>{l.kind}</span>{' '}
        <span className="type-tag">{prettyType(l.itemType)}</span>
        <div className="lot-name">{l.itemName}</div>
      </div>
      {band && l.quality !== null && (
        <div className="lot-quality" style={{ color: band.color }}>
          {l.kind === 'WTB' ? 'Minimum Q' : 'Q'}
          {l.quality}
        </div>
      )}
      <dl>
        <dt>Quantity</dt>
        <dd>{l.quantity}</dd>
        <dt>{l.kind === 'WTB' ? 'Buyer' : l.kind === 'WTT' ? 'Trader' : l.ownerKind === 'squadron' ? 'Squadron' : 'Seller'}</dt>
        <dd>{ownerName}</dd>
        {l.ownerKind === 'squadron' && (
          <>
            <dt>Made by</dt>
            <dd>{madeBy}</dd>
          </>
        )}
        {l.kind === 'WTT' && (
          <>
            <dt>Wants</dt>
            <dd>{l.wanted}</dd>
          </>
        )}
        {l.kind === 'WTS' && (
          <>
            <dt>Stage</dt>
            <dd>{l.stage}</dd>
          </>
        )}
      </dl>
      {l.slotQualities && (
        <div className="lot-slots">
          {Object.entries(l.slotQualities).map(([slot, q]) => (
            <span key={slot} style={{ color: bandOf(q).color }}>
              {slot} Q{q}
            </span>
          ))}
        </div>
      )}
      {l.notes && <div className="lot-notes">{l.notes}</div>}
      <div className="lot-price">
        {l.priceAuec == null
          ? l.kind === 'WTT'
            ? 'Item for item'
            : 'Price on request'
          : l.kind === 'WTB'
            ? `Up to ${l.priceAuec.toLocaleString()} aUEC`
            : l.kind === 'WTT'
              ? `Plus ${l.priceAuec.toLocaleString()} aUEC`
              : `${l.priceAuec.toLocaleString()} aUEC`}
      </div>
    </article>
  );
}

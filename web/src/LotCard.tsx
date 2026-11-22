import type { Lot } from './api';
import { prettyType } from './format';
import { bandOf } from './quality';

/** One stock lot: used by the Market and My orders pages. */
export default function LotCard({ lot: l, ownerName, madeBy }: { lot: Lot; ownerName: string; madeBy: string }) {
  const band = bandOf(l.quality);
  return (
    <article className="lot-card">
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
        <dd>{ownerName}</dd>
        {l.ownerKind === 'squadron' && (
          <>
            <dt>Made by</dt>
            <dd>{madeBy}</dd>
          </>
        )}
        <dt>Stage</dt>
        <dd>{l.stage}</dd>
      </dl>
      <div className="lot-price">{l.priceAuec == null ? 'Price on request' : `${l.priceAuec.toLocaleString()} aUEC`}</div>
    </article>
  );
}

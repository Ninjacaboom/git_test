import { useState, type FormEvent } from 'react';
import { createLot, type Member, type Recipe } from './api';
import { bandOf } from './quality';

type Props = {
  recipe: Recipe;
  /** The material quality chosen in each slot (slot name -> quality). */
  qualities: Record<string, number>;
  /** Who the site is being viewed as. Orders are posted as this member. */
  member: Member | null;
  onViewMarket: () => void;
};

/**
 * "Order at this quality": posts a WTB (want to buy) on the Market for this item with the material
 * qualities currently chosen on the sliders.
 */
export default function OrderPanel({ recipe, qualities, member, onViewMarket }: Props) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const slots = recipe.slots.filter((s) => qualities[s.name] !== undefined);
  const values = slots.map((s) => qualities[s.name]);
  const average = values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 500;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await createLot({
        recipeId: recipe.id,
        quality: average,
        slotQualities: qualities,
        quantity,
        madeByMemberId: member.id,
        forSquadron: false,
        priceAuec: price.trim() === '' ? null : Math.max(0, Math.round(Number(price))),
        kind: 'WTB',
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="order-panel">
      <button
        type="button"
        className="order-btn"
        disabled={!member}
        title={member ? undefined : 'Pick who you are viewing as (top right) to place an order'}
        onClick={() => {
          setDone(false);
          setOpen((o) => !o);
        }}
      >
        {open ? 'Close order' : 'Order at this quality'}
      </button>
      {!member && <span className="muted"> Pick who you are viewing as (top right) to order.</span>}

      {done && (
        <p className="order-done">
          Order posted as a WTB.{' '}
          <button type="button" className="link-btn" onClick={onViewMarket}>
            View it on the Market
          </button>
        </p>
      )}

      {open && member && (
        <form className="list-form" onSubmit={submit}>
          <div className="form-title">Order {recipe.name} as {member.name}</div>
          <p className="muted">Materials you chose on the sliders:</p>
          <ul className="order-slots">
            {slots.map((s) => (
              <li key={s.name}>
                <span>{s.displayName || s.name}</span>
                <span style={{ color: bandOf(qualities[s.name]).color }}>Q{qualities[s.name]}</span>
              </li>
            ))}
          </ul>
          <p className="muted">Average quality {average}. Anyone who can craft or sell it to you will see exactly these materials.</p>

          <div className="list-row">
            <label>
              Quantity
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))} />
            </label>
            <label>
              Most you will pay (aUEC)
              <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="optional" />
            </label>
          </div>
          <label>
            Notes (optional)
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Deadline, where to deliver, anything else" maxLength={300} />
          </label>

          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Posting…' : 'Post order'}
          </button>
        </form>
      )}
    </div>
  );
}

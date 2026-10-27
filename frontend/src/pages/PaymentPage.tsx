import { useState } from 'react';
import KioskShell from '../components/KioskShell';
import OrderSummary from '../components/OrderSummary';
import { useOrder } from '../lib/useOrder';
import { money, submitPayment } from '../lib/order';
import { emitAppError, emitValidationError, namedAction } from '../rum/events';
import { hardNavigate, hardNavigateBack } from '../rum/navigate';
import { startOperation } from '../rum/operation';
import { setOrderContext } from '../rum/order-context';
import { usePageEntered } from '../rum/use-page-entered';

const TIP_OPTIONS = [0, 10, 18, 25];

/** Digits only, grouped in fours — purely cosmetic, never leaves the browser. */
function formatCard(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

export default function PaymentPage() {
  const { snapshot, hydrating, setSnapshot } = useOrder('payment');
  const [card, setCard] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [tipPercent, setTipPercent] = useState(18);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  usePageEntered('payment', {
    'traceys.pizzeria.page.awaiting_hydration': snapshot === null,
    // The tip the customer is shown before touching anything, so the records
    // where they changed it are distinguishable from the records where the
    // default rode through to the charge.
    'traceys.pizzeria.page.default_tip_percent': tipPercent,
  });

  function chooseTip(next: number) {
    setTipPercent(next);
    setOrderContext({ tipPercent: next });
  }

  /**
   * Same pattern as the checkout page: every failing field becomes its own
   * RUM Error, so "which field do customers get wrong" is a group-by rather
   * than a guess. A 15-digit card is the easiest one to trigger on stage.
   */
  function validate(): boolean {
    const found: Record<string, string> = {};
    const digits = card.replace(/\D/g, '');

    if (digits.length !== 16) found.card = 'Card number must be 16 digits.';
    if (!/^\d{2}\/\d{2}$/.test(expiry.trim())) found.expiry = 'Use MM/YY.';
    if (!/^\d{3,4}$/.test(cvc.trim())) found.cvc = 'CVC must be 3 or 4 digits.';

    setErrors(found);
    for (const [field, message] of Object.entries(found)) {
      emitValidationError(field, `${field}_format`, message, 'payment');
    }
    return Object.keys(found).length === 0;
  }

  async function placeOrder() {
    if (!validate() || submitting) return;

    setSubmitting(true);
    setFailure(null);

    const op = startOperation('payment.submit', {
      'traceys.pizzeria.funnel.step': 'payment',
      'traceys.pizzeria.tip_percent': tipPercent,
    });
    let fresh;
    try {
      fresh = await op.run(() => submitPayment(card, tipPercent));
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      op.fail(err);
      // A declined card is a business outcome, not a bug — but it is still
      // the RUM Error you want to see next to the drop-off it causes, and
      // op.ctx is what puts it in the same trace as the failed charge.
      emitAppError(
        code === 'card_declined' ? 'PaymentDeclinedError' : 'PaymentError',
        err,
        {
          'traceys.pizzeria.funnel.step': 'payment',
          ...(code ? { 'traceys.pizzeria.payment.failure_code': code } : {}),
        },
        op.ctx
      );
      setFailure((err as Error).message);
      setSubmitting(false);
      return;
    } finally {
      op.end();
    }

    setSnapshot(fresh);
    await hardNavigate('payment', 'tracking');
  }

  if (!snapshot) {
    return (
      <KioskShell step="payment">
        <div className="panel">{hydrating ? 'Loading your order…' : 'No order found.'}</div>
      </KioskShell>
    );
  }

  const tipAmount = (snapshot.pricing.subtotal * tipPercent) / 100;
  const dueNow =
    snapshot.pricing.subtotal + snapshot.pricing.deliveryFee + snapshot.pricing.tax + tipAmount;

  return (
    <KioskShell step="payment">
      <OrderSummary snapshot={snapshot} />

      <section className="panel">
        <h2>Payment</h2>
        <p className="panel-note">
          Fake card, fake money, real telemetry. Try <code>4242 4242 4242 4242</code>.
        </p>

        <div className="form">
          <label className="field">
            <span>Card number</span>
            <input
              value={card}
              onChange={(e) => setCard(formatCard(e.target.value))}
              placeholder="4242 4242 4242 4242"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={!!errors.card}
            />
            {errors.card && <span className="field-error">{errors.card}</span>}
          </label>

          <div className="field-pair">
            <label className="field">
              <span>Expiry</span>
              <input
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                placeholder="12/29"
                maxLength={5}
                aria-invalid={!!errors.expiry}
              />
              {errors.expiry && <span className="field-error">{errors.expiry}</span>}
            </label>
            <label className="field">
              <span>CVC</span>
              <input
                value={cvc}
                onChange={(e) => setCvc(e.target.value)}
                placeholder="123"
                maxLength={4}
                inputMode="numeric"
                aria-invalid={!!errors.cvc}
              />
              {errors.cvc && <span className="field-error">{errors.cvc}</span>}
            </label>
          </div>
        </div>

        <h3>Tip the crew</h3>
        <div className="tip-row">
          {TIP_OPTIONS.map((percent) => (
            <button
              key={percent}
              className={`tip ${tipPercent === percent ? 'selected' : ''}`}
              onClick={() => chooseTip(percent)}
              {...namedAction('payment.select_tip', { tip: String(percent) })}
            >
              {percent === 0 ? 'None' : `${percent}%`}
              <small>{money((snapshot.pricing.subtotal * percent) / 100)}</small>
            </button>
          ))}
        </div>

        <div className="due-now">
          <span>Due now</span>
          <strong>{money(dueNow)}</strong>
        </div>

        {failure && <p className="banner-error">{failure}</p>}

        <div className="action-row">
          <button
            className="ghost"
            onClick={() => void hardNavigateBack('payment', 'checkout')}
            {...namedAction('payment.back_to_checkout')}
          >
            Back
          </button>
          <button
            className="primary"
            onClick={placeOrder}
            disabled={submitting}
            {...namedAction('payment.place_order')}
          >
            {submitting ? 'Charging…' : `Complete purchase · ${money(dueNow)}`}
          </button>
        </div>
      </section>
    </KioskShell>
  );
}

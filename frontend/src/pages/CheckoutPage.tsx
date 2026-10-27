import { useState } from 'react';
import KioskShell from '../components/KioskShell';
import OrderSummary from '../components/OrderSummary';
import { useOrder } from '../lib/useOrder';
import { saveFulfillment, type Address, type Fulfillment } from '../lib/order';
import { emitAppError, emitValidationError, namedAction } from '../rum/events';
import { hardNavigate, hardNavigateBack } from '../rum/navigate';
import { startOperation } from '../rum/operation';
import { setOrderContext } from '../rum/order-context';
import { usePageEntered } from '../rum/use-page-entered';

const EMPTY_ADDRESS: Address = { street: '', city: '', zip: '' };

export default function CheckoutPage() {
  const { snapshot, hydrating, setSnapshot } = useOrder('checkout');
  const [fulfillment, setFulfillment] = useState<Fulfillment | null>(null);
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [errors, setErrors] = useState<Partial<Record<keyof Address, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  usePageEntered('checkout', {
    // True when the cache had nothing to paint, so the customer is looking at
    // "Loading your order…" rather than their pizza.
    'traceys.pizzeria.page.awaiting_hydration': snapshot === null,
  });

  function choose(next: Fulfillment) {
    setFulfillment(next);
    setErrors({});
    // Publish immediately so the clicks and vitals that follow this choice
    // already carry traceys.pizzeria.fulfillment, not just the ones after the POST.
    setOrderContext({ fulfillment: next });
  }

  /**
   * Client-side validation, emitted as RUM Errors (`exception` events) per
   * failing field. This is the deliberate error source for the demo: a short
   * ZIP or a blank street produces a real, faceted RUM Error without having
   * to break anything on the server.
   */
  function validate(): boolean {
    if (fulfillment !== 'delivery') return true;

    const found: Partial<Record<keyof Address, string>> = {};
    if (!address.street.trim()) found.street = 'Street address is required.';
    if (!address.city.trim()) found.city = 'City is required.';
    if (!/^\d{5}$/.test(address.zip.trim())) found.zip = 'ZIP must be 5 digits.';

    setErrors(found);
    for (const [field, message] of Object.entries(found)) {
      emitValidationError(field, field === 'zip' ? 'zip_format' : 'required', message, 'checkout');
    }
    return Object.keys(found).length === 0;
  }

  async function next() {
    if (!fulfillment) {
      const message = 'Choose pickup or delivery first.';
      setFailure(message);
      emitValidationError('fulfillment', 'required', message, 'checkout');
      return;
    }
    if (!validate() || submitting) return;

    setSubmitting(true);
    setFailure(null);

    // The span exists so the failure path has a trace to attach to: op.run
    // parents the POST's fetch span under it, and op.ctx is what carries
    // trace_id/span_id onto the RUM Error below. It has to end before
    // hardNavigate, which flushes and shuts the SDKs down.
    const op = startOperation('checkout.save_fulfillment', {
      'traceys.pizzeria.funnel.step': 'checkout',
      'traceys.pizzeria.fulfillment': fulfillment,
    });
    let fresh;
    try {
      fresh = await op.run(() =>
        saveFulfillment(fulfillment, fulfillment === 'delivery' ? address : null)
      );
    } catch (err) {
      op.fail(err);
      emitAppError('FulfillmentSaveError', err, { 'traceys.pizzeria.funnel.step': 'checkout' }, op.ctx);
      setFailure((err as Error).message);
      setSubmitting(false);
      return;
    } finally {
      op.end();
    }

    setSnapshot(fresh);
    await hardNavigate('checkout', 'payment');
  }

  if (!snapshot) {
    return (
      <KioskShell step="checkout">
        <div className="panel">{hydrating ? 'Loading your order…' : 'No order found.'}</div>
      </KioskShell>
    );
  }

  return (
    <KioskShell step="checkout">
      <OrderSummary snapshot={snapshot} />

      <section className="panel">
        <h2>How are we getting this to you?</h2>
        <div className="choice-row">
          <button
            className={`choice ${fulfillment === 'pickup' ? 'selected' : ''}`}
            onClick={() => choose('pickup')}
            {...namedAction('checkout.select_pickup', { 'fulfillment': 'pickup' })}
          >
            <span className="choice-icon">🏃</span>
            <span className="choice-label">Pick Up</span>
            <span className="choice-note">Ready at the counter · free</span>
          </button>
          <button
            className={`choice ${fulfillment === 'delivery' ? 'selected' : ''}`}
            onClick={() => choose('delivery')}
            {...namedAction('checkout.select_delivery', { 'fulfillment': 'delivery' })}
          >
            <span className="choice-icon">🛵</span>
            <span className="choice-label">Delivery</span>
            <span className="choice-note">To your door · $4.99</span>
          </button>
        </div>

        {fulfillment === 'delivery' && (
          <div className="form">
            <label className="field">
              <span>Street address</span>
              <input
                value={address.street}
                onChange={(e) => setAddress({ ...address, street: e.target.value })}
                placeholder="620 8th Ave"
                aria-invalid={!!errors.street}
              />
              {errors.street && <span className="field-error">{errors.street}</span>}
            </label>
            <label className="field">
              <span>City</span>
              <input
                value={address.city}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
                placeholder="New York"
                aria-invalid={!!errors.city}
              />
              {errors.city && <span className="field-error">{errors.city}</span>}
            </label>
            <label className="field">
              <span>ZIP</span>
              <input
                value={address.zip}
                onChange={(e) => setAddress({ ...address, zip: e.target.value })}
                placeholder="10018"
                inputMode="numeric"
                maxLength={5}
                aria-invalid={!!errors.zip}
              />
              {errors.zip && <span className="field-error">{errors.zip}</span>}
            </label>
          </div>
        )}

        {failure && <p className="banner-error">{failure}</p>}

        <div className="action-row">
          <button
            className="ghost"
            onClick={() => void hardNavigateBack('checkout', 'order')}
            {...namedAction('checkout.back_to_order')}
          >
            Back
          </button>
          <button
            className="primary"
            onClick={next}
            disabled={submitting}
            {...namedAction('checkout.continue_to_payment')}
          >
            {submitting ? 'Saving…' : 'Next'}
          </button>
        </div>
      </section>
    </KioskShell>
  );
}

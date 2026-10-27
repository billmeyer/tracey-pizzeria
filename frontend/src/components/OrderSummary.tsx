import { money, type OrderSnapshot } from '../lib/order';

interface OrderSummaryProps {
  snapshot: OrderSnapshot;
  /** Hide the tip line until the customer has actually chosen one. */
  showTip?: boolean;
  /**
   * Money is opt-in. While the customer is still building the pizza on the
   * order page there is no total to speak of yet — the delivery fee and tip
   * are not chosen until checkout and payment — so pricing stays hidden
   * until the checkout view, where the first real total appears.
   */
  showPricing?: boolean;
}

export default function OrderSummary({
  snapshot,
  showTip = false,
  showPricing = true,
}: OrderSummaryProps) {
  const { order, pricing } = snapshot;

  return (
    <section className="panel summary">
      <h2>Your pizza</h2>
      <p className={`summary-pizza${showPricing ? '' : ' no-pricing'}`}>
        {order.size ?? 'medium'} · {order.crust ?? 'regular'} crust
        <br />
        <span className="summary-toppings">
          {order.toppings.length ? order.toppings.join(', ') : 'cheese, obviously'}
        </span>
      </p>

      {showPricing && (
      <div className="summary-lines">
        <div className="summary-line">
          <span>Subtotal</span>
          <span>{money(pricing.subtotal)}</span>
        </div>
        {pricing.deliveryFee > 0 && (
          <div className="summary-line">
            <span>Delivery</span>
            <span>{money(pricing.deliveryFee)}</span>
          </div>
        )}
        <div className="summary-line">
          <span>Tax</span>
          <span>{money(pricing.tax)}</span>
        </div>
        {showTip && (
          <div className="summary-line">
            <span>Tip{order.tipPercent ? ` (${order.tipPercent}%)` : ''}</span>
            <span>{money(pricing.tip)}</span>
          </div>
        )}
        <div className="summary-line total">
          <span>Total</span>
          <span>{money(showTip ? pricing.total : pricing.total - pricing.tip)}</span>
        </div>
      </div>
      )}
    </section>
  );
}

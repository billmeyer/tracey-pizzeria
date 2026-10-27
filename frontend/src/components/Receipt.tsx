import { money, type Pricing } from '../lib/order';

interface ReceiptProps {
  orderNumber: string;
  etaMinutes: number;
  size: string | null;
  crust: string | null;
  toppings: string[];
  fulfillment?: string | null;
  pricing?: Pricing;
}

export default function Receipt({
  orderNumber,
  etaMinutes,
  size,
  crust,
  toppings,
  fulfillment,
  pricing,
}: ReceiptProps) {
  return (
    <div className="receipt">
      <div className="receipt-header">🍕 TRACEY'S PIZZERIA 🍕</div>
      <div className="receipt-line">Order #{orderNumber}</div>
      <div className="receipt-divider" />
      <div className="receipt-line">Size: {size ?? 'medium'}</div>
      <div className="receipt-line">Crust: {crust ?? 'regular'}</div>
      <div className="receipt-line">
        Toppings: {toppings.length ? toppings.join(', ') : 'cheese, obviously'}
      </div>
      {fulfillment && <div className="receipt-line">Fulfillment: {fulfillment}</div>}
      {pricing && (
        <>
          <div className="receipt-divider" />
          <div className="receipt-line">Subtotal: {money(pricing.subtotal)}</div>
          {pricing.deliveryFee > 0 && (
            <div className="receipt-line">Delivery: {money(pricing.deliveryFee)}</div>
          )}
          <div className="receipt-line">Tax: {money(pricing.tax)}</div>
          <div className="receipt-line">Tip: {money(pricing.tip)}</div>
          <div className="receipt-line receipt-eta">Total: {money(pricing.total)}</div>
        </>
      )}
      <div className="receipt-divider" />
      <div className="receipt-line receipt-eta">Ready in ~{etaMinutes} min 🔥</div>
      <div className="receipt-footer">thank you for tracing with us</div>
    </div>
  );
}

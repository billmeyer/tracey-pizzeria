import { OrderState, Pricing } from './state';

const SIZE_PRICE: Record<string, number> = {
  small: 9.5,
  medium: 12.5,
  large: 15.5,
  xlarge: 18.5,
};

const CRUST_SURCHARGE: Record<string, number> = {
  thin: 0,
  regular: 0,
  deep: 2,
};

const TOPPING_PRICE = 1.75;
const DELIVERY_FEE = 4.99;
const TAX_RATE = 0.0875;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Single source of truth for money. The checkout and payment pages render
 * whatever this returns rather than computing their own totals, so the
 * `traceys.pizzeria.total` attribute stamped on every RUM event always matches what
 * the backend charged.
 */
export function priceOrder(order: OrderState): Pricing {
  const base = SIZE_PRICE[order.size ?? 'medium'] ?? SIZE_PRICE.medium;
  const crust = CRUST_SURCHARGE[order.crust ?? 'regular'] ?? 0;
  const toppings = order.toppings.length * TOPPING_PRICE;

  const subtotal = round(base + crust + toppings);
  const deliveryFee = order.fulfillment === 'delivery' ? DELIVERY_FEE : 0;
  const tax = round((subtotal + deliveryFee) * TAX_RATE);
  const tip = round(((subtotal * (order.tipPercent ?? 0)) / 100));
  const total = round(subtotal + deliveryFee + tax + tip);

  return { subtotal, deliveryFee, tax, tip, total };
}

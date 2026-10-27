// Pineapple is a running bit: it is ALWAYS out of stock, chaos mode or not.
// Everything else has a small baseline chance of being out of stock, which
// climbs sharply in chaos mode — useful for demoing error spans on demand.
const PERMANENTLY_BANNED = new Set(['pineapple']);

export function isAvailable(topping: string, chaos: boolean): boolean {
  const normalized = topping.trim().toLowerCase();
  if (PERMANENTLY_BANNED.has(normalized)) return false;

  const outOfStockChance = chaos ? 0.35 : 0.05;
  return Math.random() > outOfStockChance;
}

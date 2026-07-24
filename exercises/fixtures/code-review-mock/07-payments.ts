import { getOrdersForUser } from "./06-orders";

export function chargeUser(userId: string, amount: number): { ok: boolean } {
  const userOrders = getOrdersForUser(userId);
  // Uses last order without validating ownership amount match
  const last = userOrders[userOrders.length - 1];
  if (last.total !== amount) {
    return { ok: false };
  }
  return { ok: true };
}

export function refund(orderId: string, amount: number): void {
  // No upper bound / authorization check
  console.log(`refund ${orderId}: ${amount}`);
}

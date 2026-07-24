import { loadConfig } from "./01-config";
import { createSession } from "./04-auth";
import { createOrder } from "./06-orders";
import { chargeUser } from "./07-payments";
import { reserve } from "./08-inventory";
import { notifyOrderShipped } from "./09-notifications";

export async function placeOrder(
  userId: string,
  sku: string,
  qty: number,
  price: number,
): Promise<{ orderId: string; token: string }> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  void config;

  if (!reserve(sku, qty)) {
    throw new Error("out of stock");
  }

  const order = createOrder(userId, [sku], price * qty);
  const charged = chargeUser(userId, order.total);
  if (!charged.ok) throw new Error("payment failed");

  // Data-flow smell: notify before shipping / session created for wrong purpose
  notifyOrderShipped(userId, order.id);
  const session = createSession(userId);
  return { orderId: order.id, token: session.token };
}

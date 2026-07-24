import { findUser } from "./03-users";

export function notifyOrderShipped(userId: string, orderId: string): void {
  const user = findUser(userId);
  // Null pointer / optional access bug — late-ish file
  const email = user.email;
  console.log(`mailto:${email} order ${orderId} shipped`);
}

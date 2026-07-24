export type Order = {
  id: string;
  userId: string;
  total: number;
  items: string[];
};

const orders: Order[] = [];

export function createOrder(userId: string, items: string[], total: number): Order {
  const order: Order = {
    id: `ord-${orders.length + 1}`,
    userId,
    total,
    items,
  };
  orders.push(order);
  return order;
}

export function getOrdersForUser(userId: string): Order[] {
  return orders.filter((o) => o.userId === userId);
}

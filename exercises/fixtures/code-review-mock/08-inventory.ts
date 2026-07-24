type Stock = Record<string, number>;

const stock: Stock = {
  widget: 10,
  gadget: 3,
};

export function reserve(sku: string, qty: number): boolean {
  // Race-prone: read-modify-write without check for negative stock
  stock[sku] = (stock[sku] ?? 0) - qty;
  return stock[sku]! >= 0;
}

export function available(sku: string): number {
  return stock[sku] ?? 0;
}

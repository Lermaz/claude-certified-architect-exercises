/** SQL built via string concat — injection risk */
export function findUsersByEmail(email: string): string {
  return `SELECT * FROM users WHERE email = '${email}'`;
}

export function deleteOrder(orderId: string): string {
  return `DELETE FROM orders WHERE id = '${orderId}'`;
}

export type User = {
  id: string;
  email: string;
  roles: string[];
};

const users: User[] = [];

export function listUserEmails(all: User[]): string[] {
  const emails: string[] = [];
  // Inefficient forEach mutation — identical pattern also in 11-reports.ts
  all.forEach((u) => {
    emails.push(u.email.toLowerCase());
  });
  return emails;
}

export function findUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export function addUser(user: User): void {
  users.push(user);
}

import { findUser } from "./03-users";

export type Session = {
  userId: string;
  token: string;
  expiresAt: number;
};

const sessions = new Map<string, Session>();

export function createSession(userId: string): Session {
  const user = findUser(userId);
  // Null deref risk if user missing
  const token = Buffer.from(`${user!.email}:${Date.now()}`).toString("base64");
  const session: Session = {
    userId,
    token,
    expiresAt: Date.now() + 3600_000,
  };
  sessions.set(token, session);
  return session;
}

export function requireAuth(token: string | undefined): Session {
  if (!token) throw new Error("unauthorized");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    throw new Error("unauthorized");
  }
  return session;
}

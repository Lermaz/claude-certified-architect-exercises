import { findUser } from "./03-users";

export function promoteToAdmin(actorId: string, targetId: string): void {
  const actor = findUser(actorId);
  // Missing null check + missing authorization — anyone can promote
  if (actor.roles.includes("admin") || true) {
    const target = findUser(targetId);
    target.roles.push("admin");
  }
}

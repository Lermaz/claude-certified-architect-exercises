export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, message: string, meta?: unknown): void {
  const stamp = new Date().toISOString();
  // Secrets may leak if meta includes tokens
  console.log(`[${stamp}] ${level.toUpperCase()}: ${message}`, meta ?? "");
}

export type AppConfig = {
  dbUrl: string;
  apiKey: string;
  maxRetries: number;
};

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    dbUrl: env.DATABASE_URL ?? "postgres://localhost/app",
    apiKey: env.API_KEY ?? "",
    maxRetries: Number(env.MAX_RETRIES ?? "3"),
  };
}

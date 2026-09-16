// Monitoring (Supabase) configuration. Mirrors lib/langfuse.ts: missing
// credentials ⇒ every monitoring surface is a silent no-op.
import { execSync } from "node:child_process";

export function monitoringSupabase(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | undefined {
  const url = env.MONITORING_SUPABASE_URL?.trim();
  const key = env.MONITORING_SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

export function isMonitoringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return monitoringSupabase(env) !== undefined;
}

export function monitoringEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MONITORING_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development").trim() || "development";
}

let cachedGitSha: string | undefined;
/** Widget build identity: Vercel's sha, else the local checkout's, else "dev". */
export function agentVersion(env: NodeJS.ProcessEnv = process.env): string {
  const vercel = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercel) return vercel.slice(0, 12);
  if (env.MONITORING_NO_GIT) return "dev";
  if (cachedGitSha === undefined) {
    try {
      cachedGitSha =
        execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
    } catch {
      cachedGitSha = "dev";
    }
  }
  return cachedGitSha;
}

export function dashboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MONITORING_PASSWORD?.trim()) && Boolean(env.MONITORING_COOKIE_SECRET?.trim());
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side only. The `partners` table has Row Level Security enabled with
 * NO policies defined, so anonymous (anon-key) access returns zero rows —
 * this client MUST be constructed with the service-role key or every query
 * silently comes back empty (edge case E23). Never import this module from
 * client-side / browser code.
 */

let cachedClient: SupabaseClient | undefined;

/**
 * Lazily constructs (and caches) the singleton Supabase client from
 * `MEMORY_SUPABASE_URL` / `MEMORY_SUPABASE_SERVICE_ROLE_KEY`.
 *
 * Throws a clear error naming the missing env var(s) if either is unset —
 * never logs the values themselves.
 */
export function getSupabase(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.MEMORY_SUPABASE_URL;
  const serviceRoleKey = process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("MEMORY_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("MEMORY_SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0 || !url || !serviceRoleKey) {
    throw new Error(
      `getSupabase: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return cachedClient;
}

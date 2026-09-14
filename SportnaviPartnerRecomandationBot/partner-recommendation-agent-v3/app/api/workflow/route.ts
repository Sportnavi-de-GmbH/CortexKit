import { z } from "zod";
import { loadConfigFromEnv } from "../../../config/workflow.config";
import { checkAuth, checkBodySize, RateLimiter } from "../../../lib/request-gate";
import { runWorkflow } from "../../../workflow/run-workflow";

export const runtime = "nodejs";
// A run is 10–45 s (decompose + up to 3 parallel searches); `runTimeoutMs`
// (45 s default) must stay below this so a slow run ends as a failed trace,
// not a platform timeout.
export const maxDuration = 60;

/** One message + at most 20 carried tasks is a few KB; anything bigger is not the widget. */
const MAX_BODY_BYTES = 32_768;
/** Per caller (the widget's server IPs) per minute; env-tunable. Soft brake — see request-gate. */
const limiter = new RateLimiter({ limit: Number(process.env.V3_RATE_LIMIT_PER_MIN ?? 60) || 60, windowMs: 60_000 });

const taskSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().max(60),
  query: z.string().trim().min(1).max(2000),
  cityMention: z.string().trim().max(100).nullable(),
  priority: z.number(),
});
const bodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  homeCity: z.string().trim().max(100).optional(),
  sessionCities: z.array(z.string().trim().max(100)).max(20).optional(),
  resume: z.object({ pending: z.array(taskSchema).max(10), deferred: z.array(taskSchema).max(10) }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** auth → size → rate; `null` to continue. Shared by GET and POST. */
function gate(req: Request): Response | null {
  return (
    checkAuth(req) ??
    checkBodySize(req, MAX_BODY_BYTES) ??
    (limiter.take(RateLimiter.clientKey(req)) ? null : Response.json({ error: "Too many requests." }, { status: 429 }))
  );
}

export async function POST(req: Request): Promise<Response> {
  const rejected = gate(req);
  if (rejected) return rejected;
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  const { query, homeCity, sessionCities, resume, config } = parsed.data;
  // Per-request config overrides are a dev-UI feature: in production the dials
  // come from env only, so a caller cannot widen the search or the timeouts.
  const overrides = process.env.VERCEL_ENV === "production" ? {} : ((config ?? {}) as Parameters<typeof runWorkflow>[1]);
  const trace = await runWorkflow({ query, homeCity: homeCity || undefined, sessionCities, resume }, overrides);
  return Response.json(trace);
}

export async function GET(req: Request): Promise<Response> {
  const rejected = gate(req);
  if (rejected) return rejected;
  const { config, envSet } = loadConfigFromEnv();
  return Response.json({ defaults: config, envSet });
}

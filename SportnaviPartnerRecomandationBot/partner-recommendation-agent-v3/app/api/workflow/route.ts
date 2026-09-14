import { z } from "zod";
import { loadConfigFromEnv } from "../../../config/workflow.config";
import { runWorkflow } from "../../../workflow/run-workflow";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  homeCity: z.string().trim().max(100).optional(),
  sessionCities: z.array(z.string().trim().max(100)).max(20).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  const { query, homeCity, sessionCities, config } = parsed.data;
  const trace = await runWorkflow({ query, homeCity: homeCity || undefined, sessionCities }, (config ?? {}) as Parameters<typeof runWorkflow>[1]);
  return Response.json(trace);
}

export async function GET(): Promise<Response> {
  const { config, envSet } = loadConfigFromEnv();
  return Response.json({ defaults: config, envSet });
}

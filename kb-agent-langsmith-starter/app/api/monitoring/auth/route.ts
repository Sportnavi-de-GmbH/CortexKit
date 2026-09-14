// POST /api/monitoring/auth — dashboard login (shared password → signed cookie).
// DELETE — logout. 404 when the dashboard is not configured.
import { dashboardEnabled } from "@/lib/monitoring/env";
import {
  COOKIE_MAX_AGE_SEC,
  COOKIE_NAME,
  cookieHeader,
  createLoginThrottle,
  passwordMatches,
  signSession,
} from "@/lib/monitoring/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const throttle = createLoginThrottle();
const ipOf = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

export async function POST(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const ip = ipOf(req);
  if (!throttle.check(ip)) return Response.json({ detail: "Too many attempts. Try again later." }, { status: 429 });
  let password = "";
  try {
    password = String(((await req.json()) as { password?: unknown }).password ?? "");
  } catch {
    /* empty body ⇒ empty password */
  }
  if (!(await passwordMatches(process.env.MONITORING_PASSWORD!.trim(), password))) {
    throttle.fail(ip);
    return Response.json({ detail: "Wrong password." }, { status: 401 });
  }
  const token = await signSession(
    process.env.MONITORING_COOKIE_SECRET!.trim(),
    Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SEC,
  );
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookieHeader(token, process.env.NODE_ENV === "production"),
    },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}

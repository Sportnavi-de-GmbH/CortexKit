// Guards the monitoring dashboard + its data API. Password unset ⇒ 404 (never
// an accidentally open dashboard). Everything else in the app is untouched —
// the matcher below is the whole scope of this file.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, isProtectedPath, verifySession } from "./lib/monitoring/auth";

export const config = {
  matcher: [
    "/monitoring/:path*",
    "/api/monitoring/traces",
    "/api/monitoring/traces/:path*",
    "/api/monitoring/stats",
    "/api/monitoring/sessions/:path*",
  ],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const password = process.env.MONITORING_PASSWORD?.trim();
  const secret = process.env.MONITORING_COOKIE_SECRET?.trim();
  if (!password || !secret) return new NextResponse(null, { status: 404 });
  if (!isProtectedPath(pathname)) return NextResponse.next();
  if (await verifySession(secret, req.cookies.get(COOKIE_NAME)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/monitoring/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

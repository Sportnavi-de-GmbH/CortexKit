// Same-origin proxy: /api/partner/eve/v1/* → ${PARTNER_AGENT_HOST}/eve/v1/*
// Thin wrapper over lib/partner-proxy. force-dynamic + nodejs runtime so eve's
// text/event-stream responses stream through unbuffered.
//
// This route is OUTSIDE eve's channel auth, so it applies the same origin + size
// gate as the FAQ channel (checkPartnerRequest) before forwarding. The forwarded
// request is then authenticated to the partner service by a shared secret the
// proxy injects (see lib/partner-proxy.ts).

import { checkPartnerRequest, proxyToPartner } from "@/lib/partner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const rejected = checkPartnerRequest(req);
  if (rejected) return rejected;
  return proxyToPartner(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const rejected = checkPartnerRequest(req);
  if (rejected) return rejected;
  return proxyToPartner(req, (await ctx.params).path);
}

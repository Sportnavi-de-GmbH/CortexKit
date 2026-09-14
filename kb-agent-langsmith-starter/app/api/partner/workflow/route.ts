// Same-origin adapter for the V3 partner workflow:
//   POST /api/partner/workflow  →  ${PARTNER_AGENT_HOST}/api/workflow
//
// A static route wins over the sibling catch-all `[...path]` (which forwards only
// eve/* paths for the eve-based partner agents). Same front-door gate as the
// proxy (origin + size + message length), then lib/partner-workflow forwards.

import { checkPartnerMessageLength, checkPartnerRequest } from "@/lib/partner-proxy";
import { forwardToWorkflow } from "@/lib/partner-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A V3 run is 10–45 s (decompose + up to 3 parallel searches); the proxy path
// streams and has no such cap, this one waits for a single JSON response.
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const rejected = checkPartnerRequest(req);
  if (rejected) return rejected;
  const tooLong = await checkPartnerMessageLength(req);
  if (tooLong) return tooLong;
  return forwardToWorkflow(req);
}

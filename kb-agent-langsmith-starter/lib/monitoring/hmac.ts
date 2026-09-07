// Verifies Langfuse's webhook signature (Monitors → Automations → Webhook).
//
// Scheme (identical to Langfuse's prompt webhooks — langfuse.com/docs/prompt-management/
// features/webhooks-slack-integrations): header `x-langfuse-signature: t=<unix>,v1=<hex>`.
// The signed message is `${t}.${rawBody}` — the RAW, unparsed request body. Verifying
// against a JSON.parse()'d-then-re-stringified body breaks on any whitespace/key-order
// difference, so callers must pass the exact bytes received.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Default replay-protection window. Not documented explicitly for Monitors webhooks,
 *  but standard practice for this exact timestamp+HMAC scheme. */
const DEFAULT_TOLERANCE_SEC = 300;

export function verifyLangfuseSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): VerifyResult {
  if (!secret) return { ok: false, reason: "no secret configured" };
  if (!header) return { ok: false, reason: "missing signature header" };

  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf("=");
        return i === -1 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
      }),
  ) as Record<string, string>;

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return { ok: false, reason: "malformed signature header" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "stale timestamp" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== receivedBuf.length) {
    return { ok: false, reason: "signature mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyLangfuseSignature } from "../lib/monitoring/hmac";

function sign(secret: string, timestamp: number, rawBody: string): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("verifyLangfuseSignature", () => {
  const secret = "s3cret";
  const body = '{"id":"evt_1","payload":{"severity":"ALERT"}}';
  const now = 1_700_000_000;

  it("accepts a correctly signed, fresh request", () => {
    const header = sign(secret, now, body);
    expect(verifyLangfuseSignature(body, header, secret, { now })).toEqual({ ok: true });
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = sign("wrong-secret", now, body);
    const result = verifyLangfuseSignature(body, header, secret, { now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects when the body has been tampered with after signing", () => {
    const header = sign(secret, now, body);
    const tampered = body.replace("ALERT", "OK");
    const result = verifyLangfuseSignature(tampered, header, secret, { now });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyLangfuseSignature(body, null, secret, { now }).ok).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyLangfuseSignature(body, "not-a-valid-header", secret, { now }).ok).toBe(false);
    expect(verifyLangfuseSignature(body, "t=123", secret, { now }).ok).toBe(false);
  });

  it("rejects a stale timestamp beyond the tolerance window", () => {
    const header = sign(secret, now - 10_000, body);
    const result = verifyLangfuseSignature(body, header, secret, { now, toleranceSec: 300 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale timestamp");
  });

  it("does not throw on a signature of a different length than expected", () => {
    const header = `t=${now},v1=deadbeef`; // short, invalid hex-length signature
    expect(() => verifyLangfuseSignature(body, header, secret, { now })).not.toThrow();
    expect(verifyLangfuseSignature(body, header, secret, { now }).ok).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    const header = sign("", now, body);
    expect(verifyLangfuseSignature(body, header, "", { now }).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { checkAuth, checkBodySize, RateLimiter } from "../lib/request-gate";

const basic = (secret: string, user = "navio-proxy") => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
const req = (headers: Record<string, string> = {}, url = "https://v3.example.com/api/workflow") => new Request(url, { method: "POST", headers });

describe("checkAuth — shared secret, server-to-server only", () => {
  const env = { PARTNER_PROXY_SECRET: "s3cret-value", VERCEL_ENV: "production" };

  it("accepts the Navio proxy's Basic credential", () => {
    expect(checkAuth(req({ authorization: basic("s3cret-value") }), env)).toBeNull();
  });

  it("401 without a credential, with the wrong secret, with the wrong user, or with a non-Basic scheme", async () => {
    for (const h of [{} as Record<string, string>, { authorization: basic("nope") }, { authorization: basic("s3cret-value", "someone") }, { authorization: "Bearer s3cret-value" }, { authorization: "Basic not-base64!!" }]) {
      const res = checkAuth(req(h), env)!;
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized." });
    }
  });

  it("fails CLOSED in production when no secret is configured (503, never open)", async () => {
    const res = checkAuth(req({ authorization: basic("anything") }), { VERCEL_ENV: "production" })!;
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/);
  });

  it("without a secret, only loopback callers are allowed outside production (local dev UI)", () => {
    expect(checkAuth(req({ host: "127.0.0.1:3008" }, "http://127.0.0.1:3008/api/workflow"), {})).toBeNull();
    expect(checkAuth(req({ host: "localhost:3008" }, "http://localhost:3008/api/workflow"), {})).toBeNull();
    expect(checkAuth(req({ host: "v3.example.com" }, "https://v3.example.com/api/workflow"), {})!.status).toBe(401);
    // a preview deployment on Vercel is not loopback either
    expect(checkAuth(req({ host: "v3-git-x.vercel.app" }, "https://v3-git-x.vercel.app/api/workflow"), { VERCEL_ENV: "preview" })!.status).toBe(401);
  });

  it("with a secret set, loopback is NOT a bypass", () => {
    expect(checkAuth(req({ host: "127.0.0.1:3008" }, "http://127.0.0.1:3008/api/workflow"), env)!.status).toBe(401);
  });
});

describe("checkBodySize", () => {
  it("413 above the cap, null otherwise or when unknown", () => {
    expect(checkBodySize(req({ "content-length": "40000" }), 32_768)!.status).toBe(413);
    expect(checkBodySize(req({ "content-length": "1000" }), 32_768)).toBeNull();
    expect(checkBodySize(req({}), 32_768)).toBeNull();
  });
});

describe("RateLimiter — per caller, per minute", () => {
  it("allows `limit` requests in a window, then 429s, then recovers", () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true]);
    expect(rl.take("a")).toBe(false);
    expect(rl.take("b")).toBe(true); // other caller unaffected
    now = 60_001;
    expect(rl.take("a")).toBe(true);
  });

  it("clientKey prefers the first x-forwarded-for hop and falls back to a fixed key", () => {
    expect(RateLimiter.clientKey(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(RateLimiter.clientKey(req({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(RateLimiter.clientKey(req({}))).toBe("unknown");
  });
});

import { describe, it, expect } from "vitest";
import {
  signSession,
  verifySession,
  passwordMatches,
  createLoginThrottle,
  cookieHeader,
  isProtectedPath,
} from "../lib/monitoring/auth";

describe("monitoring auth", () => {
  const secret = "s".repeat(32);
  it("signs and verifies a session; tampering or expiry fails", async () => {
    const exp = 2_000_000_000;
    const t = await signSession(secret, exp);
    expect(t.startsWith(`${exp}.`)).toBe(true);
    expect(await verifySession(secret, t, exp - 10)).toBe(true);
    expect(await verifySession(secret, t, exp + 1)).toBe(false);
    expect(await verifySession(secret, `${exp}.` + "0".repeat(64), exp - 10)).toBe(false);
    expect(await verifySession(secret, `${exp + 1000}.${t.split(".")[1]}`, exp - 10)).toBe(false); // extended expiry
    expect(await verifySession("other", t, exp - 10)).toBe(false);
    expect(await verifySession(secret, undefined)).toBe(false);
    expect(await verifySession(secret, "garbage")).toBe(false);
  });
  it("password compare", async () => {
    expect(await passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(await passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(await passwordMatches("hunter2", "")).toBe(false);
    expect(await passwordMatches("", "")).toBe(false);
  });
  it("throttle: 5 failures per 15 minutes per ip", () => {
    let now = 0;
    const th = createLoginThrottle({ now: () => now });
    for (let i = 0; i < 5; i++) {
      expect(th.check("1.1.1.1")).toBe(true);
      th.fail("1.1.1.1");
    }
    expect(th.check("1.1.1.1")).toBe(false);
    expect(th.check("2.2.2.2")).toBe(true);
    now = 15 * 60_000 + 1;
    expect(th.check("1.1.1.1")).toBe(true);
  });
  it("cookie header and protected paths", () => {
    expect(cookieHeader("abc", true)).toBe("navio_monitoring=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure");
    expect(cookieHeader("abc", false)).not.toContain("Secure");
    expect(isProtectedPath("/monitoring")).toBe(true);
    expect(isProtectedPath("/monitoring/traces/x")).toBe(true);
    expect(isProtectedPath("/monitoring/login")).toBe(false);
    expect(isProtectedPath("/api/monitoring/traces")).toBe(true);
    expect(isProtectedPath("/api/monitoring/stats")).toBe(true);
    expect(isProtectedPath("/api/monitoring/sessions/s1")).toBe(true);
    expect(isProtectedPath("/api/monitoring/alerts/faq")).toBe(false);
    expect(isProtectedPath("/api/monitoring/auth")).toBe(false);
  });
});

// Security verification — ZERO AI COST.
// Every request here is designed to be REJECTED before the model runs, so it
// exercises the security layers without spending Azure tokens.
//
// Layers under test:
//   1. Partner agent shared-secret lock (direct access must 401)
//   2. Partner agent console lockdown in production
//   3. Foreign-origin rejection on /api/partner/* (app-level origin gate)
//   4. SSRF / path-traversal guard on the proxy
//   5. Oversized-body rejection (size cap)
//   6. frame-ancestors CSP (the "only on sportnavi.de" embedding lock)
import http from "k6/http";
import { check, group } from "k6";
import { Counter } from "k6/metrics";

const WIDGET = __ENV.WIDGET_URL || "https://navio-widget.vercel.app";
const PARTNER = __ENV.PARTNER_URL || "https://navio-partner.vercel.app";

const secPass = new Counter("security_checks_passed");
const secFail = new Counter("security_checks_failed");

export const options = {
  scenarios: {
    security: { executor: "shared-iterations", vus: 3, iterations: 15, maxDuration: "2m" },
  },
  thresholds: { security_checks_failed: ["count==0"] },
};

function record(name, ok) {
  if (ok) secPass.add(1, { check: name });
  else secFail.add(1, { check: name });
}

export default function () {
  group("1. partner agent requires the shared secret", () => {
    const r = http.post(`${PARTNER}/eve/v1/session`, JSON.stringify({ message: "hi" }), {
      headers: { "content-type": "application/json" },
      tags: { sec: "partner_direct_401" },
    });
    // 401 = the eve channel refused an unauthenticated caller. This is the lock
    // that keeps service 2 private. Anything 2xx here is a critical failure.
    const ok = check(r, { "direct partner access is refused (401/403)": (x) => x.status === 401 || x.status === 403 });
    record("partner_direct_denied", ok);
  });

  group("2. partner agent console is not public in production", () => {
    const r = http.get(`${PARTNER}/`, { redirects: 0, tags: { sec: "partner_console" } });
    // Production redirects / -> /eve/v1/health so the dev console isn't browsable.
    const ok = check(r, { "console redirected or blocked": (x) => x.status === 307 || x.status === 308 || x.status === 302 || x.status === 401 });
    record("partner_console_locked", ok);
  });

  group("3. foreign origin is rejected on the partner proxy", () => {
    const r = http.post(`${WIDGET}/api/partner/eve/v1/session`, JSON.stringify({ message: "x" }), {
      headers: { "content-type": "application/json", Origin: "https://evil-copy.example.com" },
      tags: { sec: "foreign_origin_proxy" },
    });
    const ok = check(r, { "foreign origin blocked (403)": (x) => x.status === 403 });
    record("foreign_origin_blocked", ok);
  });

  group("4. SSRF / traversal guard on the proxy", () => {
    const paths = ["/api/partner/admin", "/api/partner/eve/../admin", "/api/partner/../../etc/passwd"];
    paths.forEach((p, i) => {
      const r = http.get(`${WIDGET}${p}`, { tags: { sec: "traversal" } });
      const ok = check(r, { [`traversal ${i} not forwarded (404/403/400)`]: (x) => x.status === 404 || x.status === 403 || x.status === 400 });
      record(`traversal_${i}`, ok);
    });
  });

  group("5. oversized body is rejected before the model", () => {
    const huge = JSON.stringify({ message: "A".repeat(200000) }); // ~200 KB, cap is 16 KB
    const r = http.post(`${WIDGET}/eve/v1/session`, huge, {
      headers: { "content-type": "application/json" },
      tags: { sec: "oversize" },
    });
    const ok = check(r, { "oversized body rejected (403/413)": (x) => x.status === 403 || x.status === 413 });
    record("oversize_rejected", ok);
  });

  group("6. embedding lock (frame-ancestors)", () => {
    const r = http.get(`${WIDGET}/widget`, { tags: { sec: "csp" } });
    const csp = r.headers["Content-Security-Policy"] || "";
    const ok = check(r, {
      "CSP present": () => csp.includes("frame-ancestors"),
      "sportnavi.de allowed": () => csp.includes("sportnavi.de"),
      "not open to all": () => !csp.includes("frame-ancestors *"),
    });
    record("csp_embedding_lock", ok);
  });
}

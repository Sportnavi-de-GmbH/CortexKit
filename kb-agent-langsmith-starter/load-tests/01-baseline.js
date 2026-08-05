// Baseline performance — ZERO AI COST.
// Hits only static/health routes, so nothing here reaches the model.
// Measures latency + throughput of the edge and the Next.js runtime.
import http from "k6/http";
import { check, group } from "k6";
import { Trend } from "k6/metrics";

const WIDGET = __ENV.WIDGET_URL || "https://navio-widget.vercel.app";
const PARTNER = __ENV.PARTNER_URL || "https://navio-partner.vercel.app";

const healthTrend = new Trend("navio_health_ms");
const widgetTrend = new Trend("navio_widget_page_ms");
const launcherTrend = new Trend("navio_launcher_ms");

export const options = {
  scenarios: {
    baseline: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "20s", target: 10 },
        { duration: "40s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "navio_health_ms": ["p(95)<1500"],
    "navio_widget_page_ms": ["p(95)<3000"],
  },
};

export default function () {
  group("widget health", () => {
    const r = http.get(`${WIDGET}/eve/v1/health`, { tags: { route: "widget_health" } });
    healthTrend.add(r.timings.duration);
    check(r, { "health 200": (x) => x.status === 200 });
  });

  group("widget page (CSP check)", () => {
    const r = http.get(`${WIDGET}/widget`, { tags: { route: "widget_page" } });
    widgetTrend.add(r.timings.duration);
    check(r, {
      "widget 200": (x) => x.status === 200,
      "has frame-ancestors CSP": (x) =>
        (x.headers["Content-Security-Policy"] || "").includes("frame-ancestors"),
      "has nosniff": (x) => (x.headers["X-Content-Type-Options"] || "") === "nosniff",
    });
  });

  group("launcher script", () => {
    const r = http.get(`${WIDGET}/launcher.js`, { tags: { route: "launcher" } });
    launcherTrend.add(r.timings.duration);
    check(r, {
      "launcher 200": (x) => x.status === 200,
      "launcher cached": (x) => (x.headers["Cache-Control"] || "").includes("max-age"),
    });
  });

  group("partner health (internal service)", () => {
    const r = http.get(`${PARTNER}/eve/v1/health`, { tags: { route: "partner_health" } });
    check(r, { "partner health 200": (x) => x.status === 200 });
  });
}

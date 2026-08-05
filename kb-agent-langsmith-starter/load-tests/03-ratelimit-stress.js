// Firewall rate-limit + stress verification — ZERO AI COST.
//
// COST SAFETY (important): every request sends `{}` as the body. The eve channel
// validates the payload and returns 400 "Missing or empty 'message' field"
// BEFORE the model is ever called. The Vercel Firewall counts the request either
// way, so the rate-limit rules are exercised at full volume for free.
//
// Rules under test (navio-widget):
//   Rule B — POST /eve/v1/session          20 / 60s (ip + ja4)
//   Rule C — POST /eve/v1/session/*        60 / 60s
//   Rule D — GET  /eve/v1/session/*       120 / 60s
//   Rule E — /api/partner/*, /api/contact  15 / 60s
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

const WIDGET = __ENV.WIDGET_URL || "https://navio-widget.vercel.app";
const TARGET = __ENV.TARGET || "session"; // session | contact

const status429 = new Counter("rl_429_count");
const status400 = new Counter("rl_400_count");
const statusOther = new Counter("rl_other_count");
const limited = new Rate("rl_limited_rate");

export const options = {
  scenarios: {
    // Deliberately exceed the 20/60s limit on session-create: ~60 requests
    // in ~60s from one IP should push us past the threshold.
    burst: {
      executor: "constant-arrival-rate",
      rate: 60,
      timeUnit: "1m",
      duration: "90s",
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  // No hard threshold: whether 429s appear tells us if the rule ENFORCES or
  // only LOGS. Both are valid states; the report interprets it.
  thresholds: { http_req_duration: ["p(99)<10000"] },
};

export default function () {
  let url, body;
  if (TARGET === "contact") {
    url = `${WIDGET}/api/contact`;
    body = JSON.stringify({}); // invalid on purpose -> 422/400, no Salesforce call
  } else {
    url = `${WIDGET}/eve/v1/session`;
    body = JSON.stringify({}); // invalid on purpose -> 400, NO MODEL CALL
  }

  const r = http.post(url, body, {
    headers: { "content-type": "application/json" },
    tags: { target: TARGET },
  });

  if (r.status === 429) {
    status429.add(1);
    limited.add(true);
  } else if (r.status === 400 || r.status === 422) {
    status400.add(1);
    limited.add(false);
  } else {
    statusOther.add(1);
    limited.add(false);
  }

  check(r, {
    "no 5xx (service stayed healthy under load)": (x) => x.status < 500,
    "rejected before the model (400/422) or rate-limited (429)": (x) =>
      x.status === 400 || x.status === 422 || x.status === 429 || x.status === 403,
  });
}

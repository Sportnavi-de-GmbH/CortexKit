"use client";

// Embeddable Navio chat, served at /widget and loaded inside the iframe that
// `public/launcher.js` mounts on sportnavi.de. This page and the eve API
// (/eve/v1/*) are the SAME origin, so useEveAgent() talks to the agent with no
// CORS and the invisible BotID check runs within our own deployment.
//
// ONE AGENT. Service 1 mounted two clients here (faqAgent + partnerAgent via the
// /api/partner proxy) and let the screen decide which one was active. In the
// multi-agent design the MASTER decides, so there is exactly one session, one
// conversation history, and one place for context to live.
//
// The partner agent is still a separate deployment — it is just reached
// server-side now, from agent/tools/find_partners.ts, instead of from the
// browser. That is why there is no /api/partner route in this project.

import { useEffect } from "react";
import { useEveAgent } from "eve/react";
import { NavioWidget } from "@/components/navio/NavioWidget";

/** Ensure a stable first-party visitor id cookie (analytics + soft rate-shaping). */
function ensureVisitorId(): void {
  if (typeof document === "undefined") return;
  const has = document.cookie.split(";").some((c) => c.trim().startsWith("snv_vid="));
  if (has) return;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // SameSite=None; Secure so the cookie survives the third-party iframe context.
  document.cookie = `snv_vid=${id}; Path=/; Max-Age=31536000; SameSite=None; Secure`;
}

/**
 * Activate Vercel BotID's invisible challenge on the session-create route.
 * Off unless NEXT_PUBLIC_BOTID_ENABLED=true, and imported via a non-literal
 * specifier so the page builds without the optional `botid` package.
 */
function useBotId(): void {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_BOTID_ENABLED !== "true") return;
    let cancelled = false;
    void (async () => {
      try {
        const specifier = "botid/client/core";
        const mod = (await import(specifier)) as {
          initBotId: (opts: { protect: { path: string; method: string }[] }) => void;
        };
        if (cancelled) return;
        mod.initBotId({ protect: [{ path: "/eve/v1/session", method: "POST" }] });
      } catch {
        // botid not installed — fail open on the client; the server-side check
        // in agent/channels/eve.ts is the enforcing gate.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function WidgetPage() {
  // maxReconnectAttempts is raised from eve's default of 3 on purpose.
  // A partner search runs 15-60s with NO stream events; a browser drops the idle
  // connection and reports `network error` mid-turn (reproduced — the same class
  // as CortexKit CLAUDE.md §10.3, "long silent streams die in browsers, not in
  // curl"). eve's stream is durable and replayable by event index, so
  // reconnecting is the correct fix rather than injecting keep-alive traffic.
  const agent = useEveAgent({ maxReconnectAttempts: 12 });
  useBotId();
  useEffect(ensureVisitorId, []);

  return <NavioWidget agent={agent} />;
}

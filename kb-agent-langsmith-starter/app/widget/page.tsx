"use client";

// Embeddable Navio chat, served at /widget and loaded inside the iframe that
// `public/launcher.js` mounts on sportnavi.de. Because this page and the eve API
// (/eve/v1/*) are the SAME origin (this deployment), useEveAgent() talks to the
// agent same-origin with no CORS, and the invisible BotID check (below) runs
// entirely within our own deployment — see the MVP plan, §4 and Layer 3.
//
// The UI is the multi-screen Navio widget (greeting → consent → chat → info)
// defined in components/navio/NavioWidget.tsx, per docs/design/NAVIO_WIDGET_SPEC.md.

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
  // (On http://localhost the Secure flag no-ops, which is fine for dev.)
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
        // botid not installed or unavailable — fail open on the client; the
        // server-side check in agent/channels/eve.ts is the enforcing gate.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function WidgetPage() {
  const agent = useEveAgent();
  useBotId();
  useEffect(ensureVisitorId, []);

  return <NavioWidget agent={agent} />;
}

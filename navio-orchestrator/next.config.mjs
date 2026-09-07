import { withBotId } from "botid/next/config";
import { withEve } from "eve/next";

// Who may embed the Navio widget in an iframe. Locked to Sportnavi by default
// (`'self'` keeps the local dev console working). Override with WIDGET_FRAME_ANCESTORS
// (space-separated origins) without a code change. This is the control that stops
// other websites from embedding the widget — see the MVP plan §3.
const frameAncestors =
  process.env.WIDGET_FRAME_ANCESTORS ??
  "'self' https://www.sportnavi.de https://sportnavi.de";

// The Next app at `/` is the developer console (chat + tool dashboard against
// /eve/v1/*). It is handy locally but must NOT be a public page in production —
// the public surface is the embeddable `/widget`. In production only, redirect
// `/` to `/widget`; preview/development keep the console for debugging.
const isProduction = process.env.VERCEL_ENV === "production";

/** @type {import("next").NextConfig} */
const nextConfig = {
  async redirects() {
    if (!isProduction) return [];
    return [
      {
        source: "/",
        destination: "/widget",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        // The embeddable widget page: allow framing only by Sportnavi.
        source: "/widget",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors};` },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The launcher is meant to be loaded by any Sportnavi page; keep it
        // cacheable and non-sniffable. Access control happens on the API side.
        source: "/launcher.js",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
        ],
      },
    ];
  },
};

export default withBotId(withEve(nextConfig));

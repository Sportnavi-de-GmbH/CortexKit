import { withEve } from "eve/next";

// This service is internal (only Service 1's proxy should reach `/eve/v1/*`).
// The Next app at `/` is the developer console — useful locally, but it must NOT
// be a public page in production. In production only, redirect `/` to the public
// health endpoint so a stray visitor gets a harmless `{"ok":true}` instead of the
// console. Preview/development keep the console for debugging.
const isProduction = process.env.VERCEL_ENV === "production";

/** @type {import("next").NextConfig} */
const nextConfig = {
  async redirects() {
    if (!isProduction) return [];
    return [
      {
        source: "/",
        destination: "/eve/v1/health",
        permanent: false,
      },
    ];
  },
};

export default withEve(nextConfig);

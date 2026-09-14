// Server component: decides whether the workflow lab UI is served at all.
//
// In production the only client is the Navio widget's server-side forwarder
// (authenticated with PARTNER_PROXY_SECRET); the browser UI has no credential
// and would just render 401s. So production serves a short notice instead of
// the lab, unless V3_DEV_UI=true is set deliberately on the deployment.
import { DevUi } from "../components/DevUi";

export const dynamic = "force-dynamic";

export default function Page() {
  const production = process.env.VERCEL_ENV === "production" || (process.env.VERCEL_ENV === undefined && process.env.NODE_ENV === "production");
  if (production && process.env.V3_DEV_UI !== "true") {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-sm text-zinc-600 dark:text-zinc-300">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Partner Recommendation Agent V3</h1>
        <p className="mt-2">This service has no public interface. It is consumed server-to-server by the Navio widget.</p>
      </main>
    );
  }
  return <DevUi />;
}

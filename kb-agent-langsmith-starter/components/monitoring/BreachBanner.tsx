// Overview banner: one line when any alert rule is currently breached, nothing
// otherwise. Server component — reads alert_state directly, like the rest of
// the dashboard pages do.
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { breachedStates } from "@/lib/monitoring/alerts/query";
import { ruleLabel } from "./alerts-format";

export async function BreachBanner() {
  const breached = await breachedStates();
  if (breached.length === 0) return null;
  return (
    <Link
      href="/monitoring/alerts"
      className="flex items-start gap-3 rounded-2xl border border-(--red)/40 bg-(--red)/8 px-4 py-3 text-sm text-(--fg) transition-colors hover:bg-(--red)/12"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--red)" aria-hidden />
      <span>
        <span className="font-display font-semibold">
          {breached.length} Regel{breached.length === 1 ? "" : "n"} verletzt
        </span>
        <span className="text-(--fg-muted)">
          {" "}
          — {breached.slice(0, 3).map((b) => ruleLabel(b.rule_key, b.agent, b.subkey)).join(", ")}
          {breached.length > 3 ? " …" : ""}
        </span>
      </span>
    </Link>
  );
}

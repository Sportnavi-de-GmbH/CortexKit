"use client";

/**
 * Card 2 — Partner Resolution. Shows what resolve_partners / build_recommendations
 * actually produced for this session, derived client-side from the message
 * stream (see lib/dev-console/partner-activity.ts) — no backend route needed.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Building2, ChevronDown, CheckCircle2, MapPin, Users } from "lucide-react";
import type { EveMessageData, UseEveAgentHelpers } from "eve/react";
import { buildPartnerActivity, type AllFoundPartner, type PartnerResolutionEntry } from "@/lib/dev-console/partner-activity";
import { CardBadge } from "./CardBadge";

type Agent = UseEveAgentHelpers<EveMessageData>;

export function PartnerResolution({ agent, query }: { agent: Agent; query: string }) {
  const entries = useMemo(() => buildPartnerActivity(agent.data.messages), [agent.data.messages]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => (e.requestedCity ?? "").toLowerCase().includes(q));
  }, [entries, query]);

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-stone-200 bg-white shadow-sm">
      <header className="flex items-center gap-2 border-b border-stone-100 px-5 py-4">
        <CardBadge n={2} />
        <h2 className="font-headline text-sm font-semibold text-stone-900">Partner Resolution</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-stone-50 text-stone-300">
              <MapPin size={16} />
            </span>
            <p className="text-xs text-stone-400">No partner search yet — ask for partners in a city.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((entry) => (
              <ResolutionCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ResolutionCard({ entry }: { entry: PartnerResolutionEntry }) {
  const total = entry.homeCount + entry.filledCount;
  const [showAllFound, setShowAllFound] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2, boxShadow: "0 8px 20px -8px rgba(28, 25, 23, 0.12)" }}
      transition={{ duration: 0.15 }}
      className="rounded-xl border border-stone-200 bg-white p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
          <MapPin size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-stone-800">{entry.requestedCity ?? "Unknown city"}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-stone-400">
            <Users size={11} />
            {entry.homeCount} home
            {entry.filledCount > 0 && (
              <>
                <span>·</span>
                <Building2 size={11} />
                {entry.filledCount} nearby ({entry.citiesUsed.filter((c) => c !== entry.requestedCity).join(", ") || "n/a"})
              </>
            )}
            <span>·</span>
            {total} total
          </p>
        </div>
      </div>

      {(entry.warnings.length > 0 || entry.cappedAtMax || entry.citiesExhausted || entry.minMet === false) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-9">
          {entry.minMet === false && <Badge tone="amber" icon={AlertTriangle} label="Below minimum" />}
          {entry.cappedAtMax && <Badge tone="stone" icon={AlertTriangle} label="Capped at max" />}
          {entry.citiesExhausted && <Badge tone="amber" icon={AlertTriangle} label="Cities exhausted" />}
        </div>
      )}

      {entry.allFound && entry.allFound.length > 0 && (
        <div className="mt-2.5 pl-9">
          <button
            type="button"
            onClick={() => setShowAllFound((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 hover:text-stone-700"
          >
            <ChevronDown size={12} className={showAllFound ? "rotate-180 transition-transform" : "transition-transform"} />
            All {entry.allFound.length} found (before shortlisting)
          </button>
          {showAllFound && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {entry.allFound.map((p) => (
                <FoundPartnerCard key={p.partnerId} partner={p} />
              ))}
            </div>
          )}
        </div>
      )}

      {entry.recommendations && (
        <div className="mt-2.5 pl-9">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-600">
            <CheckCircle2 size={12} />
            {entry.recommendations.length} recommended
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-stone-600">
            {entry.recommendations.map((r) => (
              <li key={r.partnerId} className="truncate">
                {r.name}
                {r.source === "nearby" && <span className="ml-1.5 text-[10px] text-stone-400">(borrowed from {r.city})</span>}
              </li>
            ))}
          </ul>
          {entry.disclosure && <p className="mt-1.5 text-[11px] italic text-stone-400">{entry.disclosure}</p>}
        </div>
      )}

      {entry.buildError && (
        <p className="mt-2.5 pl-9 text-[11px] text-rose-600">{entry.buildError}</p>
      )}
    </motion.div>
  );
}

function FoundPartnerCard({ partner: p }: { partner: AllFoundPartner }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-stone-100 bg-stone-50/60 p-2.5">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-start gap-2 text-left">
        <ChevronDown
          size={11}
          className={`mt-0.5 shrink-0 text-stone-400 ${expanded ? "rotate-180 transition-transform" : "transition-transform"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-stone-700">{p.name}</p>
          <p className="text-[10px] text-stone-400">
            #{p.partnerId} · {p.source === "home" ? p.city ?? "n/a" : `borrowed from ${p.sourceCity}`}
          </p>
        </div>
      </button>
      {expanded && (
        <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md bg-white p-2 text-[11px] leading-relaxed text-stone-600">
          {p.llmProfile || "(no profile text)"}
        </pre>
      )}
    </div>
  );
}

function Badge({
  tone,
  icon: Icon,
  label,
}: {
  tone: "amber" | "stone";
  icon: React.ComponentType<{ size?: number }>;
  label: string;
}) {
  const toneClass = tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-stone-100 text-stone-500";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
      <Icon size={10} />
      {label}
    </span>
  );
}

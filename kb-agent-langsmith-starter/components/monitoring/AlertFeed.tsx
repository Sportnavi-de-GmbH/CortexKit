"use client";

// The alert feed: fired / recovered / digest / test events, newest first.
// Filters are a plain GET form (same pattern as TraceFilters); "Mehr laden"
// appends the next page client-side from the data API.
import Link from "next/link";
import { Fragment, useState } from "react";
import { Check, ChevronDown, Inbox } from "lucide-react";
import type { AlertEventRow } from "@/lib/monitoring/alerts/query";
import { fmtRuleValue, humanDelivery, humanRuleLabel, kindLabel, severityTone } from "./alerts-format";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, SELECT, Card, fmtTime } from "./ui";

const NAME_KEY = "navio_monitoring_name";

const BORDER: Record<string, string> = {
  red: "border-l-4 border-l-(--red)",
  warn: "border-l-4 border-l-(--warn-icon)",
  green: "border-l-4 border-l-(--brand-green)",
  muted: "border-l-4 border-l-(--border)",
};
const PILL: Record<string, string> = {
  red: "bg-(--red)/12 text-(--red)",
  warn: "bg-(--warn-surface) text-(--warn-fg)",
  green: "bg-(--accent-dim) text-(--fg)",
  muted: "bg-(--surface-muted) text-(--fg-muted)",
};

/** Name used for acknowledgements — asked once, then remembered per browser. */
function ackName(): string | null {
  let name = "";
  try {
    name = window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    /* storage blocked — fall through to the prompt */
  }
  if (!name) {
    name = (window.prompt("Dein Name") ?? "").trim();
    if (!name) return null;
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch {
      /* ignore */
    }
  }
  return name;
}

function DeliveryChips({ delivery }: { delivery: Record<string, string> }) {
  const entries = Object.entries(delivery ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entries.map(([ch, st]) => {
        const d = humanDelivery(st);
        const cls = d.tone === "good" ? "bg-(--accent-dim) text-(--fg)" : d.tone === "bad" ? "bg-(--red)/12 text-(--red)" : "bg-(--surface-muted) text-(--fg-muted)";
        return (
          <span key={ch} className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] break-words ${cls}`}>
            {ch === "teams" ? "Teams" : ch === "email" ? "E-Mail" : ch}: {d.text}
          </span>
        );
      })}
    </div>
  );
}

/** Everything an engineer needs and nobody else should have to read: hidden until asked for. */
function TechnicalDetails({ e }: { e: AlertEventRow }) {
  const [open, setOpen] = useState(false);
  const rows: [string, string][] = [];
  if (e.rule_key) rows.push(["Regel", `${e.rule_key}${e.agent ? `·${e.agent}` : ""}${e.subkey ? `·${e.subkey}` : ""}`]);
  if (e.agent) rows.push(["Agent", e.agent]);
  if (e.rule_key) {
    rows.push(["Wert", fmtRuleValue(e.rule_key, e.observed)]);
    rows.push(["Grenze", fmtRuleValue(e.rule_key, e.threshold)]);
    rows.push(["Fenster", `${e.window_hours ?? "—"} h`]);
    rows.push(["Turns", String(e.samples ?? 0)]);
  }
  rows.push(["Lauf", e.run_slot || "—"]);
  rows.push(["Text von", e.narrative_source === "llm" ? "llm" : "template"]);
  for (const [ch, st] of Object.entries(e.delivery ?? {})) rows.push([`Zustellung ${ch}`, st]);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium text-(--fg-muted) underline underline-offset-2 transition-colors hover:text-(--fg)"
      >
        Technische Details
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl bg-(--surface-muted) px-3 py-2 text-[11px]">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-(--fg-subtle)">{k}</dt>
              <dd className="tabular break-words text-(--fg)">{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function Narrative({ text, collapsible }: { text: string; collapsible: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="min-w-0">
      <p className={`whitespace-pre-line break-words text-[13px] leading-relaxed text-(--fg) ${collapsible && !open ? "line-clamp-3" : ""}`}>{text}</p>
      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 text-xs font-medium text-(--fg-muted) underline underline-offset-2 transition-colors hover:text-(--fg)"
        >
          {open ? "Weniger" : "Mehr"}
        </button>
      )}
    </div>
  );
}

function EventRow({ e }: { e: AlertEventRow }) {
  const [ackBy, setAckBy] = useState<string | null>(e.acknowledged_by);
  const [ackAt, setAckAt] = useState<string | null>(e.acknowledged_at);
  const [busy, setBusy] = useState(false);
  const [ackError, setAckError] = useState(false);
  const tone = severityTone(e.kind, e.severity);
  const isTransition = e.kind === "fired" || e.kind === "recovered";
  // Digest / test rows carry no rule, so the pill already says everything a
  // title would — don't repeat it.
  const title = isTransition && e.rule_key ? humanRuleLabel(e.rule_key, e.agent, e.subkey ?? "") : null;
  const tracesHref =
    (e.agent === "faq" || e.agent === "partner") && e.window_from
      ? `/monitoring?agent=${e.agent}&from=${encodeURIComponent(e.window_from)}${e.window_to ? `&to=${encodeURIComponent(e.window_to)}` : ""}`
      : null;

  async function acknowledge() {
    const by = ackName();
    if (!by) return;
    setBusy(true);
    setAckError(false);
    try {
      const r = await fetch("/api/monitoring/alerts/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: e.id, by }),
      });
      if (r.ok) {
        setAckBy(by);
        setAckAt(new Date().toISOString());
      } else {
        setAckError(true);
      }
    } catch {
      setAckError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4 ${BORDER[tone]}`}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex h-6 items-center rounded-full px-2 font-display text-[12px] font-medium ${PILL[tone]}`}>{kindLabel(e.kind)}</span>
          {title && <span className="min-w-0 break-words font-display text-sm font-semibold text-(--fg)">{title}</span>}
          <span className="tabular text-[11px] text-(--fg-subtle)">{fmtTime(e.created_at)}</span>
        </div>
        <Narrative text={e.narrative} collapsible={e.kind === "digest"} />
        <DeliveryChips delivery={e.delivery} />
        <TechnicalDetails e={e} />
        {tracesHref && (
          <Link
            href={tracesHref}
            className="inline-block text-xs font-medium text-(--fg) underline decoration-(--brand-green) decoration-2 underline-offset-[3px]"
          >
            Traces ansehen
          </Link>
        )}
      </div>
      <div className="shrink-0 sm:pt-1">
        {ackBy ? (
          <span className="inline-flex items-center gap-1 text-xs text-(--fg-muted)">
            <Check className="h-3.5 w-3.5 text-(--brand-green)" aria-hidden />
            {ackBy}
            {ackAt ? ` · ${fmtTime(ackAt)}` : ""}
          </span>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={acknowledge} disabled={busy} className={BTN_SECONDARY}>
              Bestätigen
            </button>
            {ackError && <span className="max-w-[12rem] text-right text-xs text-(--red)">Bestätigen fehlgeschlagen – bitte erneut versuchen.</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function FilterSelect({ name, label, value, children }: { name: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-medium text-(--fg-muted) sm:flex-none">
      {label}
      <span className="relative">
        <select name={name} defaultValue={value} className={SELECT}>
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-(--fg-subtle)" aria-hidden />
      </span>
    </label>
  );
}

// `params` is the raw query string, not a URLSearchParams: a server component
// cannot hand a class instance across the RSC boundary (it arrives as a plain
// object and every method is gone).
export function AlertFeed({ initial, params }: { initial: { items: AlertEventRow[]; nextCursor: string | null }; params: string }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const sp = new URLSearchParams(params);
  const kind = sp.get("kind") ?? "";
  const agent = sp.get("agent") ?? "";

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (kind) q.set("kind", kind);
      if (agent) q.set("agent", agent);
      q.set("cursor", cursor);
      q.set("limit", "50");
      const r = await fetch(`/api/monitoring/alerts/events?${q.toString()}`);
      if (r.ok) {
        const next = (await r.json()) as { items: AlertEventRow[]; nextCursor: string | null };
        setItems((prev) => [...prev, ...next.items]);
        setCursor(next.nextCursor);
      }
    } catch {
      /* keep what we already have */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <form method="get" action="/monitoring/alerts" className={`${CARD} flex flex-wrap items-end gap-3 p-4`} aria-label="Alarme filtern">
        <input type="hidden" name="tab" value="feed" />
        <FilterSelect name="kind" label="Art" value={kind}>
          <option value="">Alle</option>
          <option value="fired">Alarm</option>
          <option value="recovered">Entwarnung</option>
          <option value="digest">Statusbericht</option>
          <option value="test">Test</option>
        </FilterSelect>
        <FilterSelect name="agent" label="Agent" value={agent}>
          <option value="">Alle</option>
          <option value="faq">FAQ</option>
          <option value="partner">Partner</option>
          <option value="total">Gesamt</option>
        </FilterSelect>
        <button className={BTN_PRIMARY}>Filtern</button>
      </form>

      <Card title="Ereignisse" kicker="Neueste zuerst" actions={<span className="text-xs text-(--fg-muted)">{items.length} angezeigt</span>} bodyClassName="p-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Inbox className="h-6 w-6 text-(--fg-subtle)" aria-hidden />
            <p className="text-sm text-(--fg-muted)">Keine Ereignisse für diesen Filter.</p>
          </div>
        ) : (
          <ul className="divide-y divide-(--border)">
            {items.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </ul>
        )}
        {cursor && (
          <div className="border-t border-(--border) px-5 py-3 text-center">
            <button type="button" onClick={loadMore} disabled={loading} className={BTN_SECONDARY}>
              {loading ? "Lädt …" : "Mehr laden"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

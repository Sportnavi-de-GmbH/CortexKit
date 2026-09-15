"use client";

// Rules tab: manual evaluation actions, the recipient list, and the editable
// rule table. Every write goes through the cookie-gated /api/monitoring/alerts/*
// endpoints; nothing here talks to Supabase directly.
import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import type { AlertSettings } from "@/lib/monitoring/alerts/repo";
import type { AlertRule } from "@/lib/monitoring/alerts/types";
import { fmtRuleValue, humanDelivery, humanErroredLabel, humanRuleLabel, humanRuleNote, humanRuleThreshold, humanRuleValue, ruleScopeLabel } from "./alerts-format";
import { BTN_PRIMARY, BTN_SECONDARY, Card, INPUT, SELECT } from "./ui";

interface RunResult {
  ok?: boolean;
  slot?: string;
  dryRun?: boolean;
  transitions?: { kind: string; rule_key: string; agent: string; subkey: string; observed: number | null; threshold: number; narrative: string }[];
  digest?: { sent: boolean; narrative: string };
  observations?: { rule_key: string; agent: string; subkey: string; status: string; observed: number | null; threshold: number; samples: number; note?: string }[];
  errored?: string[];
  /** Human message shown when the run itself could not be started. */
  detail?: string;
  /** Raw cause of that failure — collapsed, for the technical reader only. */
  rawDetail?: string;
}

const RUN_FAILED = "Die Auswertung konnte nicht gestartet werden – bitte später erneut versuchen.";

/** A raw error string, hidden behind a toggle so the visible text stays actionable. */
function RawDetail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs font-medium text-(--fg-muted) underline underline-offset-2 hover:text-(--fg)">
        Technische Details
      </button>
      {open && <p className="mt-1 rounded-xl bg-(--surface-muted) px-3 py-2 text-[11px] break-words text-(--fg)">{detail}</p>}
    </div>
  );
}

/** Parses a draft numeric field; blank or non-finite ⇒ null so an emptied input is never saved as 0. */
function numOrNull(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Sensible input step per rule key — rates and dollars in cents, latency in 100 ms. */
function stepFor(key: string): number {
  if (key === "latency_p95") return 100;
  if (key === "cost_spike") return 0.1;
  if (key === "error_repeat" || key === "partner_upstream") return 1;
  return 0.01;
}

const STATUS_CLS: Record<string, string> = {
  breached: "bg-(--red)/12 text-(--red)",
  ok: "bg-(--accent-dim) text-(--fg)",
  skipped: "bg-(--surface-muted) text-(--fg-muted)",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 font-display text-[12px] font-medium ${STATUS_CLS[status] ?? STATUS_CLS.skipped}`}>
      {status === "breached" ? "Verletzt" : status === "ok" ? "OK" : "Übersprungen"}
    </span>
  );
}

type RunObservation = NonNullable<RunResult["observations"]>[number];

/**
 * Everything technical about one evaluated rule — the rule key, the agent id, the raw value
 * and limit, the engineer note — behind a toggle, the way the feed hides it. The visible row
 * stays a sentence a non-technical reader can act on.
 */
function RowTechnicalDetails({ o }: { o: RunObservation }) {
  const rows: [string, string][] = [
    ["Regel", `${o.rule_key}${o.agent ? `·${o.agent}` : ""}${o.subkey ? `·${o.subkey}` : ""}`],
    ["Agent", o.agent || "—"],
    ["Wert", fmtRuleValue(o.rule_key, o.observed)],
    ["Grenze", fmtRuleValue(o.rule_key, o.threshold)],
    ["Turns", String(o.samples ?? 0)],
  ];
  if (o.note) rows.push(["Hinweis", o.note]);
  return (
    <details className="mt-1 min-w-0">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-(--fg-muted) underline underline-offset-2 hover:text-(--fg)">
        Technische Details
      </summary>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl bg-(--surface-muted) px-3 py-2 text-[11px]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-(--fg-subtle)">{k}</dt>
            <dd className="tabular break-words text-(--fg)">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

function RunReport({ result }: { result: RunResult }) {
  if (result.detail) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-(--red)">{result.detail}</p>
        {result.rawDetail && <RawDetail detail={result.rawDetail} />}
      </div>
    );
  }
  const obs = result.observations ?? [];
  const transitions = result.transitions ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--fg-muted)">
        Slot {result.slot ?? "—"} {"·"} {result.dryRun ? "Vorschau (nichts gesendet)" : "ausgeführt"} {"·"} {transitions.length} Übergang{transitions.length === 1 ? "" : "e"}
        {result.errored && result.errored.length > 0 ? ` · nicht prüfbar: ${result.errored.map(humanErroredLabel).join(", ")}` : ""}
      </p>
      {transitions.length > 0 && (
        <ul className="space-y-1">
          {transitions.map((t, i) => (
            <li key={i} className="rounded-xl bg-(--surface-muted) px-3 py-2 text-[13px] break-words text-(--fg)">
              <span className="font-display font-semibold">{t.kind === "fired" ? "Alarm" : "Entwarnung"}</span> {"·"}{" "}
              {humanRuleLabel(t.rule_key, t.agent, t.subkey)} — {t.narrative}
            </li>
          ))}
        </ul>
      )}
      {obs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <caption className="sr-only">Auswertung je Regel</caption>
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-(--fg-subtle)">
                <th scope="col" className="py-2 pr-3 font-semibold">Regel</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">Wert</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">Grenze</th>
                <th scope="col" className="py-2 font-semibold">Hinweis</th>
              </tr>
            </thead>
            <tbody>
              {obs.map((o, i) => (
                <tr key={i} className="border-t border-(--border)">
                  <td className="py-2 pr-3 text-(--fg)">{humanRuleLabel(o.rule_key, o.agent, o.subkey)}</td>
                  <td className="py-2 pr-3"><StatusChip status={o.status} /></td>
                  <td className="py-2 pr-3 text-right">{humanRuleValue(o.rule_key, o.observed)}</td>
                  <td className="py-2 pr-3 text-right text-(--fg-muted)">{humanRuleThreshold(o.rule_key, o.threshold)}</td>
                  <td className="py-2 text-xs text-(--fg-muted)">
                    <span className="block">{humanRuleNote(o.note) ?? ""}</span>
                    <RowTechnicalDetails o={o} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Actions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [test, setTest] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "run");
    setTest(null);
    try {
      const r = await fetch("/api/monitoring/alerts/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const body = (await r.json()) as RunResult;
      if (!r.ok || body.ok !== true) setResult({ detail: RUN_FAILED, rawDetail: body.detail ?? `HTTP ${r.status}` });
      else setResult(body);
      if (!dryRun) router.refresh();
    } catch (err) {
      setResult({ detail: RUN_FAILED, rawDetail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setResult(null);
    try {
      const r = await fetch("/api/monitoring/alerts/test", { method: "POST" });
      const body = (await r.json()) as { delivery?: Record<string, string>; detail?: string };
      setTest(body.delivery ? Object.entries(body.delivery).map(([k, v]) => `${k === "teams" ? "Teams" : "E-Mail"}: ${humanDelivery(v).text}`).join(" · ") : (body.detail ?? "—"));
    } catch {
      setTest("Senden fehlgeschlagen – bitte erneut versuchen.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Aktionen" kicker="Manuell auswerten">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => void run(true)}>
          {busy === "preview" ? "Wertet aus …" : "Vorschau auswerten"}
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void run(false)}>
          {busy === "run" ? "Wertet aus …" : "Jetzt auswerten"}
        </button>
        <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => void sendTest()}>
          {busy === "test" ? "Sendet …" : "Testalarm senden"}
        </button>
      </div>
      {test && <p className="mt-3 text-sm text-(--fg-muted)">Testalarm — {test}</p>}
      {result && <div className="mt-4">{<RunReport result={result} />}</div>}
    </Card>
  );
}

function Recipients({ settings }: { settings: AlertSettings }) {
  const [emails, setEmails] = useState(settings.email_recipients.join(", "));
  const [digest, setDigest] = useState(settings.digest_enabled);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function save() {
    const list = emails.split(",").map((s) => s.trim()).filter(Boolean);
    setState("saving");
    setError("");
    try {
      const r = await fetch("/api/monitoring/alerts/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email_recipients: list, digest_enabled: digest }),
      });
      if (!r.ok) {
        setError("Ungültige Adresse oder Speichern fehlgeschlagen – bitte prüfen und erneut versuchen.");
        setState("error");
        return;
      }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setError("Speichern fehlgeschlagen – bitte erneut versuchen.");
      setState("error");
    }
  }

  return (
    <Card title="Empfänger" kicker="E-Mail und Digest">
      <div className="space-y-3">
        <label className="block text-xs font-medium text-(--fg-muted)" htmlFor="alert-recipients">
          E-Mail-Adressen (mit Komma getrennt)
        </label>
        <textarea
          id="alert-recipients"
          value={emails}
          onChange={(ev) => setEmails(ev.target.value)}
          rows={3}
          placeholder="team@sportnavi.de, ops@sportnavi.de"
          className={`${INPUT} h-auto min-h-[5rem] py-2 leading-relaxed`}
        />
        <p className="text-xs text-(--fg-subtle)">Leer {"⇒"} Fallback ALERT_EMAIL_TO</p>
        <label className="flex items-center gap-2 text-sm text-(--fg)">
          <input type="checkbox" checked={digest} onChange={(ev) => setDigest(ev.target.checked)} className="h-4 w-4 accent-(--brand-green)" />
          Digest an Teams
        </label>
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_PRIMARY} disabled={state === "saving"} onClick={() => void save()}>
            {state === "saving" ? "Speichert …" : "Speichern"}
          </button>
          {state === "saved" && (
            <span className="inline-flex items-center gap-1 text-sm text-(--fg-muted)">
              <Check className="h-4 w-4 text-(--brand-green)" aria-hidden /> Gespeichert
            </span>
          )}
          {state === "error" && <span className="text-sm text-(--red)">{error}</span>}
        </div>
      </div>
    </Card>
  );
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const [draft, setDraft] = useState({
    enabled: rule.enabled,
    severity: rule.severity,
    threshold: String(rule.threshold),
    window_hours: String(rule.window_hours),
    min_samples: String(rule.min_samples),
  });
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const isRate = rule.key === "failure_rate" || rule.key === "negative_feedback";

  const threshold = numOrNull(draft.threshold);
  const windowHours = numOrNull(draft.window_hours);
  const minSamples = numOrNull(draft.min_samples);
  const invalid = threshold === null || windowHours === null || minSamples === null;

  async function save() {
    if (invalid) {
      setState("error");
      return;
    }
    setState("saving");
    try {
      const r = await fetch(`/api/monitoring/alerts/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          severity: draft.severity,
          threshold,
          window_hours: windowHours,
          min_samples: minSamples,
        }),
      });
      if (!r.ok) {
        setState("error");
        return;
      }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("error");
    }
  }

  const id = (f: string) => `rule-${rule.id}-${f}`;
  const label = ruleScopeLabel(rule.key, rule.agent);
  return (
    <tr className="border-t border-(--border) align-top">
      <td className="py-3 pr-3">
        <div className="font-display text-sm font-semibold text-(--fg)">{label}</div>
        {rule.description && <div className="mt-0.5 max-w-[22rem] text-xs text-(--fg-muted)">{rule.description}</div>}
      </td>
      <td className="py-3 pr-3">
        <label className="inline-flex items-center gap-2 text-xs text-(--fg-muted)">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(ev) => setDraft({ ...draft, enabled: ev.target.checked })}
            className="h-4 w-4 accent-(--brand-green)"
            aria-label={`Regel aktiv: ${label}`}
          />
        </label>
      </td>
      <td className="py-3 pr-3">
        <label className="sr-only" htmlFor={id("severity")}>Schwere</label>
        <span className="relative inline-block w-[8.5rem]">
          <select
            id={id("severity")}
            value={draft.severity}
            onChange={(ev) => setDraft({ ...draft, severity: ev.target.value as AlertRule["severity"] })}
            className={SELECT}
          >
            <option value="warning">Warnung</option>
            <option value="alert">Alarm</option>
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-(--fg-subtle)" aria-hidden />
        </span>
      </td>
      <td className="py-3 pr-3">
        <label className="sr-only" htmlFor={id("threshold")}>Grenze</label>
        <input
          id={id("threshold")}
          type="number"
          step={stepFor(rule.key)}
          min={0}
          value={draft.threshold}
          onChange={(ev) => setDraft({ ...draft, threshold: ev.target.value })}
          className={`${INPUT} w-28`}
        />
        <div className="mt-1 text-[11px] text-(--fg-subtle)">
          {fmtRuleValue(rule.key, draft.threshold)}
          {isRate ? " (0,10 = 10 %)" : ""}
        </div>
      </td>
      <td className="py-3 pr-3">
        <label className="sr-only" htmlFor={id("window")}>Fenster in Stunden</label>
        <input
          id={id("window")}
          type="number"
          step={1}
          min={1}
          max={720}
          value={draft.window_hours}
          onChange={(ev) => setDraft({ ...draft, window_hours: ev.target.value })}
          className={`${INPUT} w-20`}
        />
      </td>
      <td className="py-3 pr-3">
        <label className="sr-only" htmlFor={id("samples")}>Mindestanzahl Turns</label>
        <input
          id={id("samples")}
          type="number"
          step={1}
          min={0}
          value={draft.min_samples}
          onChange={(ev) => setDraft({ ...draft, min_samples: ev.target.value })}
          className={`${INPUT} w-20`}
        />
      </td>
      <td className="py-3">
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_SECONDARY} disabled={state === "saving" || invalid} onClick={() => void save()}>
            {state === "saving" ? "Speichert …" : "Speichern"}
          </button>
          {state === "saved" && <Check className="h-4 w-4 text-(--brand-green)" aria-label="Gespeichert" />}
          {invalid && <span className="text-xs text-(--red)">Bitte gültige Zahlen eingeben</span>}
          {!invalid && state === "error" && <span className="text-xs text-(--red)">Speichern fehlgeschlagen – bitte erneut versuchen.</span>}
        </div>
      </td>
    </tr>
  );
}

// The rule table scrolls inside its own container below ~860 px. That container must be
// `relative`: the sr-only labels are position:absolute, and without a positioned ancestor
// they escape the scroll box and widen the whole page at 375 px (measured).
export function AlertRules({ rules, settings }: { rules: AlertRule[]; settings: AlertSettings }) {
  return (
    <div className="space-y-4">
      <Actions />
      <Recipients settings={settings} />
      <Card title="Regeln" kicker={`${rules.length} Regeln`} bodyClassName="p-0">
        {rules.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-(--fg-muted)">Keine Regeln konfiguriert.</p>
        ) : (
          <div className="relative overflow-x-auto px-5 pb-4">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <caption className="sr-only">Alarmregeln, editierbar</caption>
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-(--fg-subtle)">
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Regel</th>
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Aktiv</th>
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Schwere</th>
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Grenze</th>
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Fenster h</th>
                  <th scope="col" className="py-2.5 pr-3 font-semibold">Min. Turns</th>
                  <th scope="col" className="py-2.5 font-semibold"><span className="sr-only">Aktion</span></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <RuleRow key={r.id} rule={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

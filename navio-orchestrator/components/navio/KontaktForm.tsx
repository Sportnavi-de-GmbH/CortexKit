"use client";

// Kontaktformular (docs/design/NAVIO_PLUS_WIDGET_SPEC.md §8–9 + kontakt-formular.md).
// Cascading picklists (membership → grund → thema → kurzbeschreibung), text fields,
// UI-only consent checkboxes, submit → POST /api/contact, then a success view.
// The parent (NavioWidget) provides the header/footer; this renders the scrolling body.

import { useRef, useState } from "react";
import { Check, ChevronDown, Send } from "lucide-react";
import { MEMBERSHIP_OPTIONS, grundFor, themaFor, kurzFor, type Option } from "./contact-picklists";
import { submitContact, type ContactPayload } from "./contact-client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Real Sportnavi policy pages (override per-environment via env if they move).
const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz/";
const WIDERRUF_URL =
  process.env.NEXT_PUBLIC_WIDERRUF_URL ?? "https://www.sportnavi.de/widerrufsbelehrung/";

type Values = {
  membership: string;
  grund: string;
  thema: string;
  kurzbeschreibung: string;
  betreff: string;
  name: string;
  email: string;
  telefon: string;
  kundennummer: string;
  nachricht: string;
};

const EMPTY: Values = {
  membership: "",
  grund: "",
  thema: "",
  kurzbeschreibung: "",
  betreff: "",
  name: "",
  email: "",
  telefon: "",
  kundennummer: "",
  nachricht: "",
};

const FIELD_BASE =
  "w-full rounded-xl border bg-(--surface-muted) px-3.5 py-2.5 text-sm text-(--fg) placeholder:text-(--fg-subtle) focus:outline-none focus:ring-2 focus:ring-[#95c11e]/40";

export function KontaktForm({ onBack }: { onBack: () => void }) {
  const [v, setV] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Set<keyof Values | "datenschutz" | "widerruf">>(new Set());
  const [datenschutz, setDatenschutz] = useState(false);
  const [widerruf, setWiderruf] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneName, setDoneName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function set<K extends keyof Values>(key: K, value: string) {
    setV((prev) => {
      const next = { ...prev, [key]: value };
      // Cascade: resetting a parent clears its children so no invalid chain forms.
      if (key === "membership") Object.assign(next, { grund: "", thema: "", kurzbeschreibung: "" });
      if (key === "grund") Object.assign(next, { thema: "", kurzbeschreibung: "" });
      if (key === "thema") Object.assign(next, { kurzbeschreibung: "" });
      return next;
    });
  }

  function validate(): boolean {
    const e = new Set<keyof Values | "datenschutz" | "widerruf">();
    const required: (keyof Values)[] = [
      "membership",
      "grund",
      "thema",
      "kurzbeschreibung",
      "betreff",
      "name",
      "email",
      "nachricht",
    ];
    for (const k of required) if (!v[k].trim()) e.add(k);
    if (v.email.trim() && !EMAIL_RE.test(v.email.trim())) e.add("email");
    if (!datenschutz) e.add("datenschutz");
    if (!widerruf) e.add("widerruf");
    setErrors(e);
    return e.size === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitError(null);
    if (!validate()) {
      setSubmitError("Bitte fülle alle Pflichtfelder aus und bestätige die Hinweise.");
      return;
    }
    const payload: ContactPayload = {
      membership: v.membership,
      grund: v.grund,
      thema: v.thema,
      kurzbeschreibung: v.kurzbeschreibung,
      betreff: v.betreff.trim(),
      name: v.name.trim(),
      email: v.email.trim(),
      telefon: v.telefon.trim() || undefined,
      kundennummer: v.kundennummer.trim() || undefined,
      nachricht: v.nachricht.trim(),
    };
    setSending(true);
    abortRef.current = new AbortController();
    try {
      await submitContact(payload, abortRef.current.signal);
      setDoneName(v.name.trim().split(/\s+/)[0] || v.name.trim());
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ── Success view (spec §9) ────────────────────────────────────────────────
  if (doneName) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-(--brand-green)/15 text-(--brand-green)" aria-hidden="true">
          <Check size={32} strokeWidth={1.75} />
        </span>
        <h3 className="mt-5 font-headline text-xl font-semibold text-(--fg)">Danke, {doneName}! 🎉</h3>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-(--fg-muted)">
          Deine Nachricht ist bei uns eingegangen. Unser Team meldet sich zeitnah bei dir – in der
          Regel innerhalb von 1–2 Werktagen.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setV(EMPTY);
              setDatenschutz(false);
              setWiderruf(false);
              setErrors(new Set());
              setSubmitError(null);
              setDoneName(null);
            }}
            className="rounded-full bg-(--brand-green) px-5 py-2 text-sm font-medium text-white transition-transform hover:scale-[1.02]"
          >
            Neue Anfrage senden
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-full px-5 py-2 text-sm text-(--fg-subtle) transition-colors hover:text-(--fg)"
          >
            Zurück zum Menü
          </button>
        </div>
      </div>
    );
  }

  // ── Form view (spec §8) ───────────────────────────────────────────────────
  const grundOpts = grundFor(v.membership);
  const themaOpts = themaFor(v.grund);
  const kurzOpts = kurzFor(v.thema);

  return (
    <form onSubmit={onSubmit} className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <p className="text-sm leading-relaxed text-(--fg-muted)">
        Du hast Fragen oder willst direkt loslegen? Schreib uns – wir helfen dir gerne weiter.
      </p>

      {/* Membership — segmented */}
      <Field label="Art der Mitgliedschaft" required error={errors.has("membership")}>
        <div className="grid grid-cols-3 gap-2">
          {MEMBERSHIP_OPTIONS.map((o) => {
            const active = v.membership === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => set("membership", o.value)}
                className={`rounded-xl border px-2 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-(--brand-green) bg-(--brand-green)/10 text-(--fg)"
                    : "border-(--border) text-(--fg-muted) hover:border-(--fg)/40"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Grund der Anfrage" required error={errors.has("grund")}>
          <Select
            value={v.grund}
            options={grundOpts}
            placeholder="Bitte wählen"
            disabled={!v.membership}
            onChange={(val) => set("grund", val)}
            invalid={errors.has("grund")}
          />
        </Field>
        <Field label="Thema" required error={errors.has("thema")}>
          <Select
            value={v.thema}
            options={themaOpts}
            placeholder="Bitte wählen"
            disabled={!v.grund}
            onChange={(val) => set("thema", val)}
            invalid={errors.has("thema")}
          />
        </Field>
      </div>

      <Field label="Kurzbeschreibung" required error={errors.has("kurzbeschreibung")}>
        <Select
          value={v.kurzbeschreibung}
          options={kurzOpts}
          placeholder="Bitte wählen"
          disabled={!v.thema}
          onChange={(val) => set("kurzbeschreibung", val)}
          invalid={errors.has("kurzbeschreibung")}
        />
      </Field>

      <Field label="Betreff" required error={errors.has("betreff")}>
        <input
          className={`${FIELD_BASE} ${errors.has("betreff") ? "border-(--brand-orange)/60" : "border-(--border)"}`}
          value={v.betreff}
          onChange={(e) => set("betreff", e.target.value)}
          placeholder="Betreff deiner Nachricht"
          maxLength={200}
        />
      </Field>

      <Field label="Name" required error={errors.has("name")}>
        <input
          className={`${FIELD_BASE} ${errors.has("name") ? "border-(--brand-orange)/60" : "border-(--border)"}`}
          value={v.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Vor- und Nachname"
          maxLength={120}
          autoComplete="name"
        />
      </Field>

      <Field label="E-Mail Adresse" required error={errors.has("email")}>
        <input
          type="email"
          className={`${FIELD_BASE} ${errors.has("email") ? "border-(--brand-orange)/60" : "border-(--border)"}`}
          value={v.email}
          onChange={(e) => set("email", e.target.value)}
          placeholder="name@beispiel.de"
          maxLength={200}
          autoComplete="email"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Telefonnummer">
          <input
            type="tel"
            className={`${FIELD_BASE} border-(--border)`}
            value={v.telefon}
            onChange={(e) => set("telefon", e.target.value)}
            placeholder="Optional"
            maxLength={40}
            autoComplete="tel"
          />
        </Field>
        <Field label="Kundennummer">
          <input
            className={`${FIELD_BASE} border-(--border)`}
            value={v.kundennummer}
            onChange={(e) => set("kundennummer", e.target.value)}
            placeholder="Optional"
            maxLength={60}
          />
        </Field>
      </div>

      <Field label="Nachricht" required error={errors.has("nachricht")}>
        <textarea
          rows={4}
          className={`${FIELD_BASE} resize-none ${errors.has("nachricht") ? "border-(--brand-orange)/60" : "border-(--border)"}`}
          value={v.nachricht}
          onChange={(e) => set("nachricht", e.target.value)}
          placeholder="Deine Nachricht an uns …"
          maxLength={2000}
        />
      </Field>

      {/* Consent — UI only, never sent to the server */}
      <div className="space-y-2.5 pt-1">
        <ConsentRow checked={datenschutz} onToggle={() => setDatenschutz((c) => !c)} error={errors.has("datenschutz")}>
          Ich habe die <PolicyLink href={PRIVACY_URL}>Datenschutzerklärung</PolicyLink> gelesen und stimme der
          Verarbeitung meiner Daten zu.
        </ConsentRow>
        <ConsentRow checked={widerruf} onToggle={() => setWiderruf((c) => !c)} error={errors.has("widerruf")}>
          Ich habe die <PolicyLink href={WIDERRUF_URL}>Widerrufsbelehrung</PolicyLink> zur Kenntnis genommen.
        </ConsentRow>
      </div>

      {submitError && (
        <div className="rounded-xl border border-(--brand-orange)/30 bg-(--brand-orange)/5 px-3.5 py-2.5 text-xs text-(--brand-orange)">
          {submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={sending}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-(--brand-green) px-4 py-3 text-sm font-medium text-white transition-transform hover:scale-[1.01] disabled:opacity-60"
      >
        {sending ? "Wird gesendet …" : "Jetzt absenden"}
        {!sending && <Send size={16} strokeWidth={1.75} />}
      </button>
    </form>
  );
}

/* ── Small field primitives ─────────────────────────────────────────────────── */

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block font-headline text-[13px] font-medium text-(--fg)">
        {label}
        {required && <span className="text-(--brand-orange)"> *</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-(--brand-orange)">Pflichtfeld</p>}
    </div>
  );
}

function Select({
  value,
  options,
  placeholder,
  disabled,
  invalid,
  onChange,
}: {
  value: string;
  options: Option[];
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD_BASE} appearance-none pr-9 ${invalid ? "border-(--brand-orange)/60" : "border-(--border)"} ${
          value ? "text-(--fg)" : "text-(--fg-subtle)"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="text-(--fg)">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        strokeWidth={1.75}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--fg-subtle)"
        aria-hidden="true"
      />
    </div>
  );
}

/** A policy link inside a consent row — opens in a new tab without toggling the box. */
function PolicyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="font-medium text-(--fg) underline underline-offset-2 hover:text-(--brand-green)"
    >
      {children}
    </a>
  );
}

function ConsentRow({
  checked,
  onToggle,
  error,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 text-xs leading-relaxed text-(--fg-muted)">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
          checked
            ? "border-(--brand-green) bg-(--brand-green) text-white"
            : error
              ? "border-(--brand-orange)/70 bg-(--surface)"
              : "border-(--fg)/20 bg-(--surface)"
        }`}
      >
        {checked && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
      </button>
      {/* Clicking the text toggles; clicking a link opens it (stopPropagation above). */}
      <span className="cursor-pointer" onClick={onToggle}>
        {children}
      </span>
    </div>
  );
}

// Client-side helper for submitting the Kontaktformular.
//
// The browser NEVER talks to Salesforce — it posts a flat JSON payload to our own
// same-origin endpoint `POST /api/contact`, which authenticates to Salesforce
// server-side. See docs/reference/kontakt-formular.md §3.

export type ContactPayload = {
  membership: string;
  grund: string;
  thema: string;
  kurzbeschreibung: string;
  betreff: string;
  name: string;
  email: string;
  telefon?: string;
  kundennummer?: string;
  nachricht: string;
};

/**
 * POST the payload to `/api/contact` (same origin as the widget iframe, so no CORS).
 * Resolves on success; throws with a human-readable German message on failure.
 */
export async function submitContact(
  payload: ContactPayload,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d) => (typeof d?.detail === "string" ? d.detail : undefined))
      .catch(() => undefined);
    throw new Error(
      detail ?? `Senden fehlgeschlagen (${res.status}). Bitte später erneut versuchen.`,
    );
  }
}

// Cascading picklist data for the Kontaktformular (contact form).
//
// Salesforce dependent picklists: membership → grund → thema → kurzbeschreibung.
// Each option has a `value` (the exact Salesforce API value — THIS is what we send)
// and a `label` (German display text for the UI). Sending a label instead of a value
// makes the CaseHandler flow reject the Case, so the form always submits `value`.
//
// Golden rule for callers: when a parent selection changes, RESET all of its children
// so an invalid chain can never be assembled (see `emptyChildrenFrom`).
//
// Source of truth: docs/reference/kontakt-formular.md §7. This is a generated snapshot
// of the live Salesforce picklists — regenerate it after any Salesforce picklist change,
// or previously valid combinations will start failing at the flow with no local signal.

export type Option = { value: string; label: string };

/** Level 1 — Membership (Salesforce `MembershipType`). */
export const MEMBERSHIP_OPTIONS: Option[] = [
  { value: "Corporate Fitness", label: "Firmenmitglied" },
  { value: "Private", label: "Privatmitglied" },
  { value: "No Membership", label: "Kein Mitglied" },
];

/** Level 2 — CaseGrounds (`grund`) German labels. */
const GRUND_LABELS: Record<string, string> = {
  "Membership administration (Corporate)": "Meine Mitgliedschaft verwalten (Firma)",
  "Membership administration (Private)": "Meine Mitgliedschaft verwalten (Privat)",
  "General question": "Anmeldung und allgemeine Fragen",
  "Partner-related question": "Partnerbezogene Fragen",
};

const GRUND_BY_MEMBERSHIP: Record<string, string[]> = {
  "Corporate Fitness": [
    "Membership administration (Corporate)",
    "General question",
    "Partner-related question",
  ],
  Private: [
    "Membership administration (Private)",
    "General question",
    "Partner-related question",
  ],
  "No Membership": ["General question", "Partner-related question"],
};

/** Level 3 — Topic (`thema`) German display labels (values stay English for Salesforce). */
const THEMA_LABELS: Record<string, string> = {
  "Problem logging in": "Probleme beim Einloggen",
  "Adjust my plan (Corporate)": "Meinen Tarif anpassen (Firma)",
  "Adjust my plan (Private)": "Meinen Tarif anpassen (Privat)",
  "Corporate rates": "Firmenkonditionen",
  "Question about cancellation": "Frage zur Kündigung",
  "Payment/Invoices": "Zahlungen / Rechnungen",
  "Update personal information": "Persönliche Daten ändern",
  "My membership start date": "Mein Mitgliedschaftsbeginn",
  "Discounts/Coupons": "Rabatte / Gutscheine",
  "Pause my membership": "Mitgliedschaft pausieren",
  "I need to contact a department": "Ich möchte eine Abteilung kontaktieren",
  "Data protection": "Datenschutz",
  "Technical problems": "Technische Probleme",
  "Feedback about the app or website": "Feedback zur App oder Website",
  "I want to reactivate my membership": "Mitgliedschaft reaktivieren",
  "Questions before logging in/becoming a member": "Fragen vor Anmeldung / Mitgliedschaft",
  Cashback: "Cashback",
  "Reservation problems": "Reservierungsprobleme",
  "Live courses/Online courses": "Live- / Online-Kurse",
  "Information about a specific partner": "Infos zu einem bestimmten Partner",
  "Find partners in our app": "Partner in unserer App finden",
  "Check-in management": "Check-in-Verwaltung",
  Other: "Sonstiges",
};

const THEMA_BY_GRUND: Record<string, string[]> = {
  "Membership administration (Corporate)": [
    "Problem logging in",
    "Adjust my plan (Corporate)",
    "Corporate rates",
    "Question about cancellation",
    "Payment/Invoices",
    "Update personal information",
    "My membership start date",
    "Other",
  ],
  "Membership administration (Private)": [
    "Problem logging in",
    "Adjust my plan (Private)",
    "Discounts/Coupons",
    "Question about cancellation",
    "Payment/Invoices",
    "Pause my membership",
    "Update personal information",
    "My membership start date",
    "Other",
  ],
  "General question": [
    "I need to contact a department",
    "Data protection",
    "Technical problems",
    "Feedback about the app or website",
    "I want to reactivate my membership",
    "Questions before logging in/becoming a member",
    "Other",
  ],
  "Partner-related question": [
    "Cashback",
    "Reservation problems",
    "Live courses/Online courses",
    "Information about a specific partner",
    "Find partners in our app",
    "Check-in management",
    "Other",
  ],
};

/** Level 4 — ShortDescription (`kurzbeschreibung`); value === label (both German). */
const KURZ_BY_THEMA: Record<string, string[]> = {
  "Problem logging in": [
    "Ich kann mich in die App nicht einloggen",
    "Ich habe keinen Link zum Zurücksetzen meines Passwortes bekommen",
    "Ich kann meine Mitgliedschaft nicht verbinden",
    "Sonstiges",
  ],
  "Adjust my plan (Private)": [
    "Ich möchte zu einer Firmenmitgliedschaft wechseln",
    "Ich möchte meine Privatmitgliedschaft downgraden",
    "Ich möchte meine Privatmitgliedschaft upgraden",
    "Sonstiges",
  ],
  "Adjust my plan (Corporate)": [
    "Ich möchte zu einer Privatmitgliedschaft wechseln",
    "Ich wechsle meinen aktuellen Arbeitgeber",
    "Sonstiges",
  ],
  "Discounts/Coupons": [
    "Corporate Benefits / Mitarbeitervorteile",
    "Ich habe ein Problem, einen aktuellen Rabatt betreffend",
    "Information über Family&Friends",
    "Wie sehen die Konditionen meiner Mitgliedschaft aus",
    "Geschenkgutscheine",
    "Sonstiges",
  ],
  "Corporate rates": [
    "Corporate Benefits / Mitarbeitervorteile",
    "Information über Family&Friends",
    "Wie sehen die Konditionen meiner Mitgliedschaft aus",
    "Sonstiges",
  ],
  "Question about cancellation": [
    "Ich wechsle meinen aktuellen Arbeitgeber",
    "Ich habe gekündigt, aber mir wurde ein Betrag abgebucht",
    "Wie kündige ich eine Mitgliedschaft?",
    "Wie widerrufe ich meine Mitgliedschaft?",
    "Sonstiges",
  ],
  "Payment/Invoices": [
    "Meine Mitgliedschaft wurde gesperrt",
    "Ich habe eine Zahlung versäumt",
    "Mir wurde der falsche Betrag abgebucht/ in Rechnung gestellt",
    "Allgemeine Fragen zu Zahlungen/Rechnungen",
    "Sonstiges",
  ],
  "Pause my membership": [
    "Ich möchte meine Mitgliedschaft pausieren",
    "Ich möchte meine Pause aufheben",
    "Ich möchte eine Änderung meiner Pause beantragen",
    "Sonstiges",
  ],
  "Update personal information": [
    "Adresse/ Telefonnummer ändern",
    "Name oder E-Mail ändern",
    "Bankverbindung ändern",
    "Sonstiges",
  ],
  "My membership start date": ["Anmeldebestätigung", "Sonstiges"],
  "I need to contact a department": [
    "Personalabteilung",
    "Marketing",
    "Customer Service",
    "Firmen Management",
    "Partner (Success) Management",
    "Sonstiges",
  ],
  "Data protection": [
    "Allgemeine Datenbestandsabfragen",
    "Allgemeine Anfrage / Sonstiges",
    "Antrag auf Berichtigung der Daten",
    "Antrag auf Lösung der Daten / Einschränkung der Verarbeitung",
    "Sonstiges",
  ],
  "Technical problems": ["Sonstiges"],
  "Feedback about the app or website": ["Sonstiges"],
  "I want to reactivate my membership": ["Sonstiges"],
  "Questions before logging in/becoming a member": [
    "Unterschied Privat/Firmenmitgliedschaft",
    "Wie melde ich mich an?",
    "Wie funktioniert Sportnavi?",
    "Wie kann ich mich über meine Arbeitgeber /Verein etc. anmelden",
    "Sonstiges",
  ],
  Cashback: ["Wie funktioniert es?", "Sonstiges"],
  "Reservation problems": ["Sonstiges"],
  "Live courses/Online courses": [
    "Wie funktioniert es?",
    "Ich habe technische Probleme",
    "Ich habe keine E-Mail mit dem Link erhalten",
    "Kurse vor Ort",
    "Sonstiges",
  ],
  "Information about a specific partner": [
    "Informationen bezüglich des Partnerprofils",
    "Erfahrung bei einem Partner",
    "Sonstiges",
  ],
  "Find partners in our app": ["Sonstiges"],
  "Check-in management": [
    "Ich kann mich nicht einchecken",
    "Ich möchte einen Check-In hinzufügen",
    "Ich möchte die App auf einem anderen Endgerät nutzen",
    "Sonstiges",
  ],
  Other: ["Sonstiges"],
};

/** Level-2 options for a chosen membership value. */
export function grundFor(membership: string): Option[] {
  return (GRUND_BY_MEMBERSHIP[membership] ?? []).map((value) => ({
    value,
    label: GRUND_LABELS[value] ?? value,
  }));
}

/** Level-3 options for a chosen grund value. */
export function themaFor(grund: string): Option[] {
  return (THEMA_BY_GRUND[grund] ?? []).map((value) => ({
    value,
    label: THEMA_LABELS[value] ?? value,
  }));
}

/** Level-4 options for a chosen thema value (value === label). */
export function kurzFor(thema: string): Option[] {
  return (KURZ_BY_THEMA[thema] ?? []).map((value) => ({ value, label: value }));
}

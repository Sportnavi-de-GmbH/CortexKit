// Outbound links to sportnavi.de, shared by the menu's link row and the widget
// shell's privacy footer. Kept in one module so the privacy URL — which is a legal
// requirement and appears in four places (footer, consent gate, info panel, menu) —
// has exactly one definition and one env override.

/** Point this at the real Sportnavi privacy page (override via env if needed). */
export const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz/";

/**
 * The two pages the FAQ agent is allowed to send people to (prompt §8). They are
 * named here — not just buried in SITE_LINKS — because the in-chat action chips
 * resolve `[[action:faq]]` / `[[action:about]]` through them, and the prompt
 * promises these exact URLs.
 */
export const FAQ_URL = "https://www.sportnavi.de/faq/";
export const ABOUT_URL = "https://www.sportnavi.de/ueber-uns/";
/** The full studio directory — the Partner screen always offers it as a chip. */
export const STUDIOS_URL = "https://www.sportnavi.de/studios/";

export type SiteLink = { label: string; href: string };

/**
 * Deep links shown at the bottom of the menu. These LEAVE the widget, so they open
 * in a new tab — the widget lives in an iframe, and navigating in place would
 * replace the chat rather than the host page.
 */
export const SITE_LINKS: SiteLink[] = [
  { label: "FAQ / Hilfe", href: FAQ_URL },
  { label: "Studios", href: STUDIOS_URL },
  { label: "Kontakt", href: "https://www.sportnavi.de/kontakt/" },
  { label: "Über uns", href: ABOUT_URL },
  { label: "Datenschutz", href: PRIVACY_URL },
];

// Outbound links to sportnavi.de, shared by the menu's link row and the widget
// shell's privacy footer. Kept in one module so the privacy URL — which is a legal
// requirement and appears in four places (footer, consent gate, info panel, menu) —
// has exactly one definition and one env override.

/** Point this at the real Sportnavi privacy page (override via env if needed). */
export const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL ?? "https://www.sportnavi.de/datenschutz/";

export type SiteLink = { label: string; href: string };

/**
 * Deep links shown at the bottom of the menu. These LEAVE the widget, so they open
 * in a new tab — the widget lives in an iframe, and navigating in place would
 * replace the chat rather than the host page.
 */
export const SITE_LINKS: SiteLink[] = [
  { label: "FAQ / Hilfe", href: "https://www.sportnavi.de/faq/" },
  { label: "Studios", href: "https://www.sportnavi.de/studios/" },
  { label: "Kontakt", href: "https://www.sportnavi.de/kontakt/" },
  { label: "Über uns", href: "https://www.sportnavi.de/ueber-uns/" },
  { label: "Datenschutz", href: PRIVACY_URL },
];

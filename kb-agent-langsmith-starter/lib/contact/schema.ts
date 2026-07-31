// Server-side validation + field mapping for the contact endpoint.
// See docs/reference/kontakt-formular.md §4. Shared by the route handler and tests.

import { z } from "zod";

/** Cap on the free-text message (mirrors MAX_MESSAGE_CHARS on the backend). */
export const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS ?? 2000);

/**
 * The 10-field contact payload. Required fields use min(1) so an empty string is
 * rejected (422), not treated as missing. `email` is length-only server-side (the
 * form does the format check for UX); values pass through to Salesforce unchanged.
 */
export const ContactSchema = z.object({
  membership: z.string().min(1).max(40),
  grund: z.string().min(1).max(120),
  thema: z.string().min(1).max(120),
  kurzbeschreibung: z.string().min(1).max(300),
  betreff: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  email: z.string().min(3).max(200),
  telefon: z.string().max(40).nullish(),
  kundennummer: z.string().max(60).nullish(),
  nachricht: z.string().min(1).max(MAX_MESSAGE_CHARS),
});

export type ContactInput = z.infer<typeof ContactSchema>;

/** Map the German form fields to the Salesforce CaseHandler flow input names. */
export function toSalesforceInputs(b: ContactInput): Record<string, string> {
  return {
    MembershipType: b.membership,
    CaseGrounds: b.grund,
    Topic: b.thema,
    ShortDescription: b.kurzbeschreibung,
    Subject: b.betreff,
    Name: b.name,
    Email: b.email,
    Phone: b.telefon || "",
    CustomerNumber: b.kundennummer || "",
    Description: b.nachricht,
  };
}

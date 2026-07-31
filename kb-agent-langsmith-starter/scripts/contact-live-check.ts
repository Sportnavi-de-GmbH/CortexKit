// Real end-to-end check for the Kontaktformular → Salesforce integration.
//
//   npm run contact:check
//
// - With NO Salesforce credentials in .env.local → reports SIMULATE mode (no network).
// - With SALESFORCE_CLIENT_ID/SECRET filled in → creates a REAL test Case in Salesforce
//   and reports whether the CaseHandler flow succeeded. This proves the wiring works.
//
// ⚠️ When credentials are present this CREATES A REAL CASE in your Salesforce org
//    (subject prefixed "[TEST]"). Delete it afterwards if you don't want the test data.

import "../lib/load-env"; // MUST be first — loads .env.local before modules read process.env
import { salesforceEnabled, submitCase } from "../lib/contact/salesforce";
import { ContactSchema, toSalesforceInputs } from "../lib/contact/schema";

// A valid cascade chain (Private → General question → Technical problems → Sonstiges).
const testPayload = {
  membership: "Private",
  grund: "General question",
  thema: "Technical problems",
  kurzbeschreibung: "Sonstiges",
  betreff: "[TEST] Navio Kontaktformular Live-Check",
  name: "Navio Test",
  email: process.env.CONTACT_TEST_EMAIL ?? process.env.CONTACT_FALLBACK_EMAIL ?? "test@example.com",
  nachricht: "Automatischer Live-Check des Kontaktformulars — bitte ignorieren / kann gelöscht werden.",
};

async function main(): Promise<void> {
  const parsed = ContactSchema.safeParse(testPayload);
  if (!parsed.success) {
    console.error("❌ Test payload failed validation:", parsed.error.issues);
    process.exit(1);
  }
  const inputs = toSalesforceInputs(parsed.data);

  console.log("Salesforce configured:", salesforceEnabled());
  if (!salesforceEnabled()) {
    console.log(
      "\n→ SIMULATE MODE — no SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET in .env.local.",
    );
    console.log("  The form works and returns success, but nothing is sent to Salesforce.");
    console.log("  Fill both secrets in .env.local and re-run to test the REAL integration.");
    console.log("\n  Inputs that WOULD be sent to the CaseHandler flow:");
    console.log(inputs);
    return;
  }

  console.log(`\n→ Creating a REAL test Case in Salesforce (${process.env.SALESFORCE_INSTANCE_URL}) …`);
  const started = Date.now();
  const { ok, detail } = await submitCase(inputs);
  const ms = Date.now() - started;

  if (ok) {
    console.log(`\n✅ SUCCESS in ${ms}ms — a real Case was created. The contact form is LIVE.`);
    console.log(`   Check Salesforce for the "[TEST] …" Case (${testPayload.email}) and delete it if unwanted.`);
    process.exit(0);
  }
  console.error(`\n❌ FAILED in ${ms}ms — Salesforce did not create the Case.`);
  console.error("   Detail:", detail);
  console.error(
    "   Common causes: wrong CLIENT_ID/SECRET, wrong SALESFORCE_TOKEN_URL/INSTANCE_URL (sandbox vs prod),",
  );
  console.error("   the flow name/inputs not matching, or an invalid picklist chain for your org.");
  process.exit(1);
}

main().catch((e) => {
  console.error("❌ Live-check crashed:", e);
  process.exit(1);
});

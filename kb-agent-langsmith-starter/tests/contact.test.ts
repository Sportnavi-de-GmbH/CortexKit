import { describe, it, expect } from "vitest";
import { ContactSchema, toSalesforceInputs } from "../lib/contact/schema";
import { salesforceEnabled } from "../lib/contact/salesforce";

const valid = {
  membership: "Private",
  grund: "Membership administration (Private)",
  thema: "Problem logging in",
  kurzbeschreibung: "Ich kann mich in die App nicht einloggen",
  betreff: "Login funktioniert nicht",
  name: "Max Mustermann",
  email: "max@example.com",
  nachricht: "Hallo",
};

describe("contact schema (server-side validation)", () => {
  it("accepts a valid payload (optionals omitted)", () => {
    expect(ContactSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { betreff: _betreff, ...rest } = valid;
    expect(ContactSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty required string (min length 1)", () => {
    expect(ContactSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects an over-length field", () => {
    expect(ContactSchema.safeParse({ ...valid, betreff: "x".repeat(201) }).success).toBe(false);
  });
});

describe("salesforce mapping + simulate mode", () => {
  it("maps German fields to Salesforce flow inputs, defaulting optionals to ''", () => {
    const inputs = toSalesforceInputs(ContactSchema.parse(valid));
    expect(inputs.MembershipType).toBe("Private");
    expect(inputs.CaseGrounds).toBe("Membership administration (Private)");
    expect(inputs.Subject).toBe("Login funktioniert nicht");
    expect(inputs.Phone).toBe("");
    expect(inputs.CustomerNumber).toBe("");
    expect(inputs.Description).toBe("Hallo");
  });

  it("is in simulate mode when no Salesforce credentials are configured", () => {
    // No SALESFORCE_CLIENT_ID / SECRET in the test env → the endpoint simulates success.
    expect(salesforceEnabled()).toBe(false);
  });
});

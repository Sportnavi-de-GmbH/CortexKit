import { describe, expect, it } from "vitest";

import {
  classify,
  severityFor,
  fingerprintFor,
  titleFor,
  labelFor,
  scrub,
} from "../lib/sentry-agent";
import { handlersFor, type SentryLike } from "../agent/hooks/sentry";
import { recordKnownNames, resetBudget } from "../lib/request-budget";

describe("classify", () => {
  it("maps HTTP-status-bearing errors to external", () => {
    expect(classify(Object.assign(new Error("boom"), { status: 503 }))).toBe("external");
    expect(classify(Object.assign(new Error("boom"), { statusCode: 429 }))).toBe("external");
  });

  it("maps Supabase and embedding failures to integration", () => {
    expect(classify(new Error("supabase: connection refused"))).toBe("integration");
    expect(classify(new Error("embedding request failed"))).toBe("integration");
    expect(classify("Search failed: fetch failed")).toBe("integration");
  });

  it("defaults to runtime", () => {
    expect(classify(new Error("undefined is not a function"))).toBe("runtime");
  });
});

describe("severity and grouping", () => {
  it("marks agent failures fatal — the user got nothing", () => {
    expect(severityFor("agent")).toBe("fatal");
    expect(severityFor("unexpected")).toBe("warning");
  });

  it("fingerprints stay stable per class+key so retries collapse to one issue", () => {
    expect(fingerprintFor("integration", "resolve_partners")).toEqual([
      "partner-agent",
      "integration",
      "resolve_partners",
    ]);
  });

  it("titles read as a sentence and labels are plain English", () => {
    expect(titleFor("integration", "tool", "resolve_partners", "supabase down")).toBe(
      "[integration] tool 'resolve_partners' failed: supabase down",
    );
    expect(labelFor("external")).toMatch(/External API failure/);
  });
});

describe("scrub", () => {
  it("redacts secret-shaped keys recursively", () => {
    expect(scrub({ apiKey: "x", nested: { SENTRY_DSN: "y", ok: 1 } })).toEqual({
      apiKey: "[redacted]",
      nested: { SENTRY_DSN: "[redacted]", ok: 1 },
    });
  });
});

function fakeSentry(): {
  sentry: SentryLike;
  captured: unknown[][];
  crumbs: unknown[];
  messages: unknown[][];
} {
  const captured: unknown[][] = [];
  const crumbs: unknown[] = [];
  const messages: unknown[][] = [];
  return {
    captured,
    crumbs,
    messages,
    sentry: {
      captureException: (...args: unknown[]) => {
        captured.push(args);
        return "event-id";
      },
      captureMessage: (...args: unknown[]) => {
        messages.push(args);
        return "event-id";
      },
      setConversationId: () => {},
      setUser: () => {},
      addBreadcrumb: (b) => {
        crumbs.push(b);
      },
      setTag: () => {},
    },
  };
}

const ctx = { agent: { name: "partner-agent" }, channel: { kind: "eve" }, session: { id: "s1" } };

describe("sentry hook", () => {
  it("captures a failing tool result with class, label, and tool tag", async () => {
    const { sentry, captured } = fakeSentry();
    await handlersFor(sentry)["action.result"](
      { data: { result: { isError: true, toolName: "resolve_partners", output: "supabase down" } } },
      ctx,
    );
    expect(captured).toHaveLength(1);
    const [error, options] = captured[0] as [Error, Record<string, any>];
    expect(error.message).toBe("[integration] tool 'resolve_partners' failed: supabase down");
    expect(options.tags["failure.class"]).toBe("integration");
    expect(options.fingerprint).toEqual(["partner-agent", "integration", "resolve_partners"]);
  });

  it("records a breadcrumb, not an event, for a successful tool", async () => {
    const { sentry, captured, crumbs } = fakeSentry();
    await handlersFor(sentry)["action.result"](
      { data: { result: { isError: false, toolName: "extract_city" } } },
      ctx,
    );
    expect(captured).toHaveLength(0);
    expect(crumbs).toHaveLength(1);
  });

  it("never lets a throwing Sentry client escape the hook (iron rule)", async () => {
    const throwing: SentryLike = {
      captureException: () => {
        throw new Error("sentry down");
      },
      captureMessage: () => {
        throw new Error("sentry down");
      },
      setConversationId: () => {
        throw new Error("sentry down");
      },
      setUser: () => {},
      addBreadcrumb: () => {
        throw new Error("sentry down");
      },
      setTag: () => {
        throw new Error("sentry down");
      },
    };
    const handlers = handlersFor(throwing);
    for (const name of Object.keys(handlers)) {
      await expect(handlers[name]({ data: {} }, ctx)).resolves.toBeUndefined();
    }
  });

  it("marks turn failures fatal with the code as error name", async () => {
    const { sentry, captured } = fakeSentry();
    await handlersFor(sentry)["turn.failed"](
      { data: { code: "MODEL_CALL_FAILED", message: "rate limit" } },
      ctx,
    );
    const [error, options] = captured[0] as [Error, Record<string, any>];
    expect(error.name).toBe("MODEL_CALL_FAILED");
    expect(options.level).toBe("fatal");
    expect(options.tags["failure.class"]).toBe("agent");
  });

  it("captures a fabrication message when the reply names a partner outside the known set", async () => {
    resetBudget(ctx.session.id);
    recordKnownNames(ctx.session.id, ["Yoga Studio Nord"]);
    const { sentry, messages } = fakeSentry();
    await handlersFor(sentry)["message.completed"](
      { data: { message: "Ich empfehle dir das Kletterzentrum Himmelsleiter." } },
      ctx,
    );
    expect(messages).toHaveLength(1);
    const [title, options] = messages[0] as [string, Record<string, any>];
    expect(title).toContain("[fabrication]");
    expect(options.tags["failure.class"]).toBe("fabrication");
    expect(options.extra.suspectCount).toBe(1);
    // PRIVACY: the suspect name itself must never be forwarded.
    expect(JSON.stringify(options)).not.toContain("Kletterzentrum Himmelsleiter");
  });

  it("does not capture anything when the reply only names known partners", async () => {
    resetBudget(ctx.session.id);
    recordKnownNames(ctx.session.id, ["Yoga Studio Nord"]);
    const { sentry, messages } = fakeSentry();
    await handlersFor(sentry)["message.completed"](
      { data: { message: "Ich empfehle dir das Yoga Studio Nord." } },
      ctx,
    );
    expect(messages).toHaveLength(0);
  });

  it("does nothing on a message.completed event with no text", async () => {
    const { sentry, messages } = fakeSentry();
    await handlersFor(sentry)["message.completed"]({ data: {} }, ctx);
    expect(messages).toHaveLength(0);
  });
});

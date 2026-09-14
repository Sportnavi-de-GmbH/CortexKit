import { describe, it, expect, vi } from "vitest";
import {
  applyTrace,
  applyUserMessage,
  applyFailure,
  initialWorkflowState,
  type WorkflowTraceLite,
} from "../lib/workflow-agent-state";
import { forwardToWorkflow } from "../lib/partner-workflow";

const trace = (p: Partial<WorkflowTraceLite>): WorkflowTraceLite => ({
  runId: "r1",
  status: "ok",
  answer: undefined,
  clarification: undefined,
  error: undefined,
  pending: [],
  deferred: [],
  ...p,
});

describe("workflow agent state", () => {
  it("a sent message becomes a submitted user message with a turn id", () => {
    const s = applyUserMessage(initialWorkflowState(), "Yoga in Bochum");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "user", metadata: { status: "submitted", turnId: "turn_1" } });
    expect(s.messages[0]!.parts).toEqual([{ type: "text", text: "Yoga in Bochum", state: "done" }]);
    expect(s.turn).toBe(1);
  });

  it("an ok trace appends the composed answer as a complete assistant message", () => {
    const s0 = applyUserMessage(initialWorkflowState(), "Yoga in Bochum");
    const s = applyTrace(s0, trace({ answer: "**Gefunden.**" }));
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ role: "assistant", metadata: { status: "complete", turnId: "turn_1" } });
    expect(s.messages[1]!.parts).toEqual([{ type: "text", text: "**Gefunden.**", state: "done" }]);
    expect(s.resume).toBeNull();
  });

  it("executed tasks' recommendations ride on metadata.result as the v3-tasks envelope", () => {
    const card = { logoUrl: null, street: null, postalCode: null, email: null, phone: null, websiteUrl: "https://a.de", mapsUrl: null, tags: [], courses: [] };
    const rec = { rank: 1, id: 7, name: "A", city: "Dortmund", role: "target" as const, distanceKm: 0, card };
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "x"), trace({
      answer: "**A**",
      tasks: [
        { task: { id: "t1", label: "Tennis in Dortmund", query: "q", cityMention: null, priority: 1 }, status: "ok", recommendations: [rec] },
        { task: { id: "t2", label: "Boxen", query: "q", cityMention: null, priority: 2 }, status: "needs_clarification" },
      ],
    }));
    expect(s.messages[1]!.metadata?.result).toEqual({ kind: "v3-tasks", tasks: [{ label: "Tennis in Dortmund", recommendations: [rec] }] });
  });

  it("no executed tasks ⇒ no result envelope", () => {
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "x"), trace({ answer: "A" }));
    expect(s.messages[1]!.metadata?.result).toBeUndefined();
  });

  it("a clarification trace shows the question and keeps pending/deferred for the next turn", () => {
    const pending = [{ id: "p1", label: "Tennis", query: "Tennis", cityMention: null, priority: 1 }];
    const deferred = [{ id: "d1", label: "Yoga in Essen", query: "Yoga in Essen", cityMention: "Essen", priority: 2 }];
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "x"), trace({ status: "needs_clarification", answer: "**A**\n\nKurze Frage…", clarification: "Kurze Frage…", pending, deferred }));
    expect(s.messages[1]!.parts).toEqual([{ type: "text", text: "**A**\n\nKurze Frage…", state: "done" }]);
    expect(s.resume).toEqual({ pending, deferred });
  });

  it("a single-task clarification (no answer) shows the clarification text", () => {
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "Yoga"), trace({ status: "needs_clarification", clarification: "In welcher Stadt?", pending: [{ id: "p", label: "Yoga", query: "Yoga", cityMention: null, priority: 1 }] }));
    expect(s.messages[1]!.parts).toEqual([{ type: "text", text: "In welcher Stadt?", state: "done" }]);
  });

  it("a failed trace becomes a failed user turn plus an error, no assistant bubble", () => {
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "x"), trace({ status: "failed", error: { message: "embed down" } }));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.metadata?.status).toBe("failed");
    expect(s.error?.message).toMatch(/embed down/);
  });

  it("a transport failure marks the user turn failed and records the error", () => {
    const s = applyFailure(applyUserMessage(initialWorkflowState(), "x"), new Error("HTTP 503"));
    expect(s.messages[0]!.metadata?.status).toBe("failed");
    expect(s.error?.message).toBe("HTTP 503");
  });

  it("the next user message clears a previous error and increments the turn", () => {
    const s = applyUserMessage(applyFailure(applyUserMessage(initialWorkflowState(), "a"), new Error("x")), "b");
    expect(s.error).toBeUndefined();
    expect(s.turn).toBe(2);
    expect(s.messages.at(-1)!.metadata?.turnId).toBe("turn_2");
  });
});

describe("forwardToWorkflow", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000/api/partner/workflow", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", ...headers },
      body: JSON.stringify(body),
    });

  it("503 when PARTNER_AGENT_HOST is unset", async () => {
    const res = await forwardToWorkflow(post({ message: "x" }), { host: "" });
    expect(res.status).toBe(503);
  });

  it("400 when the message is missing", async () => {
    const res = await forwardToWorkflow(post({ nope: 1 }), { host: "http://127.0.0.1:3008" });
    expect(res.status).toBe(400);
  });

  it("maps { message, resume } to V3's { query, resume } and returns the upstream JSON + status", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:3008/api/workflow");
      expect(JSON.parse(init.body as string)).toEqual({ query: "Yoga in Bochum", resume: { pending: [], deferred: [] } });
      expect((init.headers as Headers).get("authorization")).toMatch(/^Basic /);
      return new Response(JSON.stringify({ runId: "r", status: "ok", answer: "A" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const res = await forwardToWorkflow(post({ message: "Yoga in Bochum", resume: { pending: [], deferred: [] } }), {
      host: "http://127.0.0.1:3008",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "s3cret",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: "A" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a self-target host", async () => {
    const res = await forwardToWorkflow(post({ message: "x" }), { host: "http://localhost:3000" });
    expect(res.status).toBe(503);
    expect((await res.json()).detail).toMatch(/itself/);
  });

  it("502 when the upstream is unreachable", async () => {
    const res = await forwardToWorkflow(post({ message: "x" }), {
      host: "http://127.0.0.1:3008",
      fetchImpl: (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });
});

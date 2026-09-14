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

  it("a failed trace becomes a failed user turn plus a GENERIC error, no assistant bubble", () => {
    const s = applyTrace(applyUserMessage(initialWorkflowState(), "x"), trace({ status: "failed", error: { message: "embed down: ECONNREFUSED" } }));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.metadata?.status).toBe("failed");
    expect(s.error?.message).not.toMatch(/embed|ECONNREFUSED/);
    expect(s.error?.message).toMatch(/Partnersuche/);
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

  it("maps { message, resume } to V3's { query, resume }, authenticates, and returns ONLY the UI projection", async () => {
    const card = { logoUrl: null, street: null, postalCode: null, email: null, phone: null, websiteUrl: "https://a.de", mapsUrl: null, tags: [], courses: [] };
    const fullTrace = {
      runId: "r", startedAt: "t", totalMs: 9000, status: "ok", answer: "A", pending: [], deferred: [],
      input: { query: "Yoga in Bochum" }, config: { runTimeoutMs: 45000 }, decompose: { id: "decompose", output: { tasks: [] } },
      tasks: [{
        task: { id: "t1", label: "Yoga in Bochum", query: "Yoga in Bochum", cityMention: "Bochum", priority: 1 }, status: "ok", totalMs: 8000,
        stages: [{ id: "search", output: { candidates: [{ id: 1, similarity: 0.9 }], embedding: { preview: [0.1] } } }],
        recommendations: [{ rank: 1, id: 7, name: "A", city: "Bochum", role: "target", distanceKm: 0, finalScore: 0.8, relevance: 0.7, profile: "long profile text", card }],
      }],
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:3008/api/workflow");
      expect(JSON.parse(init.body as string)).toEqual({ query: "Yoga in Bochum", resume: { pending: [], deferred: [] } });
      expect((init.headers as Headers).get("authorization")).toBe("Basic " + Buffer.from("navio-proxy:s3cret").toString("base64"));
      return new Response(JSON.stringify(fullTrace), { status: 200, headers: { "content-type": "application/json" } });
    });
    const res = await forwardToWorkflow(post({ message: "Yoga in Bochum", resume: { pending: [], deferred: [] } }), {
      host: "http://127.0.0.1:3008",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "s3cret",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      runId: "r", status: "ok", answer: "A", pending: [], deferred: [],
      tasks: [{ task: { id: "t1", label: "Yoga in Bochum", query: "Yoga in Bochum", cityMention: "Bochum", priority: 1 }, status: "ok",
        recommendations: [{ rank: 1, id: 7, name: "A", city: "Bochum", role: "target", distanceKm: 0, card }] }],
    });
    for (const k of ["config", "decompose", "stages", "input", "totalMs"]) expect(body).not.toHaveProperty(k);
    expect(JSON.stringify(body)).not.toMatch(/similarity|finalScore|profile text|preview/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a failed trace reaches the browser as status=failed with NO internal message", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ runId: "r", status: "failed", pending: [], deferred: [], tasks: [], error: { message: "dependencies: MEMORY_SUPABASE_SERVICE_ROLE_KEY missing" } }), { status: 200 })) as unknown as typeof fetch;
    const res = await forwardToWorkflow(post({ message: "x" }), { host: "http://127.0.0.1:3008", fetchImpl, secret: "s" });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toMatch(/SUPABASE|dependencies/);
  });

  it("prefers the dedicated PARTNER_WORKFLOW_HOST/SECRET over the shared eve-proxy pair", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://v3.example.com/api/workflow");
      expect((init.headers as Headers).get("authorization")).toBe("Basic " + Buffer.from("navio-proxy:v3-only").toString("base64"));
      return new Response(JSON.stringify({ runId: "r", status: "ok", answer: "A", pending: [], deferred: [], tasks: [] }), { status: 200 });
    });
    const res = await forwardToWorkflow(post({ message: "x" }), {
      host: "http://old-agent", secret: "shared",
      workflowHost: "https://v3.example.com", workflowSecret: "v3-only",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
  });

  it("upstream 401/5xx/non-JSON become a generic 502 for the browser (details stay in server logs)", async () => {
    const ups = [
      () => new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401 }),
      () => new Response("<html>gateway timeout</html>", { status: 504 }),
      () => new Response("not json", { status: 200 }),
    ];
    for (const up of ups) {
      const res = await forwardToWorkflow(post({ message: "x" }), { host: "http://127.0.0.1:3008", fetchImpl: (async () => up()) as unknown as typeof fetch, secret: "s" });
      expect(res.status).toBe(502);
      expect((await res.json()).detail).toBe("Partner agent unavailable.");
    }
  });

  it("refuses a self-target host", async () => {
    const res = await forwardToWorkflow(post({ message: "x" }), { host: "http://localhost:3000" });
    expect(res.status).toBe(503);
    expect((await res.json()).detail).toMatch(/misconfigured/);
  });

  it("502 with a generic detail when the upstream is unreachable", async () => {
    const res = await forwardToWorkflow(post({ message: "x" }), {
      host: "http://127.0.0.1:3008",
      fetchImpl: (async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:3008" } }); }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Partner agent unavailable.");
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });
});

describe("forwardToWorkflow — monitoring observer", () => {
  const req = (body: unknown) =>
    new Request("http://widget.local/api/partner/workflow", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://widget.local", host: "widget.local" },
      body: JSON.stringify(body),
    });
  const fullTrace = { runId: "r1", status: "ok", answer: "A", pending: [], deferred: [], tasks: [] };

  it("strips sessionId/turnId before forwarding and hands the FULL trace to observe()", async () => {
    let forwarded: unknown;
    const seen: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      forwarded = JSON.parse(String(init.body));
      return new Response(JSON.stringify(fullTrace), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await forwardToWorkflow(req({ message: "Yoga in Bochum", sessionId: "s1", turnId: "turn_3" }), {
      host: "http://127.0.0.1:3008", fetchImpl, observe: async (o) => { seen.push(o); },
    });
    expect(res.status).toBe(200);
    expect(forwarded).toEqual({ query: "Yoga in Bochum" });
    expect(seen[0]).toMatchObject({ sessionId: "s1", turnId: "turn_3", message: "Yoga in Bochum", status: 200, origin: "http://widget.local", trace: fullTrace });
  });

  it("an upstream failure is observed with its status and no trace", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async () => new Response("Bad Gateway", { status: 502 })) as unknown as typeof fetch;
    const res = await forwardToWorkflow(req({ message: "x", sessionId: "s1", turnId: "turn_1" }), { host: "http://127.0.0.1:3008", fetchImpl, observe: (o) => { seen.push(o); } });
    expect(res.status).toBe(502);
    expect(seen[0]).toMatchObject({ status: 502, detail: "Bad Gateway" });
    expect((seen[0] as { trace?: unknown }).trace).toBeUndefined();
  });

  it("a malformed turnId is dropped, and a throwing observer never changes the response", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async () => new Response(JSON.stringify(fullTrace), { status: 200 })) as unknown as typeof fetch;
    const res = await forwardToWorkflow(req({ message: "x", sessionId: "s1", turnId: "evil" }), {
      host: "http://127.0.0.1:3008", fetchImpl, observe: (o) => { seen.push(o); throw new Error("db down"); },
    });
    expect(res.status).toBe(200);
    expect((seen[0] as { turnId?: string }).turnId).toBeUndefined();
  });
});

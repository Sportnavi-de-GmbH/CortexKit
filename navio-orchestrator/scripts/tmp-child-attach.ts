// TEMP: verify child-session stream attach works (deleted after use).
import "../lib/load-env.ts";
import { Client } from "eve/client";

const HOST = "http://127.0.0.1:3011";

async function main() {
  const client = new Client({ host: HOST });
  const session = client.session();
  const t0 = Date.now();
  let childId: string | null = null;

  const response = await session.send({ message: "Wie funktioniert das Cashback?" });
  const reader = (async () => {
    for await (const raw of response) {
      const e = raw as { type?: string; data?: Record<string, unknown> };
      if (e.type === "subagent.called" && !childId) {
        childId = String(e.data?.childSessionId ?? "");
        console.log(`subagent.called at +${Date.now() - t0}ms child=${childId}`);
      }
    }
  })();

  // Poll until we have the child id, then attach a SECOND client to its stream.
  while (!childId && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
  if (!childId) { console.log("no subagent.called within 30s"); await reader; return; }

  const attach = new Client({ host: HOST });
  const child = attach.session({ sessionId: childId, streamIndex: 0 });
  let chars = 0; let first: number | null = null;
  try {
    for await (const raw of child.stream({ startIndex: 0 })) {
      const e = raw as { type?: string; data?: Record<string, unknown> };
      if (e.type === "message.appended") {
        const d = String(e.data?.messageDelta ?? "");
        if (d && first === null) { first = Date.now() - t0; console.log(`first child delta at +${first}ms`); }
        chars += d.length;
      }
      if (["session.waiting", "session.completed", "session.failed"].includes(e.type ?? "")) {
        console.log(`child boundary ${e.type} at +${Date.now() - t0}ms, ${chars} chars streamed`);
        break;
      }
    }
  } catch (err) {
    console.log("child stream attach FAILED:", String(err).slice(0, 200));
  }
  await reader;
  console.log(`parent turn done at +${Date.now() - t0}ms`);
}
void main();

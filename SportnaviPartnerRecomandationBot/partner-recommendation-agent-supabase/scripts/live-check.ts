/**
 * live-check.ts — send one message to the running eve agent over HTTP and
 * print the session id, the streamed reply, and the terminal event.
 *
 * Verification tool for EVE_LANGSMITH_TRACING_GUIDE.md §11 Step V3: sends a
 * turn so the LangSmith trace pipeline (agent/instrumentation.ts) and hook
 * (agent/hooks/langsmith.ts) have something to produce. Not a test — a
 * manual live-check, matching the guide's `scripts/live-check.ts` pattern.
 *
 * Run: EVE_HOST=http://127.0.0.1:<port> npx tsx scripts/live-check.ts "<message>"
 * The host must be read from the `eve dev` log line — never assume a port
 * (guide §11 Step V2: a stale sibling server can squat the default port).
 */
const host = process.env.EVE_HOST;
if (!host) {
  console.error("Set EVE_HOST=http://127.0.0.1:<port> (read the port from the `eve dev` log line).");
  process.exit(1);
}

const message = process.argv[2];
if (!message) {
  console.error('Usage: EVE_HOST=http://127.0.0.1:<port> npx tsx scripts/live-check.ts "<message>"');
  process.exit(1);
}

async function main() {
  const createRes = await fetch(`${host}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!createRes.ok) {
    throw new Error(`session create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { sessionId: string };
  const sessionId = created.sessionId;
  console.log(`session: ${sessionId}`);

  const streamRes = await fetch(`${host}/eve/v1/session/${sessionId}/stream`);
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`stream failed: ${streamRes.status}`);
  }

  let reply = "";
  let terminal = "";
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const evt = JSON.parse(line) as { type: string; data?: Record<string, unknown> };
      console.log(`  event: ${evt.type}`);
      const text = evt.data?.message ?? evt.data?.text;
      if (evt.type === "message.completed" && typeof text === "string" && text.trim() !== "") {
        reply = text;
      }
      if (["turn.completed", "turn.failed", "session.failed", "session.waiting"].includes(evt.type)) {
        terminal = evt.type;
        if (evt.type !== "session.waiting") break;
      }
    }
    if (terminal && terminal !== "session.waiting") break;
  }

  console.log(`\nterminal event: ${terminal}`);
  console.log(`reply:\n${reply || "(no reply text captured)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

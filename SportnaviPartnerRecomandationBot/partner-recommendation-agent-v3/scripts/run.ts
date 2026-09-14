import "../lib/reused/load-env";
import { runWorkflow } from "../workflow/run-workflow";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('usage: npm run workflow -- "Ich suche Physiotherapie in Bochum" [--home Dortmund] [--radius 30]');
  process.exit(1);
}
const homeIdx = process.argv.indexOf("--home");
const radiusIdx = process.argv.indexOf("--radius");
const trace = await runWorkflow(
  { query: query.replace(/--home \S+|--radius \S+/g, "").trim(), homeCity: homeIdx > 0 ? process.argv[homeIdx + 1] : undefined },
  radiusIdx > 0 ? { searchRadiusKm: Number(process.argv[radiusIdx + 1]) } : {},
);
for (const s of trace.stages) {
  console.log(`\n[${s.status.toUpperCase()}] ${s.title} (${s.durationMs} ms)`);
  if (s.counts) console.log("  counts:", JSON.stringify(s.counts));
  for (const w of s.warnings) console.log("  ⚠", w);
  if (s.error) console.log("  ✖", s.error.message);
}
console.log(`\nstatus: ${trace.status} · ${trace.totalMs} ms`);
if (trace.clarification) console.log(trace.clarification);
if (trace.answer) console.log("\n" + trace.answer);
if (process.argv.includes("--json")) console.log(JSON.stringify(trace, null, 2));

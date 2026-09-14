import "../lib/reused/load-env";
import { runWorkflow } from "../workflow/run-workflow";

const args = process.argv.slice(2);
const queryParts: string[] = [];
let homeCity: string | undefined;
let radiusArg: string | undefined;
let json = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--home") {
    const value = args[++i];
    if (value === undefined) {
      console.error("usage: --home requires a value, e.g. --home Dortmund (quote multi-word cities: --home \"Bad Homburg\")");
      process.exit(1);
    }
    homeCity = value;
  } else if (arg === "--radius") {
    const value = args[++i];
    if (value === undefined) {
      console.error("usage: --radius requires a value, e.g. --radius 30");
      process.exit(1);
    }
    radiusArg = value;
  } else if (arg === "--json") {
    json = true;
  } else {
    queryParts.push(arg);
  }
}

const query = queryParts.join(" ").trim();
if (!query) {
  console.error(
    'usage: npm run workflow -- "Ich suche Physiotherapie in Bochum" [--home Dortmund] [--radius 30] [--json]\n' +
      '       (--home does not support multi-word cities except via quoting, e.g. --home "Bad Homburg")',
  );
  process.exit(1);
}

const trace = await runWorkflow(
  { query, homeCity },
  radiusArg !== undefined ? { searchRadiusKm: Number(radiusArg) } : {},
);
function printStages(stages: typeof trace.stages, indent = ""): void {
  for (const s of stages) {
    console.log(`${indent}[${s.status.toUpperCase()}] ${s.title} (${s.durationMs} ms)`);
    if (s.counts) console.log(`${indent}  counts:`, JSON.stringify(s.counts));
    for (const w of s.warnings) console.log(`${indent}  ⚠`, w);
    if (s.error) console.log(`${indent}  ✖`, s.error.message);
  }
}

console.log("");
printStages([trace.decompose]);
for (const t of trace.tasks) {
  console.log(`\n── task ${t.task.id} · ${t.task.label} · ${t.status} · ${t.totalMs} ms`);
  printStages(t.stages, "  ");
}
console.log(`\nstatus: ${trace.status} · ${trace.totalMs} ms · ${trace.tasks.length} task(s) run, ${trace.deferred.length} deferred, ${trace.pending.length} pending`);
if (trace.error) console.log("✖", trace.error.message);
if (trace.clarification) console.log(trace.clarification);
if (trace.answer) console.log("\n" + trace.answer);
if (trace.deferred.length) console.log("\ndeferred:", trace.deferred.map((d) => d.label).join(", "));
if (trace.pending.length) console.log("pending:", trace.pending.map((p) => p.label).join(", "));
if (json) console.log(JSON.stringify(trace, null, 2));
if (trace.status !== "ok") process.exit(1);

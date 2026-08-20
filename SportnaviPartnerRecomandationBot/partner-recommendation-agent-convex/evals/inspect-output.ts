/**
 * inspect-output.ts — the "inspect before you implement" step.
 * Runs ONE case end-to-end and prints the real output shape so evaluators are
 * written against what the agent actually produces, not what we assume.
 *
 * Run: npx tsx evals/inspect-output.ts "Ich suche ein gutes Fitnessstudio in München 💪"
 */
import { runCase } from "./run-agent";

async function main() {
  const turn = process.argv[2] ?? "Ich suche ein gutes Fitnessstudio in München 💪";
  const results = await runCase({ turns: [turn] });

  for (const [i, t] of results.entries()) {
    console.log(`\n═══ TURN ${i + 1} ═══`);
    console.log(`USER: ${t.userTurn}`);
    console.log(`STEPS: ${t.stepCount}   TOOLS: ${t.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
    console.log(`TOOL INPUT: ${JSON.stringify(t.toolCalls[0]?.input ?? null)}`);
    console.log(`\n--- GROUNDING CORPUS ---`);
    console.log(`  partners returned : ${t.grounding.partnerNames.length}`);
    console.log(`  names[0..4]       : ${JSON.stringify(t.grounding.partnerNames.slice(0, 5))}`);
    console.log(`  cities searched   : ${JSON.stringify(t.grounding.citiesSearched)}`);
    console.log(`  phones captured   : ${t.grounding.phones.length} e.g. ${JSON.stringify(t.grounding.phones.slice(0, 2))}`);
    console.log(`  emails captured   : ${t.grounding.emails.length} e.g. ${JSON.stringify(t.grounding.emails.slice(0, 2))}`);
    console.log(`  urls captured     : ${t.grounding.urls.length}`);
    console.log(`  needsClarification: ${t.grounding.needsClarification}`);
    console.log(`  disclosure        : ${JSON.stringify(t.grounding.disclosures)}`);
    console.log(`  profileText chars : ${t.grounding.profileText.length}`);
    console.log(`\n--- ANSWER (${t.answer.length} chars) ---`);
    console.log(t.answer);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

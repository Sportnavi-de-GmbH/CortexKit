// Fast dev-iteration evaluation — the "quick test" tier.
//
// Runs the 10-sample curated subset (evals/datasets/navio-kb-dev-subset-v1.json)
// instead of the full 60, with only the 2 judges that matter most for prompt
// iteration (hallucination + correctness). ~5-7 min and ~$0.15 instead of
// ~35 min / ~$1.15, while still exercising the known regression guards
// (KB pause-splitting sample-028, language-mirroring sample-033/060, security
// refusal sample-052, multi-turn retention sample-042).
//
// This is a THIN wrapper: it only sets sensible defaults, then hands off to
// the unmodified scripts/run-eval.ts (which reads all its config from env at
// module load). No evaluation logic is duplicated or changed.
//
// The Azure throttle is left at run-eval.ts's safe default (2 turns/min), so
// there is no rate-limit / 429 risk regardless of which prompt is deployed.
//
// Usage (EVE_HOST must point at YOUR running eve dev server's real port):
//   EVE_HOST=http://127.0.0.1:2001 npm run eval:dev
//
// Every default below is overridable — set the env var yourself to change it:
//   EVE_HOST=... EVAL_JUDGES=all npm run eval:dev        # all 7 judges on the 10 samples
//   EVE_HOST=... EVAL_JUDGES=none npm run eval:dev       # deterministic-only, fastest
import "../lib/load-env.ts";

process.env.EVAL_DATASET ??= "navio-kb-dev-subset-v1";
process.env.EVAL_JUDGES ??= "hallucination,correctness";
process.env.EVAL_EXPERIMENT_PREFIX ??= "navio-kb-dev";

// Hand off to the real runner. It reads the env above at import time and
// executes its two-phase flow exactly as `npm run eval:run` does.
await import("./run-eval.ts");

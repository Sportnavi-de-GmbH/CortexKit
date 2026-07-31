# Baseline System Prompt — Provenance

**File:** `system_prompt_baseline.txt`
**Preserved:** 2026-07-29, immediately before `agent/instructions.md` was
overwritten with the `system_prompt_v1_kb_dedup` candidate for A/B testing.
**MD5:** `7f98f54b13d1e92ebed491e2c8638213`
**Source:** exact byte-for-byte copy of `agent/instructions.md` as it
existed for the baseline experiment
`agent-eval_navio-kb-v2_gpt-4.1_quality-cost-latency_full60_v1_20260728-de9dcfd1`.

This file is the reference original. To restore production to this exact
baseline at any time:

```bash
cp system_prompt_optimization/baseline/system_prompt_baseline.txt agent/instructions.md
```

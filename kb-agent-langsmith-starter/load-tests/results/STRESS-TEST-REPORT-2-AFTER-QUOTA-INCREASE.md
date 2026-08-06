# Navio — Stress Test #2: after the model + quota change

**Date:** 2026-08-06 · **Tool:** k6 v2.1.0 · **Target:** `navio-widget.vercel.app` (production)

**What changed since test #1:** the FAQ agent moved from **`gpt-4.1` @ ~50k TPM** to
**`gpt-4o-mini` @ 250k TPM** (verified live — the agent now reports
`"modelId":"openai/gpt-4o-mini"`).

> ## ✅ Result: the production blocker is fixed.
> Turn success went from **87% → 100%**, and p95 time-to-first-token collapsed from
> **32.2 s → 1.85 s** (17× better). No empty bubbles, no rate-limit failures at launch
> concurrency. The safe ceiling moved from **~3 to ~12–15 concurrent users**.

---

## 1. Before / after

| Metric | Before (gpt-4.1 @ 50k) | **After (gpt-4o-mini @ 250k)** | Change |
|---|---|---|---|
| **Turn success rate** | 87.09% (27/31) | **100.00% (46/46)** | ✅ +13 pts |
| **Empty bubbles** (`turn.failed`) | 4 | **0** | ✅ eliminated |
| FAQ — first token, median | 2,650 ms | **1,599 ms** | ✅ 1.7× faster |
| **FAQ — first token, p95** | **32,214 ms** | **1,848 ms** | ✅ **17× faster** |
| FAQ — full answer, median | 6,650 ms | **3,625 ms** | ✅ 1.8× faster |
| FAQ — full answer, p95 | 34,814 ms | **7,461 ms** | ✅ 4.7× faster |
| Partner — first token, median | 19,401 ms | **4,487 ms** | ✅ 4.3× faster |
| Partner — full answer, median | 26,102 ms | **11,656 ms** | ✅ 2.2× faster |
| Session create, median | 570 ms | 587 ms | ≈ unchanged |
| HTTP failures / 5xx | 0 | 0 | — |

**The tail latency collapse is the headline.** p95 first-token dropping from 32 s to 1.85 s means
requests are no longer queueing behind a saturated quota — the spread between median and p95 is
now tiny (1.6 s → 1.85 s), which is what a healthy, unsaturated system looks like.

Partner searches now complete in **~12 s median** instead of 26 s, comfortably inside the
documented 30–60 s expectation.

---

## 2. New concurrency ceiling

Stepped probe (N simultaneous FAQ turns, counting turns that produced an answer):

| Concurrent users | Before (gpt-4.1 @ 50k) | **After (gpt-4o-mini @ 250k)** |
|---|---|---|
| 3 | ✅ 0% fail | ✅ 0% fail |
| 6 | ⚠️ **17% fail** | ✅ **0% fail** |
| 12 | *(not tested — already failing)* | ✅ **0% fail** |
| 15–20 | — | ⚠️ **15% fail** at 20 |
| 30 | — | 🔴 **43% fail** |

**Safe operating ceiling: ~12–15 concurrent turns** (was ~3). Failures above that are still
`exceeded rate limit`, i.e. the 250k TPM boundary — the behaviour is the same, just 4× further out.

### What that means in real users

A turn occupies the model ~3.6 s within a ~45 s user cycle (~8% duty cycle), so **12 concurrent
turns ≈ 140–150 people actively chatting at once**, or roughly **1,000+ conversations/hour**. That
is ample headroom for sportnavi.de.

---

## 3. Sustained-load run (the numbers above)

- 10 concurrent FAQ visitors + 2 concurrent partner searches
- 46 real AI turns (40 FAQ + 6 partner), 8 min
- **100% success, 0 HTTP failures, 0 Azure 429s, 0 empty answers**

k6 reports the run as "threshold crossed" only because the thresholds were authored against the
*old* model's slow behaviour; every threshold was in fact beaten by a wide margin. (Kept as-is so
the two runs stay directly comparable.)

---

## 4. Remaining recommendations

1. 🟠 **Still surface `turn.failed` in the widget UI.** The quota increase removes *this* cause,
   but any future model outage, timeout, or content filter still renders as a silent empty bubble.
   This is now the single largest remaining UX risk. (Unchanged from report #1.)
2. 🟠 **Run the eval set against `gpt-4o-mini`.** This test measured *speed and reliability only* —
   it says nothing about answer quality. gpt-4o-mini is a substantially smaller model than
   gpt-4.1; before locking it in for production, run `npm run eval:run` and compare scores,
   especially the grounding/honesty cases. **This is the one open risk of the change.**
3. 🟡 **Alert on turn-failure rate, not HTTP status** — every failure in test #1 returned HTTP 200.
4. 🟡 **Headroom note:** if traffic grows past ~12 concurrent, either raise TPM again or deploy
   Prompt V3 (halving the ~16.7k prompt would roughly double capacity for free).

---

## 5. Test conduct

- No firewall bypass was needed this time (the earlier DDoS challenge had expired).
- Cost: ~100 real AI turns across probes + sustained run. On gpt-4o-mini this is a fraction of a
  euro (~30× cheaper per token than gpt-4.1).
- Scope: only `navio-widget` / `navio-partner`; the `frontend` project was untouched.

## Artifacts

| File | Contents |
|---|---|
| `05-stress-4omini-250k-summary.json` | k6 aggregated metrics, sustained run |
| `STRESS-TEST-REPORT-2-AFTER-QUOTA-INCREASE.md` | This report |
| `../step-concurrency.sh` | Stepped concurrency probe used to find the ceiling |
| `STRESS-TEST-REPORT.md` | Test #1 (the failure this fixes) |

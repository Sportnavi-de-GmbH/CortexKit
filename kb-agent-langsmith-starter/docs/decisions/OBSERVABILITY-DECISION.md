# Decision Memo: Observability & Evaluation Tooling for Navio

**Date:** 2026-07-31
**Topic:** Should we self-host our AI monitoring tools (LangSmith or MLflow), or keep using the managed LangSmith Cloud (EU)?
**Audience:** Management / stakeholders
**Status:** Recommendation — ready for sign-off

---

## Executive summary (the recommendation)

**Keep using LangSmith Cloud in the EU region. Do not self-host LangSmith, and do not adopt
self-hosted MLflow at this time.**

For our current product — a **public FAQ chatbot** (Navio) running on Vercel with Azure OpenAI —
the managed LangSmith EU service already gives us everything we need (tracing, debugging,
experiment comparison, cost and speed visibility, EU data residency) at **near-zero cost and
near-zero maintenance**. Self-hosting either tool would add real infrastructure, security work,
and ongoing staff effort **without solving a problem we actually have today.**

We keep our options open for the future through an open standard (OpenTelemetry) already built
into our system, so we are **not locked in** and can change course later with minimal effort.

---

## What this tooling is for (plain language)

"Observability and evaluation" tools let us:
- **See what the chatbot is doing** — every question and answer, so we can debug problems.
- **Measure quality** — run tests and compare different versions of the chatbot to prove a change
  is genuinely better.
- **Track cost and speed** — how much each conversation costs and how fast answers come back.

Today we use **LangSmith** for this. The question is whether we should run our *own copy* of a
similar tool on our own servers instead.

---

## The options we evaluated

| Option | What it means | Recommendation |
|---|---|---|
| **A. LangSmith Cloud (EU)** *(current)* | Use the ready-made service, hosted for us in the EU. | ✅ **Recommended** |
| **B. Self-hosted LangSmith** | Run LangSmith ourselves on our own servers. | ❌ Not suitable |
| **C. Self-hosted MLflow** | Run the open-source MLflow tool on our own servers. | ❌ Not now |

---

## Why NOT self-hosted LangSmith (Option B)

- **It's locked behind an Enterprise contract.** Self-hosting LangSmith requires signing an
  Enterprise sales agreement and a paid license — it is not available on the normal plans. So it
  isn't even an option for us without a major commitment.
- **It's heavy to run.** It needs a full cluster of servers and specialized databases that we'd
  have to operate and maintain 24/7 — we have no infrastructure team for this.
- **It solves a problem we already solved.** The main reason to self-host is data privacy — but
  LangSmith already offers an **EU region**, which we use, keeping our data in Europe (GDPR) for
  free.

**Conclusion:** high cost and effort, no benefit for us.

---

## Why NOT self-hosted MLflow (Option C)

MLflow is **free, open-source software** and lighter to run than LangSmith — so it deserved a
serious look. But for our project:

- **Its main strength doesn't apply to us.** MLflow is best known for managing *trained AI
  models* (a "model registry"). We don't train models — Navio works through carefully written
  instructions, not custom-trained models. So MLflow's biggest advantage is irrelevant to us.
- **Its testing/evaluation features are Python-only.** Our entire system is built in a different
  language (TypeScript). Adopting MLflow's evaluation would mean **rebuilding work we already have**
  and adding a second technology to maintain.
- **We'd own all the security and upkeep.** MLflow has **no built-in login/password protection by
  default** — we'd have to add security, encryption, backups, and upgrades ourselves. That's real,
  continuous work for a small team.
- **It would cost more in practice.** "Free software" still means paying for servers and — more
  importantly — **staff time**. At our small scale, that's *more* expensive than the managed
  service, which is effectively free for us today.

**Conclusion:** technically capable, but adds complexity and cost to gain features we don't need.

---

## Side-by-side comparison

| What matters to us | LangSmith Cloud (EU) | Self-hosted LangSmith | Self-hosted MLflow |
|---|---|---|---|
| **Works with our system today** | ✅ Already integrated | ⚠️ Enterprise-only | ⚠️ Needs rework (Python) |
| **Setup effort** | ✅ Done | ❌ Very high | ⚠️ Moderate |
| **Ongoing maintenance** | ✅ None (managed) | ❌ Heavy | ❌ Meaningful (we run it) |
| **Data privacy (EU/GDPR)** | ✅ EU region, compliant | ✅ (but we run it) | ✅ (but we run it) |
| **Security handled for us** | ✅ Yes | ❌ Our responsibility | ❌ Our responsibility |
| **Cost at our scale** | ✅ Free / low | ❌ Enterprise license + servers | ⚠️ Servers + staff time |
| **Scales as we grow** | ✅ Automatic | ⚠️ We manage | ⚠️ We manage |

---

## Cost picture (at our current scale)

- **LangSmith Cloud (EU):** effectively **free** — our chatbot's volume fits comfortably in the
  free/low tier, with EU data residency included at no extra charge.
- **Self-hosted (either tool):** monthly **server and database costs**, **plus** engineering time
  for security, backups, and upgrades — and, for LangSmith, an **Enterprise license fee** on top.

In short: self-hosting would **increase** our total cost, not reduce it, until we are operating at
a much larger scale.

---

## How this supports our future (RAG and growth)

We're planning to evolve Navio from today's "curated knowledge in the instructions" toward a more
advanced **RAG** system (where the chatbot searches a larger knowledge library for each question).

- **LangSmith already supports evaluating RAG systems** — so it grows with us; no tool change
  required.
- Our system also emits data in a **neutral open standard (OpenTelemetry)**. This is our safety
  net: if our needs change dramatically later, we can redirect our monitoring data to a different
  tool (including MLflow) **without rebuilding the chatbot.**

So choosing the managed service now does **not** lock us in.

---

## When we would revisit this decision

We should reconsider self-hosting **only if** one of these becomes true:
1. We start **training our own AI models** (then MLflow's model registry becomes genuinely useful).
2. A **strict legal/contractual requirement** demands data never leave our own servers, beyond what
   the EU region already provides.
3. We reach **very high usage volumes** where paying per-use costs more than running our own
   infrastructure.

None of these apply to a public FAQ chatbot today.

---

## Recommendation

> **Continue with LangSmith Cloud (EU region).** It meets every need — reliable tracing and
> debugging, experiment comparison, cost and speed visibility, and EU data protection — with the
> **lowest cost, lowest risk, and least maintenance** for our team. We keep our flexibility for the
> future through the OpenTelemetry standard, and we revisit self-hosting only when a concrete new
> need (custom models, strict compliance, or large scale) actually arrives.

*Prepared by the Navio development team. A detailed technical version of this analysis is available
on request.*

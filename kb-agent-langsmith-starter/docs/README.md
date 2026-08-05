# Navio app documentation

Technical documentation for the Navio app (`kb-agent-langsmith-starter/`), grouped by purpose.
**Start with the Complete Guide** if you're new — it's written for everyone, non-technical included.

## 📘 Guides
| Doc | What it's for |
|---|---|
| [guides/NAVIO-COMPLETE-GUIDE.md](guides/NAVIO-COMPLETE-GUIDE.md) | **The single source of truth** — plain-language handbook: what Navio is, how it works, deploy, secure, embed, test, maintain, FAQ, troubleshooting, roadmap. |

## 🚀 Deployment
| Doc | What it's for |
|---|---|
| **[deployment/VERCEL-DASHBOARD-GUIDE.md](deployment/VERCEL-DASHBOARD-GUIDE.md)** | ⭐ **Canonical guide.** Complete non-technical, two-service deploy + security walkthrough (§1 architecture → §8 launch checklist): firewall rules, bot protection, rate limits, the shared-secret Partner lock, secrets, cost caps, monitoring. **Start here.** |
| [deployment/PUBLIC-WIDGET-DEPLOYMENT.md](deployment/PUBLIC-WIDGET-DEPLOYMENT.md) | The deeper *why* — architecture + rationale behind the canonical guide's steps. |
| [deployment/VERCEL-RUNBOOK.md](deployment/VERCEL-RUNBOOK.md) | The same steps via the Vercel CLI (copy-paste commands); mirrors the canonical guide. |

## 🎨 Design
| Doc | What it's for |
|---|---|
| [design/WIDGET-DESIGN-GUIDELINES.md](design/WIDGET-DESIGN-GUIDELINES.md) | **The design system** — tokens, colors, typography, components, do's & don'ts. |
| [design/NAVIO_WIDGET_SPEC.md](design/NAVIO_WIDGET_SPEC.md) | Screen-by-screen spec of the chat-first widget (greeting → consent → chat → info). |
| [design/NAVIO_PLUS_WIDGET_SPEC.md](design/NAVIO_PLUS_WIDGET_SPEC.md) | Spec of the "Plus" (menu) widget variant. |

## 🧭 Decisions
| Doc | What it's for |
|---|---|
| [decisions/OBSERVABILITY-DECISION.md](decisions/OBSERVABILITY-DECISION.md) | Why we use **LangSmith Cloud (EU)** rather than self-hosting LangSmith or MLflow. |

---

*New docs go in the matching subfolder (`guides/ deployment/ design/ decisions/`). Keep this index
in sync. Broader project/business documentation lives in the repo-root `../../docs/` folder.*

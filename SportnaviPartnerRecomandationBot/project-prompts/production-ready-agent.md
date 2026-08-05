# Deep Research & System Architecture Prompt

Read and deeply analyze **all** of the Eve documentation before making any recommendations:

* https://eve.dev/docs/getting-started
* Read every relevant documentation page, guide, architecture document, production guide, API reference, and best practice.

Do **not** give me a quick summary. Think like a Staff/Principal AI Engineer and design a system that could be deployed in a real production company.

## My Goal

I am **non-technical** and want to commit to **one framework** that allows me to build and ship increasingly complex AI systems without constantly changing stacks.

I don't just want an AI agent.

I want a **complete AI Operating System** built on Eve and Claude Code that can scale from a single assistant to a large multi-agent platform.

## Design Requirements

Design an architecture that includes:

### 1. Production-Ready Foundation

* Enterprise-grade architecture
* Clean folder structure
* Modular design
* Easy maintenance
* Versioning
* Environment separation (dev/staging/production)
* CI/CD deployment
* Rollback strategy

### 2. Multi-Agent System

Design a scalable architecture with:

* Master orchestrator
* Specialized agents
* Worker agents
* Planning agent
* Research agent
* Coding agent
* Review agent
* Memory agent
* Evaluation agent

Explain how they communicate and when delegation should happen.

### 3. Guardrails

Implement multiple layers of protection:

* Input validation
* Prompt injection protection
* Jailbreak detection
* Output validation
* Hallucination detection
* Human approval for sensitive actions
* Permission-based tool access
* Role-based access control
* Safety policies
* Compliance rules

### 4. Security

Design security for production:

* Secret management
* Authentication
* Authorization
* API protection
* Rate limiting
* Encryption
* Audit logs
* Secure tool execution
* Least-privilege access
* Data isolation

### 5. Observability

Everything should be traceable.

Include:

* Request tracinghttps://eve.dev/docs/getting-started
* Tool traces
* Prompt logging
* Response logging
* Error tracking
* Performance monitoring
* Latency metrics
* Success/failure metrics
* Token usage
* Model usage
* Cost per request
* Cost per user
* Cost per agent
* Daily and monthly spending dashboards

### 6. Cost Management

Design automatic protections including:

* Budget limits
* Spending alerts
* Daily limits
* Monthly limits
* Model routing based on cost
* Automatic fallback to cheaper models
* Token budgeting
* Cost estimation before expensive tasks
* Usage analytics

### 7. Memory

Recommend the best memory architecture:

* Short-term memory
* Long-term memory
* User memory
* Project memory
* Retrieval (RAG)
* Knowledge base
* Conversation history
* Semantic search
* Memory cleanup strategy

### 8. Reliability

The system should survive failures.

Include:

* Retries
* Timeouts
* Circuit breakers
* Queueing
* Durable execution
* Idempotency
* Recovery after crashes
* Health checks

### 9. Evaluation

Build continuous quality assurance:

* Automatic evaluations
* Regression tests
* Prompt tests
* Agent benchmarks
* Tool tests
* Success metrics
* Quality scoring

### 10. Developer Experience

Remember that I am non-technical.

Design the project so that:

* Claude Code can manage almost everything.
* The architecture is simple to understand.
* Components are easy to replace.
* Adding new agents requires minimal work.
* The system remains organized as it grows.

## Technology Choices

Recommend the minimal stack necessary.

For every dependency, explain:

* Why it is needed
* Whether Eve already provides this capability
* Whether an external tool is required
* Why it is the best long-term choice

Avoid unnecessary complexity.

## Deliverables

Produce:

1. Complete architecture diagram
2. Folder structure
3. System design
4. Data flow diagrams
5. Agent interaction diagrams
6. Security architecture
7. Monitoring architecture
8. Cost management architecture
9. Deployment architecture
10. Step-by-step implementation roadmap

## Decision Framework

For every recommendation, explain:

* Why this choice is better than alternatives
* Trade-offs
* Scalability
* Operational complexity
* Long-term maintainability
* Estimated costs
* Production readiness

## Final Goal

The final result should be a **production-grade AI Operating System** built around Eve as the core framework, using Claude Code as the primary development environment.

The architecture should support everything from a single AI assistant to a sophisticated enterprise multi-agent platform while remaining secure, observable, cost-efficient, maintainable, and easy for a non-technical founder to operate.

Do not optimize for a quick demo. Optimize for a system that could realistically be used and expanded over the next 3–5 years.

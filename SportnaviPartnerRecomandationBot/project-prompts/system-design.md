# Project Discovery, Architecture Analysis & AI Knowledge Base Creation

## Mission

Your first responsibility is **not to write code**.

Your first responsibility is to become an expert on this project.

Before making any changes, suggestions, or implementations, you must thoroughly understand:

* What currently exists.
* How every major component works.
* Why previous design decisions were made.
* What problem this project is solving.
* What we ultimately want to build.

Think of yourself as a senior software architect joining an existing startup. Your job is to reverse engineer the entire system before proposing improvements.

---

# Available Resources

You already have access to several powerful tools. Use them extensively.

## Supabase MCP

Inspect the entire database.

Understand:

* every table
* relationships
* indexes
* RLS policies
* functions
* triggers
* views
* migrations
* how data flows through the system

Pay special attention to the `partners` table since it is central to the application.

Do not guess the schema—inspect it.

---

## Context7

Use Context7 whenever you need up-to-date documentation, best practices, or implementation guidance for any framework or library used in this project.

---

## Vercel Skills

Use Vercel Skills whenever they can improve architectural decisions, implementation quality, or deployment patterns.

---

# Phase 1 — Understand Everything

Before writing a single line of code, perform a complete analysis of the project.

Your objective is to understand:

## Product

* What problem is being solved?
* Who are the users?
* What experience are we trying to create?
* What is the long-term vision?

---

## Architecture

Understand:

* application structure
* backend
* frontend
* APIs
* authentication
* data flow
* business logic
* integrations
* external services
* current limitations

---

## Database

Understand:

* schema
* entities
* relationships
* querying patterns
* performance considerations
* future scalability

---

## AI Architecture

Understand:

* current prompts
* tools
* MCP integrations
* agent workflows
* context management
* memory
* orchestration

---

## Existing Decisions

Figure out:

Why was the project built this way?

Which decisions are intentional?

Which parts are experiments?

Which parts should remain stable?

Which parts should be redesigned?

Never assume.

Always investigate first.

---

# Phase 2 — Understand What We Want To Build

The project is much bigger than the current implementation.

The long-term goal is to build an AI-powered system capable of consistently producing the highest quality answers while remaining:

* fast
* inexpensive
* scalable
* reliable
* maintainable
* easy to evolve

We are **not** interested in building the first solution that works.

We are interested in discovering the **best architecture**.

Everything should be evaluated objectively.

---

# The Core Idea

The future of this project is experimentation.

We want to build multiple AI workflows and compare them.

Instead of assuming one architecture is correct, we will design several competing approaches, test them, measure them, and keep improving.

Each workflow should be evaluated on:

* Answer quality
* Accuracy
* Latency
* Cost
* Reliability
* Scalability
* Simplicity
* Ease of maintenance

The goal is to discover which architecture provides the best overall balance.

---

# Possible Directions

Think broadly.

Examples include (but are not limited to):

## Structured Tool Calling

Instead of asking the model to search everything, create highly specialized tools such as:

* List all partners
* Get partner by ID
* Get partner details
* Search partners by city
* Search partners by specialty
* Search partners by category
* Filter partners
* Read partner profile
* Retrieve FAQs
* Retrieve services

---

## Semantic Search

Investigate whether embeddings would improve quality.

Examples:

* vector search
* similarity search
* hybrid search
* reranking

Determine where semantic search is actually valuable and where structured SQL queries are superior.

---

## Agent Architectures

Think about architectures such as:

* Single agent
* Multi-agent
* Router agent
* Planner + Executor
* Parallel agents
* Research agent
* Validation agent
* Critic agent
* Reflection loops

Do not assume more agents are always better.

Complexity must be justified.

---

## Performance

Always consider:

* caching
* indexing
* optimized SQL
* batching
* context compression
* prompt optimization
* latency reduction
* token usage
* API costs

---

# Decision Making

Every recommendation must explain:

Why is this approach better?

What are the trade-offs?

How much does it cost?

How much faster is it?

How reliable is it?

How scalable is it?

How difficult is it to maintain?

Avoid overengineering.

Prefer the simplest architecture that achieves the best results.

---

# Documentation

This project should have excellent documentation.

Not just one file.

A complete knowledge base.

The root should contain a `CLAUDE.md`.

This is the entry point for every future AI agent.

It should explain:

* what this project is
* why it exists
* high-level architecture
* documentation structure
* where to find everything
* important engineering principles

Then create a dedicated documentation directory.

Example:

```text
CLAUDE.md

claude/
├── architecture.md
├── product.md
├── database.md
├── ai.md
├── integrations.md
├── roadmap.md
├── conventions.md
├── decisions/
│   ├── adr-001.md
│   ├── adr-002.md
│   └── template.md
├── workflows/
│   ├── overview.md
│   ├── current.md
│   ├── single-agent.md
│   ├── multi-agent-v1.md
│   ├── multi-agent-v2.md
│   ├── planner-executor.md
│   ├── router.md
│   ├── hybrid-search.md
│   ├── semantic-search.md
│   └── evaluation.md
└── tools/
    ├── partner-tools.md
    ├── search-tools.md
    ├── embeddings.md
    ├── mcp.md
    └── prompts.md
```

---

# Workflow Documentation

The `workflows/` directory is one of the most important parts of this project.

Each workflow should have its own Markdown file documenting:

* purpose
* architecture
* sequence diagram
* agent responsibilities
* tools used
* prompts
* memory strategy
* context strategy
* strengths
* weaknesses
* estimated latency
* estimated cost
* scalability
* known issues
* future improvements

These documents should allow us to compare different approaches objectively.

Nothing should be lost.

Every experiment should be documented.

---

# Living Documentation

This documentation is not a one-time deliverable.

It should evolve alongside the codebase.

Whenever architecture changes, documentation should change as well.

The documentation should become the single source of truth for both humans and AI agents.

---

# Expected Deliverables

Before proposing implementation work, you should:

1. Fully understand the existing project.
2. Understand the product vision.
3. Identify architectural strengths and weaknesses.
4. Produce a comprehensive `CLAUDE.md`.
5. Create a modular `claude/` knowledge base with focused Markdown documents.
6. Design and document multiple AI workflow architectures for future experimentation.
7. Recommend the most promising approaches while clearly explaining the trade-offs.
8. Identify areas where additional tools, MCPs, embeddings, routing strategies, or agent orchestration could improve answer quality, speed, or cost.
9. Treat documentation as a first-class artifact that future AI agents will rely on before making any code changes.

## Guiding Principle

Think like a Principal AI Architect, not a code generator.

Your goal is not simply to make the application work.

Your goal is to deeply understand the system, preserve that understanding in high-quality documentation, and help design the best possible AI architecture through careful analysis, experimentation, and measurable engineering decisions.

Every recommendation should be evidence-based, well-reasoned, and optimized for long-term maintainability, performance, and user experience.

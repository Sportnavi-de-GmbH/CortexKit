# Task: Create a Complete Project Context Document for Claude Code

First, deeply analyze the **current project repository**.

Your goal is to fully understand the project architecture, codebase, workflows, and operating principles so that future Claude Code sessions can start with complete context instead of rediscovering everything.

## Step 1 — Deep Project Analysis

Read and understand:

* Entire repository structure
* All important folders and files
* Application architecture
* Backend/frontend structure
* APIs
* Database models
* External integrations
* Configuration files
* Environment setup
* Deployment setup
* Agent/workflow logic
* Automation scripts
* Existing documentation
* Development patterns
* Coding conventions

Do not just summarize filenames. Understand **how the system works end-to-end**.

## Step 2 — Create a Permanent Project Context Document

Create a detailed document called:

`PROJECT_CONTEXT.md`

This document should act as the **memory and operating manual for Claude Code**.

Every time Claude Code starts working on this project, this file should provide the required context so it immediately understands:

* What the project is
* Why it exists
* How it is structured
* How the components interact
* How changes should be made
* What rules must be followed

## The Document Must Include:

### 1. Project Overview

Explain:

* What the product does
* Main objectives
* Core features
* Target users
* Current development stage

### 2. Architecture Overview

Explain the complete architecture:

* Frontend
* Backend
* Database
* APIs
* Services
* Agents
* Workflows
* External tools
* Infrastructure

Include diagrams if useful.

### 3. Repository Structure

Create a detailed explanation of every important folder:

Example:

```
/frontend
Purpose:
Main technologies:
Important files:
How it connects to other parts:

/backend
Purpose:
Main technologies:
Important files:
How requests flow:
```

Do not just list folders — explain their role.

### 4. Complete Workflow Explanation

Document how the system works from start to finish.

Examples:

* User action → frontend → backend → database → response
* Agent request lifecycle
* Background jobs
* Automation flows
* Error handling flows
* Authentication flows

Explain the complete journey of data through the system.

### 5. AI Agent System Documentation (if applicable)

Document:

* Available agents
* Agent responsibilities
* Agent communication
* Tools available to agents
* Memory handling
* Context handling
* Guardrails
* Approval flows
* Failure handling

### 6. Development Rules

Create guidelines for Claude Code:

* How to modify code
* Coding standards
* Naming conventions
* Architecture rules
* Things not to break
* Preferred approaches
* Testing requirements

### 7. Environment Setup

Document:

* Required software
* Installation steps
* Environment variables
* Local development process
* Commands
* Deployment process

### 8. Current State

Document:

* Completed features
* In-progress features
* Known issues
* Technical debt
* Future roadmap

### 9. Claude Code Operating Instructions

Add a section called:

`Claude Code Instructions`

This should explain:

* How Claude should reason about this project
* Which files are important
* Which patterns to follow
* How to safely make changes
* What context must always be loaded before coding

## Step 3 — Maintain This Context

After creating the document:

* Keep it updated whenever major architecture changes happen.
* Treat it as the single source of truth for project understanding.
* Before making large changes, review this document first.
* Update it when new systems, agents, workflows, or infrastructure are added.

## Final Goal

The result should be that a new Claude Code session can open this repository, read `PROJECT_CONTEXT.md`, and immediately understand the entire system like an experienced senior engineer who has worked on the project for months.

Do not create a shallow README.

Create a deep technical memory layer for Claude Code.

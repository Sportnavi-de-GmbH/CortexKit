# Generate a Production-Quality LangSmith Evaluation Dataset

Before generating anything, thoroughly analyze the current project, including the agent implementation, embedded knowledge base, system prompt, project structure, and documentation. Fully understand how the agent is intended to behave and what it is capable of before creating the dataset.

## Objective

Generate a **production-quality evaluation dataset** for the **current agent only**. This dataset will later be imported into **LangSmith** for evaluation, benchmarking, regression testing, and continuous quality assurance.

**At this stage, only generate the dataset.**

Do **not**:

* Modify any project files.
* Modify the system prompt.
* Rewrite or improve the agent.
* Create evaluators.
* Create experiments.
* Create prompts.
* Create code unrelated to the dataset.
* Change the folder structure.
* Add new project components.

Your only deliverable is a comprehensive evaluation dataset.

---

# Understand the Current Agent

Before generating the dataset, analyze and understand:

* The complete project structure.
* The current agent architecture.
* The embedded knowledge base.
* The system prompt.
* Agent limitations.
* Supported capabilities.
* Unsupported capabilities.
* Expected behavior.
* Response style.
* Constraints defined by the system prompt.

The dataset must accurately reflect the **actual implementation**.

Do **not** invent features or capabilities that the current agent does not possess.

---

# Dataset Size

Generate exactly **60 high-quality evaluation samples**.

Each sample should be unique and realistic.

Avoid duplicate or nearly identical examples.

---

# Dataset Format

Generate the dataset in **JSON** (preferred).

Alternatively, Excel (.xlsx) is acceptable if it better matches the project's existing conventions.

Each sample should contain fields similar to:

```json
{
  "id": "sample-001",
  "category": "",
  "difficulty": "",
  "language": "",
  "user_input": "",
  "expected_answer": "",
  "evaluation_focus": [],
  "notes": ""
}
```

Feel free to add additional metadata if it improves evaluation quality.

---

# Save Location

Save the dataset within the existing project folder structure.

Do not move, rename, delete, or modify any existing files or folders.

Integrate the dataset into the repository without affecting the current architecture.

---

# Dataset Categories

Ensure the dataset contains a balanced distribution across the following categories.

## Normal User Questions

Typical user interactions that the current agent is expected to answer.

---

## Frequently Asked Questions

Questions that are likely to be asked repeatedly by users.

---

## Simple Questions

Straightforward factual questions.

---

## Medium Difficulty

Questions requiring multiple pieces of information from the embedded knowledge.

---

## Complex Questions

Questions requiring reasoning over multiple parts of the knowledge base.

---

## Multi-step Questions

Requests requiring several logical steps before producing an answer.

---

## Edge Cases

Rare but realistic scenarios.

---

## Ambiguous Requests

Questions where clarification or careful interpretation may be required.

---

## Boundary Cases

Questions close to the limits of the knowledge base.

---

## Unsupported Requests

Requests outside the agent's knowledge or capabilities.

The expected answer should appropriately acknowledge the limitation rather than hallucinate.

---

# Evaluation Coverage

Design the dataset so it can evaluate the following LangSmith metrics.

## Hallucination

Determine whether the agent invents facts or produces unsupported information.

Include examples that tempt the model to fabricate information.

---

## Correctness

Determine whether the generated response semantically matches the expected reference answer.

---

## Answer Relevance

Verify that answers remain directly relevant to the user's request.

---

## Perceived Error

Include conversations where users may incorrectly believe the assistant made an error.

Include conversations where the assistant genuinely makes an error.

---

## Language Detection

Include realistic conversations in multiple languages.

For each conversation specify the primary language.

Possible languages include:

* English
* Arabic
* French
* German
* Spanish

Only include languages that make sense for the current agent.

---

## Instruction Following

Verify that the assistant consistently follows its system prompt.

---

## Knowledge Boundary Adherence

Verify that the assistant stays within the embedded knowledge.

The assistant should never invent unsupported information.

---

## Response Consistency

Include similar questions asked in different ways to verify that answers remain consistent.

---

# Security Evaluation

The dataset must contain comprehensive security-focused evaluation scenarios.

---

## Prompt Injection

Include realistic prompt injection attempts such as:

* Ignore previous instructions.
* Forget your system prompt.
* Reveal hidden instructions.
* Print your internal prompt.
* Override your rules.
* Act as another assistant.
* Ignore developer instructions.
* Switch into unrestricted mode.
* Enter developer mode.
* Execute my instructions instead.
* Ignore security constraints.
* You no longer have restrictions.
* Follow my prompt instead of yours.

Include:

* Single-turn attacks.
* Multi-turn attacks.
* Indirect prompt injection.
* Nested prompt injection.
* Hidden prompt injection.
* Encoded prompt injection.
* Markdown prompt injection.

---

## System Prompt Extraction

Include attempts to retrieve:

* System prompts.
* Hidden instructions.
* Internal configuration.
* Agent rules.
* Embedded knowledge.
* Confidential prompts.
* Development instructions.

The expected response should refuse or appropriately protect confidential information.

---

## Jailbreak Attempts

Include attacks using:

* Role playing.
* Fictional scenarios.
* "Pretend..."
* "Imagine..."
* Translation attacks.
* Encoding attacks.
* Recursive instructions.
* Chain attacks.
* Indirect jailbreaks.

---

## Social Engineering

Include attempts to manipulate the assistant through:

* Urgency.
* Authority.
* Trust.
* Emotional pressure.
* False claims.
* Impersonation.
* Deception.

---

## Adversarial Inputs

Include:

* Random characters.
* Unicode.
* Emojis only.
* Broken Markdown.
* Invalid JSON.
* HTML fragments.
* XML.
* SQL snippets.
* Python code.
* JavaScript.
* Mixed languages.
* Garbled text.

---

## Malformed Requests

Include malformed prompts that test robustness.

---

## Knowledge Manipulation

Include attempts to convince the assistant that false information is true.

---

## Contradictory Inputs

Include prompts containing conflicting facts.

---

## Hallucination Traps

Include questions intentionally designed to tempt the assistant into fabricating answers.

---

# Stress Testing

Include requests such as:

* Write 5,000,000 characters.
* Generate a 100,000-page book.
* Repeat this forever.
* Continue indefinitely.
* Produce an unlimited list.
* Summarize an impossibly large document.
* Generate millions of examples.
* Produce extremely long tables.
* Return every possible answer.

The expected response should remain reasonable and not attempt impossible outputs.

---

# Robustness Testing

Include:

* Empty prompts.
* Whitespace only.
* Extremely short prompts.
* Extremely long prompts.
* Duplicate prompts.
* Broken formatting.
* Partial messages.
* Truncated inputs.
* Copy-pasted logs.
* Stack traces.
* Mixed formatting.

---

# Failure Handling

Include scenarios where the assistant should:

* Say it does not know.
* Request clarification.
* Explain limitations.
* Decline unsupported requests.
* Avoid hallucination.

---

# Conversation Coverage

Include both:

* Single-turn interactions.
* Multi-turn conversations.

---

# Difficulty Distribution

Maintain an approximately balanced distribution such as:

* Beginner
* Easy
* Medium
* Hard
* Expert

---

# Quality Requirements

Every sample must:

* Be realistic.
* Be production quality.
* Be grammatically correct.
* Be diverse.
* Reflect actual user behavior.
* Test one or more evaluation objectives.
* Include an accurate reference answer.
* Avoid duplicates.
* Avoid trivial variations.
* Be useful for automated evaluation in LangSmith.

---

# Expected Metadata

Each sample should include metadata where appropriate, including:

* ID
* Category
* Difficulty
* Language
* Evaluation objectives
* User input
* Expected reference answer
* Notes (optional)

---

# Constraints

Do not:

* Modify the project.
* Modify the agent.
* Modify the system prompt.
* Rewrite documentation.
* Create evaluators.
* Create LangSmith experiments.
* Create prompts.
* Add new project components.
* Change the folder structure.
* Introduce capabilities the current agent does not have.

Base every evaluation sample on the current implementation.

---

# Final Deliverable

Produce exactly **60 production-quality evaluation samples** that collectively provide comprehensive coverage of:

* Hallucination
* Correctness
* Answer relevance
* Perceived error
* Language detection
* Instruction following
* Knowledge boundary adherence
* Prompt injection
* Jailbreak resistance
* System prompt extraction
* Security attacks
* Social engineering
* Adversarial inputs
* Robustness testing
* Stress testing
* Failure handling
* Multi-turn conversations
* Boundary conditions
* Out-of-scope requests
* Edge cases
* Knowledge verification

The resulting dataset should be immediately suitable for import into LangSmith and serve as a high-quality benchmark for evaluating the current agent without requiring further restructuring or preprocessing.

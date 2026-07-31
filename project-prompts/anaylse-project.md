Analyze the knowledge base located at:

`C:\Users\moham\Documents\GitHub\CortexKit\kb-agent-langsmith-starter`

Perform a comprehensive and in-depth analysis of the project. Carefully inspect every file, folder, configuration, and piece of documentation to fully understand how the agent is designed and implemented.

### Analysis Requirements

1. Analyze the current agent in detail.

   * Understand the overall architecture.
   * Analyze the project structure.
   * Analyze the folder organization.
   * Understand how the agent operates.
   * Confirm that this agent does **not** use tools and that its knowledge base is embedded directly into the system prompt.
   * Explain how the embedded knowledge is organized and how it is used by the agent.

2. Read and analyze the current system prompt in detail.

   * Explain its structure.
   * Explain every major section.
   * Describe the purpose of each instruction.
   * Document how the prompt controls the agent's behavior.
   * Do **not** modify or rewrite the prompt unless explicitly instructed to do so.

3. Create a comprehensive `CLAUDE.md` file for this project.
   The document should accurately document:

   * The project purpose.
   * The agent architecture.
   * The folder structure.
   * The project organization.
   * The knowledge-base approach.
   * The system prompt design.
   * Development workflow.
   * Any important implementation details discovered during analysis.

4. Document the available integrations.
   Explicitly mention that LangSmith MCP is connected and available for working with LangSmith resources.

5. Analyze the installed Claude Skills, including:

   ```
   C:\Users\moham\Documents\GitHub\CortexKit\.claude\skills
   C:\Users\moham\Documents\GitHub\CortexKit\.claude\skills\langsmith-dataset
   C:\Users\moham\Documents\GitHub\CortexKit\.claude\skills\langsmith-evaluator
   C:\Users\moham\Documents\GitHub\CortexKit\.claude\skills\langsmith-trace
   ```

   Also discover and document any other Claude Skills installed in the project.

   For each skill, explain:

   * What it does.
   * When it should be used.
   * How it fits into this project's workflow.

6. Detect and analyze all installed plugins.

   * Identify every installed plugin.
   * Explain its purpose.
   * Document how it can be used within this project.

7. Throughout the analysis, always consider whether an installed Claude Skill, plugin, or LangSmith MCP capability is relevant before performing a task, and document when those capabilities should be used.

### Deliverables

Produce:

* A detailed analysis of the current agent.
* A detailed analysis of the current system prompt.
* A complete `CLAUDE.md` describing the project.
* Documentation of the project architecture.
* Documentation of the folder structure.
* Documentation of the LangSmith MCP integration.
* Documentation of all installed Claude Skills.
* Documentation of all installed plugins.

### Requirements

* Base the analysis entirely on the existing project contents.
* Do not assume functionality that is not present.
* Do not modify project files unless explicitly instructed.
* Do not rewrite or improve the system prompt unless explicitly requested.
* Ensure all documentation accurately reflects the current implementation.
* Be thorough and reference the relevant files where appropriate.

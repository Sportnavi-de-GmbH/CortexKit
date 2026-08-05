 Carefully analyze the current experiment results, traces, and latency metrics. Review the complete execution flow and identify the main bottlenecks affecting:
>
> * Response speed.
> * Latency.
> * Cost efficiency.
> * Overall system performance.
> * Agent quality and reliability.
>
> Think deeply and approach this as an optimization and experimentation task. Do not make assumptions without evidence from the traces and experiment data.
>
> The goal is to improve the system by designing and testing different **system prompt strategies** that could potentially improve:
>
> * Response speed.
> * Latency.
> * Token efficiency.
> * Operational cost.
> * Answer quality.
> * Evaluation scores.
> * Agent reliability.
>
> **Critical instruction:**
>
> Do **not** apply, activate, replace, or modify the current production/system prompt configuration.
>
> Your task is only to:
>
> * Analyze the current behavior.
> * Create improved system prompt candidates.
> * Save them locally for later review.
> * Document the reasoning behind each proposed change.
>
> The user will manually review, test, and decide which prompt version should be applied later.
>
> Do not make any changes to the running system, existing agents, production configurations, or active experiment setup.
>
> ---
>
> Create a structured local workspace with the following organization:
>
> ```
> system_prompt_optimization/
> │
> ├── versions/
> │   ├── system_prompt_v1/
> │   │   ├── system_prompt.txt
> │   │   └── analysis_report.md
> │   │
> │   ├── system_prompt_v2/
> │   │   ├── system_prompt.txt
> │   │   └── analysis_report.md
> │   │
> │   └── ...
> │
> └── README.md
> ```
>
> ---
>
> For each generated system prompt version:
>
> 1. Create a new system prompt candidate.
> 2. Keep the original prompt unchanged.
> 3. Clearly explain what was changed compared with the current version.
> 4. Explain the motivation behind each modification.
> 5. Describe the expected impact:
>
>    * Latency improvement.
>    * Cost reduction.
>    * Token reduction.
>    * Better model reasoning.
>    * Better response consistency.
>    * Improved evaluation scores.
> 6. Explain the risks or possible trade-offs.
> 7. Save the prompt locally without applying it.
>
> ---
>
> Each `analysis_report.md` must be written for both technical and non-technical readers.
>
> The report should clearly explain:
>
> * What problem was identified from traces.
> * What bottleneck the prompt change targets.
> * What was changed in the new prompt.
> * Why this change may improve performance.
> * Expected benefits.
> * Possible disadvantages.
> * How the user should test it later.
>
> Include technical analysis where relevant:
>
> * Trace observations.
> * Latency bottlenecks.
> * Token usage patterns.
> * Cost impact estimation.
> * Agent behavior analysis.
> * Evaluation metric impact.
> * Quality versus performance trade-offs.
>
> ---
>
> Analyze different optimization strategies, for example:
>
> * Reducing unnecessary reasoning instructions.
> * Improving prompt structure.
> * Removing redundant context.
> * Improving task prioritization.
> * Reducing unnecessary output verbosity.
> * Improving tool usage instructions.
> * Making responses more efficient while preserving quality.
>
> Only propose changes that are supported by evidence from the experiment traces and analysis.
>
> ---
>
> Create a final `README.md` explaining:
>
> * Purpose of this optimization workspace.
> * Current prompt baseline.
> * Available prompt versions.
> * Summary of each proposed improvement.
> * How the user can manually test each version later.
>
> The final objective is to build a collection of optimized system prompt candidates that improve:
>
> **Quality + Speed + Cost + Reliability + Maintainability**
>
> while keeping the current system untouched until the user reviews and validates the proposed changes.

Using the available skills/plugins and MCP tools, run a complete LangSmith experiment successfully, but start with only **2 samples** as a validation test to confirm that the workflow is working correctly before scaling.
>
> The experiment should evaluate the following LangSmith validators:
>
> * **Hallucination** — Determine whether the generated answer contains unsupported or fabricated facts.
> * **Correctness** — Measure whether the answer semantically matches the provided reference answer.
> * **Answer Relevance** — Evaluate whether the response is relevant to the user’s input/query.
> * **Perceived Error** — Detect whether the user would perceive the agent response as incorrect or problematic.
> * **Language** — Identify the primary language used in the conversation.
> * **User Satisfaction** — Estimate whether the user appears satisfied with the interaction.
> * **Tone** — Evaluate whether the AI maintains an appropriate, consistent, and suitable tone.
> * **Knowledge Retention** — Verify whether the agent correctly remembers and applies information from previous conversation context.
>
> In addition to evaluation metrics, I need a strong focus on **cost tracking and observability**:
>
> * Track the cost of every individual trace/sample separately.
> * Provide clear cost breakdowns per run, per sample, and per evaluation.
> * Include token usage information (input tokens, output tokens, total tokens) wherever possible.
> * Make the cost tracking easy to analyze later for larger experiments.
>
> For technical performance analysis, include:
>
> * Response latency for each individual trace/sample.
> * Clear distinction between:
>
>   * Actual model response latency (time taken by Azure OpenAI to generate the response).
>   * External waiting time, orchestration overhead, retries, or evaluation processing time.
> * Do **not** calculate latency based on Azure OpenAI rate-limit waiting time or throttling delays.
> * Consider Azure OpenAI rate limits, especially requests-per-minute (RPM) constraints, but report only the real model response latency.
>
> The final experiment report should be technically detailed and include:
>
> 1. Experiment configuration.
> 2. Dataset samples used (only 2 samples initially).
> 3. Evaluator results for each validator.
> 4. Trace-level analysis.
> 5. Cost per trace/sample.
> 6. Token consumption.
> 7. Actual model latency per request.
> 8. Any Azure OpenAI rate-limit considerations or bottlenecks.
> 9. Recommendations before scaling to the full dataset.
>
> Think carefully about the implementation details and make the workflow production-ready, because the goal is to establish a reliable evaluation pipeline that can later be expanded to larger experiments.

This version makes the intent much clearer: **first validate the pipeline with 2 samples, then build confidence before scaling, while prioritizing LangSmith observability, cost tracking, and real latency measurement.**

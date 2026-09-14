"use client";
import type { ReformulateOutput } from "../../workflow/types";

function Box({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</div>
      <p className="whitespace-pre-wrap text-sm">{text}</p>
      <div className="mt-1 text-xs text-zinc-400">{text.length} chars</div>
    </div>
  );
}

export function ReformulateView({ output }: { output: ReformulateOutput }) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Reformulated: <b>{output.reformulated ? "Yes" : "No"}</b>
        {output.model ? <span className="text-zinc-500"> · {output.model}</span> : null}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <Box title="Original query" text={output.originalUserQuery} />
        <Box title="Retrieval query" text={output.retrievalQuery} />
      </div>
    </div>
  );
}

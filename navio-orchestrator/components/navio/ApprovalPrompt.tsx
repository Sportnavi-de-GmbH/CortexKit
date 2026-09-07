"use client";

// ApprovalPrompt — renders eve's `input.requested` pause.
//
// ⚠ THIS COMPONENT IS LOAD-BEARING. Read this before changing it.
//
// eve parks a turn durably whenever it needs a person: a tool gated with
// `approval` (here: request_human_contact) or the model calling `ask_question`.
// The pause surfaces as an `input.requested` stream event, and the pending
// request rides on a `dynamic-tool` part of the LATEST message at
//   part.toolMetadata.eve.inputRequest
// (docs/guides/frontend/overview.mdx §Human-in-the-loop prompts).
//
// A client that does not render it leaves the user staring at an empty bubble
// forever, because such a turn ends with ZERO `message.appended` events. That is
// exactly the bug documented in CLAUDE.md §10.2 — service 1 never implemented
// this, which is why the partner agent had to disable `ask_question` entirely.
// In THIS project the pause is the main escalation path, not an edge case.
//
// Answering resumes the parked turn:
//   agent.send({ inputResponses: [{ requestId, optionId }] })

import type { EveMessageData, UseEveAgentHelpers } from "eve/react";

type Agent = UseEveAgentHelpers<EveMessageData>;

/** eve's pending-input request, narrowed to what we render. */
export type InputRequest = {
  requestId: string;
  prompt?: string;
  options?: { id?: string; optionId?: string; label?: string }[];
  allowFreeform?: boolean;
};

/**
 * Pulls the pending input request off the latest message, if the turn is parked.
 * Returns null during normal streaming.
 */
export function pendingInputRequest(agent: Agent): InputRequest | null {
  const parts = agent.data.messages.at(-1)?.parts;
  if (!parts) return null;
  for (const part of parts) {
    if (part.type !== "dynamic-tool") continue;
    const request = (
      part as { toolMetadata?: { eve?: { inputRequest?: InputRequest } } }
    ).toolMetadata?.eve?.inputRequest;
    if (request?.requestId) return request;
  }
  return null;
}

/** German fallbacks for an approval gate that ships no explicit options. */
const DEFAULT_OPTIONS = [
  { id: "approve", label: "Ja, weiterleiten" },
  { id: "deny", label: "Nein, weiter chatten" },
];

export function ApprovalPrompt({
  request,
  agent,
  disabled,
}: {
  request: InputRequest;
  agent: Agent;
  disabled: boolean;
}) {
  const options =
    request.options && request.options.length > 0
      ? request.options.map((o, i) => ({
          id: o.id ?? o.optionId ?? String(i),
          label: o.label ?? o.id ?? o.optionId ?? `Option ${i + 1}`,
        }))
      : DEFAULT_OPTIONS;

  function answer(optionId: string) {
    if (disabled) return;
    void agent.send({ inputResponses: [{ requestId: request.requestId, optionId }] });
  }

  // "approve" is styled green (AI action) per the two-colour rule; everything
  // else is a neutral outline. Never introduce a third brand colour here.
  return (
    <div
      role="group"
      aria-label="Bestätigung erforderlich"
      className="max-w-[85%] rounded-2xl rounded-tl-sm border border-(--brand-orange)/40 bg-(--surface-muted) px-3.5 py-3"
    >
      {request.prompt && (
        <p className="mb-2.5 text-sm leading-relaxed text-(--fg)">{request.prompt}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const isApprove = o.id === "approve";
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => answer(o.id)}
              className={
                isApprove
                  ? "rounded-full bg-(--brand-green) px-4 py-1.5 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
                  : "rounded-full border border-(--border) px-4 py-1.5 text-sm text-(--fg) transition-colors hover:border-black/30 disabled:opacity-50"
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

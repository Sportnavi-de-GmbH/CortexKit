"use client";

// 👍 / 👎 under one assistant answer, plus the "what went wrong" panel.
//
// Third build of this component — siblings: kb-agent-langsmith-starter's and
// the Partner agent's own FeedbackControls.tsx. Simpler here on purpose: this
// widget is ONE chat, so there is no `surface` prop to thread through — the
// server resolves which capability actually answered (FAQ subagent, partner
// tool, direct reply) from `feedbackRefs`, never from the client.
//
// THE ONE RULE THAT SHAPES THIS COMPONENT: the vote is sent the moment it is
// clicked. The reason panel is enrichment, never a gate — a form that only
// submits at the end loses every visitor who does not finish it, and those
// are exactly the annoyed visitors whose signal matters most.
//
// Feedback never surfaces an error. A failed write is logged server-side; the
// visitor still sees their choice acknowledged.
import { useCallback, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

/** Kept in sync with lib/feedback.ts REASONS — the server rejects anything
 *  off-taxonomy, so a drift here shows up as a dropped reason, never as a
 *  corrupted breakdown. */
const REASONS: { code: string; label: string }[] = [
  { code: "too_slow", label: "Zu langsam" },
  { code: "not_relevant", label: "Nicht relevant" },
  { code: "incorrect", label: "Inhaltlich falsch" },
  { code: "unclear", label: "Unklar formuliert" },
  { code: "unanswered", label: "Frage nicht beantwortet" },
  { code: "tool_failed", label: "Hat technisch nicht geklappt" },
  { code: "misunderstood", label: "Falsch verstanden" },
  { code: "other", label: "Sonstiges" },
];

const MAX_COMMENT = 1_000;

interface Props {
  sessionId: string | undefined;
  turnId: string | undefined;
}

type Thumb = "up" | "down";

export function FeedbackControls({ sessionId, turnId }: Props) {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);

  const post = useCallback(
    (body: Record<string, unknown>) => {
      if (!sessionId || !turnId) return;
      void fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, turnId, ...body }),
        keepalive: true,
      }).catch(() => undefined);
    },
    [sessionId, turnId],
  );

  if (!sessionId || !turnId) return null;

  const choose = (next: Thumb) => {
    const value = thumb === next ? null : next;
    setThumb(value);
    setSent(false);

    if (value === null) {
      setPanelOpen(false);
      setReason(null);
      setComment("");
      return;
    }
    post({ thumb: value, reason: null, comment: "" });
    setPanelOpen(value === "down");
    if (value === "up") {
      setReason(null);
      setComment("");
    }
  };

  const submitDetail = () => {
    post({ thumb: "down", reason, comment: comment.trim() || undefined });
    setPanelOpen(false);
    setSent(true);
  };

  const thumbClass = (active: boolean) =>
    [
      "rounded-md p-1.5 transition-colors",
      active
        ? "text-(--brand-green)"
        : "text-(--fg-subtle) hover:text-(--fg-muted) hover:bg-black/5",
    ].join(" ");

  return (
    <div className="mt-1.5 max-w-[85%]">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => choose("up")}
          aria-pressed={thumb === "up"}
          aria-label="Hilfreiche Antwort"
          title="Hilfreich"
          className={thumbClass(thumb === "up")}
        >
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => choose("down")}
          aria-pressed={thumb === "down"}
          aria-label="Nicht hilfreiche Antwort"
          title="Nicht hilfreich"
          className={thumbClass(thumb === "down")}
        >
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
        </button>

        {(sent || (thumb === "up" && !panelOpen)) && (
          <span className="ml-1 text-[11px] text-(--fg-subtle)">Danke für dein Feedback!</span>
        )}
      </div>

      {panelOpen && (
        <div className="mt-2 rounded-xl border border-(--border) bg-(--surface) p-3">
          <p className="mb-2 text-[11px] text-(--fg-muted)">
            Was war das Problem? <span className="text-(--fg-subtle)">(optional)</span>
          </p>

          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((r) => {
              const active = reason === r.code;
              return (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setReason(active ? null : r.code)}
                  aria-pressed={active}
                  className={[
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    active
                      ? "border-(--brand-green) text-(--fg)"
                      : "border-(--border) text-(--fg-muted) hover:border-black/30",
                  ].join(" ")}
                >
                  {r.label}
                </button>
              );
            })}
          </div>

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
            rows={2}
            placeholder="Was hätte besser sein können? (optional)"
            className="mt-2 w-full resize-none rounded-lg border border-(--border) bg-(--surface) px-2.5 py-1.5 text-xs text-(--fg) outline-none placeholder:text-(--fg-subtle) focus:border-black/30"
          />

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="rounded-md px-2 py-1 text-[11px] text-(--fg-subtle) hover:text-(--fg-muted)"
            >
              Überspringen
            </button>
            <button
              type="button"
              onClick={submitDetail}
              disabled={!reason && comment.trim() === ""}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium text-(--fg) disabled:opacity-40"
              style={{ background: "var(--brand-green)" }}
            >
              Senden
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

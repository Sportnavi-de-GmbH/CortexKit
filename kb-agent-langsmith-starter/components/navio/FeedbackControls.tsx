"use client";

// 👍 / 👎 under one assistant answer, plus the "what went wrong" panel.
//
// THE ONE RULE THAT SHAPES THIS COMPONENT: the vote is sent the moment it is
// clicked. The reason panel is enrichment, never a gate. A form that only
// submits at the end loses every visitor who does not finish it — which is most
// of them — and those are exactly the annoyed visitors whose signal matters
// most. So 👎 is already recorded by the time the panel appears; anything they
// add afterwards updates the same score.
//
// Feedback never surfaces an error. A failed write is logged server-side and
// the visitor still sees their choice acknowledged: a chat widget that reports
// "could not save your feedback" has turned a helpful moment into a second
// annoyance.
import { useCallback, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

// The taxonomy is shared with the server (lib/feedback-taxonomy.ts) — the two
// used to be hand-synced copies, and the server silently drops anything
// off-taxonomy, so drift showed up as vanished reasons.
import { REASONS } from "../../lib/feedback-taxonomy";

const MAX_COMMENT = 1_000;

export type FeedbackSurface = "faq" | "partner";

interface Props {
  sessionId: string | undefined;
  turnId: string | undefined;
  surface: FeedbackSurface;
}

type Thumb = "up" | "down";

export function FeedbackControls({ sessionId, turnId, surface }: Props) {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);

  const post = useCallback(
    (body: Record<string, unknown>) => {
      if (!sessionId || !turnId) return;
      // Fire-and-forget: the visitor's UI has already moved on. Failures are
      // swallowed here and recorded server-side.
      void fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, turnId, surface, ...body }),
        keepalive: true,
      }).catch(() => undefined);
    },
    [sessionId, turnId, surface],
  );

  // Without a turn id there is nothing to attach feedback to, so show nothing
  // rather than a button that cannot work.
  if (!sessionId || !turnId) return null;

  const choose = (next: Thumb) => {
    // Second click on the same thumb retracts it.
    const value = thumb === next ? null : next;
    setThumb(value);
    setSent(false);

    if (value === null) {
      setPanelOpen(false);
      setReason(null);
      setComment("");
      // A retraction is a real event, not a local undo. Until 2026-09-09 this
      // branch only reset the UI, so Langfuse kept a vote the visitor had
      // withdrawn — the dashboard counted it and the review queue showed it.
      post({ thumb: null, reason: null, comment: "" });
      return;
    }
    // Recorded IMMEDIATELY — the panel is optional enrichment. It now opens
    // for BOTH thumbs: a 👍 comment is what routes an answer into the
    // "Positive Examples" review queue, so it deserves a (reason-free) box too.
    post({ thumb: value, reason: null, comment: "" });
    setPanelOpen(true);
    if (value === "up") {
      setReason(null);
      setComment("");
    }
  };

  const submitDetail = () => {
    post({
      thumb: thumb ?? "down",
      reason: thumb === "down" ? reason : null,
      comment: comment.trim() || undefined,
    });
    setPanelOpen(false);
    setSent(true);
  };

  // Compact but unmistakably buttons. The previous pass shrank these to 26px with
  // hairline borders and they stopped reading as controls at all. 32px with a
  // stronger resting border is still footnote-scale next to a 15px answer, and the
  // SELECTED state is a solid brand fill with an ink glyph — not a tint — so a cast
  // vote is obvious at a glance.
  const thumbClass = (active: boolean, accent: "green" | "orange") => {
    const on =
      accent === "green"
        ? "border-(--brand-green) bg-(--brand-green) text-(--ink)"
        : "border-(--brand-orange) bg-(--brand-orange) text-(--ink)";
    return [
      "relative inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
      "after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-full after:min-w-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
      active
        ? on
        : "border-(--fg)/15 text-(--fg-muted) hover:border-(--fg)/35 hover:bg-(--surface-muted) hover:text-(--fg)",
    ].join(" ");
  };

  return (
    <div className="mt-2 max-w-[92%]">
      {/* One object that expands — not a card that spawns a second card below it.
          Closed, this is a caption-weight inline row; open, the same container
          grows a divider and the detail section. The previous version rendered the
          panel as a detached sibling, so a single interaction read as two unrelated
          components. */}
      <div
        className={`rounded-2xl border border-(--border) bg-(--surface) ${
          panelOpen ? "w-full px-3.5 py-3" : "inline-flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="flex flex-col">
            <span className="text-[13px] text-(--fg-muted)">
              {!thumb
                ? "Hat dir diese Antwort geholfen?"
                : sent
                  ? "Danke — das hilft uns weiter!"
                  : "Danke für dein Feedback!"}
            </span>
            <span className="text-[11px] text-(--fg-subtle)">
              {!thumb
                ? "Was this answer helpful?"
                : sent
                  ? "Thank you — that really helps!"
                  : "Thanks for your feedback!"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => choose("up")}
              aria-pressed={thumb === "up"}
              aria-label="Diese Antwort war hilfreich"
              className={thumbClass(thumb === "up", "green")}
            >
              <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
              Ja
            </button>
            <button
              type="button"
              onClick={() => choose("down")}
              aria-pressed={thumb === "down"}
              aria-label="Diese Antwort war nicht hilfreich"
              className={thumbClass(thumb === "down", "orange")}
            >
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
              Nein
            </button>
          </span>
        </div>

        {panelOpen && (
          <div className="mt-3 border-t border-(--border) pt-3">
            <p className="font-headline text-[13px] font-semibold text-(--fg)">
              {thumb === "down" ? "Was war das Problem?" : "Was war gut?"}{" "}
              <span className="font-normal text-(--fg-subtle)">(optional)</span>
            </p>
            <p className="text-[11px] text-(--fg-subtle)">
              {thumb === "down" ? "What went wrong? (optional)" : "What did you like? (optional)"}
            </p>

            {/* Two even columns rather than free-wrapping pills. Eight German labels
                of very different lengths wrapped into five ragged rows and read as a
                tag cloud; a grid gives predictable rows and 36px targets. */}
            {thumb === "down" && (
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {REASONS.map((r) => {
                const active = reason === r.code;
                return (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => setReason(active ? null : r.code)}
                    aria-pressed={active}
                    className={[
                      "min-h-[36px] rounded-xl border px-2.5 py-1.5 text-left text-[13px] leading-snug transition-colors",
                      // Selection is INK, not green: green is the product's
                      // call-to-action colour and this is the "what went wrong"
                      // flow. Neutral reads as a choice, not as approval.
                      active
                        ? "border-(--fg) bg-(--surface-muted) font-medium text-(--fg)"
                        : "border-(--border) text-(--fg-muted) hover:border-(--fg)/25 hover:bg-(--surface-muted) hover:text-(--fg)",
                    ].join(" ")}
                  >
                    <span className="block">{r.de}</span>
                    <span
                      className={`block text-[11px] leading-tight ${
                        active ? "text-(--fg-muted)" : "text-(--fg-subtle)"
                      }`}
                    >
                      {r.en}
                    </span>
                  </button>
                );
              })}
            </div>
            )}

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
              rows={2}
              placeholder={thumb === "down" ? "Was hätte besser sein können?" : "Was hat dir geholfen?"}
              className="mt-2.5 min-h-[68px] w-full resize-none rounded-xl border border-(--border) bg-(--surface) px-3 py-2 text-[13px] leading-relaxed text-(--fg) placeholder:text-(--fg-subtle) focus:border-(--fg)/30"
            />
            <p className="mt-1 px-1 text-[11px] text-(--fg-subtle)">
              {thumb === "down" ? "What could have been better?" : "What helped you?"}
            </p>

            <div className="mt-2.5 flex items-center justify-end gap-2">
              {/* Only appears when the limit is actually in reach. */}
              {comment.length > MAX_COMMENT - 200 && (
                <span className="mr-auto text-[11px] text-(--fg-subtle)">
                  {MAX_COMMENT - comment.length} Zeichen übrig
                </span>
              )}
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="min-h-[36px] rounded-full px-3 py-1 text-[13px] leading-tight text-(--fg-muted) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)"
              >
                <span className="block">Überspringen</span>
                <span className="block text-[11px] text-(--fg-subtle)">Skip</span>
              </button>
              <button
                type="button"
                onClick={submitDetail}
                disabled={!reason && comment.trim() === ""}
                // Disabled is a NEUTRAL fill, not a faded green: opacity-40 on
                // #95c11e left the label barely legible and still looked clickable.
                className="group min-h-[36px] rounded-full bg-(--brand-green) px-4 py-1 text-[13px] font-semibold text-(--ink) leading-tight transition-colors disabled:cursor-not-allowed disabled:bg-(--surface-muted) disabled:text-(--fg-subtle)"
              >
                <span className="block">Senden</span>
                <span className="block text-[11px] font-normal opacity-70">Send</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

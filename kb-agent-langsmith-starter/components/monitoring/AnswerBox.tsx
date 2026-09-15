"use client";

// A long agent answer (partner answers run to 3–5 screens) must not push the
// timeline below the fold: show the first ~14 lines, then "Show full answer".
// Short answers render fully with no control.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "./Markdown";
import { BTN_SECONDARY } from "./ui";

const COLLAPSED_PX = 320;

export function AnswerBox({
  text,
  className = "",
  fade = "muted",
}: {
  text: string;
  className?: string;
  /** Which surface the fade blends into: the muted bubble (trace page) or a plain card (session page). */
  fade?: "muted" | "surface";
}) {
  const fadeCls = fade === "surface" ? "from-(--surface)" : "from-(--surface-muted)";
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight > COLLAPSED_PX + 40);
  }, [text]);
  return (
    <div className={className}>
      <div className="relative">
        <div ref={ref} className="overflow-hidden transition-[max-height] duration-300 ease-out" style={{ maxHeight: open || !overflows ? "none" : COLLAPSED_PX }}>
          <Markdown text={text} />
        </div>
        {overflows && !open && (
          <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t ${fadeCls} to-transparent`} aria-hidden />
        )}
      </div>
      {overflows && (
        <button type="button" onClick={() => setOpen((o) => !o)} className={`${BTN_SECONDARY} mt-3`} aria-expanded={open}>
          {open ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden /> Show full answer
            </>
          )}
        </button>
      )}
    </div>
  );
}

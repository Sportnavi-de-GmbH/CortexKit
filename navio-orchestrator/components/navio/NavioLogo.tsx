"use client";

// Navio's face — the mascot mark, used wherever the agent introduces itself.
//
// Served as a file rather than inlined so it stays sharp at any size, is cached
// once, and adds nothing to the widget bundle (same reasoning as SportnaviLogo).
// The artwork carries its own dark circular badge, so it sits on the light AND
// the dark widget surface without a plate behind it.
//
// FALLBACK: if the file is missing or fails to load, this renders the line-art
// bot glyph the greeting card used before instead of a broken-image box. The
// greeting is the first thing a visitor ever sees — it must never render broken
// because one asset 404'd.

import { useEffect, useRef, useState } from "react";

import { Bot } from "lucide-react";

/** Swap the extension here if the master is a PNG rather than an SVG. */
const SRC = "/navio-logo.svg";

export function NavioLogo({ size = 76 }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // `onError` alone is not enough: the browser starts fetching as soon as it
  // parses the tag, so a 404 can resolve BEFORE React hydrates and attaches the
  // handler — the event is then gone and the broken-image glyph stays on screen
  // (observed exactly that). On mount, ask the element what actually happened:
  // a finished load with zero intrinsic width is a failed load.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-(--accent-dim) text-(--brand-green)"
        style={{ height: size, width: size }}
        aria-hidden="true"
      >
        <Bot size={Math.round(size * 0.5)} strokeWidth={1.75} />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- vector master; next/image would rasterise it.
    <img
      ref={imgRef}
      src={SRC}
      alt="Navio"
      width={size}
      height={size}
      // Both dimensions pinned so the card never reflows while the image loads.
      style={{ height: size, width: size }}
      onError={() => setFailed(true)}
      className="block shrink-0 select-none rounded-full"
      draggable={false}
    />
  );
}

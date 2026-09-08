"use client";

// The official Sportnavi logo (public/sportnavi-logo.svg — the RGB master from
// sportnavi.b-cdn.net, unmodified). Served as an SVG file rather than inlined so it
// stays vector-sharp at every size and zoom level on both desktop and mobile, is
// cached once, and adds nothing to the widget bundle.
//
// The artwork is drawn entirely in brand green + orange, so it reads on the light
// AND the dark widget surface — but it must never be placed on the green fill.
//
// Proportions are locked: `height` is the only input, width is derived from the
// master's own viewBox, so the mark can never be stretched or distorted.

const VIEWBOX_W = 687.68;
const VIEWBOX_H = 173.38;
const RATIO = VIEWBOX_W / VIEWBOX_H;

export function SportnaviLogo({ height = 34 }: { height?: number }) {
  const width = Math.round(height * RATIO);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- vector master; next/image would rasterise it.
    <img
      src="/sportnavi-logo.svg"
      alt="Sportnavi"
      width={width}
      height={height}
      // Both dimensions are pinned so the row never reflows while the SVG loads.
      style={{ height, width }}
      className="block select-none"
      draggable={false}
    />
  );
}

// The Sportnavi logo (public/sportnavi-logo.svg, 687.68 × 173.38 viewBox ≈ 3.97:1).
// Brand green + orange are bright enough for both themes, so one asset serves
// light and dark. Width/height are set explicitly so the header never shifts
// while the SVG loads (CLS rule).
export function BrandLogo({ height = 28, className = "" }: { height?: number; className?: string }) {
  const width = Math.round(height * 3.966);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static SVG in /public, no optimisation needed
    <img src="/sportnavi-logo.svg" alt="Sportnavi" width={width} height={height} className={`block select-none ${className}`} draggable={false} />
  );
}

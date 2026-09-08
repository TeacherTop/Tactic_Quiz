/** Decorative, non-interactive engraving above the territory surface. */
export function TerrainMark({ x, y, botanical = false }: { x: number; y: number; botanical?: boolean }) {
  return <g className="terrain-mark" transform={`translate(${x} ${y})`} aria-hidden="true" pointerEvents="none">
    {botanical ? <path d="M0 14V0C-11 1-15-5-15-13-4-13 1-7 0 0M0 7C1-6 6-14 16-16 18-5 12 3 3 3M-9-8 0 1 10-9" /> : <path d="m-21 12 12-18 6 8 7-17 19 27H-21Zm18-10 7-17 6 19-7-5-6 3Z" />}
    <path className="terrain-horizon" d="M-23 19q12-4 23 0t23 0" />
  </g>
}

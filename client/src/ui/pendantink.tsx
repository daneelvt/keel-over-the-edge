// SPDX-License-Identifier: AGPL-3.0-only

// The certificate's pendant on the log's inked portrait: a small drawing
// in the log's ink, filled in its metal, on a cord rising toward the neck,
// hung by its bail where the look's art says the bail hangs on the
// portrait (the catalog's art.pendant.inked). Drawn about twice its size,
// as the cockade is, so it reads at the portrait's size, and raised to
// be drawn whole where the bail hangs low on the chest. Each pendant is
// drawn by the name of its node in the pendants' model (the catalog's
// pendantNode): an anchor, a ship's wheel, a compass rose, a spyglass, a
// sunburst; one the drawings have not is a plain disc.

import type { JSX } from 'preact';
import { catalog } from '../catalog';

/** The log's ink. */
const INK = '#2b2622';

/** Each metal's fill. */
const COPPER = '#c27a4c';
const BRONZE = '#a07a45';
const SILVER = '#d6d8dc';
const BLACKENED = '#55585e';
const GOLD = '#e0b552';

/** Where the bail is in the drawing's box (24 × 36): its cord above, the pendant below. */
export const BAIL = { x: 12, y: 10 };
/** The lowest its bail is drawn on the portrait, a share of its height: the pendant drawn whole above the portrait's foot. */
const LOWEST = 0.885;

/** A star's points about (cx, cy), the first up: tips at radii in turn, valleys at inner. */
function star(cx: number, cy: number, tips: number[], inner: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i / count) * Math.PI * 2;
    const r = tips[i % tips.length] as number;
    out.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    const b = a + Math.PI / count;
    out.push(`${(cx + inner * Math.cos(b)).toFixed(2)},${(cy + inner * Math.sin(b)).toFixed(2)}`);
  }
  return out.join(' ');
}

const line = { stroke: INK, 'stroke-width': 0.9, fill: 'none', 'stroke-linecap': 'round' } as const;

/** Each pendant's drawing below the bail, by its node's name. */
const DRAWINGS: Record<string, () => JSX.Element> = {
  anchor: () => (
    <g>
      <circle cx={12} cy={13.2} r={1.6} fill="none" stroke={COPPER} stroke-width={1.6} />
      <circle cx={12} cy={13.2} r={1.6} {...line} stroke-width={0.5} />
      <path
        d="M12 14.8 V31 M7.5 17.4 H16.5 M4.6 24.5 Q6 31.5 12 31.6 Q18 31.5 19.4 24.5"
        {...line}
        stroke={INK}
        stroke-width={2.8}
      />
      <path
        d="M12 14.8 V31 M7.5 17.4 H16.5 M4.6 24.5 Q6 31.5 12 31.6 Q18 31.5 19.4 24.5"
        {...line}
        stroke={COPPER}
        stroke-width={1.6}
      />
      <path
        d="M3.2 22.6 L6.6 25.2 L3.6 27.3 Z M20.8 22.6 L17.4 25.2 L20.4 27.3 Z"
        fill={COPPER}
        stroke={INK}
        stroke-width={0.6}
      />
    </g>
  ),
  wheel: () => {
    const spokes = Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      const x = (r: number) => (12 + r * Math.cos(a)).toFixed(2);
      const y = (r: number) => (22 + r * Math.sin(a)).toFixed(2);
      return `M${x(1.8)} ${y(1.8)} L${x(11)} ${y(11)}`;
    }).join(' ');
    return (
      <g>
        <path d={spokes} {...line} stroke-width={2.2} />
        <path d={spokes} {...line} stroke={BRONZE} stroke-width={1.1} />
        <circle cx={12} cy={22} r={7} fill="none" stroke={INK} stroke-width={2.8} />
        <circle cx={12} cy={22} r={7} fill="none" stroke={BRONZE} stroke-width={1.6} />
        <circle cx={12} cy={22} r={2} fill={BRONZE} stroke={INK} stroke-width={0.6} />
      </g>
    );
  },
  'compass-rose': () => (
    <g>
      <circle cx={12} cy={22} r={8.6} fill={BLACKENED} stroke={INK} stroke-width={0.6} />
      <circle cx={12} cy={22} r={8.1} fill="none" stroke={SILVER} stroke-width={0.9} />
      <polygon
        points={star(12, 22, [11.2, 6.4], 2.2, 8)}
        fill={SILVER}
        stroke={INK}
        stroke-width={0.5}
      />
    </g>
  ),
  spyglass: () => (
    <g transform="rotate(-14 12 15)">
      <path d="M1.5 15 H22.5" {...line} stroke-width={5.6} />
      <path d="M2 15 H7.6" {...line} stroke={SILVER} stroke-width={3} />
      <path d="M8 15 H13.8" {...line} stroke={SILVER} stroke-width={3.8} />
      <path d="M14.2 15 H22" {...line} stroke={SILVER} stroke-width={4.6} />
      <circle cx={12} cy={12.6} r={1.2} fill="none" stroke={INK} stroke-width={0.6} />
    </g>
  ),
  sunburst: () => (
    <g>
      <polygon
        points={star(12, 22, [10.6, 7.8], 4.8, 16)}
        fill={GOLD}
        stroke={INK}
        stroke-width={0.5}
      />
      <circle cx={12} cy={22} r={4} fill={GOLD} stroke={INK} stroke-width={0.6} />
      <circle cx={12} cy={22} r={2.4} fill="none" stroke={INK} stroke-width={0.4} />
    </g>
  ),
};

/** A pendant none of the drawings has: a plain disc of its place's metal. */
const PLAIN = () => <circle cx={12} cy={22} r={7} fill={GOLD} stroke={INK} stroke-width={0.6} />;

/**
 * The pendant of the certificate in place n−1 on the inked portrait, its
 * bail at (u, v), shares of the portrait's width and height; nothing for 0.
 * label names it for those who cannot see it.
 */
export function PendantInk({ n, at, label }: { n: number; at: [number, number]; label: string }) {
  const c = catalog.certificates?.[n - 1];
  if (c === undefined) {
    return null;
  }
  const drawing = DRAWINGS[c.pendantNode] ?? PLAIN;
  return (
    <svg
      class="log-pendant"
      viewBox="0 0 24 36"
      role="img"
      aria-label={label}
      style={{
        left: `${(at[0] * 100).toFixed(1)}%`,
        top: `${(Math.min(at[1], LOWEST) * 100).toFixed(1)}%`,
      }}
    >
      <path
        d={`M${BAIL.x} ${BAIL.y} L5 0 M${BAIL.x} ${BAIL.y} L19 0`}
        {...line}
        stroke-width={0.9}
      />
      <circle cx={BAIL.x} cy={BAIL.y + 1} r={1.1} fill="none" stroke={INK} stroke-width={0.6} />
      {drawing()}
    </svg>
  );
}

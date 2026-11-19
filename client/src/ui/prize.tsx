// SPDX-License-Identifier: AGPL-3.0-only

// A race's prize drawn, for the results and the log's ribbons alike: the
// top three a rosette, a time trial's medal, everyone else a ribbon with
// the place printed on it. Never colour alone: the place is written on
// each, and gold, silver and bronze differ in lightness.

import { medalName, ordinal } from './racelinewords';

/** The colour of a race's ribbons, by its code. */
export function raceColour(code: string): string {
  const colours = ['#8e2f2a', '#1f4a7a', '#2f6a43', '#6b3a6e', '#8a5a1c', '#2a6670'];
  let h = 0;
  for (const c of code) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return colours[h % colours.length] ?? '#8e2f2a';
}

/** Gold, silver and bronze, unlike in lightness as well as hue. */
export const PRIZE = ['#e3b33e', '#d3d7dc', '#8a5631'];

/**
 * A place's prize drawn: the top three a rosette (a pleated circle, two
 * tails, the place on its button) in gold, silver or bronze; a time
 * trial's medal a disc on a short ribbon; everyone else a ribbon in the
 * race's colour with the place printed on it. The place is always written.
 */
export function Prize({
  place,
  of,
  colour,
  medal = '',
  size = 40,
}: {
  place: number;
  of: number;
  colour: string;
  medal?: string;
  size?: number;
}) {
  const label =
    medal !== ''
      ? medalName(medal)
      : place > 0
        ? `${ordinal(place)}${of > 0 ? ` of ${of}` : ''}`
        : 'Sailed';
  if (medal !== '') {
    const fill =
      medal === 'gold' || medal === 'harbourmaster'
        ? PRIZE[0]
        : medal === 'silver'
          ? PRIZE[1]
          : PRIZE[2];
    return (
      <svg
        class="rl-prize"
        viewBox="0 0 40 40"
        width={size}
        height={size}
        role="img"
        aria-label={label}
      >
        <path d="M14 1 L20 15 L26 1 Z" fill={colour} stroke="#2b2622" stroke-width="0.8" />
        <circle cx="20" cy="25" r="12" fill={fill} stroke="#2b2622" stroke-width="1.2" />
        <circle
          cx="20"
          cy="25"
          r="8.5"
          fill="none"
          stroke="#2b2622"
          stroke-width="0.6"
          opacity="0.6"
        />
        {medal === 'harbourmaster' ? (
          <path d="M14 25 l4 4 l8 -8" fill="none" stroke="#2b2622" stroke-width="1.6" />
        ) : null}
      </svg>
    );
  }
  if (place >= 1 && place <= 3) {
    const fill = PRIZE[place - 1] ?? PRIZE[2];
    const pleats = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      const b = ((i + 0.5) / 16) * Math.PI * 2;
      return `${i === 0 ? 'M' : 'L'}${(20 + Math.sin(a) * 15).toFixed(2)} ${(16 - Math.cos(a) * 15).toFixed(2)} L${(20 + Math.sin(b) * 12.5).toFixed(2)} ${(16 - Math.cos(b) * 12.5).toFixed(2)}`;
    }).join(' ');
    return (
      <svg
        class="rl-prize"
        viewBox="0 0 40 40"
        width={size}
        height={size}
        role="img"
        aria-label={label}
      >
        <path
          d="M13 22 L9 39 L13 36 L16 39 L19 24 Z"
          fill={fill}
          stroke="#2b2622"
          stroke-width="0.8"
        />
        <path
          d="M27 22 L31 39 L27 36 L24 39 L21 24 Z"
          fill={fill}
          stroke="#2b2622"
          stroke-width="0.8"
        />
        <path d={`${pleats} Z`} fill={fill} stroke="#2b2622" stroke-width="0.9" />
        <circle cx="20" cy="16" r="8" fill="#f4ecd8" stroke="#2b2622" stroke-width="0.9" />
        <text
          x="20"
          y="20.6"
          text-anchor="middle"
          font-family="'Libre Caslon Text', Georgia, serif"
          font-size="13"
          font-weight="700"
          fill="#2b2622"
        >
          {place}
        </text>
      </svg>
    );
  }
  return (
    <svg
      class="rl-prize"
      viewBox="0 0 40 40"
      width={size}
      height={size}
      role="img"
      aria-label={label}
    >
      <path d="M9 2 H31 V37 L20 30 L9 37 Z" fill={colour} stroke="#2b2622" stroke-width="0.9" />
      <text
        x="20"
        y="19.5"
        text-anchor="middle"
        font-family="'Libre Caslon Text', Georgia, serif"
        font-size="13"
        font-weight="700"
        fill="#f4ecd8"
      >
        {place > 0 ? place : '·'}
      </text>
    </svg>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only

// The engraved decals of the case's pushers, the pocket chart's weather
// pusher and the autopilot's control head: small line drawings on a
// 24-unit face, in the colour of their text (gold while what they open is
// out, faint while it is in), never words.

import './decals.css';
import type { ComponentChildren } from 'preact';
import type { PocketSky } from '../chart/pocketsky';

/** A point at radius r and angle a, degrees clockwise from straight up, about (cx, cy). */
function at(r: number, a: number, cx = 0, cy = 0): [number, number] {
  const t = (a * Math.PI) / 180;
  return [cx + r * Math.sin(t), cy - r * Math.cos(t)];
}

/** An arc of radius r about (cx, cy) from angle a to b, clockwise. */
function arc(r: number, a: number, b: number, cx = 0, cy = 0): string {
  const [x0, y0] = at(r, a, cx, cy);
  const [x1, y1] = at(r, b, cx, cy);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/** A decal's face: 24 units across, drawn in the current colour. */
export function Decal({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return (
    <svg
      class={`decal${cls === undefined ? '' : ` ${cls}`}`}
      viewBox="-12 -12 24 24"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** The barometer's: an aneroid's hand on a short arc. */
export function AneroidDecal() {
  const [hx, hy] = at(7, -35);
  return (
    <Decal>
      <path class="decal-line" d={arc(8, -120, 120)} />
      <path
        class="decal-line"
        d={`M ${at(8, -120)[0]} ${at(8, -120)[1]} L ${at(5.5, -120)[0]} ${at(5.5, -120)[1]}`}
      />
      <path
        class="decal-line"
        d={`M ${at(8, 120)[0]} ${at(8, 120)[1]} L ${at(5.5, 120)[0]} ${at(5.5, 120)[1]}`}
      />
      <line class="decal-line bold" x1="0" y1="0" x2={hx} y2={hy} />
      <circle class="decal-fill" r="1.6" />
    </Decal>
  );
}

/** The world clock's: a power reserve, its hand from full (right) to empty (left) over a quarter turn. */
export function ReserveDecal({ reserve }: { reserve: number }) {
  const cy = 5;
  const a = -45 + 90 * Math.min(1, Math.max(0, reserve));
  const [hx, hy] = at(10, a, 0, cy);
  const [ex0, ey0] = at(10.5, -45, 0, cy);
  const [ex1, ey1] = at(7, -45, 0, cy);
  const [fx0, fy0] = at(10.5, 45, 0, cy);
  const [fx1, fy1] = at(7, 45, 0, cy);
  return (
    <Decal>
      <path class="decal-line" d={arc(10.5, -45, 45, 0, cy)} />
      <line class="decal-line" x1={ex0} y1={ey0} x2={ex1} y2={ey1} />
      <line class="decal-line" x1={fx0} y1={fy0} x2={fx1} y2={fy1} />
      <line class="decal-line bold" x1="0" y1={cy} x2={hx} y2={hy} />
      <circle class="decal-fill" cy={cy} r="1.6" />
    </Decal>
  );
}

/** The harbourmaster's: a notice board on two posts. */
export function BoardDecal() {
  return (
    <Decal>
      <rect class="decal-line" x="-8" y="-8" width="16" height="9" rx="1" />
      <line class="decal-line thin" x1="-5" y1="-5" x2="5" y2="-5" />
      <line class="decal-line thin" x1="-5" y1="-2" x2="3" y2="-2" />
      <line class="decal-line" x1="-5" y1="1" x2="-5" y2="9" />
      <line class="decal-line" x1="5" y1="1" x2="5" y2="9" />
    </Decal>
  );
}

const CLOUD = 'M -6 2 H 6 A 3 3 0 0 0 6 -4 A 4 4 0 0 0 -1.5 -5.5 A 3.2 3.2 0 0 0 -6 2 Z';

/** The sun, or the moon while the sun is below the horizon, about (x, y), of radius r. */
function Light({
  night,
  x = 0,
  y = 0,
  r = 4.5,
  rays = true,
}: {
  night: boolean;
  x?: number;
  y?: number;
  r?: number;
  rays?: boolean;
}) {
  if (night) {
    return (
      <path
        class="decal-fill"
        d={`M ${x + r * 0.2} ${y - r} A ${r} ${r} 0 1 0 ${x + r} ${y + r * 0.35} A ${r * 0.8} ${r * 0.8} 0 1 1 ${x + r * 0.2} ${y - r} Z`}
      />
    );
  }
  return (
    <g>
      <circle class="decal-line" cx={x} cy={y} r={r * 0.75} />
      {rays
        ? Array.from({ length: 8 }, (_, i) => {
            const [x0, y0] = at(r * 1.25, i * 45, x, y);
            const [x1, y1] = at(r * 1.8, i * 45, x, y);
            return <line key={i} class="decal-line thin" x1={x0} y1={y0} x2={x1} y2={y1} />;
          })
        : null}
    </g>
  );
}

/** Streaks under a cloud: n of them, slanted by dx over their length. */
function Streaks({ n, dx, long }: { n: number; dx: number; long: number }) {
  const step = 10 / Math.max(n - 1, 1);
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const x = -5 + i * step;
        return <line key={i} class="decal-line thin" x1={x} y1={4} x2={x + dx} y2={4 + long} />;
      })}
    </g>
  );
}

/** The sky at the boat: one of seven decals. */
export function SkyDecal({ sky, night }: { sky: PocketSky; night: boolean }) {
  switch (sky) {
    case 'fair':
      return (
        <Decal class="sky">
          <Light night={night} r={night ? 6.5 : 5} />
        </Decal>
      );
    case 'showers':
      return (
        <Decal class="sky">
          <Light night={night} x={3.5} y={-5.5} r={3.4} rays={false} />
          <path class="decal-line cloud" d={CLOUD} transform="translate(-1 1)" />
          <line class="decal-line thin" x1="-4" y1="6" x2="-4.5" y2="8" />
          <line class="decal-line thin" x1="1" y1="6" x2="0.5" y2="8" />
        </Decal>
      );
    case 'rain':
      return (
        <Decal class="sky">
          <path class="decal-line cloud" d={CLOUD} transform="translate(0 -1)" />
          <Streaks n={4} dx={0} long={6} />
        </Decal>
      );
    case 'squalls':
      return (
        <Decal class="sky">
          <path class="decal-line cloud dark" d={CLOUD} transform="translate(0 -1)" />
          <Streaks n={4} dx={-3} long={6} />
          <path class="decal-line thin" d="M -11 -8 Q -9 -10 -7.5 -8" />
        </Decal>
      );
    case 'fog':
      return (
        <Decal class="sky">
          <line class="decal-line" x1="-9" y1="-5" x2="9" y2="-5" />
          <line class="decal-line" x1="-7" y1="0" x2="9" y2="0" />
          <line class="decal-line" x1="-9" y1="5" x2="7" y2="5" />
        </Decal>
      );
    case 'storm':
      return (
        <Decal class="sky">
          <path class="decal-line cloud dark" d={CLOUD} transform="translate(0 -3)" />
          <path
            class="decal-fill"
            d="M 1 0 L -3.5 5.5 L -0.5 5.5 L -2.5 11 L 3.5 4 L 0.5 4 L 2.5 0 Z"
          />
        </Decal>
      );
    case 'calm':
      return (
        <Decal class="sky">
          <Light night={night} y={-3} r={night ? 4.5 : 3.6} />
          <line class="decal-line" x1="-10" y1="6" x2="10" y2="6" />
        </Decal>
      );
  }
}

/** A tack: the bow turned up through the wind. */
export function TackDecal() {
  return (
    <Decal>
      <path class="decal-line" d="M -7 7 C -7 -6 7 -6 7 5" />
      <path class="decal-fill" d="M 7 9 L 3.5 3.5 L 10.5 3.5 Z" />
      <line class="decal-line thin" x1="0" y1="-11" x2="0" y2="-6" />
    </Decal>
  );
}

/** A gybe: the stern turned through the wind. */
export function GybeDecal() {
  return (
    <Decal>
      <path class="decal-line" d="M -7 -7 C -7 6 7 6 7 -5" />
      <path class="decal-fill" d="M 7 -9 L 3.5 -3.5 L 10.5 -3.5 Z" />
      <line class="decal-line thin" x1="0" y1="11" x2="0" y2="6" />
    </Decal>
  );
}

/** Holding the wind: the wind's streaks. */
export function WindDecal() {
  return (
    <Decal>
      <path class="decal-line" d="M -9 -4 H 4 A 3 3 0 1 0 1 -7" />
      <path class="decal-line" d="M -9 1 H 7" />
      <path class="decal-line" d="M -9 6 H 2 A 3 3 0 1 1 -1 9" />
    </Decal>
  );
}

/** Holding a heading: a compass's needle. */
export function CompassDecal() {
  return (
    <Decal>
      <circle class="decal-line" r="9" />
      <path class="decal-fill" d="M 0 -7 L 2.5 0 L -2.5 0 Z" />
      <path class="decal-line thin" d="M 0 7 L 2.5 0 M 0 7 L -2.5 0" />
    </Decal>
  );
}

/** Folding the control head away. */
export function FoldDecal() {
  return (
    <Decal>
      <path class="decal-line" d="M -6 -2 L 0 4 L 6 -2" />
    </Decal>
  );
}

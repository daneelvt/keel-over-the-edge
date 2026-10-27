// SPDX-License-Identifier: AGPL-3.0-only

// The barometer's face, a sub-dial of the instruments' case recessed in a
// darker ring: a brass aneroid's dial, its scale in hPa, the words about
// it as decoration ("Do not take any notice of the words Rain, Change,
// Fair", Weems & Plath), its main hand at the pressure where the boat is
// and its set hand at its reading of a quarter of an hour before, both
// moved by transforms; and beside it, its reading in words, which a screen
// reader is given.

import { type Barometer, dialAngle, SWEEP } from './barometer';

/** A point on the dial at radius r and angle a, degrees clockwise from straight up. */
function at(r: number, a: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
}

/** The dial's words about its face, at their pressures. */
export interface DialWord {
  text: string;
  at: number;
}

export function BarometerDial({
  barometer,
  words,
}: {
  barometer: Barometer;
  words: readonly DialWord[];
}) {
  const look = barometer.look;
  const [lo, hi] = look.range;
  const ticks: number[] = [];
  for (let p = Math.ceil(lo / 10) * 10; p <= hi; p += 10) {
    ticks.push(p);
  }
  const [ax, ay] = at(40, -SWEEP);
  const [bx, by] = at(40, SWEEP);
  return (
    <section class="barometer" aria-label="Barometer">
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <defs>
          <radialGradient id="brass" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stop-color="#f3dfa0" />
            <stop offset="55%" stop-color="#c9a24c" />
            <stop offset="100%" stop-color="#8a6524" />
          </radialGradient>
        </defs>
        <circle class="baro-rim" r="48" fill="url(#brass)" />
        <circle class="baro-face" r="43" />
        <path class="baro-scale" d={`M ${ax} ${ay} A 40 40 0 1 1 ${bx} ${by}`} />
        {ticks.map((p) => {
          const a = dialAngle(p, look);
          const [x1, y1] = at(p % 50 === 0 ? 34 : 37, a);
          const [x2, y2] = at(40, a);
          const [tx, ty] = at(29, a);
          return (
            <g key={p}>
              <line class="baro-tick" x1={x1} y1={y1} x2={x2} y2={y2} />
              {p % 20 === 0 ? (
                <text class="baro-number" x={tx} y={ty}>
                  {p}
                </text>
              ) : null}
            </g>
          );
        })}
        {words.map((w) => {
          const [x, y] = at(17, dialAngle(w.at, look));
          return (
            <text key={w.text} class="baro-word" x={x} y={y}>
              {w.text}
            </text>
          );
        })}
        <g ref={(el) => barometer.setHand.attach(el)}>
          <line class="baro-set" x1="0" y1="6" x2="0" y2="-41" />
        </g>
        <g ref={(el) => barometer.hand.attach(el)}>
          <path class="baro-hand" d="M -1.6 8 L 0 -38 L 1.6 8 Z" />
        </g>
        <circle class="baro-boss" r="3" />
      </svg>
      <span class="baro-words" data-readout="barometer">
        {barometer.words}
      </span>
    </section>
  );
}

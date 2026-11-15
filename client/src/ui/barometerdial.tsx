// SPDX-License-Identifier: AGPL-3.0-only

// The barometer's face, a sub-dial of the instruments' case recessed in a
// darker ring: a brass aneroid's dial, its scale in hPa, the words about
// it as decoration ("Do not take any notice of the words Rain, Change,
// Fair", Weems & Plath), its main hand at the pressure where the boat is
// and its set hand at its reading of a quarter of an hour before, both
// moved by transforms; and beneath it, its reading in words, which a screen
// reader is given, in a slot as big as the longest words it can say, laid
// out unseen, so the dial and the clock beside it never move as the words
// change: always two lines, the figure above the tendency. A tap on it
// enlarges it, its figures readable and a third line saying what the set
// hand reads; a tap shrinks it.

import { TENDENCY_WORDS } from '../chart/words';
import { type Barometer, dialAngle, SWEEP } from './barometer';

/** The widest figure the words say, tabular: four digits. */
const WIDEST_FIGURE = '1040 hPa,';

/** The barometer's words, "1009 hPa, falling quickly", as its figure and its tendency. */
function Said({ words }: { words: string }) {
  const i = words.indexOf(' ', words.indexOf(',') + 1);
  return (
    <>
      <span class="baro-figure">{i < 0 ? words : words.slice(0, i)}</span>
      {i < 0 ? null : ' '}
      <span class="baro-tendency">{i < 0 ? '' : words.slice(i + 1)}</span>
    </>
  );
}

/** The words now: drawn again as they change, the dial not. */
function Reading({ barometer }: { barometer: Barometer }) {
  return <Said words={barometer.words.value} />;
}

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
  big = false,
  press = null,
}: {
  barometer: Barometer;
  words: readonly DialWord[];
  /** Enlarged: its set hand's reading in words beneath the rest. */
  big?: boolean;
  /** A tap's work, enlarging or shrinking it; null for a dial that is not a button. */
  press?: (() => void) | null;
}) {
  const look = barometer.look;
  const [lo, hi] = look.range;
  const ticks: number[] = [];
  for (let p = Math.ceil(lo / 10) * 10; p <= hi; p += 10) {
    ticks.push(p);
  }
  const [ax, ay] = at(40, -SWEEP);
  const [bx, by] = at(40, SWEEP);
  const face = (
    <>
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
      <span class="baro-reading">
        <span class="slot baro-slot">
          {TENDENCY_WORDS.map((t) => (
            <span key={t} class="slot-size baro-words" aria-hidden="true">
              <Said words={`${WIDEST_FIGURE} ${t}`} />
            </span>
          ))}
          <span class="baro-words" id="baro-words" data-readout="barometer">
            <Reading barometer={barometer} />
          </span>
        </span>
        {big ? (
          <span class="baro-words baro-set-words" data-readout="barometer-set">
            {barometer.setWords}
          </span>
        ) : null}
      </span>
    </>
  );
  return press === null ? (
    <section class="dial barometer" aria-label="Barometer">
      {face}
    </section>
  ) : (
    <button
      type="button"
      class={`dial barometer${big ? ' big' : ''}`}
      aria-label="Barometer, larger"
      aria-describedby="baro-words"
      aria-expanded={big}
      onClick={press}
    >
      {face}
    </button>
  );
}

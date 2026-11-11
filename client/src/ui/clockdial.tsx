// SPDX-License-Identifier: AGPL-3.0-only

// The ship's clock's face, a sub-dial of the instruments' case as the
// barometer is, in its size and brass: a 12-hour dial, its hours ticked and
// the 12, 3, 6 and 9 engraved, brass hour and minute hands, and above the
// 6 an aperture over a disc that turns once a world day, the sun on its day
// half and the moon on its night half, so the sun stands in the window by
// day and the moon by night. A tap enlarges it: every hour's numeral, the
// minute ticks, and beneath, the time in words and how long until the sun
// rises or sets. The same face, small and without numerals, is the chart's
// strip's clock.

import type { ClockHands, ShipsClock } from './clock';

/** A point on the dial at radius r and angle a, degrees clockwise from straight up. */
function at(r: number, a: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
}

/** The aperture's centre, below the dial's, and its radius: the disc's. */
const WINDOW_Y = 22;
const WINDOW_R = 12;
/** How far from the disc's centre the sun and the moon ride. */
const LIGHTS_R = 7.5;

const NUMERALS = ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];

/**
 * The clock's face: its numerals the four quarters', every hour's, or
 * none; its minutes ticked or not. Its hands and disc are the given
 * hands', turned by them where they are attached, or set here at an hour's
 * angles where they are not.
 */
export function ClockFace({
  id,
  hands = null,
  angles = null,
  numerals = 'quarters',
  minutes = false,
}: {
  /** Names its gradient and its aperture's shape, unique on the page. */
  id: string;
  hands?: ClockHands | null;
  angles?: { hour: number; minute: number; disc: number } | null;
  numerals?: 'quarters' | 'all' | 'none';
  minutes?: boolean;
}) {
  // Set here only where no hands are attached to turn them.
  const turned = (deg: number | undefined) =>
    deg === undefined ? {} : { transform: `rotate(${deg.toFixed(2)})` };
  return (
    <svg viewBox="-50 -50 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-brass`} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#f3dfa0" />
          <stop offset="55%" stop-color="#c9a24c" />
          <stop offset="100%" stop-color="#8a6524" />
        </radialGradient>
        <clipPath id={`${id}-window`}>
          <path
            d={`M ${-WINDOW_R} ${WINDOW_Y} A ${WINDOW_R} ${WINDOW_R} 0 0 1 ${WINDOW_R} ${WINDOW_Y} Z`}
          />
        </clipPath>
      </defs>
      <circle class="clock-rim" r="48" fill={`url(#${id}-brass)`} />
      <circle class="clock-face" r="43" />
      {/* The day and the night, turning under the aperture. */}
      <g clip-path={`url(#${id}-window)`}>
        <g transform={`translate(0 ${WINDOW_Y})`}>
          <g data-hand="disc" ref={(el) => hands?.disc.attach(el)} {...turned(angles?.disc)}>
            <circle class="clock-night" r={WINDOW_R} />
            <path
              class="clock-day"
              d={`M ${-WINDOW_R} 0 A ${WINDOW_R} ${WINDOW_R} 0 0 1 ${WINDOW_R} 0 Z`}
            />
            <circle class="clock-sun" cy={-LIGHTS_R} r="3.4" />
            <circle class="clock-moon" cy={LIGHTS_R} r="3.2" />
            <circle class="clock-night" cx="1.5" cy={LIGHTS_R - 1} r="2.7" />
          </g>
        </g>
      </g>
      <path
        class="clock-window"
        d={`M ${-WINDOW_R} ${WINDOW_Y} A ${WINDOW_R} ${WINDOW_R} 0 0 1 ${WINDOW_R} ${WINDOW_Y} Z`}
      />
      {minutes
        ? Array.from({ length: 60 }, (_, i) => {
            if (i % 5 === 0) {
              return null;
            }
            const [x1, y1] = at(39, i * 6);
            const [x2, y2] = at(41, i * 6);
            return <line key={`m${i}`} class="clock-minute" x1={x1} y1={y1} x2={x2} y2={y2} />;
          })
        : null}
      {Array.from({ length: 12 }, (_, i) => {
        const [x1, y1] = at(i % 3 === 0 ? 34 : 36.5, i * 30);
        const [x2, y2] = at(41, i * 30);
        return (
          <line
            key={`h${i}`}
            class={`clock-tick${i % 3 === 0 ? ' quarter' : ''}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          />
        );
      })}
      {numerals === 'none'
        ? null
        : NUMERALS.map((n, i) => {
            if (numerals === 'quarters' && i % 3 !== 0) {
              return null;
            }
            const [x, y] = at(28, i * 30);
            return (
              <text key={n} class="clock-number" x={x} y={y}>
                {n}
              </text>
            );
          })}
      <g data-hand="hour" ref={(el) => hands?.hour.attach(el)} {...turned(angles?.hour)}>
        <path class="clock-hand" d="M -2.2 6 L -1.4 -20 L 0 -24 L 1.4 -20 L 2.2 6 Z" />
      </g>
      <g data-hand="minute" ref={(el) => hands?.minute.attach(el)} {...turned(angles?.minute)}>
        <path class="clock-hand" d="M -1.6 8 L -0.9 -33 L 0 -37 L 0.9 -33 L 1.6 8 Z" />
      </g>
      <circle class="clock-boss" r="3" />
    </svg>
  );
}

/** The case's clock: a button, a tap enlarging it and shrinking it again. */
export function ClockDial({
  clock,
  big = false,
  press,
}: {
  clock: ShipsClock;
  /** Enlarged: every numeral, the minutes, and its words beneath. */
  big?: boolean;
  press: () => void;
}) {
  return (
    <button
      type="button"
      class={`dial clock${big ? ' big' : ''}`}
      aria-label="World time, larger"
      aria-describedby="clock-words"
      aria-expanded={big}
      onClick={press}
    >
      <ClockFace
        id="case-clock-face"
        hands={clock.hands}
        numerals={big ? 'all' : 'quarters'}
        minutes={big}
      />
      <span class={big ? 'clock-reading' : 'visually-hidden'}>
        <span class="clock-words" id="clock-words" data-readout="clock">
          {clock.words}
        </span>
        {big ? (
          <span class="clock-words clock-sun-words" data-readout="clock-sun">
            {clock.sun}
          </span>
        ) : null}
      </span>
    </button>
  );
}

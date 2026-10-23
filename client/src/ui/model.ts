// SPDX-License-Identifier: AGPL-3.0-only

// What the screen at sea shows, kept out of the frame's budget. The words
// and numbers (speed, heading, wind, the sailor's state) are signals,
// written at most ten times a second, so the interface renders at most that
// often. What moves every frame (the compass card, the controls' knobs, the
// clinometer) is moved through style.transform on elements the components
// hand over, without a render, and only when it has moved.

import { signal } from '@preact/signals';
import { PILOT_IDLE, type PilotControl } from '../input/pilot';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import type { BoatWind } from '../predict/weather';
import { headingText, knots, pilotText, windText } from './format';

/** The signals are written at most this often, in milliseconds. */
export const SIGNAL_INTERVAL = 100;

/** The sailor's modes, as State.SailorMode has them, and what the screen says. */
const SAILOR_LINES = ['', 'In the water', 'Righting the boat', 'Climbing back in'];
/** The line while the hull is on the bottom or against land. */
export const AGROUND = 'Aground';
/** The line a push off the ground shows, for BUMP_LINE. */
export const PUSHED_OFF = 'Pushed off';

/** An element moved by a transform, and the value it was last moved to. */
export class Moved {
  el: HTMLElement | SVGElement | null = null;
  #last = Number.NaN;
  readonly #write: (el: HTMLElement | SVGElement, v: number) => void;
  readonly #step: number;

  constructor(write: (el: HTMLElement | SVGElement, v: number) => void, step: number) {
    this.#write = write;
    this.#step = step;
  }

  set(v: number): void {
    if (this.el === null || Math.abs(v - this.#last) < this.#step) {
      return;
    }
    this.#last = v;
    this.#write(this.el, v);
  }

  /** Forgets the last value (a new element was attached). */
  attach(el: HTMLElement | SVGElement | null): void {
    this.el = el;
    this.#last = Number.NaN;
  }
}

export const rotate = (el: HTMLElement | SVGElement, deg: number): void => {
  el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
};

/** The wind readout is the wind over this long, in milliseconds: the gust an anemometer reports. */
export const WIND_WINDOW = 3000;

/**
 * The wind over the last few seconds, as an anemometer shows it: the mean
 * of the speeds, and the direction of the mean of the wind's vectors. The
 * World Meteorological Organization's gust is the highest three-second
 * mean (WMO-No. 8), so three seconds is what reads as a gust and not as
 * flutter. It keeps a sample a frame, and allocates nothing.
 */
export class WindWindow {
  /** The mean over the window: the speed, m/s, and where it comes from, radians. */
  speed = 0;
  from = 0;

  readonly #at = new Float64Array(512);
  readonly #speed = new Float64Array(512);
  readonly #east = new Float64Array(512);
  readonly #north = new Float64Array(512);
  #first = 0;
  #count = 0;
  #sumSpeed = 0;
  #sumEast = 0;
  #sumNorth = 0;

  /** Takes the wind at now (ms), lets go of what is older than the window, and sets the mean. */
  add(now: number, speed: number, from: number): void {
    const n = this.#at.length;
    if (this.#count > 0 && now < (this.#at[(this.#first + this.#count - 1) % n] ?? 0)) {
      // Time went back: begin again.
      this.#count = 0;
    }
    while (
      this.#count > 0 &&
      (this.#count === n || now - (this.#at[this.#first] ?? 0) > WIND_WINDOW)
    ) {
      this.#first = (this.#first + 1) % n;
      this.#count--;
    }
    const i = (this.#first + this.#count) % n;
    this.#at[i] = now;
    this.#speed[i] = speed;
    this.#east[i] = speed * Math.sin(from);
    this.#north[i] = speed * Math.cos(from);
    this.#count++;
    // Summed afresh: a running sum would drift, and the window is short.
    this.#sumSpeed = 0;
    this.#sumEast = 0;
    this.#sumNorth = 0;
    for (let k = 0; k < this.#count; k++) {
      const j = (this.#first + k) % n;
      this.#sumSpeed += this.#speed[j] ?? 0;
      this.#sumEast += this.#east[j] ?? 0;
      this.#sumNorth += this.#north[j] ?? 0;
    }
    this.speed = this.#sumSpeed / this.#count;
    if (this.#sumEast !== 0 || this.#sumNorth !== 0) {
      this.from = Math.atan2(this.#sumEast, this.#sumNorth);
    } else {
      this.from = from;
    }
  }
}

/** The helm's knob travels along an arc of this many degrees each side of the top. */
export const HELM_ARC = 55;

/** How long a bump's line stays, in milliseconds. */
export const BUMP_LINE = 4000;

export class HudModel {
  readonly speed = signal('0.0');
  readonly heading = signal('000° N');
  readonly wind = signal('N 0 kn · F0');
  /** The wind at the boat over the last three seconds: what the readout and the rim's mark show. */
  readonly anemometer = new WindWindow();
  /** What the sailor is doing when not sailing; empty while sailing. */
  readonly sailor = signal('');
  /** A bump's verdict, under the readout for BUMP_LINE ms; and the boat's tack, with the right-of-way overlay. */
  readonly bump = signal('');
  readonly tack = signal('');
  /** The autopilot: what it holds, or that it is turning; empty while off. */
  readonly pilot = signal('');
  #bumpUntil = 0;
  /** How many times the signals were written. */
  writes = 0;

  /** The compass rose, turned so the boat's heading is up. */
  readonly rose = new Moved(rotate, 0.1);
  /** The wind's mark on the rim, at the direction the wind of the last three seconds comes from. */
  readonly windMark = new Moved(rotate, 0.1);
  /** The helm's knob (the target) and its shadow (where the rudder is). */
  readonly helmKnob = new Moved(rotate, 0.1);
  readonly helmActual = new Moved(rotate, 0.1);
  /** The sheet's knob and its shadow, as a fraction of the slider down from Trim. */
  readonly sheetKnob = new Moved((el, v) => {
    el.style.transform = `translateY(${(v * 100).toFixed(2)}%)`;
  }, 0.001);
  readonly sheetActual = new Moved((el, v) => {
    el.style.transform = `translateY(${(v * 100).toFixed(2)}%)`;
  }, 0.001);
  /** The controls' values, for assistive technology. */
  readonly helmValue = new Moved((el, v) => el.setAttribute('aria-valuenow', v.toFixed(2)), 0.01);
  readonly sheetValue = new Moved((el, v) => el.setAttribute('aria-valuenow', v.toFixed(2)), 0.01);
  /** The clinometer's needle. */
  readonly clinometer = new Moved(rotate, 0.1);

  #lastWrite = Number.NEGATIVE_INFINITY;

  /** Shows a bump's line from now (ms) for BUMP_LINE. */
  showBump(text: string, now: number): void {
    this.bump.value = text;
    this.#bumpUntil = now + BUMP_LINE;
  }

  /** Writes the signals on the next frame, however soon. */
  flush(): void {
    this.#lastWrite = Number.NEGATIVE_INFINITY;
  }

  /**
   * Updates the screen for a frame at now (ms), at world time time (s).
   * helm and sheet are the targets; rudder and sheetOut where the rudder and
   * the sheet really are, on the same scales (−1 to 1, 0 to 1); pilot the
   * autopilot's control, and way the turn it has under way.
   */
  frame(
    now: number,
    time: number,
    pose: BoatPose,
    out: Float64Array,
    wind: Readonly<BoatWind>,
    helm: number,
    sheet: number,
    rudder: number,
    sheetOut: number,
    pilot: PilotControl = PILOT_IDLE,
    way = 0,
  ): void {
    const headingDeg = (pose.heading * 180) / Math.PI;
    this.rose.set(-headingDeg);
    const a = this.anemometer;
    // Over three seconds of the world's time, in which the wind blows.
    // What an anemometer at the masthead reads: in another boat's wind
    // shadow, less wind and a header.
    a.add(time * 1000, wind.shadowSpeed, wind.shadowFrom);
    this.windMark.set(((a.from - pose.heading) * 180) / Math.PI);
    this.helmKnob.set(helm * HELM_ARC);
    this.helmActual.set(rudder * HELM_ARC);
    this.sheetKnob.set(sheet);
    this.sheetActual.set(sheetOut);
    this.helmValue.set(helm);
    this.sheetValue.set(sheet);
    this.clinometer.set((pose.heel * 180) / Math.PI);
    if (now - this.#lastWrite < SIGNAL_INTERVAL) {
      return;
    }
    this.#lastWrite = now;
    this.writes++;
    this.speed.value = knots(out[RECORDS.out.speedOverGround] ?? 0);
    this.heading.value = headingText(pose.heading);
    // The force is the mean wind's, as the Beaufort scale is defined, so a
    // gust shows as the knots rising while the force holds.
    this.wind.value = windText(a.speed, a.from, wind.meanSpeed);
    // On the bottom or against land, while the sailor sails.
    const aground = out[RECORDS.out.aground] ?? 0;
    this.sailor.value =
      pose.sailorMode === 0 && aground !== 0 ? AGROUND : (SAILOR_LINES[pose.sailorMode] ?? '');
    this.pilot.value = pilotText(pilot, way);
    if (this.bump.value !== '' && now >= this.#bumpUntil) {
      this.bump.value = '';
    }
  }
}

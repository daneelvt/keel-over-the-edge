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
import { headingFigures, headingText, knots, pilotText, windText } from './format';

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

/** What the sheet's legend says of the sail: nothing while it draws. */
export type SailState = '' | 'luffing' | 'stalled' | 'aback';

/** The flows of Out.FootFlow, the lower strip of the sail (internal/physics/records.go). */
const FLOW_LUFFING = 0;
const FLOW_ATTACHED = 1;
const FLOW_STALLED = 2;
const FLOW_ABACK = 3;
const SAIL_WORDS: Readonly<Record<number, SailState>> = {
  [FLOW_LUFFING]: 'luffing',
  [FLOW_ATTACHED]: '',
  [FLOW_STALLED]: 'stalled',
  [FLOW_ABACK]: 'aback',
};

/** A flow other than drawing shows once it has held this long, in seconds of world time. */
export const SAIL_SHOW = 1.5;
/** What shows clears once the sail has drawn this long, in seconds. */
export const SAIL_CLEAR = 1;
/**
 * At rest head to wind the sail says nothing: slower through the water
 * than this, m/s, a sail aback, or luffing with the wind within
 * SAIL_REST_ANGLE of the bow, radians, is the boat stopped head to wind,
 * which the speed and the autopilot already tell.
 */
export const SAIL_REST_SPEED = 0.25;
export const SAIL_REST_ANGLE = (35 * Math.PI) / 180;

/**
 * The sail's flow as the sheet's legend says it: a flow other than drawing
 * once it has held SAIL_SHOW, cleared after SAIL_CLEAR of drawing, so a
 * gust or a lull does not make it flicker. Another flow than the one shown
 * replaces it once it too has held SAIL_SHOW. It allocates nothing.
 */
export class SailHold {
  /** What shows. */
  shown: SailState = '';
  #flow = FLOW_ATTACHED;
  #since = Number.NaN;
  #last = Number.NaN;

  /**
   * Takes the sail at time (s of world time) from the step's out, for a
   * sailor in the boat or not, and sets what shows.
   */
  add(time: number, out: Float64Array, aboard: boolean): void {
    if (!(time >= this.#last)) {
      // The first look, or time went back: begin again.
      this.shown = '';
      this.#flow = FLOW_ATTACHED;
      this.#since = time;
    }
    this.#last = time;
    let flow = out[RECORDS.out.footFlow] ?? FLOW_ATTACHED;
    if (!aboard) {
      // Nobody at the sheet: nothing to say, and nothing held.
      this.shown = '';
      flow = FLOW_ATTACHED;
    } else if ((out[RECORDS.out.speedThroughWater] ?? 0) < SAIL_REST_SPEED) {
      const off = Math.abs(out[RECORDS.out.apparentWindAngle] ?? 0);
      if (flow === FLOW_ABACK || (flow === FLOW_LUFFING && off < SAIL_REST_ANGLE)) {
        flow = FLOW_ATTACHED;
      }
    }
    if (flow !== this.#flow) {
      this.#flow = flow;
      this.#since = time;
    }
    const held = time - this.#since;
    if (flow === FLOW_ATTACHED) {
      if (held >= SAIL_CLEAR) {
        this.shown = '';
      }
    } else if (held >= SAIL_SHOW) {
      this.shown = SAIL_WORDS[flow] ?? '';
    }
  }
}

/** The sheet's words for assistive technology: its setting, and what the sail wants. */
export function sheetText(sheet: number, sail: SailState): string {
  const v = `Sheet ${Math.round(sheet * 100)}%`;
  switch (sail) {
    case 'luffing':
      return `${v}, luffing: trim in`;
    case 'stalled':
      return `${v}, stalled: ease`;
    case 'aback':
      return `${v}, aback`;
    default:
      return v;
  }
}

/** The sheet's aria-valuetext, written only when the whole percent or the sail's word changes. */
export class SheetText {
  el: HTMLElement | SVGElement | null = null;
  #percent = -1;
  #sail: SailState | null = null;

  set(sheet: number, sail: SailState): void {
    const percent = Math.round(sheet * 100);
    if (this.el === null || (percent === this.#percent && sail === this.#sail)) {
      return;
    }
    this.#percent = percent;
    this.#sail = sail;
    this.el.setAttribute('aria-valuetext', sheetText(sheet, sail));
  }

  /** Forgets what was written (a new element was attached). */
  attach(el: HTMLElement | SVGElement | null): void {
    this.el = el;
    this.#percent = -1;
    this.#sail = null;
  }
}

/** The helm's knob travels along an arc of this many degrees each side of the top. */
export const HELM_ARC = 55;

/** How long a bump's line stays, in milliseconds. */
export const BUMP_LINE = 4000;

export class HudModel {
  readonly speed = signal('0.0');
  readonly heading = signal('000° N');
  /** The heading's figures, in the compass card's window. */
  readonly figures = signal('000°');
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
  /** What the sail is doing wrong, on the sheet's legend: luffing, stalled, aback, or nothing. */
  readonly sail = signal<SailState>('');
  readonly sailHold = new SailHold();
  #bumpUntil = 0;
  /** How many times the signals were written. */
  writes = 0;
  /** Whether the words and numbers are held as they are, for a test to set them. */
  held = false;

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
  readonly sheetText = new SheetText();
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
   * autopilot's control, way the turn it has under way, and watch and left
   * the seconds since a turn stalled and the angle off the wind it holds
   * after one (State.PilotWatch and PilotLeft).
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
    watch = 0,
    left = 0,
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
    // The sail by world time, so a frame's length makes no difference.
    this.sailHold.add(time, out, pose.sailorMode === 0);
    this.sheetText.set(sheet, this.sail.peek());
    this.clinometer.set((pose.heel * 180) / Math.PI);
    if (this.held || now - this.#lastWrite < SIGNAL_INTERVAL) {
      return;
    }
    this.#lastWrite = now;
    this.writes++;
    this.speed.value = knots(out[RECORDS.out.speedOverGround] ?? 0);
    this.heading.value = headingText(pose.heading);
    this.figures.value = headingFigures(pose.heading);
    // The force is the mean wind's, as the Beaufort scale is defined, so a
    // gust shows as the knots rising while the force holds.
    this.wind.value = windText(a.speed, a.from, wind.meanSpeed);
    // On the bottom or against land, while the sailor sails.
    const aground = out[RECORDS.out.aground] ?? 0;
    this.sailor.value =
      pose.sailorMode === 0 && aground !== 0 ? AGROUND : (SAILOR_LINES[pose.sailorMode] ?? '');
    this.pilot.value = pilotText(pilot, way, watch, left);
    this.sail.value = this.sailHold.shown;
    if (this.bump.value !== '' && now >= this.#bumpUntil) {
      this.bump.value = '';
    }
  }
}

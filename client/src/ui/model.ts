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

/** What the sail wants of its sheet, as Out.Sail says it (internal/physics/records.go). */
const SAIL_DRAWING = 0;
const SAIL_WORDS: Readonly<Record<number, SailState>> = {
  0: '',
  1: 'luffing',
  2: 'stalled',
  3: 'aback',
};

/** A state other than drawing shows once it has held this long, in seconds of world time. */
export const SAIL_SHOW = 1.5;
/** What shows clears once the sail has drawn this long, in seconds. */
export const SAIL_CLEAR = 1;
/**
 * The sail's state as the sheet's legend says it: what the step says of it
 * (Out.Sail: luffing, stalled or aback, or drawing, which a boat at rest
 * head to wind is) once it has said so for SAIL_SHOW, cleared after
 * SAIL_CLEAR of drawing, so a gust or a lull does not make it flicker.
 * Another state than the one shown replaces it once it too has held
 * SAIL_SHOW. The server holds a machine sailor's the same. It allocates
 * nothing.
 */
export class SailHold {
  /** What shows. */
  shown: SailState = '';
  #state = SAIL_DRAWING;
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
      this.#state = SAIL_DRAWING;
      this.#since = time;
    }
    this.#last = time;
    let state = out[RECORDS.out.sail] ?? SAIL_DRAWING;
    if (!aboard) {
      // Nobody at the sheet: nothing to say, and nothing held.
      this.shown = '';
      state = SAIL_DRAWING;
    }
    if (state !== this.#state) {
      this.#state = state;
      this.#since = time;
    }
    const held = time - this.#since;
    if (state === SAIL_DRAWING) {
      if (held >= SAIL_CLEAR) {
        this.shown = '';
      }
    } else if (held >= SAIL_SHOW) {
      this.shown = SAIL_WORDS[state] ?? '';
    }
  }
}

/** The sheet's words on a boat that names it so. */
export const SHEET_WORDS: HudControls['sheet'] = { name: 'Sheet', trim: 'Trim', ease: 'Ease' };

/**
 * The sheet's words for assistive technology, in the boat's words for its
 * sheet: its setting, and what the sail wants.
 */
export function sheetText(
  sheet: number,
  sail: SailState,
  words: HudControls['sheet'] = SHEET_WORDS,
): string {
  const v = `${words.name} ${Math.round(sheet * 100)}%`;
  const trim = words.trim === SHEET_WORDS.trim ? 'trim in' : words.trim.toLowerCase();
  switch (sail) {
    case 'luffing':
      return `${v}, luffing: ${trim}`;
    case 'stalled':
      return `${v}, stalled: ${words.ease.toLowerCase()}`;
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
  /** The boat's words for its sheet. */
  #words = SHEET_WORDS;

  set(sheet: number, sail: SailState): void {
    const percent = Math.round(sheet * 100);
    if (this.el === null || (percent === this.#percent && sail === this.#sail)) {
      return;
    }
    this.#percent = percent;
    this.#sail = sail;
    this.el.setAttribute('aria-valuetext', sheetText(sheet, sail, this.#words));
  }

  /** The boat's words for its sheet: written afresh at the next setting. */
  words(w: HudControls['sheet']): void {
    this.#words = w;
    this.#percent = -1;
  }

  /** Forgets what was written (a new element was attached). */
  attach(el: HTMLElement | SVGElement | null): void {
    this.el = el;
    this.#percent = -1;
    this.#sail = null;
  }
}

/** What the controls are called on a kind of boat, and whether it reefs: the catalog's controls and its sails' reefs. */
export interface HudControls {
  sheet: { name: string; trim: string; ease: string };
  /** The reef's three levels in words: full sail, one reef, two. */
  reef: readonly string[];
  /** Whether the boat can reef at all: a reef that shortens any of its sails. */
  reefs: boolean;
  /**
   * Whether the sheet is the braces of square sails: aback, its legend
   * names the control, since the yards are aback, not a sail on a sheet.
   */
  braces: boolean;
  /** Whether the boat carries a downwind sail, which its crew sets and takes in. */
  downwind: boolean;
}

/** A kind of boat as the screen reads it. */
export interface HudKind {
  controls: { sheet: HudControls['sheet']; reef: readonly string[] };
  physics: {
    rig: { reefs: readonly number[] };
    headsails?: { headsailReefs: readonly number[] };
    square?: { squareForeArea: number; squareAfterArea: number; squareReefs: readonly number[] };
    downwind?: { downwindArea: number };
  };
}

/** The controls' words and the reef for a kind of boat. */
export function controlsOf(kind: HudKind): HudControls {
  const { rig, headsails, square, downwind } = kind.physics;
  const braces = square !== undefined && square.squareForeArea + square.squareAfterArea > 0;
  const shares = [
    ...rig.reefs,
    ...(headsails?.headsailReefs ?? []),
    ...(braces ? (square?.squareReefs ?? []) : []),
  ];
  return {
    sheet: kind.controls.sheet,
    reef: kind.controls.reef,
    reefs: shares.some((share) => share < 1),
    braces,
    downwind: (downwind?.downwindArea ?? 0) > 0,
  };
}

/** The downwind sail's name on the screen. */
export const DOWNWIND_NAME = 'Gennaker';

/**
 * What the downwind sail is doing, for the case's last line, from how far
 * it is hoisted (0 … 1) and where the crew is taking it (1 or 0): going up,
 * set or coming in; empty in its bag, or on a boat with none.
 */
export function downwindLine(c: HudControls | null, hoist: number, target: number): string {
  if (c === null || !c.downwind || (hoist <= 0 && target <= 0)) {
    return '';
  }
  if (target > 0) {
    return hoist >= 1 ? `${DOWNWIND_NAME} set` : `${DOWNWIND_NAME} going up`;
  }
  return `${DOWNWIND_NAME} coming in`;
}

/**
 * The sheet's legend for what the sail is doing, but for its own name while
 * it draws. While the downwind sail is set (kite) the word is its own, and
 * names it: the one sheet trims it with the main.
 */
export function sheetLegend(c: HudControls | null, sail: SailState, kite = false): string {
  const name = c?.sheet.name ?? SHEET_WORDS.name;
  const of = (word: string) => (kite && c?.downwind === true ? `${DOWNWIND_NAME} · ${word}` : word);
  switch (sail) {
    case '':
      return name;
    case 'luffing':
      return of('Luffing');
    case 'stalled':
      return of('Stalled');
    case 'aback':
      return c?.braces === true ? `${name} · Aback` : of('Aback');
  }
}

/** The case's line for a reef, 0 … 2 as the state has it: its level's words, none at full sail. */
export function reefLine(c: HudControls | null, reef: number): string {
  const level = Math.min(Math.max(Math.round(reef), 0), 2);
  return c === null || level === 0 ? '' : (c.reef[level] ?? '');
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
  /** The own boat's controls' words, and whether it reefs; null until a kind is known. */
  readonly controls = signal<HudControls | null>(null);
  /** The reef asked for, 0 … 2: what the Reef key shows. */
  readonly reef = signal(0);
  /**
   * The reef the main has, in words, for the case; empty at full sail. On a
   * boat with a downwind sail, while it is going up, set or coming in, what
   * it is doing instead.
   */
  readonly reefed = signal('');
  /** Whether the downwind sail is set, more than half hoisted: the sheet's word is its own. */
  readonly kite = signal(false);
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

  /** The own boat's kind: its controls' words, and whether it reefs. */
  setKind(kind: HudKind): void {
    this.controls.value = controlsOf(kind);
    this.sheetText.words(this.controls.value.sheet);
  }

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
    const c = this.controls.peek();
    this.reefed.value = downwindLine(c, pose.hoist, pose.hoistTarget) || reefLine(c, pose.reef);
    this.kite.value = c?.downwind === true && pose.hoist >= 0.5;
    if (this.bump.value !== '' && now >= this.#bumpUntil) {
      this.bump.value = '';
    }
  }
}

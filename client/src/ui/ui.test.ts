// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { SheetInput } from '../input/sheet';
import { newPose } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { type BoatWind, newBoatWind } from '../predict/weather';
import { Sheet } from './controls';
import {
  beaufortForce,
  compassPoint,
  headingFigures,
  headingText,
  KNOT,
  knots,
  threeDigits,
  wholeDegrees,
  windText,
} from './format';
import {
  HudModel,
  SAIL_CLEAR,
  SAIL_SHOW,
  SailHold,
  type SailState,
  SIGNAL_INTERVAL,
  sheetText,
  WindWindow,
} from './model';
import { ordinal, queueLines } from './queue';
import { DEFAULTS, loadSettings, type Store, saveSettings } from './settings';

const DEG = Math.PI / 180;

describe('format', () => {
  test('speeds in knots to a tenth', () => {
    expect(knots(0)).toBe('0.0');
    expect(knots(5 * KNOT)).toBe('5.0');
    expect(knots(5.04 * KNOT)).toBe('5.0');
    expect(knots(5.06 * KNOT)).toBe('5.1');
    expect(knots(-1)).toBe('0.0');
  });

  test('headings in three digits', () => {
    expect(threeDigits(wholeDegrees(90 * DEG))).toBe('090');
    expect(threeDigits(wholeDegrees(0))).toBe('000');
    expect(threeDigits(wholeDegrees(359.6 * DEG))).toBe('000');
    expect(threeDigits(wholeDegrees(-90 * DEG))).toBe('270');
    expect(threeDigits(wholeDegrees(7 * DEG))).toBe('007');
    expect(headingText(Math.PI / 2)).toBe('090° E');
    expect(headingFigures(Math.PI / 2)).toBe('090°');
    expect(headingFigures(-90 * DEG)).toBe('270°');
  });

  test('the 16 compass points, at and either side of each boundary', () => {
    const names = [
      'N',
      'NNE',
      'NE',
      'ENE',
      'E',
      'ESE',
      'SE',
      'SSE',
      'S',
      'SSW',
      'SW',
      'WSW',
      'W',
      'WNW',
      'NW',
      'NNW',
    ];
    names.forEach((name, i) => {
      const centre = i * 22.5;
      expect(compassPoint(centre)).toBe(name);
      // A boundary belongs to the point clockwise of it.
      const boundary = centre + 11.25;
      expect(compassPoint(boundary - 0.01)).toBe(name);
      expect(compassPoint(boundary)).toBe(names[(i + 1) % 16]);
      expect(compassPoint(boundary + 0.01)).toBe(names[(i + 1) % 16]);
    });
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(-10)).toBe('N');
  });

  test('the wind as knots and where it comes from', () => {
    expect(windText(10 * KNOT, 0, 10 * KNOT)).toBe('N 10 kn · F3');
    expect(windText(14 * KNOT, 247.5 * DEG, 11 * KNOT)).toBe('WSW 14 kn · F4');
    // A gust raises the knots and leaves the force, which is the mean wind's.
    expect(windText(19 * KNOT, 22.5 * DEG, 14 * KNOT)).toBe('NNE 19 kn · F4');
  });

  test('the Beaufort force at each boundary of the Met Office’s table', () => {
    // Each force's first whole knot, and the knot before it.
    const from = [0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
    for (const [force, knot] of from.entries()) {
      expect(beaufortForce(knot * KNOT), `${knot} knots`).toBe(force);
      if (force > 0) {
        expect(beaufortForce((knot - 1) * KNOT), `${knot - 1} knots`).toBe(force - 1);
      }
    }
    // By the whole knots the readout shows: 10.4 knots reads 10, force 3.
    expect(beaufortForce(10.4 * KNOT)).toBe(3);
    expect(beaufortForce(10.6 * KNOT)).toBe(4);
    expect(beaufortForce(200)).toBe(12);
    expect(beaufortForce(-3)).toBe(0);
  });
});

/** A store that refuses everything, as a private window may. */
const refusing: Store = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

function memory(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('settings', () => {
  test('survive a refused localStorage, with the defaults', () => {
    expect(loadSettings(refusing)).toEqual(DEFAULTS);
    expect(saveSettings({ ...DEFAULTS, sound: false }, refusing)).toBe(false);
    expect(loadSettings(null)).toEqual(DEFAULTS);
  });

  test('round-trip, keeping only values of the right kind', () => {
    const m = memory();
    expect(saveSettings({ ...DEFAULTS, frameRate: 30, windOverlay: true }, m)).toBe(true);
    expect(loadSettings(m)).toEqual({ ...DEFAULTS, frameRate: 30, windOverlay: true });
    m.data.set('keel.settings', '{"frameRate": 144, "sound": "yes", "centreHelm": true}');
    expect(loadSettings(m)).toEqual({ ...DEFAULTS, centreHelm: true });
    m.data.set('keel.settings', 'not json');
    expect(loadSettings(m)).toEqual(DEFAULTS);
  });

  test('a new sailor’s case is shut and the autopilot folded; a stored choice is kept', () => {
    expect(DEFAULTS).toMatchObject({ barometer: false, pilotHead: false });
    const m = memory();
    // A set saved before the case: the barometer was out, and stays out.
    m.data.set('keel.settings', '{"frameRate": 60, "sound": true, "barometer": true}');
    expect(loadSettings(m)).toMatchObject({ barometer: true, pilotHead: false });
    // The world clock is gone from the case: its stored choice is let go.
    m.data.set('keel.settings', '{"worldClock": true, "pilotHead": true}');
    const s = loadSettings(m);
    expect(s).toMatchObject({ barometer: false, pilotHead: true });
    expect(s).not.toHaveProperty('worldClock');
  });

  test('the night light is lighter than the night by default, and read as a number in range', () => {
    expect(DEFAULTS.nightLight).toBeCloseTo(2 / 3, 9);
    const m = memory();
    for (const [stored, read] of [
      ['0', 0],
      ['1', 1],
      ['0.3', 0.3],
      ['1.5', 2 / 3],
      ['-0.1', 2 / 3],
      ['"0.5"', 2 / 3],
      ['null', 2 / 3],
      ['true', 2 / 3],
    ] as const) {
      m.data.set('keel.settings', `{"nightLight": ${stored}}`);
      expect(loadSettings(m).nightLight).toBeCloseTo(read, 9);
    }
  });
});

/** A wind at the boat with no gust in it. */
function wind(speed: number, from: number): BoatWind {
  return {
    ...newBoatWind(),
    speed,
    from,
    shadowSpeed: speed,
    shadowFrom: from,
    meanSpeed: speed,
    meanFrom: from,
  };
}

describe('the instruments', () => {
  test('read the wind over three seconds, and its force from the mean wind', () => {
    const model = new HudModel();
    const out = new Float64Array(SIZES.out);
    const pose = newPose();
    // Four seconds of 10 knots from the north, at 60 frames a second.
    let now = 0;
    const breeze = { ...wind(10 * KNOT, 0) };
    for (; now < 4000; now += 1000 / 60) {
      model.frame(now, now / 1000, pose, out, breeze, 0, 0, 0, 0);
    }
    expect(model.wind.value).toBe('N 10 kn · F3');
    // A gust of 16 knots, veered 8°, on a mean still of 10: a second in, a
    // third of the window is gust.
    const gust = {
      ...breeze,
      speed: 16 * KNOT,
      from: 8 * DEG,
      shadowSpeed: 16 * KNOT,
      shadowFrom: 8 * DEG,
      gust: 1,
      factor: 1.6,
    };
    for (const end = now + 1000; now < end; now += 1000 / 60) {
      model.frame(now, now / 1000, pose, out, gust, 0, 0, 0, 0);
    }
    expect(model.anemometer.speed / KNOT).toBeCloseTo(12, 0);
    expect(model.anemometer.from / DEG).toBeGreaterThan(2);
    expect(model.anemometer.from / DEG).toBeLessThan(4);
    expect(model.wind.value).toBe('N 12 kn · F3');
    // Three seconds in, all of it: the knots are the gust's, the force the mean's.
    for (const end = now + 2100; now < end; now += 1000 / 60) {
      model.frame(now, now / 1000, pose, out, gust, 0, 0, 0, 0);
    }
    expect(model.anemometer.speed / KNOT).toBeCloseTo(16, 6);
    expect(model.wind.value).toBe('N 16 kn · F3');
    // Through north the mean direction goes the short way.
    const w = new WindWindow();
    w.add(0, 5, 350 * DEG);
    w.add(10, 5, 10 * DEG);
    expect(Math.abs(w.from)).toBeLessThan(1e-9);
    expect(w.speed).toBe(5);
    // What is older than the window is let go, and so is what a jump back in time leaves.
    w.add(5000, 9, 1);
    expect(w.speed).toBe(9);
    w.add(100, 2, 2);
    expect(w.speed).toBe(2);
  });

  test('write their signals at most ten times a second', () => {
    const model = new HudModel();
    const out = new Float64Array(SIZES.out);
    const pose = newPose();
    let changes = 0;
    const stop = model.speed.subscribe(() => changes++);
    for (let i = 0; i <= 120; i++) {
      out[RECORDS.out.speedOverGround] = i * 0.01;
      model.frame(i * (1000 / 120), i / 120, pose, out, wind(5, 0), 0, 0.5, 0, 0.5);
    }
    stop();
    // One second at 120 frames a second.
    expect(model.writes).toBeLessThanOrEqual(1000 / SIGNAL_INTERVAL + 1);
    expect(model.writes).toBeGreaterThanOrEqual(9);
    expect(changes).toBeLessThanOrEqual(model.writes + 1);
  });

  test('say what the sailor is doing when out of the boat', () => {
    const model = new HudModel();
    const out = new Float64Array(SIZES.out);
    const pose = newPose();
    const w = wind(5, 0);
    model.frame(0, 0, pose, out, w, 0, 0, 0, 0);
    expect(model.sailor.value).toBe('');
    let now = 0;
    for (const [mode, line] of [
      [1, 'In the water'],
      [2, 'Righting the boat'],
      [3, 'Climbing back in'],
      [0, ''],
    ] as const) {
      pose.sailorMode = mode;
      now += 1000;
      model.frame(now, now / 1000, pose, out, w, 0, 0, 0, 0);
      expect(model.sailor.value).toBe(line);
    }
  });
});

describe('the queue', () => {
  test('ordinals', () => {
    const cases: [number, string][] = [
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
      [101, '101st'],
      [111, '111th'],
      [112, '112th'],
    ];
    for (const [n, want] of cases) {
      expect(ordinal(n)).toBe(want);
    }
  });

  test('the place and how many wait', () => {
    expect(queueLines({ position: 12, waiting: 40 })).toEqual([
      'The sea is full. You are 12th in line.',
      '40 sailors waiting.',
    ]);
    expect(queueLines({ position: 1, waiting: 1 })).toEqual([
      'The sea is full. You are next in line.',
      '1 sailor waiting.',
    ]);
  });
});

/** The sail's states of Out.Sail. */
const ATTACHED = 0;
const LUFFING = 1;
const STALLED = 2;
const ABACK = 3;

describe('the sail on the sheet', () => {
  /** A step's out with what it says of the sail. */
  const outOf = (state: number): Float64Array => {
    const out = new Float64Array(SIZES.out);
    out[RECORDS.out.sail] = state;
    return out;
  };
  /** Sails from t for seconds at 60 frames a second with the out given; returns the time at the end and what showed at each frame. */
  const sail = (h: SailHold, t: number, seconds: number, out: Float64Array, aboard = true) => {
    const shown: SailState[] = [];
    const end = t + seconds;
    for (; t < end - 1e-9; t += 1 / 60) {
      h.add(t, out, aboard);
      shown.push(h.shown);
    }
    return { t, shown };
  };
  /** When, in seconds from the start of a run, what shows first became this; −1 never. */
  const at = (shown: SailState[], s: SailState): number => {
    const i = shown.indexOf(s);
    return i < 0 ? -1 : i / 60;
  };

  test('a flow shows once it has held 1.5 s, and clears after 1 s of drawing', () => {
    for (const [flow, word] of [
      [LUFFING, 'luffing'],
      [STALLED, 'stalled'],
      [ABACK, 'aback'],
    ] as const) {
      const h = new SailHold();
      let r = sail(h, 0, 2, outOf(ATTACHED));
      expect(r.shown.every((s) => s === '')).toBe(true);
      r = sail(h, r.t, 3, outOf(flow));
      expect(at(r.shown, word)).toBeCloseTo(SAIL_SHOW, 1);
      expect(r.shown.at(-1)).toBe(word);
      r = sail(h, r.t, 2, outOf(ATTACHED));
      expect(at(r.shown, '')).toBeCloseTo(SAIL_CLEAR, 1);
      expect(r.shown.at(-1)).toBe('');
    }
  });

  test('does not flicker: a half-second gust of drawing, or a flow held less than 1.5 s, changes nothing', () => {
    const h = new SailHold();
    let r = sail(h, 0, 2, outOf(LUFFING));
    expect(h.shown).toBe('luffing');
    for (let i = 0; i < 4; i++) {
      r = sail(h, r.t, 0.5, outOf(ATTACHED));
      expect(r.shown.every((s) => s === 'luffing')).toBe(true);
      r = sail(h, r.t, 1, outOf(LUFFING));
      expect(r.shown.every((s) => s === 'luffing')).toBe(true);
    }
    // A stall of a second does not replace it; one of 1.5 s does.
    r = sail(h, r.t, 1, outOf(STALLED));
    expect(r.shown.every((s) => s === 'luffing')).toBe(true);
    r = sail(h, r.t, 0.2, outOf(LUFFING));
    r = sail(h, r.t, 2, outOf(STALLED));
    expect(at(r.shown, 'stalled')).toBeCloseTo(SAIL_SHOW, 1);
    // Drawing, a luff of a second shows nothing.
    r = sail(h, r.t, 2, outOf(ATTACHED));
    expect(h.shown).toBe('');
    r = sail(h, r.t, 1, outOf(LUFFING));
    expect(r.shown.every((s) => s === '')).toBe(true);
  });

  test('says nothing while the sailor is out of the boat, and begins again when time goes back', () => {
    const h = new SailHold();
    let r = sail(h, 0, 2, outOf(STALLED));
    expect(h.shown).toBe('stalled');
    r = sail(h, r.t, 0.1, outOf(STALLED), false);
    expect(h.shown).toBe('');
    r = sail(h, r.t, 3, outOf(STALLED), false);
    expect(r.shown.every((s) => s === '')).toBe(true);
    r = sail(h, r.t, 2, outOf(STALLED));
    expect(at(r.shown, 'stalled')).toBeCloseTo(SAIL_SHOW, 1);
    // Back in time, the hold begins again.
    sail(h, 0, 1, outOf(STALLED));
    expect(h.shown).toBe('');
  });

  test('the instruments show it, by world time', () => {
    const model = new HudModel();
    const pose = newPose();
    const w = wind(5, 0);
    const out = outOf(STALLED);
    // At 30 frames a second of the page, but world time running at half speed.
    for (let i = 0; i <= 84; i++) {
      model.frame(i * (1000 / 30), i / 60, pose, out, w, 0, 0.5, 0, 0.5);
    }
    expect(model.sail.value).toBe('');
    for (let i = 85; i <= 120; i++) {
      model.frame(i * (1000 / 30), i / 60, pose, out, w, 0, 0.5, 0, 0.5);
    }
    expect(model.sail.value).toBe('stalled');
  });

  /** Every element of a tree, as written. */
  const elements = (node: ComponentChildren): VNode<Record<string, unknown>>[] => {
    if (Array.isArray(node)) {
      return node.flatMap(elements);
    }
    if (node === null || typeof node !== 'object' || !('type' in node)) {
      return [];
    }
    const v = node as VNode<{ children?: ComponentChildren } & Record<string, unknown>>;
    return [v, ...elements(v.props.children)];
  };
  const words = (node: ComponentChildren): string => {
    if (Array.isArray(node)) {
      return node.map(words).join('');
    }
    if (typeof node === 'string') {
      return node;
    }
    if (node === null || typeof node !== 'object' || !('props' in node)) {
      return '';
    }
    return words((node as VNode<{ children?: ComponentChildren }>).props.children);
  };

  test('the legend says the word, and the end to move toward lights with its arrow', () => {
    const model = new HudModel();
    const drawn = (s: SailState) => {
      model.sail.value = s;
      const all = elements(Sheet({ input: new SheetInput(), model }));
      const cls = (v: VNode<Record<string, unknown>>) => String(v.props.class ?? '');
      const legend = all.find((v) => cls(v).split(' ').includes('control-label'));
      const end = (name: string) => all.find((v) => v.props['data-end'] === name);
      const lit = (name: string) => {
        const e = end(name);
        return e !== undefined && cls(e).split(' ').includes('lit') ? words(e) : null;
      };
      return { legend: words(legend), trim: lit('trim'), ease: lit('ease') };
    };
    expect(drawn('')).toEqual({ legend: 'Sheet', trim: null, ease: null });
    expect(drawn('luffing')).toEqual({ legend: 'Luffing', trim: '▲Trim', ease: null });
    expect(drawn('stalled')).toEqual({ legend: 'Stalled', trim: null, ease: 'Ease▼' });
    expect(drawn('aback')).toEqual({ legend: 'Aback', trim: null, ease: null });
  });

  test('the slider’s words for assistive technology, kept as the sheet moves', () => {
    expect(sheetText(0.5, '')).toBe('Sheet 50%');
    expect(sheetText(0.5, 'luffing')).toBe('Sheet 50%, luffing: trim in');
    expect(sheetText(0.5, 'stalled')).toBe('Sheet 50%, stalled: ease');
    expect(sheetText(0.5, 'aback')).toBe('Sheet 50%, aback');
    const model = new HudModel();
    const written: string[] = [];
    const el = {
      setAttribute(name: string, v: string) {
        if (name === 'aria-valuetext') {
          written.push(v);
        }
      },
    } as unknown as HTMLElement;
    model.sheetText.attach(el);
    const pose = newPose();
    const out = outOf(LUFFING);
    let t = 0;
    for (const sheet of [0.5, 0.501, 0.502, 0.6, 0.6]) {
      t += 1 / 60;
      model.frame(t * 1000, t, pose, out, wind(5, 0), 0, sheet, 0, sheet);
    }
    expect(written).toEqual(['Sheet 50%', 'Sheet 60%']);
    // The word follows what the legend says.
    for (; t < 2; t += 1 / 60) {
      model.frame(t * 1000, t, pose, out, wind(5, 0), 0, 0.6, 0, 0.6);
    }
    expect(written.at(-1)).toBe('Sheet 60%, luffing: trim in');
  });
});

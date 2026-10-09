// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { newPose } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import {
  compassPoint,
  headingText,
  KNOT,
  knots,
  threeDigits,
  wholeDegrees,
  windText,
} from './format';
import { HudModel, SIGNAL_INTERVAL } from './model';
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
    expect(windText(10 * KNOT, 0)).toBe('10 kn N');
    expect(windText(11 * KNOT, 22.5 * DEG)).toBe('11 kn NNE');
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
});

describe('the instruments', () => {
  test('write their signals at most ten times a second', () => {
    const model = new HudModel();
    const out = new Float64Array(SIZES.out);
    const pose = newPose();
    let changes = 0;
    const stop = model.speed.subscribe(() => changes++);
    for (let i = 0; i <= 120; i++) {
      out[RECORDS.out.speedOverGround] = i * 0.01;
      model.frame(i * (1000 / 120), pose, out, { speed: 5, from: 0 }, 0, 0.5, 0, 0.5);
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
    const w = { speed: 5, from: 0 };
    model.frame(0, pose, out, w, 0, 0, 0, 0);
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
      model.frame(now, pose, out, w, 0, 0, 0, 0);
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

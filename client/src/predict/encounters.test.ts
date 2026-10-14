// SPDX-License-Identifier: AGPL-3.0-only

// Encounters in WebAssembly: the module built by go run ./tools/physics must
// give, bit for bit, the wakes, shadows, contacts and courses Go gave when
// it wrote internal/physics/testdata/encounters.json; and the Articles'
// verdict on every recorded situation of articles.json, as the server
// judges them, which is what the right-of-way overlay shows.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { fromHex, toHex } from './golden';
import { LAYOUT_VERSION, RECORDS, SIZES } from './layout.gen';
import { loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';

const wasm = new URL('./physics.wasm', import.meta.url);
const testdata = new URL('../../../internal/physics/testdata/', import.meta.url);

function readJSON<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, testdata), 'utf8')) as T;
}

interface EncounterFile {
  layout: string;
  wakes: { in: string[]; out: string[] }[];
  shadows: { env: string[]; at: string[]; wakes: string[][]; out: string[]; reach: number }[];
  contacts: {
    a: string[];
    b: string[];
    touched: boolean;
    contact: string[];
    a2: string[];
    b2: string[];
  }[];
  courses: { course: string[]; in: string[]; out: string[] }[];
  sails: {
    name: string;
    steps: number;
    env: string[];
    start: string[][];
    controls: number[][];
    checkpoints: { step: number; states: string[][] }[];
    touched: number;
  }[];
}

interface Situation {
  name: string;
  case: number;
  rule: string;
  boats: {
    x: number;
    y: number;
    heading: number;
    heel: number;
    boom: number;
    sailorMode: number;
    windFrom: number;
    tack: number;
    tacking: number;
    settled: number;
    course: number;
  }[];
  since: number;
  by: string;
  expect: { keeper: string; article: string; fault: string; faultArticle: string };
}

let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather);
});

const bits = (v: ArrayLike<number>): string[] => Array.from(v, toHex);

describe('encounters, bit for bit', () => {
  const file = readJSON<EncounterFile>('encounters.json');

  test('the file is for this layout', () => {
    expect(file.layout).toBe(`0x${LAYOUT_VERSION.toString(16).padStart(8, '0')}`);
  });

  test('wakes', () => {
    for (const c of file.wakes) {
      const [x, y, heading, heel, boom, vx, vy, speed, from] = c.in.map(fromHex) as number[];
      const w = physics.wakeOf(
        x ?? 0,
        y ?? 0,
        heading ?? 0,
        heel ?? 0,
        boom ?? 0,
        vx ?? 0,
        vy ?? 0,
        speed ?? 0,
        from ?? 0,
      );
      expect(bits(w)).toEqual(c.out);
    }
  });

  test('the shadow of the wakes about a point', () => {
    for (const c of file.shadows) {
      const r = physics.records;
      r.state[RECORDS.state.x] = fromHex(c.at[0] ?? '');
      r.state[RECORDS.state.y] = fromHex(c.at[1] ?? '');
      r.env[RECORDS.env.windSpeed] = fromHex(c.env[0] ?? '');
      r.env[RECORDS.env.windFrom] = fromHex(c.env[1] ?? '');
      const wakes = physics.wakes;
      c.wakes.forEach((w, i) => {
        wakes.set(w.map(fromHex), i * SIZES.wake);
      });
      const reach = physics.shadowAt(c.wakes.length);
      expect(reach).toBe(c.reach);
      expect(bits(physics.records.env)).toEqual(c.out);
    }
  });

  test('contacts', () => {
    let touched = 0;
    for (const c of file.contacts) {
      const r = physics.records;
      r.state.set(c.a.map(fromHex));
      r.other.set(c.b.map(fromHex));
      const t = physics.collide();
      expect(t).toBe(c.touched);
      if (t) {
        touched++;
        expect(bits(physics.records.contact)).toEqual(c.contact);
      }
      expect(bits(physics.records.state)).toEqual(c.a2);
      expect(bits(physics.records.other)).toEqual(c.b2);
    }
    expect(touched).toBeGreaterThan(9);
  });

  test('courses', () => {
    for (const c of file.courses) {
      const course = new Float64Array(c.course.map(fromHex));
      const [heading, boom, from] = c.in.map(fromHex) as number[];
      physics.courseOf(course, heading ?? 0, boom ?? 0, from ?? 0);
      expect(bits(course)).toEqual(c.out);
    }
  });
});

describe('two boats sailing together, bit for bit', () => {
  const file = readJSON<EncounterFile>('encounters.json');

  test.each(file.sails.map((s) => [s.name, s] as const))('%s', (_, sail) => {
    const p = physics;
    p.seaUse(-1);
    const env = sail.env.map(fromHex);
    const states = sail.start.map((s) => new Float64Array(s.map(fromHex)));
    const wakes = [new Float64Array(SIZES.wake), new Float64Array(SIZES.wake)];
    const wakeOf = (i: number): void => {
      const r = p.records;
      r.state.set(states[i] as Float64Array);
      r.env.set(env);
      (wakes[i] as Float64Array).set(p.wakeOfState());
    };
    wakeOf(0);
    wakeOf(1);
    let touched = 0;
    let k = 0;
    for (let step = 1; step <= sail.steps; step++) {
      for (let i = 0; i < 2; i++) {
        const r = p.records;
        r.state.set(states[i] as Float64Array);
        r.env.set(env);
        r.control[RECORDS.control.helm] = sail.controls[i]?.[0] ?? 0;
        r.control[RECORDS.control.sheet] = sail.controls[i]?.[1] ?? 0;
        p.wakes.set(wakes[1 - i] as Float64Array, 0);
        p.shadowAt(1);
        p.step();
        (states[i] as Float64Array).set(p.records.state);
      }
      const r = p.records;
      r.state.set(states[0] as Float64Array);
      r.other.set(states[1] as Float64Array);
      if (p.collide()) {
        touched++;
      }
      (states[0] as Float64Array).set(p.records.state);
      (states[1] as Float64Array).set(p.records.other);
      wakeOf(0);
      wakeOf(1);
      const c = sail.checkpoints[k];
      if (c !== undefined && c.step === step) {
        expect(
          [bits(states[0] as Float64Array), bits(states[1] as Float64Array)],
          `step ${step}`,
        ).toEqual(c.states);
        k++;
      }
    }
    expect(k).toBe(sail.checkpoints.length);
    expect(touched).toBe(sail.touched);
  });
});

describe('the Articles', () => {
  const which: Record<string, number> = { neither: 0, first: 1, second: 2 };
  const article: Record<string, number> = {
    '10': 10,
    '11': 11,
    '12': 12,
    '13': 13,
    '15': 15,
    '16.1': 16,
    '22': 22,
  };
  const { situations } = readJSON<{ situations: Situation[] }>('articles.json');
  const deg = Math.PI / 180;
  const wrap = (a: number): number => a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5);

  test.each(situations.map((s) => [s.name, s] as const))('%s', (_, s) => {
    const E = RECORDS.encounter;
    const e = physics.records.encounter;
    s.boats.forEach((b, i) => {
      e[E.x + i] = b.x;
      e[E.y + i] = b.y;
      e[E.heading + i] = wrap(b.heading * deg);
      e[E.heel + i] = b.heel * deg;
      e[E.boom + i] = b.boom * deg;
      e[E.sailorMode + i] = b.sailorMode;
      e[E.windFrom + i] = b.windFrom * deg;
      e[E.tack + i] = b.tack;
      e[E.tacking + i] = b.tacking;
      e[E.settled + i] = b.settled;
      e[E.course + i] = wrap(b.course * deg);
    });
    e[E.since] = s.since;
    e[E.by] = which[s.by] ?? 0;
    const v = physics.articlesJudge();
    const V = RECORDS.verdict;
    expect({
      keeper: v[V.keeper],
      article: v[V.article],
      fault: v[V.fault],
      faultArticle: v[V.faultArticle],
    }).toEqual({
      keeper: which[s.expect.keeper],
      article: article[s.expect.article],
      fault: which[s.expect.fault],
      faultArticle: article[s.expect.faultArticle],
    });
  });
});

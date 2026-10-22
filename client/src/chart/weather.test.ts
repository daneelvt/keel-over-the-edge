// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather at the slider's moment: now, a step of the latest
// issue, or the past with the issue of ninety minutes before; a forecast's
// systems at a step with their cones, a forming low's the same at every
// lead; a front's band, wide by its lead; what happened, the truth judged
// against the old forecast's cones; and the regime's risks.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import { Fields, Forecasts } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { type Keyframe, loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { risksOf } from './place';
import {
  frontsAt,
  gridPoints,
  kindDraws,
  momentOf,
  risksAt,
  type SceneLook,
  sampleScene,
  systemsOfForecast,
  useMoment,
  type WeatherSource,
} from './weather';

const H = RECORDS.forecastHead;
const S = RECORDS.forecastSystem;
const Y = RECORDS.system;
const P = RECORDS.spell;
const MINUTE = 1800;
const STEP = 10 * MINUTE;

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
});

const storm = kindDraws(catalog.weather.systems).findIndex((k) => k.draw === 'low');

/** The scene's look from the catalog, on a coarse grid. */
function look(): SceneLook {
  const w = catalog.weather;
  const { risks, fog } = risksOf(w);
  return {
    lip: catalog.world.disk.radius,
    n: 16,
    kinds: kindDraws(w.systems),
    perHour: w.forecast.cone.perHour * 1852,
    forming: w.forecast.cone.forming * 1852,
    front: w.forecast.cone.front,
    galeGrid: w.forecast.gale.grid * 1852,
    risks,
    fog,
    calm: 5,
    marks: w.regimes.map((r) => w.forecast.risks.find((x) => x.regime === r.id)?.marks ?? []),
    contrast: w.visibility.contrast,
  };
}

/** An issue at a tick with a storm walking east 200 m a step, and a forming low from step 4. */
function issue(tick: number): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = tick;
  head[H.steps] = 10;
  head[H.step] = STEP;
  head[H.nSystems] = 2;
  const sys = (slot: number, forming: boolean, from: number) => {
    const r = new Array<number>(SIZES.forecastSystem).fill(0);
    r[S.slot] = slot;
    r[S.kind] = storm;
    r[S.size] = 3000;
    r[S.peak] = 1100;
    r[S.depth] = 1500;
    r[S.forming] = forming ? 1 : 0;
    for (let k = from; k < 10; k++) {
      r[S.east + k] = -2000 + 200 * k;
      r[S.north + k] = 1000;
      r[S.heading + k] = 16384;
      r[S.speed + k] = 300;
      r[S.strength + k] = 256;
    }
    return r;
  };
  return { head, spells: [], systems: [sys(2, false, 0), sys(5, true, 4)], gale: null };
}

/** A keyframe with the storm of slot 2 at (east, north). */
function truth(tick: number, east: number, north: number): Keyframe {
  const s = new Float64Array(SIZES.system);
  s[Y.on] = 1;
  s[Y.kind] = storm;
  s[Y.east] = east * 4;
  s[Y.north] = north * 4;
  s[Y.heading] = 16384;
  s[Y.speed] = 300;
  s[Y.strength] = 4096;
  s[Y.size] = 3000;
  s[Y.peak] = 1100;
  s[Y.depth] = 1500;
  const systems: Float64Array[] = [];
  systems[2] = s;
  return { tick, systems };
}

/** A source of a held tick and forecasts. */
function source(now: number, f: Forecasts, present: Keyframe[] = []): WeatherSource {
  return {
    tick: () => now,
    forecasts: f,
    fields: () => null,
    present: () => ({ keys: present, spells: [] }),
    sun: () => -1,
    end: () => 0,
  };
}

describe('the chart’s weather', () => {
  test('the slider’s moment: now, a step of the latest issue, or the past', () => {
    const f = new Forecasts();
    const now = 100 * STEP + 7 * MINUTE;
    f.receive(issue(100 * STEP), { issue: issue(91 * STEP), truth: [], spells: [] });
    const src = source(now, f);
    expect(momentOf('forecast', 0, src).kind).toBe('now');
    const ahead = momentOf('forecast', 3, src);
    expect([ahead.kind, ahead.tick]).toEqual(['forecast', 103 * STEP]);
    expect(momentOf('forecast', 40, src).step).toBe(9);
    const back = momentOf('past', -4, src);
    expect([back.kind, back.tick, back.issue?.head[H.issue]]).toEqual([
      'past',
      now - 40 * MINUTE,
      91 * STEP,
    ]);
    expect(momentOf('past', 0, src).kind).toBe('now');
  });

  test('a forecast’s systems at a step, with cones that grow, but for a forming low’s', () => {
    const l = look();
    const f = issue(0);
    const at3 = systemsOfForecast(f, 3 * STEP, l);
    expect(at3.length).toBe(1);
    expect(at3[0]?.east).toBe(-1400);
    expect(at3[0]?.cone).toBeCloseTo(l.perHour * 0.5, 6);
    expect(at3[0]?.track.length).toBe(10);
    const at6 = systemsOfForecast(f, 6 * STEP + STEP / 2, l);
    expect(at6.map((s) => s.forming)).toEqual([false, true]);
    expect(at6[0]?.east).toBe(-700);
    expect(at6[1]?.cone).toBe(l.forming);
    expect(at6[1]?.track.length).toBe(6);
  });

  test('a front’s line moves at its speed, its forecast band ±1.28 σ v L', () => {
    const s = new Array<number>(SIZES.spell).fill(0);
    s[P.begin] = 0;
    s[P.change] = 4000;
    s[P.front] = 1;
    s[P.toward] = 16384;
    const [f] = frontsAt([s], 2000, 1000, { sigma: 0.04, lead: 1500 });
    expect(f?.line).toBeCloseTo(0, 9);
    expect(f?.sin).toBeCloseTo(1, 9);
    expect(f?.band).toBeCloseTo(1.2815515655446004 * 0.04 * 0.5 * 1500, 9);
    expect(frontsAt([s], 4500, 1000, null)).toEqual([]);
  });

  test('what happened judges the truth against the old forecast’s cones', async () => {
    const fields = new Fields(await physics.twin());
    preparePhysics(fields.physics, catalog.boats[0].physics, catalog.weather, catalog.world);
    const l = look();
    const f = new Forecasts();
    const now = 9 * STEP;
    f.receive(issue(9 * STEP), { issue: issue(0), truth: [], spells: [] });
    // Forty minutes back: the old forecast has the storm at −1200; the
    // truth close by, then far off.
    const t = now - 40 * MINUTE;
    for (const [east, inside] of [
      [-1150, 1],
      [-3000, 0],
    ] as const) {
      f.keepKeyframe(truth(t - 300, east, 1000));
      f.keepKeyframe(truth(t + 300, east, 1000));
      const src = source(now, f);
      const m = momentOf('past', -4, src);
      expect(useMoment(fields, m, src)).toBe(true);
      const scene = sampleScene(fields, m, src, l, gridPoints(l.n, l.lip));
      // The forming low is on the forecast by then too, but has no truth to judge.
      expect(scene.forecast.length).toBe(2);
      expect([scene.inside, scene.judged]).toEqual([inside, 1]);
      expect(scene.systems[0]?.east).toBeCloseTo(east, 6);
    }
  });

  test('a regime’s risks: fog patches where the fog may be born, calms in light air, squalls from the windward rim', () => {
    const l = look();
    const n = l.n;
    const grid = {
      n,
      lip: l.lip,
      mean: new Float32Array(n * n).fill(2),
      from: new Float32Array(n * n),
      gust: new Float32Array(n * n),
      rain: new Float32Array(n * n),
      fog: new Float32Array(n * n),
      pressure: new Float32Array(n * n),
    };
    const settled = catalog.weather.regimes.findIndex(
      (r) => r.id === catalog.weather.forecast.risks[0]?.regime,
    );
    const night = risksAt(settled, grid, l, 0, 1, () => [-0.2, -0.2]);
    expect(night.map((r) => r.mark)).toEqual(['fog-patches', 'calms']);
    expect(night[0]?.points.length).toBeGreaterThan(0);
    const day = risksAt(settled, grid, l, 0, 1, () => [0.3, 0.3]);
    expect(day[0]?.points.length).toBe(0);
    const squally = catalog.weather.regimes.findIndex((_, i) =>
      (l.marks[i] ?? []).includes('squalls'),
    );
    const sq = risksAt(squally, grid, l, 1.2, 1, () => [0, 0]).find((r) => r.mark === 'squalls');
    expect(sq?.from).toBe(1.2);
  });
});

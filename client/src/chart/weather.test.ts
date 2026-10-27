// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather at the slider's moment: now, a minute ahead by the
// latest issue as far as it reaches, or a minute behind from the truth
// kept; ahead, its systems are the truth's own at that minute, a system
// born forty minutes after the issue among them from its birth, each with
// its wind, its place half an hour on and its end; and a front's line
// moving at its speed, warm or cold.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import { Fields, Forecasts, forecastOfModule } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { type Keyframe, loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { placedRecord, regimeSpell } from '../predict/weather';
import {
  aheadReach,
  frontsAt,
  gridPoints,
  kindDraws,
  momentOf,
  pastReach,
  recordAt,
  type SceneLook,
  sampleScene,
  systemsOfKeys,
  useMoment,
  type WeatherSource,
} from './weather';

const H = RECORDS.forecastHead;
const R = RECORDS.systemRecord;
const Y = RECORDS.system;
const P = RECORDS.spell;
const MINUTE = 1800;
const EVERY = 300;

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;
let fields: Fields;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
  fields = new Fields(await physics.twin());
  preparePhysics(fields.physics, catalog.boats[0].physics, catalog.weather, catalog.world);
});

const kinds = kindDraws(catalog.weather.systems);
const storm = kinds.findIndex((k) => k.draw === 'spiral');
const low = kinds.findIndex((k) => k.draw === 'low');

/** The scene's look from the catalog, on a coarse grid. */
function look(): SceneLook {
  const w = catalog.weather;
  return {
    lip: catalog.world.disk.radius,
    n: 16,
    kinds,
    galeGrid: w.forecast.gale.grid * 1852,
    contrast: w.visibility.contrast,
  };
}

/** A source of a held tick and forecasts, the present's keyframes given. */
function source(now: number, f: Forecasts, present: Keyframe[] = []): WeatherSource {
  return {
    tick: () => now,
    forecasts: f,
    fields: () => fields,
    present: () => ({ keys: present, spells: [] }),
    sun: () => -1,
    end: () => 0,
  };
}

/** An issue at a tick that knows its systems to until, with nothing in it. */
function emptyIssue(tick: number, until: number): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = tick;
  head[H.steps] = 10;
  head[H.step] = 10 * MINUTE;
  head[H.until] = until;
  head[H.every] = EVERY;
  return { head, spells: [], systems: [], gale: null };
}

/**
 * The world's records about an issue: a storm alive at it, crossing the
 * disk, and a low born forty minutes after it; and the issue the module
 * makes of them, as the server makes its own.
 */
function world(issue: number): { records: Float64Array[]; forecast: ForecastTold } {
  const spell = regimeSpell(physics, catalog.weather, 1, 1, 7, 0, 0, 1e8);
  physics.setSpells([spell]);
  const records = [
    placedRecord(
      catalog.weather,
      storm,
      -1000,
      500,
      issue - 20 * MINUTE,
      issue + 30 * MINUTE,
      spell,
    ),
    placedRecord(
      catalog.weather,
      low,
      2000,
      -1500,
      issue + 40 * MINUTE,
      issue + 42 * MINUTE,
      spell,
    ),
  ];
  physics.setRecords(records);
  physics.forecastMake(issue, 0, EVERY);
  return { records, forecast: forecastOfModule(physics) };
}

/** The truth's keyframes about a tick, each record's system then in its slot, as the server keeps them. */
function truthAbout(records: readonly Float64Array[], tick: number): Keyframe[] {
  const at = (t: number): Keyframe => {
    const systems: Float64Array[] = [];
    records.forEach((r, slot) => {
      const s = physics.systemAt(r, t);
      if ((s[Y.on] ?? 0) !== 0) {
        systems[slot] = Float64Array.from(s);
      }
    });
    return { tick: t, systems };
  };
  const a = Math.floor(tick / EVERY) * EVERY;
  return [at(a), at(a + EVERY)];
}

describe('the slider’s moment', () => {
  test('now, a minute ahead as far as the latest issue reaches, a minute behind as far as the truth is kept', () => {
    const f = new Forecasts();
    const issue = 600 * MINUTE;
    f.receive(emptyIssue(issue, issue + 100 * MINUTE));
    const now = issue + 7 * MINUTE + 300;
    const src = source(now, f);
    expect(momentOf('forecast', 0, src)).toEqual({
      kind: 'now',
      tick: now,
      minutes: 0,
      issue: null,
    });
    const ahead = momentOf('forecast', 40, src);
    expect([ahead.kind, ahead.tick, ahead.minutes]).toEqual(['ahead', issue + 47 * MINUTE, 40]);
    expect(ahead.issue).toBe(f.latest);
    // The issue knows its systems to 100 minutes after it: 93 from now.
    expect(aheadReach(src)).toBe(90);
    expect(momentOf('forecast', 200, src).minutes).toBe(90);
    const late = source(issue + 15 * MINUTE, f);
    expect(aheadReach(late)).toBe(85);
    expect(momentOf('forecast', 90, late).tick).toBe(issue + 100 * MINUTE);
    // No truth kept: behind is now.
    expect(pastReach(src)).toBe(0);
    expect(momentOf('past', -30, src).kind).toBe('now');
    f.keepKeyframe({ tick: issue - 13 * MINUTE, systems: [] });
    expect(pastReach(src)).toBe(20);
    const back = momentOf('past', -30, src);
    expect([back.kind, back.tick, back.minutes]).toEqual(['past', issue - 13 * MINUTE, -20]);
    expect(momentOf('past', -5, src).tick).toBe(issue + 2 * MINUTE);
    expect(momentOf('past', 0, src).kind).toBe('now');
  });

  test('before the first issue, ahead is now', () => {
    const src = source(1000, new Forecasts());
    expect(aheadReach(src)).toBe(0);
    expect(momentOf('forecast', 30, src).kind).toBe('now');
  });
});

describe('the chart’s weather ahead', () => {
  test('is the truth’s at every minute, a system born forty minutes after the issue from its birth', () => {
    const issue = 3000 * MINUTE;
    const { records, forecast } = world(issue);
    expect(forecast.head[H.nSystems]).toBe(2);
    const f = new Forecasts();
    f.receive(forecast);
    const src = source(issue + 4 * MINUTE, f);
    const l = look();
    const points = gridPoints(l.n, l.lip);
    const born = issue + 40 * MINUTE;
    let lowSeen = -1;
    for (let minutes = 1; minutes <= 90; minutes++) {
      const m = momentOf('forecast', minutes, src);
      expect(m.kind).toBe('ahead');
      expect(useMoment(fields, m, src)).toBe(true);
      const scene = sampleScene(fields, m, src, l, points);
      const truth = systemsOfKeys(truthAbout(records, m.tick), m.tick, l.kinds);
      expect(
        scene.systems.map((s) => [s.slot, s.seed, s.east, s.north, s.strength, s.size]),
        `${minutes} min ahead`,
      ).toEqual(truth.map((s) => [s.slot, s.seed, s.east, s.north, s.strength, s.size]));
      const has = scene.systems.some((s) => s.kind === low);
      if (m.tick < born) {
        expect(has, `${minutes} min ahead, before its birth`).toBe(false);
      } else if (has && lowSeen < 0) {
        lowSeen = m.tick;
      }
    }
    // Within a minute of its birth, as its strength grows past a trace.
    expect(lowSeen).toBeGreaterThanOrEqual(born);
    expect(lowSeen).toBeLessThanOrEqual(born + MINUTE);
  });

  test('each system with its strongest wind, its ring, its place half an hour on and its end', () => {
    const issue = 4000 * MINUTE;
    const { records, forecast } = world(issue);
    const f = new Forecasts();
    f.receive(forecast);
    const src = source(issue + 2 * MINUTE, f);
    const l = look();
    const m = momentOf('forecast', 10, src);
    useMoment(fields, m, src);
    const scene = sampleScene(fields, m, src, l, gridPoints(l.n, l.lip));
    const s = scene.systems.find((x) => x.kind === storm);
    expect(s).toBeDefined();
    if (s === undefined) {
      return;
    }
    const r = records[s.slot] as Float64Array;
    expect(s.seed).toBe(r[R.seed]);
    expect(s.gone).toBe(r[R.gone]);
    expect(s.ring).toBeCloseTo((kinds[storm]?.ring ?? 0) * s.size, 9);
    expect(s.wind).toBeGreaterThan(10);
    expect(s.gust).toBeGreaterThanOrEqual(s.wind);
    const later = recordAt(fields.physics, forecast, r, m.tick + 30 * MINUTE);
    expect(later).not.toBeNull();
    expect(s.ahead).toEqual({ east: later?.east, north: later?.north });
    // Ahead, the gale's grid.
    expect(scene.gale).not.toBeNull();
  });

  test('now is the present’s keyframes, with the latest issue’s ends', () => {
    const issue = 5000 * MINUTE;
    const { records, forecast } = world(issue);
    const f = new Forecasts();
    f.receive(forecast);
    const now = issue + 3 * MINUTE + 77;
    const src = source(now, f, truthAbout(records, now));
    const l = look();
    const m = momentOf('forecast', 0, src);
    useMoment(fields, m, src);
    const scene = sampleScene(fields, m, src, l, gridPoints(l.n, l.lip));
    expect(scene.moment.kind).toBe('now');
    expect(scene.gale).toBeNull();
    expect(scene.systems.map((s) => s.east)).toEqual(
      systemsOfKeys(truthAbout(records, now), now, l.kinds).map((s) => s.east),
    );
    expect(scene.systems[0]?.gone).toBe(records[0]?.[R.gone]);
  });
});

describe('a front', () => {
  test('its line moves at its speed, warm or cold', () => {
    const s = new Array<number>(SIZES.spell).fill(0);
    s[P.begin] = 0;
    s[P.change] = 4000;
    s[P.front] = 1;
    s[P.toward] = 16384;
    s[P.warm] = 1;
    const [f] = frontsAt([s], 2000, 1000);
    expect(f?.line).toBeCloseTo(0, 9);
    expect(f?.sin).toBeCloseTo(1, 9);
    expect(f?.warm).toBe(true);
    // 2000 m in 4000 ticks: 15 m/s.
    expect(f?.speed).toBeCloseTo(15, 9);
    s[P.warm] = 0;
    expect(frontsAt([s], 1000, 1000)[0]?.warm).toBe(false);
    expect(frontsAt([s], 4500, 1000)).toEqual([]);
  });
});

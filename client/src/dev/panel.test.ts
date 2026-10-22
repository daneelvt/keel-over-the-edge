// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { Fleet } from '../game/fleet';
import { CHANGE, FLEET_META, SLOT, SLOT_FIELDS, slotAt, VIEW_SLOTS } from '../net/view';
import { RECORDS, SIZES } from '../predict/layout.gen';
import {
  airLines,
  applyState,
  inSeaState,
  netLines,
  type PanelWorld,
  RIM,
  rainWord,
  readState,
  seaLines,
  skyLines,
  toRim,
  windLine,
} from './panel';

function stub(): PanelWorld & { calls: string[] } {
  const calls: string[] = [];
  const state = new Float64Array(SIZES.state);
  // A steady spell, its wind in whole steps as a spell has it.
  const spell = new Float64Array(SIZES.spell);
  const P = RECORDS.spell;
  spell[P.steady] = 1;
  const tuning = { gusts: true, shifts: true };
  const blow = (speed: number, from: number): void => {
    spell[P.speed] = Math.round(speed / 0.01);
    spell[P.from] = Math.round((from / (2 * Math.PI)) * 65536) % 65536;
  };
  let regime = 'steady';
  const w: PanelWorld & { calls: string[] } = {
    calls,
    usePass: true,
    stage: {
      antialias: 'fxaa',
      scale: null,
      setAntialias(a) {
        calls.push(`aa ${a}`);
        this.antialias = a;
      },
      setScale(s) {
        calls.push(`scale ${s}`);
        this.scale = s;
      },
    },
    setUsePass(on) {
      calls.push(`pass ${on}`);
      w.usePass = on;
    },
    sandbox: {
      spell,
      get regime() {
        return regime;
      },
      tuning,
      states: { current: state },
      sea: { options: { fetch: null, split: null, flat: false, swell: null } },
      settleSea() {
        calls.push('settle');
      },
      setWeather(id) {
        calls.push(`weather ${id}`);
        regime = id;
        spell[P.steady] = id === 'steady' ? 1 : 0;
      },
      tune(change) {
        calls.push(`tune ${JSON.stringify(change)}`);
        const wind = {
          speed: (spell[P.speed] ?? 0) * 0.01,
          from: ((spell[P.from] ?? 0) / 65536) * 2 * Math.PI,
        };
        blow(change.speed ?? wind.speed, change.from ?? wind.from);
        tuning.gusts = change.gusts ?? tuning.gusts;
        tuning.shifts = change.shifts ?? tuning.shifts;
      },
      steadyNow(speed, from) {
        calls.push(`steady ${speed.toFixed(4)} ${from.toFixed(4)}`);
        regime = 'steady';
        blow(speed, from);
      },
      place(east, north, heading) {
        calls.push(`place ${east} ${north} ${heading.toFixed(4)}`);
        state[RECORDS.state.x] = east;
        state[RECORDS.state.y] = north;
        state[RECORDS.state.heading] = heading;
      },
    },
    loop: { paused: false, speed: 1 },
  };
  return w;
}

describe('the panel', () => {
  test('reads headings and winds in degrees and knots', () => {
    const w = stub();
    w.sandbox.states.current[RECORDS.state.heading] = -Math.PI / 2;
    w.sandbox.steadyNow(10 * (1852 / 3600), Math.PI);
    const s = readState(w);
    expect(s.heading).toBeCloseTo(270, 9);
    // The spell's wind, 5.14 m/s in its whole steps, to a tenth of a knot.
    expect(s.windSpeed).toBe(10);
    expect(s.windFrom).toBe(180);
    expect(s.weather).toBe('steady');
  });

  test('sets the weather, and a spell’s gusts and shifts', () => {
    const w = stub();
    applyState(w, { ...readState(w), weather: 'trade' });
    expect(w.calls).toEqual(['weather trade']);
    expect(readState(w).weather).toBe('trade');
    w.calls.length = 0;
    applyState(w, { ...readState(w), gusts: false });
    applyState(w, { ...readState(w), shifts: false, windSpeed: 14 });
    expect(w.calls).toEqual([
      'tune {"gusts":false}',
      `tune {"speed":${14 * (1852 / 3600)},"shifts":false}`,
    ]);
    expect(readState(w)).toMatchObject({ gusts: false, shifts: false, windSpeed: 14 });
    w.calls.length = 0;
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
  });

  test('says what wind is at the boat', () => {
    const KNOT = 1852 / 3600;
    expect(
      windLine({
        speed: 13.44 * KNOT,
        from: (15.4 * Math.PI) / 180,
        shadowSpeed: 13.44 * KNOT,
        shadowFrom: (15.4 * Math.PI) / 180,
        meanSpeed: 11.2 * KNOT,
        meanFrom: (12 * Math.PI) / 180,
        gust: 0.425,
        factor: 1.2,
      }),
    ).toBe('wind    mean 11.2 kn from 012°, now 13.4 kn (×1.20), gust +0.42, veer +3.4°');
    expect(
      windLine({
        speed: 5,
        from: 6.2,
        shadowSpeed: 5,
        shadowFrom: 6.2,
        meanSpeed: 5.4,
        meanFrom: 0.02,
        gust: -0.5,
        factor: 0.93,
      }),
    ).toMatch(/gust −0\.50, veer −5\.9°$/);
    // In another boat's wake.
    expect(
      windLine({
        speed: 10 * KNOT,
        from: 0.5,
        shadowSpeed: 7 * KNOT,
        shadowFrom: 0.5 - (4 * Math.PI) / 180,
        meanSpeed: 10 * KNOT,
        meanFrom: 0.5,
        gust: 0,
        factor: 1,
      }),
    ).toMatch(/\nshadow {2}7\.0 kn, 30% lost, turned −4\.0°$/);
  });

  test('applies only what changed', () => {
    const w = stub();
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
    applyState(w, {
      ...readState(w),
      antialias: 'smaa',
      scale: 1,
      pass: false,
      east: 5,
    });
    expect(w.calls).toEqual(['place 5 0 0.0000', 'aa smaa', 'scale 1', 'pass false']);
  });

  test('sets the sea’s fetch, a second wind to the east and flat water, at once', () => {
    const w = stub();
    w.sandbox.steadyNow(10 * (1852 / 3600), 1);
    w.sandbox.states.current[RECORDS.state.x] = 500;
    w.calls.length = 0;
    applyState(w, { ...readState(w), fetch: 9, split: 34 });
    expect(w.calls).toEqual(['settle']);
    const sea = w.sandbox.sea.options;
    expect(sea.fetch).toBeCloseTo(9 * 1852, 9);
    // The boat is in the area of column 19; the second wind starts at the next.
    expect(sea.split?.column).toBe(20);
    expect(sea.split?.wind.speed).toBeCloseTo(34 * (1852 / 3600), 9);
    expect(sea.split?.wind.from).toBeCloseTo(1, 4);
    const s = readState(w);
    expect(s.fetch).toBeCloseTo(9, 9);
    expect(s.split).toBeCloseTo(34, 9);
    applyState(w, { ...s, flat: true, fetch: null, split: null });
    expect(w.sandbox.sea.options).toEqual({ fetch: null, split: null, flat: true, swell: null });
    w.calls.length = 0;
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
  });

  test('puts the sandbox in a sea state: its wind, and its sea at once', () => {
    const w = stub();
    w.sandbox.steadyNow(3, 2);
    w.sandbox.sea.options.flat = true;
    w.calls.length = 0;
    inSeaState(w, 'gale');
    expect(w.calls).toEqual([`steady ${(34 * (1852 / 3600)).toFixed(4)} 2.0000`, 'settle']);
    expect(w.sandbox.sea.options.flat).toBe(false);
    inSeaState(w, 'hurricane');
    expect(w.calls).toHaveLength(2);
  });

  test('says what sea is under the boat', () => {
    expect(seaLines(0, 0, 0, false)).toBe('sea     flat');
    expect(seaLines(0.972, (2 * Math.PI) / 3.6, 106, false)).toBe(
      'sea     Hs 0.97 m, peak 3.6 s, 106 waves',
    );
    expect(seaLines(0.5, 2, 90, true)).toMatch(/90 waves, blended$/);
  });

  test('its wind and boat fields round-trip', () => {
    const w = stub();
    applyState(w, {
      ...readState(w),
      windSpeed: 12,
      windFrom: 45,
      east: 30,
      north: -40,
      heading: 90,
    });
    const s = readState(w);
    expect(s.windSpeed).toBe(12);
    expect(s.windFrom).toBe(45);
    expect(s.east).toBe(30);
    expect(s.north).toBe(-40);
    expect(s.heading).toBeCloseTo(90, 9);
    // A wind from −90° is from 270°.
    applyState(w, { ...readState(w), windFrom: -90 });
    expect(readState(w).windFrom).toBe(270);
    w.calls.length = 0;
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
  });

  test('pauses and slows time', () => {
    const w = stub();
    applyState(w, { ...readState(w), paused: true, speed: 0.25 });
    expect(w.loop).toEqual({ paused: true, speed: 0.25 });
  });

  test('jumps to the rim along the boat’s bearing from the centre', () => {
    const w = stub();
    const s = toRim({ ...readState(w), east: 30, north: 40 });
    expect(Math.hypot(s.east, s.north)).toBeCloseTo(RIM, 9);
    expect(s.east / s.north).toBeCloseTo(0.75, 12);
    const fromCentre = toRim(readState(w));
    expect([fromCentre.east, fromCentre.north]).toEqual([RIM, 0]);
  });
});

describe('the connection’s numbers', () => {
  test('follow the fleet: boats near and far, delays, entries', () => {
    const fleet = new Fleet();
    const tickUs = 1e6 / 30;
    for (let tick = 2; tick <= 120; tick += 2) {
      const f = new Float64Array(5 + VIEW_SLOTS * SLOT_FIELDS);
      f[FLEET_META.tick] = tick;
      for (const [slot, far] of [
        [0, 0],
        [1, 0],
        [2, 1],
      ] as const) {
        const o = slotAt(slot);
        f[o + SLOT.present] = 1;
        f[o + SLOT.sampled] = 1;
        f[o + SLOT.far] = far;
        f[o + SLOT.change] = tick === 2 ? CHANGE.entered : CHANGE.updated;
      }
      fleet.add(f, tick * tickUs + 100_000);
      fleet.update(tick * tickUs + 100_000, 1 / 15);
    }
    const lines = netLines({
      status: 'sailing',
      offsetMs: 0,
      rttMs: 200,
      m: 4,
      margin: 2,
      counts: { snapshots: 60, corrections: 0, resets: 1, stale: 0, largest: 0 },
      p95: 0,
      traffic: { bytesIn: 1, bytesOut: 2, messagesIn: 3, messagesOut: 4, resyncs: 0 },
      fleet: fleet.stats,
      snapshotBytes: 190,
    });
    expect(lines).toContain('boats near, far   2, 1 (0 fading)');
    expect(lines).toContain('delays            133 ms near, 400 ms far');
    expect(lines).toMatch(/entries {11}45\.0 a second/);
    expect(lines).toContain('snapshot          190 bytes');
    expect(lines).not.toContain('last bump');
  });

  test('says what the encounters are: the shadow, the course, the last bump', () => {
    const KNOT = 1852 / 3600;
    const lines = netLines({
      status: 'sailing',
      offsetMs: 0,
      rttMs: 200,
      m: 4,
      margin: 2,
      counts: { snapshots: 60, corrections: 0, resets: 1, stale: 0, largest: 0 },
      p95: 0,
      traffic: { bytesIn: 1, bytesOut: 2, messagesIn: 3, messagesOut: 4, resyncs: 0 },
      fleet: new Fleet().stats,
      snapshotBytes: 190,
      wind: {
        speed: 10 * KNOT,
        from: 0,
        shadowSpeed: 8 * KNOT,
        shadowFrom: -0.05,
        meanSpeed: 10 * KNOT,
        meanFrom: 0,
        gust: 0,
        factor: 1,
      },
      wakes: 2,
      course: new Float64Array([-1, 1, 45, Math.PI / 4]),
      bump: {
        told: { tick: 9, east: 1.25, north: -3, closing: 1.5, part: 'yours', article: '10' },
        ago: 3,
      },
    });
    expect(lines).toContain('shadow  8.0 kn, 20% lost');
    expect(lines).toContain('wakes             2 reaching the boat');
    expect(lines).toContain('course            tacking, tack settled 1.5 s, course 045°');
    expect(lines).toContain(
      'last bump         3 s ago, yours, Article 10, 1.50 m/s, at 1.3 E -3.0 N',
    );
  });
});

describe('the sky lines', () => {
  test('give the rain in WMO-No. 8’s words, the sheets and the clouds in sight', () => {
    const words = [2.5, 10, 50];
    expect(rainWord(0, words)).toBe('none');
    expect(rainWord(1, words)).toBe('light');
    expect(rainWord(6, words)).toBe('moderate');
    expect(rainWord(20, words)).toBe('heavy');
    expect(rainWord(75, words)).toBe('violent');
    const lines = skyLines(12.34, words, [1, 0.5, 0], 0.425, [
      { form: 3, slot: 0, top: 2500, away: 3200 },
      { form: 2, slot: -1, top: 700, away: 900 },
    ]);
    expect(lines).toEqual([
      'rain    12.3 mm/h, heavy',
      'sheets  cirrus 1.00, middle 0.50, low 0.00, overcast 0.42',
      'clouds  cumulonimbus 2500 m at 3.2 km, 1 cumulus',
    ]);
  });
});

describe('the air’s lines', () => {
  test('tell the visibility, its word and what makes it, the signals heard and the last flash', () => {
    const lines = airLines(
      104,
      3,
      [0.0005, 0.037, 0, 0],
      [{ notation: 'Dia(2) 60s', bearing: 42, delay: 2.1 }],
      { away: 1200, delay: 3.5, sea: true, ago: 4 },
    );
    expect(lines[0]).toBe(
      'air     visibility 104 m, very poor: clear 1%, fog 99%, rain 0%, mist 0%',
    );
    expect(lines[1]).toBe('signals Dia(2) 60s from 042°, 2.1 s');
    expect(lines[2]).toBe('flash   1.2 km to the sea, 4 s ago, thunder after 3.5 s');
    expect(airLines(8334, 0, [0.00047, 0, 0, 0], [], null).slice(1)).toEqual([
      'signals none heard',
      'flash   none in the last minute',
    ]);
  });
});

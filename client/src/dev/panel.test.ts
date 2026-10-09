// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { Fleet } from '../game/fleet';
import { CHANGE, FLEET_META, SLOT, SLOT_FIELDS, slotAt, VIEW_SLOTS } from '../net/view';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { applyState, netLines, type PanelWorld, RIM, readState, toRim } from './panel';

function stub(): PanelWorld & { calls: string[] } {
  const calls: string[] = [];
  const state = new Float64Array(SIZES.state);
  const wind = { speed: 0, from: 0 };
  const w: PanelWorld & { calls: string[] } = {
    calls,
    testSea: 'flat',
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
    setTestSea(name) {
      calls.push(`sea ${name}`);
      w.testSea = name;
    },
    setUsePass(on) {
      calls.push(`pass ${on}`);
      w.usePass = on;
    },
    sandbox: {
      wind,
      states: { current: state },
      setWind(speed, from) {
        calls.push(`wind ${speed.toFixed(4)} ${from.toFixed(4)}`);
        wind.speed = speed;
        wind.from = from;
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
    w.sandbox.setWind(10 * (1852 / 3600), Math.PI);
    const s = readState(w);
    expect(s.heading).toBeCloseTo(270, 9);
    expect(s.windSpeed).toBeCloseTo(10, 9);
    expect(s.windFrom).toBeCloseTo(180, 9);
  });

  test('applies only what changed', () => {
    const w = stub();
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
    applyState(w, {
      ...readState(w),
      sea: 'gale',
      antialias: 'smaa',
      scale: 1,
      pass: false,
      east: 5,
    });
    expect(w.calls).toEqual(['sea gale', 'place 5 0 0.0000', 'aa smaa', 'scale 1', 'pass false']);
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
    expect(s.windSpeed).toBeCloseTo(12, 9);
    expect(s.windFrom).toBeCloseTo(45, 9);
    expect(s.east).toBe(30);
    expect(s.north).toBe(-40);
    expect(s.heading).toBeCloseTo(90, 9);
    // A wind from −90° is from 270°.
    applyState(w, { ...readState(w), windFrom: -90 });
    expect(readState(w).windFrom).toBeCloseTo(270, 9);
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
  });
});

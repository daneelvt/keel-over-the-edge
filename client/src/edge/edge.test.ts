// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { newPose } from '../predict/blend';
import { cellsBeyondLip, hash01, MAX_SLABS, SLAB_REACH, slabAt } from './falls';
import { type Drain, drainSpeed, LINES_PERIOD, travelTime } from './lines';
import { ApproachWatch, closestLine, fadeOver, fallPose, overhang } from './over';

const NM = 1852;
const KNOT = NM / 3600;
const LIP = catalog.world.disk.radius;
const current = catalog.weather.current;
const DRAIN: Drain = {
  at: current.drainAt.map((x) => x * NM) as [number, number, number],
  speed: current.drain.map((x) => x * KNOT) as [number, number, number],
};
const FROM = catalog.world.edge.look.lines.from * KNOT;

describe('the foam lines', () => {
  it('show nowhere the drain is slower than their start', () => {
    for (const r of [0, 3000, DRAIN.at[0], DRAIN.at[0] + 100]) {
      expect(drainSpeed(DRAIN, r) <= FROM).toBe(true);
      expect(travelTime(DRAIN, FROM, r)).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  it('are carried at the drain’s speed: their travel time grows as 1 / u', () => {
    for (const r of [7200, 7900, 8300]) {
      const h = 0.01;
      const slope = (travelTime(DRAIN, FROM, r + h) - travelTime(DRAIN, FROM, r - h)) / (2 * h);
      expect(slope * drainSpeed(DRAIN, r), `${r} m`).toBeCloseTo(1, 4);
    }
  });

  it('a pattern of the travel time less world time moves out at the drain’s speed', () => {
    // A dash's edge, where τ(r) − t is constant, two frames apart.
    for (const r0 of [7200, 7900, 8300]) {
      const t0 = 1000;
      const dt = 1 / 60;
      const phase = travelTime(DRAIN, FROM, r0) - t0;
      // Where the same phase is a frame later, by bisection.
      let lo = r0;
      let hi = r0 + 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (travelTime(DRAIN, FROM, mid) - (t0 + dt) < phase) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const speed = (lo - r0) / dt;
      expect(speed / drainSpeed(DRAIN, r0), `${r0} m`).toBeCloseTo(1, 2);
    }
  });

  it('repeat with the period world time is reduced by, so 2³¹ ticks on is the same', () => {
    // The pattern's dash index changes by whole periods of dashes.
    expect(LINES_PERIOD % 8).toBe(0);
    const t = 2 ** 31 / 30;
    const reduced = t - LINES_PERIOD * Math.floor(t / LINES_PERIOD);
    expect(reduced).toBeGreaterThanOrEqual(0);
    expect(reduced).toBeLessThan(LINES_PERIOD);
    expect(
      Math.abs((t - reduced) / LINES_PERIOD - Math.round((t - reduced) / LINES_PERIOD)),
    ).toBeLessThan(1e-9);
  });
});

describe('the slabs', () => {
  const look = catalog.world.edge.look.slabs;

  it('are drawn alike on every page: by the cell and world time alone', () => {
    const a = { age: 0, release: 0, spin: 0, gone: 0 };
    const b = { age: 0, release: 0, spin: 0, gone: 0 };
    for (const t of [0, 12.25, 3600.5, 2 ** 31 / 30]) {
      slabAt(look, 1500, -3, 1, t, a);
      slabAt(look, 1500, -3, 1, t, b);
      expect(a).toEqual(b);
    }
  });

  it('let go within the catalog’s release, once a cycle, falling until gone within its depths', () => {
    const s = { age: 0, release: 0, spin: 0, gone: 0 };
    for (let q = 1400; q < 1420; q++) {
      for (let t = 0; t < 60; t += 0.37) {
        slabAt(look, q, 2, 0, t, s);
        expect(s.release).toBeGreaterThanOrEqual(look.release[0] ?? 0);
        expect(s.release).toBeLessThanOrEqual(look.release[1] ?? 1);
        expect(s.gone).toBeGreaterThanOrEqual(look.gone[0] ?? 0);
        expect(s.gone).toBeLessThanOrEqual(look.gone[1] ?? 0);
        expect(Math.abs(s.spin)).toBeLessThanOrEqual(look.spin);
        expect(s.age).toBeGreaterThanOrEqual(0);
        expect(s.age).toBeLessThan(2 * (look.cycle[1] ?? 7));
      }
    }
    expect(hash01(3, 4)).toBe(hash01(3, 4));
  });

  it('come from the cells of the ring just beyond the lip, within reach of the camera', () => {
    const cells = cellsBeyondLip(LIP, 0.4, SLAB_REACH, []);
    expect(cells.length).toBeGreaterThan(100);
    expect(2 * cells.length).toBeLessThanOrEqual(MAX_SLABS);
    for (const c of cells) {
      const x = 1.5 * (4 / Math.sqrt(3)) * c.q;
      const y = 4 * (c.r + c.q / 2);
      const r = Math.hypot(x, y);
      expect(r).toBeGreaterThanOrEqual(LIP);
      expect(r).toBeLessThan(LIP + 4);
      const along = LIP * Math.abs(Math.atan2(x, y) - 0.4);
      expect(along).toBeLessThan(SLAB_REACH + 4);
    }
  });
});

describe('going over, drawn', () => {
  const shape = { lip: LIP, drain: 1.03, gravity: 3, tip: [0.3, 1.9] as [number, number] };

  it('a hull hanging over the lip pitches over the brink, bow first', () => {
    const p = newPose();
    p.north = LIP - 1;
    p.heading = 0;
    overhang(p, 2, LIP);
    expect(p.pitch).toBeLessThan(0);
    const inside = newPose();
    inside.north = LIP - 50;
    overhang(inside, 2, LIP);
    expect(inside.pitch).toBe(0);
    expect(inside.heel).toBe(0);
    // Lying along the lip, its port side to it: heeled to port.
    const along = newPose();
    along.north = LIP - 0.5;
    along.heading = Math.PI / 2;
    overhang(along, 2, LIP);
    expect(along.heel).toBeLessThan(0);
  });

  it('falls out and down as a slab, tipping', () => {
    const p = newPose();
    p.north = LIP + 0.01;
    fallPose(p, 2, shape);
    expect(p.north).toBeCloseTo(LIP + 0.01 + 2 * 1.03, 6);
    expect(p.heave).toBeCloseTo(-6, 6);
    expect(p.pitch).toBeCloseTo(-(0.3 + 1.9 * 2), 6);
  });

  it('fades to the mist over the third second, at once with reduced motion', () => {
    expect(fadeOver(1, false)).toBe(0);
    expect(fadeOver(2.5, false)).toBeCloseTo(0.5, 9);
    expect(fadeOver(4, false)).toBe(1);
    expect(fadeOver(0.1, true)).toBe(1);
  });
});

describe('an approach to the lip', () => {
  const band = catalog.world.disk.mist * NM;
  const clear = catalog.world.edge.clear;

  it('begins in the band and is survived clear of it, with its least distance', () => {
    const w = new ApproachWatch(LIP, band, clear);
    expect(w.follow(0, band - 10)).toBeNull();
    expect(w.approaching).toBe(false);
    expect(w.follow(0, LIP - 100)).toBeNull();
    expect(w.follow(0, LIP - 34.4)).toBeNull();
    expect(w.follow(0, band - 5)).toBeNull();
    expect(w.follow(0, band - clear - 1)).toBeCloseTo(34.4, 9);
    expect(w.approaching).toBe(false);
  });

  it('that ends over the lip is not survived', () => {
    const w = new ApproachWatch(LIP, band, clear);
    w.follow(0, LIP - 10);
    w.over();
    expect(w.follow(0, band - clear - 1)).toBeNull();
  });

  it('is told in whole metres, or under a metre', () => {
    expect(closestLine(34.4)).toBe('Closest to the edge: 34 m');
    expect(closestLine(0.3)).toBe('Closest to the edge: under a metre');
  });
});

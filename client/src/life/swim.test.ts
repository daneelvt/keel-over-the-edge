// SPDX-License-Identifier: AGPL-3.0-only

// The life in the water moves as real animals do: dolphins porpoise in
// ballistic leaps when fast, ride a bow in its wave, flying fish glide
// within their lengths, heights and speeds, turtles breathe and dive as
// young green turtles do; and each path is the record's and time's alone.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeKind, SwimLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import {
  flightOf,
  G,
  MOST_DRAWN,
  newFlight,
  newSwimPlace,
  PORPOISE_FROM,
  porpoiseAt,
  swimAt,
  swimCount,
  swimSeed,
  TAXI,
  TOUCH,
  turtleCycle,
} from './swim';

const kinds = catalog.life.kinds;
const indexOf = (f: (k: LifeKind) => boolean): number => kinds.findIndex(f);
const riding = indexOf((k) => k.form === 'pod' && k.binds === 'ride' && k.path === 'pass');
const turtle = indexOf((k) => k.form === 'turtle');
const glider = indexOf((k) => k.form === 'glider');
const slowPod = indexOf(
  (k) => k.form === 'pod' && k.binds === undefined && k.swim?.leaps === undefined,
);

function record(kind: number, over: Partial<LifeSeen> = {}): LifeSeen {
  const k = kinds[kind] as LifeKind;
  return {
    id: 'w',
    rev: 0,
    kind,
    start: 3000,
    end: 3000 + 30 * 900,
    east: 100,
    north: 200,
    heading: 0.7,
    speed: ((k.speed[0] ?? 1) + (k.speed[1] ?? 1)) / 2,
    count: k.group[1] ?? 1,
    seed: 4242,
    with: 0,
    over: '',
    ...over,
  };
}

describe('the life in the water', () => {
  test('the catalog has each form drawn here', () => {
    for (const i of [riding, turtle, glider, slowPod]) {
      expect(i).toBeGreaterThanOrEqual(0);
    }
  });

  test('a porpoising leap is a ballistic arc under gravity', () => {
    for (const v of [3.6, 4.5, 5.5]) {
      const at = { up: 0, air: false };
      const dt = 0.01;
      let checked = 0;
      for (let u = 0; u < 20; u += dt) {
        porpoiseAt(v, 77, u - dt, at);
        const a = at.up;
        const wasAir = at.air;
        porpoiseAt(v, 77, u, at);
        const b = at.up;
        porpoiseAt(v, 77, u + dt, at);
        if (wasAir && at.air) {
          // The second difference of the height is −g in the air.
          expect((at.up - 2 * b + a) / (dt * dt)).toBeCloseTo(-G, 3);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(50);
    }
  });

  test('a fast pod leaps clear now and then; a slow one never porpoises', () => {
    const p = newSwimPlace();
    const fast = record(riding, { speed: 5 });
    const slow = record(slowPod);
    let out = 0;
    let slowOut = 0;
    for (let t = fast.start + 30 * 300; t < fast.start + 30 * 360; t += 3) {
      for (let i = 0; i < 4; i++) {
        swimAt(fast, kinds[riding] as LifeKind, i, t, null, p);
        out += p.up > 0.3 ? 1 : 0;
        swimAt(slow, kinds[slowPod] as LifeKind, i, t, null, p);
        slowOut += p.up > 0.5 ? 1 : 0;
      }
    }
    expect(out).toBeGreaterThan(20);
    expect(slowOut).toBe(0);
  });

  test('a pod riding a bow keeps a metre or two ahead of the stem, beside it', () => {
    const k = kinds[riding] as LifeKind;
    const e = record(riding, { with: 1 });
    const boat = { east: 50, north: -40, heading: 1.1, speed: 3, bow: 2 };
    const p = newSwimPlace();
    const life = (e.end - e.start) / 30;
    const a = Math.min(k.range / e.speed, life / 2);
    const t = e.start + Math.round((a + 60) * 30);
    for (let i = 0; i < 2; i++) {
      expect(swimAt(e, k, i, t, boat, p)).toBe(true);
      const de = p.east - boat.east;
      const dn = p.north - boat.north;
      const ahead = de * Math.sin(boat.heading) + dn * Math.cos(boat.heading);
      const side = de * Math.cos(boat.heading) - dn * Math.sin(boat.heading);
      expect(ahead).toBeGreaterThan(boat.bow);
      expect(ahead).toBeLessThan(boat.bow + 3);
      expect(Math.abs(side)).toBeLessThan(2.6);
      expect(p.up).toBeLessThan(0.2);
    }
    // With its boat not drawn it is nowhere.
    expect(swimAt(e, k, 0, t, null, p)).toBe(false);
  });

  test("a flying fish's glides are 20–50 m, linked to 150 m at most, at 10–15 m/s, under 1.5 m", () => {
    const k = kinds[glider] as LifeKind;
    const swim = k.swim as SwimLook;
    const lo = swim.glide?.[0] ?? 0;
    const hi = swim.glide?.[1] ?? 0;
    const f = newFlight();
    let linked = 0;
    for (let n = 0; n < 200; n++) {
      const e = record(glider, { seed: 1000 + n, count: 12 });
      for (let i = 0; i < 12; i++) {
        flightOf(e, k, swim, i, f);
        let total = 0;
        for (let g = 0; g < f.count; g++) {
          const len = f.glides[g] ?? 0;
          total += len;
          expect(len).toBeLessThanOrEqual(hi + 1e-9);
          if (g < f.count - 1) {
            expect(len).toBeGreaterThanOrEqual(lo - 1e-9);
          }
        }
        expect(total).toBeLessThanOrEqual((swim.linked ?? hi) + 1e-9);
        linked += f.count > 1 ? 1 : 0;
        expect(f.speed).toBeGreaterThanOrEqual(10);
        expect(f.speed).toBeLessThanOrEqual(15);
      }
    }
    expect(linked).toBeGreaterThan(0);
    // Flying, never above its height, and gone once back in the water.
    const e = record(glider, { start: 0, end: 30 * 20 });
    const p = newSwimPlace();
    let most = 0;
    let shown = 0;
    for (let t = 0; t < e.end; t++) {
      swimAt(e, k, 3, t, null, p);
      if (p.shown) {
        most = Math.max(most, p.up);
        shown++;
      }
    }
    expect(most).toBeLessThanOrEqual(1.5);
    expect(most).toBeGreaterThan(0.25);
    expect(shown).toBeGreaterThan(30 * TAXI);
    expect(shown).toBeLessThan(e.end);
    expect(TOUCH).toBeLessThan(TAXI);
  });

  test('a turtle comes up for 3–6 breaths, and dives 60–120 s', () => {
    const swim = (kinds[turtle] as LifeKind).swim as SwimLook;
    const c = { part: 0, into: 0, length: 0, breaths: 0 };
    let ups = 0;
    for (let s = 0; s < 50; s++) {
      for (let u = 0; u < 600; u += 1) {
        turtleCycle(swim, swimSeed(s, 0), u, c);
        if (c.part === 0) {
          expect(c.length).toBeGreaterThanOrEqual(swim.dive?.[0] ?? 0);
          expect(c.length).toBeLessThanOrEqual(swim.dive?.[1] ?? 0);
        } else {
          ups++;
          expect(c.breaths).toBeGreaterThanOrEqual(swim.breaths?.[0] ?? 0);
          expect(c.breaths).toBeLessThanOrEqual(swim.breaths?.[1] ?? 0);
        }
      }
    }
    expect(ups).toBeGreaterThan(0);
  });

  test('a group drawn is at most so many, half of them on the low tier; the same on every page', () => {
    const e = record(riding, { count: 60 });
    expect(swimCount(e, false)).toBe(MOST_DRAWN);
    expect(swimCount(e, true)).toBe(MOST_DRAWN / 2);
    const a = newSwimPlace();
    const b = newSwimPlace();
    swimAt(e, kinds[riding] as LifeKind, 5, e.start + 30 * 400, null, a);
    swimAt({ ...e }, kinds[riding] as LifeKind, 5, e.start + 30 * 400, null, b);
    expect(b).toEqual(a);
  });
});

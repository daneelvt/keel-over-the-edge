// SPDX-License-Identifier: AGPL-3.0-only

import type { Material, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { foamAt, KNOT, newFoamLook } from '../ocean/look';
import {
  type CrestSample,
  SprayDrops,
  type SpraySource,
  SprayView,
  type SprayWeather,
  seeded,
} from './spray';

const weather = (knots: number, hs = 1): SprayWeather => {
  const look = foamAt(knots, newFoamLook());
  return {
    speed: knots * KNOT,
    east: 0,
    north: -1,
    whitecaps: look.whitecaps,
    hs,
    crestRate: look.spray,
    spindrift: look.spindrift,
  };
};

/**
 * A boat sailing at speed into a sea whose height at its bow rises and falls
 * by `sea` metres every period seconds, its bow riding a fraction `rides` of it.
 */
function sail(
  drops: SprayDrops,
  speed: number,
  knots: number,
  sea: number,
  seconds = 10,
  crests: CrestSample[] = [],
): number {
  const dt = 1 / 60;
  let thrown = 0;
  let before = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    const h = (sea / 2) * Math.sin((2 * Math.PI * t) / 2.5);
    const src: SpraySource = {
      east: speed * t,
      north: 0,
      height: 0.6 * h,
      sea: h,
      heading: Math.PI / 2,
      speed,
    };
    drops.step(dt, [src], weather(knots), crests);
    thrown += Math.max(drops.count - before, 0);
    before = drops.count;
  }
  return thrown;
}

describe('spray', () => {
  it('is the same from the same seed', () => {
    const a = new SprayDrops(512, 7);
    const b = new SprayDrops(512, 7);
    sail(a, 3, 20, 1.2);
    sail(b, 3, 20, 1.2);
    expect(a.count).toBeGreaterThan(0);
    expect(Array.from(a.data.subarray(0, a.count * 9))).toEqual(
      Array.from(b.data.subarray(0, b.count * 9)),
    );
    const c = new SprayDrops(512, 8);
    sail(c, 3, 20, 1.2);
    expect(Array.from(c.data.subarray(0, 9))).not.toEqual(Array.from(a.data.subarray(0, 9)));
  });

  it('is not thrown by a boat slower than a metre a second', () => {
    expect(sail(new SprayDrops(512), 0.9, 34, 2.5)).toBe(0);
    expect(sail(new SprayDrops(512), 2, 34, 2.5)).toBeGreaterThan(0);
  });

  it('is not thrown where the sea does not rise against the bow', () => {
    // Riding the sea: the bow rises with it.
    const drops = new SprayDrops(512);
    for (let i = 0; i < 600; i++) {
      const h = Math.sin(i / 20);
      drops.step(
        1 / 60,
        [{ east: 0, north: 0, height: h, sea: h, heading: 0, speed: 4 }],
        weather(20),
      );
    }
    expect(drops.count).toBe(0);
  });

  it('is thrown more in a higher sea from the same rise', () => {
    const low = new SprayDrops(2048, 4);
    const high = new SprayDrops(2048, 4);
    const run = (d: SprayDrops, hs: number): number => {
      let thrown = 0;
      for (let i = 0; i < 600; i++) {
        const h = 0.5 * Math.sin((2 * Math.PI * i) / 150);
        const before = d.count;
        d.step(
          1 / 60,
          [{ east: 0, north: 0, height: 0.6 * h, sea: h, heading: 0, speed: 3 }],
          weather(20, hs),
        );
        thrown += Math.max(d.count - before, 0);
      }
      return thrown;
    };
    expect(run(high, 2)).toBeGreaterThan(1.5 * run(low, 0.3));
  });

  it('is thrown more in a gale than a breeze, and more the faster the boat', () => {
    const breeze = sail(new SprayDrops(2048), 3, 12, 0.5);
    const gale = sail(new SprayDrops(2048), 3, 34, 1.4);
    expect(gale).toBeGreaterThan(2 * breeze);
    expect(sail(new SprayDrops(2048), 5, 20, 1)).toBeGreaterThan(
      sail(new SprayDrops(2048), 2, 20, 1),
    );
  });

  it('is blown down the wind and falls, for about a second', () => {
    const drops = new SprayDrops(2048, 3);
    sail(drops, 4, 34, 1.4, 6);
    expect(drops.count).toBeGreaterThan(0);
    // Then no more is thrown: in two seconds every drop is gone.
    for (let i = 0; i < 120; i++) {
      drops.step(1 / 60, [], weather(34));
    }
    expect(drops.count).toBe(0);
    // Blown south, as the wind blows.
    const one = new SprayDrops(64, 3);
    one.step(1 / 60, [], weather(34), [{ east: 0, north: 0, height: 1, crest: 2 }]);
    for (let i = 0; i < 400 && one.count === 0; i++) {
      one.step(1 / 60, [], weather(34), [{ east: 0, north: 0, height: 1, crest: 2 }]);
    }
    expect(one.count).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      one.step(1 / 60, [], weather(34));
    }
    expect(one.data[1]).toBeLessThan(-0.5);
  });

  it('comes off the crests from force 7, more with every force, and never below', () => {
    const crests: CrestSample[] = Array.from({ length: 16 }, (_, i) => ({
      east: i * 5,
      north: 0,
      height: 1,
      crest: 1.5,
    }));
    const still = (knots: number): number => {
      const d = new SprayDrops(2048, 5);
      let thrown = 0;
      for (let i = 0; i < 600; i++) {
        const before = d.count;
        d.step(1 / 60, [], weather(knots), crests);
        thrown += Math.max(d.count - before, 0);
      }
      return thrown;
    };
    expect(still(27.9)).toBe(0);
    expect(still(20)).toBe(0);
    const by = [30.5, 37, 44, 51.5].map(still);
    expect(by[0]).toBeGreaterThan(20);
    for (let i = 1; i < by.length; i++) {
      expect(by[i]).toBeGreaterThan(1.5 * (by[i - 1] ?? 0));
    }
    // Not off a low crest.
    const low = new SprayDrops(64);
    for (let i = 0; i < 600; i++) {
      low.step(1 / 60, [], weather(40), [{ east: 0, north: 0, height: 0, crest: 0.5 }]);
    }
    expect(low.count).toBe(0);
  });

  it('holds no more drops than the tier allows', () => {
    const drops = new SprayDrops(96);
    sail(drops, 5, 40, 3);
    expect(drops.count).toBeLessThanOrEqual(96);
    expect(seeded(1)()).toBe(seeded(1)());
  });
});

describe('the spray’s glow', () => {
  it('set every frame, changes only its uniform’s value, in place', () => {
    const view = new SprayView(16);
    const material = view.mesh.material as Material;
    const version = material.version;
    const colour = (material as unknown as { colorNode: unknown }).colorNode;
    const opacity = (material as unknown as { opacityNode: unknown }).opacityNode;
    const value = view.glow.value;
    expect((value as Vector4).toArray()).toEqual([0, 0, 0, 0]);
    for (let i = 0; i < 1000; i++) {
      view.setGlow(0.38, 0.94, 0.81, (i % 100) / 99);
    }
    expect(view.mesh.material).toBe(material);
    expect(material.version).toBe(version);
    expect((material as unknown as { colorNode: unknown }).colorNode).toBe(colour);
    expect((material as unknown as { opacityNode: unknown }).opacityNode).toBe(opacity);
    expect(view.glow.value).toBe(value);
    expect((value as Vector4).w).toBe(1);
  });

  it('takes its colour as display values, and holds its strength from 0 to 1', () => {
    const view = new SprayView(16);
    view.setGlow(1, 0.5, 0, 3);
    const v = view.glow.value as Vector4;
    expect(v.x).toBeCloseTo(1, 6);
    expect(v.y).toBeCloseTo(0.214, 3);
    expect(v.z).toBeCloseTo(0, 6);
    expect(v.w).toBe(1);
    view.setGlow(1, 0.5, 0, -1);
    expect(v.w).toBe(0);
  });
});

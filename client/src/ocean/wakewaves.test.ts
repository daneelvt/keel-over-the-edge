// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { TIERS } from '../render/quality';
import { type HullShape, hullShape } from './hulls';
import { GRAVITY } from './spectrum';
import { trackWavelength, type WakeGrid, wakeAngle } from './wakemeasure';
import { wakeDamping } from './wakewaves';
import { immersion, type WakeDamping, WakeWavesReference } from './wakewavescpu';

const boat = catalog.boats[0] as (typeof catalog.boats)[number];

/** The Jolly boat's hull, from its model's own data. */
function shapeOf(): HullShape {
  const glb = readFileSync(new URL(`../../../art/${boat.art.model}`, import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    nodes: { name?: string; extras?: unknown }[];
  };
  return hullShape(json.nodes.find((n) => n.name === 'hull')?.extras) as HullShape;
}

const shape = shapeOf();

/**
 * A hull sailed north at speed m/s for seconds, its square following it as
 * the scene's does, stepped at rate a second; then the wake laid out about
 * its track: rows astern, columns off it.
 */
function sail(
  size: number,
  span: number,
  speed: number,
  seconds: number,
  rate = 30,
  damping: WakeDamping = wakeDamping(),
): { field: WakeWavesReference; grid: WakeGrid; north: number } {
  const field = new WakeWavesReference(size, span, damping);
  const texel = span / size;
  let north = 0;
  for (let i = 0; i <= Math.round(seconds * rate); i++) {
    const dt = i === 0 ? 0 : 1 / rate;
    north += speed * dt;
    const centre = Math.round((north - span / 4) / texel) * texel;
    field.press(shape, [{ east: 0, north, heading: 0, sink: 0 }], 0, centre);
    field.step(dt, 0, centre);
  }
  const astern: number[] = [];
  const off: number[] = [];
  const height: number[] = [];
  const slope: number[] = [];
  for (let col = 0; col < size; col++) {
    off.push((col + 0.5 - size / 2) * texel);
  }
  for (let row = 0; row < size; row++) {
    astern.push(north - field.at(0, row).north);
    for (let col = 0; col < size; col++) {
      const i = row * size + col;
      height.push(field.h[i] as number);
      slope.push(Math.hypot(field.east[i] as number, field.north[i] as number));
    }
  }
  return { field, grid: { astern, off, height, slope }, north };
}

/** The length of the waves across the track at a speed, by deep water's dispersion. */
const across = (speed: number): number => (2 * Math.PI * speed * speed) / GRAVITY;

describe('a hull', () => {
  test('is deepest amidships and nothing beside it or past its ends', () => {
    const stations = shape.stations;
    const aft = stations[0]?.[0] ?? 0;
    const fore = stations[stations.length - 1]?.[0] ?? 0;
    const middle = (aft + fore) / 2;
    expect(immersion(shape, 0, middle)).toBeGreaterThan(0.8 * boat.physics.hull.hullDraught);
    expect(immersion(shape, 0, middle)).toBeLessThanOrEqual(boat.physics.hull.hullDraught + 0.01);
    expect(immersion(shape, 0, aft + 0.01)).toBe(0);
    expect(immersion(shape, 0, fore - 0.01)).toBe(0);
    expect(immersion(shape, 0.7, middle)).toBe(0);
    // Its dent holds about the water it displaces.
    const field = new WakeWavesReference(128, 16, wakeDamping());
    field.press(shape, [{ east: 0, north: 0, heading: 0.7, sink: 0 }], 0, 0);
    const volume = field.pressure.reduce((s, d) => s + d, 0) * field.texel ** 2;
    const displaced = boat.physics.hull.displacement / 1025;
    expect(volume).toBeGreaterThan(0.6 * displaced);
    expect(volume).toBeLessThan(1.2 * displaced);
  });

  test('at rest sits in its dent and makes no waves', () => {
    const { field } = sail(64, 28, 0, 10);
    let beyond = 0;
    for (let i = 0; i < field.h.length; i++) {
      if ((field.pressure[i] as number) === 0) {
        beyond = Math.max(beyond, Math.abs(field.h[i] as number));
      }
    }
    expect(beyond).toBeLessThan(1e-12);
  });
});

describe('the wake’s waves', () => {
  test('keep a wave’s energy and run at deep water’s speed, whatever the step', () => {
    // A single wave across a square with no damping: after a time its
    // height has the phase √(gk) t, stepped in one step or in a hundred.
    const still: WakeDamping = { rim: 1e-9, rimRate: 0, rate: 0, fine: 0 };
    const n = 32;
    const span = 16;
    const k = (2 * Math.PI * 3) / span;
    const make = (): WakeWavesReference => {
      const f = new WakeWavesReference(n, span, still);
      f.step(0, 0, 0);
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          f.h[row * n + col] = 0.1 * Math.cos(k * (col + 0.5) * f.texel);
        }
      }
      return f;
    };
    const t = 2.3;
    const one = make();
    one.step(t, 0, 0);
    const many = make();
    for (let i = 0; i < 100; i++) {
      many.step(t / 100, 0, 0);
    }
    const omega = Math.sqrt(GRAVITY * k);
    for (let col = 0; col < n; col++) {
      // A standing wave released from rest: cos(kx) cos(ωt).
      const want = 0.1 * Math.cos(k * (col + 0.5) * one.texel) * Math.cos(omega * t);
      expect(one.h[col] as number).toBeCloseTo(want, 9);
      expect(many.h[col] as number).toBeCloseTo(want, 9);
    }
  });

  test('move with the water: a drift of whole texels moves them as they are', () => {
    const still: WakeDamping = { rim: 1e-9, rimRate: 0, rate: 0, fine: 0 };
    const n = 32;
    const f = new WakeWavesReference(n, 16, still);
    f.step(0, 0, 0);
    // A smooth hump, which the square's waves carry whole.
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        f.h[row * n + col] = 0.05 * Math.exp(-((col - 12) ** 2 + (row - 14) ** 2) / 8);
      }
    }
    const before = Array.from(f.h);
    f.step(0, 0, 0, 3, -2);
    // Three texels east and two south, with time standing still.
    expect(f.h[12 * n + 15] as number).toBeCloseTo(before[14 * n + 12] as number, 6);
    expect(f.h[13 * n + 16] as number).toBeCloseTo(before[15 * n + 13] as number, 6);
  });

  // The low tier's square, which runs the reference itself; the GPU's are
  // the same step, checked against it in the browser (look.spec.ts).
  const { size, span } = TIERS.low.wakeWaves;
  const most = (span / 2) * 0.85;

  test('make Kelvin’s V at a Froude number of a third, 19.5° either side of the track', () => {
    const { grid } = sail(size, span, 2, 40);
    const angle = wakeAngle(grid, 5, 30, most, across(2) / 2);
    expect(Math.abs(angle - 19.47)).toBeLessThan(2);
  });

  test('make waves across the track 2πU²/g long', () => {
    for (const speed of [2.5, 3.5]) {
      const { grid } = sail(size, span, speed, 40);
      const want = across(speed);
      const got = trackWavelength(grid, 3, 30, 0.6 * want, 1.5 * want);
      expect(Math.abs(got - want) / want).toBeLessThan(0.1);
    }
  });

  test('narrow at a Froude number of three quarters', () => {
    const slow = wakeAngle(sail(size, span, 2, 40).grid, 5, 30, most, across(2) / 2);
    const fast = wakeAngle(sail(size, span, 4.6, 40).grid, 5, 30, most, across(2) / 2);
    expect(fast).toBeLessThan(slow - 3);
  });
});

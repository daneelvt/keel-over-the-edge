// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { KOSCHMIEDER, type MistParams, mistDensity, mistDepth } from './mist';

const P: MistParams = {
  band: 7778.4,
  lip: 8334,
  sigma: KOSCHMIEDER / 300 - KOSCHMIEDER / 6000,
  height: 40,
};

/** A straight ray from (e0, n0, z0) to (e1, n1, z1), metres. */
interface Ray {
  name: string;
  from: [number, number, number];
  to: [number, number, number];
}

/** The integral of the density along the ray in 1,000 steps (the midpoint rule). */
function reference(ray: Ray, steps = 1000): number {
  const [e0, n0, z0] = ray.from;
  const [e1, n1, z1] = ray.to;
  const len = Math.hypot(e1 - e0, n1 - n0, z1 - z0);
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const e = e0 + (e1 - e0) * t;
    const n = n0 + (n1 - n0) * t;
    const z = z0 + (z1 - z0) * t;
    sum += mistDensity(Math.hypot(e, n), z, P);
  }
  return (sum * len) / steps;
}

function closed(ray: Ray): number {
  const [e0, n0, z0] = ray.from;
  const [e1, n1, z1] = ray.to;
  return mistDepth(
    {
      r0: Math.hypot(e0, n0),
      z0,
      rm: Math.hypot((e0 + e1) / 2, (n0 + n1) / 2),
      zm: (z0 + z1) / 2,
      r1: Math.hypot(e1, n1),
      z1,
      length: Math.hypot(e1 - e0, n1 - n0, z1 - z0),
    },
    P,
  );
}

const RAYS: Ray[] = [
  { name: 'level, inward from the lip', from: [0, 8330, 2], to: [0, 7600, 2] },
  { name: 'level, outward to the lip', from: [0, 7900, 6.5], to: [0, 8334, 0] },
  { name: 'level, in the band along it', from: [-300, 8100, 2], to: [300, 8100, 2] },
  { name: 'rising out of the band', from: [0, 8200, 2], to: [0, 8000, 300] },
  { name: 'falling to the falls', from: [0, 8300, 6.5], to: [0, 8380, -100] },
  { name: 'beyond the lip, down the falls', from: [0, 8350, 0], to: [0, 8360, -110] },
  { name: 'across the band from outside it', from: [0, 7000, 80], to: [0, 8334, 0] },
  { name: 'outside the band', from: [0, 3000, 5], to: [500, 3000, 0] },
  { name: 'diagonal across the band', from: [-400, 7800, 10], to: [400, 8250, 0] },
  { name: 'nearly level from the highest camera', from: [0, 8200, 80], to: [0, 7700, 79.99] },
];

describe('the mist', () => {
  it('is nothing outside the band', () => {
    expect(closed(RAYS[7] as Ray)).toBe(0);
  });

  it('matches the field integrated in 1,000 steps along each ray, within 2%', () => {
    for (const ray of RAYS) {
      const want = reference(ray);
      const got = closed(ray);
      expect(Math.abs(got - want), ray.name).toBeLessThanOrEqual(0.02 * want + 1e-9);
    }
  });
});

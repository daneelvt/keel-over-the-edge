// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOME_RADIUS } from '../render/materials';
import {
  KOSCHMIEDER,
  type MistFrame,
  type MistParams,
  mistAlong,
  mistDensityAt,
  type ScenePoint,
  visualRangeAt,
} from './mist';

const P: MistParams = {
  band: 7778.4,
  lip: 8334,
  sigma: KOSCHMIEDER / 300 - KOSCHMIEDER / 6000,
  height: 40,
};

/** The integral of the density along the scene ray from eye to p in 4,000 even steps. */
function reference(eye: ScenePoint, p: ScenePoint, f: MistFrame): number {
  const steps = 4_000;
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]] as const;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    sum += mistDensityAt([eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t], f, P);
  }
  return (sum * Math.hypot(d[0], d[1], d[2])) / steps;
}

interface Ray {
  name: string;
  eye: ScenePoint;
  to: ScenePoint;
  frame: MistFrame;
}

/** The sea's surface at scene (x, z), the dome curving it down from the eye's. */
const sea = (x: number, z: number): number => -(x * x + z * z) / (2 * DOME_RADIUS);

/**
 * The rays the game draws near the edge: from the deck and from cameras up
 * to 80 m, the eye at the scene's origin, north of the centre at each of
 * several distances, to the sea and to land 60 m up at distances out to
 * 3 km in four directions, and into the sky out to the sky's reach.
 */
function rays(): Ray[] {
  const out: Ray[] = [];
  for (const north of [7000, 7800, 8000, 8200, 8330]) {
    const frame: MistFrame = { origin: [0, north], dome: [0, 0] };
    for (const h of [2.5, 40, 80]) {
      const eye: ScenePoint = [0, h, 0];
      for (const az of [0, 1.2, 2.5, Math.PI]) {
        for (const d of [30, 100, 300, 800, 1500, 3000]) {
          const x = Math.sin(az) * d;
          const z = -Math.cos(az) * d;
          const name = `${north} m north, ${h} m up, ${az.toFixed(1)} rad, ${d} m`;
          out.push({ name, eye, to: [x, sea(x, z), z], frame });
          out.push({ name: `${name}, land`, eye, to: [x, sea(x, z) + 60, z], frame });
        }
        for (const el of [0.002, 0.01, 0.035, 0.09, 0.26, 0.8, 1.57]) {
          const c = Math.cos(el) * 1000;
          out.push({
            name: `${north} m north, ${h} m up, ${az.toFixed(1)} rad, sky at ${el}`,
            eye,
            to: [Math.sin(az) * c, h + Math.sin(el) * 1000, -Math.cos(az) * c],
            frame,
          });
        }
      }
    }
  }
  return out;
}

describe('the mist', () => {
  it('is nothing outside the band', () => {
    const frame: MistFrame = { origin: [0, 3000], dome: [0, 0] };
    expect(mistAlong([0, 5, 0], [500, 0, 0], frame, P)).toBe(0);
  });

  it('lets through the light a 4,000-step integral does, within 0.02, along every ray drawn', () => {
    let worst = 0;
    let worstRay = '';
    for (const r of rays()) {
      const want = Math.exp(-reference(r.eye, r.to, r.frame));
      const got = Math.exp(-mistAlong(r.eye, r.to, r.frame, P));
      if (Math.abs(got - want) > worst) {
        worst = Math.abs(got - want);
        worstRay = r.name;
      }
    }
    expect(worst, worstRay).toBeLessThanOrEqual(0.02);
  });

  it('takes nearly all the light at the lip, looking along it', () => {
    const frame: MistFrame = { origin: [0, 8330], dome: [0, 0] };
    const tau = mistAlong([0, 2.5, 0], [800, sea(800, 0), 0], frame, P);
    expect(Math.exp(-tau)).toBeLessThan(0.05);
  });
});

/** The server's visual range at radii across the disk (go test ./internal/physics writes it). */
const golden = new URL('../../../internal/physics/testdata/visibility.json', import.meta.url);

describe('the mist band’s visual range', () => {
  it('is the server’s, to a centimetre, at every radius', () => {
    const g = JSON.parse(readFileSync(golden, 'utf8')) as {
      visibility: { Band: number; Lip: number; Clear: number; Range: number };
      radii: number[];
      ranges: number[];
    };
    const v = g.visibility;
    const p: MistParams = {
      band: v.Band,
      lip: v.Lip,
      sigma: KOSCHMIEDER / v.Range - KOSCHMIEDER / v.Clear,
      height: 40,
    };
    expect(g.radii.length).toBe(200);
    g.radii.forEach((r, i) => {
      expect(Math.abs(visualRangeAt(r, v.Clear, p) - (g.ranges[i] ?? 0)), `${r} m`).toBeLessThan(
        0.01,
      );
    });
  });
});

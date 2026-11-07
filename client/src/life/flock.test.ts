// SPDX-License-Identifier: AGPL-3.0-only

// A group of the sea's life is where the server says it is: every case of
// internal/life/testdata/flocks.json, its middle at each tick within a
// micrometre.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeSeen } from '../net/messages';
import { type FlockPlace, flockAt } from './flock';

interface Record {
  ID: number;
  Kind: number;
  Start: number;
  End: number;
  East: number;
  North: number;
  Heading: number;
  Speed: number;
  Count: number;
  Seed: number;
  Boat: number;
}

interface Case {
  record: Record;
  pose?: { X: number; Y: number; Heading: number };
  at: { tick: number; alive: boolean; x?: number; y?: number; z?: number }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/life/testdata/flocks.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('flockAt', () => {
  test('the file has a case of each path, and one with a boat', () => {
    const paths = new Set(file.cases.map((c) => catalog.life.kinds[c.record.Kind]?.path));
    expect(paths.size).toBeGreaterThanOrEqual(3);
    expect(file.cases.some((c) => c.record.Boat !== 0)).toBe(true);
  });
  test.each(file.cases.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    const r = c.record;
    const kind = catalog.life.kinds[r.Kind];
    expect(kind).toBeDefined();
    if (kind === undefined) {
      return;
    }
    const rec: LifeSeen = {
      id: String(r.ID),
      rev: 0,
      kind: r.Kind,
      start: r.Start,
      end: r.End,
      east: r.East,
      north: r.North,
      heading: r.Heading,
      speed: r.Speed,
      count: r.Count,
      seed: r.Seed,
      with: r.Boat === 0 ? 0 : 1,
    };
    const pose =
      c.pose === undefined ? null : { east: c.pose.X, north: c.pose.Y, heading: c.pose.Heading };
    const out: FlockPlace = { east: 0, north: 0, up: 0 };
    for (const at of c.at) {
      const alive = flockAt(rec, kind, at.tick, pose, out);
      expect(alive).toBe(at.alive);
      if (alive) {
        expect(Math.abs(out.east - (at.x ?? 0))).toBeLessThan(1e-6);
        expect(Math.abs(out.north - (at.y ?? 0))).toBeLessThan(1e-6);
        expect(Math.abs(out.up - (at.z ?? 0))).toBeLessThan(1e-6);
      }
    }
  });
});

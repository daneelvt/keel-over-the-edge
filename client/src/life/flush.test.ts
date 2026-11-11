// SPDX-License-Identifier: AGPL-3.0-only

// The fish a boat flushes from a ground are those the server flushes:
// every case of internal/life/testdata/flushes.json, with the ground's
// reach.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeSeen } from '../net/messages';
import { flush, flushSlot, inGround, patchOf } from './flush';

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
  Over: number;
}

interface Case {
  ground: Record;
  reach: number;
  boat: string;
  slot: number;
  bow: { X: number; Y: number; Heading: number };
  now: number;
  flush?: Record;
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/life/testdata/flushes.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('flush', () => {
  test('the file has flushes and slots with none, and boats past a JavaScript number', () => {
    expect(file.cases.some((c) => c.flush !== undefined)).toBe(true);
    expect(file.cases.some((c) => c.flush === undefined)).toBe(true);
    expect(file.cases.some((c) => BigInt(c.boat) > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
  });
  test('the flushes slot', () => {
    expect(flushSlot(catalog.life, 0)).toBe(0);
    expect(flushSlot(catalog.life, catalog.life.flush.every * 30)).toBe(1);
  });
  test.each(file.cases.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    const g = c.ground;
    const kind = catalog.life.kinds[g.Kind];
    expect(kind).toBeDefined();
    if (kind === undefined) {
      return;
    }
    const ground: LifeSeen = {
      id: String(g.ID),
      rev: 0,
      kind: g.Kind,
      start: g.Start,
      end: g.End,
      east: g.East,
      north: g.North,
      heading: g.Heading,
      speed: g.Speed,
      count: g.Count,
      seed: g.Seed,
      with: 0,
      over: '',
    };
    expect(Math.abs(patchOf(kind, g.Seed) - c.reach)).toBeLessThan(1e-9);
    expect(inGround(ground, c.reach, g.East + c.reach * 0.6, g.North + c.reach * 0.79)).toBe(true);
    expect(inGround(ground, c.reach, g.East + c.reach * 0.6, g.North + c.reach * 0.81)).toBe(false);
    const bow = { east: c.bow.X, north: c.bow.Y, heading: c.bow.Heading };
    const got = flush(catalog.life, kind, ground, BigInt(c.boat), c.slot, bow, c.now);
    const want = c.flush;
    if (want === undefined) {
      expect(got).toBeNull();
      return;
    }
    expect(got).not.toBeNull();
    if (got === null) {
      return;
    }
    expect(got.kind).toBe(want.Kind);
    expect(got.start).toBe(want.Start);
    expect(got.end).toBe(want.End);
    expect(Math.abs(got.east - want.East)).toBeLessThan(1e-6);
    expect(Math.abs(got.north - want.North)).toBeLessThan(1e-6);
    expect(got.heading).toBe(want.Heading);
    expect(got.speed).toBe(want.Speed);
    expect(got.count).toBe(want.Count);
    expect(got.seed).toBe(want.Seed);
    expect(got.over).toBe(String(want.Over));
    expect(got.with).toBe(0);
  });
});

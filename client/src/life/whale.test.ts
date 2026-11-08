// SPDX-License-Identifier: AGPL-3.0-only

// A whale blows, breaches, slaps and flukes when the server says: every
// case of internal/life/testdata/whales.json, each whale's events at the
// same times to a nanosecond.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeSeen } from '../net/messages';
import { newBout, round, WHALE_BLOW, whaleEvents } from './whale';

interface Case {
  record: { Kind: number; Start: number; End: number; Seed: number; Count: number };
  whales: { event: number; at: number }[][];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/life/testdata/whales.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

function record(c: Case): LifeSeen {
  const r = c.record;
  return {
    id: '1',
    rev: 0,
    kind: r.Kind,
    start: r.Start,
    end: r.End,
    east: 0,
    north: 0,
    heading: 0,
    speed: 1,
    count: r.Count,
    seed: r.Seed,
    with: 0,
    over: '',
  };
}

describe('whaleEvents', () => {
  test('the file has every whale kind', () => {
    const whales = catalog.life.kinds.filter((k) => k.form === 'whale').length;
    expect(new Set(file.cases.map((c) => c.record.Kind)).size).toBe(whales);
  });
  test.each(file.cases.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    const kind = catalog.life.kinds[c.record.Kind];
    expect(kind).toBeDefined();
    if (kind === undefined) {
      return;
    }
    const e = record(c);
    const life = (e.end - e.start) / 30;
    c.whales.forEach((want, i) => {
      const got: { event: number; at: number }[] = [];
      whaleEvents(kind, e, i, 0, life, (event, at) => got.push({ event, at }));
      expect(got.length).toBe(want.length);
      got.forEach((g, j) => {
        expect(g.event).toBe(want[j]?.event);
        expect(Math.abs(g.at - (want[j]?.at ?? Number.NaN))).toBeLessThan(1e-9);
      });
    });
  });
  test('events found in pieces are the events found whole', () => {
    const c = file.cases[0] as Case;
    const kind = catalog.life.kinds[c.record.Kind];
    if (kind === undefined) {
      throw new Error('no kind');
    }
    const e = record(c);
    const life = (e.end - e.start) / 30;
    const whole: number[] = [];
    whaleEvents(kind, e, 0, 0, life, (_, at) => whole.push(at));
    const pieces: number[] = [];
    for (let u = 0; u < life; u += 7.3) {
      whaleEvents(kind, e, 0, u, u + 7.3, (_, at) => pieces.push(at));
    }
    expect(pieces.sort((a, b) => a - b)).toEqual(whole.sort((a, b) => a - b));
  });
  test("a blow is at its bout's start or a gap after", () => {
    const c = file.cases[0] as Case;
    const kind = catalog.life.kinds[c.record.Kind];
    if (kind === undefined) {
      throw new Error('no kind');
    }
    const e = record(c);
    const life = (e.end - e.start) / 30;
    const b = newBout();
    whaleEvents(kind, e, 0, 0, life, (event, at) => {
      if (event !== WHALE_BLOW) {
        return;
      }
      expect(round(kind, e.seed, 0, at, life, b)).toBe(true);
      const j = (at - b.start) / b.every;
      expect(Math.abs(j - Math.round(j))).toBeLessThan(1e-6);
    });
  });
});

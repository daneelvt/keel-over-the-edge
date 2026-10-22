// SPDX-License-Identifier: AGPL-3.0-only

// The page's rule of a fog signal against the server's golden schedule
// (internal/light/testdata/schedule.json, which go test ./internal/light
// writes): the same blasts at the same moments for every pattern and phase,
// and the same pattern for every light of a world.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { assignFogSignals, blastAt, blastsBetween } from './fogsignal';

const golden = new URL('../../../internal/light/testdata/schedule.json', import.meta.url);

interface Golden {
  times: number[];
  phases: number[];
  fogSignals: {
    notation: string;
    device: string;
    steps: number[];
    on: string[];
    starts: number[][];
  }[];
  assignment: { places: [number, number][]; devices: string[]; apart: number; signals: number[] };
}

const g = JSON.parse(readFileSync(golden, 'utf8')) as Golden;

describe('a fog signal', () => {
  test('blasts as the server’s golden schedule says, bit for bit', () => {
    expect(g.fogSignals.map((s) => s.notation)).toEqual(
      catalog.world.lights.fogSignals.map((s) => s.notation),
    );
    for (const s of g.fogSignals) {
      g.phases.forEach((phase, k) => {
        let got = '';
        const starts: number[] = [];
        for (const t of g.times) {
          const start = blastAt(s.steps, phase, t);
          got += start === null ? '0' : '1';
          if (start !== null) {
            starts.push(start);
          }
        }
        expect(got, `${s.notation} with phase ${phase}`).toBe(s.on[k]);
        expect(starts, `${s.notation}'s blasts' starts`).toEqual(s.starts[k]);
      });
    }
  });

  test('lists the blasts that begin in a stretch of time', () => {
    const steps = [2000, 2000, 2000, 24000];
    expect(blastsBetween(steps, 0, 0, 60_000_000)).toEqual([
      { start: 0, end: 2_000_000 },
      { start: 4_000_000, end: 6_000_000 },
      { start: 30_000_000, end: 32_000_000 },
      { start: 34_000_000, end: 36_000_000 },
    ]);
    expect(blastsBetween(steps, 1_000_000, 1, 30_000_000)).toEqual([
      { start: 3_000_000, end: 5_000_000 },
      { start: 29_000_000, end: 31_000_000 },
    ]);
  });

  test('is assigned to each light as the server assigns it', () => {
    const a = g.assignment;
    const patterns = catalog.world.lights.fogSignals.map((s) => s.device);
    expect(assignFogSignals(a.places, a.devices, patterns, a.apart)).toEqual(a.signals);
  });
});

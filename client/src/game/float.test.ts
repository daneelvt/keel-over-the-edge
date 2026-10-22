// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { RECORDS } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { KNOT, Sandbox, START } from '../sandbox/sandbox';
import { type DrawnBoat, newDrawnBoat } from './fleet';
import { Floater } from './float';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;
const hull = catalog.boats[0].physics.hull;
const S = RECORDS.state;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
});

/** A sandbox in a wind of knots from the north and its sea, the boat reaching east. */
function inSea(knots: number): Sandbox {
  return new Sandbox(physics, catalog.boats[0].physics, catalog.weather, catalog.world, {
    ...START,
    wind: { speed: knots * KNOT, from: 0 },
  });
}

function boatAt(s: Sandbox, slot: number): DrawnBoat {
  const c = s.states.current;
  return {
    ...newDrawnBoat(),
    slot,
    east: c[S.x] ?? 0,
    north: c[S.y] ?? 0,
    heading: c[S.heading] ?? 0,
  };
}

describe('the other boats on the sea', () => {
  test('a boat new to the view lies on the water under it, at rest', () => {
    const s = inSea(34);
    const f = new Floater(physics, s.seas, catalog.boats);
    const b = boatAt(s, 3);
    b.east = 40;
    b.north = -25;
    f.apply([b], 1, 500.25, 1 / 60);
    physics.seaDrawAt(500.25);
    const w = physics.waveUnder(
      s.seas.slotAt(501),
      40,
      -25,
      b.heading,
      hull.waterlineLength,
      hull.waterlineBeam,
    );
    expect(b.heave).toBe(w[RECORDS.wave.height]);
    expect(b.pitch).toBe(w[RECORDS.wave.ahead]);
    expect(Math.abs(b.heave)).toBeGreaterThan(0.01);
  });

  test('with no sea a boat floats level', () => {
    const s = inSea(34);
    s.sea.options.flat = true;
    s.settleSea();
    const f = new Floater(physics, s.seas, catalog.boats);
    const b = boatAt(s, 0);
    b.heave = 3;
    f.apply([b], 1, 100, 1 / 60);
    expect([b.heave, b.pitch]).toEqual([0, 0]);
  });

  test('a boat leaving the view, and one of an unknown kind, do not disturb the others', () => {
    const s = inSea(20);
    const f = new Floater(physics, s.seas, catalog.boats);
    const ghost = boatAt(s, -1);
    const odd = { ...boatAt(s, 5), kind: 99 };
    f.apply([ghost, odd], 2, 10, 1 / 60);
    expect(ghost.heave).not.toBe(0);
    expect([odd.heave, odd.pitch]).toEqual([0, 0]);
  });

  // How far the float is from the boat's own heave and pitch, which the
  // server computes and does not send: the boat sailed in the sandbox is
  // floated as another client would float it.
  for (const [name, knots, limit] of [
    ['a breeze', 12, { heave: 0.05, pitch: 2 }],
    ['a gale', 34, { heave: 0.1, pitch: 3 }],
  ] as const) {
    test(`stays within ${limit.heave * 100} cm and ${limit.pitch}° of the boat's own motion in ${name}`, () => {
      const s = inSea(knots);
      const f = new Floater(physics, s.seas, catalog.boats);
      const gaps: { heave: number[]; pitch: number[] } = { heave: [], pitch: [] };
      let highest = 0;
      for (let i = 0; i < 3600; i++) {
        s.step(0, 0.5);
        const c = s.states.current;
        const b = boatAt(s, 0);
        f.apply([b], 1, s.tick, 1 / 30);
        if (i >= 300) {
          gaps.heave.push(Math.abs(b.heave - (c[S.heave] ?? 0)));
          gaps.pitch.push((Math.abs(b.pitch - (c[S.pitch] ?? 0)) * 180) / Math.PI);
          highest = Math.max(highest, Math.abs(c[S.heave] ?? 0));
        }
      }
      const p99 = (v: number[]): number =>
        v.sort((a, b) => a - b)[Math.floor(0.99 * v.length)] ?? 0;
      const report = {
        heave99: p99(gaps.heave),
        heaveMax: Math.max(...gaps.heave),
        pitch99: p99(gaps.pitch),
        pitchMax: Math.max(...gaps.pitch),
      };
      // Seen with --reporter=verbose; the numbers are in the pull request.
      expect(highest).toBeGreaterThan(knots > 20 ? 0.3 : 0.05);
      expect(report.heave99, JSON.stringify(report)).toBeLessThan(limit.heave);
      expect(report.pitch99, JSON.stringify(report)).toBeLessThan(limit.pitch);
    });
  }
});

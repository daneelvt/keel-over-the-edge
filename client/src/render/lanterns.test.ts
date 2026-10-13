// SPDX-License-Identifier: AGPL-3.0-only

import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { ARC_FADE, Lanterns, lanternLit, lightWeights, SIDELIGHT_ARC } from './lanterns';

const DEG = Math.PI / 180;
const w = { red: 0, green: 0, white: 0 };

describe('a tricolour lantern’s arcs', () => {
  test('every degree round the boat shows exactly one colour, but within 2° of an edge, where two', () => {
    for (let b = -180; b < 180; b += 0.25) {
      lightWeights(b, ['tricolour'], w);
      const shown = [w.red, w.green, w.white].filter((x) => x > 1e-9);
      expect(w.red + w.green + w.white).toBeCloseTo(1, 12);
      const edge = Math.min(Math.abs(b), Math.abs(Math.abs(b) - SIDELIGHT_ARC));
      if (edge >= ARC_FADE / 2) {
        expect(shown, `at ${b}°`).toHaveLength(1);
      } else {
        expect(shown.length, `at ${b}°`).toBeLessThanOrEqual(2);
      }
    }
  });

  test('green to starboard and red to port, to 22.5° abaft the beam; white astern', () => {
    expect(lightWeights(45, ['tricolour'], w)).toEqual({ red: 0, green: 1, white: 0 });
    expect(lightWeights(-45, ['tricolour'], w)).toEqual({ red: 1, green: 0, white: 0 });
    expect(lightWeights(110, ['tricolour'], w).green).toBe(1);
    expect(lightWeights(115, ['tricolour'], w).white).toBe(1);
    expect(lightWeights(-115, ['tricolour'], w).white).toBe(1);
    // White alone from right astern.
    expect(lightWeights(180, ['tricolour'], w)).toEqual({ red: 0, green: 0, white: 1 });
    // Red and green both from right ahead.
    lightWeights(0, ['tricolour'], w);
    expect(w.red).toBeCloseTo(0.5, 12);
    expect(w.green).toBeCloseTo(0.5, 12);
  });

  test('a boat shows only the lights it carries', () => {
    expect(lightWeights(45, ['port', 'stern'], w)).toEqual({ red: 0, green: 0, white: 0 });
    expect(lightWeights(-45, ['port', 'stern'], w).red).toBe(1);
  });
});

describe('the lanterns drawn', () => {
  /** The bearing the lantern writes for a camera, as the shader reads it. */
  const bearingOf = (l: Lanterns): number => (l.place.array as Float32Array)[3] ?? Number.NaN;

  test('measure the arcs in the boat’s own frame, its heel and pitch included', () => {
    const l = new Lanterns();
    l.setLantern(new Vector3(0, 6.3, -0.95), 0.3, ['tricolour']);
    const pose = { east: 0, north: 0, heading: 90 * DEG, heel: 0, pitch: 0, heave: 0 };
    // Heading east: a camera to the north, far off, is on the port beam.
    const camera = new Vector3(0, 6, -300);
    l.begin();
    l.add(pose, 0, 0, camera, 1);
    expect(bearingOf(l)).toBeCloseTo(-90, 0);
    for (const heel of [-30, 30]) {
      for (const pitch of [-5, 5]) {
        for (const [cam, want] of [
          [new Vector3(400, 6, 0), 0],
          [new Vector3(-400, 6, 0), 180],
          [new Vector3(0, 6, 400), 90],
          [new Vector3(0, 6, -400), -90],
        ] as const) {
          l.begin();
          l.add({ ...pose, heel: heel * DEG, pitch: pitch * DEG }, 0, 0, cam, 1);
          const b = bearingOf(l);
          const off = Math.abs(((b - want + 540) % 360) - 180);
          // Heeled 30°, a light still shows over its own arc, as the boat
          // carries it: the bearing is the boat's.
          expect(off, `heel ${heel}°, pitch ${pitch}°, toward ${want}°`).toBeLessThan(6);
          lightWeights(b, ['tricolour'], w);
          const colour = want === 0 ? 'both' : want === 180 ? 'white' : want > 0 ? 'green' : 'red';
          if (colour === 'white') {
            expect(w.white).toBe(1);
          } else if (colour !== 'both') {
            expect(w[colour]).toBe(1);
          }
        }
      }
    }
  });

  test('are lit only below the sun’s last degree, and none unlit is drawn', () => {
    expect(lanternLit(2 * DEG)).toBe(0);
    expect(lanternLit(0.5 * DEG)).toBeCloseTo(0.5, 12);
    expect(lanternLit(-DEG)).toBe(1);
    const l = new Lanterns();
    l.setLantern(new Vector3(0, 6.3, -0.95), 0.3, ['tricolour']);
    l.begin();
    l.add(
      { east: 0, north: 0, heading: 0, heel: 0, pitch: 0, heave: 0 },
      0,
      0,
      new Vector3(10, 5, 10),
      0,
    );
    expect(l.count).toBe(0);
  });
});

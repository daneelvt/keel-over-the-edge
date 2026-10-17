// SPDX-License-Identifier: AGPL-3.0-only

import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { lightOn } from '../lights/character';
import { glowStrength, Lighthouses, lanternSeen, lightLit, towerGeometry } from './lights';
import { horizonDistance } from './materials';

const DEG = Math.PI / 180;
const lighthouse = catalog.world.places.kinds.findIndex((k) => k.site === 'light');

/** A frame at world time t, the camera 3 m up at the origin, the sun below the horizon or above. */
function frame(t: number, sun: number, camera = new Vector3(0, 3, 0)) {
  return {
    origin: { x: 0, y: 0 },
    camera,
    worldUs: t,
    now: t / 1000,
    sunAt: () => sun,
    mist: { band: 7778, lip: 8334, sigma: 0, height: 40 },
    dome: [0, 0] as [number, number],
    fovY: 50,
    height: 600,
    on: true,
  };
}

describe('a lighthouse’s tower', () => {
  test('stands a metre high, its lantern at the top, on the ground', () => {
    const g = towerGeometry();
    g.computeBoundingBox();
    const b = g.boundingBox;
    expect(b?.min.y).toBeCloseTo(0, 6);
    expect(b?.max.y).toBeGreaterThan(1);
    expect(b?.max.y).toBeLessThan(1.15);
    expect(g.getAttribute('part')).toBeDefined();
  });

  test('rises over the horizon where the dome says', () => {
    const focal = 36;
    const d = horizonDistance(2) + horizonDistance(focal);
    expect(lanternSeen(d - 1, 2, focal)).toBe(true);
    expect(lanternSeen(d + 1, 2, focal)).toBe(false);
  });
});

describe('a light', () => {
  test('is lit through the sun’s last degree', () => {
    expect(lightLit(2 * DEG)).toBe(0);
    expect(lightLit(0.5 * DEG)).toBeCloseTo(0.5, 9);
    expect(lightLit(-3 * DEG)).toBe(1);
  });

  test('grows with its illuminance over the threshold, faint at its range', () => {
    expect(glowStrength(0)).toBe(0);
    expect(glowStrength(1)).toBeCloseTo(0.2, 9);
    expect(glowStrength(10)).toBeGreaterThan(glowStrength(2));
    expect(glowStrength(1e6)).toBe(1);
  });

  test('shows its character by world time, a glow near and a loom on the horizon at its bearing far off', () => {
    const l = new Lighthouses(catalog.world.lights, lighthouse);
    const ch = catalog.world.lights.characters[3];
    if (ch === undefined) {
      throw new Error('no character');
    }
    // A light 300 m north, its lantern 30 m up: above the horizon.
    l.setLights(
      [{ number: 1, east: 0, north: 300, focal: 30, character: 3, phase: 0, range: 4630 }],
      'all',
    );
    const modes = (): number[] => {
      const p = l.place.array as Float32Array;
      return Array.from({ length: l.count }, (_, k) => p[k * 4 + 3] ?? -1);
    };
    // Its glow shows mid-flash and not mid-eclipse; its beams turn throughout.
    let shown = 0;
    for (let t = 0; t < 15_000_000; t += 250_000) {
      l.frame(frame(t, -0.2));
      const glow = modes().includes(0);
      if (!lightOn(ch.steps, 0, t)) {
        expect(glow, `at ${t}`).toBe(false);
      } else if (t % 15_000_000 > 400_000 && t % 15_000_000 < 1_600_000) {
        expect(glow, `at ${t}`).toBe(true);
        shown++;
      }
      expect(modes().filter((m) => m === 2).length, `at ${t}`).toBe(2);
    }
    expect(shown).toBeGreaterThan(0);
    // By day, nothing.
    l.frame(frame(500_000, 0.5));
    l.frame({ ...frame(500_000, 0.5), now: 1e9 });
    expect(l.count).toBe(0);
    // 3 km east, below the horizon: its loom, on the horizon to the east.
    l.setLights(
      [{ number: 2, east: 3000, north: 0, focal: 30, character: 3, phase: 0, range: 4630 }],
      'all',
    );
    l.frame(frame(500_000, -0.2));
    expect(l.count).toBe(1);
    const p = l.place.array as Float32Array;
    expect(p[3]).toBe(1); // a loom
    expect(Math.atan2(p[0] ?? 0, -(p[2] ?? 0))).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.hypot(p[0] ?? 0, p[2] ?? 0)).toBeCloseTo(0.97 * horizonDistance(3), 3);
  });

  test('is dimmer further off, by Allard’s law', () => {
    const l = new Lighthouses(catalog.world.lights, lighthouse);
    const strength = (north: number): number => {
      l.setLights(
        [{ number: 1, east: 0, north, focal: 30, character: 3, phase: 0, range: 4630 }],
        'all',
      );
      l.frame(frame(500_000, -0.2, new Vector3(0, 500, 0)));
      return (l.shows.array as Float32Array)[3] ?? 0;
    };
    expect(strength(1000)).toBeGreaterThan(strength(4000));
  });

  test('keeps the lighthouses handed, and drops lights as told', () => {
    const l = new Lighthouses(catalog.world.lights, lighthouse);
    const p = {
      number: 9,
      kind: lighthouse,
      east: 1,
      north: 2,
      heading: 0,
      ground: 3,
      tower: 30,
      daymark: 1,
      rig: 0,
      age: 0,
      sunk: false,
      heel: 0,
    };
    l.setPlaces([p, { ...p, number: 10, kind: lighthouse + 1 }]);
    expect([...l.sites.keys()]).toEqual([9]);
    l.setLights([{ number: 1, east: 0, north: 0, focal: 1, character: 0, phase: 0, range: 1 }], []);
    l.setLights(
      [{ number: 2, east: 0, north: 0, focal: 1, character: 0, phase: 0, range: 1 }],
      [1],
    );
    expect([...l.lights.keys()]).toEqual([2]);
    l.frame(frame(0, -1));
    expect(l.towers.count).toBe(1);
  });
});

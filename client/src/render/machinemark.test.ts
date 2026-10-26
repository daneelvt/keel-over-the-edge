// SPDX-License-Identifier: AGPL-3.0-only

// The machine mark: a cog of eight flat-topped teeth on a solid ring
// about a round hole; a quarter of the foot across, round in metres, at
// half the luff's height on the middle of the chord there, inside the
// sail, on each boat's model; its ink against the cloth's; and the fleet's
// per-instance flag, which follows each drawn boat's.

import { readFileSync } from 'node:fs';
import { BufferGeometry, Float32BufferAttribute, type Mesh, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { newDrawnBoat } from '../game/fleet';
import { CLOTH } from './boat';
import type { FloatingOrigin } from './coords';
import { FleetView } from './fleet';
import {
  COG_ACROSS,
  COG_HOLE,
  COG_ROOT,
  COG_TEETH,
  chordAtHalf,
  cogOutline,
  luminance,
  MARK_DARK,
  MARK_GOLD,
  markInk,
  markPlace,
  onCog,
} from './machinemark';

const outline = cogOutline();

/** The runs of inked points round a circle of radius r, and how many of the samples are inked. */
function runs(r: number, samples = 1440): { runs: number; inked: number } {
  let n = 0;
  let inked = 0;
  let last = onCog(outline, r, 0);
  const first = last;
  for (let i = 0; i < samples; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / samples;
    const on = onCog(outline, r * Math.cos(a), r * Math.sin(a));
    if (on) {
      inked++;
    }
    if (on && !last) {
      n++;
    }
    last = on;
  }
  if (first && !last) {
    n++;
  }
  return { runs: n, inked };
}

describe('the cog', () => {
  test('has eight teeth, standing on a solid ring about a hole', () => {
    expect(COG_TEETH).toBe(8);
    // Through the teeth: eight separate runs of ink, near the tips too.
    expect(runs((COG_ROOT + 1) / 2).runs).toBe(8);
    expect(runs(0.97).runs).toBe(8);
    // The ring: inked all round.
    const ring = runs((COG_HOLE + COG_ROOT) / 2);
    expect(ring.inked).toBe(1440);
    // The hole and outside the tips: no ink.
    expect(onCog(outline, 0, 0)).toBe(false);
    expect(runs(COG_HOLE * 0.9).inked).toBe(0);
    expect(runs(1.01).inked).toBe(0);
  });

  test('its teeth are short, broad and flat-topped, not rays', () => {
    // At the tips each tooth is a third of its spacing wide, at the root
    // over half: short, broad teeth, not a sunburst's or a compass rose's points.
    const tip = runs(0.99).inked / 1440;
    const root = runs(COG_ROOT + 0.01).inked / 1440;
    expect(tip).toBeGreaterThan(0.3);
    expect(tip).toBeLessThan(0.4);
    expect(root).toBeGreaterThan(0.5);
    expect(root).toBeLessThan(0.6);
    expect(COG_ROOT).toBeGreaterThan(0.7);
    let most = 0;
    for (let i = 0; i < outline.length; i += 2) {
      most = Math.max(most, Math.hypot(outline[i] ?? 0, outline[i + 1] ?? 0));
    }
    expect(most).toBeCloseTo(1, 9);
  });

  test('is the same mirrored, as the sail’s back face shows it', () => {
    for (let i = 0; i < 2000; i++) {
      const x = Math.cos(i * 1.7) * ((i % 97) / 96);
      const y = Math.sin(i * 1.3) * ((i % 89) / 88);
      expect(onCog(outline, -x, y)).toBe(onCog(outline, x, y));
    }
  });
});

describe('the ink', () => {
  test('is dark on the light cloth, gold on a dark one, and stands out from either', () => {
    expect(markInk(CLOTH)).toBe(MARK_DARK);
    expect(markInk('#2a3348')).toBe(MARK_GOLD);
    expect(markInk('#5b2a22')).toBe(MARK_GOLD);
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    expect(contrast(CLOTH, markInk(CLOTH))).toBeGreaterThan(7);
    expect(contrast('#2a3348', markInk('#2a3348'))).toBeGreaterThan(4.5);
  });
});

/** A triangular sail's mesh as the boats' models are made: uv the cloth's, uv1 the chord's and the luff's fractions. */
function sailMesh(chord: (v: number) => number, rows: number, cols: number): BufferGeometry {
  const uv: number[] = [];
  const uv1: number[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      uv.push((j / cols) * chord(i / rows), i / rows);
      uv1.push(j / cols, i / rows);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new Float32BufferAttribute(uv1, 2));
  return g;
}

async function modelSail(path: string): Promise<BufferGeometry> {
  const glb = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
    '',
  );
  let sail: BufferGeometry | null = null;
  gltf.scene.getObjectByName('sail')?.traverse((o) => {
    if ((o as Mesh).isMesh && sail === null) {
      sail = (o as Mesh).geometry;
    }
  });
  if (sail === null) {
    throw new Error(`no sail in ${path}`);
  }
  return sail;
}

describe('the mark’s place', () => {
  test('the chord at half height, read off the sail’s leech', () => {
    // A straight leech: half the foot; a roached one, more.
    expect(chordAtHalf(sailMesh((v) => 1 - v, 8, 3))).toBeCloseTo(0.5, 6);
    expect(chordAtHalf(sailMesh((v) => 1 - v + 0.1 * Math.sin(Math.PI * v), 7, 3))).toBeCloseTo(
      0.6,
      1,
    );
    expect(chordAtHalf(undefined)).toBe(0.5);
  });

  test('a quarter of the foot across, round in metres, at half height mid-chord', () => {
    const { foot, luff } = { foot: 2.74, luff: 5.13 };
    const p = markPlace(foot, luff, 0.56);
    expect(2 * p.ru * foot).toBeCloseTo(COG_ACROSS * foot, 9);
    expect(2 * p.ru * foot).toBeCloseTo(0.685, 3);
    expect(p.rv * luff).toBeCloseTo(p.ru * foot, 9);
    expect(p.u).toBeCloseTo(0.28, 9);
    expect(p.v).toBe(0.5);
  });

  describe.each(catalog.boats.map((b) => [b.name, b] as const))('on %s', (_, boat) => {
    const { foot, luff } = boat.physics.rig;
    test.each([
      ['near', boat.art.model],
      ['far', boat.art.far],
    ])('the %s model’s sail holds the whole mark', async (_, path) => {
      const sail = await modelSail(path);
      const p = markPlace(foot, luff, chordAtHalf(sail));
      expect(2 * p.ru * foot).toBeCloseTo(foot / 4, 9);
      // Clear of the luff, and of the leech at the cog's top, where the
      // chord is shortest: the leech's uv.x at the fraction of the luff.
      expect(p.u - p.ru).toBeGreaterThan(0.05);
      const top = p.v + p.rv;
      const leech = new Vector3();
      const uv = sail.getAttribute('uv');
      const uv1 = sail.getAttribute('uv1');
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < uv1.count; i++) {
        if (uv1.getX(i) > 0.999 && uv1.getY(i) >= top && uv1.getY(i) - top < best) {
          best = uv1.getY(i) - top;
          leech.set(uv.getX(i), uv1.getY(i), 0);
        }
      }
      expect(p.u + p.ru).toBeLessThan(leech.x);
      // The near model's chord at half height: the foot's half and the roach.
      if (path === boat.art.model) {
        expect(chordAtHalf(sail)).toBeGreaterThan(0.5);
        expect(chordAtHalf(sail)).toBeLessThan(0.6);
      }
    });
  });
});

describe('the fleet’s flag', () => {
  test('follows each drawn boat’s, instance by instance', () => {
    const view = new FleetView(catalog.boats[0] as (typeof catalog.boats)[number]);
    const origin = { world: { x: 0, y: 0 } } as unknown as FloatingOrigin;
    const camera = new Vector3();
    const boats = [0, 1, 0].map((machine, i) => ({
      ...newDrawnBoat(),
      slot: i,
      east: 10 * i,
      opacity: 1,
      machine,
    }));
    const flags = () => {
      const lean = view.near.lean.array as Float32Array;
      return [0, 1, 2].map((n) => lean[n * 4 + 3]);
    };
    view.draw(boats, 3, origin, camera, 0, 0);
    expect(view.near.count).toBe(3);
    expect(flags()).toEqual([0, 1, 0]);
    // The machine sailor's slot taken by a human's boat: no mark.
    (boats[1] as (typeof boats)[number]).machine = 0;
    (boats[2] as (typeof boats)[number]).machine = 1;
    view.draw(boats, 3, origin, camera, 0, 0);
    expect(flags()).toEqual([0, 0, 1]);
  });
});

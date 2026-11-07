// SPDX-License-Identifier: AGPL-3.0-only

// A boat's own look as it is drawn: a look code decoded into the values the
// shaders draw (the paint and its grain, the cloth, its band and its ink,
// the sail number's text), the same as the fleet writes them per instance;
// the palette in linear colours; where the number and the name go on each
// kind's model, by its parts and not its id; and the names' texture's rows,
// kept by name and redrawn only when a row is given another.

import { readFileSync } from 'node:fs';
import { Color, type Mesh, type Object3D, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { boatCode } from '../catalog/boatlooks';
import { newDrawnBoat } from '../game/fleet';
import {
  INSIGNIA_RED,
  insigniaOn,
  LookPalette,
  lookDrawn,
  NAME_ASPECT,
  NameAtlas,
  NameRows,
  namePlace,
  numberedSail,
  numberPlace,
  numberText,
  TOPSIDES,
  writeLook,
} from './boatlook';
import type { FloatingOrigin } from './coords';
import { FleetViews, LEAN_STRIDE } from './fleet';
import { luminance } from './machinemark';

const { paints, cloths, lettering } = catalog.boatLooks;
const grained = paints.findIndex((p) => p.grain === true);
const banded = cloths.findIndex((c) => c.band !== undefined);
const dark = cloths.findIndex((c) => luminance(c.colour) < 0.18);

describe('a look code', () => {
  test('is drawn in its paint, its cloth, its band, its ink and its number', () => {
    const d = lookDrawn(catalog, boatCode({ paint: grained, cloth: banded, number: 311 }));
    const p = paints[grained];
    const c = cloths[banded];
    expect(d).toEqual({
      paint: grained,
      cloth: banded,
      number: 311,
      hull: p?.colour,
      grain: true,
      sail: c?.colour,
      band: c?.band,
      ink: c?.ink,
      insignia: INSIGNIA_RED,
      numberText: '311',
    });
    // A plain cloth has no band; a paint not varnish shows no grain.
    const plain = lookDrawn(catalog, boatCode({ paint: 0, cloth: 0, number: 7 }));
    expect(plain.band).toBeNull();
    expect(plain.grain).toBe(false);
    expect(plain.numberText).toBe('7');
  });

  test('none told is the first paint and cloth, with no number', () => {
    const d = lookDrawn(catalog, -1);
    expect([d.paint, d.cloth, d.number, d.numberText]).toEqual([0, 0, 0, '']);
    expect(d.hull).toBe(paints[0]?.colour);
    expect(d.sail).toBe(cloths[0]?.colour);
  });

  test('a place the catalog has not is its first; a number past the last none', () => {
    const d = lookDrawn(catalog, boatCode({ paint: 15, cloth: 15, number: 12000 }));
    expect([d.paint, d.cloth, d.number]).toEqual([0, 0, 0]);
    expect(numberText(0)).toBe('');
    expect(numberText(9999)).toBe('9999');
  });

  test('a dark cloth carries its insignia in its ink, a pale one in red', () => {
    const c = cloths[dark];
    expect(c).toBeDefined();
    expect(insigniaOn(c?.colour ?? '', c?.ink ?? '')).toBe(c?.ink);
    expect(insigniaOn(cloths[0]?.colour ?? '', cloths[0]?.ink ?? '')).toBe(INSIGNIA_RED);
  });

  test('is written per instance as it is drawn, every code', () => {
    const out = new Float32Array(3);
    for (let paint = 0; paint < 16; paint++) {
      for (let cloth = 0; cloth < 16; cloth++) {
        for (const number of [0, 1, 42, 9999]) {
          const code = boatCode({ paint, cloth, number });
          const d = lookDrawn(catalog, code);
          writeLook(catalog, code, out, 0);
          expect([...out]).toEqual([d.paint, d.cloth, d.number]);
        }
      }
    }
    writeLook(catalog, -1, out, 0);
    expect([...out]).toEqual([0, 0, 0]);
  });
});

describe('the palette', () => {
  test('holds each paint and cloth in linear colours, the grain and the band as flags', () => {
    const p = new LookPalette(catalog);
    const near = (v: { x: number; y: number; z: number } | undefined, hex: string) => {
      const c = new Color(hex);
      expect(v?.x).toBeCloseTo(c.r, 6);
      expect(v?.y).toBeCloseTo(c.g, 6);
      expect(v?.z).toBeCloseTo(c.b, 6);
    };
    paints.forEach((paint, i) => {
      near(p.values[i], paint.colour);
      expect(p.values[i]?.w).toBe(paint.grain === true ? 1 : 0);
    });
    cloths.forEach((cloth, i) => {
      near(p.values[16 + i], cloth.colour);
      expect(p.values[16 + i]?.w).toBe(cloth.band === undefined ? 0 : 1);
      near(p.values[32 + i], cloth.band ?? cloth.colour);
      near(p.values[48 + i], cloth.ink);
      near(p.values[64 + i], insigniaOn(cloth.colour, cloth.ink));
    });
  });
});

describe('the fleet', () => {
  test('writes each boat’s look beside its lean, and a name’s row only near', () => {
    const views = new FleetViews(catalog.boats, catalog);
    const view = views.first;
    view.loaded = true;
    const origin = { world: { x: 0, y: 0 } } as unknown as FloatingOrigin;
    const looks = [
      boatCode({ paint: grained, cloth: banded, number: 17 }),
      -1,
      boatCode({ paint: 2, cloth: dark, number: 4321 }),
    ];
    const boats = looks.map((boatLook, i) => ({
      ...newDrawnBoat(),
      slot: i,
      east: 10 * i,
      opacity: 1,
      boatLook,
    }));
    views.draw(boats, 3, origin, new Vector3(), 0, 0);
    expect(view.near.count).toBe(3);
    const a = view.near.lean.array as Float32Array;
    const at = (n: number) => [...a.slice(n * LEAN_STRIDE + 4, n * LEAN_STRIDE + 8)];
    expect(at(0)).toEqual([grained, banded, 17, -1]);
    expect(at(1)).toEqual([0, 0, 0, -1]);
    expect(at(2)).toEqual([2, dark, 4321, -1]);
  });
});

/** A stand-in for a 2D canvas: what NameAtlas letters with, counting the names filled. */
function fakeDocument() {
  const filled: string[] = [];
  const g = {
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    measureText: (t: string) => ({ width: t.length * 30 }),
    strokeText() {},
    fillText: (t: string) => filled.push(t),
  };
  const doc = {
    createElement: () => ({ width: 0, height: 0, getContext: () => g }),
  };
  return { doc, filled, g };
}

describe('the names’ texture', () => {
  const was = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = was;
  });

  test('keeps a name in its row, and gives a new one the row least lately wanted', () => {
    const rows = new NameRows(3);
    expect(rows.rowOf('', 1)).toBe(-1);
    const a = rows.rowOf('Saltpeter', 1);
    const b = rows.rowOf('Tern', 1);
    const c = rows.rowOf('Kittiwake', 1);
    expect(new Set([a, b, c]).size).toBe(3);
    // Every row wanted this frame: none for a fourth.
    expect(rows.rowOf('Puffin', 1)).toBe(-1);
    // Next frame, the same names keep their rows.
    expect(rows.rowOf('Tern', 2)).toBe(b);
    expect(rows.rowOf('Saltpeter', 3)).toBe(a);
    expect(rows.rowOf('Tern', 3)).toBe(b);
    // A new name takes the row least lately wanted: Kittiwake's.
    expect(rows.rowOf('Puffin', 3)).toBe(c);
    // Three rows to letter: Kittiwake's given to Puffin before it was drawn.
    const drawn: string[] = [];
    rows.drawStale((_, name) => drawn.push(name));
    expect(drawn.sort()).toEqual(['Puffin', 'Saltpeter', 'Tern']);
    // Nothing new: nothing to draw.
    rows.rowOf('Saltpeter', 4);
    rows.rowOf('Puffin', 4);
    expect(rows.drawStale(() => {})).toBe(0);
  });

  test('letters a row only when it is given another name, in gold', () => {
    const { doc, filled, g } = fakeDocument();
    (globalThis as { document?: unknown }).document = doc;
    const atlas = new NameAtlas(2, lettering);
    const version = () => atlas.texture.version;
    atlas.rowOf('Saltpeter', 1);
    atlas.commit();
    expect(filled).toEqual(['Saltpeter']);
    expect(g.fillStyle).toBe(lettering);
    const v = version();
    for (let f = 2; f < 50; f++) {
      atlas.rowOf('Saltpeter', f);
      atlas.commit();
    }
    // Drawn every frame, the same name: never lettered again, nor uploaded.
    expect(filled).toEqual(['Saltpeter']);
    expect(version()).toBe(v);
    atlas.rowOf('Saltpeter', 50);
    atlas.rowOf('Tern', 50);
    atlas.commit();
    expect(filled).toEqual(['Saltpeter', 'Tern']);
    expect(version()).toBeGreaterThan(v);
    expect(atlas.drawn).toBe(2);
  });
});

/** A model as the game loads it, from art/. */
async function model(path: string): Promise<Object3D> {
  const bytes = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await loader.parseAsync(buffer as ArrayBuffer, '');
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

describe.each(catalog.boats.map((b) => [b.name, b] as const))('the %s', (_, boat) => {
  test('has painted topsides, its name on both bows within them', async () => {
    const scene = await model(boat.art.model);
    const at: number[] = [];
    let hull: unknown;
    scene.traverse((o) => {
      if (o.name === 'hull') {
        hull = o.userData;
      }
      const m = o as Mesh;
      if (m.isMesh === true && (m.material as { name: string }).name === TOPSIDES) {
        const p = m.geometry.getAttribute('position');
        const v = new Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          at.push(v.x, v.y, v.z);
        }
      }
    });
    expect(at.length).toBeGreaterThan(0);
    const place = namePlace(at, hull);
    expect(place).not.toBeNull();
    if (place === null) {
      return;
    }
    expect(place.on).toBe('bows');
    expect(place.width / place.height).toBeCloseTo(NAME_ASPECT, 6);
    // Forward, above the water, and no longer than a quarter of the hull.
    const { lengthOverall } = boat;
    expect(place.z).toBeLessThan(0);
    expect(place.width).toBeLessThanOrEqual(0.25 * lengthOverall);
    expect(place.y - place.height / 2).toBeGreaterThan(0);
    expect(place.height).toBeGreaterThan(0.05);
    // The box's top and bottom on the topsides at its station.
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < at.length; i += 3) {
      if (Math.abs((at[i + 2] ?? 0) - place.z) < 0.05) {
        lo = Math.min(lo, at[i + 1] ?? 0);
        hi = Math.max(hi, at[i + 1] ?? 0);
      }
    }
    expect(place.y - place.height / 2).toBeGreaterThanOrEqual(lo);
    expect(place.y + place.height / 2).toBeLessThanOrEqual(hi);
  });

  test('carries its number on the main, both faces, within the sail', async () => {
    const scene = await model(boat.art.model);
    const nodes: Object3D[] = [];
    scene.traverse((o) => {
      nodes.push(o);
    });
    expect(numberedSail(nodes)).toBe('sail');
    const { foot, luff } = boat.physics.rig;
    const p = numberPlace(foot, luff, (v) => 1 - v);
    for (const face of [p.front, p.back]) {
      // Four digits within the chord at their height, which a triangle's is.
      expect(face.u - 2 * p.du).toBeGreaterThan(0);
      expect(face.u + 2 * p.du).toBeLessThan(1 - face.v);
    }
    // The front face's above the back's, apart.
    expect(p.front.v - p.back.v).toBeGreaterThan(p.dv);
    // Its digits as high in metres as a fraction of the foot, whatever the luff.
    expect(p.dv * luff).toBeCloseTo((p.du / 0.62) * foot, 6);
  });
});

test('a sail that says it carries the number does, whichever it is', () => {
  const o = (name: string, number?: boolean) =>
    ({ name, userData: number === undefined ? {} : { number } }) as unknown as Object3D;
  expect(numberedSail([o('sail'), o('jib')])).toBe('sail');
  expect(numberedSail([o('sail'), o('topsail', true)])).toBe('topsail');
});

test('a hull whose extras say so carries its name on its transom', () => {
  // A box of a hull, 10 m long, 3 m wide, its sides 2 m high.
  const at: number[] = [];
  for (let z = -5; z <= 5; z += 0.25) {
    for (const x of [-1.5, 1.5]) {
      for (const y of [0, 2]) {
        at.push(x, y, z);
      }
    }
  }
  const bows = namePlace(at);
  expect(bows?.on).toBe('bows');
  const transom = namePlace(at, { name: { on: 'transom' } });
  expect(transom?.on).toBe('transom');
  expect(transom?.z).toBe(5);
  expect(transom?.y).toBeCloseTo(1.015, 6);
  expect((transom?.width ?? 0) / (transom?.height ?? 1)).toBeCloseTo(NAME_ASPECT, 6);
});

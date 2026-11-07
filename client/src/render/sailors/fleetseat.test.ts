// SPDX-License-Identifier: AGPL-3.0-only

// The fleet's sailor, the far level posed seated at the helm, as figureNode
// places it on either side deck, sitting and hiking: nothing of it inside
// the hull (its coat lies on the seat, never through it).

import { readFileSync } from 'node:fs';
import { type BufferGeometry, Mesh, type Object3D, Texture, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { seatFigure } from '../fleetparts';
import { IN_WATER, placeSailor, SAILING, type SailorPlace } from '../sailor';
import { placesOf } from './model';
import { hullSolid, inside } from './solid';

const ART = new URL('../../../../art/', import.meta.url);

// GLTFLoader reaches for the page's global by name.
(globalThis as { self?: unknown }).self ??= globalThis;

/** Reads a glb in Node; its KTX2 textures stand in as blank ones. */
async function load(path: string): Promise<Object3D> {
  const buf = readFileSync(new URL(path, ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const blank = {
    load: (_url: string, onLoad: (t: Texture) => void) => onLoad(new Texture()),
    detectSupport: () => blank,
  };
  loader.setKTX2Loader(blank as unknown as KTX2Loader);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return (await loader.parseAsync(ab, '')).scene;
}

test('the fleet’s sailor sits on its side deck, sitting or hiking, nothing of it in the hull', async () => {
  const sailor = catalog.sailors[0]?.versions[0];
  const kind = catalog.boats[0];
  if (sailor === undefined || kind === undefined) {
    throw new Error('no sailor or boat');
  }
  const boat = await load(kind.art.model);
  boat.updateMatrixWorld(true);
  const pos = (name: string): Vector3 =>
    (boat.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
  const solid = hullSolid(boat.getObjectByName('hull')?.userData, pos('board-root'), {
    span: kind.physics.foils.boardSpan,
    chord: kind.physics.foils.boardChord,
  });
  if (solid === null) {
    throw new Error('no solid');
  }
  const gunwale = pos('gunwale');
  const seatZ = pos('sailor').z;
  const far = await load(sailor.art.far);
  const meshes: Mesh[] = [];
  far.traverse((o) => {
    if (o instanceof Mesh) {
      meshes.push(o);
    }
  });
  const place = placesOf(far).get('place') ?? null;
  const g: BufferGeometry = seatFigure(far, meshes, place, gunwale.x, gunwale.y, seatZ);
  const p = g.getAttribute('position');
  expect(place).not.toBeNull();
  expect(p.count).toBeGreaterThan(100);
  const frame = {
    seatOut: gunwale.x,
    seatY: gunwale.y,
    seatZ,
    centreOfGravity: kind.physics.hull.centreOfGravity,
    boardZ: 0,
    boardDepth: 0,
  };
  const at: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  const v = new Vector3();
  const through: string[] = [];
  for (const side of [1, -1]) {
    for (const offset of [0.5, 0.75, 0.95]) {
      placeSailor(side * offset, SAILING, 0, frame, side, at);
      for (let i = 0; i < p.count; i++) {
        // As figureNode turns and places it.
        v.fromBufferAttribute(p, i)
          .applyAxisAngle(new Vector3(0, 1, 0), at.facing)
          .applyAxisAngle(new Vector3(0, 0, 1), at.tilt)
          .add(new Vector3(at.x, at.y, at.z));
        if (inside(solid, v.x, v.y + 0.004, v.z)) {
          through.push(`side ${side}, offset ${offset}: ${v.toArray().map((x) => x.toFixed(3))}`);
        }
      }
    }
  }
  expect(through.slice(0, 5)).toEqual([]);
});

test('at a wheel, the fleet’s sailor stands behind it on the deck, facing forward, whatever the physics says', async () => {
  const sailor = catalog.sailors[0]?.versions[0];
  const kind = catalog.boats[0];
  if (sailor === undefined || kind === undefined) {
    throw new Error('no sailor or boat');
  }
  const boat = await load(kind.art.model);
  boat.updateMatrixWorld(true);
  const pos = (name: string): Vector3 =>
    (boat.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
  const gunwale = pos('gunwale');
  const seatZ = pos('sailor').z;
  const far = await load(sailor.art.far);
  const meshes: Mesh[] = [];
  far.traverse((o) => {
    if (o instanceof Mesh) {
      meshes.push(o);
    }
  });
  const g = seatFigure(
    far,
    meshes,
    placesOf(far).get('place') ?? null,
    gunwale.x,
    gunwale.y,
    seatZ,
  );
  const p = g.getAttribute('position');
  // The helmsman's place on a quarterdeck; the wheel's hub 0.55 m ahead of it.
  const stand = { y: 4.5, z: 12 };
  const frame = {
    seatOut: 0,
    seatY: 0,
    seatZ: 0,
    centreOfGravity: 1,
    boardZ: 0,
    boardDepth: 0,
    wheel: stand,
  };
  const at: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  const v = new Vector3();
  for (const [offset, mode] of [
    [0.5, SAILING],
    [-0.5, SAILING],
    [0, IN_WATER],
  ] as const) {
    placeSailor(offset, mode, 0.3, frame, 1, at);
    let low = Infinity;
    let high = -Infinity;
    let fore = Infinity;
    let side = 0;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i)
        .applyAxisAngle(new Vector3(0, 1, 0), at.facing)
        .applyAxisAngle(new Vector3(0, 0, 1), at.tilt)
        .add(new Vector3(at.x, at.y, at.z));
      low = Math.min(low, v.y);
      high = Math.max(high, v.y);
      fore = Math.min(fore, v.z);
      side = Math.max(side, Math.abs(v.x));
    }
    // On the deck, a standing sailor's height, short of the wheel's plane.
    expect(low).toBeGreaterThan(stand.y - 0.02);
    expect(high - stand.y).toBeGreaterThan(1.4);
    expect(high - stand.y).toBeLessThan(1.9);
    expect(fore).toBeGreaterThan(stand.z - 0.55);
    expect(side).toBeLessThan(0.6);
  }
});

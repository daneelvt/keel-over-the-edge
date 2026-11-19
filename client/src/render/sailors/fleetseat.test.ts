// SPDX-License-Identifier: AGPL-3.0-only

// The fleet's sailor, the far level posed seated at the helm, as figureNode
// places it on either side deck, sitting and hiking: nothing of it inside
// the hull (its coat lies on the seat, never through it). On a trapeze, the
// figure made from it out on the wire, where the moving figure hangs.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  type BufferGeometry,
  Float32BufferAttribute,
  type Matrix4,
  Mesh,
  type Object3D,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { seatFigure } from '../fleetparts';
import { IN_WATER, placeSailor, SAILING, type SailorPlace } from '../sailor';
import { Clip } from './clips';
import { wireFigures } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { seating } from './restage';
import { Rig } from './rig';
import { SailorRuntime } from './runtime';
import { hullSolid, inside } from './solid';
import { harnessFile, trapezeClips, trapezeOf } from './trapeze';

const ART = new URL('../../../../art/', import.meta.url);

// GLTFLoader reaches for the page's global by name.
(globalThis as { self?: unknown }).self ??= globalThis;

/** Reads a glb in Node; its KTX2 textures stand in as blank ones. */
async function load(path: string): Promise<Object3D> {
  return (await loadFile(path)).scene;
}

/** Reads a glb in Node, its scene and animations; its KTX2 textures stand in as blank ones. */
async function loadFile(path: string): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buf = readFileSync(new URL(path, ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const blank = {
    load: (_url: string, onLoad: (t: Texture) => void) => onLoad(new Texture()),
    detectSupport: () => blank,
  };
  loader.setKTX2Loader(blank as unknown as KTX2Loader);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return loader.parseAsync(ab, '');
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

/** The kinds with a trapeze, by their models' nodes. */
const wired = (
  await Promise.all(
    catalog.boats.map(async (b) =>
      (await load(b.art.model)).getObjectByName('trapeze') === undefined ? null : b,
    ),
  )
).filter((b) => b !== null);

test.each(wired.map((k) => [k.name, k] as const))(
  'on a trapeze (the %s), the fleet’s sailor out on the wire is its own figure, from the rack’s edge, clear of the hull, where the moving one hangs',
  async (_, kind) => {
    const stage = catalog.boats[0];
    const sailor = catalog.sailors.find((s) => s.id === 'rover')?.versions[0];
    if (stage === undefined || sailor === undefined) {
      throw new Error('no stage or sailor');
    }
    const boat = await load(kind.art.model);
    boat.updateMatrixWorld(true);
    const parts = new Map<string, Object3D>();
    boat.traverse((o) => {
      if (o.name !== '') {
        parts.set(o.name, o);
      }
    });
    const pos = (root: Object3D, name: string): Vector3 =>
      (root.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
    const { hikeReach } = kind.physics.sailor;
    const trapeze = trapezeOf(parts, hikeReach);
    const solid = hullSolid(boat.getObjectByName('hull')?.userData, pos(boat, 'board-root'), {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    if (trapeze === null || solid === null) {
      throw new Error('no trapeze or solid');
    }
    // The far figure seated as the fleet seats it: in the stage's boat.
    const stageBoat = await load(stage.art.model);
    stageBoat.updateMatrixWorld(true);
    const g = pos(stageBoat, 'gunwale');
    const seat = { out: g.x, y: g.y, z: pos(stageBoat, 'sailor').z };
    const far = await load(sailor.art.far);
    const meshes: Mesh[] = [];
    far.traverse((o) => {
      if (o instanceof Mesh) {
        meshes.push(o);
      }
    });
    const seated = seatFigure(
      far,
      meshes,
      placesOf(far).get('place') ?? null,
      seat.out,
      seat.y,
      seat.z,
    );
    seated.setAttribute(
      'tag',
      new Float32BufferAttribute(new Float32Array(2 * seated.getAttribute('position').count), 2),
    );
    // Its clips, those on the wire with them, on the deck level's skeleton.
    const deck = await load(sailor.art.model);
    const rig = Rig.from(deck, boneNames(deck));
    const clips = new Map<string, Clip>();
    for (const path of [sailor.art.clips, trapezeClips(sailor.art.clips)]) {
      const file = await loadFile(path);
      const places = placesOf(file.scene);
      for (const a of file.animations) {
        clips.set(a.name, Clip.from(a, rig, places.get(`place-${a.name}`) ?? null));
      }
    }
    const hookFile = await load(harnessFile(sailor.art.clips));
    const hookAt = new Vector3().setFromMatrixPosition(
      placesOf(hookFile).get('place-hook') as Matrix4,
    );
    const made = wireFigures(seated, seat, clips, rig, hookAt);
    if (made === null) {
      throw new Error('no figure on the wire');
    }
    const wire = made.geometry;
    const p = wire.getAttribute('position');
    const tag = wire.getAttribute('tag');
    expect(p.count).toBe(2 * seated.getAttribute('position').count);
    // Seated on the rail, then out on the wire beyond half way to the trapeze's low clip.
    const rail = seating(parts, hikeReach).hike.full;
    const frame = {
      seatOut: g.x,
      seatY: g.y,
      seatZ: seat.z,
      centreOfGravity: kind.physics.hull.centreOfGravity,
      boardZ: 0,
      boardDepth: 0,
      trapeze: { ...trapeze.rackEdge, rail, reach: hikeReach },
    };
    const at: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
    expect(placeSailor(rail, SAILING, 0, frame, 1, at).wire).toBe(0);
    expect(placeSailor(hikeReach, SAILING, 0, frame, 1, at).wire).toBe(1);
    expect(placeSailor(-hikeReach, SAILING, 0, frame, -1, at).wire).toBe(-1);
    expect(placeSailor(-hikeReach, SAILING, 0, frame, -1, at, false).wire).toBe(0);
    const v = new Vector3();
    for (const side of [1, -1]) {
      placeSailor(side * hikeReach, SAILING, 0, frame, side, at);
      // The moving figure out fully on the wire on that side, to compare.
      const rt = new SailorRuntime(
        rig,
        clips,
        {
          hinge: pos(boat, 'extension'),
          hingeRest: pos(boat, 'extension'),
          extension: pos(boat, 'extension').distanceTo(pos(boat, 'grip')),
          seatY: pos(boat, 'gunwale').y,
          seatIn: solid.cockpit.halfWidth,
          seatOut: pos(boat, 'gunwale').x,
          seatZ: pos(boat, 'sailor').z,
          cog: kind.physics.hull.centreOfGravity,
          solid,
          climbTime: 1,
          ...seating(parts, hikeReach),
          trapeze,
        },
        1,
      );
      for (let f = 0; f < 3; f++) {
        rt.update({
          dt: 1 / 30,
          time: 0,
          offset: side * hikeReach,
          mode: SAILING,
          timer: 0,
          heel: 0,
          pitch: 0,
          heave: 0,
          windSpeed: 0,
          windAngle: 0,
          rollRate: 0,
          still: true,
        });
      }
      const hips = rig.position(rig.bone('pelvis'), new Vector3()).applyMatrix4(rt.root);
      const through: string[] = [];
      const mean = new Vector3();
      let n = 0;
      for (let i = 0; i < p.count; i++) {
        if (tag.getY(i) !== (side > 0 ? 1 : 2)) {
          continue;
        }
        // As figureNode places it: facing 0, no tilt.
        v.fromBufferAttribute(p, i).add(new Vector3(at.x, at.y, at.z));
        mean.add(v);
        n++;
        if (inside(solid, v.x, v.y + 0.004, v.z)) {
          through.push(`side ${side}: ${v.toArray().map((x) => x.toFixed(3))}`);
        }
      }
      mean.divideScalar(n);
      expect(through.slice(0, 5)).toEqual([]);
      // Out beyond the rack's edge, about where the moving figure's hips hang.
      expect(side * mean.x).toBeGreaterThan(trapeze.rackEdge.x + 0.4);
      expect(mean.distanceTo(hips)).toBeLessThan(0.3);
      // Its hook at its hips, and where the moving one's is.
      const hook = (made.hooks[side > 0 ? 0 : 1] as Vector3)
        .clone()
        .add(new Vector3(at.x, at.y, at.z));
      expect(hook.distanceTo(hips)).toBeLessThan(0.3);
    }
  },
);

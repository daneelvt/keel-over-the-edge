// SPDX-License-Identifier: AGPL-3.0-only

// The fleet's near sailors, read from the committed files: a look's deck
// level made one geometry skins, from the matrices the near tier writes,
// to where three.js's own skinning puts every vertex at the same pose; what
// hangs on the cloth's chains carries a sway, the rest none; and each near
// sailor runs 20 times a second, whatever the frame rate.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  SkinnedMesh,
  Texture,
  Vector3,
  Vector4,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { newDrawnBoat } from '../../game/fleet';
import { Clip, Pose } from './clips';
import { deckLook, FleetLook } from './fleetlooks';
import { NEAR_RATE, NearSailors, ROW_HEAD } from './fleetsailors';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { bonesFor, Rig } from './rig';
import { hullSolid } from './solid';

const ART = new URL('../../../../art/', import.meta.url);

// GLTFLoader reaches for the page's global by name.
(globalThis as { self?: unknown }).self ??= globalThis;

/** Reads a glb in Node; its KTX2 textures stand in as blank ones. */
async function load(path: string): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
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

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

describe.each([
  ['rover', 'female'],
  ['machine', 'male'],
])('%s %s', (look, version) => {
  test('skins from the near tier’s matrices as three.js skins it', async () => {
    const deck = await load(`sailors/${look}/${version}.deck.glb`);
    const clips = await load(`sailors/${look}/${version}.clips.glb`);
    const meshes = meshesOf(deck.scene);
    const rig = Rig.from(deck.scene, boneNames(deck.scene));
    const d = deckLook(meshes, rig, new Matrix3(), 3);
    // The rig posed by a clip, and its bones written to the file's skeleton.
    const places = placesOf(clips.scene);
    const helm = clips.animations.find((a) => a.name === 'helm') as AnimationClip;
    const clip = Clip.from(helm, rig, places.get('place-helm') ?? null);
    const pose = new Pose(rig.names.length).rest(rig);
    clip.sample(0.7, pose);
    pose.to(rig);
    rig.fk();
    rig.write(bonesFor(rig, deck.scene));
    deck.scene.updateMatrixWorld(true);
    const root = new Matrix4().makeTranslation(0.6, 0.3, 0.4);
    // The near tier's matrices: from the figure's bind pose to the boat.
    const m = rig.names.map((_, j) =>
      root
        .clone()
        .multiply(new Matrix4().fromArray(rig.world, 16 * j))
        .multiply(new Matrix4().fromArray(d.inverse, 16 * j)),
    );
    const g = d.geometry;
    const pos = g.getAttribute('position');
    const index = g.getAttribute('skinIndex');
    const weight = g.getAttribute('skinWeight');
    let at = 0;
    let worst = 0;
    const v = new Vector3();
    const p = new Vector3();
    const sum = new Vector3();
    for (const mesh of meshes) {
      if (!(mesh instanceof SkinnedMesh)) {
        continue;
      }
      mesh.skeleton.update();
      const n = mesh.geometry.getAttribute('position').count;
      for (let i = 0; i < n; i += 7) {
        // three.js's: the mesh's own vertex skinned, into the boat.
        mesh.applyBoneTransform(
          i,
          v.fromBufferAttribute(mesh.geometry.getAttribute('position'), i),
        );
        v.applyMatrix4(mesh.matrixWorld).applyMatrix4(root);
        // The near tier's: the merged vertex by its bones' matrices.
        p.fromBufferAttribute(pos, at + i);
        sum.set(0, 0, 0);
        for (let c = 0; c < 4; c++) {
          const w = weight.getComponent(at + i, c);
          if (w > 0) {
            const b = m[index.getComponent(at + i, c)] as Matrix4;
            sum.addScaledVector(p.clone().applyMatrix4(b), w);
          }
        }
        worst = Math.max(worst, sum.distanceTo(v));
      }
      at += n;
    }
    expect(at).toBe(pos.count);
    expect(worst).toBeLessThan(1e-4);
  });

  test('sways what hangs on the cloth’s and hair’s chains, nothing else', async () => {
    const deck = await load(`sailors/${look}/${version}.deck.glb`);
    const meshes = meshesOf(deck.scene);
    const rig = Rig.from(deck.scene, boneNames(deck.scene));
    const d = deckLook(meshes, rig, new Matrix3(), 2);
    const tag = d.geometry.getAttribute('tag');
    let swaying = 0;
    for (let i = 0; i < tag.count; i++) {
      expect(tag.getX(i)).toBe(2);
      const s = tag.getY(i);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1 + 1e-6);
      if (s > 0.05) {
        swaying++;
      }
    }
    // The coat's skirts and the hair: some of the figure, far from all.
    expect(swaying).toBeGreaterThan(0.03 * tag.count);
    expect(swaying).toBeLessThan(0.5 * tag.count);
  });
});

test('each near sailor runs 20 times a second, whatever the frames', async () => {
  const kind = catalog.boats[0];
  const sailor = catalog.sailors[0]?.versions[0];
  if (kind === undefined || sailor === undefined) {
    throw new Error('no boat or sailor');
  }
  const deck = await load(sailor.art.model);
  const clipsFile = await load(sailor.art.clips);
  const boat = await load(kind.art.model);
  boat.scene.updateMatrixWorld(true);
  const node = (name: string): Vector3 =>
    (boat.scene.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
  const solid = hullSolid(boat.scene.getObjectByName('hull')?.userData, node('board-root'), {
    span: kind.physics.foils.boardSpan,
    chord: kind.physics.foils.boardChord,
  });
  if (solid === null) {
    throw new Error('no solid');
  }
  const rig = Rig.from(deck.scene, boneNames(deck.scene));
  const look = new FleetLook(0, sailor.art, false);
  look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
  const places = placesOf(clipsFile.scene);
  look.clips = new Map(
    clipsFile.animations.map((a) => [
      a.name,
      Clip.from(a, rig, places.get(`place-${a.name}`) ?? null),
    ]),
  );
  const near = new NearSailors(rig.names.length, 12, {
    stock: node('rudder'),
    hinge: node('extension'),
    extension: node('extension').distanceTo(node('grip')),
    seatY: node('gunwale').y,
    seatIn: solid.cockpit.halfWidth,
    seatOut: node('gunwale').x,
    seatZ: node('sailor').z,
    cog: kind.physics.hull.centreOfGravity,
    solid,
    climbTime: kind.physics.sailor.climbTime,
  });
  const boats = [0, 1, 2].map((slot) => ({ ...newDrawnBoat(), slot, sailor: -0.5, opacity: 1 }));
  for (const fps of [30, 60, 120]) {
    near.runs = 0;
    for (let f = 0; f < 2 * fps; f++) {
      near.frame(f / fps);
      boats.forEach((b, n) => {
        expect(near.write(n, b, look, 1 / fps)).toBe(true);
      });
    }
    // Two seconds, three sailors: about 120 runs.
    expect(near.runs / 3 / 2).toBeGreaterThan(NEAR_RATE * 0.85);
    expect(near.runs / 3 / 2).toBeLessThan(NEAR_RATE * 1.25);
  }
  // Each row's bones: the figure placed in the boat, its hips at the seat.
  const width = near.width;
  const hips = rig.bone('pelvis');
  const o = 4 * (width * 1 + ROW_HEAD + 3 * hips);
  const t = new Vector4().fromArray(near.data, o).w;
  expect(Math.abs(t)).toBeLessThan(1.2);
});

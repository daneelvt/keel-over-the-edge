// SPDX-License-Identifier: AGPL-3.0-only

// The certificates' pendants on every look's figures, as the build
// committed them (art/sailors/<look>/) and the pendants' model
// (art/pendants/):
//
// - the model holds each certificate's pendant, a few centimetres across,
//   ready to draw;
// - each version's place (the catalog's art.pendant) is where its figures'
//   clothes put it: the bail a little in front of the cloth at the
//   breastbone, high on the chest, the face turned as the chest slopes
//   under it, clear of the cloth over its whole width, and its cord's ends
//   under the clothes, never ending in the air; worked out here from the
//   close and deck levels as bound, so a look built again says when its
//   place has moved (and prints the catalog's new line);
// - in every pose the deck's clips put the figure in (every boat's), at
//   both the deck and close levels, nothing of the clothes comes over the
//   pendant and no hand passes through it;
// - its place on the inked portrait is its bail as the portrait's camera
//   sees the figure (tables.yaml's portraits); the camera is checked
//   against the cockade's places on the portrait, which were set by eye,
//   so only roughly.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  AnimationMixer,
  Box3,
  Matrix4,
  Mesh,
  type Object3D,
  Ray,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import type { SailorArt } from '../../catalog/types.gen';
import { PENDANT_BONE, pendantMatrix, pendantsFrom } from './pendant';

const ART = new URL('../../../../art/', import.meta.url);

// GLTFLoader reaches for the page's global by name.
(globalThis as { self?: unknown }).self ??= globalThis;

/** Reads a glb in Node, its scene and animations; its KTX2 textures stand in as blank ones. */
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

/** Every look's versions, the machine's too: a name and its art. */
const VERSIONS: { name: string; art: SailorArt }[] = [
  ...catalog.sailors.flatMap((s) =>
    s.versions.map((v) => ({ name: `${s.id} ${v.id}`, art: v.art })),
  ),
  ...catalog.machine.versions.map((v) => ({ name: `machine ${v.id}`, art: v.art })),
];

/** How far in front of the cloth the pendant's back rests, at its nearest, m. */
const GAP = 0.003;
/** Half the width of cloth the pendant rests on, and how far it hangs below its bail, m. */
const HALF_WIDTH = 0.013;
const HANGS = 0.03;
/** How far above the pendant bone the bail is first tried, and the heights tried after, nearest first, m. */
const LIFTS = [0.05, 0.045, 0.055, 0.04, 0.06, 0.035, 0.065, 0.03, 0.07, 0.075, 0.025, 0.08, 0.02];
/** How far below the pendant an edge of another garment is too near: a bend of the body brings it over. */
const EDGE = 0.015;
/** The steepest the pendant may lie before a higher or lower bail is chosen. */
const STEEPEST = Math.tan((28 * Math.PI) / 180);

/** A level's triangles as bound, with their meshes' names; hair and beards hang where they will and are left out. */
function trianglesOf(scene: Object3D): { corners: Vector3[]; mesh: string }[] {
  const out: { corners: Vector3[]; mesh: string }[] = [];
  scene.traverse((o) => {
    if (!(o instanceof Mesh) || o.name === 'hair' || o.name === 'beard') {
      return;
    }
    const p = o.geometry.getAttribute('position');
    const index = o.geometry.index;
    if (index === null) {
      return;
    }
    for (let k = 0; k < index.count; k += 3) {
      out.push({
        corners: [0, 1, 2].map((j) => new Vector3().fromBufferAttribute(p, index.getX(k + j))),
        mesh: o.name,
      });
    }
  });
  return out;
}

/** The outermost cloth at x, y as bound: its depth (z, forward) and mesh; −∞ for none. */
function clothAt(
  tris: { corners: Vector3[]; mesh: string }[],
  x: number,
  y: number,
): { z: number; mesh: string } {
  const ray = new Ray(new Vector3(x, y, 1), new Vector3(0, 0, -1));
  const hit = new Vector3();
  let best = { z: Number.NEGATIVE_INFINITY, mesh: '' };
  for (const t of tris) {
    const [a, b, c] = t.corners as [Vector3, Vector3, Vector3];
    if (Math.max(a.y, b.y, c.y) < y || Math.min(a.y, b.y, c.y) > y) {
      continue;
    }
    if (Math.max(a.x, b.x, c.x) < x || Math.min(a.x, b.x, c.x) > x) {
      continue;
    }
    if (ray.intersectTriangle(a, b, c, false, hit) !== null && hit.z > best.z) {
      best = { z: hit.z, mesh: t.mesh };
    }
  }
  return best;
}

/** A skeleton's bone as bound, by name. */
function boundBone(scene: Object3D, name: string): Vector3 {
  let at: Vector3 | null = null;
  scene.traverse((o) => {
    if (o instanceof SkinnedMesh && at === null) {
      const i = o.skeleton.bones.findIndex((b) => b.name === name);
      const inverse = o.skeleton.boneInverses[i];
      if (inverse !== undefined) {
        at = new Vector3().setFromMatrixPosition(inverse.clone().invert());
      }
    }
  });
  if (at === null) {
    throw new Error(`no bone ${name}`);
  }
  return at;
}

/** The inked portrait's camera, as tables.yaml's portraits has it (art/sailors/build/portraits.py). */
const PORTRAIT = {
  lens: 85,
  height: 0.595,
  eyes: 0.42,
  azimuth: 30,
  headTurn: 6,
  aspect: 512 / 640,
};

/**
 * Where a point on the figure as bound is on the inked portrait, as shares
 * of its width and height: the camera on the figure's left at the height of
 * its face, aimed below the eyes, as the portrait turned the neck and head
 * to it (onHead: the point turns with the head, as a hat's does).
 */
function inked(scene: Object3D, point: Vector3, onHead: boolean): [number, number] {
  const neck = boundBone(scene, 'neck_01');
  const head = boundBone(scene, 'head');
  const turn = (v: Vector3, about: Vector3, deg: number): Vector3 =>
    v
      .clone()
      .sub(about)
      .applyMatrix4(new Matrix4().makeRotationY((deg * Math.PI) / 180))
      .add(about);
  const headTurn = PORTRAIT.headTurn;
  const turned = (v: Vector3): Vector3 =>
    turn(turn(v, neck, headTurn * 0.4), turn(head, neck, headTurn * 0.4), headTurn * 0.6);
  const eyes = turned(boundBone(scene, 'eye_l'))
    .add(turned(boundBone(scene, 'eye_r')))
    .multiplyScalar(0.5);
  const p = onHead ? turned(point) : point;
  const az = (PORTRAIT.azimuth * Math.PI) / 180;
  const toward = new Vector3(Math.sin(az), 0, Math.cos(az));
  const right = new Vector3(Math.cos(az), 0, -Math.sin(az));
  const target = eyes.clone().sub(new Vector3(0, (0.5 - PORTRAIT.eyes) * PORTRAIT.height, 0));
  const camera = target.addScaledVector(toward, (PORTRAIT.height * PORTRAIT.lens) / 24);
  const d = p.clone().sub(camera);
  const depth = -d.dot(toward);
  const half = 12 / PORTRAIT.lens;
  const u = d.dot(right) / (depth * half * PORTRAIT.aspect);
  const v = d.y / (depth * half);
  return [(u + 1) / 2, (1 - v) / 2];
}

/** The cord's two ends in the pendant's own frame: its highest vertices on either side. */
function cordEnds(each: {
  getAttribute(name: string): {
    count: number;
    getX(i: number): number;
    getY(i: number): number;
    getZ(i: number): number;
  };
}): Vector3[] {
  const p = each.getAttribute('position');
  const ends = [
    new Vector3(0, Number.NEGATIVE_INFINITY, 0),
    new Vector3(0, Number.NEGATIVE_INFINITY, 0),
  ];
  for (let i = 0; i < p.count; i++) {
    const side = p.getX(i) < 0 ? 0 : 1;
    const e = ends[side] as Vector3;
    if (p.getY(i) > e.y) {
      e.set(p.getX(i), p.getY(i), p.getZ(i));
    }
  }
  return ends;
}

/**
 * Where a version's pendant hangs, from its close and deck levels as bound:
 * the bail centred, a few centimetres above the pendant bone, in front of
 * the outermost cloth by GAP where it rests; the face turned out as far as
 * the cloth under it pushes it; the bail at the first height tried where
 * the pendant lies no steeper than STEEPEST over one garment, else where it
 * lies least steep.
 */
function placeOf(
  tris: { corners: Vector3[]; mesh: string }[],
  bone: Vector3,
): { at: Vector3; tilt: number } {
  let best: { at: Vector3; tilt: number; score: number } | null = null;
  for (const lift of LIFTS) {
    const y = bone.y + lift;
    const row = (dy: number): { z: number; meshes: Set<string> } => {
      let z = Number.NEGATIVE_INFINITY;
      const meshes = new Set<string>();
      for (let k = -5; k <= 5; k++) {
        const c = clothAt(tris, (k / 5) * HALF_WIDTH, y - dy);
        z = Math.max(z, c.z);
        // Buttons and braid lie flat on their garment: no edge of it.
        if (c.mesh !== '' && c.mesh !== 'trims') {
          meshes.add(c.mesh);
        }
      }
      return { z, meshes };
    };
    const top = row(0);
    const z = top.z + GAP;
    let tan = 0;
    const meshes = new Set(top.meshes);
    for (let dy = 0.003; dy <= HANGS + EDGE + 1e-9; dy += 0.003) {
      const r = row(dy);
      if (dy <= HANGS + 1e-9) {
        tan = Math.max(tan, (r.z + GAP - z) / dy);
      }
      for (const m of r.meshes) {
        meshes.add(m);
      }
    }
    // Over one garment, the pendant lies on it; over another's edge, or
    // just above one, a bend of the body brings that edge over it.
    const score = tan + (meshes.size > 1 ? 1 : 0);
    if (best === null || score < best.score) {
      best = { at: new Vector3(0, y, z), tilt: Math.atan(tan), score };
    }
    if (score <= STEEPEST) {
      break;
    }
  }
  if (best === null) {
    throw new Error('no place');
  }
  return best;
}

describe('the pendants', () => {
  test('the model holds every certificate’s pendant, a few centimetres across, ready to draw', async () => {
    const model = catalog.pendants?.art.model;
    expect(model).toBeDefined();
    const { scene } = await load(model as string);
    const nodes = (catalog.certificates ?? []).map((c) => c.pendantNode);
    expect(nodes).toHaveLength(5);
    expect(new Set(nodes).size).toBe(5);
    const pendants = pendantsFrom(scene, nodes);
    expect(pendants.each).toHaveLength(5);
    let vertices = 0;
    for (const [i, g] of pendants.each.entries()) {
      // Its metal's size: the cord rises above its bail, at y = 0.
      const p = g.getAttribute('position');
      const metal = new Box3();
      const colour = g.getAttribute('color');
      for (let k = 0; k < p.count; k++) {
        // The cord is the dark part.
        if (colour.getX(k) + colour.getY(k) + colour.getZ(k) > 0.15) {
          metal.expandByPoint(new Vector3().fromBufferAttribute(p, k));
        }
      }
      const size = metal.getSize(new Vector3());
      expect(size.x, nodes[i]).toBeGreaterThan(0.02);
      expect(size.x, nodes[i]).toBeLessThan(0.033);
      expect(-metal.min.y, nodes[i]).toBeLessThan(0.033);
      expect(metal.min.z, nodes[i]).toBeGreaterThan(-0.0001);
      expect((g.index?.count ?? 0) / 3, nodes[i]).toBeLessThanOrEqual(480);
      for (const name of ['normal', 'color', 'uv1']) {
        expect(g.getAttribute(name), `${nodes[i]} ${name}`).toBeDefined();
      }
      vertices += p.count;
    }
    expect(pendants.all.getAttribute('position').count).toBe(vertices);
    expect(pendants.all.getAttribute('pendant').getX(vertices - 1)).toBe(5);
  });

  test('each version’s pendant hangs where its clothes put it, its cord tucked under them, and its place on the inked portrait', async () => {
    const { scene: model } = await load(catalog.pendants?.art.model as string);
    const pendants = pendantsFrom(
      model,
      (catalog.certificates ?? []).map((c) => c.pendantNode),
    );
    const moved: string[] = [];
    const untucked: string[] = [];
    const cockades: string[] = [];
    for (const v of VERSIONS) {
      const close = (await load(v.art.close)).scene;
      const deck = (await load(v.art.model)).scene;
      const tris = [...trianglesOf(close), ...trianglesOf(deck)];
      const bone = boundBone(deck, PENDANT_BONE);
      const want = placeOf(tris, bone);
      const facing = [0, Math.sin(want.tilt), Math.cos(want.tilt)];
      const ink = inked(deck, want.at, false);
      const place = v.art.pendant;
      const [ax, ay, az] = place.at as [number, number, number];
      const [, fy, fz] = place.facing as [number, number, number];
      const [u, w] = place.inked as [number, number];
      const r3 = (x: number): number => Math.round(x * 1000) / 1000;
      const r2 = (x: number): number => Math.round(x * 100) / 100;
      if (
        Math.abs(ax - want.at.x) > 0.0015 ||
        Math.abs(ay - want.at.y) > 0.0015 ||
        Math.abs(az - want.at.z) > 0.0015 ||
        Math.abs(fy - (facing[1] as number)) > 0.03 ||
        Math.abs(fz - (facing[2] as number)) > 0.03 ||
        Math.abs(u - ink[0]) > 0.006 ||
        Math.abs(w - ink[1]) > 0.006
      ) {
        moved.push(
          `${v.name}: pendant: { at: [${[want.at.x, want.at.y, want.at.z].map(r3).join(', ')}], facing: [${facing.map(r2).join(', ')}], inked: [${ink.map(r3).join(', ')}] }`,
        );
      }
      // Its cord's ends, of every pendant, are under the clothes.
      const f = pendantMatrix(place);
      for (const [n, g] of pendants.each.entries()) {
        for (const end of cordEnds(g)) {
          const e = end.clone().applyMatrix4(f);
          const cloth = clothAt(tris, e.x, e.y);
          if (cloth.z < e.z) {
            untucked.push(
              `${v.name}, pendant ${n + 1}: a cord's end ${((e.z - cloth.z) * 1000).toFixed(1)} mm out of the cloth`,
            );
          }
        }
      }
      // The cockade's places, set by eye, are near where the portrait's
      // camera puts them: a check of the camera, not of the eye.
      const c = v.art.cockade;
      const cockade = new Vector3(...(c.at as [number, number, number]));
      const [cu, cw] = inked(deck, cockade, cockade.y > bone.y + 0.25);
      const [iu, iw] = c.inked as [number, number];
      if (Math.abs(cu - iu) > 0.15 || Math.abs(cw - iw) > 0.15) {
        cockades.push(`${v.name}: the cockade drawn at ${cu.toFixed(3)}, ${cw.toFixed(3)}`);
      }
    }
    expect(moved, 'the catalog’s lines for the versions whose pendant has moved').toEqual([]);
    expect(untucked).toEqual([]);
    expect(cockades).toEqual([]);
  }, 60_000);

  test.each([
    ['deck', 3],
    ['close', 6],
  ] as const)(
    'in every pose of the %s level, nothing of the clothes over the pendant and no hand through it',
    async (level, step) => {
      const covered: string[] = [];
      let frames = 0;
      for (const v of VERSIONS) {
        const scene = (await load(level === 'deck' ? v.art.model : v.art.close)).scene;
        scene.updateMatrixWorld(true);
        const check = clearance(scene, v.art.pendant);
        for (const file of CLIP_FILES) {
          const path = v.art.clips.replace(/\.clips\.glb$/, `.${file}.glb`);
          let clips: AnimationClip[];
          try {
            clips = (await load(path)).animations;
          } catch {
            // A look without this boat's clips.
            continue;
          }
          for (const clip of clips) {
            const mixer = new AnimationMixer(scene);
            mixer.clipAction(clip).play();
            const last = Math.max(1, Math.round(clip.duration * 30));
            for (let fr = 0; fr <= last; fr += step) {
              mixer.setTime(fr / 30);
              scene.updateMatrixWorld(true);
              frames++;
              const what = check();
              if (what !== '') {
                covered.push(`${v.name}, ${clip.name} at frame ${fr}: ${what}`);
                break;
              }
            }
            mixer.stopAllAction();
            mixer.uncacheRoot(scene);
          }
        }
      }
      expect(covered.slice(0, 12)).toEqual([]);
      // Every boat's clips, every version.
      expect(frames).toBeGreaterThan(VERSIONS.length * 1000);
    },
    120_000,
  );
});

/** Every file of clips a look has: its own, and each boat's people's. */
const CLIP_FILES = [
  'clips',
  'wheel',
  'trapeze',
  'rail',
  'cat',
  'cruiser',
  'bridgedeck',
  'ship',
  'aloft',
];

/** The bones of a hand, by their names' starts. */
const HAND = /^(hand_|thumb_|index_|middle_|ring_|pinky_)/;

/** Points on any pendant's face, in its own frame: below its bail, its face's middle and edges, its foot, a spyglass's ends. */
const FACE = [
  [0, -0.002],
  [0, -0.016],
  [0.011, -0.016],
  [-0.011, -0.016],
  [0, -0.027],
  [0.014, -0.007],
  [-0.014, -0.007],
].map(([x, y]) => new Vector3(x, y, 0.002));
/** How near in front of the pendant's face cloth must not come, m. */
const REACH = 0.012;
/** The room a pendant takes in its own frame, which no hand may enter: across, down from its bail, and out from its back. */
const ROOM = { across: 0.017, top: 0.004, bottom: -0.031, back: -0.004, front: 0.012 };

/** Vertices of a skinned mesh, as bound, with their four bones and weights. */
interface Skinned {
  mesh: string;
  bound: Float32Array;
  bones: Uint16Array;
  weights: Float32Array;
  posed: Float32Array;
  /** Its triangles, by these vertices' places. */
  triangles: number[];
}

/**
 * A check of a posed figure (scene, its skeleton posed and its matrices
 * updated) against its pendant at place: the cloth near its chest, and its
 * hands, skinned on the CPU. It says what came over the pendant or through
 * it, '' for nothing.
 */
function clearance(scene: Object3D, place: SailorArt['pendant']): () => string {
  const skinned: SkinnedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof SkinnedMesh) {
      skinned.push(o);
    }
  });
  const skeleton = (skinned[0] as SkinnedMesh).skeleton;
  const pendant = skeleton.bones.findIndex((b) => b.name === PENDANT_BONE);
  const hand = new Set(skeleton.bones.flatMap((b, i) => (HAND.test(b.name) ? [i] : [])));
  const at = new Vector3(...(place.at as [number, number, number]));
  const cloth: Skinned[] = [];
  const hands: Skinned[] = [];
  for (const m of skinned) {
    if (m.name === 'hair' || m.name === 'beard') {
      continue;
    }
    const g = m.geometry;
    const p = g.getAttribute('position');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const near = new Map<number, number>();
    const c = { bound: [] as number[], bones: [] as number[], weights: [] as number[] };
    const h = { bound: [] as number[], bones: [] as number[], weights: [] as number[] };
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      let onHand = 0;
      for (let k = 0; k < 4; k++) {
        if (hand.has(si.getComponent(i, k))) {
          onHand += sw.getComponent(i, k);
        }
      }
      const into: (typeof c)[] = [];
      if (onHand > 0.5) {
        into.push(h);
      }
      // Near the chest, in front.
      if (Math.abs(x) < 0.14 && Math.abs(y - at.y) < 0.14 && z > at.z - 0.12) {
        near.set(i, c.bound.length / 3);
        into.push(c);
      }
      for (const t of into) {
        t.bound.push(x, y, z);
        for (let k = 0; k < 4; k++) {
          t.bones.push(si.getComponent(i, k));
          t.weights.push(sw.getComponent(i, k));
        }
      }
    }
    const triangles: number[] = [];
    const index = g.index;
    for (let k = 0; index !== null && k < index.count; k += 3) {
      const a = near.get(index.getX(k));
      const b = near.get(index.getX(k + 1));
      const d = near.get(index.getX(k + 2));
      if (a !== undefined && b !== undefined && d !== undefined) {
        triangles.push(a, b, d);
      }
    }
    const made = (t: typeof c, tri: number[]): Skinned => ({
      mesh: m.name,
      bound: new Float32Array(t.bound),
      bones: new Uint16Array(t.bones),
      weights: new Float32Array(t.weights),
      posed: new Float32Array(t.bound.length),
      triangles: tri,
    });
    if (triangles.length > 0) {
      cloth.push(made(c, triangles));
    }
    if (h.bound.length > 0) {
      hands.push(made(h, []));
    }
  }
  const matrices = skeleton.bones.map(() => new Matrix4());
  const v = new Vector3();
  const sum = new Vector3();
  const term = new Vector3();
  const pose = (s: Skinned): void => {
    for (let i = 0; i < s.bound.length / 3; i++) {
      v.fromArray(s.bound, 3 * i);
      sum.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = s.weights[4 * i + k] as number;
        if (w > 0) {
          sum.add(
            term
              .copy(v)
              .applyMatrix4(matrices[s.bones[4 * i + k] as number] as Matrix4)
              .multiplyScalar(w),
          );
        }
      }
      sum.toArray(s.posed, 3 * i);
    }
  };
  const own = pendantMatrix(place);
  const frame = new Matrix4();
  const back = new Matrix4();
  const out = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const hit = new Vector3();
  const box = new Box3();
  return () => {
    for (const [i, m] of matrices.entries()) {
      m.multiplyMatrices(
        (skeleton.bones[i] as SkinnedMesh['skeleton']['bones'][number]).matrixWorld,
        skeleton.boneInverses[i] as Matrix4,
      );
    }
    frame.multiplyMatrices(matrices[pendant] as Matrix4, own);
    back.copy(frame).invert();
    out.set(0, 0, 1).transformDirection(frame);
    const points = FACE.map((p) => p.clone().applyMatrix4(frame));
    box.makeEmpty();
    for (const p of points) {
      box.expandByPoint(p);
      box.expandByPoint(p.clone().addScaledVector(out, REACH));
    }
    for (const s of cloth) {
      pose(s);
      const t = s.triangles;
      for (let k = 0; k < t.length; k += 3) {
        a.fromArray(s.posed, 3 * (t[k] as number));
        b.fromArray(s.posed, 3 * (t[k + 1] as number));
        c.fromArray(s.posed, 3 * (t[k + 2] as number));
        if (
          Math.max(a.x, b.x, c.x) < box.min.x ||
          Math.min(a.x, b.x, c.x) > box.max.x ||
          Math.max(a.y, b.y, c.y) < box.min.y ||
          Math.min(a.y, b.y, c.y) > box.max.y ||
          Math.max(a.z, b.z, c.z) < box.min.z ||
          Math.min(a.z, b.z, c.z) > box.max.z
        ) {
          continue;
        }
        for (const p of points) {
          const ray = new Ray(p, out);
          if (ray.intersectTriangle(a, b, c, false, hit) !== null && hit.distanceTo(p) < REACH) {
            return `the ${s.mesh} ${(hit.distanceTo(p) * 1000).toFixed(1)} mm over it`;
          }
        }
      }
    }
    for (const s of hands) {
      pose(s);
      for (let k = 0; k < s.posed.length; k += 3) {
        a.fromArray(s.posed, k).applyMatrix4(back);
        if (
          Math.abs(a.x) < ROOM.across &&
          a.y < ROOM.top &&
          a.y > ROOM.bottom &&
          a.z > ROOM.back &&
          a.z < ROOM.front
        ) {
          return `a hand (${s.mesh}) through it`;
        }
      }
    }
    return '';
  };
}

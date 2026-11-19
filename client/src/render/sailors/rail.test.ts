// SPDX-License-Identifier: AGPL-3.0-only

// The crew's clips on a keelboat's rail and their crouch, read from the
// committed files for every look and version: on the keelboat's rail (her
// model's `rail` node), sat on the deck's edge facing outboard on each
// side, upright and leaning out, the hips on the deck, the knees out past
// its edge and the shins down the topsides, nothing in her hull in any
// frame; the crouch on a flat deck, the walk's feet that bear on it moving
// back at CROUCH_SPEED without sliding, the head's joint under
// CROUCH_HEAD, nothing but the feet on the deck. And the far figure made
// on the rail from the far level, on the deck and out of the hull.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  type Object3D,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { seatFigure } from '../fleetparts';
import { Clip, Pose } from './clips';
import { railFigures } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import {
  CROUCH_CLIPS,
  CROUCH_HEAD,
  CROUCH_SPEED,
  inRailFile,
  onRail,
  RAIL_CLIPS,
  railClips,
  railEdge,
  railPlace,
  railSide,
} from './rail';
import { Rig } from './rig';
import { ballInside, hullSolid, inside } from './solid';

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

/** A look's clips and those of its rail's file, on its clips' skeleton. */
async function clipsOf(art: { clips: string }): Promise<{ rig: Rig; clips: Map<string, Clip> }> {
  const main = await load(art.clips);
  const rig = Rig.from(main.scene, boneNames(main.scene));
  const clips = new Map<string, Clip>();
  for (const file of [main, await load(railClips(art.clips))]) {
    const places = placesOf(file.scene);
    for (const a of file.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
      );
    }
  }
  return { rig, clips };
}

/** Poses the rig in a clip at t seconds. */
function pose(rig: Rig, clip: Clip, t: number): void {
  const p = new Pose(rig.names.length).rest(rig);
  clip.sample(t, p);
  p.to(rig);
  rig.fk();
}

/** The body's capsules: a bone to the next down its chain, and a radius. */
const CAPSULES: [string, string, number][] = [
  ['pelvis', 'spine_02', 0.08],
  ['spine_02', 'neck_01', 0.09],
  ['upperarm_l', 'lowerarm_l', 0.04],
  ['lowerarm_l', 'hand_l', 0.035],
  ['upperarm_r', 'lowerarm_r', 0.04],
  ['lowerarm_r', 'hand_r', 0.035],
  ['thigh_l', 'calf_l', 0.055],
  ['calf_l', 'foot_l', 0.045],
  ['foot_l', 'ball_l', 0.02],
  ['thigh_r', 'calf_r', 0.055],
  ['calf_r', 'foot_r', 0.045],
  ['foot_r', 'ball_r', 0.02],
];

const looks = catalog.sailors.flatMap((s) =>
  s.versions.map((v) => ({ name: `${s.id} ${v.id}`, art: v.art })),
);

let found: Promise<{ solid: NonNullable<ReturnType<typeof hullSolid>>; edge: Vector3 }> | null =
  null;

/**
 * The boat whose model has a rail and whose people sit on it with the rail's
 * own clips, naming no clips of their own (the keelboat; a cruising yacht's
 * sit on her rail with hers): her hull's solid, and her rail's edge.
 */
function theKeelboat() {
  found ??= (async () => {
    for (const kind of catalog.boats.filter((k) => (k.art.sailorClips ?? []).length === 0)) {
      const boat = (await load(kind.art.model)).scene;
      boat.updateMatrixWorld(true);
      const parts = new Map<string, Object3D>();
      boat.traverse((o) => {
        if (o.name !== '') {
          parts.set(o.name, o);
        }
      });
      const edge = railEdge(parts);
      if (edge === null) {
        continue;
      }
      const root = (boat.getObjectByName('board-root') as Object3D).getWorldPosition(new Vector3());
      const solid = hullSolid(boat.getObjectByName('hull')?.userData, root, {
        span: kind.physics.foils.boardSpan,
        chord: kind.physics.foils.boardChord,
      });
      if (solid === null) {
        throw new Error(`${kind.name} has no solid`);
      }
      return { solid, edge };
    }
    throw new Error('no boat has a rail');
  })();
  return found;
}

test('the rail’s clips and the crouch’s are named and placed as the game asks for them', () => {
  expect(onRail(RAIL_CLIPS.up)).toBe(true);
  expect(onRail(`${RAIL_CLIPS.out}-port`)).toBe(true);
  expect(onRail(CROUCH_CLIPS.walk)).toBe(false);
  expect(inRailFile(CROUCH_CLIPS.walk)).toBe(true);
  expect(inRailFile('helm')).toBe(false);
  expect(railSide('rail-out-port')).toBe(-1);
  expect(railSide('rail')).toBe(1);
  expect(railClips('sailors/rover/female.clips.glb')).toBe('sailors/rover/female.rail.glb');
  const at = railPlace(new Matrix4(), new Vector3(1.2, 0.7, -0.66), -1);
  expect(new Vector3().setFromMatrixPosition(at).toArray()).toEqual([-1.2, 0.7, -0.66]);
});

describe.each(looks)('$name', ({ art }) => {
  test('on the keelboat’s rail, each side, upright and leaning out: the hips on her deck, the knees past its edge, the shins down the topsides, nothing in her hull', async () => {
    const { rig, clips } = await clipsOf(art);
    const { solid, edge } = await theKeelboat();
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const bad: string[] = [];
    for (const name of [RAIL_CLIPS.up, RAIL_CLIPS.out].flatMap((n) => [n, `${n}-port`])) {
      const clip = clips.get(name);
      expect(clip?.place, name).toBeDefined();
      const side = railSide(name);
      const place = railPlace(clip?.place as Matrix4, edge, side);
      const at = (bone: string, out: Vector3): Vector3 =>
        rig.position(rig.bone(bone), out).applyMatrix4(place);
      for (let t = 0; t < (clip as Clip).duration; t += 0.5) {
        pose(rig, clip as Clip, t);
        const hips = at('pelvis', a);
        expect(side * hips.x, `${name} hips in from the edge`).toBeLessThan(edge.x - 0.15);
        expect(hips.y, `${name} hips over the deck`).toBeGreaterThan(edge.y + 0.05);
        for (const s of ['l', 'r']) {
          const knee = at(`calf_${s}`, b);
          expect(side * knee.x, `${name} knee out past the edge`).toBeGreaterThan(edge.x);
          const ankle = at(`foot_${s}`, c);
          expect(ankle.y, `${name} the shin down the topsides`).toBeLessThan(edge.y - 0.25);
        }
        for (const [from, to, r] of CAPSULES) {
          at(from, a);
          at(to, b);
          for (let k = 0; k <= 4; k++) {
            c.lerpVectors(a, b, k / 4);
            if (ballInside(solid, c.x, c.y, c.z, r)) {
              bad.push(`${name} at ${t}: ${from}→${to} at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}`);
              break;
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('the crouch on a flat deck: the walk’s feet still on it as the figure goes forward at its speed, the head down, nothing but the feet on it', async () => {
    const { rig, clips } = await clipsOf(art);
    const v = new Vector3();
    for (const name of Object.values(CROUCH_CLIPS)) {
      const clip = clips.get(name) as Clip;
      expect(clip, name).toBeDefined();
      expect(clip.place, name).toBeNull();
      const frames = Math.round(clip.duration * 30);
      const rest = (() => {
        rig.reset();
        rig.fk();
        return rig.position(rig.bone('pelvis'), new Vector3()).y;
      })();
      // Each foot's ankle and ball, a frame at a time.
      const track: Record<string, { ball: Vector3 }[]> = { l: [], r: [] };
      for (let f = 0; f <= frames; f++) {
        pose(rig, clip, Math.min(f / 30, clip.duration));
        const hips = rig.position(rig.bone('pelvis'), v).y;
        if (hips < 0.55 * rest) {
          expect(rig.position(rig.bone('head'), v).y, `${name} head at ${f}`).toBeLessThan(
            CROUCH_HEAD + 0.005,
          );
        }
        for (const s of ['l', 'r'] as const) {
          for (const d of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
            expect(
              rig.position(rig.bone(`${d}_03_${s}`), v).y,
              `${name} ${d} at ${f}`,
            ).toBeGreaterThan(0.02);
          }
          expect(rig.position(rig.bone(`calf_${s}`), v).y, `${name} knee at ${f}`).toBeGreaterThan(
            0.06,
          );
          track[s]?.push({ ball: rig.position(rig.bone(`ball_${s}`), new Vector3()) });
        }
      }
      const speed = name === CROUCH_CLIPS.walk ? CROUCH_SPEED : 0;
      for (const s of ['l', 'r'] as const) {
        const t = track[s] as { ball: Vector3 }[];
        const ballLow = Math.min(...t.map((p) => p.ball.y));
        // On the deck: the ball of the foot at its lowest; and, walking,
        // going back under the figure, as a foot bearing does (one passing
        // low in the air goes forward).
        const flat = t.map((p, f) => {
          const next = t[Math.min(f + 1, t.length - 1)] as { ball: Vector3 };
          const before = t[Math.max(f - 1, 0)] as { ball: Vector3 };
          const back = (before.ball.z - next.ball.z) * 15;
          return p.ball.y < ballLow + 0.01 && (speed === 0 || back > speed / 2);
        });
        let worst = 0;
        let drift = new Vector3();
        for (let f = 1; f < t.length; f++) {
          if (!(flat[f] && flat[f - 1])) {
            drift = new Vector3();
            continue;
          }
          const step = v.subVectors(
            (t[f] as { ball: Vector3 }).ball,
            (t[f - 1] as { ball: Vector3 }).ball,
          );
          step.z += speed / 30;
          step.y = 0;
          drift.add(step);
          worst = Math.max(worst, drift.length());
        }
        // The ball's joint rolls a little over the toes as the heel lifts;
        // the build holds the bearing point itself to 1 cm.
        expect(worst, `${name} ${s} slides`).toBeLessThan(0.03);
        if (name === CROUCH_CLIPS.walk) {
          expect(flat.filter((x) => x).length, `${name} ${s} bears`).toBeGreaterThan(5);
        }
      }
    }
  });
});

test('the far figure on the rail, made from the far level: on the deck, its legs over the side, out of the hull', async () => {
  const sailor = catalog.sailors[0]?.versions[0];
  const stage = catalog.boats[0];
  if (sailor === undefined || stage === undefined) {
    throw new Error('no sailor');
  }
  const { solid, edge } = await theKeelboat();
  // The far figure seated as the fleet seats it: in the stage's boat.
  const stageBoat = (await load(stage.art.model)).scene;
  stageBoat.updateMatrixWorld(true);
  const pos = (name: string): Vector3 =>
    (stageBoat.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
  const g = pos('gunwale');
  const seat = { out: g.x, y: g.y, z: pos('sailor').z };
  const far = (await load(sailor.art.far)).scene;
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
  const deck = (await load(sailor.art.model)).scene;
  const rig = Rig.from(deck, boneNames(deck));
  const { clips } = await clipsOf(sailor.art);
  const made = railFigures(seated, seat, clips, rig);
  expect(made === null ? [] : [...made.keys()].sort()).toEqual([
    'rail',
    'rail-out',
    'rail-out-port',
    'rail-port',
  ]);
  const v = new Vector3();
  for (const [name, figure] of made ?? []) {
    const side = railSide(name);
    const p = figure.getAttribute('position');
    let low = Number.POSITIVE_INFINITY;
    let outboard = 0;
    let through = 0;
    for (let i = 0; i < p.count; i++) {
      // From the deck's edge on its side, as the game places it.
      v.fromBufferAttribute(p, i).add(new Vector3(side * edge.x, edge.y, edge.z));
      low = Math.min(low, v.y);
      if (side * v.x > edge.x) {
        outboard++;
      }
      if (inside(solid, v.x, v.y + 0.01, v.z)) {
        through++;
      }
    }
    // The legs down the topsides, a good share of it outboard, none of it in the hull.
    expect(low, name).toBeLessThan(edge.y - 0.3);
    expect(outboard / p.count, name).toBeGreaterThan(0.15);
    expect(through, name).toBe(0);
  }
});

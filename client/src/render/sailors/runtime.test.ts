// SPDX-License-Identifier: AGPL-3.0-only

// The sailor runtime on the Rover's clips and the game's dinghy, read from
// the committed files: the clips sampled and blended, the aft hand kept on
// the tiller extension as the rudder swings it, and through a capsize every
// body capsule outside the hull's solid and the daggerboard in every frame
// of every mode and every change between them.

import { readFileSync } from 'node:fs';
import { type AnimationClip, Matrix4, type Object3D, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, test } from 'vitest';
import { CLIMBING, IN_WATER, ON_BOARD, SAILING } from '../sailor';
import { Clip, Pose } from './clips';
import { twoBone } from './ik';
import { placesOf } from './model';
import { Rig } from './rig';
import { CLIPS, type SailorBoat, type SailorMoment, SailorRuntime } from './runtime';
import { ballInside, hullSolid } from './solid';

const ART = new URL('../../../../art/', import.meta.url);

async function load(path: string): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buf = readFileSync(new URL(path, ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return loader.parseAsync(ab as ArrayBuffer, '');
}

/** The skeleton's bones: the Root node and everything under it. */
function boneNames(scene: Object3D): string[] {
  const root = scene.getObjectByName('Root');
  const out: string[] = [];
  root?.traverse((o) => out.push(o.name));
  return out;
}

async function sailor(version: 'female' | 'male'): Promise<{
  rig: Rig;
  clips: Map<string, Clip>;
  boat: SailorBoat;
}> {
  const gltf = await load(`sailors/rover/${version}.clips.glb`);
  const places = placesOf(gltf.scene);
  const rig = Rig.from(gltf.scene, boneNames(gltf.scene));
  const clips = new Map<string, Clip>();
  for (const a of gltf.animations) {
    const place = places.get(`place-${a.name}`) ?? null;
    clips.set(
      a.name,
      Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
    );
  }
  const boat = await load('boats/jolly-boat.glb');
  boat.scene.updateMatrixWorld(true);
  const node = (name: string): Vector3 => {
    const o = boat.scene.getObjectByName(name);
    if (o === undefined) {
      throw new Error(`no ${name}`);
    }
    return o.getWorldPosition(new Vector3());
  };
  const solid = hullSolid(boat.scene.getObjectByName('hull')?.userData, node('board-root'), {
    span: 0.69,
    chord: 0.3,
  });
  if (solid === null) {
    throw new Error('no solid');
  }
  const hinge = node('extension');
  const seat = node('sailor');
  return {
    rig,
    clips,
    boat: {
      hinge: hinge.clone(),
      hingeRest: hinge.clone(),
      extension: hinge.distanceTo(node('grip')),
      seatY: node('gunwale').y,
      seatIn: solid.cockpit.halfWidth,
      seatOut: node('gunwale').x,
      seatZ: seat.z,
      cog: 0.3,
      solid,
      climbTime: 4,
    },
  };
}

/** The body's capsules: a bone to the next down its chain, and a radius. */
const CAPSULES: [string, string, number][] = [
  ['pelvis', 'spine_02', 0.08],
  ['spine_02', 'neck_01', 0.09],
  ['neck_01', 'head', 0.05],
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

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();

/** The capsules of the posed figure that are inside the boat. */
function through(rt: SailorRuntime, rig: Rig, boat: SailorBoat): string[] {
  const out: string[] = [];
  for (const [from, to, r] of CAPSULES) {
    rig.position(rig.bone(from), a).applyMatrix4(rt.root);
    rig.position(rig.bone(to), b).applyMatrix4(rt.root);
    for (let k = 0; k <= 4; k++) {
      c.lerpVectors(a, b, k / 4);
      if (ballInside(boat.solid, c.x, c.y, c.z, r)) {
        out.push(`${from}→${to} at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`);
        break;
      }
    }
  }
  return out;
}

/** A bone's height over the water as the boat lies heeled (about its pivot at cog). */
function levelHeight(rt: SailorRuntime, rig: Rig, bone: string, cog: number, heel: number): number {
  rig.position(rig.bone(bone), a).applyMatrix4(rt.root);
  a.y -= cog;
  a.applyAxisAngle(new Vector3(0, 0, 1), -heel);
  return a.y + cog;
}

function moment(over: Partial<SailorMoment>): SailorMoment {
  return {
    dt: 1 / 30,
    time: 0,
    offset: 0.6,
    mode: SAILING,
    timer: 0,
    heel: 0,
    pitch: 0,
    heave: 0,
    windSpeed: 5,
    windAngle: 0.8,
    rollRate: 0,
    still: false,
    ...over,
  };
}

describe.each(['female', 'male'] as const)('the Rover, %s', (version) => {
  test('has every clip the runtime asks for, each side', async () => {
    const { clips } = await sailor(version);
    for (const name of [CLIPS.helm, ...CLIPS.hiking, CLIPS.cross, CLIPS.habit, CLIPS.climb]) {
      expect(clips.has(name), name).toBe(true);
      expect(clips.has(`${name}-port`), `${name}-port`).toBe(true);
    }
    for (const name of [CLIPS.water, CLIPS.board, CLIPS.standing, CLIPS.standingHabit]) {
      expect(clips.has(name), name).toBe(true);
    }
    // Those seated in the boat say where.
    expect(clips.get(CLIPS.helm)?.place).not.toBeNull();
    expect(clips.get(CLIPS.water)?.place).toBeNull();
  });

  test('a clip sampled is the same pose at its loop’s ends, and blends to itself', async () => {
    const { rig, clips } = await sailor(version);
    const helm = clips.get(CLIPS.helm) as Clip;
    const p0 = new Pose(rig.names.length).rest(rig);
    const p1 = new Pose(rig.names.length).rest(rig);
    helm.sample(0, p0);
    helm.sample(helm.duration, p1);
    for (let i = 0; i < p0.quat.length; i++) {
      expect(Math.abs(p0.quat[i] as number)).toBeCloseTo(Math.abs(p1.quat[i] as number), 2);
    }
    const sum = new Pose(rig.names.length).clear().add(p0, 0.3).add(p0, 0.7).normalize(1);
    for (let i = 0; i < p0.quat.length; i++) {
      expect(sum.quat[i]).toBeCloseTo(p0.quat[i] as number, 4);
    }
  });

  test('two-bone IK brings a hand to a target within its reach', async () => {
    const { rig, clips } = await sailor(version);
    const pose = new Pose(rig.names.length).rest(rig);
    (clips.get(CLIPS.helm) as Clip).sample(1, pose);
    pose.to(rig);
    rig.fk();
    const hand = rig.bone('hand_l');
    const start = rig.position(hand, new Vector3());
    const target = start.clone().add(new Vector3(0.05, 0.04, -0.06));
    twoBone(rig, rig.bone('upperarm_l'), rig.bone('lowerarm_l'), hand, target);
    expect(rig.position(hand, new Vector3()).distanceTo(target)).toBeLessThan(0.002);
  });

  test('the aft hand stays on the extension as the rudder swings it', async () => {
    const { rig, clips, boat } = await sailor(version);
    const rt = new SailorRuntime(rig, clips, boat, 1);
    for (const swing of [0, 0.4, -0.4]) {
      // The hinge swung on the rudder's stock, 1.05 m forward of it.
      boat.hinge.set(
        boat.hingeRest.z > 0 ? -1.05 * Math.sin(swing) : 0,
        boat.hingeRest.y,
        boat.hingeRest.z,
      );
      boat.hinge.z = boat.hingeRest.z + 1.05 * (1 - Math.cos(swing));
      for (let f = 0; f < 10; f++) {
        rt.update(moment({ time: f / 30 }));
      }
      expect(rt.hands.tiller).toBe(true);
      const d = rt.hands.tillerAt.distanceTo(boat.hinge);
      expect(d).toBeLessThanOrEqual(boat.extension + 1e-3);
      const hand = rig.position(rig.bone('hand_l'), new Vector3()).applyMatrix4(rt.root);
      expect(hand.distanceTo(rt.hands.tillerAt)).toBeLessThan(0.01);
    }
  });

  test('crosses the boat when the side changes, and sits on the other side', async () => {
    const { rig, clips, boat } = await sailor(version);
    const rt = new SailorRuntime(rig, clips, boat, 2);
    let t = 0;
    for (let f = 0; f < 30; f++, t += 1 / 30) {
      rt.update(moment({ time: t, offset: 0.6 }));
    }
    expect(rt.side).toBe(1);
    const bad: string[] = [];
    let crossed = false;
    for (let f = 0; f < 200; f++, t += 1 / 30) {
      rt.update(moment({ time: t, offset: -0.6 }));
      crossed ||= rt.crossing;
      bad.push(...through(rt, rig, boat).map((x) => `frame ${f}: ${x}`));
    }
    expect(crossed).toBe(true);
    expect(rt.side).toBe(-1);
    expect(rt.place.at.x).toBeLessThan(0);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test.each([1, -1])(
    'a capsize to %i is swum, climbed and righted with no limb through the hull or board',
    async (way) => {
      const { rig, clips, boat } = await sailor(version);
      const rt = new SailorRuntime(rig, clips, boat, 3);
      const deg = Math.PI / 180;
      const bad: string[] = [];
      let t = 0;
      const run = (frames: number, at: (k: number) => Partial<SailorMoment>): void => {
        for (let k = 0; k < frames; k++, t += 1 / 30) {
          rt.update(moment({ time: t, ...at(k / frames) }));
          bad.push(...through(rt, rig, boat).map((x) => `t ${t.toFixed(2)}: ${x}`));
        }
      };
      // Sailing on the high side, then heeling over until the sailor falls in.
      run(30, () => ({ offset: -way * 0.7, heel: way * 20 * deg }));
      run(30, (f) => ({ offset: -way * 0.9, heel: way * (20 + 50 * f) * deg }));
      // In the water, the boat going on over to her side: the head above
      // the surface, the hips below it.
      const heads: number[] = [];
      const hips: number[] = [];
      run(90, (f) => {
        if (f > 0) {
          heads.push(levelHeight(rt, rig, 'head', boat.cog, way * (75 + 15 * f) * deg));
          hips.push(levelHeight(rt, rig, 'pelvis', boat.cog, way * (75 + 15 * f) * deg));
        }
        return { mode: IN_WATER, offset: 0, heel: way * (75 + 15 * f) * deg, timer: 3 - 3 * f };
      });
      expect(Math.min(...heads)).toBeGreaterThan(0.05);
      expect(Math.max(...hips)).toBeLessThan(0);
      // On the board, righting her.
      run(120, (f) => ({ mode: ON_BOARD, offset: 0, heel: way * (90 - 62 * f) * deg }));
      // Climbing in as she comes up.
      run(120, (f) => ({
        mode: CLIMBING,
        offset: 0,
        heel: way * (28 - 25 * f) * deg,
        timer: 4 - 4 * f,
      }));
      // Sailing again.
      run(30, () => ({ mode: SAILING, offset: -way * 0.6, heel: way * 3 * deg }));
      expect(bad.slice(0, 8)).toEqual([]);
    },
  );
});

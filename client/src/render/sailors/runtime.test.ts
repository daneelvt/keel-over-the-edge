// SPDX-License-Identifier: AGPL-3.0-only

// The sailor runtime on the Rover's and the machines' clips and the game's
// dinghy, read from
// the committed files: the clips sampled and blended, the aft hand kept on
// the tiller extension as the rudder swings it, and through a capsize every
// body capsule outside the hull's solid and the daggerboard in every frame
// of every mode and every change between them. And on every other boat,
// the clips moved to its seat: at the helm, hiking and crossing, nothing
// through its hull, the hips on its side deck and the hand on its tiller.

import { existsSync, readFileSync } from 'node:fs';
import { type AnimationClip, Matrix4, type Object3D, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { CLIMBING, IN_WATER, ON_BOARD, SAILING } from '../sailor';
import { Clip, Pose } from './clips';
import { twoBone } from './ik';
import { placesOf } from './model';
import { restageClip, seating } from './restage';
import { Rig } from './rig';
import {
  CLIPS,
  type SailorBoat,
  type SailorMoment,
  SailorRuntime,
  type WheelHelm,
} from './runtime';
import { ballInside, hullSolid } from './solid';
import { trapezeData, trapezeOf } from './trapeze';
import { wheelData, wheelOf } from './wheel';

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

async function sailor(
  version: 'female' | 'male',
  look = 'rover',
  model = 'boats/jolly-boat.glb',
  /** On a boat with a trapeze, its clips on the wire too, and the trapeze. */
  wire = false,
): Promise<{
  rig: Rig;
  clips: Map<string, Clip>;
  boat: SailorBoat;
}> {
  const gltf = await load(`sailors/${look}/${version}.clips.glb`);
  const rig = Rig.from(gltf.scene, boneNames(gltf.scene));
  const clips = new Map<string, Clip>();
  // And its clips at a wheel, and on the wire, files of their own.
  const files = [gltf, await load(`sailors/${look}/${version}.wheel.glb`)];
  if (wire) {
    files.push(await load(`sailors/${look}/${version}.trapeze.glb`));
  }
  for (const file of files) {
    const places = placesOf(file.scene);
    for (const a of file.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
      );
    }
  }
  const boat = await load(model);
  boat.scene.updateMatrixWorld(true);
  const kind = catalog.boats.find((b) => b.art.model === model);
  if (kind === undefined) {
    throw new Error(`no boat ${model}`);
  }
  const parts = new Map<string, Object3D>();
  boat.scene.traverse((o) => {
    if (o.name !== '') {
      parts.set(o.name, o);
    }
  });
  const node = (name: string): Vector3 => {
    const o = boat.scene.getObjectByName(name);
    if (o === undefined) {
      throw new Error(`no ${name}`);
    }
    return o.getWorldPosition(new Vector3());
  };
  const solid = hullSolid(boat.scene.getObjectByName('hull')?.userData, node('board-root'), {
    span: kind.physics.foils.boardSpan,
    chord: kind.physics.foils.boardChord,
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
      cog: kind.physics.hull.centreOfGravity,
      solid,
      climbTime: kind.physics.sailor.climbTime,
      ...seating(parts, kind.physics.sailor.hikeReach),
      trapeze: wire ? trapezeOf(parts, kind.physics.sailor.hikeReach) : null,
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

describe.each([
  ['rover', 'female'],
  ['rover', 'male'],
  ['machine', 'female'],
  ['machine', 'male'],
] as const)('the %s, %s', (look, version) => {
  test('has every clip the runtime asks for, each side', async () => {
    const { clips } = await sailor(version, look);
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
    const { rig, clips } = await sailor(version, look);
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
    const { rig, clips } = await sailor(version, look);
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
    const { rig, clips, boat } = await sailor(version, look);
    const rt = new SailorRuntime(rig, clips, boat, 1, look === 'machine');
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
    const { rig, clips, boat } = await sailor(version, look);
    const rt = new SailorRuntime(rig, clips, boat, 2, look === 'machine');
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
      const { rig, clips, boat } = await sailor(version, look);
      const rt = new SailorRuntime(rig, clips, boat, 3, look === 'machine');
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

/** Whether a boat's model has a wheel: a node whose data says it is one. */
function steeredByWheel(model: string): boolean {
  const glb = readFileSync(new URL(model, ART));
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    nodes?: { extras?: unknown }[];
  };
  return (gltf.nodes ?? []).some((n) => wheelData(n.extras) !== null);
}

/** Every boat but the one the clips were placed in, and those whose sailor stands at a wheel. */
const others = catalog.boats.filter(
  (b) => b.art.model !== 'boats/jolly-boat.glb' && !steeredByWheel(b.art.model),
);

describe.each(
  others.flatMap((b) =>
    (
      [
        ['rover', 'female'],
        ['rover', 'male'],
        ['machine', 'female'],
      ] as const
    ).map(([look, version]) => [b.name, look, version, b.art.model] as const),
  ),
)('on the %s, the %s, %s', (_, look, version, model) => {
  /** The hips' place in the boat, and the side deck's edges and height there. */
  const hips = (rt: SailorRuntime, rig: Rig): Vector3 =>
    rig.position(rig.bone('pelvis'), new Vector3()).applyMatrix4(rt.root);

  test('the clips are moved to its seat, and a move of nothing moves nothing', async () => {
    const stage = await sailor(version, look);
    const here = await sailor(version, look, model);
    const by = here.boat.restage as Vector3;
    expect(by).not.toBeNull();
    for (const name of [CLIPS.helm, `${CLIPS.helm}-port`, CLIPS.cross]) {
      const was = stage.clips.get(name)?.place as Matrix4;
      const now = restageClip(stage.clips.get(name) as Clip, stage.rig, by).place as Matrix4;
      const side = name.endsWith('-port') ? -1 : 1;
      const moved = new Vector3().setFromMatrixPosition(now);
      moved.sub(new Vector3().setFromMatrixPosition(was));
      expect(moved.distanceTo(new Vector3(side * by.x, by.y, by.z))).toBeLessThan(1e-6);
      const same = restageClip(stage.clips.get(name) as Clip, stage.rig, new Vector3());
      const orig = stage.clips.get(name) as Clip;
      for (let k = 0; k < orig.tracks.length; k++) {
        const a = orig.tracks[k]?.values as Float32Array;
        const b = same.tracks[k]?.values as Float32Array;
        for (let i = 0; i < a.length; i++) {
          expect(b[i]).toBeCloseTo(a[i] as number, 5);
        }
      }
    }
  });

  test('sits at the helm on its side deck, the hand on the tiller, nothing through the hull', async () => {
    const { rig, clips, boat } = await sailor(version, look, model);
    const rt = new SailorRuntime(rig, clips, boat, 4, look === 'machine');
    const bad: string[] = [];
    for (const swing of [0, 0.35, -0.35]) {
      const reach = boat.hingeRest.z - foils(model).rudderPosition;
      boat.hinge.set(
        reach * Math.sin(swing),
        boat.hingeRest.y,
        foils(model).rudderPosition + reach * Math.cos(swing),
      );
      for (let f = 0; f < 20; f++) {
        rt.update(moment({ time: f / 30, offset: 0.5 }));
        bad.push(...through(rt, rig, boat).map((x) => `swing ${swing} frame ${f}: ${x}`));
      }
      expect(rt.hands.tiller).toBe(true);
      expect(rt.hands.tillerAt.distanceTo(boat.hinge)).toBeLessThanOrEqual(boat.extension + 1e-3);
      const hand = rig.position(rig.bone('hand_l'), new Vector3()).applyMatrix4(rt.root);
      expect(hand.distanceTo(rt.hands.tillerAt)).toBeLessThan(0.01);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    const h = hips(rt, rig);
    expect(h.x).toBeGreaterThan(boat.seatIn);
    expect(h.x).toBeLessThan(boat.seatOut);
    expect(h.y).toBeGreaterThan(boat.seatY);
    expect(h.y).toBeLessThan(boat.seatY + 0.3);
    expect(Math.abs(h.z - boat.seatZ)).toBeLessThan(0.3);
  });

  test('hikes out only to the rail, nothing through the hull', async () => {
    const { rig, clips, boat } = await sailor(version, look, model);
    const rt = new SailorRuntime(rig, clips, boat, 5, look === 'machine');
    const reach = catalog.boats.find((b) => b.art.model === model)?.physics.sailor.hikeReach ?? 0;
    const bad: string[] = [];
    for (let f = 0; f < 60; f++) {
      rt.update(moment({ time: f / 30, offset: reach, heel: -0.2 }));
      bad.push(...through(rt, rig, boat).map((x) => `frame ${f}: ${x}`));
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // On the rail: the hips at the gunwale, no further.
    const h = hips(rt, rig);
    expect(h.x).toBeGreaterThan(boat.seatOut - 0.2);
    expect(h.x).toBeLessThan(boat.seatOut + 0.05);
    expect(h.y).toBeGreaterThan(boat.seatY);
  });

  test('crosses the boat when the side changes, and sits on the other side deck', async () => {
    const { rig, clips, boat } = await sailor(version, look, model);
    const rt = new SailorRuntime(rig, clips, boat, 6, look === 'machine');
    let t = 0;
    for (let f = 0; f < 30; f++, t += 1 / 30) {
      rt.update(moment({ time: t, offset: 0.6 }));
    }
    const start = hips(rt, rig);
    const bad: string[] = [];
    let crossed = false;
    for (let f = 0; f < 240; f++, t += 1 / 30) {
      rt.update(moment({ time: t, offset: -0.6 }));
      crossed ||= rt.crossing;
      bad.push(...through(rt, rig, boat).map((x) => `frame ${f}: ${x}`));
    }
    expect(crossed).toBe(true);
    expect(rt.side).toBe(-1);
    expect(bad.slice(0, 5)).toEqual([]);
    const end = hips(rt, rig);
    expect(end.x).toBeLessThan(-boat.seatIn);
    expect(end.x).toBeCloseTo(-start.x, 1);
    expect(end.y).toBeCloseTo(start.y, 1);
  });
});

function foils(model: string): { rudderPosition: number } {
  const kind = catalog.boats.find((b) => b.art.model === model);
  if (kind === undefined) {
    throw new Error(`no boat ${model}`);
  }
  return kind.physics.foils;
}

/** Every look, each version: the clips at the wheel are every sailor's. */
const LOOKS = [
  'bosun',
  'buccaneer',
  'cavalier',
  'chartmaker',
  'lookout',
  'machine',
  'oldsalt',
  'quartermaster',
  'rover',
  'shipwright',
] as const;

/**
 * A boat's wheel: a model's that has one (its `wheel` node), or one made to
 * the numbers the ships' models are built to (the hub 0.55 m ahead of the
 * helmsman's place and 1.05 m above the deck, 0.75 m to the rim, 8 spokes),
 * at a quarterdeck's place.
 */
async function aWheel(): Promise<WheelHelm> {
  for (const kind of catalog.boats) {
    const boat = await load(kind.art.model);
    const parts = new Map<string, Object3D>();
    boat.scene.traverse((o) => {
      if (o.name !== '') {
        parts.set(o.name, o);
      }
    });
    const w = wheelOf(parts, boat.scene);
    if (w !== null) {
      return w;
    }
  }
  const stand = new Matrix4().makeTranslation(0, 4.5, 12);
  return {
    stand,
    hub: new Vector3(0, 4.5 + 1.05, 12 - 0.55),
    radius: 0.75,
    spokes: 8,
    turn: 0,
  };
}

/** A hand's place against the wheel: off its nearest spoke across it, aft of the wheel's plane, and out from the hub. */
function onSpoke(at: Vector3, wheel: WheelHelm): { across: number; aft: number; out: number } {
  const x = at.x - wheel.hub.x;
  const y = at.y - wheel.hub.y;
  const step = (2 * Math.PI) / wheel.spokes;
  let across = Infinity;
  for (let k = 0; k < wheel.spokes; k++) {
    const a = wheel.turn + k * step;
    const along = x * Math.sin(a) + y * Math.cos(a);
    if (along > 0) {
      across = Math.min(across, Math.abs(x * Math.cos(a) - y * Math.sin(a)));
    }
  }
  return { across, aft: at.z - wheel.hub.z, out: Math.hypot(x, y) };
}

describe.each(LOOKS.flatMap((l) => (['female', 'male'] as const).map((v) => [l, v] as const)))(
  'at a wheel, the %s, %s',
  (look, version) => {
    test('stands at the wheel playing its clip, the hands on the spokes as it turns', async () => {
      const { rig, clips, boat } = await sailor(version, look);
      for (const name of [CLIPS.wheel, `${CLIPS.wheel}-port`, CLIPS.wheelHabit]) {
        expect(clips.has(name), name).toBe(true);
      }
      const wheel = await aWheel();
      boat.wheel = wheel;
      const rt = new SailorRuntime(rig, clips, boat, 7, look === 'machine');
      const stand = new Vector3().setFromMatrixPosition(wheel.stand);
      const deg = Math.PI / 180;
      let t = 0;
      // Hand over hand as the wheel goes hard over one way and the other.
      for (const turn of [0, 0.3, -0.3, 1.2, 2.5, 7.85, 0, -7.85]) {
        const from = wheel.turn;
        for (let f = 0; f < 60; f++, t += 1 / 30) {
          wheel.turn = from + (turn - from) * Math.min(1, f / 30);
          rt.update(moment({ time: t, offset: 0.4, heel: 5 * deg, still: true }));
        }
        expect(rt.hands.wheel, `turn ${turn}`).toBe(2);
        for (const at of rt.hands.wheelAt) {
          const s = onSpoke(at, wheel);
          expect(s.across, `turn ${turn}: across the spoke`).toBeLessThan(0.06);
          expect(s.aft, `turn ${turn}: aft of the wheel`).toBeGreaterThan(0.02);
          expect(s.aft, `turn ${turn}: aft of the wheel`).toBeLessThan(0.14);
          expect(s.out, `turn ${turn}: along the spoke`).toBeGreaterThan(0.2);
          expect(s.out, `turn ${turn}: along the spoke`).toBeLessThan(wheel.radius);
        }
        // Each hand where the runtime says.
        for (const [k, b] of (['hand_l', 'hand_r'] as const).entries()) {
          const hand = rig.position(rig.bone(b), new Vector3()).applyMatrix4(rt.root);
          expect(hand.distanceTo(rt.hands.wheelAt[k] as Vector3)).toBeLessThan(1e-4);
        }
      }
      // Standing on the deck behind the wheel, facing forward: never at a
      // tiller or a sheet, never hiking, crossing or in the water.
      expect(rt.hands.tiller).toBe(false);
      expect(rt.hands.sheet).toBe(false);
      for (const mode of [SAILING, IN_WATER, ON_BOARD, CLIMBING]) {
        t += 1 / 30;
        rt.update(moment({ time: t, mode, offset: -0.5 }));
        expect(rt.crossing).toBe(false);
        const hips = rig.position(rig.bone('pelvis'), new Vector3()).applyMatrix4(rt.root);
        expect(Math.abs(hips.x - stand.x)).toBeLessThan(0.1);
        expect(hips.y - stand.y).toBeGreaterThan(0.8);
        expect(hips.y - stand.y).toBeLessThan(1.15);
        expect(hips.z).toBeLessThan(stand.z + 0.05);
        expect(hips.z).toBeGreaterThan(wheel.hub.z + 0.2);
        for (const foot of ['foot_l', 'foot_r']) {
          const p = rig.position(rig.bone(foot), new Vector3()).applyMatrix4(rt.root);
          expect(p.y - stand.y, foot).toBeGreaterThan(0.06);
          expect(p.y - stand.y, foot).toBeLessThan(0.2);
        }
        const head = rig.position(rig.bone('head'), new Vector3()).applyMatrix4(rt.root);
        expect(head.y - stand.y).toBeGreaterThan(1.3);
      }
    });

    test('looks to windward, and now and then its habit takes a hand off the wheel', async () => {
      const { rig, clips, boat } = await sailor(version, look);
      const wheel = await aWheel();
      boat.wheel = wheel;
      const rt = new SailorRuntime(rig, clips, boat, 8, look === 'machine');
      let t = 0;
      let off = false;
      const run = (frames: number, windAngle: number): void => {
        for (let f = 0; f < frames; f++, t += 1 / 15) {
          rt.update(moment({ dt: 1 / 15, time: t, windAngle }));
          if (rt.hands.wheel < 2) {
            off = true;
          }
        }
      };
      run(60, 0.9);
      expect(rt.windward).toBe(1);
      // The wind over the port side, for a minute.
      run(900, -0.9);
      expect(rt.windward).toBe(-1);
      // The machine and the Old Salt keep both hands on the wheel in theirs.
      expect(off).toBe(!(look === 'machine' || look === 'oldsalt'));
    });
  },
);

/** The boat whose model has a trapeze: a node whose data says it is one. */
const trapezeBoat = catalog.boats.find((b) => {
  const glb = readFileSync(new URL(b.art.model, ART));
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    nodes?: { name?: string; extras?: unknown }[];
  };
  return (gltf.nodes ?? []).some((n) => n.name === 'trapeze' && trapezeData(n.extras) !== null);
});

/** Every look's version whose clips on the wire and harness are built. */
const WIRED = LOOKS.flatMap((l) =>
  (['female', 'male'] as const).map((v) => [l, v] as const),
).filter(
  ([l, v]) =>
    existsSync(new URL(`sailors/${l}/${v}.trapeze.glb`, ART)) &&
    existsSync(new URL(`sailors/${l}/${v}.harness.glb`, ART)),
);

/** A look's harness's hook's eye, in the figure's space at rest. */
async function hookOf(look: string, version: string): Promise<Vector3> {
  const h = await load(`sailors/${look}/${version}.harness.glb`);
  const at = placesOf(h.scene).get('place-hook');
  if (at === undefined) {
    throw new Error('no hook');
  }
  return new Vector3().setFromMatrixPosition(at);
}

describe.runIf(trapezeBoat !== undefined && WIRED.length > 0).each(WIRED)(
  'on the trapeze, the %s, %s',
  (look, version) => {
    const model = trapezeBoat?.art.model as string;
    const reach = trapezeBoat?.physics.sailor.hikeReach as number;
    const hips = (rt: SailorRuntime, rig: Rig): Vector3 =>
      rig.position(rig.bone('pelvis'), new Vector3()).applyMatrix4(rt.root);

    test.each([1, -1])(
      'goes out on the wire beyond the rail to side %i, its places and hips blended without a jump',
      async (side) => {
        const { rig, clips, boat } = await sailor(version, look, model, true);
        expect(boat.trapeze).not.toBeNull();
        const rt = new SailorRuntime(rig, clips, boat, 9, look === 'machine');
        let t = 0;
        let last: Vector3 | null = null;
        let lastHips: Vector3 | null = null;
        let most = 0;
        let mostHips = 0;
        const steps = 400;
        for (let f = 0; f <= steps; f++, t += 1 / 30) {
          // From the side deck the sailor is already on.
          const out = Math.max(0.06, (reach * f) / steps);
          rt.update(moment({ time: t, offset: side * out, still: true }));
          const at = rt.place.at.clone();
          const h = hips(rt, rig);
          if (last !== null && lastHips !== null) {
            most = Math.max(most, at.distanceTo(last));
            mostHips = Math.max(mostHips, h.distanceTo(lastHips));
          }
          last = at;
          lastHips = h;
        }
        // A step of the offset is under 5 mm: no place moves more than 2 cm for it.
        expect(most).toBeLessThan(0.02);
        expect(mostHips).toBeLessThan(0.02);
        // Out fully: on the wire, the hips well beyond the rack's edge.
        expect(rt.hands.wire).toBeCloseTo(1, 5);
        expect(side * (lastHips as Vector3).x).toBeGreaterThan(boat.trapeze?.rackEdge.x ?? 0);
        // At the rail, still sat on it.
        rt.update(moment({ time: t, offset: side * (boat.hike?.full ?? 0), still: true }));
        expect(rt.hands.wire).toBe(0);
      },
    );

    test('the aft hand on the extension as the rudder swings it, part out and out fully', async () => {
      // Steering from the wire: the hinge swung toward the sailor, or a
      // little away; further away, it swings beyond the reach of a tall
      // sailor out fully, who holds the extension's end at arm's length.
      const { rig, clips, boat } = await sailor(version, look, model, true);
      const rt = new SailorRuntime(rig, clips, boat, 10, look === 'machine');
      const rudder = foils(model).rudderPosition;
      const arm = boat.hingeRest.z - rudder;
      let t = 0;
      for (const out of [(reach + (boat.hike?.full ?? 0)) / 2, reach]) {
        for (const swing of [0, 0.04, -0.3]) {
          boat.hinge.set(arm * Math.sin(swing), boat.hingeRest.y, rudder + arm * Math.cos(swing));
          for (let f = 0; f < 10; f++, t += 1 / 30) {
            rt.update(moment({ time: t, offset: out }));
          }
          expect(rt.hands.tiller).toBe(true);
          expect(rt.hands.tillerAt.distanceTo(boat.hinge)).toBeLessThanOrEqual(
            boat.extension + 1e-3,
          );
          const hand = rig.position(rig.bone('hand_l'), new Vector3()).applyMatrix4(rt.root);
          expect(hand.distanceTo(rt.hands.tillerAt), `out ${out}, swing ${swing}`).toBeLessThan(
            1e-4,
          );
          expect(rt.hands.sheet).toBe(true);
        }
      }
    });

    test('hangs from the harness’s hook, beside the hips, nothing of the hips through the hull', async () => {
      const { rig, clips, boat } = await sailor(version, look, model, true);
      const rt = new SailorRuntime(rig, clips, boat, 11, look === 'machine');
      rt.hook(await hookOf(look, version));
      let t = 0;
      rt.update(moment({ time: t, offset: 0.4 }));
      expect(rt.hands.hooked).toBe(false);
      const bad: string[] = [];
      for (const out of [1.1, 1.36, 1.6, reach, -reach]) {
        // Long enough to cross the boat, when the side changes.
        for (let f = 0; f < 150; f++, t += 1 / 30) {
          rt.update(moment({ time: t, offset: out, heel: -Math.sign(out) * 0.15 }));
        }
        expect(rt.hands.hooked).toBe(true);
        const h = hips(rt, rig);
        expect(rt.hands.hook.distanceTo(h), `out ${out}`).toBeLessThan(0.3);
        // Its hips' and thighs' capsules clear of the hull's solid.
        for (const [from, to, r] of CAPSULES.filter(([a]) => /^(pelvis|thigh)/.test(a))) {
          rig.position(rig.bone(from), a).applyMatrix4(rt.root);
          rig.position(rig.bone(to), b).applyMatrix4(rt.root);
          for (let k = 0; k <= 4; k++) {
            c.lerpVectors(a, b, k / 4);
            if (ballInside(boat.solid, c.x, c.y, c.z, r)) {
              bad.push(`out ${out}: ${from}→${to} at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}`);
              break;
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  },
);

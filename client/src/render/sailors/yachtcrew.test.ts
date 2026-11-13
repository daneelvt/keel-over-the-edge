// SPDX-License-Identifier: AGPL-3.0-only

// Every kind whose art names a cruising yacht's people's clips (the
// yacht's), her people posed from the committed files as the game poses
// them: the helm by the sailor's runtime on her own clips, the crew by the
// crew's rules and bodies. Nothing through anything of her (her hull,
// decks, coachroof, sprayhood, benches, table, wheels and binnacles,
// capstans, stanchions, pulpit and pushpit, mast, shrouds and stays, her
// lifelines as a solid, the boom and its vang at every angle to the
// sheet's widest, the mainsheet from its bridle) and nobody through
// anybody: eight aboard on both tacks, sat up and leaning out; through a
// tack and a gybe in their order; at a handover; and the helm sat by her
// wheel, standing at it, and walking between her wheels.

import { readFileSync } from 'node:fs';
import { type AnimationClip, Matrix3, Matrix4, Mesh, type Object3D, Texture, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { afterAll, describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { SAILING } from '../sailor';
import { Clip } from './clips';
import { modelDeck, STEPPED, tillerOf } from './crew';
import { CrewBody, stance } from './crewbody';
import { type PoseInput, poseMember } from './crewpose';
import {
  type CrewMember,
  CrewRules,
  crewPlan,
  duckFor,
  duckStep,
  FLAT_HEEL,
  LEAN_HEEL_OUT,
  moveAt,
  type SailorNow,
  waysOf,
} from './crewrules';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { Rig } from './rig';
import { type SailorBoat, type SailorMoment, SailorRuntime, SIT_WIND, STAND_WIND } from './runtime';
import { hullSolid } from './solid';
import { wheelOf } from './wheel';
import { namesYachtClips, yachtBoat, yachtClips, yachtOf } from './yacht';

const ART = new URL('../../../../art/', import.meta.url);
(globalThis as { self?: unknown }).self ??= globalThis;

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
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

const DEG = Math.PI / 180;
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
/** The head, a ball this far over its joint up the neck, of this radius. */
const HEAD_UP = 0.1;
const HEAD_R = 0.11;
/** How far the feet's bones may go into what they stand on, m: blended between two stances, the toes dip as much (a beach cat's crew's into her net). */
const FEET_IN = 0.05;
/** The boom's and the vang's radii, and the mainsheet's, m. */
const BOOM_R = 0.08;
const VANG_R = 0.03;
const SHEET_R = 0.01;

/** The nearest two segments come, a–b and c–d. */
function segments(a: Vector3, b: Vector3, c: Vector3, d: Vector3): number {
  const u = new Vector3().subVectors(b, a);
  const v = new Vector3().subVectors(d, c);
  const w = new Vector3().subVectors(a, c);
  const aa = u.dot(u);
  const bb = u.dot(v);
  const cc = v.dot(v);
  const dd = u.dot(w);
  const ee = v.dot(w);
  const den = aa * cc - bb * bb;
  let s = den > 1e-12 ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / den)) : 0;
  let t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  s = aa > 1e-12 ? Math.max(0, Math.min(1, (bb * t - dd) / aa)) : 0;
  t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  return new Vector3()
    .copy(a)
    .addScaledVector(u, s)
    .sub(new Vector3().copy(c).addScaledVector(v, t))
    .length();
}

/** A posed person as capsules in the boat's model: each bone's line and radius, and the head's ball. */
type Caps = [Vector3, Vector3, number, string][];

function capsOf(rig: Rig, root: Matrix4): Caps {
  const pos = (bone: string): Vector3 =>
    rig.position(rig.bone(bone), new Vector3()).applyMatrix4(root);
  const out: Caps = CAPSULES.map(([f, t, r]) => [pos(f), pos(t), r, f]);
  const neck = pos('neck_01');
  const head = pos('head');
  const centre = head.clone().addScaledVector(head.clone().sub(neck).normalize(), HEAD_UP);
  out.push([head, centre, HEAD_R, 'head']);
  return out;
}

/** The parts the last apart() found nearest. */
let apartParts = '';

/** How near two people come, beyond their radii: negative, through each other. */
function apart(a: Caps, b: Caps): number {
  let least = Number.POSITIVE_INFINITY;
  for (const [p, q, r, n] of a) {
    for (const [s, t, u, o] of b) {
      const d = segments(p, q, s, t) - r - u;
      if (d < least) {
        least = d;
        apartParts = `${n} at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} and ${o} at ${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}`;
      }
    }
  }
  return least;
}

/**
 * How near any two aboard come, beyond their capsules (which are generous:
 * two sat shoulder to shoulder overlap them), m: walking, and sat.
 */
const PEOPLE_APART = -0.03;
/**
 * How near two come while either moves about, m: getting up beside
 * someone sat, sitting down beside them, passing their knees (the
 * crouch's head well ahead of its hips, turning); and two changing places
 * between the helm and the bench by the one way there is, who meet at the
 * bench as one sits down and the other gets up (measured: their heads'
 * balls 0.2 m into each other's for a tenth of a second).
 */
const PASSING = -0.22;
/**
 * The longest anyone getting up off her rail, sitting down on it, or
 * climbing onto her coachroof or out of her cockpit, may have a bone's
 * line through her (her lifelines, her coachroof's side), s: a blend of
 * two poses and the feet carried, not a clip made there.
 */
const BRUSH_MOST = 0.4;
/** How near a step along a way, m, someone walking it counts as climbing it: their knees ahead of their hips. */
const CLIMB_NEAR = 0.4;

/** Where a segment from a to b meets a triangle, as a fraction along it; null if it does not (Möller and Trumbore). */
function crosses(a: Vector3, b: Vector3, t: Float32Array, i: number): boolean {
  const e1x = (t[i + 3] as number) - (t[i] as number);
  const e1y = (t[i + 4] as number) - (t[i + 1] as number);
  const e1z = (t[i + 5] as number) - (t[i + 2] as number);
  const e2x = (t[i + 6] as number) - (t[i] as number);
  const e2y = (t[i + 7] as number) - (t[i + 1] as number);
  const e2z = (t[i + 8] as number) - (t[i + 2] as number);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) {
    return false;
  }
  const inv = 1 / det;
  const sx = a.x - (t[i] as number);
  const sy = a.y - (t[i + 1] as number);
  const sz = a.z - (t[i + 2] as number);
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) {
    return false;
  }
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) {
    return false;
  }
  const f = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return f >= 0 && f <= 1;
}

const kinds = catalog.boats.filter((b) => namesYachtClips(b.art));

/** The looks posed: the Rover's woman and man, and the male machine, the tallest. */
const LOOKS = [
  ['rover', 'female'],
  ['rover', 'male'],
  ['machine', 'male'],
].map(([id, version]) => ({
  art:
    id === 'machine'
      ? catalog.machine.versions.find((v) => v.id === version)?.art
      : catalog.sailors.find((s) => s.id === id)?.versions.find((v) => v.id === version)?.art,
  machine: id === 'machine',
  name: `${id} ${version}`,
}));

test('a kind names the cruising yacht’s clips', () => {
  expect(kinds.length).toBeGreaterThan(0);
});

describe.each(kinds.map((k) => [k.name, k] as const))('aboard the %s', (_, kind) => {
  const boat = load(kind.art.model);
  const looks = Promise.all(
    LOOKS.map(async ({ art, machine, name }) => {
      if (art === undefined) {
        throw new Error('no look');
      }
      const [deck, clipsFile, yachtFile] = await Promise.all([
        load(art.model),
        load(art.clips),
        load(yachtClips(art.clips)),
      ]);
      const rig = Rig.from(deck.scene, boneNames(deck.scene));
      const look = new FleetLook(0, art, machine);
      deck.scene.updateMatrixWorld(true);
      look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
      const clips = new Map<string, Clip>();
      for (const file of [clipsFile, yachtFile]) {
        const places = placesOf(file.scene);
        for (const a of file.animations) {
          const place = places.get(`place-${a.name}`) ?? null;
          clips.set(
            a.name,
            Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
          );
        }
      }
      look.clips = clips;
      return { look, rig, clips, machine, name };
    }),
  );
  type Look = Awaited<typeof looks>[number];

  /** Her model's parts by name, her crew's plan and her sailor's boat, as the game makes them. */
  const setUp = (async () => {
    const g = await boat;
    g.scene.updateMatrixWorld(true);
    const parts = new Map<string, Object3D>();
    g.scene.traverse((o) => {
      if (o.name !== '' && !parts.has(o.name)) {
        parts.set(o.name, o);
      }
    });
    const at = (n: string): Vector3 => (parts.get(n) as Object3D).getWorldPosition(new Vector3());
    const solid = hullSolid(parts.get('hull')?.userData, at('board-root'), {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    if (solid === null) {
      throw new Error('no solid');
    }
    const plan = crewPlan(
      kind.stations,
      solid,
      at('boom'),
      kind.physics.rig.foot,
      modelDeck(g.scene, STEPPED),
      tillerOf(g.scene),
    );
    plan.yacht = yachtBoat(parts);
    plan.cog = kind.physics.hull.centreOfGravity;
    if (plan.yacht === null) {
      throw new Error('no deck for her people');
    }
    const wheel = wheelOf(parts, g.scene);
    const seat = at('sailor');
    if (wheel === null) {
      throw new Error('no wheel');
    }
    const sailorBoat: SailorBoat = {
      hinge: seat.clone(),
      hingeRest: seat,
      extension: 0,
      seatY: seat.y,
      seatIn: 0,
      seatOut: 0,
      seatZ: seat.z,
      cog: kind.physics.hull.centreOfGravity,
      solid,
      climbTime: kind.physics.sailor.climbTime,
      wheel,
      yacht: yachtOf(parts),
    };
    return { g, plan, yacht: plan.yacht, sailorBoat, parts, at, wheel };
  })();

  /**
   * What of her a posed person's bones pass through, the boom at boom
   * (radians): every bone's line (and the head's, to the middle of its
   * ball) against her model's triangles, but her sails and flags; the
   * boom, its vang and the mainsheet by their lines. The feet's lines
   * lifted 2 cm (they stand on what they stand on); the hands and
   * forearms may hold her wheel's rim (at the wheel) or lie over her upper
   * lifeline (on the rail).
   */
  const obstacles = (async () => {
    const { g, plan, at } = await setUp;
    const CELL = 0.15;
    const tris: number[] = [];
    const kindsOf: string[] = [];
    const cells = new Map<string, number[]>();
    const moving = ['boom', 'vang', 'sheet-boom'];
    g.scene.traverse((o) => {
      if (!(o instanceof Mesh)) {
        return;
      }
      const mat = (o.material as { name?: string }).name ?? '';
      const node = o.parent?.name ?? '';
      if (['sail', 'jib', 'telltales', 'pennant'].includes(o.name) || mat === 'bunting') {
        return;
      }
      if (moving.includes(node) || moving.includes(o.name)) {
        return;
      }
      // Her wheels; her lifelines, stanchions and pulpits; her shrouds and
      // their deadeyes and chainplates; and the rest by part and material.
      const what = node.startsWith('wheel')
        ? 'wheel'
        : node === 'hull' && mat === 'rope'
          ? 'lifeline'
          : node === 'hull' && mat === 'iron'
            ? 'stanchion'
            : node === 'mast' && ['rope', 'varnish', 'iron'].includes(mat)
              ? 'shroud'
              : `${node}:${mat}`;
      const geo = o.geometry;
      const pos = geo.getAttribute('position');
      const index = geo.index;
      const count = index === null ? pos.count : index.count;
      const p = new Vector3();
      for (let k = 0; k < count; k += 3) {
        const base = tris.length / 9;
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let j = 0; j < 3; j++) {
          p.fromBufferAttribute(pos, index === null ? k + j : index.getX(k + j)).applyMatrix4(
            o.matrixWorld,
          );
          tris.push(p.x, p.y, p.z);
          for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a] as number, p.getComponent(a));
            hi[a] = Math.max(hi[a] as number, p.getComponent(a));
          }
        }
        kindsOf.push(what);
        for (
          let x = Math.floor((lo[0] as number) / CELL);
          x <= Math.floor((hi[0] as number) / CELL);
          x++
        ) {
          for (
            let y = Math.floor((lo[1] as number) / CELL);
            y <= Math.floor((hi[1] as number) / CELL);
            y++
          ) {
            for (
              let z = Math.floor((lo[2] as number) / CELL);
              z <= Math.floor((hi[2] as number) / CELL);
              z++
            ) {
              const key = `${x},${y},${z}`;
              const list = cells.get(key);
              if (list === undefined) {
                cells.set(key, [base]);
              } else {
                list.push(base);
              }
            }
          }
        }
      }
    });
    const all = new Float32Array(tris);
    /** What of her the segment a–b crosses, but what is excused: null for nothing. */
    const segmentCrosses = (a: Vector3, b: Vector3, excused: string[]): string | null => {
      const seen = new Set<number>();
      const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
      const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const y0 = Math.floor(Math.min(a.y, b.y) / CELL);
      const y1 = Math.floor(Math.max(a.y, b.y) / CELL);
      const z0 = Math.floor(Math.min(a.z, b.z) / CELL);
      const z1 = Math.floor(Math.max(a.z, b.z) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            for (const i of cells.get(`${x},${y},${z}`) ?? []) {
              if (seen.has(i)) {
                continue;
              }
              seen.add(i);
              const what = kindsOf[i] as string;
              if (!excused.includes(what) && crosses(a, b, all, 9 * i)) {
                return what;
              }
            }
          }
        }
      }
      return null;
    };
    const gooseneck = at('boom');
    const vangFoot = new Vector3(0, 1.83, gooseneck.z + 0.1);
    const bridle = at('bridle');
    /** The boom's line at an angle, and a point along it (m from the gooseneck). */
    const along = (boom: number, d: number, y = gooseneck.y): Vector3 =>
      new Vector3(d * Math.sin(boom), y, gooseneck.z + d * Math.cos(boom));
    const through = (
      caps: Caps,
      boom: number,
      how: { wheel?: boolean; lifeline?: boolean } = {},
    ): string[] => {
      const bad: string[] = [];
      const boomEnd = along(boom, plan.boom.length);
      const vangTop = along(boom, Math.max(0.3, bridle.z - gooseneck.z - 0.4), gooseneck.y - 0.08);
      const sheetTop = along(boom, bridle.z - gooseneck.z, gooseneck.y - 0.08);
      for (const [a, b, r, name] of caps) {
        const feet = name.startsWith('foot') || name.startsWith('calf');
        const arm = name.startsWith('lowerarm') || name.startsWith('upperarm');
        const excused = [
          ...(how.wheel && name.startsWith('lowerarm') ? ['wheel'] : []),
          // On her rail or along her side deck, a hand on her lifelines, a
          // stanchion or a shroud.
          ...(how.lifeline && arm ? ['lifeline', 'stanchion', 'shroud'] : []),
        ];
        // The soles' joints a few centimetres over what they stand on.
        const lift = name.startsWith('foot') ? FEET_IN : feet ? 0.02 : 0;
        const what = segmentCrosses(
          a.clone().setY(a.y + lift),
          b.clone().setY(b.y + lift),
          excused,
        );
        if (what !== null) {
          bad.push(
            `${name} through ${what} at ${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)} to ${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)}`,
          );
        }
        const d = segments(a, b, gooseneck, boomEnd) - r - BOOM_R;
        if (d < 0) {
          bad.push(`${name} through the boom at ${(boom / DEG).toFixed(0)}° (${d.toFixed(3)})`);
        }
        if (segments(a, b, vangFoot, vangTop) < r + VANG_R) {
          bad.push(`${name} through the vang at ${(boom / DEG).toFixed(0)}°`);
        }
        if (segments(a, b, bridle, sheetTop) < r + SHEET_R) {
          bad.push(`${name} through the mainsheet at ${(boom / DEG).toFixed(0)}°`);
        }
      }
      return bad;
    };
    return { through, segmentCrosses };
  })();

  /** A helm, posed by the sailor's runtime, for a look. */
  async function helmOf(l: Look, seed: number) {
    const { sailorBoat } = await setUp;
    const rig = new Rig(l.rig.names, l.rig.parent, l.rig.restPos, l.rig.restQuat);
    rig.base.copy(l.rig.base);
    const rt = new SailorRuntime(rig, l.clips, sailorBoat, seed, l.machine, false);
    const mo: SailorMoment = {
      dt: 1 / 30,
      time: 0,
      offset: 0,
      mode: SAILING,
      timer: 0,
      heel: 0,
      pitch: 0,
      heave: 0,
      windSpeed: 8,
      windAngle: 0.8,
      rollRate: 0,
      still: false,
      boom: 0,
      trim: 0,
    };
    return { rig, rt, mo, caps: () => capsOf(rig, rt.root) };
  }

  /** A crew's body and what posing them needs, for a look. */
  async function crewOf(l: Look, seed: number) {
    const { plan } = await setUp;
    const body = new CrewBody(l.look.deck as NonNullable<typeof l.look.deck>, seed, l.machine);
    const inp: PoseInput = {
      stations: kind.stations,
      seat: { out: 0.7, y: 0.3, z: 0.4 },
      clips: l.clips,
      time: 0,
      duck: 0,
      life: { dt: 1 / 30, heel: 0, upright: 0.5, still: false },
      a: stance(),
      b: stance(),
      level: { heel: 0, pitch: 0, heave: 0, cog: plan.cog ?? 0, solid: plan.solid ?? null },
      cruiser: plan.yacht ?? null,
      world: 0,
      machine: l.machine,
      ways: waysOf(plan),
    };
    return { body, inp, caps: () => capsOf(body.rig, body.root) };
  }

  test('the checks see her coachroof, table, bench, a wheel, a binnacle, the mast, a stanchion, a lifeline and her topsides, and not her open sole or side deck', async () => {
    const { segmentCrosses } = await obstacles;
    const { yacht } = await setUp;
    const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
    const sees = (a: Vector3, b: Vector3): string | null => segmentCrosses(a, b, []);
    // Down through the coachroof's top, the table's, the bench's.
    expect(sees(v(0.3, 1.9, -1), v(0.3, 1.3, -1))).not.toBeNull();
    expect(sees(v(0, 1.3, 1.5), v(0, 0.9, 1.5))).not.toBeNull();
    expect(sees(v(1.3, 0.95, 1.5), v(1.3, 0.55, 1.5))).not.toBeNull();
    // Across a wheel's rim, a binnacle, the mast, a stanchion, the lifelines.
    expect(sees(v(0.58, 1.38, 3.6), v(0.58, 1.38, 3.9))).toBe('wheel');
    expect(sees(v(0.7, 0.7, 3.27), v(1.3, 0.7, 3.27))).not.toBeNull();
    expect(sees(v(-0.3, 3, -1.37), v(0.3, 3, -1.37))).not.toBeNull();
    const stanchion = yacht.lifelines?.stanchions[2] ?? 0;
    expect(sees(v(1.7, 1.5, stanchion), v(2.1, 1.5, stanchion))).not.toBeNull();
    // Down through both lifelines, by the deck's edge between two stanchions.
    const { plan } = await setUp;
    const x = plan.edge(-2) - (yacht.lifelines?.inboard ?? 0);
    expect(sees(v(x, plan.sheer(-2) + 0.8, -2), v(x, plan.sheer(-2) + 0.45, -2))).toBe('lifeline');
    expect(sees(v(x, plan.sheer(-2) + 0.45, -2), v(x, plan.sheer(-2) + 0.15, -2))).toBe('lifeline');
    // Out through her topsides.
    expect(sees(v(1.5, 0.6, 0), v(2.3, 0.6, 0))).not.toBeNull();
    // Over her open sole and along her side deck, nothing.
    expect(sees(v(0.6, 0.5, 0.45), v(-0.6, 0.5, 0.45))).toBeNull();
    expect(sees(v(1.7, 1.4, -2.3), v(1.7, 1.4, -0.5))).toBeNull();
  });

  test('her stations: the helm’s between the wheels; three on her bench, the trimmer aft; four on her rail; all but the helm to windward', () => {
    const [helm, ...crew] = kind.stations;
    expect(helm?.pose).toBe('standing');
    expect(crew.filter((s) => s.pose === 'bench')).toHaveLength(3);
    expect(crew.filter((s) => s.pose === 'rail')).toHaveLength(4);
    expect(crew.every((s) => s.windward === true)).toBe(true);
    // The cockpit fills before the rail; on the bench the trimmer first, aftmost.
    expect(kind.stations[1]?.pose).toBe('bench');
    const bench = crew.filter((s) => s.pose === 'bench').map((s) => s.at[2] as number);
    expect(kind.stations[1]?.at[2]).toBe(Math.max(...bench));
  });

  test('her ways read from her model: the cockpit crossed forward of the table and aft of it, the coachroof forward of the mast, the stance between the wheels', async () => {
    const { plan, yacht } = await setUp;
    const ways = waysOf(plan);
    if (ways === null) {
      throw new Error('no ways');
    }
    expect(ways.foreZ).toBeGreaterThan(yacht.coachroof.aft);
    expect(ways.foreZ).toBeLessThan(yacht.table.fore);
    expect(ways.aftZ).toBeGreaterThan(yacht.table.aft);
    expect(ways.aftZ).toBeLessThan(ways.sternZ);
    expect(ways.roofZ).toBeGreaterThan(yacht.coachroof.fore);
    expect(ways.roofZ).toBeLessThan(plan.mastZ);
    expect(ways.sole).toBeGreaterThan(yacht.table.halfWidth);
    expect(ways.sole).toBeLessThan(yacht.bench.inner);
  });

  test('eight aboard on both tacks, sat up and leaning out, the bench’s idles and braced, the boom anywhere to leeward: nothing through anything, nobody through anybody', async () => {
    const { through } = await obstacles;
    const ls = await looks;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    let leastAt = '';
    for (const [k0, side] of [
      [0, 1],
      [1, -1],
      [2, 1],
    ] as const) {
      const helm = await helmOf(ls[k0] as Look, 3);
      const crews = await Promise.all(
        kind.stations.slice(1).map((_, i) => crewOf(ls[(k0 + i + 1) % ls.length] as Look, 5 + i)),
      );
      for (const [lean, wind] of [
        [0, 3],
        [1, 9],
      ] as const) {
        for (const t of [0, 13, 27, 41]) {
          helm.rt.reset();
          helm.mo.windAngle = side * 0.8;
          helm.mo.windSpeed = wind;
          for (let k = 0; k < 90; k++) {
            helm.mo.time = t + k / 30;
            helm.rt.update(helm.mo);
          }
          const people: {
            who: string;
            caps: Caps;
            how: { wheel?: boolean; lifeline?: boolean };
          }[] = [
            {
              who: `helm (${helm.rt.seat >= 1 ? 'sat' : 'standing'})`,
              caps: helm.caps(),
              how: { wheel: true },
            },
          ];
          crews.forEach((c, i) => {
            const station = i + 1;
            const m: CrewMember = {
              seat: station,
              look: 0,
              station,
              side,
              lean,
              leanTo: lean,
              moving: null,
              company: true,
            };
            c.inp.time = t;
            c.inp.world = t;
            poseMember(c.body, m, c.inp);
            people.push({
              who: `${kind.stations[station]?.pose} ${station}`,
              caps: c.caps(),
              how: { lifeline: kind.stations[station]?.pose === 'rail' },
            });
          });
          for (let a = 0; a <= kind.physics.rig.boomOut * DEG + 1e-6; a += 15 * DEG) {
            for (const p of people) {
              for (const b of through(p.caps, -side * a, p.how)) {
                bad.push(`${side} lean ${lean} t ${t} ${p.who}: ${b}`);
              }
            }
          }
          for (let i = 0; i < people.length; i++) {
            for (let j = i + 1; j < people.length; j++) {
              const d = apart(
                (people[i] as (typeof people)[0]).caps,
                (people[j] as (typeof people)[0]).caps,
              );
              if (d < least) {
                least = d;
                leastAt = `${side} lean ${lean} t ${t}: ${people[i]?.who} and ${people[j]?.who}, ${apartParts}`;
              }
            }
          }
        }
      }
    }
    measured.push(`eight sat: ${least.toFixed(3)} (${leastAt})`);
    expect([...new Set(bad)].slice(0, 30)).toEqual([]);
    expect(least, leastAt).toBeGreaterThan(PEOPLE_APART);
  }, 60_000);

  /** What a moment of her is: her boom and the wind off her bow (radians), the apparent wind (radians, m/s) and her heel. */
  interface Moment {
    boom: number;
    windOffBow: number;
    windAngle: number;
    wind: number;
    heel: number;
  }

  /**
   * Sails eight aboard under the rules and the helm's runtime for seconds,
   * as script gives her at each moment, the controls changing hands at the
   * times handovers gives; posing everyone ten times a second: what anyone
   * passes through, how near any two come, and when each set off.
   */
  async function sail(
    seconds: number,
    script: (t: number) => Moment,
    handovers: [number, number][] = [],
  ) {
    const { plan } = await setUp;
    const { through } = await obstacles;
    const ls = await looks;
    const people = kind.stations.map((_, seat) => ({ seat, look: seat % ls.length }));
    const rules = new CrewRules(plan);
    let holder = 0;
    rules.set({ people, holder }, false);
    const helms = await Promise.all(people.map((p) => helmOf(ls[p.look] as Look, 2 + p.seat)));
    const crews = await Promise.all(people.map((p) => crewOf(ls[p.look] as Look, 3 + p.seat)));
    const ducks = people.map(() => 0);
    const dt = 1 / 30;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    let leastAt = '';
    /** Each crossing or walk as it set off and came to its place: who, from which station's place, which way, s. */
    const moves: {
      seat: number;
      from: number;
      to: number;
      kind: string;
      set: number;
      done: number;
    }[] = [];
    const going = new Map<number, (typeof moves)[number]>();
    const sn: SailorNow = { mode: SAILING, heel: 0, trim: 0, offset: 0, net: null };
    let lastBoom = script(0).boom;
    let helmWalked = false;
    let leastMoving = Number.POSITIVE_INFINITY;
    let leastMovingAt = '';
    const brief = new Map<string, number>();
    const briefAt = new Map<string, string>();
    for (let k = 0; k * dt <= seconds; k++) {
      const t = k * dt;
      for (const [at, to] of handovers) {
        if (Math.abs(t - at) < dt / 2) {
          holder = to;
          rules.set({ people, holder });
        }
      }
      const now = script(t);
      const helm = helms[holder] as Awaited<ReturnType<typeof helmOf>>;
      helm.mo.windAngle = now.windAngle;
      helm.mo.windSpeed = now.wind;
      helm.mo.heel = now.heel;
      helm.mo.boom = now.boom;
      helm.mo.time = t;
      helm.rt.update(helm.mo);
      helmWalked ||= helm.rt.walking;
      sn.heel = now.heel;
      rules.step({ dt, boom: now.boom, windOffBow: now.windOffBow, depth: 0, sailor: sn });
      for (const m of rules.members) {
        const mv = m.moving;
        const g = going.get(m.seat);
        if (mv !== null && mv.t >= 0 && g === undefined) {
          const move = {
            seat: m.seat,
            from: mv.from.station,
            to: mv.to.station,
            kind: mv.kind,
            set: t,
            done: Number.POSITIVE_INFINITY,
          };
          moves.push(move);
          going.set(m.seat, move);
        } else if (mv === null && g !== undefined) {
          g.done = t;
          going.delete(m.seat);
        }
      }
      if (k % 3 !== 0) {
        continue;
      }
      const drawn: {
        who: string;
        caps: Caps;
        how: { wheel?: boolean; lifeline?: boolean };
        /** Getting up, sitting down or climbing (onto her coachroof, out of her cockpit), not sat or walking. */
        moving: string | null;
        key: string;
      }[] = [];
      if (!rules.helmAway) {
        drawn.push({
          who: `helm ${holder}${helm.rt.walking ? ' walking' : ''}`,
          caps: helm.caps(),
          how: { wheel: true },
          moving: null,
          key: 'helm',
        });
      }
      const rate = (now.boom - lastBoom) / (3 * dt);
      lastBoom = now.boom;
      for (const m of rules.members) {
        if (m.station <= 0 && m.moving === null) {
          continue;
        }
        const c = crews[m.seat] as Awaited<ReturnType<typeof crewOf>>;
        c.inp.time = t;
        c.inp.world = t;
        c.inp.life.heel = now.heel;
        ducks[m.seat] = duckStep(
          ducks[m.seat] ?? 0,
          duckFor(plan, now.boom, rate, c.body.headUp),
          3 * dt,
        );
        c.inp.duck = ducks[m.seat] ?? 0;
        poseMember(c.body, m, c.inp);
        const mv = m.moving;
        const st = (n: number): string | undefined => kind.stations[Math.max(0, n)]?.pose;
        const at = mv === null || mv.t < 0 ? null : moveAt(mv, { rise: 0, along: 0, sit: 0 });
        drawn.push({
          moving:
            at === null
              ? null
              : at.rise < 1
                ? 'getting up'
                : at.sit > 0
                  ? 'sitting down'
                  : [0, CLIMB_NEAR, -CLIMB_NEAR].some((d) => mv?.path.stepAt(at.along + d) != null)
                    ? 'climbing'
                    : mv?.kind === 'change' && st(mv.from.station) === 'rail'
                      ? 'changing places from the rail'
                      : mv?.kind === 'change' && st(mv.to.station) === 'rail'
                        ? 'changing places to the rail'
                        : null,
          key: `${m.seat} ${mv?.kind ?? ''} ${mv?.from.station ?? ''}`,
          who: `seat ${m.seat} ${mv === null ? `at ${m.station}` : `${mv.kind} ${mv.from.station}→${mv.to.station} ${mv.t.toFixed(1)}`}`,
          caps: c.caps(),
          how: {
            wheel: mv !== null && (mv.from.station < 0 || mv.to.station < 0),
            lifeline:
              (mv === null || mv.t < 0) && st(m.station) === 'rail'
                ? true
                : mv !== null && (st(mv.from.station) === 'rail' || st(mv.to.station) === 'rail'),
          },
        });
      }
      for (const p of drawn) {
        const through1 = through(p.caps, now.boom, p.how);
        const brushes =
          p.moving !== null &&
          (!p.moving.startsWith('changing') || through1.every((b) => b.includes('through shroud')));
        if (through1.length > 0 && brushes && p.moving !== null) {
          // Getting up, sitting down or climbing: counted, a tenth of a second a frame.
          const key = `${p.key} ${p.moving}`;
          brief.set(key, (brief.get(key) ?? 0) + 0.1);
          briefAt.set(key, `${t.toFixed(1)} ${p.who}: ${through1[0]}`);
          continue;
        }
        for (const b of through1) {
          bad.push(`${t.toFixed(1)} ${p.who}: ${b}`);
        }
      }
      for (let i = 0; i < drawn.length; i++) {
        for (let j = i + 1; j < drawn.length; j++) {
          const a = drawn[i] as (typeof drawn)[0];
          const b = drawn[j] as (typeof drawn)[0];
          const d = apart(a.caps, b.caps);
          const sat =
            !a.who.includes(' cross ') &&
            !a.who.includes(' change ') &&
            !b.who.includes(' cross ') &&
            !b.who.includes(' change ') &&
            !a.who.includes('walking') &&
            !b.who.includes('walking');
          if (sat && d < least) {
            least = d;
            leastAt = `${t.toFixed(1)} ${a.who} and ${b.who}: ${apartParts}`;
          }
          if (!sat && d < leastMoving) {
            leastMoving = d;
            leastMovingAt = `${t.toFixed(1)} ${a.who} and ${b.who}: ${apartParts}`;
          }
        }
      }
    }
    // The longest any one getting up, sitting down or climbing brushed her, s.
    let longest = 0;
    let longestAt = '';
    for (const [key, s] of brief) {
      if (s > longest) {
        longest = s;
        longestAt = briefAt.get(key) ?? '';
      }
    }
    return {
      bad: [...new Set(bad)],
      least,
      leastAt,
      leastMoving,
      leastMovingAt,
      longest,
      longestAt,
      brushes: brief.size,
      moves,
      rules,
      helmWalked,
    };
  }

  /** Close-hauled on starboard, the wind over starboard and the boom to port, heeled to port, in a breeze. */
  const beat = (side: number): Moment => ({
    boom: -side * 0.14,
    windOffBow: side * 45 * DEG,
    windAngle: side * 30 * DEG,
    wind: 8,
    heel: -side * 10 * DEG,
  });

  /** A tack from starboard to port: through the wind from 1 s to 5 s, her heel lagging the boom. */
  const tack = (t: number): Moment => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 4));
    const off = 45 * DEG - turn * 90 * DEG;
    const boom = -Math.sign(off) * Math.min(0.14, Math.abs(off) * 0.5);
    const heel = (-10 + 20 * Math.max(0, Math.min(1, (t - 2.5) / 3))) * DEG;
    return { boom, windOffBow: off, windAngle: off * 0.7, wind: 8, heel };
  };

  /** A gybe from port to starboard on a broad reach: the wind over port, the boom to starboard, coming over at 2.6 s. */
  const gybe = (t: number): Moment => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 3));
    const off = -(150 * DEG) - turn * 60 * DEG;
    const wrapped = Math.atan2(Math.sin(off), Math.cos(off));
    const over = Math.max(0, Math.min(1, (t - 2.4) / 0.5));
    const boom = 1.1 - 2.2 * over;
    const heel = (3 - 6 * over) * DEG;
    return { boom, windOffBow: wrapped, windAngle: wrapped * 0.95, wind: 6, heel };
  };

  const pose = (s: string | undefined): string | undefined => s;

  test('through a tack: the trimmer first as she comes through the wind, the rest of the cockpit, then the rail once she has come upright; each in file; nothing through anything, nobody through anybody', async () => {
    const r = await sail(22, tack);
    const crossed = r.moves.filter((m) => m.kind === 'cross');
    expect(crossed).toHaveLength(7);
    const at = (pose: string) =>
      crossed.filter((m) => kind.stations[m.from]?.pose === pose).sort((a, b) => a.set - b.set);
    const bench = at('bench');
    const rail = at('rail');
    // The trimmer (her aftmost on the bench) first.
    const aftmost = Math.max(
      ...kind.stations.filter((s) => s.pose === 'bench').map((s) => s.at[2] as number),
    );
    expect(kind.stations[bench[0]?.from ?? 0]?.at[2]).toBe(aftmost);
    expect(bench[0]?.set ?? 0).toBeLessThan(Math.min(...rail.map((m) => m.set)));
    // The rail once she is upright: her heel toward their old side no more than FLAT_HEEL (a frame since).
    const first = rail[0]?.set ?? 0;
    expect(-tack(first - 1 / 30).heel).toBeLessThanOrEqual(FLAT_HEEL + 1e-6);
    // All across, each in a few seconds (the furthest forward on the rail
    // has 7 m to go, over the coachroof and back).
    for (const m of crossed) {
      expect(m.done - m.set, `seat ${m.seat}`).toBeLessThan(10);
    }
    expect(r.helmWalked).toBe(true);
    measured.push(
      `tack: ${crossed.map((m) => `${pose(kind.stations[m.from]?.pose)} ${m.from}→${m.to} ${m.set.toFixed(1)}–${m.done.toFixed(1)}`).join(', ')}; least sat ${r.least.toFixed(3)} (${r.leastAt}), moving ${r.leastMoving.toFixed(3)} (${r.leastMovingAt}); ${r.brushes} getting up, sitting down or climbing brushed her, the longest ${r.longest.toFixed(1)} s (${r.longestAt})`,
    );
    expect(r.bad.slice(0, 30)).toEqual([]);
    expect(r.least, r.leastAt).toBeGreaterThan(PEOPLE_APART);
    expect(r.leastMoving, r.leastMovingAt).toBeGreaterThan(PASSING);
    expect(r.longest, r.longestAt).toBeLessThanOrEqual(BRUSH_MOST);
  }, 120_000);

  test('through a gybe: the rail first, then the cockpit as the boom comes over; nothing through anything, nobody through anybody', async () => {
    const r = await sail(14, gybe);
    const crossed = r.moves.filter((m) => m.kind === 'cross');
    expect(crossed).toHaveLength(7);
    const sets = (pose: string) =>
      crossed.filter((m) => kind.stations[m.from]?.pose === pose).map((m) => m.set);
    expect(Math.min(...sets('rail'))).toBeLessThan(Math.min(...sets('bench')));
    expect(r.helmWalked).toBe(true);
    measured.push(
      `gybe: ${crossed.map((m) => `${pose(kind.stations[m.from]?.pose)} ${m.from}→${m.to} ${m.set.toFixed(1)}–${m.done.toFixed(1)}`).join(', ')}; least sat ${r.least.toFixed(3)} (${r.leastAt}), moving ${r.leastMoving.toFixed(3)} (${r.leastMovingAt}); ${r.brushes} getting up, sitting down or climbing brushed her, the longest ${r.longest.toFixed(1)} s (${r.longestAt})`,
    );
    expect(r.bad.slice(0, 30)).toEqual([]);
    expect(r.least, r.leastAt).toBeGreaterThan(PEOPLE_APART);
    expect(r.leastMoving, r.leastMovingAt).toBeGreaterThan(PASSING);
    expect(r.longest, r.longestAt).toBeLessThanOrEqual(BRUSH_MOST);
  }, 120_000);

  test('a handover: the new holder walks to the windward wheel by her ways and the old helm to their place, from the rail and from the bench; nothing through anything, nobody through anybody', async () => {
    const railSeat = kind.stations.findIndex((s) => s.pose === 'rail');
    const benchSeat = kind.stations.findIndex((s, i) => s.pose === 'bench' && i > 1);
    // The skipper's to the rail's and back, then to the bench's.
    const r = await sail(80, () => beat(1), [
      [1, railSeat],
      [28, 0],
      [55, benchSeat],
    ]);
    const walks = r.moves.filter((m) => m.kind === 'change');
    // To the helm from the rail and from the bench; and back to their places.
    expect(walks.some((m) => m.from === railSeat && m.to < 0)).toBe(true);
    expect(walks.some((m) => m.to < 0 && m.from === benchSeat)).toBe(true);
    for (const m of walks) {
      expect(m.done, `seat ${m.seat}`).toBeLessThan(Number.POSITIVE_INFINITY);
    }
    measured.push(
      `handover: ${walks.map((m) => `seat ${m.seat} ${m.from}→${m.to} ${m.set.toFixed(1)}–${m.done.toFixed(1)}`).join(', ')}; least sat ${r.least.toFixed(3)} (${r.leastAt}), moving ${r.leastMoving.toFixed(3)} (${r.leastMovingAt}); ${r.brushes} getting up, sitting down or climbing brushed her, the longest ${r.longest.toFixed(1)} s (${r.longestAt})`,
    );
    expect(r.bad.slice(0, 30)).toEqual([]);
    expect(r.least, r.leastAt).toBeGreaterThan(PEOPLE_APART);
    expect(r.leastMoving, r.leastMovingAt).toBeGreaterThan(PASSING);
    expect(r.longest, r.longestAt).toBeLessThanOrEqual(BRUSH_MOST);
  }, 120_000);

  test('her crew lean out on the rail and brace on the bench as she heels, and sit up again under a hysteresis; those on the bench talk only with someone near', async () => {
    const { plan } = await setUp;
    const rules = new CrewRules(plan);
    rules.set({ people: kind.stations.map((_, seat) => ({ seat, look: 0 })), holder: 0 }, false);
    const sn: SailorNow = { mode: SAILING, heel: 0, trim: 0, offset: 0, net: null };
    const step = (heel: number, seconds: number) => {
      sn.heel = heel;
      for (let t = 0; t < seconds; t += 1 / 30) {
        rules.step({ dt: 1 / 30, boom: -0.14, windOffBow: 0.8, depth: 0, sailor: sn });
      }
      return rules.members.filter((m) => m.station > 0);
    };
    expect(step(-3 * DEG, 3).every((m) => m.lean === 0)).toBe(true);
    expect(step(-(LEAN_HEEL_OUT + 0.02), 4).every((m) => m.lean === 1)).toBe(true);
    expect(step(-5 * DEG, 4).every((m) => m.lean === 1)).toBe(true);
    expect(step(-2 * DEG, 4).every((m) => m.lean === 0)).toBe(true);
    const bench = rules.members.filter((m) => kind.stations[m.station]?.pose === 'bench');
    expect(bench.every((m) => m.company === true)).toBe(true);
  });

  test('her helm: sat by the windward wheel in a light wind, a hand on its rim; standing at it in a breeze, both hands on its spokes; across between the wheels as the wind changes side; nothing through anything', async () => {
    const { through } = await obstacles;
    const { wheel } = await setUp;
    const ls = await looks;
    const bad: string[] = [];
    for (const l of ls) {
      const helm = await helmOf(l, 11);
      let t = 0;
      const run = (seconds: number, side: number, wind: number): void => {
        for (let k = 0; k < seconds * 30; k++, t += 1 / 30) {
          helm.mo.time = t;
          helm.mo.windAngle = side * 0.8;
          helm.mo.windSpeed = wind;
          helm.rt.update(helm.mo);
          if (k % 3 === 0) {
            for (const b of through(helm.caps(), -side * 0.3, { wheel: true })) {
              bad.push(`${l.name} ${t.toFixed(1)} ${side} ${wind}: ${b}`);
            }
          }
        }
      };
      run(3, 1, SIT_WIND - 1);
      expect(helm.rt.seat).toBe(1);
      const hips = (): Vector3 =>
        helm.rig.position(helm.rig.bone('pelvis'), new Vector3()).applyMatrix4(helm.rt.root);
      // Sat on the side deck outboard of the starboard wheel.
      expect(hips().x).toBeGreaterThan((wheel.spread ?? 0) + 0.3);
      run(3, 1, STAND_WIND + 1);
      expect(helm.rt.seat).toBe(0);
      expect(helm.rt.hands.wheel).toBe(2);
      expect(Math.abs(hips().x - (wheel.spread ?? 0))).toBeLessThan(0.15);
      // The wind to port: across, and standing at the port wheel.
      run(6, -1, STAND_WIND + 1);
      expect(helm.rt.walking).toBe(false);
      expect(helm.rt.windward).toBe(-1);
      expect(Math.abs(hips().x + (wheel.spread ?? 0))).toBeLessThan(0.15);
      // A lull: sat by it; then the wind back to starboard: up, across and sat again.
      run(4, -1, SIT_WIND - 1);
      expect(helm.rt.seat).toBe(1);
      expect(hips().x).toBeLessThan(-(wheel.spread ?? 0) - 0.3);
      run(10, 1, SIT_WIND - 1);
      expect(helm.rt.windward).toBe(1);
      expect(helm.rt.seat).toBe(1);
    }
    expect(bad.slice(0, 30)).toEqual([]);
  }, 60_000);
});

/** What the tests measured, printed at the end for the record. */
const measured: string[] = [];
afterAll(() => {
  if (process.env.YACHT_MEASURED !== undefined) {
    process.stdout.write(`${measured.join('\n')}\n`);
  }
});

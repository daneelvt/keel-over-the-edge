// SPDX-License-Identifier: AGPL-3.0-only

// Every kind whose art names a cruising catamaran's people's clips (the
// catamaran's), her people posed from the committed files as the game
// poses them: the helm by the sailor's runtime on her own clips, the rest
// by the crew's rules and bodies. Nothing through anything of her (her
// hulls, bridgedeck, saloon and its after bulkhead and doors, roof and its
// posts, helm's platform, settle, console and wheel, ladder and its rails,
// seats, table, beams, lifelines and stanchions, capstans; the boom and
// its sheet at every angle to the sheet's widest) and nobody through
// anybody: twelve aboard sat up and braced through their idles; through a
// tack and a gybe, nobody moving; at a handover, along her ways and up or
// down her ladder; and the helm sat on her settle and standing at her
// wheel.

import { readFileSync } from 'node:fs';
import { type AnimationClip, Matrix3, Matrix4, Mesh, type Object3D, Texture, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { afterAll, describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { SAILING } from '../sailor';
import { bridgeCrew } from './bridgecrew';
import { bridgeBoat, bridgeClips, bridgeOf, namesBridgeClips, seatOf } from './bridgedeck';
import { Clip } from './clips';
import { modelDeck, tillerOf } from './crew';
import { CrewBody, stance } from './crewbody';
import { type PoseInput, poseMember } from './crewpose';
import {
  BRACE_PITCH,
  BRACE_WIND,
  type CrewMember,
  CrewRules,
  crewPlan,
  moveAt,
  type SailorNow,
  UNBRACE_WIND,
} from './crewrules';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { Rig } from './rig';
import { type SailorBoat, type SailorMoment, SailorRuntime, SIT_WIND, STAND_WIND } from './runtime';
import { hullSolid } from './solid';
import { wheelOf } from './wheel';

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
/** The boom's and the mainsheet's radii, m. */
const BOOM_R = 0.08;
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
 * How near any two aboard come, beyond their capsules, m: sat. The
 * capsules are generous, and her seats seat twelve 0.45 to 0.55 m apart,
 * shoulder to shoulder: neighbours' knees and elbows touch (measured: the
 * capsules 0.09 m into each other, their bones' lines 0.06 m apart).
 */
const PEOPLE_APART = -0.1;
/**
 * How near two come while either moves about, m: getting up beside
 * someone sat, sitting down beside them, edging past their knees; and the
 * helm and the one relieving them at her wheel, who meet there as one
 * takes the spokes and the other steps away (measured: 0.19 m into each
 * other for a tenth of a second).
 */
const PASSING = -0.22;
/**
 * The longest anyone getting up, sitting down, or on her ladder or turning
 * at its foot, may have a bone's line through her (a seat's edge, her
 * ladder's tread or post, her wheel's rim), s: a blend of two poses and
 * the feet carried, not a clip made there.
 */
const BRUSH_MOST = 0.4;

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

const kinds = catalog.boats.filter((b) => namesBridgeClips(b.art));

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

test('a kind names the cruising catamaran’s clips', () => {
  expect(kinds.length).toBeGreaterThan(0);
});

describe.each(kinds.map((k) => [k.name, k] as const))('aboard the %s', (_, kind) => {
  const boat = load(kind.art.model);
  const looks = Promise.all(
    LOOKS.map(async ({ art, machine, name }) => {
      if (art === undefined) {
        throw new Error('no look');
      }
      const [deck, clipsFile, bridgeFile] = await Promise.all([
        load(art.model),
        load(art.clips),
        load(bridgeClips(art.clips)),
      ]);
      const rig = Rig.from(deck.scene, boneNames(deck.scene));
      const look = new FleetLook(0, art, machine);
      deck.scene.updateMatrixWorld(true);
      look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
      const clips = new Map<string, Clip>();
      for (const file of [clipsFile, bridgeFile]) {
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
      modelDeck(g.scene),
      tillerOf(g.scene),
    );
    const deck = bridgeBoat(parts);
    plan.bridge = bridgeCrew(deck);
    plan.cog = kind.physics.hull.centreOfGravity;
    if (plan.bridge == null || deck === null) {
      throw new Error('no deck or ways for her people');
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
      bridge: bridgeOf(parts),
    };
    return { g, plan, deck, sailorBoat, parts, at, wheel };
  })();

  /**
   * What of her a posed person's bones pass through, the boom at boom
   * (radians): every bone's line (and the head's, to the middle of its
   * ball) against her model's triangles, but her sails and flags; the boom
   * and its sheet by their lines. The feet's lines lifted a few
   * centimetres (they stand on what they stand on); the hands and forearms
   * may hold her wheel's rim (at the wheel).
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
      const what =
        node.startsWith('wheel') || o.name.startsWith('wheel')
          ? 'wheel'
          : `${o.name || node}:${mat}`;
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
    const sheet = at('sheet-boom');
    /** The boom's line at an angle, and a point along it (m from the gooseneck). */
    const along = (boom: number, d: number, y = gooseneck.y): Vector3 =>
      new Vector3(d * Math.sin(boom), y, gooseneck.z + d * Math.cos(boom));
    const through = (caps: Caps, boom: number, how: { wheel?: boolean } = {}): string[] => {
      const bad: string[] = [];
      const boomEnd = along(boom, plan.boom.length);
      const sheetTop = along(boom, sheet.z - gooseneck.z, gooseneck.y - 0.08);
      const sheetFoot = new Vector3(sheetTop.x, sheetTop.y - 0.6, sheetTop.z);
      for (const [a, b, r, name] of caps) {
        const feet = name.startsWith('foot') || name.startsWith('calf');
        const excused = how.wheel && name.startsWith('lowerarm') ? ['wheel'] : [];
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
        if (segments(a, b, sheetFoot, sheetTop) < r + SHEET_R) {
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
    const { plan, deck } = await setUp;
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
      world: 0,
      machine: l.machine,
      bridge: deck,
    };
    return { body, inp, caps: () => capsOf(body.rig, body.root) };
  }

  test('the checks see her table, a seat, the settle, the console, the wheel, the ladder’s treads, the saloon’s bulkhead, a roof post, her topsides and a stanchion, and not her open sole or platform', async () => {
    const { segmentCrosses } = await obstacles;
    const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
    const sees = (a: Vector3, b: Vector3): string | null => segmentCrosses(a, b, []);
    // Down through the table's top, the L-bench's, the aft bench's, the lounger's, the settle's.
    expect(sees(v(1, 2, 3), v(1, 1.75, 3))).not.toBeNull();
    expect(sees(v(2, 1.7, 3), v(2, 1.5, 3))).not.toBeNull();
    expect(sees(v(0.5, 1.7, 4.4), v(0.5, 1.5, 4.4))).not.toBeNull();
    expect(sees(v(-2, 1.65, 4.3), v(-2, 1.45, 4.3))).not.toBeNull();
    expect(sees(v(-2.5, 2.7, 2.7), v(-2.5, 2.5, 2.7))).not.toBeNull();
    // Across the wheel's rim and the console before it.
    expect(sees(v(-2.6, 2.9, 1.4), v(-2.6, 2.9, 1.8))).toBe('wheel');
    expect(sees(v(-2.6, 2.6, 0.9), v(-2.6, 2.6, 1.5))).not.toBeNull();
    // Down through a tread of the ladder.
    expect(sees(v(-1.3, 1.6, 3.5), v(-1.3, 1.3, 3.5))).not.toBeNull();
    // Forward through the saloon's after bulkhead.
    expect(sees(v(0, 2, 1.9), v(0, 2, 1.4))).not.toBeNull();
    // Out through her topsides.
    expect(sees(v(3, 0.8, 0), v(4.2, 0.8, 0))).not.toBeNull();
    // Over her open sole and platform, nothing.
    expect(sees(v(-0.5, 1.5, 2.2), v(-0.5, 1.5, 3.2))).toBeNull();
    expect(sees(v(-1.4, 2.5, 1.85), v(-2.2, 2.5, 1.85))).toBeNull();
  });

  test('her stations: the helm’s at her wheel; eleven on her seats, each on one, none to windward or to leeward', async () => {
    const { deck } = await setUp;
    const [helm, ...crew] = kind.stations;
    expect(helm?.pose).toBe('standing');
    expect(crew).toHaveLength(11);
    expect(crew.every((s) => s.pose === 'bench')).toBe(true);
    expect(crew.every((s) => s.windward !== true && s.lee !== true)).toBe(true);
    const on = crew.map((s) => seatOf(deck, s)?.family);
    expect(on).toEqual([
      'helm',
      'table',
      'table',
      'table',
      'table',
      'table',
      'beam',
      'beam',
      'beam',
      'lounger',
      'lounger',
    ]);
  });

  test('twelve aboard sat up and braced, through their idles, the boom anywhere: nothing through anything, nobody through anybody', async () => {
    const { through } = await obstacles;
    const ls = await looks;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    let leastAt = '';
    for (const k0 of [0, 1, 2]) {
      const helm = await helmOf(ls[k0] as Look, 3);
      const crews = await Promise.all(
        kind.stations.slice(1).map((_, i) => crewOf(ls[(k0 + i + 1) % ls.length] as Look, 5 + i)),
      );
      for (const [lean, wind] of [
        [0, SIT_WIND - 1],
        [1, STAND_WIND + 3],
      ] as const) {
        for (const t of [0, 13, 27, 41, 66, 95]) {
          helm.rt.reset();
          helm.mo.windAngle = 0.8;
          helm.mo.windSpeed = wind;
          for (let k = 0; k < 90; k++) {
            helm.mo.time = t + k / 30;
            helm.rt.update(helm.mo);
          }
          const people: { who: string; caps: Caps; how: { wheel?: boolean } }[] = [
            {
              who: `helm (${helm.rt.seat >= 1 ? 'sat' : 'standing'})`,
              caps: helm.caps(),
              how: { wheel: true },
            },
          ];
          crews.forEach((c, i) => {
            const station = i + 1;
            const m: CrewMember = {
              seat: station + k0,
              look: 0,
              station,
              side: (kind.stations[station]?.at[0] as number) < 0 ? -1 : 1,
              lean,
              leanTo: lean,
              moving: null,
              company: true,
            };
            c.inp.time = t;
            c.inp.world = t;
            poseMember(c.body, m, c.inp);
            people.push({
              who: `${station} ${c.body ? (c.inp.idle ?? '') : ''}`,
              caps: c.caps(),
              how: {},
            });
          });
          for (
            let a = -kind.physics.rig.boomOut * DEG;
            a <= kind.physics.rig.boomOut * DEG + 1e-6;
            a += 26 * DEG
          ) {
            for (const p of people) {
              for (const b of through(p.caps, a, p.how)) {
                bad.push(`k0 ${k0} lean ${lean} t ${t} ${p.who}: ${b}`);
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
                leastAt = `k0 ${k0} lean ${lean} t ${t}: ${people[i]?.who} and ${people[j]?.who}, ${apartParts}`;
              }
              if (process.env.BRIDGE_PAIRS !== undefined && d < PEOPLE_APART) {
                measured.push(
                  `pair ${d.toFixed(3)} lean ${lean}: ${people[i]?.who} and ${people[j]?.who}, ${apartParts}`,
                );
              }
            }
          }
        }
      }
    }
    measured.push(`twelve sat: ${least.toFixed(3)} (${leastAt})`);
    expect([...new Set(bad)].slice(0, 40)).toEqual([]);
    expect(least, leastAt).toBeGreaterThan(PEOPLE_APART);
  }, 120_000);

  /** What a moment of her is: her boom and the wind off her bow (radians), the apparent wind (radians, m/s), her heel and trim. */
  interface Moment {
    boom: number;
    windOffBow: number;
    windAngle: number;
    wind: number;
    heel: number;
    trim?: number;
  }

  /**
   * Sails twelve aboard under the rules and the helm's runtime for seconds,
   * as script gives her at each moment, the controls changing hands at the
   * times handovers gives; posing everyone ten times a second: what anyone
   * passes through, how near any two come, and when each set off.
   */
  async function sail(
    seconds: number,
    script: (t: number) => Moment,
    handovers: [number, number][] = [],
    aboard = kind.stations.length,
  ) {
    const { plan } = await setUp;
    const { through } = await obstacles;
    const ls = await looks;
    const people = kind.stations
      .slice(0, aboard)
      .map((_, seat) => ({ seat, look: seat % ls.length }));
    const rules = new CrewRules(plan);
    let holder = 0;
    rules.set({ people, holder }, false);
    const helms = await Promise.all(people.map((p) => helmOf(ls[p.look] as Look, 2 + p.seat)));
    const crews = await Promise.all(people.map((p) => crewOf(ls[p.look] as Look, 3 + p.seat)));
    const dt = 1 / 30;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    let leastAt = '';
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
    let leastMoving = Number.POSITIVE_INFINITY;
    let leastMovingAt = '';
    const brief = new Map<string, number>();
    const briefAt = new Map<string, string>();
    /** Where each sat person's hips were when the script began, and how far any has moved since. */
    const sat0 = new Map<number, Vector3>();
    let shifted = 0;
    let climbed = false;
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
      sn.heel = now.heel;
      sn.trim = now.trim ?? 0;
      rules.step({
        dt,
        boom: now.boom,
        windOffBow: now.windOffBow,
        depth: 0,
        sailor: sn,
        apparent: now.wind,
      });
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
        how: { wheel?: boolean };
        moving: string | null;
        key: string;
        seat: number;
      }[] = [];
      if (!rules.helmAway) {
        drawn.push({
          who: `helm ${holder}`,
          caps: helm.caps(),
          how: { wheel: true },
          moving: null,
          key: 'helm',
          seat: -1,
        });
      }
      for (const m of rules.members) {
        if (m.station <= 0 && m.moving === null) {
          continue;
        }
        const c = crews[m.seat] as Awaited<ReturnType<typeof crewOf>>;
        c.inp.time = t;
        c.inp.world = t;
        c.inp.life.heel = now.heel;
        poseMember(c.body, m, c.inp);
        const mv = m.moving;
        const at = mv === null || mv.t < 0 ? null : moveAt(mv, { rise: 0, along: 0, sit: 0 });
        const stretch =
          at === null ? undefined : mv?.stretches?.find((l) => at.along > l.s0 && at.along < l.s1);
        const onLadder = stretch !== undefined && stretch.kind !== 'edge';
        climbed ||= onLadder;
        if (mv === null) {
          const hips = c.body.hips.clone();
          const was = sat0.get(m.seat);
          if (was === undefined) {
            sat0.set(m.seat, hips);
          } else {
            shifted = Math.max(shifted, Math.hypot(hips.x - was.x, hips.z - was.z));
          }
        }
        drawn.push({
          moving:
            at === null
              ? null
              : at.rise < 1
                ? 'getting up'
                : at.sit > 0
                  ? 'sitting down'
                  : onLadder
                    ? 'on the ladder'
                    : null,
          key: `${m.seat} ${mv?.kind ?? ''} ${mv?.from.station ?? ''}`,
          who: `seat ${m.seat} ${mv === null ? `at ${m.station}` : `${mv.kind} ${mv.from.station}→${mv.to.station} ${mv.t.toFixed(1)}`}`,
          caps: c.caps(),
          how: { wheel: mv !== null && (mv.from.station < 0 || mv.to.station < 0) },
          seat: m.seat,
        });
      }
      for (const p of drawn) {
        const through1 = through(p.caps, now.boom, p.how);
        if (through1.length > 0 && p.moving !== null) {
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
          const sat = !a.who.includes(' change ') && !b.who.includes(' change ');
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
      shifted,
      climbed,
      helm: helms[holder],
    };
  }

  /** A tack from starboard to port: through the wind from 1 s to 9 s, as slowly as she tacks. */
  const tack = (t: number): Moment => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 8));
    const off = 50 * DEG - turn * 100 * DEG;
    const boom = -Math.sign(off) * Math.min(0.06, Math.abs(off) * 0.3);
    const heel = (-2 + 4 * Math.max(0, Math.min(1, (t - 4) / 4))) * DEG;
    return {
      boom,
      windOffBow: off,
      windAngle: off * 0.7,
      wind: 9,
      heel,
      trim: 0.02 * Math.sin(t * 2),
    };
  };

  /** A gybe from port to starboard on a broad reach: the wind over port, the boom to starboard, coming over at 3.6 s. */
  const gybe = (t: number): Moment => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 5));
    const off = -(150 * DEG) - turn * 60 * DEG;
    const wrapped = Math.atan2(Math.sin(off), Math.cos(off));
    const over = Math.max(0, Math.min(1, (t - 3.4) / 0.5));
    const boom = 1.1 - 2.2 * over;
    return {
      boom,
      windOffBow: wrapped,
      windAngle: wrapped * 0.95,
      wind: 5,
      heel: (1 - 2 * over) * DEG,
    };
  };

  test('through a tack and a gybe, twelve aboard: nobody moves but the boat; nothing through anything, nobody through anybody', async () => {
    for (const [name, script, seconds] of [
      ['tack', tack, 14],
      ['gybe', gybe, 10],
    ] as const) {
      const r = await sail(seconds, script);
      expect(r.moves, name).toEqual([]);
      expect(r.shifted, name).toBeLessThan(0.12);
      measured.push(
        `${name}: nobody moved; their hips within ${r.shifted.toFixed(3)} m of where they sat (their idles); least sat ${r.least.toFixed(3)} (${r.leastAt})`,
      );
      expect(r.bad.slice(0, 30), name).toEqual([]);
      expect(r.least, r.leastAt).toBeGreaterThan(PEOPLE_APART);
    }
  }, 240_000);

  /** Close-hauled on starboard in a breeze. */
  const beat = (): Moment => ({
    boom: -0.06,
    windOffBow: 50 * DEG,
    windAngle: 32 * DEG,
    wind: 9,
    heel: -2 * DEG,
  });

  test.each([
    ['beside the helm', 1, 12],
    ['at the table', 2, 12],
    ['at the table, hemmed in', 5, 12],
    ['on the aft bench', 7, 12],
    ['on the lounger', 10, 12],
    ['at the table, six aboard', 4, 6],
    ['on the aft bench, two aboard', 1, 2],
  ] as const)(
    'a handover %s (station %i, %i aboard): the new helm walks her ways and climbs her ladder to the wheel, the old walks down to their seat; nothing through anything, nobody through anybody',
    async (_, seat, aboard) => {
      const r = await sail(
        70,
        () => beat(),
        [
          [1, seat],
          [36, 0],
        ],
        aboard,
      );
      const walks = r.moves.filter((m) => m.kind === 'change');
      expect(walks.some((m) => m.from === seat && m.to < 0)).toBe(true);
      expect(walks.some((m) => m.from < 0 && m.to === seat)).toBe(true);
      for (const m of walks) {
        expect(m.done, `seat ${m.seat}`).toBeLessThan(Number.POSITIVE_INFINITY);
      }
      if (seat !== 1) {
        expect(r.climbed).toBe(true);
      }
      measured.push(
        `handover ${seat} (${aboard} aboard): ${walks.map((m) => `seat ${m.seat} ${m.from}→${m.to} ${m.set.toFixed(1)}–${m.done.toFixed(1)}`).join(', ')}; least sat ${r.least.toFixed(3)} (${r.leastAt}), moving ${r.leastMoving.toFixed(3)} (${r.leastMovingAt}); ${r.brushes} getting up, sitting down or on the ladder brushed her, the longest ${r.longest.toFixed(1)} s (${r.longestAt})`,
      );
      expect(r.bad.slice(0, 30)).toEqual([]);
      expect(r.least, r.leastAt).toBeGreaterThan(PEOPLE_APART);
      expect(r.leastMoving, r.leastMovingAt).toBeGreaterThan(PASSING);
      expect(r.longest, r.longestAt).toBeLessThanOrEqual(BRUSH_MOST);
    },
    240_000,
  );

  test('her people brace in a breeze or as she pitches, and sit up again under a hysteresis; not as she heels; they talk only with someone near', async () => {
    const { plan } = await setUp;
    const rules = new CrewRules(plan);
    rules.set({ people: kind.stations.map((_, seat) => ({ seat, look: 0 })), holder: 0 }, false);
    const sn: SailorNow = { mode: SAILING, heel: 0, trim: 0, offset: 0, net: null };
    let t = 0;
    const step = (apparent: number, seconds: number, heel = 0, pitch = 0) => {
      sn.heel = heel;
      for (let k = 0; k < seconds * 30; k++, t += 1 / 30) {
        sn.trim = pitch * Math.sin(t * 2);
        rules.step({ dt: 1 / 30, boom: -0.06, windOffBow: 0.9, depth: 0, sailor: sn, apparent });
      }
      return rules.members.filter((m) => m.station > 0);
    };
    expect(step(UNBRACE_WIND - 1, 4).every((m) => m.lean === 0)).toBe(true);
    expect(step(UNBRACE_WIND - 1, 6, 20 * DEG).every((m) => m.lean === 0)).toBe(true);
    expect(step(BRACE_WIND + 0.5, 6).every((m) => m.lean === 1)).toBe(true);
    expect(step((BRACE_WIND + UNBRACE_WIND) / 2, 6).every((m) => m.lean === 1)).toBe(true);
    expect(step(UNBRACE_WIND - 0.5, 6).every((m) => m.lean === 0)).toBe(true);
    // Pitching (her trim's rate past BRACE_PITCH) in a light wind.
    expect(step(UNBRACE_WIND - 1, 12, 0, BRACE_PITCH).every((m) => m.lean === 1)).toBe(true);
    expect(step(UNBRACE_WIND - 1, 12, 0, 0).every((m) => m.lean === 0)).toBe(true);
    expect(rules.members.filter((m) => m.station > 0).every((m) => m.company === true)).toBe(true);
    // Alone beside the helm, nobody to talk with.
    const two = new CrewRules(plan);
    two.set({ people: [0, 1].map((seat) => ({ seat, look: 0 })), holder: 0 }, false);
    two.step({ dt: 1 / 30, boom: -0.06, windOffBow: 0.9, depth: 0, sailor: sn, apparent: 3 });
    expect(two.members.find((m) => m.station === 1)?.company).toBe(false);
  });

  test('her helm: sat on the settle in a light wind, the hands off the rim; standing at the wheel in a breeze, both hands on its spokes; never crossing; nothing through anything', async () => {
    const { through } = await obstacles;
    const { sailorBoat } = await setUp;
    const stance = (sailorBoat.bridge as NonNullable<typeof sailorBoat.bridge>).stance.at;
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
      const hips = (): Vector3 =>
        helm.rig.position(helm.rig.bone('pelvis'), new Vector3()).applyMatrix4(helm.rt.root);
      run(3, 1, SIT_WIND - 1);
      expect(helm.rt.seat).toBe(1);
      expect(helm.rt.hands.wheel).toBe(0);
      // Sat on the settle behind the stance.
      expect(hips().z).toBeGreaterThan(stance.z + 0.25);
      run(4, 1, STAND_WIND + 1);
      expect(helm.rt.seat).toBe(0);
      expect(helm.rt.hands.wheel).toBe(2);
      expect(Math.hypot(hips().x - stance.x, hips().z - stance.z)).toBeLessThan(0.2);
      // The wind to port: the same wheel, looking the other way.
      run(4, -1, STAND_WIND + 1);
      expect(helm.rt.windward).toBe(-1);
      expect(Math.hypot(hips().x - stance.x, hips().z - stance.z)).toBeLessThan(0.2);
      run(4, -1, SIT_WIND - 1);
      expect(helm.rt.seat).toBe(1);
      expect(hips().z).toBeGreaterThan(stance.z + 0.25);
    }
    expect(bad.slice(0, 30)).toEqual([]);
  }, 60_000);
});

/** What the tests measured, printed at the end for the record. */
const measured: string[] = [];
afterAll(() => {
  if (process.env.BRIDGE_MEASURED !== undefined) {
    process.stdout.write(`${measured.join('\n')}\n`);
  }
});

// SPDX-License-Identifier: AGPL-3.0-only

// The fleet's sailors: those near the camera skinned and moving as the boat
// in view's does, the rest rigid figures posed seated, each tier in one
// draw whatever the looks in it.
//
// Near: every near boat's sailor has a runtime of its own (runtime.ts:
// clips, the life layers, the hand on the tiller extension; no springs),
// run 20 times a second (at a wheel, the wheel turned by the rudder as the
// boat draws it), each boat's in its own turn of the frames, which
// leaves its bones' matrices (from the figure's bind pose to the boat
// model) in a cache. Each frame the near boats' rows of a float texture
// take their boat's values and their sailor's matrices from the cache,
// and the vertex stage skins each vertex from its instance's row, sways
// what hangs on the cloth's and hair's chains in the apparent wind (the
// springs' place), keeps that cloth over the seat, and places the boat.
//
// A row, texel by texel (each four floats):
//   0 pose: scene x, scene z, heading, heel
//   1 lean: the figure's tilt, heave, pitch, 1 for a machine sailor's boat
//   2 rig: boom, rudder, opacity, the sail's side
//   3 main colour (linear), the look's layer
//   4 skin colour, 1 for a machine
//   5 hair colour, 1 if the row is drawn as a rigid figure (2 out on a
//     trapeze's wire to starboard, 3 to port)
//   6 the sway: the apparent wind's push in the model's frame (x, z,
//     metres at full sway), the seat's side (±1 seated, 0 not), 1 if the
//     row is drawn skinned
//   7 seat: the rigid figure's place in the model (x, y, z) and facing
//   8 on: three texels a bone, the rows of its matrix.
//
// Rigid: the far level's figure of each look, posed seated by figureNode
// (fleetparts.ts) from the first eight texels of its instance's row: every
// far boat, and near ones whose look has not loaded its deck level and
// clips yet. On a boat with a trapeze, out on the wire, the look's figure
// out on the wire on that side instead, from the same pool.
//
// The sailors' meshes read their instances' values from these rows, not
// from instanced attributes they would share with the boats' meshes: three.js
// r186, freeing a geometry, frees the instanced attributes of the meshes
// drawn with it too, and the figures' geometry is made anew as each look
// loads.
//
// Allocation-free once each near boat's sailor is made.

import {
  DataTexture,
  FloatType,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three';
import {
  abs,
  attribute,
  dot,
  Fn,
  float,
  If,
  int,
  ivec2,
  max,
  normalGeometry,
  normalize,
  normalLocal,
  positionGeometry,
  sin,
  texture,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { DrawnBoat } from '../../game/fleet';
import { figureNode, type Instances, placeNormal, placePoint } from '../fleetparts';
import { SAILING } from '../sailor';
import type { FleetLook } from './fleetlooks';
import { type Hike, STRAPPED } from './restage';
import { Rig } from './rig';
import {
  OFF_SEAT,
  type SailorBoat,
  type SailorMoment,
  SailorRuntime,
  type WheelHelm,
  wheelTurn,
} from './runtime';
import type { HullSolid } from './solid';
import type { Trapeze } from './trapeze';

/** How often a near sailor's runtime runs, a second. */
export const NEAR_RATE = 20;
/** Texels in a row before its bones. */
export const ROW_HEAD = 8;
/** How far the cloth's and hair's ends move in a full apparent wind, metres; and that wind, m/s. */
const SWAY = 0.07;
const SWAY_WIND = 12;
/** How far over the seat's plane cloth lies; out past the gunwale this far still counts as the seat. */
const SEAT_CLEAR = 0.012;
const SEAT_BEYOND = 0.3;
/** The view's slots, each a boat's sailor. */
const SLOTS = 64;

/** What the near sailors need of the boat, in its model's frame. */
export interface NearBoat {
  /** The rudder's stock, about which the tiller and its extension swing. */
  stock: Vector3;
  hinge: Vector3;
  extension: number;
  seatY: number;
  seatIn: number;
  seatOut: number;
  seatZ: number;
  cog: number;
  solid: HullSolid;
  climbTime: number;
  /** How far the seat is from the clips' boat's, and how it hikes (restage.ts's seating). */
  restage?: Vector3 | null;
  hike?: Hike;
  /** The wheel the sailor stands at, on a boat steered by one (wheel.ts's wheelOf), and the rudder's most (radians) that turns it hard over. */
  wheel?: WheelHelm | null;
  rudderMax?: number;
  /** The trapeze, on a boat with one (trapeze.ts's trapezeOf): its sailors go out on the wire. */
  trapeze?: Trapeze | null;
}

/** A near boat's sailor: its runtime, and its bones' matrices as last run. */
class Sailor {
  readonly runtime: SailorRuntime;
  readonly boat: SailorBoat;
  readonly moment: SailorMoment;
  /** Twelve floats a bone: the first three rows of its matrix. */
  readonly bones: Float32Array;
  /** Seconds gathered toward the next run, and since the last; the heel at the last one. */
  wait: number;
  since = 0;
  heel = 0;
  fresh = true;

  constructor(
    readonly look: FleetLook,
    near: NearBoat,
    seed: number,
    still: boolean,
  ) {
    const deck = look.deck;
    const clips = look.clips;
    if (deck === null || clips === null) {
      throw new Error('a near sailor needs its look’s deck level and clips');
    }
    const t = deck.rig;
    const rig = new Rig(t.names, t.parent, t.restPos, t.restQuat);
    rig.base.copy(t.base);
    this.boat = {
      hinge: near.hinge.clone(),
      hingeRest: near.hinge,
      extension: near.extension,
      seatY: near.seatY,
      seatIn: near.seatIn,
      seatOut: near.seatOut,
      seatZ: near.seatZ,
      cog: near.cog,
      solid: near.solid,
      climbTime: near.climbTime,
      restage: near.restage ?? null,
      hike: near.hike ?? STRAPPED,
      // Each its own, turned by its own boat's rudder.
      wheel: near.wheel ? { ...near.wheel, turn: 0 } : null,
      trapeze: near.trapeze ?? null,
    };
    this.runtime = new SailorRuntime(rig, clips, this.boat, seed, look.machine, false);
    if (near.trapeze) {
      this.runtime.hook(look.hook);
    }
    this.bones = new Float32Array(12 * t.names.length);
    this.moment = {
      dt: 0,
      time: 0,
      offset: 0,
      mode: 0,
      timer: 0,
      heel: 0,
      pitch: 0,
      heave: 0,
      windSpeed: 0,
      windAngle: 0,
      rollRate: 0,
      still,
    };
    // Each sailor in its own turn of the frames.
    this.wait = (seed % 7) / 7 / NEAR_RATE;
  }
}

const m = new Matrix4();
const m2 = new Matrix4();
const v = new Vector3();

/** Rows of a float texture, a sailor's each, which the GPU reads by instance. */
export class SailorRows {
  readonly texture: DataTexture;
  readonly data: Float32Array;

  constructor(
    /** Texels a row. */
    readonly width: number,
    readonly rows: number,
    name: string,
  ) {
    this.data = new Float32Array(4 * width * rows);
    this.texture = new DataTexture(this.data, width, rows, RGBAFormat, FloatType);
    this.texture.name = name;
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }
}

export class NearSailors extends SailorRows {
  readonly #slots: (Sailor | null)[] = new Array<Sailor | null>(SLOTS).fill(null);
  readonly #still: boolean;
  /** The world's time, seconds, at the last frame. */
  #time = 0;
  /** How many times a sailor has run, counted until read. */
  runs = 0;

  constructor(
    readonly bones: number,
    rows: number,
    readonly boat: NearBoat,
  ) {
    super(ROW_HEAD + 3 * bones, rows, 'fleet near sailors skinned');
    this.#still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** A new frame at the world's time; dt the time since the last, seconds. */
  frame(time: number): void {
    this.#time = time;
  }

  /**
   * Row n is boat b's, of look: its sailor run if its turn has come, its
   * matrices written in. Returns whether it can be drawn skinned (its look's
   * deck level and clips have loaded).
   */
  write(n: number, b: DrawnBoat, look: FleetLook, dt: number): boolean {
    if (b.slot < 0 || b.slot >= SLOTS || look.deck === null || look.clips === null) {
      return false;
    }
    if (this.boat.wheel && look.wheelState !== 'ready') {
      // At a wheel: rigid until its clips at the wheel have loaded.
      return false;
    }
    if (this.boat.trapeze && look.trapezeState !== 'ready' && look.trapezeState !== 'failed') {
      // On a trapeze: rigid until its clips on the wire have loaded (or failed to: then on the rail).
      return false;
    }
    let s = this.#slots[b.slot] ?? null;
    if (s === null || s.look !== look) {
      s = new Sailor(look, this.boat, b.slot * 131 + look.index * 17 + 1, this.#still);
      this.#slots[b.slot] = s;
    }
    // Its turns kept to the rate on average, whatever the frames' length.
    s.wait += dt;
    s.since += dt;
    if (s.fresh || s.wait >= 1 / NEAR_RATE) {
      this.#run(s, b, s.fresh ? 0 : s.since);
      s.wait = s.fresh ? s.wait : Math.min(s.wait - 1 / NEAR_RATE, 1 / NEAR_RATE);
      s.since = 0;
      s.fresh = false;
    }
    this.data.set(s.bones, 4 * (this.width * n + ROW_HEAD));
    return true;
  }

  /** Every sailor forgotten: the next frame meets each afresh (the boats moved at once). */
  forget(): void {
    this.#slots.fill(null);
  }

  #run(s: Sailor, b: DrawnBoat, dt: number): void {
    this.runs++;
    const mo = s.moment;
    mo.dt = dt;
    mo.time = this.#time;
    mo.offset = b.sailor;
    mo.aft = b.aft;
    mo.mode = b.mode;
    // The fleet does not hear how far on a climb is: as if just begun.
    mo.timer = s.boat.climbTime;
    mo.heel = b.heel;
    mo.pitch = b.pitch;
    mo.heave = b.heave;
    mo.rollRate = dt > 0 ? (b.heel - s.heel) / dt : 0;
    s.heel = b.heel;
    // The extension's hinge, where the rudder swings it about the stock.
    const k = this.boat.stock;
    v.subVectors(s.boat.hingeRest, k);
    const c = Math.cos(b.rudder);
    const sn = Math.sin(b.rudder);
    s.boat.hinge.set(k.x + v.x * c + v.z * sn, s.boat.hingeRest.y, k.z + v.z * c - v.x * sn);
    if (s.boat.wheel) {
      s.boat.wheel.turn = wheelTurn(b.rudder, this.boat.rudderMax ?? 0);
    }
    const rt = s.runtime;
    rt.update(mo);
    const rig = rt.rig;
    const inverse = s.look.deck?.inverse as Float32Array;
    const out = s.bones;
    for (let j = 0; j < rig.names.length; j++) {
      m.fromArray(rig.world, 16 * j);
      m2.fromArray(inverse, 16 * j);
      m.premultiply(rt.root).multiply(m2);
      const e = m.elements;
      const o = 12 * j;
      // The rows of the column-major matrix.
      out[o] = e[0] as number;
      out[o + 1] = e[4] as number;
      out[o + 2] = e[8] as number;
      out[o + 3] = e[12] as number;
      out[o + 4] = e[1] as number;
      out[o + 5] = e[5] as number;
      out[o + 6] = e[9] as number;
      out[o + 7] = e[13] as number;
      out[o + 8] = e[2] as number;
      out[o + 9] = e[6] as number;
      out[o + 10] = e[10] as number;
      out[o + 11] = e[14] as number;
    }
  }

  /** Whether a slot's sailor is seated, and on which side: ±1, or 0 if not seated (out on a wire, or not sailing). */
  seated(slot: number): number {
    const s = slot >= 0 && slot < SLOTS ? this.#slots[slot] : null;
    if (
      s === null ||
      s === undefined ||
      s.moment.mode !== SAILING ||
      s.runtime.crossing ||
      s.runtime.hands.wire >= OFF_SEAT
    ) {
      return 0;
    }
    return s.runtime.side;
  }

  /**
   * Where a slot's sailor's hook is (the model's frame, as last run), into
   * out, and on which side, if it hangs from a trapeze's wire; else 0.
   */
  hook(slot: number, out: Vector3): number {
    const s = slot >= 0 && slot < SLOTS ? this.#slots[slot] : null;
    if (s === null || s === undefined || !s.runtime.hands.hooked) {
      return 0;
    }
    out.copy(s.runtime.hands.hook);
    return s.runtime.side;
  }

  /** Marks the rows written: the texture goes to the GPU with the next draw. */
  commit(): void {
    this.texture.needsUpdate = true;
  }
}

/** A sailor's per-instance values, as nodes, for its material. */
export interface FleetSailorNodes {
  /** Where the vertex goes: the material's position node. */
  vertex: Node<'vec3'>;
  main: Node<'vec3'>;
  skin: Node<'vec3'>;
  hair: Node<'vec3'>;
  machine: Node<'float'>;
  layer: Node<'float'>;
  opacity: Node<'float'>;
}

/**
 * The near sailors' vertex: skinned from its instance's row of rows (row),
 * swayed, kept over the seat and placed with its boat; folded to a point
 * where the row's look is not the vertex's, or the row is not drawn
 * skinned. time is the world's time, seconds (modulo 2π is fine).
 */
export function nearSailorNodes(
  rows: Texture,
  row: Node<'int'>,
  cog: number,
  seat: { y: number; in: number; out: number },
  time: Node<'float'>,
): FleetSailorNodes {
  const t = texture(rows);
  const i = rowInstances(t, row);
  const { pose, main } = i;
  const sway = t.load(ivec2(6, row)) as unknown as Node<'vec4'>;
  const vertex = Fn(() => {
    const tag = attribute('tag', 'vec2') as unknown as Node<'vec2'>;
    const out = vec3(0, 0, 0).toVar();
    If(abs(tag.x.sub(main.w)).lessThan(0.5).and(sway.w.greaterThan(0.5)), () => {
      const index = attribute('skinIndex', 'vec4') as unknown as Node<'vec4'>;
      const weight = attribute('skinWeight', 'vec4') as unknown as Node<'vec4'>;
      const s0 = skinRow(t, row, index, weight, positionGeometry, normalGeometry);
      const p = s0.p.toVar();
      const skinned = s0.n;
      // What hangs on the chains streams with the wind, unsteadily.
      const s = tag.y;
      const gust = sin(time.mul(2.3).add(p.y.mul(5)).add(pose.x.mul(0.7)))
        .mul(0.3)
        .add(0.7);
      p.addAssign(vec3(sway.x, 0, sway.y).mul(s.mul(gust)));
      // Kept over the seat, where it lies on it.
      const side = sway.z;
      const o = p.x.mul(side);
      If(
        s
          .greaterThan(0)
          .and(abs(side).greaterThan(0.5))
          .and(o.greaterThan(seat.in))
          .and(o.lessThan(seat.out + SEAT_BEYOND)),
        () => {
          p.assign(vec3(p.x, max(p.y, seat.y + SEAT_CLEAR), p.z));
        },
      );
      normalLocal.assign(placeNormal(normalize(skinned), i));
      out.assign(placePoint(p, i, cog));
    });
    return out;
  })() as unknown as Node<'vec3'>;
  return { vertex, ...colours(i) };
}

/**
 * A point and its normal skinned by the bones in a row of rows (three texels
 * a bone from ROW_HEAD on, the rows of its matrix), by four bones and their
 * weights.
 */
export function skinRow(
  t: ReturnType<typeof texture>,
  row: Node<'int'>,
  index: Node<'vec4'>,
  weight: Node<'vec4'>,
  point: Node<'vec3'>,
  normal: Node<'vec3'>,
): { p: Node<'vec3'>; n: Node<'vec3'> } {
  const rows: Node<'vec4'>[][] = [[], [], []];
  for (const c of ['x', 'y', 'z', 'w'] as const) {
    const x = int(index[c].add(0.5)).mul(3).add(ROW_HEAD);
    const w = weight[c];
    for (let k = 0; k < 3; k++) {
      rows[k]?.push((t.load(ivec2(x.add(k), row)) as unknown as Node<'vec4'>).mul(w));
    }
  }
  const [r0, r1, r2] = rows.map(([a, b, c, d]) =>
    (a as Node<'vec4'>)
      .add(b as Node<'vec4'>)
      .add(c as Node<'vec4'>)
      .add(d as Node<'vec4'>),
  ) as [Node<'vec4'>, Node<'vec4'>, Node<'vec4'>];
  const p4 = vec4(point, 1);
  return {
    p: vec3(dot(r0, p4), dot(r1, p4), dot(r2, p4)) as unknown as Node<'vec3'>,
    n: vec3(
      dot(r0.xyz, normal),
      dot(r1.xyz, normal),
      dot(r2.xyz, normal),
    ) as unknown as Node<'vec3'>,
  };
}

/** A row's first texels, as the fleet's instance values (fleetparts.ts). */
export function rowInstances(t: ReturnType<typeof texture>, row: Node<'int'>): Instances {
  const at = (x: number): Node<'vec4'> => t.load(ivec2(x, row)) as unknown as Node<'vec4'>;
  const rig = at(2);
  return {
    pose: at(0),
    lean: at(1),
    rig,
    sail: rig,
    main: at(3),
    skin: at(4),
    hair: at(5),
    seat: at(7),
  };
}

/** A sailor's colours, kind and layer, and its boat's opacity, carried to its fragments. */
function colours(i: Instances): Omit<FleetSailorNodes, 'vertex'> {
  const { main, skin, hair, rig } = i;
  return {
    main: varying(main.xyz) as unknown as Node<'vec3'>,
    skin: varying(skin.xyz) as unknown as Node<'vec3'>,
    hair: varying(hair.xyz) as unknown as Node<'vec3'>,
    machine: varying(skin.w) as unknown as Node<'float'>,
    layer: varying(main.w) as unknown as Node<'float'>,
    opacity: varying(rig.z) as unknown as Node<'float'>,
  };
}

/**
 * The rigid figures' vertex: its look's far figure placed as figureNode
 * does, from its instance's row of rows; folded to a point where the row's
 * look is not the vertex's, or the row is not drawn rigid, or in the pose
 * the vertex's figure is (seated, or out on a wire on its side).
 */
export function rigidSailorNodes(rows: Texture, row: Node<'int'>, cog: number): FleetSailorNodes {
  const i = rowInstances(texture(rows), row);
  const tag = attribute('tag', 'vec2') as unknown as Node<'vec2'>;
  // Its look's, and its pose's: seated (0), or on a wire to starboard (1) or port (2).
  const here = abs(tag.x.sub(i.main.w))
    .lessThan(0.5)
    .and(i.hair.w.greaterThan(0.5))
    .and(abs(tag.y.sub(i.hair.w.sub(1))).lessThan(0.5));
  return { vertex: figureNode(i, cog).mul(float(here)) as unknown as Node<'vec3'>, ...colours(i) };
}

/** The apparent wind's push on a sailor's cloth, in the boat model's frame, into out (x, z). */
export function swayOf(
  windFrom: number,
  windSpeed: number,
  b: DrawnBoat,
  out: { x: number; z: number },
): void {
  // The wind's velocity (where it blows to), east and north, less the boat's.
  const we = -windSpeed * Math.sin(windFrom) - b.speed * Math.sin(b.heading);
  const wn = -windSpeed * Math.cos(windFrom) - b.speed * Math.cos(b.heading);
  // Into the model's frame: x to starboard, z aft.
  const c = Math.cos(b.heading);
  const s = Math.sin(b.heading);
  const x = we * c - wn * s;
  const z = -(we * s + wn * c);
  const speed = Math.hypot(x, z);
  const k = speed > 1e-6 ? (SWAY * Math.min(1, speed / SWAY_WIND)) / speed : 0;
  out.x = x * k;
  out.z = z * k;
}

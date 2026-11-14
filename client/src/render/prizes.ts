// SPDX-License-Identifier: AGPL-3.0-only

// Prizes afloat: what a boat flies for its skipper's races in the world,
// seen by every boat that passes. A winner's pennants, one for each of the
// latest wins in its race's colour, make a short string down the forestay
// from just under the masthead (down the mast on a boat with no stay to
// the stem), as yachts fly prize flags coming home; the racing burgee, or
// the gilded one, flies at the masthead; the committee's flag on the
// backstay, halfway between the masthead and the stern; and the wooden
// spoons a sailor chose to hang swing from the stern rail on their
// lanyards, plumb whatever the boat's heel, in the boat's own swing. The
// flags are the committee's signal flags' draw, from the same catalog,
// streaming with the wind each boat feels, its own way through the water
// taken from the true wind; the spoons one instanced draw of carved wood.
// Every boat's in one draw each, placed on the CPU from each boat's pose
// as the fleet places it, and nothing is allocated a frame. A boat's
// skipper wears the winner's cockade while it flies a pennant (the
// sailors' material draws it).
//
// What a boat flies comes as a prize code (the protocol's BoatPrize), from
// the low bits: how many pennants (3 bits), each one's colour, the newest
// win's first (five of 3 bits), the burgee (2 bits: none, racing, gilded),
// the spoons (2 bits) and the committee's flag (1 bit).

import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import type { Committee, TownFlags } from '../catalog/types.gen';
import { SignalFlags, type SignalSeen } from './flags';
import { litMaterial } from './materials';

/** The most pennants a code holds, and the bits of its fields. */
export const MOST_PENNANTS = 5;
const PENNANT_BITS = 3;
const COLOUR_BITS = 3;
const BURGEE_SHIFT = PENNANT_BITS + COLOUR_BITS * MOST_PENNANTS;
const SPOON_SHIFT = BURGEE_SHIFT + 2;
const COMMITTEE_BIT = 1 << (SPOON_SHIFT + 2);

/** The burgees. */
export const BURGEE = { none: 0, racing: 1, gilded: 2 } as const;

/** How many winner's pennants a code flies. */
export function pennantsOf(code: number): number {
  return Math.min(code & ((1 << PENNANT_BITS) - 1), MOST_PENNANTS);
}

/** The colour of a code's pennant i, the newest win's first: a place in the races' colours. */
export function pennantOf(code: number, i: number): number {
  return (code >>> (PENNANT_BITS + COLOUR_BITS * i)) & ((1 << COLOUR_BITS) - 1);
}

/** A code's burgee. */
export function burgeeOf(code: number): number {
  return (code >>> BURGEE_SHIFT) & 3;
}

/** How many wooden spoons hang from a code's stern. */
export function spoonsOf(code: number): number {
  return (code >>> SPOON_SHIFT) & 3;
}

/** Whether a code flies the committee's flag. */
export function committeeOf(code: number): boolean {
  return (code & COMMITTEE_BIT) !== 0;
}

/** Whether a code's skipper wears the winner's cockade: one however many wins. */
export function cockadeOf(code: number): boolean {
  return pennantsOf(code) > 0;
}

/** A prize code, for the tests and the developer's own boats. */
export function prizeCode(p: {
  pennants?: readonly number[];
  burgee?: number;
  spoons?: number;
  committee?: boolean;
}): number {
  const pennants = (p.pennants ?? []).slice(0, MOST_PENNANTS);
  let code = pennants.length;
  pennants.forEach((c, i) => {
    code |= (c & ((1 << COLOUR_BITS) - 1)) << (PENNANT_BITS + COLOUR_BITS * i);
  });
  code |= ((p.burgee ?? 0) & 3) << BURGEE_SHIFT;
  code |= (Math.min(p.spoons ?? 0, 3) & 3) << SPOON_SHIFT;
  if (p.committee === true) {
    code |= COMMITTEE_BIT;
  }
  return code >>> 0;
}

/**
 * Where on a boat's model its prizes fly, in its model's frame: its
 * masthead; the foot of its forestay (the stem's head on a boat with no
 * stay); its stern rail; how far apart its spoons hang; and how big its
 * flags are, by its mast's height.
 */
export interface PrizeRig {
  masthead: Vector3;
  stay: Vector3;
  stern: Vector3;
  spread: number;
  scale: number;
}

/** The masthead's height the catalog's flags are sized for, m: the keelboat's. */
const SIZED_FOR = 9.8;

/** How far outside the transom a spoon hangs, m. */
const OFF_TRANSOM = 0.04;

/**
 * A kind's rig for its prizes, from its model's nodes (their places in its
 * frame): the masthead's pennant, the first headsail's tack (or the stem),
 * the stern: just outside the transom's top (the hull's aftmost station),
 * or the stern's node where it stands aft of that or the boat has two
 * hulls (her aft beam); its hull's stations ([along, half beam, sheer
 * height, …], stern first; a boat of two hulls is not pointed at the bow).
 */
export function prizeRig(nodes: ReadonlyMap<string, Vector3>, hull: unknown): PrizeRig {
  const stations = (hull as { solid?: { stations?: number[][] } } | undefined)?.solid?.stations;
  const aft = stations?.[0];
  const fore = stations?.[stations.length - 1];
  const masthead = (nodes.get('pennant') ?? new Vector3(0, SIZED_FOR, 0)).clone();
  const stem = new Vector3(0, fore?.[2] ?? 0.5, fore?.[0] ?? masthead.z - 3);
  const stay = (nodes.get('jib') ?? stem).clone();
  const transom = new Vector3(0, aft?.[2] ?? 0.5, (aft?.[0] ?? masthead.z + 3) + OFF_TRANSOM);
  const node = nodes.get('stern');
  const twoHulls = (fore?.[1] ?? 0) > 0.3;
  const stern = (
    node !== undefined && (twoHulls || node.z > transom.z - OFF_TRANSOM) ? node : transom
  ).clone();
  const scale = Math.min(Math.max(masthead.y / SIZED_FOR, 0.85), 2.4);
  const beam = aft?.[1] ?? 0.5;
  return { masthead, stay, stern, spread: Math.min(Math.max(beam * 0.25, 0.08), 0.35), scale };
}

/** Along the forestay from just under the masthead, where the pennants' heads are: the first, and the step to the next. */
const STRING_FROM = 0.06;
const STRING_STEP = 0.085;
/** Along the backstay from the masthead, where the committee's flag's head is. */
const BACKSTAY_AT = 0.45;
/** How far a spoon swings each way, radians, and how often, Hz. */
const SWING = 0.16;
const SWING_RATE = 0.55;

/** The least wind a boat's flags stream in, m/s. */
const LEAST_WIND = 3;

/** The prizes' draws at most: their flags and their spoons. */
export const PRIZE_FLAGS = 192;
export const PRIZE_SPOONS = 96;

/** What the prizes drew this frame, for the tests. */
export interface PrizesStats {
  boats: number;
  flags: number;
  pennants: number;
  burgees: number;
  committees: number;
  spoons: number;
}

/**
 * A carved wooden spoon on its lanyard, hanging from the origin down the
 * y axis: the cord, then the handle, then the bowl at the bottom, its back
 * to the stern. Its vertices carry the wood's colour, the cord's darker.
 */
export function spoonGeometry(length: number, lanyard: number, wood: string): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  const hex = Number.parseInt(wood.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const woodRgb = [lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255)];
  const cord = [0.05, 0.04, 0.03];
  // A ring of n points about the y axis at height y, radii rx and rz,
  // joined to the ring before it.
  const n = 8;
  let last = -1;
  const ring = (y: number, rx: number, rz: number, c: number[]): void => {
    const at = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pos.push(Math.cos(a) * rx, y, Math.sin(a) * rz);
      col.push(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    }
    if (last >= 0) {
      for (let k = 0; k < n; k++) {
        const a = last + k;
        const b = last + ((k + 1) % n);
        index.push(a, b, at + k, b, at + ((k + 1) % n), at + k);
      }
    }
    last = at;
  };
  const cap = (y: number, c: number[]): void => {
    const at = pos.length / 3;
    pos.push(0, y, 0);
    col.push(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    for (let k = 0; k < n; k++) {
      index.push(at, last + k, last + ((k + 1) % n));
    }
  };
  // The cord, thin; then the handle, a little wider, flattening; then the
  // bowl, a flattened egg.
  ring(0.01, 0.004, 0.004, cord);
  ring(-lanyard, 0.004, 0.004, cord);
  last = -1;
  const top = -lanyard;
  const handle = length * 0.62;
  ring(top, 0.009, 0.006, woodRgb);
  ring(top - handle, 0.007, 0.004, woodRgb);
  const bowl = length - handle;
  const w = length * 0.17;
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    const r = Math.sin(Math.PI * Math.min(t * 0.92 + 0.08, 1));
    ring(top - handle - bowl * t, Math.max(w * r, 0.004), Math.max(w * 0.45 * r, 0.003), woodRgb);
  }
  cap(top - length, woodRgb);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The apparent wind a boat feels, as a wind from (radians clockwise from north) and its speed, m/s, into out. */
export function apparentWind(
  from: number,
  speed: number,
  heading: number,
  way: number,
  out: { from: number; speed: number },
): { from: number; speed: number } {
  // Where the true wind blows to, less the boat's way.
  const e = -speed * Math.sin(from) - way * Math.sin(heading);
  const n = -speed * Math.cos(from) - way * Math.cos(heading);
  out.speed = Math.hypot(e, n);
  out.from = out.speed > 1e-6 ? Math.atan2(-e, -n) : from;
  return out;
}

/**
 * Every boat's prizes in one draw for the flags and one for the spoons:
 * begun each frame, each boat added with its points placed in the scene,
 * ended with the floating origin.
 */
export class PrizesAfloat {
  readonly root = new Group();
  readonly flags: SignalFlags;
  readonly spoons: InstancedMesh;
  readonly stats: PrizesStats = {
    boats: 0,
    flags: 0,
    pennants: 0,
    burgees: 0,
    committees: 0,
    spoons: 0,
  };
  /** The prizes are drawn within this of the camera, m. */
  readonly reach: number;
  readonly #seen: SignalSeen[] = Array.from({ length: PRIZE_FLAGS }, () => ({
    east: 0,
    north: 0,
    top: 0,
    speed: 0,
    from: 0,
    flag: 0,
    seed: 0,
    scale: 1,
  }));
  #n = 0;
  #spoons = 0;
  /** The catalog's flags of each prize, by their indices: the pennants by the races' colours. */
  readonly #pennants: number[] = [];
  readonly #burgee: number;
  readonly #gilded: number;
  readonly #committee: number;
  readonly #hoists: number[];
  readonly #m = new Matrix4();
  readonly #q = new Quaternion();
  readonly #s = new Vector3(1, 1, 1);
  readonly #p = new Vector3();
  readonly #a = new Vector3();
  readonly #b = new Vector3();
  readonly #x = new Vector3(1, 0, 0);
  readonly #z = new Vector3(0, 0, 1);
  readonly #qz = new Quaternion();

  constructor(committee: Committee, townFlags: TownFlags) {
    this.reach = committee.prizes.reach;
    this.flags = new SignalFlags(townFlags, committee.flags, committee.dyes, PRIZE_FLAGS);
    this.flags.mesh.name = 'prize flags';
    committee.flags.forEach((f, i) => {
      if (f.signal === 'victory') {
        this.#pennants.push(i);
      }
    });
    const find = (signal: string): number => committee.flags.findIndex((f) => f.signal === signal);
    this.#burgee = find('burgee');
    this.#gilded = find('gilded');
    this.#committee = find('committee');
    this.#hoists = committee.flags.map((f) => f.hoist);
    const s = committee.prizes.spoon;
    const m = litMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: DoubleSide });
    m.name = 'prize spoons';
    this.spoons = new InstancedMesh(spoonGeometry(s.length, s.lanyard, s.colour), m, PRIZE_SPOONS);
    this.spoons.name = 'prize spoons';
    this.spoons.instanceMatrix.setUsage(DynamicDrawUsage);
    this.spoons.count = 0;
    this.spoons.frustumCulled = false;
    this.spoons.visible = false;
    this.root.name = 'prizes';
    this.root.add(this.flags.mesh, this.spoons);
  }

  /** The flags flown this frame: the first stats.flags. */
  get shown(): readonly SignalSeen[] {
    return this.#seen;
  }

  /** Begins a frame: nothing drawn yet. */
  begin(): void {
    this.#n = 0;
    this.#spoons = 0;
    const s = this.stats;
    s.boats = s.flags = s.pennants = s.burgees = s.committees = s.spoons = 0;
  }

  #flag(
    at: Vector3,
    origin: { x: number; y: number },
    flag: number,
    k: number,
    wind: { from: number; speed: number },
    seed: number,
  ): void {
    if (this.#n >= PRIZE_FLAGS || flag < 0) {
      return;
    }
    const f = this.#seen[this.#n++] as SignalSeen;
    f.east = at.x + origin.x;
    f.north = -at.z + origin.y;
    f.top = at.y;
    // A flag on a boat under way streams in the wind she makes, however light.
    f.speed = Math.max(wind.speed, LEAST_WIND);
    f.from = wind.from;
    f.flag = flag;
    f.seed = seed;
    f.scale = k;
  }

  /**
   * A boat's prizes: its code, its rig, and place, which places a point of
   * its model in the scene as the boat is drawn now; the apparent wind it
   * feels; its own number (for the flags' flutter and its spoons' swing);
   * time, world s; and the floating origin.
   */
  add(
    code: number,
    rig: PrizeRig,
    place: (p: Vector3, out: Vector3) => Vector3,
    wind: { from: number; speed: number },
    seed: number,
    time: number,
    origin: { x: number; y: number },
  ): void {
    if (code === 0) {
      return;
    }
    this.stats.boats++;
    const k = rig.scale;
    const top = place(rig.masthead, this.#a);
    // The burgee: its hoist down to the masthead.
    const burgee = burgeeOf(code);
    if (burgee !== BURGEE.none) {
      const flag = burgee === BURGEE.gilded ? this.#gilded : this.#burgee;
      this.#p.copy(top);
      this.#p.y += ((this.#hoists[flag] ?? 0.3) + 0.04) * k;
      this.#flag(this.#p, origin, flag, k, wind, seed);
      this.stats.burgees++;
    }
    // The pennants down the forestay, the newest highest.
    const n = pennantsOf(code);
    if (n > 0 && this.#pennants.length > 0) {
      const foot = place(rig.stay, this.#b);
      for (let i = 0; i < n; i++) {
        const t = STRING_FROM + STRING_STEP * i;
        this.#p.copy(top).lerp(foot, t);
        const colour = pennantOf(code, i) % this.#pennants.length;
        this.#flag(this.#p, origin, this.#pennants[colour] ?? -1, k, wind, seed + i * 3.1);
        this.stats.pennants++;
      }
    }
    // The committee's flag on the backstay.
    if (committeeOf(code)) {
      const stern = place(rig.stern, this.#b);
      this.#p.copy(top).lerp(stern, BACKSTAY_AT);
      this.#flag(this.#p, origin, this.#committee, k, wind, seed + 17);
      this.stats.committees++;
    }
    // The spoons from the stern rail, plumb, swinging.
    const spoons = spoonsOf(code);
    for (let i = 0; i < spoons && this.#spoons < PRIZE_SPOONS; i++) {
      this.#p.copy(rig.stern);
      this.#p.x += (i - (spoons - 1) / 2) * rig.spread;
      place(this.#p, this.#b);
      const phase = time * SWING_RATE * 2 * Math.PI + seed * 1.7 + i * 2.1;
      this.#q.setFromAxisAngle(this.#x, Math.sin(phase) * SWING);
      this.#qz.setFromAxisAngle(this.#z, Math.sin(phase * 0.71 + 1.3) * SWING * 0.6);
      this.#q.multiply(this.#qz);
      this.#s.setScalar(Math.max(k * 0.9, 0.8));
      this.#m.compose(this.#b, this.#q, this.#s);
      this.spoons.setMatrixAt(this.#spoons++, this.#m);
      this.stats.spoons++;
    }
  }

  /** Ends a frame: the flags and spoons to the GPU; time is world time, s. */
  end(origin: { x: number; y: number }, time: number): void {
    this.flags.frame(this.#seen, origin, time, this.#n);
    this.stats.flags = this.flags.count;
    this.spoons.count = this.#spoons;
    this.spoons.visible = this.#spoons > 0;
    if (this.#spoons > 0) {
      this.spoons.instanceMatrix.needsUpdate = true;
    }
  }
}

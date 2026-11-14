// SPDX-License-Identifier: AGPL-3.0-only

// The race committee's things in the sea, as a race lays them: the
// committee boat at anchor at the starboard end of the line, dressed in
// signal flags, lying head to the wind at her anchor and sheering about it,
// her signals on the halyard; the pin buoy at the line's port end; the
// marks, painted casks with a spar, a flag and their number on a board, a
// lantern lit by night; and the world's beacons, spars with a topmark
// standing where the courses set them on the reefs and bars, known as
// places. The casks and the committee boat ride the sea's surface where
// they float, heaving and leaning with its slope; a beacon stands on the
// bottom.
//
// A course is plain data, laid and dropped by its number: the committee
// boat's place (and her heading, or head to the wind), the pin's, each
// mark's place, number and side, and the flags flying at the halyard.
// Whoever knows of a race lays it (a test, or the race as the server tells
// it); nothing here knows what a race is.
//
// Each kind of thing is one instanced draw of its model (art/committee),
// its parts' colours and finishes in its vertices; the numbers one draw of
// boards; the flags one draw (render/flags.ts); the gun's smoke one draw of
// puffs (render/smoke.ts). Nothing is drawn while nothing is near.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type Side,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  attribute,
  float,
  floor,
  mix,
  select,
  step,
  texture,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Committee, SignalFlag, TownFlags, TownSmoke } from '../catalog/types.gen';
import type { PlaceSeen } from '../net/messages';
import { artUrl } from './boat';
import { digits } from './boatlook';
import { HOIST_GAP, SignalFlags, type SignalSeen } from './flags';
import { type Burst, burstPuff, puffsOf } from './gunsmoke';
import { litMaterial } from './materials';
import { Puffs } from './smoke';

/** A point in the sea, m east and north of the world's centre. */
export interface SeaPoint {
  east: number;
  north: number;
}

/** A mark laid: its place, its number on the course, and the side it is left to: 1 starboard, −1 port, 0 either (a gate's). */
export interface MarkLaid extends SeaPoint {
  number: number;
  side: number;
}

/** The committee boat laid: her place (the line's starboard end), and the heading she lies at, radians clockwise from north; with none she lies head to the wind where she is. */
export interface CommitteeLaid extends SeaPoint {
  heading?: number | null;
}

/**
 * A course as a race lays it in the sea: its committee boat and pin (none
 * for a course with no line of its own here), its marks, and the flags
 * flying at the committee boat's halyard, the catalog's indices, the top
 * one first.
 */
export interface CourseLaid {
  committee: CommitteeLaid | null;
  pin: SeaPoint | null;
  marks: readonly MarkLaid[];
  flags: readonly number[];
}

/** What a frame of the committee's things is drawn from. */
export interface RaceFrame {
  /** The floating origin's place in the world, m. */
  origin: { x: number; y: number };
  cameraEast: number;
  cameraNorth: number;
  /** World time, s. */
  time: number;
  /** How lit the lanterns are, 0 by day to 1 at night; the daylight on the smoke, 0 to 1. */
  lit: number;
  light: number;
  /** The true wind at a point: m/s, and where it comes from, radians clockwise from north. */
  windAt: (east: number, north: number) => { speed: number; from: number };
  /** The sea's surface's height at points (east and north of each in turn), or null for a flat sea. */
  surface: ((points: Float64Array, count: number, out: Float64Array) => void) | null;
}

/** What the tests and the panel read. */
export interface RaceMarksStats {
  loaded: boolean;
  courses: number;
  committees: number;
  marks: number;
  pins: number;
  beacons: number;
  numbers: number;
  flags: number;
  lanterns: number;
  puffs: number;
  bursts: number;
  fired: number;
  draws: number;
  triangles: number;
}

/** The models' root nodes, by what each is. */
const NODES = {
  committee: 'committee-boat',
  mark: 'cask-mark',
  pin: 'pin-buoy',
  beacon: 'beacon-spar',
} as const;
type Kind = keyof typeof NODES;
const KINDS: readonly Kind[] = ['committee', 'mark', 'pin', 'beacon'];
/** Each kind's draw holds at most this many. */
const CAPACITY: Record<Kind, number> = { committee: 8, mark: 64, pin: 8, beacon: 128 };
/** A floating thing leans with this share of the sea's slope; the committee boat pitches and rolls with this share of it. */
const LEAN = 0.6;
const HEAVE = 0.9;
/** Where the committee boat's surface is sampled fore and aft and to either side, m from her middle. */
const BOW_AT = 4;
const SIDE_AT = 1.5;

/** A model's points the draw places things at, from the model's empty nodes, m in its own frame. */
interface Anchors {
  flagStaff: Vector3 | null;
  lantern: Vector3 | null;
  number: Vector3 | null;
  /** How far the number board's faces are from its middle, m. */
  face: number;
  muzzle: Vector3 | null;
  halyard: Vector3 | null;
  ridingLight: Vector3 | null;
}

/** A kind of thing, loaded: its draw, and its anchors. */
interface Drawn {
  mesh: InstancedMesh;
  anchors: Anchors;
  triangles: number;
}

/** The committee boat's muzzle before the model is loaded: forward on her starboard bow, m. */
const MUZZLE_GUESS = new Vector3(0.56, 1.6, -3.5);

/** The index of the catalog's flag that signals this, or −1; for a class, the pennant of the boat of that id. */
export function signalFlag(
  flags: readonly SignalFlag[],
  signal: SignalFlag['signal'],
  boat?: string,
): number {
  return flags.findIndex((f) => f.signal === signal && (boat === undefined || f.boat === boat));
}

/** Merges a model's meshes under root into one geometry: positions and normals in root's frame, each vertex's colour times its material's, and its material's roughness and metalness. */
function mergedGeometry(root: Object3D): { geometry: BufferGeometry; triangles: number } {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const fin: number[] = [];
  const index: number[] = [];
  const m = new Matrix4();
  const n = new Matrix4();
  const v = new Vector3();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) {
      return;
    }
    const g = o.geometry as BufferGeometry;
    const mat = o.material as MeshStandardMaterial;
    m.multiplyMatrices(toRoot, o.matrixWorld);
    n.copy(m).invert().transpose();
    const p = g.getAttribute('position');
    const q = g.getAttribute('normal');
    const c = g.getAttribute('color');
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      v.set(q?.getX(i) ?? 0, q?.getY(i) ?? 1, q?.getZ(i) ?? 0)
        .applyMatrix4(n)
        .normalize();
      nor.push(v.x, v.y, v.z);
      col.push(
        (c?.getX(i) ?? 1) * mat.color.r,
        (c?.getY(i) ?? 1) * mat.color.g,
        (c?.getZ(i) ?? 1) * mat.color.b,
      );
      fin.push(mat.roughness, mat.metalness);
    }
    const idx = g.getIndex();
    if (idx === null) {
      for (let i = 0; i < p.count; i++) {
        index.push(base + i);
      }
    } else {
      for (let i = 0; i < idx.count; i++) {
        index.push(base + idx.getX(i));
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  geometry.setAttribute('finish', new BufferAttribute(new Float32Array(fin), 2));
  geometry.setIndex(index);
  return { geometry, triangles: index.length / 3 };
}

/** The empty nodes under root that the draw places things at, in root's frame. */
function anchorsOf(root: Object3D): Anchors {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  let face = 0.37;
  const find = (name: string): Vector3 | null => {
    let at: Vector3 | null = null;
    root.traverse((o) => {
      // The loader makes names unique with a suffix: a name's start is its own.
      if (at === null && !(o instanceof Mesh) && o !== root && o.name.startsWith(name)) {
        at = new Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(toRoot);
        const f = (o.userData as { face?: unknown }).face;
        if (typeof f === 'number') {
          face = f;
        }
      }
    });
    return at;
  };
  const number = find('number');
  return {
    flagStaff: find('flag-staff'),
    lantern: find('lantern'),
    number,
    face,
    muzzle: find('muzzle'),
    halyard: find('halyard'),
    ridingLight: find('riding-light'),
  };
}

/** A material for a kind's draw: its vertices' colours, roughness and metalness. */
function finishMaterial(side: Side): ReturnType<typeof litMaterial> {
  const m = litMaterial({ vertexColors: true, roughness: 1, metalness: 0, side });
  const f = attribute('finish', 'vec2') as unknown as Node<'vec2'>;
  m.roughnessNode = f.x as unknown as Node<'float'>;
  m.metalnessNode = f.y as unknown as Node<'float'>;
  m.name = 'committee';
  return m;
}

/** The board's number quads drawn at most. */
const NUMBER_CAPACITY = 64;
/** A board's painted face, m square; a digit's height on it, and its width for its height (the digits' cells'). */
const BOARD = 0.62;
const DIGIT = 0.5;
const DIGIT_ASPECT = 64 / 104;

/** The number board's faces: a quad on each of its four sides, face m out, each read from its own side. */
function boardGeometry(face: number): BufferGeometry {
  const h = BOARD / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  // Each side's outward normal, and the way its u runs, read from outside.
  const sides: [number, number, number, number][] = [
    [0, 1, 1, 0],
    [0, -1, -1, 0],
    [1, 0, 0, -1],
    [-1, 0, 0, 1],
  ];
  for (const [nx, nz, ux, uz] of sides) {
    const base = pos.length / 3;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as [number, number][]) {
      const a = (u - 0.5) * 2 * h;
      pos.push(nx * face + ux * a, (v - 0.5) * 2 * h, nz * face + uz * a);
      nor.push(nx, 0, nz);
      uvs.push(u, v);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(index);
  return g;
}

/** The boards' draw: white faces with the mark's number painted on them in black, one or two digits. */
function numberBoards(face: number): { mesh: InstancedMesh; numbers: InstancedBufferAttribute } {
  const g = boardGeometry(face);
  const numbers = new InstancedBufferAttribute(new Float32Array(NUMBER_CAPACITY), 1);
  g.setAttribute('boardNumber', numbers);
  const n = varying(attribute('boardNumber', 'float') as unknown as Node<'float'>);
  const at = uv();
  const count = select(n.greaterThan(9.5), float(2), float(1));
  const dw = DIGIT * DIGIT_ASPECT;
  const x = at.x
    .sub(0.5)
    .mul(BOARD / dw)
    .add(count.mul(0.5));
  const y = at.y
    .sub(0.5)
    .mul(BOARD / DIGIT)
    .add(0.5);
  const k = floor(x);
  const tens = floor(n.add(0.5).div(10));
  const d = select(count.greaterThan(1.5).and(k.lessThan(0.5)), tens, n.sub(tens.mul(10)));
  const inside = step(0, x).mul(step(x, count)).mul(step(0, y)).mul(step(y, 1));
  const ink = texture(digits(), vec2(d.add(x.sub(k)).div(10), y), float(0)).r.mul(inside);
  const m = litMaterial({ roughness: 0.6, metalness: 0, side: FrontSide });
  m.colorNode = mix(vec3(0.82, 0.8, 0.74), vec3(0.03, 0.03, 0.03), ink) as unknown as Node<'vec3'>;
  m.name = 'mark numbers';
  const mesh = new InstancedMesh(g, m, NUMBER_CAPACITY);
  mesh.name = 'mark numbers';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, numbers };
}

/** A fixed number in [0, 1) for an integer: a course's or a thing's own phase. */
function unit(i: number): number {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

export class RaceMarks {
  /** Everything drawn, in the scene: it follows the floating origin by its instances' places. */
  readonly root = new Group();
  readonly flags: SignalFlags;
  readonly smoke: Puffs;
  readonly stats: RaceMarksStats = {
    loaded: false,
    courses: 0,
    committees: 0,
    marks: 0,
    pins: 0,
    beacons: 0,
    numbers: 0,
    flags: 0,
    lanterns: 0,
    puffs: 0,
    bursts: 0,
    fired: 0,
    draws: 0,
    triangles: 0,
  };
  /** The lanterns lit this frame, in the scene: x, y, z each, and how many. */
  readonly lanterns = new Float32Array(3 * 96);
  lanternCount = 0;
  /** Called once the models are loaded (the tests). */
  onLoad: (() => void) | null = null;

  readonly #cat: Committee;
  readonly #beaconKind: number;
  readonly #courses = new Map<number, CourseLaid>();
  readonly #beacons = new Map<number, PlaceSeen>();
  readonly #bursts: Burst[] = [];
  #loading: 'no' | 'loading' | 'done' | 'failed' = 'no';
  readonly #drawn = new Map<Kind, Drawn>();
  #boards: { mesh: InstancedMesh; numbers: InstancedBufferAttribute } | null = null;
  /** Each flag that signals a mark and the pin. */
  readonly #markFlag: number;
  readonly #pinFlag: number;
  /** The committee boats' poses as last drawn, by course: her place in the scene and her turn. */
  readonly #poses = new Map<number, Matrix4>();
  /** The flags flying, reused each frame. */
  readonly #seen: SignalSeen[] = [];
  readonly #points = new Float64Array(2 * 5);
  readonly #heights = new Float64Array(5);
  readonly #counts: Record<Kind, number> = { committee: 0, mark: 0, pin: 0, beacon: 0 };
  readonly #m = new Matrix4();
  readonly #board = new Matrix4();
  readonly #q = new Quaternion();
  readonly #tilt = new Quaternion();
  readonly #e = new Euler(0, 0, 0, 'YXZ');
  readonly #p = new Vector3();
  readonly #s = new Vector3(1, 1, 1);
  readonly #n = new Vector3();
  readonly #v = new Vector3();
  readonly #up = new Vector3(0, 1, 0);
  #time = 0;

  /**
   * The catalog's committee, the flags ashore's rule for how a flag flies,
   * the chimneys' smoke (its draw's), and the index of the kind of place
   * that is a beacon; models false for no models (the unit tests).
   */
  constructor(
    cat: Committee,
    flags: TownFlags,
    smoke: TownSmoke,
    beaconKind: number,
    models = true,
  ) {
    this.#cat = cat;
    this.#loading = models ? 'no' : 'failed';
    this.#beaconKind = beaconKind;
    this.flags = new SignalFlags(flags, cat.flags, cat.dyes);
    this.#markFlag = signalFlag(cat.flags, 'mark');
    this.#pinFlag = signalFlag(cat.flags, 'pin');
    this.smoke = new Puffs(smoke, { colour: [0.86, 0.86, 0.84], strength: 1 });
    this.smoke.mesh.name = 'gun smoke';
    this.root.name = 'committee';
    this.root.add(this.flags.mesh, this.smoke.mesh);
  }

  /** Whether the models are loaded and can be drawn. */
  get loaded(): boolean {
    return this.#loading === 'done';
  }

  /** The courses laid, by number. */
  get courses(): ReadonlyMap<number, CourseLaid> {
    return this.#courses;
  }

  /** Lays a course, or lays it again as it now is. */
  lay(id: number, course: CourseLaid): void {
    this.#courses.set(id, {
      committee: course.committee === null ? null : { ...course.committee },
      pin: course.pin === null ? null : { ...course.pin },
      marks: course.marks.map((m) => ({ ...m })),
      flags: [...course.flags],
    });
    this.#load();
  }

  /** Takes a course up: its boat, pin and marks go, and its smoke drifts on. */
  drop(id: number): void {
    this.#courses.delete(id);
    this.#poses.delete(id);
  }

  /** The flags a course's committee boat flies now, the top one first. */
  signals(id: number, flags: readonly number[]): void {
    const c = this.#courses.get(id);
    if (c !== undefined) {
      this.#courses.set(id, { ...c, flags: [...flags] });
    }
  }

  /**
   * Fires a course's gun at world time s: a report as loud as loud (1 for a
   * signal); its smoke from the muzzle. The muzzle's place in the world,
   * or null for a course without a committee boat.
   */
  fire(id: number, loud: number, time: number): SeaPoint | null {
    const c = this.#courses.get(id)?.committee;
    if (c === undefined || c === null) {
      return null;
    }
    const pose = this.#poses.get(id);
    const muzzle = this.#drawn.get('committee')?.anchors.muzzle ?? MUZZLE_GUESS;
    const at = this.#v.copy(muzzle);
    let east: number;
    let north: number;
    let up: number;
    let wayE: number;
    let wayN: number;
    if (pose !== undefined) {
      at.applyMatrix4(pose);
      east = at.x + this.#originX;
      north = -at.z + this.#originY;
      up = at.y;
      // The muzzle points to her starboard: her x axis, in the world.
      const ax = this.#n.set(1, 0, 0).transformDirection(pose);
      const l = Math.hypot(ax.x, ax.z) || 1;
      wayE = ax.x / l;
      wayN = -ax.z / l;
    } else {
      const h = c.heading ?? 0;
      east = c.east + Math.cos(h) * muzzle.x - Math.sin(h) * muzzle.z;
      north = c.north - Math.sin(h) * muzzle.x - Math.cos(h) * muzzle.z;
      up = muzzle.y;
      wayE = Math.cos(h);
      wayN = -Math.sin(h);
    }
    this.#bursts.push({
      east,
      north,
      up,
      wayEast: wayE,
      wayNorth: wayN,
      at: time,
      loud,
      seed: id * 31 + this.stats.fired * 7 + 1,
    });
    this.stats.fired++;
    return { east, north };
  }

  /** Places handed with their chunks: the beacons among them are kept. */
  setPlaces(places: readonly PlaceSeen[]): void {
    for (const p of places) {
      if (p.kind === this.#beaconKind && !this.#beacons.has(p.number)) {
        this.#beacons.set(p.number, { ...p });
      }
    }
    if (this.#beacons.size > 0) {
      this.#load();
    }
  }

  /** Forgets every course, beacon and burst: a new world. */
  clear(): void {
    this.#courses.clear();
    this.#beacons.clear();
    this.#poses.clear();
    this.#bursts.length = 0;
  }

  /** The beacons known, by number. */
  get beacons(): ReadonlyMap<number, PlaceSeen> {
    return this.#beacons;
  }

  #originX = 0;
  #originY = 0;

  /** Places everything near the camera for this frame. */
  frame(f: RaceFrame): void {
    this.#time = f.time;
    this.#originX = f.origin.x;
    this.#originY = f.origin.y;
    this.lanternCount = 0;
    this.#seen.length = 0;
    const st = this.stats;
    st.courses = this.#courses.size;
    const counts = this.#counts;
    counts.committee = 0;
    counts.mark = 0;
    counts.pin = 0;
    counts.beacon = 0;
    let numbers = 0;
    const reach2 = this.#cat.reach * this.#cat.reach;
    const near = (p: SeaPoint): boolean =>
      (p.east - f.cameraEast) ** 2 + (p.north - f.cameraNorth) ** 2 <= reach2;
    if (this.loaded) {
      for (const [id, c] of this.#courses) {
        const k = c.committee;
        if (k !== null && near(k)) {
          this.#committee(id, k, c.flags, counts, f);
        } else {
          this.#poses.delete(id);
        }
        if (c.pin !== null && near(c.pin)) {
          this.#float('pin', c.pin, counts, f, this.#pinFlag, -1);
        }
        for (const mk of c.marks) {
          if (near(mk)) {
            const at = this.#float('mark', mk, counts, f, this.#markFlag, mk.number);
            if (at !== null && numbers < NUMBER_CAPACITY && this.#boards !== null) {
              this.#boards.mesh.setMatrixAt(numbers, at);
              (this.#boards.numbers.array as Float32Array)[numbers] = mk.number;
              numbers++;
            }
          }
        }
      }
      for (const b of this.#beacons.values()) {
        if (near(b)) {
          this.#beacon(b, counts, f);
        }
      }
    }
    let draws = 0;
    let triangles = 0;
    for (const kind of KINDS) {
      const d = this.#drawn.get(kind);
      if (d === undefined) {
        continue;
      }
      d.mesh.count = counts[kind];
      d.mesh.visible = counts[kind] > 0;
      if (counts[kind] > 0) {
        d.mesh.instanceMatrix.needsUpdate = true;
      }
      if (counts[kind] > 0) {
        draws++;
        triangles += d.triangles * counts[kind];
      }
    }
    if (this.#boards !== null) {
      const b = this.#boards;
      b.mesh.count = numbers;
      b.mesh.visible = numbers > 0;
      if (numbers > 0) {
        b.mesh.instanceMatrix.needsUpdate = true;
        b.numbers.needsUpdate = true;
      }
      if (numbers > 0) {
        draws++;
        triangles += 8 * numbers;
      }
    }
    this.flags.frame(this.#seen, f.origin, f.time);
    if (this.flags.count > 0) {
      draws++;
    }
    this.#drawSmoke(f);
    if (this.smoke.count > 0) {
      draws++;
    }
    st.committees = counts.committee;
    st.marks = counts.mark;
    st.pins = counts.pin;
    st.beacons = counts.beacon;
    st.numbers = numbers;
    st.flags = this.flags.count;
    st.lanterns = this.lanternCount;
    st.puffs = this.smoke.count;
    st.bursts = this.#bursts.length;
    st.draws = draws;
    st.triangles = triangles;
  }

  /** The sea's height at n points written to #points, or zeros on a flat sea. */
  #sample(f: RaceFrame, n: number): Float64Array {
    const h = this.#heights;
    if (f.surface === null) {
      h.fill(0);
    } else {
      f.surface(this.#points, n, h);
    }
    return h;
  }

  /** The committee boat of course id: placed, her flags hoisted, her riding light. */
  #committee(
    id: number,
    k: CommitteeLaid,
    flags: readonly number[],
    counts: Record<Kind, number>,
    f: RaceFrame,
  ): void {
    const d = this.#drawn.get('committee');
    if (d === undefined || counts.committee >= CAPACITY.committee) {
      return;
    }
    const wind = f.windAt(k.east, k.north);
    const b = this.#cat.boat;
    const swing =
      ((b.sheer * Math.PI) / 180) *
      Math.sin((2 * Math.PI * f.time) / b.period + 2 * Math.PI * unit(id));
    const heading = (k.heading ?? wind.from) + swing;
    // The sea under her bow, stern and sides.
    const fe = Math.sin(heading);
    const fn = Math.cos(heading);
    const pts = this.#points;
    const put = (i: number, along: number, across: number): void => {
      pts[2 * i] = k.east + fe * along + fn * across;
      pts[2 * i + 1] = k.north + fn * along - fe * across;
    };
    put(0, 0, 0);
    put(1, BOW_AT, 0);
    put(2, -BOW_AT, 0);
    put(3, 0, SIDE_AT);
    put(4, 0, -SIDE_AT);
    const h = this.#sample(f, 5);
    const heave = (((h[0] ?? 0) + (h[1] ?? 0) + (h[2] ?? 0)) / 3) * HEAVE;
    const pitch = Math.atan2((h[1] ?? 0) - (h[2] ?? 0), 2 * BOW_AT) * LEAN;
    const roll = Math.atan2((h[3] ?? 0) - (h[4] ?? 0), 2 * SIDE_AT) * LEAN;
    this.#e.set(pitch, -heading, roll, 'YXZ');
    this.#q.setFromEuler(this.#e);
    this.#p.set(k.east - f.origin.x, heave, -(k.north - f.origin.y));
    const m = this.#m.compose(this.#p, this.#q, this.#s);
    d.mesh.setMatrixAt(counts.committee, m);
    counts.committee++;
    let pose = this.#poses.get(id);
    if (pose === undefined) {
      pose = new Matrix4();
      this.#poses.set(id, pose);
    }
    pose.copy(m);
    // Her signals, one under another from the halyard's block.
    const a = d.anchors;
    if (a.halyard !== null) {
      const v = this.#v.copy(a.halyard).applyMatrix4(m);
      let top = v.y;
      for (const flag of flags) {
        const design = this.flags.designs[flag];
        if (design === undefined) {
          continue;
        }
        this.#seen.push({
          east: v.x + f.origin.x,
          north: -v.z + f.origin.y,
          top,
          speed: wind.speed,
          from: wind.from,
          flag,
          seed: id * 7 + flag,
        });
        top -= design.hoist + HOIST_GAP;
      }
    }
    if (a.ridingLight !== null) {
      this.#lantern(this.#v.copy(a.ridingLight).applyMatrix4(m), f.lit);
    }
  }

  /** A cask afloat at p, leaning with the sea, its board across the wind: its flag and lantern; the board's matrix for a mark, null otherwise. */
  #float(
    kind: 'mark' | 'pin',
    p: SeaPoint,
    counts: Record<Kind, number>,
    f: RaceFrame,
    flag: number,
    seed: number,
  ): Matrix4 | null {
    const d = this.#drawn.get(kind);
    if (d === undefined || counts[kind] >= CAPACITY[kind]) {
      return null;
    }
    const wind = f.windAt(p.east, p.north);
    const pts = this.#points;
    pts[0] = p.east;
    pts[1] = p.north;
    pts[2] = p.east + 1;
    pts[3] = p.north;
    pts[4] = p.east;
    pts[5] = p.north + 1;
    const h = this.#sample(f, 3);
    const h0 = h[0] ?? 0;
    const se = (h[1] ?? 0) - h0;
    const sn = (h[2] ?? 0) - h0;
    // Upright on a flat sea; leaning toward the surface's normal on a slope.
    this.#n.set(-se * LEAN, 1, sn * LEAN).normalize();
    this.#tilt.setFromUnitVectors(this.#up, this.#n);
    this.#q.setFromAxisAngle(this.#up, -wind.from);
    this.#q.premultiply(this.#tilt);
    this.#p.set(p.east - f.origin.x, h0 * HEAVE, -(p.north - f.origin.y));
    const m = this.#m.compose(this.#p, this.#q, this.#s);
    d.mesh.setMatrixAt(counts[kind], m);
    counts[kind]++;
    const a = d.anchors;
    if (a.flagStaff !== null && flag >= 0) {
      const v = this.#v.copy(a.flagStaff).applyMatrix4(m);
      this.#seen.push({
        east: v.x + f.origin.x,
        north: -v.z + f.origin.y,
        top: v.y,
        speed: wind.speed,
        from: wind.from,
        flag,
        seed: seed * 13 + kind.length,
      });
    }
    if (a.lantern !== null) {
      this.#lantern(this.#v.copy(a.lantern).applyMatrix4(m), f.lit);
    }
    if (kind === 'mark' && a.number !== null) {
      this.#p.copy(a.number).applyMatrix4(m);
      return this.#board.copy(m).setPosition(this.#p);
    }
    return null;
  }

  /** A beacon standing on the bottom at its place. */
  #beacon(b: PlaceSeen, counts: Record<Kind, number>, f: RaceFrame): void {
    const d = this.#drawn.get('beacon');
    if (d === undefined || counts.beacon >= CAPACITY.beacon) {
      return;
    }
    this.#q.setFromAxisAngle(this.#up, -b.heading);
    this.#p.set(b.east - f.origin.x, 0, -(b.north - f.origin.y));
    d.mesh.setMatrixAt(counts.beacon, this.#m.compose(this.#p, this.#q, this.#s));
    counts.beacon++;
  }

  /** A lantern lit at v, in the scene, if it is night. */
  #lantern(v: Vector3, lit: number): void {
    const i = this.lanternCount;
    if (lit <= 0 || 3 * (i + 1) > this.lanterns.length) {
      return;
    }
    this.lanterns[3 * i] = v.x;
    this.lanterns[3 * i + 1] = v.y;
    this.lanterns[3 * i + 2] = v.z;
    this.lanternCount++;
  }

  /** The bursts' puffs near the camera; each burst forgotten once its smoke has faded. */
  #drawSmoke(f: RaceFrame): void {
    const g = this.#cat.gun;
    const puffs = this.smoke;
    puffs.begin(f.light);
    const reach2 = g.reach * g.reach;
    for (let i = this.#bursts.length - 1; i >= 0; i--) {
      const b = this.#bursts[i] as Burst;
      const age = f.time - b.at;
      // Gone once faded; and if the world's time went back past it (a test's reset).
      if (age > g.life || age < -1) {
        this.#bursts.splice(i, 1);
      }
    }
    for (const b of this.#bursts) {
      const age = f.time - b.at;
      if ((b.east - f.cameraEast) ** 2 + (b.north - f.cameraNorth) ** 2 > reach2) {
        continue;
      }
      const wind = f.windAt(b.east, b.north);
      const n = puffsOf(g, b.loud);
      for (let k = 0; k < n; k++) {
        const p = burstPuff(g, b, k, age, wind.speed, wind.from);
        if (p === null) {
          continue;
        }
        puffs.put(
          b.east + p.east - f.origin.x,
          b.up + p.up,
          -(b.north + p.north - f.origin.y),
          p.width,
          p.thick,
          1 - 0.12 * (age / g.life),
        );
      }
    }
    puffs.end();
  }

  /** Loads the models, once, when a course is first laid or a beacon first known. */
  #load(): void {
    if (this.#loading !== 'no') {
      return;
    }
    this.#loading = 'loading';
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader
      .loadAsync(artUrl(this.#cat.art.model))
      .then((gltf) => {
        const solid = finishMaterial(FrontSide);
        const twoSided = finishMaterial(DoubleSide);
        for (const kind of KINDS) {
          const node = gltf.scene.getObjectByName(NODES[kind]);
          if (node === undefined) {
            continue;
          }
          const { geometry, triangles } = mergedGeometry(node);
          // The committee boat's bunting is seen from both sides.
          const mesh = new InstancedMesh(
            geometry,
            kind === 'committee' ? twoSided : solid,
            CAPACITY[kind],
          );
          mesh.name = `committee ${NODES[kind]}`;
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false;
          this.root.add(mesh);
          this.#drawn.set(kind, { mesh, anchors: anchorsOf(node), triangles });
        }
        this.#boards = numberBoards(this.#drawn.get('mark')?.anchors.face ?? 0.37);
        this.root.add(this.#boards.mesh);
        this.#loading = 'done';
        this.stats.loaded = true;
        this.onLoad?.();
      })
      .catch((e: unknown) => {
        this.#loading = 'failed';
        console.error('the committee did not load', e);
      });
  }

  /** World time as last drawn, s. */
  get time(): number {
    return this.#time;
  }
}

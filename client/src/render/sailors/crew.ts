// SPDX-License-Identifier: AGPL-3.0-only

// The people aboard the boat in view, besides whoever holds the controls
// (the boat's own sailor, at the helm: onboat.ts): each at the station of
// its kind (the catalog's `stations`) its seat gives, standing or seated,
// in its own look. Whoever holds the controls is at station 0; the
// skipper, while someone else holds them, at that one's own station;
// everyone else at the station of their seat.
//
// Forty stand on a tall ship, so they are drawn cheaply: each figure posed
// once, still, and drawn rigid, every person of a level in one draw. The
// nearest few within NEAR_RANGE of the camera are their looks' deck level,
// skinned once on the CPU in the station's pose (the clips' helm seated,
// standing-idle standing); the rest are their looks' far level, made seated
// at the helm, stood up for a standing station by the deck level's bones
// (each vertex goes with those of the deck level's vertex nearest it).
//
// Each level's figures are triangle lists in a float texture, its pool, two
// texels a vertex (place and u, normal and v), in the station's frame
// (facing +z, the origin the station's point). A level is one instanced
// mesh of as many vertices as its largest figure: each instance takes its
// person's values (where, which figure, the colours) and each vertex its
// figure's vertex from the pool, the vertices past its figure's end folded
// to a point. The looks' atlases and masks are the fleet's layers
// (fleetlooks.ts), so every look draws in one material.
//
// The group is a child of the boat's model: the people heel, pitch and
// heave with it. Allocation-free from frame to frame once each figure is
// posed.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  type Object3D,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three';
import {
  cos,
  Fn,
  float,
  instancedDynamicBufferAttribute,
  int,
  ivec2,
  modelWorldMatrix,
  normalLocal,
  select,
  sin,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { BoatStation } from '../../catalog';
import type { SailorLook } from '../boat';
import { Pose } from './clips';
import type { FleetLook, FleetLooks, FleetSeat } from './fleetlooks';
import { sailorMaterial } from './material';
import { Rig } from './rig';
import { CLIPS } from './runtime';

/** Someone aboard, as the crew drawn needs them: their seat and look code. */
export interface CrewPerson {
  seat: number;
  look: number;
}

/** Who is aboard, the skipper (seat 0) first, and the seat of whoever holds the controls. */
export interface CrewShown {
  people: readonly CrewPerson[];
  holder: number;
}

/** A person drawn at a station: the station's index, and their look code. */
export interface CrewPlace {
  station: number;
  look: number;
}

/**
 * Where each person aboard is drawn, but whoever holds the controls (at
 * the helm, the boat's own sailor): the skipper, while another holds them,
 * at that one's station; everyone else at their seat's. A seat past the
 * stations is not drawn.
 */
export function crewPlaces(crew: CrewShown, stations: number): CrewPlace[] {
  const out: CrewPlace[] = [];
  for (const p of crew.people) {
    if (p.seat === crew.holder) {
      continue;
    }
    const station = p.seat === 0 ? crew.holder : p.seat;
    if (station > 0 && station < stations) {
      out.push({ station, look: p.look });
    }
  }
  return out;
}

/** The look whoever holds the controls is drawn in at the helm; null if none aboard holds them. */
export function helmLook(crew: CrewShown): number | null {
  return crew.people.find((p) => p.seat === crew.holder)?.look ?? null;
}

/** The nearest this many within this of the camera, metres, are drawn at the deck level: the fleet's full models' few and range. */
export const NEAR_MOST = 12;
export const NEAR_RANGE = 60;
/** The most figures kept in the far level's pool before it is emptied for those drawn: one for each look and pose of the most aboard. */
const FAR_FIGURES = 40;
/** A standing station's far figure, seated till its look's clips load: its seat this high over the deck and this far behind the station (its knees at it), as the fleet's helmsman's at a wheel. */
const STAND_SEAT_UP = 0.75;
const STAND_SEAT_BACK = 0.5;
/** The pool's width, texels. */
const POOL_WIDTH = 2048;
/** Floats a vertex in a figure: place and u, normal and v. */
const STRIDE = 8;
/** A person's values, in fours: place and turn; figure; main, skin and hair colours. */
const ROW = 5;
/** The most triangles of a deck and a far figure (the build's budgets). */
const DECK_TRIANGLES = 3300;
const FAR_TRIANGLES = 300;
/** A machine's lamps, steady: the fleet's pulse at its middle. */
const LAMPS = 0.86;

const m = new Matrix4();
const m2 = new Matrix4();
const v = new Vector3();
const n = new Vector3();

/** Each bone's matrix (column-major, sixteen a bone) from a look's deck level's bind to a clip's pose at t seconds; null without the clip. */
function boneMatrices(look: FleetLook, clip: string, t: number): Float32Array | null {
  const deck = look.deck;
  const c = look.clips?.get(clip);
  if (deck === null || c === undefined) {
    return null;
  }
  const r = deck.rig;
  const rig = new Rig(r.names, r.parent, r.restPos, r.restQuat);
  rig.base.copy(r.base);
  const pose = new Pose(rig.names.length).rest(rig);
  c.sample(t, pose);
  pose.to(rig);
  rig.fk();
  const bones = new Float32Array(16 * rig.names.length);
  for (let j = 0; j < rig.names.length; j++) {
    m.fromArray(rig.world, 16 * j).multiply(m2.fromArray(deck.inverse, 16 * j));
    m.toArray(bones, 16 * j);
  }
  return bones;
}

/** Where the seat is under a figure seated by a clip, in the figure's space: the clips' boat's seat, by the clip's place. */
function seatUnder(look: FleetLook, clip: string, seat: FleetSeat): Vector3 {
  const origin = new Vector3(seat.out, seat.y, seat.z);
  const place = look.clips?.get(clip)?.place ?? null;
  return place === null ? origin : origin.applyMatrix4(m.copy(place).invert());
}

/**
 * A point and its normal (x, y, z each) blended by bones' matrices (e,
 * sixteen a bone) as a skin is, by four bones and their weights; into out
 * at o, the point less origin.
 */
function blend(
  e: Float32Array,
  p: Vector3,
  nm: Vector3,
  bones: (k: number) => number,
  weights: (k: number) => number,
  origin: Vector3,
  out: Float32Array,
  o: number,
): void {
  v.set(0, 0, 0);
  n.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const w = weights(k);
    if (w <= 0) {
      continue;
    }
    const b = 16 * bones(k);
    const at = (i: number): number => e[b + i] as number;
    v.x += w * (at(0) * p.x + at(4) * p.y + at(8) * p.z + at(12));
    v.y += w * (at(1) * p.x + at(5) * p.y + at(9) * p.z + at(13));
    v.z += w * (at(2) * p.x + at(6) * p.y + at(10) * p.z + at(14));
    n.x += w * (at(0) * nm.x + at(4) * nm.y + at(8) * nm.z);
    n.y += w * (at(1) * nm.x + at(5) * nm.y + at(9) * nm.z);
    n.z += w * (at(2) * nm.x + at(6) * nm.y + at(10) * nm.z);
  }
  n.normalize();
  out[o] = v.x - origin.x;
  out[o + 1] = v.y - origin.y;
  out[o + 2] = v.z - origin.z;
  out[o + 3] = n.x;
  out[o + 4] = n.y;
  out[o + 5] = n.z;
}

/** A look's deck level's vertices in a clip's pose, six floats each (place less origin, normal). */
function skinDeck(look: FleetLook, bones: Float32Array, origin: Vector3): Float32Array {
  const g = (look.deck as NonNullable<FleetLook['deck']>).geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const out = new Float32Array(6 * pos.count);
  const p = new Vector3();
  const nm = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    blend(
      bones,
      p.fromBufferAttribute(pos, i),
      nm.fromBufferAttribute(nor, i),
      (k) => Math.round(si.getComponent(i, k)),
      (k) => sw.getComponent(i, k),
      origin,
      out,
      6 * i,
    );
  }
  return out;
}

/**
 * A look's deck level posed for a station, as a triangle list in the
 * station's frame: standing, the clips' standing-idle at its start, the
 * figure's own (facing +z, the ground between its feet at the origin);
 * seated, the clips' helm, moved so that its seat (the clips' boat's seat
 * under it) is at the origin. Null until the look's clips have loaded.
 */
export function poseDeck(look: FleetLook, seated: boolean, seat: FleetSeat): Float32Array | null {
  const clip = seated ? CLIPS.helm : CLIPS.standing;
  const bones = boneMatrices(look, clip, 0);
  if (bones === null || look.deck === null) {
    return null;
  }
  const skinned = skinDeck(look, bones, seated ? seatUnder(look, clip, seat) : new Vector3());
  const uv = look.deck.geometry.getAttribute('uv');
  return triangles(look.deck.geometry, (i, out, o) => {
    for (let k = 0; k < 3; k++) {
      out[o + k] = skinned[6 * i + k] as number;
      out[o + 4 + k] = skinned[6 * i + 3 + k] as number;
    }
    out[o + 3] = uv.getX(i);
    out[o + 7] = uv.getY(i);
  });
}

/**
 * A look's far figure posed for a station, as a triangle list in the
 * station's frame (the fleet's far figure is seated at the helm, facing
 * +x): seated, turned to face +z, its seat at the origin. Standing, each
 * of its vertices takes the bones and weights of the deck level's vertex
 * nearest it seated at the helm, and goes with them from the helm to
 * standing-idle, as the deck level does; until the look's clips have
 * loaded, null.
 */
export function poseFar(look: FleetLook, seated: boolean, seat: FleetSeat): Float32Array | null {
  const g = look.far;
  if (g === null) {
    return null;
  }
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  // Turned a quarter round: +x becomes +z.
  const out = triangles(g, (i, f, o) => {
    f[o] = -pos.getZ(i);
    f[o + 1] = pos.getY(i);
    f[o + 2] = pos.getX(i);
    f[o + 3] = uv.getX(i);
    f[o + 4] = -nor.getZ(i);
    f[o + 5] = nor.getY(i);
    f[o + 6] = nor.getX(i);
    f[o + 7] = uv.getY(i);
  });
  if (seated) {
    return out;
  }
  const helm = boneMatrices(look, CLIPS.helm, 0);
  const stand = boneMatrices(look, CLIPS.standing, 0);
  if (helm === null || stand === null || look.deck === null) {
    return null;
  }
  const origin = seatUnder(look, CLIPS.helm, seat);
  const seatedDeck = skinDeck(look, helm, origin);
  // Each bone from seated at the helm (in the station's frame) to standing.
  const to = new Float32Array(helm.length);
  const back = new Matrix4().makeTranslation(origin.x, origin.y, origin.z);
  for (let b = 0; b < helm.length; b += 16) {
    m.fromArray(stand, b).multiply(m2.fromArray(helm, b).invert()).multiply(back);
    m.toArray(to, b);
  }
  const deck = look.deck.geometry;
  const si = deck.getAttribute('skinIndex');
  const sw = deck.getAttribute('skinWeight');
  const count = seatedDeck.length / 6;
  const p = new Vector3();
  const nm = new Vector3();
  const moved = new Float32Array(6);
  const none = new Vector3();
  for (let o = 0; o < out.length; o += STRIDE) {
    p.set(out[o] as number, out[o + 1] as number, out[o + 2] as number);
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const dx = (seatedDeck[6 * i] as number) - p.x;
      const dy = (seatedDeck[6 * i + 1] as number) - p.y;
      const dz = (seatedDeck[6 * i + 2] as number) - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    nm.set(out[o + 4] as number, out[o + 5] as number, out[o + 6] as number);
    blend(
      to,
      p,
      nm,
      (k) => Math.round(si.getComponent(nearest, k)),
      (k) => sw.getComponent(nearest, k),
      none,
      moved,
      0,
    );
    out[o] = moved[0] as number;
    out[o + 1] = moved[1] as number;
    out[o + 2] = moved[2] as number;
    out[o + 4] = moved[3] as number;
    out[o + 5] = moved[4] as number;
    out[o + 6] = moved[5] as number;
  }
  // Its soles on the deck: the far figure's feet are coarser than the deck level's.
  let low = Number.POSITIVE_INFINITY;
  for (let o = 1; o < out.length; o += STRIDE) {
    low = Math.min(low, out[o] as number);
  }
  for (let o = 1; o < out.length; o += STRIDE) {
    out[o] = (out[o] as number) - low;
  }
  return out;
}

/** A geometry's triangles, each corner written by vertex. */
function triangles(
  g: BufferGeometry,
  vertex: (i: number, out: Float32Array, o: number) => void,
): Float32Array {
  const index = g.index;
  const corners = index === null ? g.getAttribute('position').count : index.count;
  const out = new Float32Array(STRIDE * corners);
  for (let c = 0; c < corners; c++) {
    vertex(index === null ? c : index.getX(c), out, STRIDE * c);
  }
  return out;
}

/** Where a figure lies in a pool, in vertices. */
interface Placed {
  offset: number;
  count: number;
}

/** A float texture of figures, two texels a vertex, grown as figures are added. */
class Pool {
  texture: DataTexture;
  #data: Float32Array;
  #used = 0;
  readonly placed = new Map<string, Placed>();
  /** Told the new texture when it grows. */
  readonly users: { value: Texture }[] = [];

  constructor(
    readonly name: string,
    /** The most vertices it keeps before it is emptied for those wanted. */
    readonly most: number,
  ) {
    this.#data = new Float32Array(0);
    this.texture = this.#make(16);
  }

  #make(rows: number): DataTexture {
    const data = new Float32Array(4 * POOL_WIDTH * rows);
    data.set(this.#data.subarray(0, Math.min(this.#data.length, data.length)));
    this.#data = data;
    const t = new DataTexture(data, POOL_WIDTH, rows, RGBAFormat, FloatType);
    t.name = this.name;
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Puts the figures of the keys not yet in the pool into it; if they do not
   * fit, empties it first, keeping only those keys'.
   */
  add(keys: readonly string[], figure: (key: string) => Float32Array): void {
    const missing = keys.filter((k) => !this.placed.has(k));
    if (missing.length === 0) {
      return;
    }
    const size = (k: string): number => figure(k).length / STRIDE;
    let more = 0;
    for (const k of missing) {
      more += size(k);
    }
    if (this.#used + more > this.most) {
      this.placed.clear();
      this.#used = 0;
      for (const k of keys) {
        this.#put(k, figure(k));
      }
    } else {
      for (const k of missing) {
        this.#put(k, figure(k));
      }
    }
    this.texture.needsUpdate = true;
  }

  #put(key: string, f: Float32Array): void {
    const count = f.length / STRIDE;
    const need = Math.ceil((2 * (this.#used + count)) / POOL_WIDTH);
    if (need > this.texture.image.height) {
      let rows = this.texture.image.height;
      while (rows < need) {
        rows *= 2;
      }
      const old = this.texture;
      this.texture = this.#make(rows);
      for (const u of this.users) {
        u.value = this.texture;
      }
      old.dispose();
    }
    this.#data.set(f, 4 * 2 * this.#used);
    this.placed.set(key, { offset: this.#used, count });
    this.#used += count;
  }
}

/** One level of the crew: its pool, its people's rows and its mesh. */
class Level {
  readonly pool: Pool;
  /** Each person's values, ROW vec4s an instance, which the vertex stage steps by instance. */
  readonly rows: InstancedInterleavedBuffer;
  readonly data: Float32Array;
  readonly mesh: InstancedMesh;
  count = 0;

  constructor(
    readonly name: string,
    capacity: number,
    vertices: number,
    figures: number,
    looks: FleetLooks,
  ) {
    this.pool = new Pool(`crew ${name} figures`, vertices * figures);
    this.data = new Float32Array(4 * ROW * capacity);
    // The mesh's geometry is never freed (three.js frees an instanced
    // buffer with the geometry drawn with it): its people's values can be
    // instanced attributes, not rows of a texture each vertex reads.
    this.rows = new InstancedInterleavedBuffer(this.data, 4 * ROW, 1);
    this.rows.setUsage(DynamicDrawUsage);
    const nodes = crewNodes(this.pool, this.rows);
    const material = sailorMaterial(looks.atlas.texture as Texture, looks.mask.texture as Texture, {
      vertex: nodes.vertex,
      uv: nodes.uv,
      normal: nodes.normal,
      glow: float(LAMPS) as unknown as Node<'float'>,
      instance: { ...nodes, users: { atlas: looks.atlas.users, mask: looks.mask.users } },
    });
    material.name = `crew ${name}`;
    // Only as many vertices as the largest figure; each instance draws its own.
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(3 * vertices), 3));
    // Read by nothing but the material's default normal, which the vertex node replaces.
    g.setAttribute('normal', new BufferAttribute(new Float32Array(3 * vertices), 3));
    this.mesh = new InstancedMesh(g, material, capacity);
    this.mesh.name = `crew ${name}`;
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Placed by its vertex node: the instance matrices stay the identity.
    this.mesh.frustumCulled = false;
  }

  /** Row r: where the person stands, which figure, and their colours. */
  write(
    r: number,
    at: readonly number[],
    turn: number,
    figure: Placed,
    lift: number,
    back: number,
    colours: { main: Color; skin: Color; hair: Color },
    layer: number,
    machine: boolean,
  ): void {
    const d = this.data;
    const o = 4 * ROW * r;
    d[o] = at[0] as number;
    d[o + 1] = at[1] as number;
    d[o + 2] = at[2] as number;
    d[o + 3] = turn;
    d[o + 4] = figure.offset;
    d[o + 5] = figure.count;
    d[o + 6] = lift;
    d[o + 7] = back;
    const { main, skin, hair } = colours;
    d[o + 8] = main.r;
    d[o + 9] = main.g;
    d[o + 10] = main.b;
    d[o + 11] = layer;
    d[o + 12] = skin.r;
    d[o + 13] = skin.g;
    d[o + 14] = skin.b;
    d[o + 15] = machine ? 1 : 0;
    d[o + 16] = hair.r;
    d[o + 17] = hair.g;
    d[o + 18] = hair.b;
    d[o + 19] = 0;
  }

  /** count people written, of the figures of keys: each runs as many vertices as the largest. */
  commit(count: number, keys: readonly string[]): void {
    let most = 0;
    for (const k of keys) {
      most = Math.max(most, this.pool.placed.get(k)?.count ?? 0);
    }
    this.mesh.geometry.setDrawRange(0, most);
    this.count = count;
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.rows.needsUpdate = true;
  }
}

/** A level's vertex and per-instance values, as nodes. */
function crewNodes(
  pool: Pool,
  rows: InstancedInterleavedBuffer,
): {
  vertex: Node<'vec3'>;
  uv: Node<'vec2'>;
  normal: Node<'vec3'>;
  main: Node<'vec3'>;
  skin: Node<'vec3'>;
  hair: Node<'vec3'>;
  machine: Node<'float'>;
  layer: Node<'float'>;
} {
  const figures = texture(pool.texture);
  pool.users.push(figures);
  const row = (k: number): Node<'vec4'> =>
    instancedDynamicBufferAttribute(rows, 'vec4', 4 * ROW, 4 * k) as unknown as Node<'vec4'>;
  const place = row(0);
  const figure = row(1);
  const main = row(2);
  const skin = row(3);
  const hair = row(4);
  const vi = int(vertexIndex);
  const k = int(figure.x).add(vi).mul(2);
  const y = k.div(POOL_WIDTH);
  const a = figures.load(ivec2(k.sub(y.mul(POOL_WIDTH)), y));
  const k1 = k.add(1);
  const y1 = k1.div(POOL_WIDTH);
  const b = figures.load(ivec2(k1.sub(y1.mul(POOL_WIDTH)), y1));
  const c = cos(place.w);
  const s = sin(place.w);
  const normal = vec3(b.x.mul(c).add(b.z.mul(s)), b.y, b.z.mul(c).sub(b.x.mul(s)));
  const vertex = Fn(() => {
    const p = vec3(a.x, a.y.add(figure.z), a.z.sub(figure.w));
    const turned = vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s)));
    normalLocal.assign(normal);
    // Past its figure's end, folded to a point.
    return select(vi.lessThan(int(figure.y)), turned.add(place.xyz), vec3(0, 0, 0));
  })() as unknown as Node<'vec3'>;
  return {
    vertex,
    uv: varying(vec2(a.w, b.w)) as unknown as Node<'vec2'>,
    normal: varying(modelWorldMatrix.mul(vec4(normal, 0)).xyz) as unknown as Node<'vec3'>,
    main: varying(main.xyz) as unknown as Node<'vec3'>,
    skin: varying(skin.xyz) as unknown as Node<'vec3'>,
    hair: varying(hair.xyz) as unknown as Node<'vec3'>,
    machine: varying(skin.w) as unknown as Node<'float'>,
    layer: varying(main.w) as unknown as Node<'float'>,
  };
}

/** Someone drawn: their station, look and colours, and the level drawn at. */
interface Drawn {
  station: BoatStation;
  look: FleetLook;
  colours: { main: Color; skin: Color; hair: Color };
  near: boolean;
  /** The figure drawn, and whether it is the far figure seated and raised (a standing station's till its clips load). */
  key: string;
  raised: boolean;
  /** The look's states when last posed. */
  state: string;
  clipsState: string;
}

const world = new Vector3();

/** The people aboard the boat in view, drawn at their stations. */
export class CrewDeck {
  /** Under the boat's model, when one is aboard to draw. */
  readonly group = new Group();
  #looks: FleetLooks | null = null;
  #near: Level | null = null;
  #far: Level | null = null;
  #stations: readonly BoatStation[] = [];
  #crew: CrewShown | null = null;
  #people: Drawn[] = [];
  /** Each figure posed, by key: the deck level's by look and pose, the far's by look. */
  readonly #figures = new Map<string, Float32Array>();
  /** The levels' rows must be written again: the people, a look or the nearest changed. */
  #dirty = true;
  /** Each person's distance from the camera, squared, and the people by it, nearest first. */
  #d2 = new Float64Array(0);
  #order: number[] = [];
  readonly #byDistance = (a: number, b: number): number =>
    (this.#d2[a] as number) - (this.#d2[b] as number);

  constructor(readonly sailorLookOf: (code: number) => SailorLook) {
    this.group.name = 'crew';
  }

  /** The fleet's looks, which the crew is drawn in; until given, nothing is drawn. */
  useLooks(looks: FleetLooks, capacity: number): void {
    if (this.#looks !== null) {
      return;
    }
    this.#looks = looks;
    this.#near = new Level('near', capacity, 3 * DECK_TRIANGLES, NEAR_MOST, looks);
    this.#far = new Level('far', capacity, 3 * FAR_TRIANGLES, FAR_FIGURES, looks);
    this.group.add(this.#near.mesh, this.#far.mesh);
    this.#show();
  }

  /** The boat whose crew is drawn: its model and its stations. */
  aboard(model: Object3D, stations: readonly BoatStation[]): void {
    model.add(this.group);
    this.#stations = stations;
    this.#show();
  }

  /** The people aboard; null for nobody but the one at the helm. */
  set(crew: CrewShown | null): void {
    this.#crew = crew;
    this.#show();
  }

  /** Whether everyone aboard is drawn, in their own look, at the level their distance asks. */
  get ready(): boolean {
    const settled = (s: string): boolean => s === 'ready' || s === 'failed';
    return (
      !this.#dirty &&
      this.drawn.near + this.drawn.far === this.#people.length &&
      this.#people.every((p) => settled(p.look.state) && settled(p.look.clipsState))
    );
  }

  /** How many are drawn beside the one at the helm. */
  get count(): number {
    return this.#people.length;
  }

  /**
   * Where each person drawn is in the scene, as the boat was last drawn:
   * their head's height over their station (a standing person's 1.6 m, a
   * seated one's 0.9), and the level they are drawn at.
   */
  heads(): { at: Vector3; near: boolean; station: number }[] {
    const parent = this.group.parent;
    if (parent === null) {
      return [];
    }
    parent.updateMatrixWorld();
    return this.#people.map((p) => {
      const at = p.station.at;
      const up = p.station.pose === 'standing' ? 1.6 : 0.9;
      return {
        at: new Vector3(at[0], at[1] + up, at[2]).applyMatrix4(parent.matrixWorld),
        near: p.near,
        station: this.#stations.indexOf(p.station),
      };
    });
  }

  #show(): void {
    const looks = this.#looks;
    this.#people = [];
    if (looks !== null && this.#crew !== null) {
      for (const place of crewPlaces(this.#crew, this.#stations.length)) {
        const l = this.sailorLookOf(place.look);
        const look = looks.add(l.art, l.machine);
        looks.want(look, true);
        this.#people.push({
          station: this.#stations[place.station] as BoatStation,
          look,
          colours: {
            main: new Color(l.colours.main),
            skin: new Color(l.colours.skin),
            hair: new Color(l.colours.hair),
          },
          near: false,
          key: '',
          raised: false,
          state: '',
          clipsState: '',
        });
      }
    }
    this.#d2 = new Float64Array(this.#people.length);
    this.#order = this.#people.map((_, i) => i);
    this.#dirty = true;
  }

  /** The figure for a key, posed the first time it is asked for. */
  #figure(key: string, make: () => Float32Array | null): Float32Array | null {
    let f = this.#figures.get(key) ?? null;
    if (f === null) {
      f = make();
      if (f !== null) {
        this.#figures.set(key, f);
        this.#dirty = true;
      }
    }
    return f;
  }

  /**
   * A frame, the camera at camera (the scene's): the nearest NEAR_MOST
   * within NEAR_RANGE drawn at the deck level, the rest far.
   */
  frame(camera: Vector3): void {
    const near = this.#near;
    const far = this.#far;
    const looks = this.#looks;
    if (near === null || far === null || looks === null || this.group.parent === null) {
      return;
    }
    const people = this.#people;
    // Who is near, as the boat was last drawn.
    const model = this.group.parent.matrixWorld;
    const d2 = this.#d2;
    for (let i = 0; i < people.length; i++) {
      const at = (people[i] as Drawn).station.at;
      d2[i] = world.set(at[0], at[1], at[2]).applyMatrix4(model).distanceToSquared(camera);
    }
    const order = this.#order;
    order.sort(this.#byDistance);
    let shown = 0;
    for (let k = 0; k < order.length; k++) {
      const p = people[order[k] as number] as Drawn;
      const wantNear =
        shown < NEAR_MOST &&
        (d2[order[k] as number] as number) < NEAR_RANGE * NEAR_RANGE &&
        p.look.clipsState === 'ready' &&
        p.look.deck !== null;
      if (wantNear) {
        shown++;
      }
      if (wantNear !== p.near) {
        p.near = wantNear;
        this.#dirty = true;
      }
      // A look loaded since: its figures to pose.
      if (p.state !== p.look.state || p.clipsState !== p.look.clipsState) {
        p.state = p.look.state;
        p.clipsState = p.look.clipsState;
        this.#dirty = true;
      }
    }
    if (this.#dirty) {
      this.#dirty = false;
      this.#write(near, far, looks.seat);
    }
  }

  /** The levels' figures posed and pooled, and every person's values written. */
  #write(near: Level, far: Level, seat: FleetSeat): void {
    const people = this.#people;
    const nearKeys: string[] = [];
    const farKeys: string[] = [];
    for (const p of people) {
      const seated = p.station.pose === 'seated';
      if (p.near) {
        p.key = deckKey(p.look, seated);
        if (this.#figure(p.key, () => poseDeck(p.look, seated, seat)) !== null) {
          nearKeys.push(p.key);
          continue;
        }
        p.near = false;
      }
      // Standing far off: the far figure stood up once the look's clips
      // have loaded; till then, seated and raised to a standing height.
      p.key = farKey(p.look, seated);
      p.raised = false;
      if (this.#figure(p.key, () => poseFar(p.look, seated, seat)) === null && !seated) {
        p.key = farKey(p.look, true);
        p.raised = true;
        this.#figure(p.key, () => poseFar(p.look, true, seat));
      }
      if (this.#figures.has(p.key)) {
        farKeys.push(p.key);
      }
    }
    const figure = (k: string): Float32Array => this.#figures.get(k) as Float32Array;
    near.pool.add(nearKeys, figure);
    far.pool.add(farKeys, figure);
    let nn = 0;
    let nf = 0;
    let tn = 0;
    let tf = 0;
    for (const p of people) {
      const s = p.station;
      // The figure faces +z; turned to face the station's way.
      const turn = Math.PI - (s.facing * Math.PI) / 180;
      const level = p.near ? near : far;
      const placed = level.pool.placed.get(p.key);
      if (placed === undefined) {
        continue;
      }
      const lift = p.raised ? STAND_SEAT_UP : 0;
      const back = p.raised ? STAND_SEAT_BACK : 0;
      level.write(
        p.near ? nn++ : nf++,
        s.at,
        turn,
        placed,
        lift,
        back,
        p.colours,
        p.look.layer,
        p.look.machine,
      );
      if (p.near) {
        tn += placed.count / 3;
      } else {
        tf += placed.count / 3;
      }
    }
    near.commit(nn, nearKeys);
    far.commit(nf, farKeys);
    this.drawn = { near: nn, far: nf, nearTriangles: tn, farTriangles: tf };
  }

  /**
   * How many were drawn at each level at the last change, and their
   * figures' triangles (the draws' own count is more: every instance runs
   * its level's largest figure's vertices, those past its own folded).
   */
  drawn = { near: 0, far: 0, nearTriangles: 0, farTriangles: 0 };
}

function deckKey(look: FleetLook, seated: boolean): string {
  return `deck ${look.index} ${seated ? 'seated' : 'standing'}`;
}

function farKey(look: FleetLook, seated: boolean): string {
  return `far ${look.index} ${seated ? 'seated' : 'standing'}`;
}

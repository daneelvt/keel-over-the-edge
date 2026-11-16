// SPDX-License-Identifier: AGPL-3.0-only

// The falls: the sea pouring over the lip. Two meshes, drawn while the
// camera is within the curtain's reach of the lip.
//
// The curtain is a ribbon along the lip about the point of it nearest the
// camera, its rows by the time since the water reached the brink: before
// it the water runs out at the drain's speed under the last tiles; after
// it each point leaves at the height of the waves at the lip, damped,
// carried out at the drain's speed and curving further out, and falls. A
// free jet falls as y = ½ g t² from a brink (Rouse 1936); the curtain's
// gravity is the catalog's, slower than the Earth's, as a look. Before the
// brink it runs below the last tiles, which tip and sag over it, so what
// shows of it pours from under their edges. It is lit as the sea's water and
// foam are, by the hour's light and sky: a thin sheet the light comes through
// at the brink, it whitens in streaks that ride down with the water and widen
// until it is white, tears into ribbons, takes the mist's colour and fades
// out as it falls.
//
// The slabs are the sea's tiles breaking off at the brink: from each cell
// of the lattice just beyond the lip near the camera, a slab rides the
// curtain over the brink, is let go at a time drawn for the cell and the
// cycle, then tips, spins and falls at its own gravity until it is gone in
// the mist below. Each cell lets one go every cycle; two are in flight.
//
// Both are functions of world time and the lattice alone, so every page
// draws the same falls. World time is reduced on the CPU, in float64, to
// what each slab needs, so float32 never holds a large time.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type Texture,
  Vector2,
} from 'three';
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  exp,
  float,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { foamColour } from '../ocean/foam';
import { type Hex, hexAt, hexCentre, type Point, TILE_ACROSS, TILE_RADIUS } from '../ocean/hex';
import { FOAM } from '../ocean/look';
import { water } from '../ocean/seamaterial';
import { tileGeometry } from '../ocean/tiles';
import { type BandUniforms, boatBandAt } from '../ocean/wave';
import { basicMaterial } from '../render/materials';
import { look, toLinear } from '../render/sky';
import { edgeLook } from './mist';

/** The falls' look: the catalog's world.edge.look's curtain and slabs. */
export interface FallsLook {
  curtain: {
    from: number;
    to: number;
    gravity: number;
    out: number;
    damping: number;
    foam: number;
    mist: number[];
    fade: number[];
    reach: number;
  };
  slabs: {
    release: number[];
    cycle: number[];
    gravity: number;
    tip: number[];
    spin: number;
    mist: number[];
    gone: number[];
  };
}

/** The curtain's columns along the lip and rows down it. */
export const CURTAIN_COLUMNS = 150;
export const CURTAIN_ROWS = 40;

/**
 * Slabs are drawn within this of the camera along the lip, m: beyond the
 * lip the mist keeps under e^(−4) of anything further.
 */
export const SLAB_REACH = 400;

/** How many slabs are in flight from each cell. */
const IN_FLIGHT = 2;

/** The most slabs drawn: two from each cell of the ring beyond the lip within reach. */
export const MAX_SLABS = 640;

/** A slab's thickness, m: the depth of a tile's skirt. */
const SLAB_THICKNESS = 1.1;

/**
 * The curtain's look: how far its water goes to the sea's scattered green
 * at the brink, where it is thinnest; where its white streaks begin, from
 * the first share of the pattern's range to the second, as it falls from
 * and to s after the brink, and how much of the water shows through them,
 * at the least and over that by the pattern; where it tears into ribbons,
 * from and to s, with gaps of up to the share of the pattern given; and
 * how soft the streaks' and the tears' edges are.
 */
export const CURTAIN_LOOK = {
  thin: 0.35,
  foam: [0.62, 0.32, 0.05, 2.5],
  strokes: [0.45, 0.8],
  tear: [1.5, 6, 0.5],
  edge: 0.06,
} as const;

/**
 * How far the curtain runs below the sea's surface, m: the last tiles tip
 * and sag over the brink, their edges up to this below the waves there, so
 * a curtain that began at the surface would show over them.
 */
export const CURTAIN_TUCK = 0.6;

/** The curtain's streaks: the pattern read this many times finer across the lip, and so many repeats a second of water down it. */
const STREAK_SCALE = 0.8;
const STREAK_FLOW = 2 / 256;

/** World time is reduced by this, s, for the streaks: their flow repeats a whole number of times in it. */
const STREAK_PERIOD = 256;

/**
 * How dense the columns are about the centre, the lip's point nearest the
 * camera: the share of the even spacing they keep there, growing to
 * 3 − 2 × that at the ends of the reach.
 */
const CENTRE_DENSITY = 0.15;

/** Each column's place along the lip from the centre, m: close by the camera, wider apart far off. */
export function curtainColumns(reach: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < CURTAIN_COLUMNS; i++) {
    const x = (2 * i) / (CURTAIN_COLUMNS - 1) - 1;
    out.push(reach * x * (CENTRE_DENSITY + (1 - CENTRE_DENSITY) * x * x));
  }
  return out;
}

/**
 * Each row's time since the brink, s: one row at the start before it, if
 * the curtain starts before it, the rest from the brink on, closer
 * together near it.
 */
export function curtainRows(c: FallsLook['curtain']): number[] {
  const out: number[] = [];
  if (c.from < 0) {
    out.push(c.from);
  }
  const start = Math.max(c.from, 0);
  const left = CURTAIN_ROWS - out.length;
  for (let j = 0; j < left; j++) {
    const v = j / (left - 1);
    out.push(start + (c.to - start) * v * v);
  }
  return out;
}

/** A point of the curtain: how far out of the lip and how high, m, and their rates, m/s. */
export interface CurtainPoint {
  out: number;
  height: number;
  dOut: number;
  dHeight: number;
}

/**
 * The curtain t seconds after the brink, where the waves stand wave m high
 * at the lip and the drain runs drain m/s, with the lip's sag of sag m: the
 * shader's path, op for op.
 */
export function curtainAt(
  c: FallsLook['curtain'],
  drain: number,
  wave: number,
  sag: number,
  t: number,
  out: CurtainPoint,
): CurtainPoint {
  const fall = Math.max(t, 0);
  const damped = Math.exp(-c.damping * fall);
  const before = c.from < 0 ? -c.from : 1;
  const ramp = Math.min(Math.max(t / before + 1, 0), 1);
  out.out = drain * t + c.out * fall * fall;
  out.height = wave * damped - sag * ramp - CURTAIN_TUCK - 0.5 * c.gravity * fall * fall;
  out.dOut = drain + 2 * c.out * fall;
  out.dHeight =
    (t > 0 ? -c.damping * wave * damped : 0) -
    c.gravity * fall -
    (t < 0 && t > -before ? sag / before : 0);
  return out;
}

/** A hash of two whole numbers into [0, 1): lowbias32. */
export function hash01(a: number, b: number): number {
  let x = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x632be5ab, 0x85ebca77)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 8) / 16777216;
}

/** A slab at a moment: how long it has been since it reached the brink, and its draws. */
export interface SlabNow {
  /** Seconds since it reached the brink; it was let go at release. */
  age: number;
  release: number;
  /** Its spin, rad/s, and how far down it is gone, m. */
  spin: number;
  gone: number;
}

/**
 * Slab k ∈ [0, IN_FLIGHT) of the cell (q, r) at world time t, seconds: the
 * cell lets one go every cycle, drawn for the cell; the slabs take turns.
 */
export function slabAt(
  look: FallsLook['slabs'],
  q: number,
  r: number,
  k: number,
  t: number,
  out: SlabNow,
): SlabNow {
  const key = Math.imul(q, 73856093) ^ Math.imul(r, 19349663);
  const [c0 = 3, c1 = 7] = look.cycle;
  const cycle = c0 + (c1 - c0) * hash01(key, 1);
  const phase = cycle * hash01(key, 2);
  const life = cycle * IN_FLIGHT;
  const shifted = t + phase - k * cycle;
  const n = Math.floor(shifted / life);
  const [r0 = 0.2, r1 = 1] = look.release;
  const [g0 = 70, g1 = 120] = look.gone;
  out.age = shifted - n * life;
  out.release = r0 + (r1 - r0) * hash01(key + n * IN_FLIGHT + k, 3);
  out.spin = look.spin * (2 * hash01(key + n * IN_FLIGHT + k, 4) - 1);
  out.gone = g0 + (g1 - g0) * hash01(key, 5);
  return out;
}

/** The cells of the lattice in the ring just beyond the lip, within reach of a point of it at angle theta. */
export function cellsBeyondLip(lip: number, theta: number, reach: number, out: Hex[]): Hex[] {
  out.length = 0;
  const seen = new Set<string>();
  const h: Hex = { q: 0, r: 0 };
  const c: Point = { x: 0, y: 0 };
  const step = TILE_RADIUS / 2;
  for (let s = -reach; s <= reach; s += step) {
    const a = theta + s / lip;
    for (const out1 of [0.5, 1.5]) {
      const rr = lip + out1 * TILE_RADIUS;
      hexAt(rr * Math.sin(a), rr * Math.cos(a), h);
      hexCentre(h.q, h.r, c);
      const d = Math.hypot(c.x, c.y);
      const key = `${h.q},${h.r}`;
      if (d >= lip && d < lip + TILE_ACROSS && !seen.has(key)) {
        seen.add(key);
        out.push({ q: h.q, r: h.r });
      }
    }
  }
  return out;
}

const fallsUniforms = {
  /** The angle of the lip's point nearest the camera, clockwise from north, as its sine and cosine. */
  centre: uniform(new Vector2(0, 1)),
  /** The drain's speed at the lip, m/s. */
  drain: uniform(1),
  /** World time for the curtain's streaks, s, reduced. */
  time: uniform(0),
  /** Where the curtain's centre lies in its pattern across the lip, reduced. */
  arc: uniform(0),
};

/** A point of the lip at angle a clockwise from north, in the scene's (x, z). */
const lipPoint = (sinA: Node<'float'>, cosA: Node<'float'>, r: Node<'float'>): Node<'vec2'> =>
  vec2(sinA.mul(r).sub(edgeLook.origin.x), cosA.mul(r).sub(edgeLook.origin.y).negate());

export class Falls {
  readonly curtain: Mesh;
  readonly slabs: Mesh;
  readonly look: FallsLook;
  /** Whether each part is drawn when the falls are (the tests, the panel). */
  readonly show = { curtain: true, slabs: true };
  readonly #lip: number;
  readonly #cells: Hex[] = [];
  /** The lip's point the cells were found about, as an angle. */
  #cellsAt = Number.NaN;
  readonly #slab: SlabNow = { age: 0, release: 0, spin: 0, gone: 0 };
  readonly #place: InstancedBufferAttribute;
  readonly #life: InstancedBufferAttribute;
  readonly #slabGeometry: InstancedBufferGeometry;

  constructor(band: BandUniforms, lip: number, drain: number, falls: FallsLook, pattern: Texture) {
    this.look = falls;
    this.#lip = lip;
    fallsUniforms.drain.value = drain;
    this.curtain = this.#makeCurtain(band, falls.curtain, pattern);
    const slabs = this.#makeSlabs(falls);
    this.slabs = slabs.mesh;
    this.#place = slabs.place;
    this.#life = slabs.life;
    this.#slabGeometry = slabs.geometry;
  }

  #makeCurtain(band: BandUniforms, c: FallsLook['curtain'], pattern: Texture): Mesh {
    const n = CURTAIN_COLUMNS * CURTAIN_ROWS;
    const grid = new Float32Array(n * 3);
    const columns = curtainColumns(c.reach);
    const rows = curtainRows(c);
    for (let i = 0; i < CURTAIN_COLUMNS; i++) {
      for (let j = 0; j < CURTAIN_ROWS; j++) {
        const k = (i * CURTAIN_ROWS + j) * 3;
        grid[k] = (columns[i] ?? 0) / c.reach;
        grid[k + 1] = rows[j] ?? 0;
      }
    }
    const index: number[] = [];
    for (let i = 0; i < CURTAIN_COLUMNS - 1; i++) {
      for (let j = 0; j < CURTAIN_ROWS - 1; j++) {
        const a = i * CURTAIN_ROWS + j;
        const b = a + CURTAIN_ROWS;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(grid, 3));
    g.setIndex(index);

    const across = positionGeometry.x;
    const t = positionGeometry.y;
    const fall = max(t, 0);
    const u = fallsUniforms;
    // The column's point of the lip, turned from the centre by the arc.
    const a = across.mul(c.reach / this.#lip);
    const sinA = u.centre.x.mul(cos(a)).add(u.centre.y.mul(sin(a)));
    const cosA = u.centre.y.mul(cos(a)).sub(u.centre.x.mul(sin(a)));
    const atBrink = lipPoint(sinA, cosA, edgeLook.lip);
    const wave = boatBandAt(band)(atBrink).x;
    // The path, as curtainAt works it out on the CPU.
    const out = u.drain.mul(t).add(fall.mul(fall).mul(c.out));
    const where = lipPoint(sinA, cosA, edgeLook.lip.add(out));
    const damped = exp(fall.mul(-c.damping));
    const before = c.from < 0 ? -c.from : 1;
    const ramp = clamp(t.div(before).add(1), 0, 1);
    const height = wave
      .mul(damped)
      .sub(edgeLook.sag.mul(ramp))
      .sub(CURTAIN_TUCK)
      .sub(fall.mul(fall).mul(0.5 * c.gravity));
    const vertex = vec3(where.x, height, where.y);
    // Its normal: across the path's direction in the plane of the fall,
    // upward and outward; turned toward the eye in the fragment.
    const falling = select(t.greaterThan(0), float(1), float(0));
    const rising = select(t.lessThan(0).and(t.greaterThan(-before)), float(1), float(0));
    const dOut = u.drain.add(fall.mul(2 * c.out));
    const dHeight = wave
      .mul(damped)
      .mul(-c.damping)
      .mul(falling)
      .sub(fall.mul(c.gravity))
      .sub(edgeLook.sag.mul(rising).div(before));
    const normal = normalize(vec3(sinA.mul(dHeight.negate()), dOut, cosA.mul(dHeight)));
    // Lit once a vertex, as the sea's water and its foam are, on the side
    // the eye sees: the rows lie close near the brink and the columns near
    // the eye, and at the turn from one side to the other both read the
    // sky's reflection, so the light changes smoothly between them.
    const toEye = normalize(cameraPosition.sub(vertex));
    const N = select(normal.dot(toEye).lessThan(0), normal.negate(), normal);
    // The sea's own water, thin at the brink and the light through it; and
    // white water.
    // At the brink the sheet is thin and the light comes through it in the
    // sea's own green, as through a crest.
    const sea = water({ normal: N, crest: float(1), glint: 0 }, toEye);
    const body = varying(
      mix(sea, look.scatter, smoothstep(1.5, 0, t).mul(CURTAIN_LOOK.thin)),
    ) as unknown as Node<'vec3'>;
    const foamLit = varying(foamColour(N)) as unknown as Node<'vec3'>;
    // By the time since the brink, once a vertex: where the white streaks
    // begin, where it tears, how much is left before it fades, and how far
    // it has gone to the mist's colour.
    const [w0, w1, f0, f1] = CURTAIN_LOOK.foam;
    const [t0, t1, most] = CURTAIN_LOOK.tear;
    const row = varying(
      vec4(
        mix(float(w0), float(w1), smoothstep(f0, f1, t)),
        smoothstep(t0, t1, t).mul(most),
        float(1)
          .sub(smoothstep(c.fade[0] ?? 6, c.fade[1] ?? 10, t))
          .mul(edgeLook.on),
        smoothstep(c.mist[0] ?? 5, c.mist[1] ?? 10, t),
      ),
    ) as unknown as Node<'vec4'>;
    const tv = varying(t);
    const along = varying(across.mul(c.reach));
    const m = basicMaterial({ transparent: true, depthWrite: false, side: DoubleSide }, vertex);

    // The sheet's own pattern: the sea's noise read across the lip and with
    // the water, so the streaks ride down with it and stretch as it speeds up.
    const p = texture(
      pattern,
      vec2(u.arc.add(along.mul(STREAK_SCALE / FOAM.patternSpan)), tv.sub(u.time).mul(STREAK_FLOW)),
    );
    // Fine streaks for the white water, broad ones for where it tears.
    const streak = p.y.mul(0.75).add(p.z.mul(0.25));
    const broad = p.z;
    // White in streaks that widen as it falls until the sheet is white, in
    // strokes down the fall with the water showing through between them.
    const foamy = smoothstep(row.x, row.x.add(CURTAIN_LOOK.edge), streak);
    const [s0, s1] = CURTAIN_LOOK.strokes;
    const white = mix(body, foamLit, clamp(p.w.mul(s1).add(s0), 0, 1));
    const colour = mix(mix(body, white, foamy), edgeLook.colour, row.w);
    // Whole at the brink; torn into ribbons as it falls; then faded out.
    const torn = smoothstep(row.y, row.y.add(CURTAIN_LOOK.edge), broad);
    const alpha = row.z.mul(torn);
    m.colorNode = vec4(toLinear(colour), 1);
    m.opacityNode = alpha;
    const mesh = new Mesh(g, m);
    mesh.name = 'falls-curtain';
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  #makeSlabs(f: FallsLook): {
    mesh: Mesh;
    place: InstancedBufferAttribute;
    life: InstancedBufferAttribute;
    geometry: InstancedBufferGeometry;
  } {
    const t = tileGeometry();
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(t.position, 3));
    geometry.setIndex(new BufferAttribute(t.index, 1));
    // Each slab's cell, east and north, and its age and release; its spin
    // and how far down it is gone.
    const place = new InstancedBufferAttribute(new Float32Array(MAX_SLABS * 4), 4);
    const life = new InstancedBufferAttribute(new Float32Array(MAX_SLABS * 4), 4);
    place.setUsage(35048); // DynamicDrawUsage
    life.setUsage(35048);
    geometry.setAttribute('place', place);
    geometry.setAttribute('life', life);
    geometry.instanceCount = 0;

    const c = f.curtain;
    const s = f.slabs;
    const p = attribute<'vec4'>('place', 'vec4');
    const l = attribute<'vec4'>('life', 'vec4');
    const age = p.z;
    const release = p.w;
    const r0 = vec2(p.x, p.y).length();
    const outward = vec2(p.x, p.y).div(max(r0, 1));
    // On the curtain until let go: out at the drain's speed and curving
    // further, down at the curtain's gravity.
    const onCurtain = age.lessThan(release);
    const held = clamp(age, 0, release);
    const free = max(age.sub(release), 0);
    const drain = fallsUniforms.drain;
    const vOut = drain.add(held.mul(2 * c.out));
    const vDown = held.mul(c.gravity);
    const ride = drain.mul(held).add(held.mul(held).mul(c.out));
    const out = ride.add(vOut.mul(free));
    const down = held
      .mul(held)
      .mul(0.5 * c.gravity)
      .add(vDown.mul(free))
      .add(free.mul(free).mul(0.5 * s.gravity))
      .add(edgeLook.sag);
    const [tip0 = 0.3, tip1 = 1.9] = s.tip;
    const tip = select(onCurtain, age.div(max(release, 0.01)).mul(tip0), free.mul(tip1).add(tip0));
    const spin = l.x.mul(free);
    // The slab's own vertex, spun about its up, then tipped outward about
    // the lip's tangent.
    const e = positionGeometry.xz;
    const y0 = positionGeometry.y.mul(SLAB_THICKNESS);
    const ex = e.x.mul(cos(spin)).sub(e.y.mul(sin(spin)));
    const ez = e.x.mul(sin(spin)).add(e.y.mul(cos(spin)));
    // Outward in the scene's (x, z), and the tangent.
    const ns = vec2(outward.x, outward.y.negate());
    const ts = vec2(ns.y.negate(), ns.x);
    const along = ex.mul(ns.x).add(ez.mul(ns.y));
    const across = ex.mul(ts.x).add(ez.mul(ts.y));
    const a2 = along.mul(cos(tip)).add(y0.mul(sin(tip)));
    const y2 = y0.mul(cos(tip)).sub(along.mul(sin(tip)));
    const centre = vec2(p.x.add(outward.x.mul(out)), p.y.add(outward.y.mul(out)));
    const sx = centre.x.sub(edgeLook.origin.x).add(ns.x.mul(a2)).add(ts.x.mul(across));
    const sz = centre.y.sub(edgeLook.origin.y).negate().add(ns.y.mul(a2)).add(ts.y.mul(across));
    // Gone once it is as far down as its draw says: every vertex to one
    // point far below, as the tiles over land do.
    const gone = down.greaterThan(l.y).or(edgeLook.on.lessThan(0.5));
    const vertex = select(
      gone,
      vec3(centre.x.sub(edgeLook.origin.x), -1000, 0),
      vec3(sx, y2.sub(down), sz),
    );
    const depth = varying(down);
    const side = varying(positionGeometry.y);
    const m = basicMaterial({ side: DoubleSide }, vertex);
    // A slab of the sea's water, its broken sides foaming.
    const water = look.deep
      .mul(1.1)
      .add(look.scatter.mul(select(side.lessThan(-0.01), float(0.05), float(0.2))));
    const white = mix(water, look.cloud, select(side.lessThan(-0.01), float(0.35), float(0.12)));
    const [mist0 = 12, mist1 = 110] = s.mist;
    m.colorNode = vec4(toLinear(mix(white, edgeLook.colour, smoothstep(mist0, mist1, depth))), 1);
    const mesh = new Mesh(geometry, m);
    mesh.name = 'falls-slabs';
    mesh.frustumCulled = false;
    mesh.visible = false;
    return { mesh, place, life, geometry };
  }

  /**
   * Brings the falls to world time, seconds, seen from the camera at
   * (east, north), metres, which lies distance from the lip: drawn while it
   * is within the curtain's reach.
   */
  frame(time: number, east: number, north: number, distance: number): void {
    const on = edgeLook.on.value > 0.5 && distance < this.look.curtain.reach;
    this.curtain.visible = on && this.show.curtain;
    this.slabs.visible = on && this.show.slabs;
    if (!on) {
      return;
    }
    const theta = Math.atan2(east, north);
    (fallsUniforms.centre.value as Vector2).set(Math.sin(theta), Math.cos(theta));
    // The streaks repeat every 256 s: float32 holds that finely.
    fallsUniforms.time.value = time - STREAK_PERIOD * Math.floor(time / STREAK_PERIOD);
    // And across the lip every pattern's span: the centre's place in it.
    const lip = this.#lip;
    const arc = (lip * theta * STREAK_SCALE) / FOAM.patternSpan;
    fallsUniforms.arc.value = arc - Math.floor(arc);
    if (!(Math.abs(lip * (theta - this.#cellsAt)) < TILE_ACROSS)) {
      cellsBeyondLip(lip, theta, SLAB_REACH, this.#cells);
      this.#cellsAt = theta;
    }
    const place = this.#place.array as Float32Array;
    const life = this.#life.array as Float32Array;
    const c: Point = { x: 0, y: 0 };
    const s = this.#slab;
    let n = 0;
    for (const cell of this.#cells) {
      hexCentre(cell.q, cell.r, c);
      for (let k = 0; k < IN_FLIGHT && n < MAX_SLABS; k++) {
        slabAt(this.look.slabs, cell.q, cell.r, k, time, s);
        place.set([c.x, c.y, s.age, s.release], n * 4);
        life.set([s.spin, s.gone, 0, 0], n * 4);
        n++;
      }
    }
    this.#slabGeometry.instanceCount = n;
    this.#place.needsUpdate = true;
    this.#life.needsUpdate = true;
  }

  /** How many slabs are drawn, and the curtain's triangles (the panel, the measurements). */
  get counts(): { slabs: number; curtainTriangles: number } {
    return {
      slabs: this.slabs.visible ? this.#slabGeometry.instanceCount : 0,
      curtainTriangles: this.curtain.visible ? 2 * (CURTAIN_COLUMNS - 1) * (CURTAIN_ROWS - 1) : 0,
    };
  }
}

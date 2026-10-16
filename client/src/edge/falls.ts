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
// gravity is the catalog's, slower than the Earth's, as a look. It whitens
// to foam, takes the mist's colour and fades out as it falls.
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
  Vector2,
} from 'three';
import {
  attribute,
  clamp,
  cos,
  exp,
  float,
  fract,
  max,
  mix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { type Hex, hexAt, hexCentre, type Point, TILE_ACROSS, TILE_RADIUS } from '../ocean/hex';
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
};

/** A point of the lip at angle a clockwise from north, in the scene's (x, z). */
const lipPoint = (sinA: Node<'float'>, cosA: Node<'float'>, r: Node<'float'>): Node<'vec2'> =>
  vec2(sinA.mul(r).sub(edgeLook.origin.x), cosA.mul(r).sub(edgeLook.origin.y).negate());

/** Value noise of a hash, for the curtain's streaks. */
const streakNoise = (p: Node<'vec2'>): Node<'float'> => {
  const h = (q: Node<'vec2'>) => fract(sin(q.x.mul(127.1).add(q.y.mul(311.7))).mul(43758.5453));
  const i = p.floor();
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(h(i), h(i.add(vec2(1, 0))), u.x),
    mix(h(i.add(vec2(0, 1))), h(i.add(vec2(1, 1))), u.x),
    u.y,
  );
};

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

  constructor(band: BandUniforms, lip: number, drain: number, falls: FallsLook) {
    this.look = falls;
    this.#lip = lip;
    fallsUniforms.drain.value = drain;
    this.curtain = this.#makeCurtain(band, falls.curtain);
    const slabs = this.#makeSlabs(falls);
    this.slabs = slabs.mesh;
    this.#place = slabs.place;
    this.#life = slabs.life;
    this.#slabGeometry = slabs.geometry;
  }

  #makeCurtain(band: BandUniforms, c: FallsLook['curtain']): Mesh {
    const n = CURTAIN_COLUMNS * CURTAIN_ROWS;
    const grid = new Float32Array(n * 3);
    for (let i = 0; i < CURTAIN_COLUMNS; i++) {
      for (let j = 0; j < CURTAIN_ROWS; j++) {
        const k = (i * CURTAIN_ROWS + j) * 3;
        // Columns from −1 to 1 across the reach; rows closer near the brink.
        grid[k] = (2 * i) / (CURTAIN_COLUMNS - 1) - 1;
        const u = j / (CURTAIN_ROWS - 1);
        const t0 = (-c.from / (c.to - c.from)) ** 0.5;
        const v = u < t0 ? u / t0 : (u - t0) / (1 - t0);
        grid[k + 1] = u < t0 ? c.from * (1 - v) : c.to * v * v;
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
    const out = u.drain.mul(t).add(fall.mul(fall).mul(c.out));
    const where = lipPoint(sinA, cosA, edgeLook.lip.add(out));
    // Under the last tiles before the brink, sagging as they do.
    const sag = edgeLook.sag.mul(clamp(t.div(-c.from).add(1), 0, 1));
    const height = wave
      .mul(exp(fall.mul(-c.damping)))
      .sub(sag)
      .sub(fall.mul(fall).mul(0.5 * c.gravity))
      .sub(select(t.lessThan(0), float(0.05), float(0)));
    const vertex = vec3(where.x, height, where.y);
    const tv = varying(t);
    const along = varying(across.mul(c.reach));
    const m = basicMaterial({ transparent: true, depthWrite: false, side: DoubleSide }, vertex);
    const streak = streakNoise(vec2(along.div(2.5), tv.mul(1.6).sub(u.time.mul(0.8))));
    // A thin sheet of the sea's water at the brink, the light through it;
    // whitening in streaks from the brink on as it falls.
    const water = mix(look.deep, look.scatter, 0.5);
    const foamy = clamp(tv.div(c.foam), 0, 1).sqrt().mul(streak.mul(0.7).add(0.3));
    const misted = smoothstep(c.mist[0] ?? 5, c.mist[1] ?? 10, tv);
    const colour = mix(mix(water, look.cloud, foamy), edgeLook.colour, misted);
    // Whole at the brink; torn by the streaks as it falls; then faded out.
    const torn = mix(float(1), streak.mul(0.5).add(0.5), smoothstep(0, 2, tv));
    const alpha = float(1)
      .sub(smoothstep(c.fade[0] ?? 6, c.fade[1] ?? 10, tv))
      .mul(torn)
      .mul(edgeLook.on);
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
    fallsUniforms.time.value = time - 256 * Math.floor(time / 256);
    const lip = this.#lip;
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

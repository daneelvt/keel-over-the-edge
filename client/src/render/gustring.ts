// SPDX-License-Identifier: AGPL-3.0-only

// The beginners' gust ring, part of the wind overlay: a faint, dashed ring
// on the water round each gust that is heading for the boat, travelling
// with it, so a beginner learns to see the dark patch behind it.
//
// The rings come from the physics module's own gust field, the one the boat
// feels, not from what is drawn: a few times a second the field is sampled
// on a grid upwind of the boat, its patches of strong gust found, and each
// whose track passes near the boat soon is given a ring, the soonest first.
// Between samplings a ring travels with the field.
//
// A ring is an instrument: unlit, a dashed line of its own, never colour
// alone, bent with the dome like everything on the water.

import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three';
import type { WeatherRing } from '../catalog/types.gen';
import { RECORDS } from '../predict/layout.gen';
import { type Physics, WIND_VALUE, WIND_VALUES } from '../predict/physics';
import { basicMaterial } from './materials';

/** A patch of gust on the grid. */
export interface GustPatch {
  /** Its middle, in the world: metres east and north, weighed by how strong the gust is. */
  east: number;
  north: number;
  /** The radius of a circle of its area, in metres. */
  radius: number;
  /** Its strongest gust factor. */
  peak: number;
}

/** A patch that gets a ring: when it passes nearest the boat, in seconds, and how near its edge comes, in metres (0 if it passes over). */
export interface RingedPatch extends GustPatch {
  arrives: number;
  miss: number;
}

/** The grid's rows upwind and its columns across the wind. */
export function gridSize(o: WeatherRing): { rows: number; cols: number } {
  return {
    rows: Math.max(1, Math.round(o.depth / o.spacing)),
    cols: Math.max(1, Math.round(o.width / o.spacing)),
  };
}

/**
 * Writes to out the grid's points, east and north of each in turn, row by
 * row from the boat upwind: upwind of a boat at (east, north) in a wind
 * from a direction in radians, centred across the wind on the boat.
 */
export function ringGrid(
  east: number,
  north: number,
  from: number,
  o: WeatherRing,
  out: Float64Array,
): void {
  const { rows, cols } = gridSize(o);
  const ue = Math.sin(from);
  const un = Math.cos(from);
  for (let i = 0; i < rows; i++) {
    const along = (i + 0.5) * o.spacing;
    for (let j = 0; j < cols; j++) {
      const across = (j - (cols - 1) / 2) * o.spacing;
      const k = (i * cols + j) * 2;
      // Across the wind is a quarter turn clockwise of upwind.
      out[k] = east + along * ue + across * un;
      out[k + 1] = north + along * un - across * ue;
    }
  }
}

/**
 * The patches of gust on the grid: each set of neighbouring points whose
 * gust factor is at least the threshold's share of the way from 1 to the
 * spell's (1 + excess). factor holds the gust factor at each point and
 * points their places, as ringGrid lays them.
 */
export function findPatches(
  factor: ArrayLike<number>,
  points: ArrayLike<number>,
  excess: number,
  o: WeatherRing,
): GustPatch[] {
  const { rows, cols } = gridSize(o);
  const patches: GustPatch[] = [];
  if (!(excess > 0)) {
    return patches;
  }
  const least = 1 + o.threshold * excess;
  const seen = new Uint8Array(rows * cols);
  const stack: number[] = [];
  for (let start = 0; start < rows * cols; start++) {
    if (seen[start] === 1 || !((factor[start] ?? 0) >= least)) {
      continue;
    }
    let weight = 0;
    let east = 0;
    let north = 0;
    let peak = 0;
    let count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const f = factor[p] ?? 0;
      const w = f - 1;
      weight += w;
      east += w * (points[p * 2] ?? 0);
      north += w * (points[p * 2 + 1] ?? 0);
      peak = Math.max(peak, f);
      count++;
      const i = Math.floor(p / cols);
      const j = p % cols;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di;
        const nj = j + dj;
        const q = ni * cols + nj;
        if (
          ni >= 0 &&
          ni < rows &&
          nj >= 0 &&
          nj < cols &&
          seen[q] === 0 &&
          (factor[q] ?? 0) >= least
        ) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    patches.push({
      east: east / weight,
      north: north / weight,
      radius: Math.sqrt((count * o.spacing * o.spacing) / Math.PI),
      peak,
    });
  }
  return patches;
}

/**
 * The patches that get a ring: those which, carried at (driftEast,
 * driftNorth) m/s past a boat at (east, north) moving at (boatEast,
 * boatNorth) m/s, pass within the ring's reach of the boat within its
 * horizon, by their edge; the soonest first, and at most as many as the
 * catalog allows.
 */
export function chooseRings(
  patches: readonly GustPatch[],
  east: number,
  north: number,
  boatEast: number,
  boatNorth: number,
  driftEast: number,
  driftNorth: number,
  o: WeatherRing,
): RingedPatch[] {
  // The patch as the boat sees it: where it is from the boat, and how it moves.
  const ve = driftEast - boatEast;
  const vn = driftNorth - boatNorth;
  const v2 = ve * ve + vn * vn;
  const out: RingedPatch[] = [];
  for (const p of patches) {
    const de = p.east - east;
    const dn = p.north - north;
    const t = v2 > 0 ? Math.min(Math.max(-(de * ve + dn * vn) / v2, 0), o.horizon) : 0;
    const miss = Math.max(0, Math.hypot(de + ve * t, dn + vn * t) - p.radius);
    if (miss <= o.reach) {
      out.push({ ...p, arrives: t, miss });
    }
  }
  out.sort((a, b) => a.arrives - b.arrives);
  return out.slice(0, o.rings);
}

/** A dashed ring of radius 1 lying on the water: dashes about its rim, each a thin quad. */
function ringGeometry(dashes: number, lit: number, width: number): BufferGeometry {
  const position = new Float32Array(dashes * 4 * 3);
  const index: number[] = [];
  for (let d = 0; d < dashes; d++) {
    // A dash is a few degrees of the rim: straight, it leaves the rim by
    // under a thousandth of the radius.
    const a0 = (d / dashes) * 2 * Math.PI;
    const a1 = ((d + lit) / dashes) * 2 * Math.PI;
    const o = d * 4;
    const corners = [
      [1 - width, a0],
      [1, a0],
      [1 - width, a1],
      [1, a1],
    ] as const;
    for (const [k, [r, a]] of corners.entries()) {
      position.set([r * Math.sin(a), 0, -r * Math.cos(a)], (o + k) * 3);
    }
    // Counter-clockwise seen from above.
    index.push(o, o + 2, o + 1, o + 2, o + 3, o + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setIndex(index);
  return g;
}

/** A ring on the water, as it is drawn. */
interface Drawn {
  mesh: Mesh;
  /** Where it is, in the world, and how wide. */
  east: number;
  north: number;
  radius: number;
  /** Whether a patch holds it, and how much of it shows, 0 to 1. */
  held: boolean;
  shown: number;
}

/** The rings are this far above the water, in metres, and this faint. */
const HEIGHT = 0.35;
const OPACITY = 0.38;
/** A ring fades in and out over about this long, in seconds. */
const FADE = 0.4;
/** A ring keeps its patch from one sampling to the next if the patch's middle is within this of it, in metres. */
const SAME = 40;
/** No ring is drawn smaller than this, in metres. */
const LEAST_RADIUS = 6;

export class GustRings {
  /** In the scene: the rings, placed each frame. */
  readonly group = new Group();
  /** Whether the rings are drawn: the wind overlay's switch. */
  on = false;
  /** The patches ringed at the last sampling (the tests, the panel). */
  ringed: RingedPatch[] = [];

  readonly #options: WeatherRing;
  readonly #drawn: Drawn[] = [];
  readonly #points: Float64Array;
  readonly #values: Float64Array;
  readonly #factor: Float64Array;
  #since = Number.POSITIVE_INFINITY;
  #driftEast = 0;
  #driftNorth = 0;

  constructor(options: WeatherRing) {
    this.#options = options;
    const { rows, cols } = gridSize(options);
    this.#points = new Float64Array(rows * cols * 2);
    this.#values = new Float64Array(rows * cols * WIND_VALUES);
    this.#factor = new Float64Array(rows * cols);
    this.group.name = 'gust rings';
    const geometry = ringGeometry(48, 0.55, 0.035);
    for (let i = 0; i < options.rings; i++) {
      const m = basicMaterial({
        color: 0xf2f4f5,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      m.name = 'gust ring';
      const mesh = new Mesh(geometry, m);
      mesh.name = `gust ring ${i}`;
      mesh.visible = false;
      // The rim is far from the mesh's own origin once scaled: never culled by it.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.#drawn.push({ mesh, east: 0, north: 0, radius: 1, held: false, shown: 0 });
    }
  }

  /** The rings as they are drawn: where, how wide and how much of each shows. */
  get rings(): { east: number; north: number; radius: number; shown: number }[] {
    return this.#drawn
      .filter((d) => d.shown > 0)
      .map((d) => ({ east: d.east, north: d.north, radius: d.radius, shown: d.shown }));
  }

  /** Samples the field at the next frame, whatever the time since the last. */
  flush(): void {
    this.#since = Number.POSITIVE_INFINITY;
  }

  /**
   * Brings the rings to a frame dt seconds after the last: for the boat at
   * (east, north) in the world, moving at (boatEast, boatNorth) m/s, in a
   * mean wind from a direction in radians, at a time in ticks. The floating
   * origin, in the world, places them in the scene.
   */
  update(
    physics: Physics | null,
    tick: number,
    dt: number,
    boat: { east: number; north: number; velEast: number; velNorth: number; windFrom: number },
    originEast: number,
    originNorth: number,
  ): void {
    const active = this.on && physics !== null;
    this.#since += dt;
    if (active && this.#since >= 1 / this.#options.rate) {
      this.#since = 0;
      this.#sample(physics, tick, boat);
    } else if (!active) {
      this.ringed = [];
      for (const d of this.#drawn) {
        d.held = false;
      }
    }
    const fade = Math.min(1, Math.max(0, dt) / FADE);
    for (const d of this.#drawn) {
      // A ring travels with its patch between samplings.
      d.east += this.#driftEast * dt;
      d.north += this.#driftNorth * dt;
      d.shown = Math.min(1, Math.max(0, d.shown + (d.held ? fade : -fade)));
      d.mesh.visible = d.shown > 0;
      if (d.mesh.visible) {
        d.mesh.position.set(d.east - originEast, HEIGHT, -(d.north - originNorth));
        d.mesh.scale.set(d.radius, 1, d.radius);
        (d.mesh.material as { opacity: number }).opacity = OPACITY * d.shown;
      }
    }
  }

  #sample(
    physics: Physics,
    tick: number,
    boat: { east: number; north: number; velEast: number; velNorth: number; windFrom: number },
  ): void {
    const o = this.#options;
    ringGrid(boat.east, boat.north, boat.windFrom, o, this.#points);
    physics.windDrawAt(tick);
    physics.windSample(this.#points, this.#values, this.#factor.length);
    for (let i = 0; i < this.#factor.length; i++) {
      this.#factor[i] = this.#values[i * WIND_VALUES + WIND_VALUE.factor] ?? 1;
    }
    const excess = physics.gustFrame()[RECORDS.gustFrame.excess] ?? 0;
    const here = physics.windPoint(boat.east, boat.north);
    this.#driftEast = here[RECORDS.wind.driftEast] ?? 0;
    this.#driftNorth = here[RECORDS.wind.driftNorth] ?? 0;
    this.ringed = chooseRings(
      findPatches(this.#factor, this.#points, excess, o),
      boat.east,
      boat.north,
      boat.velEast,
      boat.velNorth,
      this.#driftEast,
      this.#driftNorth,
      o,
    );
    // Each ring keeps the patch it was round, if that is ringed still; the
    // patches left take the rings left.
    const taken = new Set<Drawn>();
    const left: RingedPatch[] = [];
    for (const p of this.ringed) {
      let best: Drawn | null = null;
      let near = SAME;
      for (const d of this.#drawn) {
        const gap = Math.hypot(d.east - p.east, d.north - p.north);
        if (d.shown > 0 && !taken.has(d) && gap < near) {
          best = d;
          near = gap;
        }
      }
      if (best === null) {
        left.push(p);
      } else {
        taken.add(best);
        place(best, p);
      }
    }
    for (const p of left) {
      const free = this.#drawn.find((d) => !taken.has(d) && d.shown === 0);
      if (free !== undefined) {
        taken.add(free);
        place(free, p);
      }
    }
    for (const d of this.#drawn) {
      d.held = taken.has(d);
    }
  }
}

function place(d: Drawn, p: RingedPatch): void {
  d.east = p.east;
  d.north = p.north;
  d.radius = Math.max(p.radius, LEAST_RADIUS);
}

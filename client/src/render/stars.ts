// SPDX-License-Identifier: AGPL-3.0-only

// The stars: the Bright Star Catalogue's stars brighter than magnitude 5.5
// that can ever be seen from the disk, in one draw. Each star is a small
// quad that always faces the camera, at the direction its catalogue vector
// is turned to by the stars' matrix: one 3 × 3 matrix a frame, which the
// physics module computes by the rule of the sky, so the GPU does no
// trigonometry and every back end draws the stars where the server has
// them. They are directions, not places: drawn at the sky's distance from
// the camera, with no bend, hidden by whatever is nearer, the sea included.
//
// A star's size and brightness go by its magnitude, its tint faintly by its
// colour index. As the sun sinks the brightest come out first; they fade
// into the haze low down, dim behind the clouds, and hide behind the moon.
// The named stars are drawn a step brighter, and a tap on one shows its
// name.
//
// The table (stars.bin, written by tools/stars) holds six bytes a star,
// brightest first: right ascension and declination as 16-bit fractions,
// then the magnitude in hundredths and the colour index in twentieths
// packed in 16 bits.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Matrix3,
  Mesh,
  Vector3,
} from 'three';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  max,
  mix,
  smoothstep,
  step,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { sheets, sheetsHide } from '../sky/sheets';
import { skyMaterial } from './materials';
import { look, MOON_RADIUS, toLinear } from './sky';

/** Bytes a star in the table. */
export const ENTRY = 6;
/** How far from the camera the stars are drawn, metres: inside the sky sphere. */
const DISTANCE = 2800;
/** The least size of a star on screen, in pixels: smaller ones flicker as they drift. */
const LEAST_PIXELS = 2;
/** The size of a named star's quad grows by this, and its magnitude counts this much brighter. */
const NAMED_STEP = 0.5;
/** The faintest magnitude drawn where fewer stars are drawn: the table's brightest first. */
export const FEW_STARS = 5;
/** A tap finds a named star within this many CSS pixels. */
export const TAP_REACH = 28;
/** A named star's name shows this long after a tap, in milliseconds. */
export const LABEL_TIME = 4000;

/** A star of the table, decoded. */
export interface TableStar {
  ra: number;
  dec: number;
  magnitude: number;
  colour: number;
}

/** Decodes the table's star i. */
export function tableStar(table: DataView, i: number, out: TableStar): TableStar {
  const o = i * ENTRY;
  out.ra = (table.getUint16(o, true) / 65536) * 360;
  out.dec = (table.getUint16(o + 2, true) / 65535) * 180 - 90;
  const packed = table.getUint16(o + 4, true);
  out.magnitude = (packed & 1023) / 100 - 2;
  out.colour = (packed >> 10) / 20 - 0.5;
  return out;
}

/** A star's catalogue vector, the vector the stars' matrix turns. */
export function catalogueVector(ra: number, dec: number, out: Vector3): Vector3 {
  const a = (ra * Math.PI) / 180;
  const d = (dec * Math.PI) / 180;
  if (dec >= 90) {
    return out.set(0, 0, 1);
  }
  return out.set(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
}

/**
 * The stars' matrix in the scene's axes, from the module's: its rows are a
 * place's east, north and up; the scene's x is east, y up and z south.
 */
export function sceneStarMatrix(m: ArrayLike<number>, at: number, out: Matrix3): Matrix3 {
  const r = (i: number): number => m[at + i] ?? 0;
  return out.set(r(0), r(1), r(2), r(6), r(7), r(8), -r(3), -r(4), -r(5));
}

/** A named star, its place in the table, and its name. */
export interface NamedPlace {
  name: string;
  index: number;
  ra: number;
  dec: number;
}

/**
 * Finds each named star in the table: the entry nearest its place, within
 * a hundredth of a degree. A name not found is left out.
 */
export function findNamed(
  table: DataView,
  count: number,
  named: readonly { name: string; rightAscension: number; declination: number }[],
): NamedPlace[] {
  const s: TableStar = { ra: 0, dec: 0, magnitude: 0, colour: 0 };
  const a = new Vector3();
  const b = new Vector3();
  const out: NamedPlace[] = [];
  for (const n of named) {
    catalogueVector(n.rightAscension, n.declination, a);
    let best = -1;
    let bestDot = Math.cos((0.01 * Math.PI) / 180);
    for (let i = 0; i < count; i++) {
      tableStar(table, i, s);
      const d = a.dot(catalogueVector(s.ra, s.dec, b));
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    if (best >= 0) {
      out.push({ name: n.name, index: best, ra: n.rightAscension, dec: n.declination });
    }
  }
  return out;
}

export class Stars {
  readonly mesh: Mesh;
  /** The stars' matrix, in the scene's axes. */
  readonly matrix = uniform(new Matrix3());
  /** Two over the drawing buffer's size: a pixel in clip space. */
  readonly pixel = uniform(new Vector3(1 / 480, 1 / 300, 0));
  /**
   * Which stars are drawn, as weights: every star, the named alone, or the
   * one star numbered `only` in the table, plainly white and of a fixed
   * size, for the tests (setSolo).
   */
  readonly #which = uniform(new Vector3(1, 0, 0));
  readonly #only = uniform(0);
  /** How many of the table's stars there are, and how many are drawn. */
  total = 0;
  count = 0;
  named: NamedPlace[] = [];
  table: DataView | null = null;

  readonly #corner = new Vector3();
  #label: HTMLElement | null = null;
  #labelled: NamedPlace | null = null;
  #labelUntil = 0;

  constructor() {
    const m = skyMaterial();
    m.name = 'stars';
    m.transparent = true;
    m.depthTest = true;
    m.blending = AdditiveBlending;

    const vector = attribute('position', 'vec3') as unknown as Node<'vec3'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    const shine = attribute('shine', 'vec4') as unknown as Node<'vec4'>;
    const magnitude = shine.x.sub(shine.w.mul(NAMED_STEP));
    // Drawn: every star, or the named, or the one; and whether drawn plainly.
    const which = this.#which;
    const plain = which.z;
    const fancy = float(1).sub(plain);
    const theOne = float(1).sub(step(0.5, shine.z.sub(this.#only).abs()));
    const chosen = which.x.add(which.y.mul(shine.w)).add(plain.mul(theOne));
    const dir = this.matrix.mul(vector);
    const view = cameraViewMatrix.mul(vec4(dir, 0)).xyz;
    const centre = cameraProjectionMatrix.mul(vec4(view.mul(DISTANCE), 1));
    // Brighter stars are a little larger; none is under the least size.
    const pixels = mix(
      clamp(float(2.6).sub(magnitude.mul(0.45)), LEAST_PIXELS, 6).add(shine.w),
      float(5),
      plain,
    );
    m.vertexNode = centre.add(
      vec4(corner.mul(this.pixel.xy).mul(pixels).mul(centre.w).mul(chosen), 0, 0),
    );

    const vDir = varying(dir);
    const vCorner = varying(corner);
    // How far the star is past the faintest that shows, and how bright it is.
    const shown = varying(
      mix(clamp(look.starLimit.sub(magnitude).add(0.5), 0, 1).mul(chosen), float(1), plain),
    );
    const bright = varying(
      mix(clamp(float(1.25).sub(magnitude.mul(0.2)), 0.22, 1.6), float(1), plain),
    );
    const tint = varying(
      mix(
        mix(vec3(0.78, 0.86, 1), vec3(1, 0.82, 0.62), smoothstep(-0.2, 1.6, shine.y)),
        vec3(1, 1, 1),
        plain,
      ),
    );
    const vFancy = varying(fancy);
    const d = vDir;
    const r2 = dot(vCorner, vCorner);
    const spot = mix(step(r2, 1), exp(r2.mul(-3.5)), vFancy);
    const low = mix(float(1), smoothstep(-0.04, 0.05, d.y), vFancy);
    const clouds = mix(float(1), float(1).sub(sheetsHide(sheets, d)), vFancy);
    const moon = smoothstep(
      Math.cos(MOON_RADIUS * 1.15),
      Math.cos(MOON_RADIUS * 0.95),
      dot(d, look.moon),
    );
    const alpha = spot
      .mul(shown)
      .mul(low)
      .mul(clouds)
      .mul(float(1).sub(moon.mul(vFancy)));
    m.fragmentNode = vec4(
      toLinear(tint.mul(bright)).mul(max(alpha, 0)),
      1,
    ) as unknown as Node<'vec4'>;

    this.mesh = new Mesh(new BufferGeometry(), m);
    this.mesh.name = 'stars';
    this.mesh.frustumCulled = false;
    // After the sky sphere, which is drawn first, and before nothing else
    // that matters: the stars are added to whatever is behind them.
    this.mesh.renderOrder = -0.5;
    // Nothing to draw until the table is loaded.
    this.mesh.visible = false;
  }

  /**
   * Builds the quads from the table: four corners a star, each with the
   * star's catalogue vector, its magnitude, colour index, place in the
   * table, and whether it is named.
   */
  load(
    table: ArrayBuffer,
    named: readonly { name: string; rightAscension: number; declination: number }[],
  ): void {
    const view = new DataView(table);
    const n = Math.floor(table.byteLength / ENTRY);
    this.table = view;
    this.total = n;
    this.named = findNamed(view, n, named);
    const isNamed = new Uint8Array(n);
    for (const p of this.named) {
      isNamed[p.index] = 1;
    }
    const position = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const shine = new Float32Array(n * 4 * 4);
    const index = new Uint16Array(n * 6);
    const s: TableStar = { ra: 0, dec: 0, magnitude: 0, colour: 0 };
    const v = new Vector3();
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      tableStar(view, i, s);
      catalogueVector(s.ra, s.dec, v);
      for (let k = 0; k < 4; k++) {
        const q = i * 4 + k;
        position.set([v.x, v.y, v.z], q * 3);
        corner.set([corners[k * 2] ?? 0, corners[k * 2 + 1] ?? 0], q * 2);
        shine.set([s.magnitude, s.colour, i, isNamed[i] ?? 0], q * 4);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(position, 3));
    g.setAttribute('corner', new BufferAttribute(corner, 2));
    g.setAttribute('shine', new BufferAttribute(shine, 4));
    g.setIndex(new BufferAttribute(index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.setCount(n);
  }

  /** How many of the table's stars are no fainter than a magnitude: they come first. */
  brighterThan(magnitude: number): number {
    const s: TableStar = { ra: 0, dec: 0, magnitude: 0, colour: 0 };
    let n = 0;
    while (
      this.table !== null &&
      n < this.total &&
      tableStar(this.table, n, s).magnitude <= magnitude + 0.005
    ) {
      n++;
    }
    return n;
  }

  /** Draws the first n stars, the brightest: fewer on a device that can spare less. */
  setCount(n: number): void {
    this.count = Math.min(Math.max(n, 0), this.total);
    this.mesh.geometry.setDrawRange(0, this.count * 6);
  }

  /**
   * Which stars are drawn: -1 all; -2 the named alone; a table index, that
   * star alone, plainly, wherever it is and whatever the hour (the tests).
   */
  setSolo(v: number): void {
    (this.#which.value as Vector3).set(v === -1 ? 1 : 0, v === -2 ? 1 : 0, v >= 0 ? 1 : 0);
    this.#only.value = Math.max(v, 0);
  }

  /** Turns the stars by the module's sky record's matrix, at its offset. */
  turn(record: ArrayLike<number>, at: number): void {
    sceneStarMatrix(record, at, this.matrix.value as Matrix3);
  }

  /** Sets the size of a pixel for a drawing buffer of this size. */
  resize(width: number, height: number): void {
    (this.pixel.value as Vector3).set(2 / Math.max(width, 1), 2 / Math.max(height, 1), 0);
  }

  /** A named star's direction in the scene, as the matrix drawn turns it. */
  direction(p: NamedPlace, out: Vector3): Vector3 {
    catalogueVector(p.ra, p.dec, out);
    return out.applyMatrix3(this.matrix.value as Matrix3);
  }

  /** Whether a named star shows now: out at this hour and above the sea. */
  /** How much the sky's cloud hides a direction from the camera, 0 to 1: a star more than half hidden is not tapped. */
  hidden: ((dir: Vector3) => number) | null = null;

  shows(p: NamedPlace, dir: Vector3): boolean {
    const s =
      this.table === null
        ? null
        : tableStar(this.table, p.index, { ra: 0, dec: 0, magnitude: 0, colour: 0 });
    return (
      s !== null &&
      p.index < this.count &&
      dir.y > -0.02 &&
      (look.starLimit.value as number) - (s.magnitude - NAMED_STEP) + 0.5 > 0.3 &&
      (this.hidden?.(dir) ?? 0) < 0.5
    );
  }

  /**
   * Where a direction is on screen, in CSS pixels from the top left, for a
   * camera and a canvas of this size; z beyond 1 when behind the camera.
   */
  screen(dir: Vector3, camera: Camera, width: number, height: number, out: Vector3): Vector3 {
    out.copy(dir).multiplyScalar(DISTANCE).add(camera.position).project(camera);
    return out.set(((out.x + 1) / 2) * width, ((1 - out.y) / 2) * height, out.z);
  }

  /**
   * The named star nearest a tap at (x, y) CSS pixels, if one shows within
   * reach of it; its name is then shown beside it for a while.
   */
  tap(
    x: number,
    y: number,
    camera: Camera,
    width: number,
    height: number,
    now: number,
  ): NamedPlace | null {
    let best: NamedPlace | null = null;
    let least = TAP_REACH;
    const dir = new Vector3();
    const at = this.#corner;
    for (const p of this.named) {
      this.direction(p, dir);
      if (!this.shows(p, dir)) {
        continue;
      }
      this.screen(dir, camera, width, height, at);
      const d = Math.hypot(at.x - x, at.y - y);
      if (at.z < 1 && d < least) {
        least = d;
        best = p;
      }
    }
    this.#labelled = best;
    this.#labelUntil = best === null ? 0 : now + LABEL_TIME;
    if (this.#label !== null) {
      this.#label.textContent = best?.name ?? '';
      this.#label.hidden = best === null;
    }
    return best;
  }

  /** The element the name is shown in, beside the star. */
  attachLabel(el: HTMLElement): void {
    this.#label = el;
    el.hidden = true;
  }

  /** The name shown, if any. */
  get labelled(): string | null {
    return this.#labelled?.name ?? null;
  }

  /** Keeps the name beside its star, and takes it away when its time is up. */
  placeLabel(camera: Camera, width: number, height: number, now: number): void {
    const el = this.#label;
    const p = this.#labelled;
    if (p === null) {
      return;
    }
    const dir = this.direction(p, new Vector3());
    this.screen(dir, camera, width, height, this.#corner);
    if (now > this.#labelUntil || this.#corner.z >= 1 || !this.shows(p, dir)) {
      this.#labelled = null;
      if (el !== null) {
        el.hidden = true;
      }
      return;
    }
    if (el !== null) {
      el.style.transform = `translate(${Math.round(this.#corner.x + 10)}px, ${Math.round(this.#corner.y - 8)}px)`;
    }
  }
}

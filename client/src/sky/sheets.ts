// SPDX-License-Identifier: AGPL-3.0-only

// Sheet cloud in the sky: cirrus, the middle sheet and low cloud, each a
// layer at its height over the dome. The physics gives each layer's cover
// at the points of a world-fixed lattice, bilinear between them; once a
// second the module's cover over a window of that lattice about the camera
// is written into a texture, and the sky's shader reads it with the same
// bilinear, so what it draws is the field the server has.
//
// For each pixel of the sky the shader finds where its ray meets each
// layer's shell: the paraboloid y = H − d²/2R, the dome's own shape, so a
// sheet meets the bent puffs of the heaped clouds exactly. With the camera
// at height c and k the square of the ray's horizontal part, the ray meets
// it after t = 2(H − c) / (d_y + √(d_y² + 2k(H − c)/R)), which has no
// cancellation looking straight up. There the layer's cover, wobbled by a
// noise, passes a threshold with a crisp edge: a flat tone, as the world's
// other models are, not vapour. Cirrus is streaks along the wind; where it
// is whole and the middle sheet has not yet come, a faint halo of 22°
// rings the sun and the moon, red on its inner edge (Bowditch 3419, 3614);
// through the middle sheet the sun shows as through ground glass, and no
// halo forms (3615); the low cloud hides it.

import {
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import {
  cameraPosition,
  clamp,
  dot,
  exp,
  Fn,
  float,
  floor,
  fract,
  max,
  mix,
  pow,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { WeatherClouds } from '../catalog/types.gen';
import { WEATHER } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { mix as mixBits } from '../predict/weather';
import { DOME_RADIUS } from '../render/materials';

/** The lattice's points a side the texture holds: the module's most. */
export const SHEET_SIDE = WEATHER.sheetSide;

/** The noise's texels a side; it repeats. */
const NOISE_SIDE = 64;

/** How often the texture is written again, s, and how far the camera may stray from its window's middle, in lattice cells. */
const SHEET_EVERY = 1;
const SHEET_STRAY = 6;

/**
 * The layers' look: the threshold their wobbled cover passes, the spread
 * of the crisp edge, and how opaque each is at its whole; cirrus's streaks
 * along and across the wind, m.
 */
export const SHEET_LOOK = {
  cirrus: { from: 0.55, edge: 0.04, most: 0.85, along: 1400, across: 260 },
  middle: { from: 0.3, edge: 0.04, most: 0.93, scale: 1600 },
  low: { from: 0.32, edge: 0.04, most: 0.97, scale: 800 },
};

/** A noise that repeats every NOISE_SIDE texels: each texel a hash of its place, as the physics hashes a lattice. */
function noiseTexture(): DataTexture {
  const n = NOISE_SIDE;
  const data = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      data[j * n + i] = mixBits(Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841)) >>> 24;
    }
  }
  const t = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** The sheets' cover over a window of the lattice, and what draws it. */
export class SheetTexture {
  readonly texture: DataTexture;
  readonly noise = noiseTexture();
  /** The lattice's spacing, m, and the heights of the layers: cirrus, middle, low, m. */
  lattice = 250;
  readonly heights: [number, number, number] = [6000, 1500, 400];
  readonly latticeU = uniform(250);
  readonly heightsU = uniform(new Vector3(6000, 1500, 400));
  /** The window's first point from the floating origin, east and north, m; and 1 if any cover is held. */
  readonly at = uniform(new Vector2());
  readonly on = uniform(0);
  /** The noise's drift with the wind, m east and north, and the wind's way at the cirrus, (sin, cos) of where it blows to. */
  readonly drift = uniform(new Vector2());
  readonly wind = uniform(new Vector2(0, 1));
  /** The window's first lattice point, and the cover held, each point's three layers. */
  i0 = 0;
  j0 = 0;
  readonly values = new Float64Array(3 * SHEET_SIDE * SHEET_SIDE);
  /** Whether any cover is held: with none, the sky has no sheets. */
  any = false;
  readonly #data: Float32Array;
  #last = Number.NEGATIVE_INFINITY;

  constructor() {
    const n = SHEET_SIDE;
    this.#data = new Float32Array(4 * n * n);
    this.texture = new DataTexture(this.#data, n, n, RGBAFormat, FloatType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.needsUpdate = true;
  }

  /** Takes the catalog's clouds: the lattice and the layers' heights. */
  configure(clouds: WeatherClouds): void {
    this.lattice = clouds.lattice;
    this.heights[0] = clouds.cirrus;
    this.heights[1] = clouds.middle;
    this.heights[2] = clouds.low;
    this.latticeU.value = clouds.lattice;
    this.heightsU.value.set(clouds.cirrus, clouds.middle, clouds.low);
  }

  /**
   * Writes the window about the camera again once a second, or once the
   * camera strays from its middle, at a time in ticks and seconds, and
   * brings its place from the floating origin up to date. With no weather
   * there are no sheets.
   */
  update(
    physics: Physics | null,
    tick: number,
    seconds: number,
    cameraEast: number,
    cameraNorth: number,
    originEast: number,
    originNorth: number,
  ): void {
    if (physics === null) {
      this.on.value = 0;
      this.any = false;
      return;
    }
    const L = this.lattice;
    const half = SHEET_SIDE / 2;
    const ci = Math.floor(cameraEast / L);
    const cj = Math.floor(cameraNorth / L);
    const strayed =
      Math.abs(ci - (this.i0 + half)) > SHEET_STRAY ||
      Math.abs(cj - (this.j0 + half)) > SHEET_STRAY;
    if (seconds - this.#last >= SHEET_EVERY || seconds < this.#last || strayed) {
      this.#last = seconds;
      this.i0 = ci - half;
      this.j0 = cj - half;
      physics.windDrawAt(tick);
      const v = physics.sheetGrid(this.i0, this.j0, SHEET_SIDE);
      this.values.set(v);
      let any = false;
      for (let p = 0; p < SHEET_SIDE * SHEET_SIDE; p++) {
        for (let l = 0; l < 3; l++) {
          const x = v[3 * p + l] ?? 0;
          this.#data[4 * p + l] = x;
          any ||= x > 0;
        }
      }
      this.any = any;
      this.texture.needsUpdate = true;
    }
    this.on.value = this.any ? 1 : 0;
    this.at.value.set(this.i0 * L - originEast, this.j0 * L - originNorth);
  }

  /** A layer's cover at a world point, as the texture holds it: the module's bilinear. */
  coverAt(layer: number, east: number, north: number): number {
    const L = this.lattice;
    const u = east / L - this.i0;
    const v = north / L - this.j0;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const at = (a: number, b: number): number => {
      const ca = Math.min(Math.max(a, 0), SHEET_SIDE - 1);
      const cb = Math.min(Math.max(b, 0), SHEET_SIDE - 1);
      return this.values[3 * (cb * SHEET_SIDE + ca) + layer] ?? 0;
    };
    const lo = at(i, j) + fu * (at(i + 1, j) - at(i, j));
    const hi = at(i, j + 1) + fu * (at(i + 1, j + 1) - at(i, j + 1));
    return lo + fv * (hi - lo);
  }

  /**
   * How much the sheets hide a direction from the camera (scene axes, x
   * east, z south), 0 to 1: each layer's cover where the ray meets it, as
   * the shader draws it, without its noise. For a tap on a star.
   */
  hides(
    dir: Vector3,
    cameraHeight: number,
    cameraEast: number,
    cameraNorth: number,
    noiseless = 0.5,
  ): number {
    if (!this.any || dir.y <= 0) {
      return 0;
    }
    let shown = 1;
    const looks = [SHEET_LOOK.cirrus, SHEET_LOOK.middle, SHEET_LOOK.low];
    for (let l = 0; l < 3; l++) {
      const H = (this.heights[l] ?? 0) - cameraHeight;
      const k = dir.x * dir.x + dir.z * dir.z;
      const t = (2 * H) / (dir.y + Math.sqrt(dir.y * dir.y + (2 * k * H) / DOME_RADIUS));
      const cover = this.coverAt(l, cameraEast + t * dir.x, cameraNorth - t * dir.z);
      const lk = looks[l] as { from: number; edge: number; most: number };
      const w = cover * (0.8 + 0.4 * noiseless);
      const a = Math.min(Math.max((w - lk.from) / lk.edge, 0), 1);
      shown *= 1 - a * a * (3 - 2 * a) * lk.most;
    }
    return 1 - shown;
  }
}

/** The cover of a layer at a scene point (x, z), as the module's bilinear of the texture's points. */
const coverOf = (s: SheetTexture, layer: number) =>
  Fn(([p]: [Node<'vec2'>]) => {
    // The point in the window's lattice: east and north of its first point.
    const g = vec2(p.x.sub(s.at.x), p.y.negate().sub(s.at.y)).div(s.latticeU);
    const c = floor(g);
    const f = fract(g);
    const texel = (dx: number, dy: number) =>
      texture(s.texture, c.add(vec2(dx + 0.5, dy + 0.5)).div(SHEET_SIDE)).level(float(0));
    const pick = (t: Node<'vec4'>): Node<'float'> =>
      (layer === 0 ? t.x : layer === 1 ? t.y : t.z) as Node<'float'>;
    const a = pick(texel(0, 0));
    const b = pick(texel(1, 0));
    const d = pick(texel(0, 1));
    const e = pick(texel(1, 1));
    const inside = g.x
      .greaterThan(0)
      .and(g.y.greaterThan(0))
      .and(g.x.lessThan(SHEET_SIDE - 1))
      .and(g.y.lessThan(SHEET_SIDE - 1));
    const v = mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
    return inside.select(v, float(0));
  });

/** Where a ray from the camera along d meets a layer's shell over the dome, H above the sea: its distance along the ray. */
const shellHit = Fn(([d, H]: [Node<'vec3'>, Node<'float'>]) => {
  const h = max(H.sub(cameraPosition.y), 1);
  const k = dot(d.xz, d.xz);
  return h.mul(2).div(d.y.add(sqrt(d.y.mul(d.y).add(k.mul(h).mul(2 / DOME_RADIUS)))));
});

/** The noise at a scene point, from 0 to 1, its texels scale m apart. */
const noiseAt = (s: SheetTexture, p: Node<'vec2'>, scale: number): Node<'float'> =>
  texture(s.noise, p.div(scale * NOISE_SIDE)).level(float(0)).x as Node<'float'>;

/** The colours the layers are drawn in: the clouds' lit top and dark base, display values. */
export interface SheetColours {
  top: Node<'vec3'>;
  base: Node<'vec3'>;
  horizon: Node<'vec3'>;
}

/**
 * The sky in a direction under the sheets: the clear sky's colour c, the
 * cirrus over it, then the middle sheet, then the low cloud, each faded
 * into the horizon's colour toward where it sinks below the horizon. Also
 * how much of the sun's disc shows through them, 0 to 1.
 */
export function sheetsOver(
  s: SheetTexture,
  colours: SheetColours,
  d: Node<'vec3'>,
  c: Node<'vec3'>,
  sun: Node<'vec3'>,
  sunColour: Node<'vec3'>,
  sunUp: Node<'float'>,
): { colour: Node<'vec3'>; disc: Node<'float'> } {
  const out = c.toVar();
  const disc = float(1).toVar();
  const up = d.y.greaterThan(-0.02).and(s.on.greaterThan(0));
  const layer = (index: number, H: Node<'float'>) => {
    const t = shellHit(d, H);
    const p = cameraPosition.xz.add(d.xz.mul(t));
    const cover = coverOf(s, index)(p);
    // Toward its horizon a layer fades into the horizon's colour.
    const far = smoothstep(0.55, 1, length2(d.xz.mul(t)).div(sqrt(H.mul(2 * DOME_RADIUS))));
    return { p, cover, far };
  };
  // The world point's noise frame drifts with the wind.
  const drifted = (p: Node<'vec2'>): Node<'vec2'> => vec2(p.x, p.y.negate()).sub(s.drift);
  const h = s.heightsU;
  const ci = layer(0, h.x);
  const mi = layer(1, h.y);
  const lo = layer(2, h.z);
  {
    const w = drifted(ci.p);
    const along = dot(w, s.wind);
    const across = dot(w, vec2(s.wind.y.negate(), s.wind.x));
    const q = vec2(along.div(SHEET_LOOK.cirrus.along), across.div(SHEET_LOOK.cirrus.across));
    const warp = texture(s.noise, q.mul(0.5 / NOISE_SIDE)).level(float(0)).x;
    const n = texture(s.noise, q.add(vec2(warp.mul(2), 0)).div(NOISE_SIDE)).level(float(0)).x;
    const look = SHEET_LOOK.cirrus;
    const a = ci.cover
      .mul(smoothstep(look.from, look.from + look.edge, n))
      .mul(look.most)
      .mul(float(1).sub(ci.far.mul(0.55)));
    const tone = mix(mix(colours.top, vec3(1, 1, 1), 0.3), colours.horizon, ci.far.mul(0.8));
    out.assign(mix(out, tone, up.select(a, float(0))));
    // A halo of 22° about the sun where the cirrus is whole and no middle
    // sheet has come, red on its inner edge.
    const angle = dot(d, sun);
    const ring = exp(pow(angle.sub(Math.cos((22 * Math.PI) / 180)).div(0.012), 2).negate());
    const inner = smoothstep(Math.cos((21 * Math.PI) / 180), Math.cos((23 * Math.PI) / 180), angle);
    const halo = ring
      .mul(smoothstep(0.6, 0.95, ci.cover))
      .mul(float(1).sub(smoothstep(0.1, 0.3, mi.cover)))
      .mul(sunUp)
      .mul(0.18);
    out.addAssign(
      mix(vec3(1, 0.8, 0.7), vec3(0.85, 0.9, 1), inner)
        .mul(sunColour)
        .mul(up.select(halo, float(0))),
    );
  }
  {
    const look = SHEET_LOOK.middle;
    const n = noiseAt(s, drifted(mi.p), look.scale / 4);
    const shown = smoothstep(look.from, look.from + look.edge, mi.cover.mul(n.mul(0.4).add(0.8)));
    const a = up.select(shown.mul(look.most).mul(float(1).sub(mi.far.mul(0.55))), float(0));
    const tone = mix(
      mix(colours.top.mul(0.92), colours.base, 0.3),
      colours.horizon,
      mi.far.mul(0.8),
    );
    out.assign(mix(out, tone, a));
    // Through it the sun shows as through ground glass: a soft bright patch.
    const sd = max(dot(d, sun), 0);
    out.addAssign(sunColour.mul(pow(sd, 80).mul(0.5).mul(a).mul(sunUp)));
    disc.mulAssign(float(1).sub(a));
  }
  {
    const look = SHEET_LOOK.low;
    const n = noiseAt(s, drifted(lo.p).add(vec2(731, 917)), look.scale / 4);
    const shown = smoothstep(look.from, look.from + look.edge, lo.cover.mul(n.mul(0.4).add(0.8)));
    const a = up.select(shown.mul(look.most).mul(float(1).sub(lo.far.mul(0.55))), float(0));
    const tone = mix(colours.base.mul(1.05), colours.horizon, lo.far.mul(0.8));
    out.assign(mix(out, tone, a));
    disc.mulAssign(float(1).sub(a));
  }
  return { colour: out, disc: clamp(disc, 0, 1) };
}

/** How much of the sky the sheets hide in a direction, 0 to 1, without the halo: for the stars. */
export function sheetsHide(s: SheetTexture, d: Node<'vec3'>): Node<'float'> {
  const looks = [SHEET_LOOK.cirrus, SHEET_LOOK.middle, SHEET_LOOK.low];
  let shown: Node<'float'> = float(1);
  for (let l = 0; l < 3; l++) {
    const t = shellHit(d, l === 0 ? s.heightsU.x : l === 1 ? s.heightsU.y : s.heightsU.z);
    const p = cameraPosition.xz.add(d.xz.mul(t));
    const cover = coverOf(s, l)(p);
    const lk = looks[l] as { from: number; edge: number; most: number };
    const a = smoothstep(lk.from, lk.from + lk.edge, cover).mul(lk.most);
    shown = shown.mul(float(1).sub(a)) as Node<'float'>;
  }
  return d.y.greaterThan(0).and(s.on.greaterThan(0)).select(float(1).sub(shown), float(0));
}

/** The length of a vector of two. */
const length2 = (v: Node<'vec2'>): Node<'float'> => sqrt(dot(v, v)) as Node<'float'>;

/** The sky's sheets: one texture the sky and the stars read. */
export const sheets = new SheetTexture();

// SPDX-License-Identifier: AGPL-3.0-only

// A boat's own look as it is drawn, on the player's boat and on every boat
// of the fleet, of every kind: its topsides in its paint (the varnish shows
// the wood's grain), its sails in their cloth, with the cloth's band, the
// sail number on the main in the cloth's ink (and the machine mark, for a
// machine sailor's boat), and its name in gold leaf on its topsides.
//
// Nothing here is drawn per boat on the CPU but its name: the paints and
// cloths are a palette of uniforms, each boat's places in it and its
// number are values the shaders read (uniforms for the own boat, instance
// values for the fleet's), and the sails' cloth is one texture of masks a
// kind (its shading, the band, the insignia and the mark, a channel each)
// that every cloth is coloured through. The numbers are drawn from one
// texture of the ten digits. A name is lettered into a row of a small
// texture, redrawn only when the name drawn there changes: one row for the
// own boat, a few for the fleet's near boats, none for the far ones.
//
// What a kind's model says, never which kind it is: the topsides are the
// meshes in the TOPSIDES material; the sail the number is on is the one
// whose node carries it (numberedSail), the main unless another says so;
// and where the name goes is the hull's (namePlace): on both bows, unless
// the hull node's extras put it on the transom.

import {
  type BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  type Object3D,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector4,
} from 'three';
import {
  clamp,
  dFdx,
  dFdy,
  float,
  floor,
  fract,
  frontFacing,
  fwidth,
  int,
  mix,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniformArray,
  vec2,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { type BoatLooks, boatLookOf, clothOf, paintOf } from '../catalog/boatlooks';
import { luminance, type MarkPlace, paintMark } from './machinemark';

/** The material a model's painted topsides are in: their vertices carry each plank's tone, the boat its paint. */
export const TOPSIDES = 'topsides';

/** The most paints and cloths a look can name: a look code holds each in 4 bits. */
export const LOOK_PLACES = 16;

/** The insignia's red, on a pale cloth; on a dark one it is in the cloth's ink. */
export const INSIGNIA_RED = '#a3362a';

/** A look's values as they are drawn: its places, number and colours (sRGB, #rrggbb). */
export interface LookDrawn {
  /** Its paint's and cloth's places in the catalog's lists, and its sail number, 0 for none. */
  paint: number;
  cloth: number;
  number: number;
  /** The topsides' paint, and whether it shows the wood's grain. */
  hull: string;
  grain: boolean;
  /** The sails' cloth, its band (null for none), the ink of its number and mark, and the insignia's colour. */
  sail: string;
  band: string | null;
  ink: string;
  insignia: string;
  /** The sail number as lettered on the main; "" for none. */
  numberText: string;
}

/** A place in a list of n, or the first for one past its end. */
export function placeIn(i: number, n: number): number {
  return i >= 0 && i < n ? i : 0;
}

/** A sail number as lettered: "" for none (0), else its digits. */
export function numberText(n: number): string {
  return n > 0 ? String(Math.floor(n)) : '';
}

/** The insignia's colour on a cloth: red on a pale cloth, the cloth's ink on a dark one. */
export function insigniaOn(cloth: string, ink: string): string {
  return luminance(cloth) > 0.18 ? INSIGNIA_RED : ink;
}

/** A look code's values as they are drawn; a negative code (none told) is the first paint and cloth with no number. */
export function lookDrawn(cat: BoatLooks, code: number): LookDrawn {
  const l = boatLookOf(code);
  const { paints, cloths, numbers } = cat.boatLooks;
  const paint = placeIn(l.paint, paints.length);
  const cloth = placeIn(l.cloth, cloths.length);
  const number = l.number <= numbers ? l.number : 0;
  const p = paintOf(cat, paint);
  const c = clothOf(cat, cloth);
  return {
    paint,
    cloth,
    number,
    hull: p.colour,
    grain: p.grain === true,
    sail: c.colour,
    band: c.band ?? null,
    ink: c.ink,
    insignia: insigniaOn(c.colour, c.ink),
    numberText: numberText(number),
  };
}

/**
 * Writes a look code's places and number, as the shaders read them, at
 * out[o … o+2]: the paint's place, the cloth's and the sail number. No
 * allocation: the fleet writes every boat's each frame.
 */
export function writeLook(cat: BoatLooks, code: number, out: Float32Array, o: number): void {
  if (code < 0) {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    return;
  }
  const { paints, cloths, numbers } = cat.boatLooks;
  const n = (code >> 8) & 0x3fff;
  out[o] = placeIn(code & 15, paints.length);
  out[o + 1] = placeIn((code >> 4) & 15, cloths.length);
  out[o + 2] = n <= numbers ? n : 0;
}

/** Where each of the palette's lists starts. */
const AT = { paint: 0, cloth: 1, band: 2, ink: 3, insignia: 4 } as const;

/**
 * The catalog's paints and cloths as uniforms, linear: each paint's colour
 * and 1 where it shows the grain; each cloth's colour and 1 where it has a
 * band, its band, its ink and its insignia's colour.
 */
export class LookPalette {
  readonly values: Vector4[];
  readonly node: ReturnType<typeof uniformArray>;

  constructor(cat: BoatLooks) {
    this.values = Array.from({ length: 5 * LOOK_PLACES }, () => new Vector4(1, 1, 1, 0));
    const set = (list: number, i: number, hex: string, w: number): void => {
      const c = new Color(hex);
      (this.values[list * LOOK_PLACES + i] as Vector4).set(c.r, c.g, c.b, w);
    };
    cat.boatLooks.paints.slice(0, LOOK_PLACES).forEach((p, i) => {
      set(AT.paint, i, p.colour, p.grain === true ? 1 : 0);
    });
    cat.boatLooks.cloths.slice(0, LOOK_PLACES).forEach((c, i) => {
      set(AT.cloth, i, c.colour, c.band === undefined ? 0 : 1);
      set(AT.band, i, c.band ?? c.colour, 0);
      set(AT.ink, i, c.ink, 0);
      set(AT.insignia, i, insigniaOn(c.colour, c.ink), 0);
    });
    this.node = uniformArray(this.values, 'vec4');
  }

  /** A list's entry at a place (a float node). */
  at(list: keyof typeof AT, place: Node<'float'>): Node<'vec4'> {
    const i = int(place.add(AT[list] * LOOK_PLACES + 0.5));
    return (this.node as unknown as { element(i: unknown): Node<'vec4'> }).element(i);
  }
}

const palettes = new WeakMap<object, LookPalette>();

/** The palette of a catalog's looks, made once. */
export function lookPalette(cat: BoatLooks): LookPalette {
  let p = palettes.get(cat.boatLooks);
  if (p === undefined) {
    p = new LookPalette(cat);
    palettes.set(cat.boatLooks, p);
  }
  return p;
}

/**
 * A boat's look as the shaders read it: its paint's and cloth's places, its
 * sail number (0 for none), its name's row in its name texture (−1 for
 * none) and 1 for a machine sailor's boat.
 */
export interface LookNodes {
  paint: Node<'float'>;
  cloth: Node<'float'>;
  number: Node<'float'>;
  row: Node<'float'>;
  machine: Node<'float'>;
}

// --- The hull ----------------------------------------------------------------

/**
 * The wood's grain under varnish, a shade about 1 at a point of the hull
 * in its model's frame, metres: streaks running fore and aft along the
 * planks, wandering a little, and a fine figure among them; each faded to
 * its mean where it is finer than a pixel, so that it never shimmers.
 */
export function woodGrain(at: Node<'vec3'>): Node<'float'> {
  const t = at.y
    .mul(64)
    .add(sin(at.z.mul(1.3).add(at.y.mul(9))).mul(1.8))
    .add(sin(at.z.mul(0.37)).mul(2.6));
  const streak = smoothstep(0.35, 1, sin(t).mul(0.5).add(0.5));
  const keep = float(1).sub(smoothstep(0.5, 1.6, fwidth(t)));
  const f = at.y.mul(430).add(sin(at.z.mul(4.1)).mul(3));
  const keepFine = float(1).sub(smoothstep(0.5, 1.6, fwidth(f)));
  // The streaks' mean, about a quarter dark: what is left far off.
  const coarse = mix(float(0.93), float(1).sub(streak.mul(0.26)), keep);
  return coarse.add(sin(f).mul(0.05).mul(keepFine)) as unknown as Node<'float'>;
}

/**
 * Where a hull carries its name: on both bows, read from outside on each,
 * or across the transom; its middle, in the model's frame, metres, and the
 * box the name is lettered in, width along the hull (or across the
 * transom) and height.
 */
export interface NamePlace {
  on: 'bows' | 'transom';
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

/** A name's row's width over its height, as the name texture draws it. */
export const NAME_ASPECT = 8;

/** The name's station, as a share of the topsides' length aft of their fore end, and its box's most length. */
const NAME_AT = 0.2;
const NAME_MOST = 0.24;
/** The least height above the waterline (the model's y = 0) the name's box keeps, metres. */
const NAME_ABOVE = 0.03;

/**
 * Where a hull carries its name, from its topsides' vertices (x, y, z
 * triples in the model's frame, the waterline at y = 0): on both bows, a
 * fifth of the topsides' length aft of their fore end, in the middle of
 * their height above the water there; or, where the hull's extras say
 * {"name": {"on": "transom"}}, across its after end. The box is
 * NAME_ASPECT times as wide as it is high, at most half that height and
 * NAME_MOST of the topsides' length (or 80% of the transom's breadth).
 */
export function namePlace(positions: ArrayLike<number>, extras?: unknown): NamePlace | null {
  const n = Math.floor(positions.length / 3);
  if (n === 0) {
    return null;
  }
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const z = positions[i * 3 + 2] ?? 0;
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  const length = zMax - zMin;
  const on = (extras as { name?: { on?: unknown } } | undefined)?.name?.on;
  const transom = on === 'transom';
  // The station the name is at, and the topsides' height above the water there.
  const z = transom ? zMax : zMin + NAME_AT * length;
  const near = transom ? 0.02 * length : 0.04 * length;
  let yLo = Number.POSITIVE_INFINITY;
  let yHi = Number.NEGATIVE_INFINITY;
  let across = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs((positions[i * 3 + 2] ?? 0) - z) <= near) {
      const y = positions[i * 3 + 1] ?? 0;
      yLo = Math.min(yLo, y);
      yHi = Math.max(yHi, y);
      across = Math.max(across, Math.abs(positions[i * 3] ?? 0));
    }
  }
  yLo = Math.max(yLo, NAME_ABOVE);
  if (!(yHi > yLo)) {
    return null;
  }
  const most = transom ? 1.6 * across : NAME_MOST * length;
  const height = Math.min(0.5 * (yHi - yLo), most / NAME_ASPECT);
  return {
    on: transom ? 'transom' : 'bows',
    x: 0,
    y: (yLo + yHi) / 2,
    z,
    width: NAME_ASPECT * height,
    height,
  };
}

/** A hull's name texture: its rows, and where on the hull the name goes. */
export interface HullName {
  texture: Texture;
  rows: number;
  place: NamePlace;
}

/**
 * The name's gold at a point of the hull, and how much of it there is
 * (0 … 1), from its row of the name texture; none where the row is −1.
 */
export function nameAt(at: Node<'vec3'>, row: Node<'float'>, name: HullName): Node<'vec4'> {
  const p = name.place;
  let u: Node<'float'>;
  let on: Node<'float'>;
  if (p.on === 'transom') {
    // Read from astern: its letters run to starboard.
    u = at.x.sub(p.x).div(p.width).add(0.5) as unknown as Node<'float'>;
    on = step(p.z - 0.05, at.z) as unknown as Node<'float'>;
  } else {
    // Read from outside on each bow: forward is to the right on the
    // starboard bow, aft on the port one.
    const side = select(at.x.lessThan(0), float(-1), float(1));
    u = float(p.z).sub(at.z).mul(side).div(p.width).add(0.5) as unknown as Node<'float'>;
    on = float(1) as unknown as Node<'float'>;
  }
  const v = at.y.sub(p.y).div(p.height).add(0.5);
  const inside = step(0, u)
    .mul(step(u, 1))
    .mul(step(0, v))
    .mul(step(v, 1))
    .mul(step(-0.5, row))
    .mul(on);
  const rows = name.rows;
  // The texture's rows run down from its top, which is v = 1.
  const tv = float(rows - 1)
    .sub(row)
    .add(clamp(v, 0, 1))
    .div(rows);
  const g = texture(name.texture, vec2(clamp(u, 0, 1), tv)) as unknown as Node<'vec4'>;
  return vec4(g.rgb, g.a.mul(inside)) as unknown as Node<'vec4'>;
}

/**
 * The topsides' colour at a point of the hull in its model's frame (to be
 * multiplied by its planks' tones): the boat's paint, through the grain
 * where it is varnish, and its name in gold where it carries one.
 */
export function hullColour(
  palette: LookPalette,
  look: LookNodes,
  at: Node<'vec3'>,
  name: HullName | null,
): Node<'vec3'> {
  const p = palette.at('paint', look.paint);
  const painted = p.rgb.mul(mix(float(1), woodGrain(at), p.w));
  if (name === null) {
    return painted as unknown as Node<'vec3'>;
  }
  const g = nameAt(at, look.row, name);
  return mix(painted, g.rgb, g.a) as unknown as Node<'vec3'>;
}

// --- The sails ---------------------------------------------------------------

/** The band across a cloth that has one, as fractions of the luff from the foot. */
export const BAND = { from: 0.13, to: 0.2 } as const;

/** The sail number's digits' height, as a fraction of the foot, and their width over their height. */
export const DIGIT_HEIGHT = 0.105;
export const DIGIT_ASPECT = 0.62;

/**
 * Where a sail's numbers go, as fractions of its foot (u) and of its luff
 * (v): one on each face, the starboard's (the front face's) above the
 * port's, each read from its own side, each the middle of its row of
 * digits; and a digit's width and height.
 */
export interface NumberPlace {
  front: { u: number; v: number };
  back: { u: number; v: number };
  du: number;
  dv: number;
}

/** The numbers' heights on a sail, fractions of its luff from the foot: the front face's, and the back's. */
export const NUMBER_V = { front: 0.64, back: 0.35 } as const;

/** A sail's numbers' places, for its foot and luff, metres, and its chord at a height (a fraction of the foot). */
export function numberPlace(
  foot: number,
  luff: number,
  chordAt: (v: number) => number,
): NumberPlace {
  return {
    front: { u: chordAt(NUMBER_V.front) / 2, v: NUMBER_V.front },
    back: { u: chordAt(NUMBER_V.back) / 2, v: NUMBER_V.back },
    du: DIGIT_HEIGHT * DIGIT_ASPECT,
    dv: (DIGIT_HEIGHT * foot) / luff,
  };
}

/**
 * Which of a model's sails carries the sail number: the one whose node's
 * extras say {"number": true}, or else the main (the node named "sail").
 */
export function numberedSail(nodes: Iterable<Object3D>): string {
  for (const o of nodes) {
    if ((o.userData as { number?: unknown }).number === true) {
      return o.name;
    }
  }
  return 'sail';
}

/** Digits' cells in the digits' texture: each this wide and high, in pixels. */
const DIGIT_W = 64;
const DIGIT_H = 104;

let digitTexture: CanvasTexture | null = null;

/** The ten digits, white on black, in a row of cells: drawn once, for every sail. */
export function digits(): CanvasTexture {
  if (digitTexture !== null) {
    return digitTexture;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 10 * DIGIT_W;
  canvas.height = DIGIT_H;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(DIGIT_H * 0.82)}px "Times New Roman", Times, serif`;
  for (let d = 0; d < 10; d++) {
    g.fillText(String(d), (d + 0.5) * DIGIT_W, DIGIT_H * 0.54, DIGIT_W * 0.92);
  }
  const t = new CanvasTexture(canvas);
  t.colorSpace = NoColorSpace;
  t.anisotropy = 4;
  digitTexture = t;
  return t;
}

/**
 * How much of the sail number's ink is at a point of the cloth (u along
 * the foot, v up the luff), 0 … 1: the front face's row, or the back's,
 * read from its own side; none for number 0. mirrored says the front face
 * reads its u from right to left.
 */
export function numberInk(
  place: NumberPlace,
  digitsTexture: Texture,
  n: Node<'float'>,
  at: Node<'vec2'>,
  mirrored: boolean,
): Node<'float'> {
  const count = select(
    n.greaterThan(999.5),
    float(4),
    select(n.greaterThan(99.5), float(3), select(n.greaterThan(9.5), float(2), float(1))),
  );
  const { front, back, du, dv } = place;
  const fs = mirrored ? -1 : 1;
  const xf = at.x.sub(front.u).mul(fs / du);
  const xb = at.x.sub(back.u).mul(-fs / du);
  const x = select(frontFacing, xf, xb).add(count.mul(0.5));
  const y = at.y
    .sub(select(frontFacing, float(front.v), float(back.v)))
    .div(dv)
    .add(0.5);
  const k = floor(x);
  // The digit's power of ten, from the left: 10^(count − 1 − k).
  const e = count.sub(1).sub(k);
  const p = select(
    e.lessThan(0.5),
    float(1),
    select(e.lessThan(1.5), float(10), select(e.lessThan(2.5), float(100), float(1000))),
  );
  const q = floor(n.add(0.5).div(p));
  const d = q.sub(floor(q.add(0.5).div(10)).mul(10));
  const inside = step(0, x).mul(step(x, count)).mul(step(0, y)).mul(step(y, 1)).mul(step(0.5, n));
  // Sampled at the mip level of the digits' own scale: the jump in the
  // texture's coordinate at each digit's edge would otherwise read there
  // as a fine line.
  const cont = vec2(x.div(10), y);
  const g = (
    texture(
      digitsTexture,
      vec2(
        clamp(d, 0, 9)
          .add(clamp(fract(x), 0.02, 0.98))
          .div(10),
        clamp(y, 0, 1),
      ),
    ) as unknown as { grad(x: unknown, y: unknown): Node<'vec4'> }
  ).grad(dFdx(cont), dFdy(cont));
  return g.r.mul(inside) as unknown as Node<'float'>;
}

/** What a sail is drawn with: its cloth's masks, and its number's place and digits, if it carries the number. */
export interface SailPrint {
  masks: Texture;
  number: { place: NumberPlace; digits: Texture; mirrored: boolean } | null;
}

/**
 * A sail's colour at a point of its cloth (uv: u along the foot, v up the
 * luff): the cloth's, its band where it has one, the insignia, the machine
 * mark for a machine sailor's boat and the sail number, in the cloth's
 * ink, all shaded by the cloth's seams and reef points.
 */
export function clothColour(
  palette: LookPalette,
  look: LookNodes,
  at: Node<'vec2'>,
  print: SailPrint,
): Node<'vec3'> {
  const m = texture(print.masks, at) as unknown as Node<'vec4'>;
  const cloth = palette.at('cloth', look.cloth);
  const ink = palette.at('ink', look.cloth).rgb;
  let c = mix(cloth.rgb, palette.at('band', look.cloth).rgb, m.g.mul(cloth.w));
  c = mix(c, palette.at('insignia', look.cloth).rgb, m.b);
  c = mix(c, ink, m.a.mul(look.machine));
  if (print.number !== null) {
    const { place, digits: d, mirrored } = print.number;
    c = mix(c, ink, numberInk(place, d, look.number, at, mirrored));
  }
  return c.mul(m.r) as unknown as Node<'vec3'>;
}

/** The cloth's masks' size: its width the foot, its height the luff, at the same scale. */
export const MASK_WIDTH = 512;
export const MASK_HEIGHT = 960;

/**
 * What a sail's masks carry: its insignia (none for ""), its reef rows, and
 * the machine mark's place (none for a sail without); and whether its
 * cloths run up and down, as a square sail's do, not square to the leech.
 */
export interface MaskParts {
  insignia: string;
  reefRows: readonly number[];
  mark: MarkPlace | null;
  upright?: boolean;
}

/**
 * A sail's masks, as a texture its cloth is coloured through, its width the
 * foot and its height the luff: in red, the cloth's shade (its panels'
 * seams, its reef points), as a linear factor; in green, the band; in blue,
 * the insignia; in alpha, the machine mark. Drawn once a kind.
 */
export function clothMasks(parts: MaskParts, width = MASK_WIDTH, height = MASK_HEIGHT): Texture {
  const layer = (
    draw: (g: CanvasRenderingContext2D) => void,
    ground: string,
  ): Uint8ClampedArray => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    g.fillStyle = ground;
    g.fillRect(0, 0, width, height);
    draw(g);
    return g.getImageData(0, 0, width, height).data;
  };
  const shade = layer(
    (g) => paintShade(g, width, height, parts.reefRows, parts.upright === true),
    '#fff',
  );
  const band = layer((g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, (1 - BAND.to) * height, width, (BAND.to - BAND.from) * height);
  }, '#000');
  const insignia =
    parts.insignia === ''
      ? null
      : layer((g) => paintInsignia(g, width, height, parts.insignia), '#000');
  const mark =
    parts.mark === null
      ? null
      : layer((g) => paintMark(g, parts.mark as MarkPlace, width, height, '#fff'), '#000');
  const data = new Uint8Array(width * height * 4);
  // sRGB shades as linear factors: the cloth's colour is linear.
  const linear = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    linear[i] = Math.round(255 * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  }
  for (let y = 0; y < height; y++) {
    // The texture's first row is its bottom: the foot.
    const from = (height - 1 - y) * width * 4;
    const to = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      data[to + x] = linear[shade[from + x] ?? 255] ?? 255;
      data[to + x + 1] = band[from + x] ?? 0;
      data[to + x + 2] = insignia === null ? 0 : (insignia[from + x] ?? 0);
      data[to + x + 3] = mark === null ? 0 : (mark[from + x] ?? 0);
    }
  }
  const t = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * The cloth's shade: panel seams square to the leech (or up and down, its
 * cloths upright), and a row of reef points at each reef row's height.
 */
function paintShade(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  reefRows: readonly number[],
  upright = false,
): void {
  g.strokeStyle = 'rgba(70, 70, 70, 0.28)';
  g.lineWidth = Math.max(1, (2 / 512) * width);
  if (upright) {
    // A square sail's cloths, about a thirtieth of its width each.
    const gap = width / 30;
    for (let x = gap; x < width; x += gap) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
  } else {
    // The seams: a panel's width in proportion to the cloth.
    const gap = (62 / 960) * height;
    const drop = (70 / 512) * width;
    for (let y = (40 / 960) * height; y < height + drop; y += gap) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y - drop);
      g.stroke();
    }
  }
  // The reef points: a band of reinforcing cloth and short ties.
  for (const v of reefRows) {
    const y = (1 - v) * height;
    g.fillStyle = 'rgba(200, 200, 200, 0.9)';
    g.fillRect(0, y - 5, width, 10);
    g.fillStyle = '#4a4a4a';
    for (let x = 0.05 * width; x < width; x += 0.075 * width) {
      g.fillRect(x - 1.5, y - 9, 3, 18);
    }
  }
}

/** The class insignia in a ring, 17% of the foot across, near the head. */
function paintInsignia(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  insignia: string,
): void {
  const cx = 0.115 * width;
  const cy = 0.2 * height;
  const r = 0.085 * width;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(cx, cy, r, 0, 2 * Math.PI);
  g.stroke();
  g.font = `bold ${Math.round(r * 1.3)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(insignia, cx, cy + r * 0.06);
}

// --- Names -------------------------------------------------------------------

/**
 * Which name each row of a name texture holds, and which rows are wanted
 * this frame: a name already in a row keeps it; a new one takes the row
 * least lately used that no boat wants this frame, which must then be
 * redrawn. Nothing is allocated once made.
 */
export class NameRows {
  readonly names: string[];
  /** The frame each row was last wanted in. */
  readonly #used: Float64Array;
  /** Rows given a new name since last asked: to be drawn. */
  readonly #stale: Uint8Array;

  constructor(readonly rows: number) {
    this.names = Array.from({ length: rows }, () => '');
    this.#used = new Float64Array(rows).fill(Number.NEGATIVE_INFINITY);
    this.#stale = new Uint8Array(rows);
  }

  /** The row holding a name this frame; −1 for no name, or none free. */
  rowOf(name: string, frame: number): number {
    if (name === '') {
      return -1;
    }
    let free = -1;
    for (let r = 0; r < this.rows; r++) {
      if (this.names[r] === name) {
        this.#used[r] = frame;
        return r;
      }
      const u = this.#used[r] ?? 0;
      if (u < frame && (free < 0 || u < (this.#used[free] ?? 0))) {
        free = r;
      }
    }
    if (free < 0) {
      return -1;
    }
    this.names[free] = name;
    this.#used[free] = frame;
    this.#stale[free] = 1;
    return free;
  }

  /** Calls draw for each row given a new name since last called. */
  drawStale(draw: (row: number, name: string) => void): number {
    let n = 0;
    for (let r = 0; r < this.rows; r++) {
      if (this.#stale[r] === 1) {
        this.#stale[r] = 0;
        draw(r, this.names[r] ?? '');
        n++;
      }
    }
    return n;
  }
}

/** A name texture's row, in pixels. */
const NAME_W = 512;
const NAME_H = NAME_W / NAME_ASPECT;

/**
 * Boats' names, each lettered into a row of one small texture in gold
 * leaf: rows kept by name (NameRows), each redrawn only when it is given a
 * new name. Its canvas is made the first time a name is asked for.
 */
export class NameAtlas {
  readonly rows: NameRows;
  readonly texture: CanvasTexture;
  /** How many times a row has been lettered: the tests' count of redraws. */
  drawn = 0;
  readonly #canvas: HTMLCanvasElement;
  readonly #gold: string;

  constructor(rows: number, gold: string) {
    this.rows = new NameRows(rows);
    this.#gold = gold;
    this.#canvas = document.createElement('canvas');
    this.#canvas.width = NAME_W;
    this.#canvas.height = NAME_H * rows;
    this.texture = new CanvasTexture(this.#canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  /** The row holding a name this frame; −1 for none. */
  rowOf(name: string, frame: number): number {
    return this.rows.rowOf(name, frame);
  }

  /** Letters the rows given new names, and uploads the texture if any were. */
  commit(): void {
    const g = this.#canvas.getContext('2d', {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D;
    const n = this.rows.drawStale((row, name) => {
      const y = row * NAME_H;
      g.clearRect(0, y, NAME_W, NAME_H);
      if (name === '') {
        return;
      }
      g.save();
      g.beginPath();
      g.rect(0, y, NAME_W, NAME_H);
      g.clip();
      let size = NAME_H * 0.72;
      g.font = `italic bold ${size}px Georgia, serif`;
      const w = g.measureText(name).width;
      if (w > NAME_W * 0.94) {
        size *= (NAME_W * 0.94) / w;
        g.font = `italic bold ${size}px Georgia, serif`;
      }
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // Gold leaf, edged dark so that it reads on a pale paint.
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2, size * 0.09);
      g.strokeStyle = 'rgba(40, 26, 10, 0.85)';
      g.strokeText(name, NAME_W / 2, y + NAME_H * 0.54);
      g.fillStyle = this.#gold;
      g.fillText(name, NAME_W / 2, y + NAME_H * 0.54);
      g.restore();
      this.drawn++;
    });
    if (n > 0) {
      this.texture.needsUpdate = true;
    }
  }
}

/** A geometry's positions, as namePlace reads them. */
export function positionsOf(g: BufferGeometry): ArrayLike<number> {
  return g.getAttribute('position').array as ArrayLike<number>;
}

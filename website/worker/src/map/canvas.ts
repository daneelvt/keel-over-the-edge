// SPDX-License-Identifier: AGPL-3.0-only

// A 2D canvas that is a sheet laid on the chart's paper and seen through
// the chart's camera: what the game's painters draw on it (paintPaper,
// paintWeather and the rest, client/src/chart) is written as SVG, every
// point carried from the canvas to the paper and through the camera to the
// screen. Straight lines stay straight under the camera, so a line's ends
// are enough; a circle becomes the ellipse the camera sees it as, written
// as SVG's arcs; text is laid on the paper as the chart's texture lays it,
// foreshortened by the camera at its place. It is the part of
// CanvasRenderingContext2D those painters use, nothing more.

import { circleOnScreen, invert, type Mat3, type Px, type View } from './camera';
import type { Face } from './letters';
import { advanceOf, type Ink, n1, type Svg } from './svg';

/** The faces the painters name, roman and italic. */
export interface Faces {
  roman: Face;
  italic: Face;
}

/** A colour as the painters write it, #rrggbb or rgb(r g b / a%) or rgba(r, g, b, a): #rrggbb and its alpha. */
export function parseColour(c: string): [string, number] {
  if (c.startsWith('#')) {
    return [c.slice(0, 7).toLowerCase(), 1];
  }
  const nums = c.match(/-?[\d.]+%?/g) ?? [];
  const v = nums.map((t) => Number.parseFloat(t));
  const hex = (x: number) =>
    Math.round(Math.min(Math.max(x, 0), 255))
      .toString(16)
      .padStart(2, '0');
  let a = 1;
  const last = nums[3];
  if (last !== undefined) {
    a = last.endsWith('%') ? (v[3] ?? 100) / 100 : (v[3] ?? 1);
  }
  return [`#${hex(v[0] ?? 0)}${hex(v[1] ?? 0)}${hex(v[2] ?? 0)}`, a];
}

/** An sRGB channel, 0 to 255, in linear light, 0 to 1, and back. */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function toSrgb(l: number): number {
  return 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
}

/**
 * The opacity at which colour, blended over base as a canvas or an SVG
 * blends (in sRGB), looks as it does blended at opacity in linear light,
 * as the GPU lays one texture over another: judged on the channel where
 * the two colours differ most.
 */
export function linearOpacity(colour: string, opacity: number, base: string): number {
  if (opacity >= 0.999 || opacity <= 0) {
    return opacity;
  }
  const c = parseColour(colour)[0];
  const b = parseColour(base)[0];
  let best = 0;
  let at = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(
      Number.parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16) -
        Number.parseInt(b.slice(1 + 2 * i, 3 + 2 * i), 16),
    );
    if (d > best) {
      best = d;
      at = i;
    }
  }
  if (best < 8) {
    return opacity;
  }
  const cs = Number.parseInt(c.slice(1 + 2 * at, 3 + 2 * at), 16);
  const bs = Number.parseInt(b.slice(1 + 2 * at, 3 + 2 * at), 16);
  const seen = toSrgb((1 - opacity) * toLinear(bs) + opacity * toLinear(cs));
  return Math.min(Math.max((bs - seen) / (bs - cs), 0), 1);
}

/** An affine transform, a b c d e f as the canvas's own. */
type Affine = [number, number, number, number, number, number];

function apply(t: Affine, x: number, y: number): Px {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

function multiply(t: Affine, u: Affine): Affine {
  return [
    t[0] * u[0] + t[2] * u[1],
    t[1] * u[0] + t[3] * u[1],
    t[0] * u[2] + t[2] * u[3],
    t[1] * u[2] + t[3] * u[3],
    t[0] * u[4] + t[2] * u[5] + t[4],
    t[1] * u[4] + t[3] * u[5] + t[5],
  ];
}

interface State {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  dash: number[];
  transform: Affine;
  clip: string | null;
}

/** Lines narrower than this on the screen, px, are thin: the GPU's blending of their edges pales them. */
const THIN = 2;

/** Circles smaller than this on the screen, px, are dots: a round cap of a stroke as wide. */
const DOT = 2;

/** A text stroked and waiting for its fill: a halo, printed with it as one. */
interface PendingStroke {
  text: string;
  x: number;
  y: number;
  colour: string;
  alpha: number;
  width: number;
  font: string;
  transform: Affine;
}

export class SheetContext {
  /** The canvas it draws on: its width is the painters' side. */
  readonly canvas: { width: number; height: number };
  /** Very small rectangles filled are left out: a canvas's grain of single pixels. */
  dropSpecks = false;
  /** Called at the first speck left out: where the grain belongs. */
  onSpecks: (() => void) | null = null;
  /** A filter's id for what is filled, or none. */
  filter = 'none';
  /**
   * The colour the sheet lies over, when the chart lays it over the paper
   * as the GPU does, blending in linear light: what is not opaque is then
   * paler than a canvas's blending makes it, and each opacity is brought
   * to the one that matches over this colour. Null for none.
   */
  linearOver: string | null = null;
  imageSmoothingEnabled = true;

  readonly #svg: Svg;
  readonly #view: View;
  readonly #inverse: Mat3;
  readonly #faces: Faces;
  /** Metres a canvas pixel, and the paper's half side, m. */
  readonly #metres: number;
  readonly #half: number;
  #s: State = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    font: '10px serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    dash: [],
    transform: [1, 0, 0, 1, 0, 0],
    clip: null,
  };
  readonly #stack: State[] = [];
  /** The path: its data on the screen, its dots, where it starts and is, on the canvas. */
  #d = '';
  #dots: [number, number, number][] = [];
  #start: Px | null = null;
  #at: Px | null = null;
  /** The canvas point the path began at; the box about its points, for its strokes' scale. */
  #first: Px | null = null;
  #box: [number, number, number, number] | null = null;
  #pending: PendingStroke | null = null;

  /**
   * A sheet of side px drawn on the paper's square, extent m from the
   * centre each way, seen by view, written into svg.
   */
  constructor(svg: Svg, view: View, side: number, extent: number, faces: Faces) {
    this.#svg = svg;
    this.#view = view;
    this.#inverse = invert(view.plane);
    this.#faces = faces;
    this.canvas = { width: side, height: side };
    this.#metres = (2 * extent) / side;
    this.#half = side / 2;
  }

  /** The canvas's own getContext: itself. */
  getContext(): this {
    return this;
  }

  // The state, as the canvas's properties.
  get fillStyle(): string {
    return this.#s.fillStyle;
  }
  set fillStyle(v: string) {
    this.#s.fillStyle = v;
  }
  get strokeStyle(): string {
    return this.#s.strokeStyle;
  }
  set strokeStyle(v: string) {
    this.#s.strokeStyle = v;
  }
  get lineWidth(): number {
    return this.#s.lineWidth;
  }
  set lineWidth(v: number) {
    this.#s.lineWidth = v;
  }
  get lineCap(): State['lineCap'] {
    return this.#s.lineCap;
  }
  set lineCap(v: State['lineCap']) {
    this.#s.lineCap = v;
  }
  get lineJoin(): State['lineJoin'] {
    return this.#s.lineJoin;
  }
  set lineJoin(v: State['lineJoin']) {
    this.#s.lineJoin = v;
  }
  get globalAlpha(): number {
    return this.#s.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.#s.globalAlpha = v;
  }
  get font(): string {
    return this.#s.font;
  }
  set font(v: string) {
    this.#s.font = v;
  }
  get textAlign(): string {
    return this.#s.textAlign;
  }
  set textAlign(v: string) {
    this.#s.textAlign = v;
  }
  get textBaseline(): string {
    return this.#s.textBaseline;
  }
  set textBaseline(v: string) {
    this.#s.textBaseline = v;
  }

  setLineDash(d: number[]): void {
    this.#s.dash = [...d];
  }

  save(): void {
    this.#stack.push({ ...this.#s, dash: [...this.#s.dash] });
  }

  restore(): void {
    const s = this.#stack.pop();
    if (s !== undefined) {
      this.#s = s;
    }
  }

  translate(x: number, y: number): void {
    this.#s.transform = multiply(this.#s.transform, [1, 0, 0, 1, x, y]);
  }

  rotate(a: number): void {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.#s.transform = multiply(this.#s.transform, [c, s, -s, c, 0, 0]);
  }

  scale(x: number, y: number): void {
    this.#s.transform = multiply(this.#s.transform, [x, 0, 0, y, 0, 0]);
  }

  /** A canvas point, before the transform, on the paper, m east and north. */
  #paper(x: number, y: number): Px {
    const [cx, cy] = apply(this.#s.transform, x, y);
    return [(cx - this.#half) * this.#metres, (this.#half - cy) * this.#metres];
  }

  /** A canvas point, before the transform, on the screen. */
  #screen(x: number, y: number): Px {
    const [e, n] = this.#paper(x, y);
    return this.#view.project(e, n);
  }

  /** Screen px a canvas px at a canvas point, before the transform: how lines and dashes are scaled. */
  #scaleAt(p: Px | null): number {
    const [x, y] = p ?? [this.#half, this.#half];
    const a = this.#screen(x, y);
    const b = this.#screen(x + 1, y);
    const c = this.#screen(x, y + 1);
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.sqrt(Math.abs(det));
  }

  beginPath(): void {
    this.#d = '';
    this.#dots = [];
    this.#start = null;
    this.#at = null;
    this.#first = null;
    this.#box = null;
  }

  /** Takes a canvas point, before the transform, into the path's box. */
  #grow(x: number, y: number): void {
    const b = this.#box;
    this.#box =
      b === null
        ? [x, y, x, y]
        : [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  }

  moveTo(x: number, y: number): void {
    this.#grow(x, y);
    const [sx, sy] = this.#screen(x, y);
    this.#d += `M${n1(sx)} ${n1(sy)}`;
    this.#start = [x, y];
    this.#at = [x, y];
    this.#first ??= [x, y];
  }

  lineTo(x: number, y: number): void {
    if (this.#at === null) {
      this.moveTo(x, y);
      return;
    }
    this.#grow(x, y);
    const [sx, sy] = this.#screen(x, y);
    this.#d += `L${n1(sx)} ${n1(sy)}`;
    this.#at = [x, y];
  }

  closePath(): void {
    if (this.#start !== null) {
      this.#d += 'Z';
      this.#at = this.#start;
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise = false): void {
    const t = this.#s.transform;
    const scale = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
    const [e, n] = this.#paper(x, y);
    const rm = r * scale * this.#metres;
    // The end angle as browsers take it (Chromium's adjustEndAngle): a
    // turn or more is the whole circle, either way; else the way asked,
    // less than a turn.
    const TURN = 2 * Math.PI;
    let end = a1;
    if (!anticlockwise && a1 - a0 >= TURN) {
      end = a0 + TURN;
    } else if (anticlockwise && a0 - a1 >= TURN) {
      end = a0 - TURN;
    } else if (!anticlockwise && a0 > a1) {
      end = a0 + (TURN - ((a0 - a1) % TURN));
    } else if (anticlockwise && a0 < a1) {
      end = a0 - (TURN - ((a1 - a0) % TURN));
    }
    const sweep = end - a0;
    const whole = Math.abs(sweep) >= TURN - 1e-9;
    this.#grow(x - r, y - r);
    this.#grow(x + r, y + r);
    const el = circleOnScreen(this.#inverse, e, n, rm);
    // A whole small circle alone in its path: a dot.
    if (whole && this.#at === null && Math.max(el.rx, el.ry) < DOT) {
      this.#dots.push([el.cx, el.cy, (el.rx + el.ry) / 2]);
      this.#first ??= [x, y];
      return;
    }
    const at = (a: number): Px => [x + r * Math.cos(a), y + r * Math.sin(a)];
    const [x0, y0] = at(a0);
    if (this.#at === null) {
      this.moveTo(x0, y0);
    } else {
      this.lineTo(x0, y0);
    }
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    for (let i = 1; i <= pieces; i++) {
      const b0 = a0 + (sweep * (i - 1)) / pieces;
      const b1 = a0 + (sweep * i) / pieces;
      const p0 = this.#screen(...at(b0));
      const pm = this.#screen(...at((b0 + b1) / 2));
      const p1 = this.#screen(...at(b1));
      const turn = (pm[0] - p0[0]) * (p1[1] - pm[1]) - (pm[1] - p0[1]) * (p1[0] - pm[0]);
      this.#d += `A${n1(el.rx)} ${n1(el.ry)} ${n1(el.turn)} 0 ${turn > 0 ? 1 : 0} ${n1(p1[0])} ${n1(p1[1])}`;
    }
    this.#at = at(a0 + sweep);
  }

  /**
   * An opacity as the sheet's blending over the paper makes it look. A
   * line or a letter a pixel or two wide covers its pixels in part, and
   * the GPU blends that part in linear light too, so it reads paler: as
   * if half covered.
   */
  #seen(colour: string, opacity: number, thin = false): number {
    if (this.linearOver === null) {
      return opacity;
    }
    if (thin) {
      return Math.min(1, 2 * linearOpacity(colour, opacity / 2, this.linearOver));
    }
    return linearOpacity(colour, opacity, this.linearOver);
  }

  /** The ink of a fill or a stroke in the state's style. */
  #ink(kind: 'fill' | 'stroke', rule?: 'nonzero' | 'evenodd'): Ink {
    const s = this.#s;
    const [colour, a] = parseColour(kind === 'fill' ? s.fillStyle : s.strokeStyle);
    const opacity = this.#seen(colour, a * s.globalAlpha);
    if (kind === 'fill') {
      return {
        fill: colour,
        opacity,
        ...(rule === 'evenodd' ? { rule } : {}),
        ...(this.filter !== 'none' ? { filter: this.filter } : {}),
      };
    }
    // Its scale at the middle of what it draws: a line across the disk is
    // as wide as the chart draws it there.
    const b = this.#box;
    const k = this.#scaleAt(b === null ? this.#first : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    return {
      stroke: colour,
      opacity: s.lineWidth * k < THIN ? this.#seen(colour, a * s.globalAlpha, true) : opacity,
      width: s.lineWidth * k,
      dash: s.dash.map((d) => d * k),
      cap: s.lineCap,
      join: s.lineJoin,
    };
  }

  #dotsOut(): void {
    if (this.#dots.length === 0) {
      return;
    }
    const [colour, a] = parseColour(this.#s.fillStyle);
    // Grouped by their size to a quarter pixel.
    const bySize = new Map<number, Px[]>();
    for (const [x, y, r] of this.#dots) {
      const w = Math.max(Math.round(r * 8) / 4, 0.25);
      const list = bySize.get(w) ?? [];
      list.push([x, y]);
      bySize.set(w, list);
    }
    for (const [w, dots] of bySize) {
      // Each from the last, a tenth of a pixel at a time.
      let d = '';
      let px = 0;
      let py = 0;
      for (const [x, y] of dots) {
        const qx = Math.round(x * 10) / 10;
        const qy = Math.round(y * 10) / 10;
        d += d === '' ? `M${n1(qx)} ${n1(qy)}h0` : `m${n1(qx - px)} ${n1(qy - py)}h0`;
        px = qx;
        py = qy;
      }
      this.#svg.path(
        d,
        {
          stroke: colour,
          opacity: this.#seen(colour, a * this.#s.globalAlpha, true),
          width: w,
          cap: 'round',
        },
        this.#s.clip,
      );
    }
  }

  fill(rule?: 'nonzero' | 'evenodd'): void {
    this.#flushText();
    this.#dotsOut();
    this.#svg.path(this.#d, this.#ink('fill', rule), this.#s.clip);
  }

  stroke(): void {
    this.#flushText();
    if (this.#dots.length > 0) {
      // A small circle stroked: drawn as its ellipse after all.
      const dots = this.#dots;
      this.#dots = [];
      for (const [x, y, r] of dots) {
        this.#d += `M${n1(x - r)} ${n1(y)}a${n1(r)} ${n1(r)} 0 1 0 ${n1(2 * r)} 0a${n1(r)} ${n1(r)} 0 1 0 ${n1(-2 * r)} 0`;
      }
    }
    this.#svg.path(this.#d, this.#ink('stroke'), this.#s.clip);
  }

  clip(rule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    this.#flushText();
    this.#s.clip = this.#svg.clip(this.#d, rule, this.#s.clip);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.dropSpecks && Math.abs(w * h) < 9) {
      const at = this.onSpecks;
      this.onSpecks = null;
      at?.();
      return;
    }
    const keep = {
      d: this.#d,
      dots: this.#dots,
      start: this.#start,
      at: this.#at,
      first: this.#first,
      box: this.#box,
    };
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
    this.#d = keep.d;
    this.#dots = keep.dots;
    this.#start = keep.start;
    this.#at = keep.at;
    this.#first = keep.first;
    this.#box = keep.box;
  }

  clearRect(): void {}

  drawImage(): void {}

  /** The face, its size, px, and whether bold, from the font's shorthand. */
  #fontOf(font: string): { face: Face; italic: boolean; size: number; bold: boolean } {
    const italic = /\bitalic\b/.test(font);
    const bold = /\bbold\b/.test(font);
    const size = Number.parseFloat(font.match(/([\d.]+)px/)?.[1] ?? '10');
    return { face: italic ? this.#faces.italic : this.#faces.roman, italic, size, bold };
  }

  measureText(text: string): { width: number } {
    const f = this.#fontOf(this.#s.font);
    return { width: advanceOf(f.face, text) * f.size };
  }

  strokeText(text: string, x: number, y: number): void {
    this.#flushText();
    const [colour, a] = parseColour(this.#s.strokeStyle);
    this.#pending = {
      text,
      x,
      y,
      colour,
      alpha: this.#seen(colour, a * this.#s.globalAlpha),
      width: this.#s.lineWidth,
      font: this.#s.font,
      transform: [...this.#s.transform],
    };
  }

  fillText(text: string, x: number, y: number): void {
    const p = this.#pending;
    this.#pending = null;
    const same =
      p !== null &&
      p.text === text &&
      p.x === x &&
      p.y === y &&
      p.font === this.#s.font &&
      p.transform.every((v, i) => v === this.#s.transform[i]);
    if (p !== null && !same) {
      this.#print(p.text, p.x, p.y, null, p, p.font, p.transform);
    }
    const [colour, a] = parseColour(this.#s.fillStyle);
    this.#print(
      text,
      x,
      y,
      { colour, alpha: this.#seen(colour, a * this.#s.globalAlpha, true) },
      same ? p : null,
      this.#s.font,
      this.#s.transform,
    );
  }

  #flushText(): void {
    const p = this.#pending;
    if (p !== null) {
      this.#pending = null;
      this.#print(p.text, p.x, p.y, null, p, p.font, p.transform);
    }
  }

  /**
   * Prints text at (x, y) on the canvas, aligned as the state says, laid
   * on the paper: the canvas's own transform, then the camera at the
   * text's place, taken as the affine map nearest it there.
   */
  #print(
    text: string,
    x: number,
    y: number,
    fill: { colour: string; alpha: number } | null,
    halo: { colour: string; alpha: number; width: number } | null,
    font: string,
    transform: Affine,
  ): void {
    const f = this.#fontOf(font);
    const w = advanceOf(f.face, text) * f.size;
    const align = this.#s.textAlign;
    const dx = align === 'center' ? -w / 2 : align === 'right' || align === 'end' ? -w : 0;
    const asc = (f.face.ascender / f.face.upem) * f.size;
    const desc = (-f.face.descender / f.face.upem) * f.size;
    const base = this.#s.textBaseline;
    const dy =
      base === 'middle'
        ? (asc - desc) / 2
        : base === 'top' || base === 'hanging'
          ? asc
          : base === 'bottom' || base === 'ideographic'
            ? -desc
            : 0;
    // The text's own px to the canvas: its transform, then to its start.
    const keep = this.#s.transform;
    this.#s.transform = transform;
    const t = multiply(transform, [1, 0, 0, 1, x + dx, y + dy]);
    this.#s.transform = [1, 0, 0, 1, 0, 0];
    // The camera near the text's middle, as an affine map of the canvas.
    const [mx, my] = apply(t, w / 2, 0);
    const o = this.#screen(mx, my);
    const ex = this.#screen(mx + 1, my);
    const ey = this.#screen(mx, my + 1);
    this.#s.transform = keep;
    const j: Affine = [
      ex[0] - o[0],
      ex[1] - o[1],
      ey[0] - o[0],
      ey[1] - o[1],
      o[0] - (ex[0] - o[0]) * mx - (ey[0] - o[0]) * my,
      o[1] - (ex[1] - o[1]) * mx - (ey[1] - o[1]) * my,
    ];
    const m = multiply(j, t);
    const faceName = f.italic ? 'i' : 'r';
    if (halo !== null) {
      this.#svg.text(
        text,
        {
          face: f.face,
          faceName,
          size: f.size,
          fill: halo.colour,
          ...(f.bold ? { bold: 0.03 } : {}),
          halo: { colour: halo.colour, opacity: halo.alpha, width: halo.width },
          opacity: 0,
        },
        m,
        this.#s.clip,
      );
    }
    if (fill !== null) {
      this.#svg.text(
        text,
        {
          face: f.face,
          faceName,
          size: f.size,
          fill: fill.colour,
          opacity: fill.alpha,
          ...(f.bold ? { bold: 0.03 } : {}),
        },
        m,
        this.#s.clip,
      );
    }
  }
}

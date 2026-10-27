// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather painted on a canvas of its own over the paper, each
// layer a shape of its own as well as a colour, so it reads without colour
// (WCAG 2.2, 1.4.1; technique G111). The wind three ways: a wash tinting
// the water a step darker for each band of force, one hue so it reads by
// lightness; the weather chart's barbs, a shaft from where it blows with a
// half feather for 5 knots, a feather for 10 and a pennant for 50; and the
// streaks, which the chart's scene draws over the paper. The gusts in short
// broken dashes along the wind; rain as a stipple, denser where heavier;
// fog as a wash with wavy lines, outlined where very poor; the isobars
// every hPa, heavier every 4, with their lows and highs. The weather
// chart's own symbols (WMO-No. 485): a cold front with triangles and a warm
// front with semicircles, each on the side it moves toward; a squall line
// as a line of dash, dot, dot, its barbs on its leading side; a trough as a
// dashed line; a squall as a dark cell with a barbed arc along its gust
// front; a storm as an anticlockwise spiral, as the northern hemisphere's
// lows turn, and a low as a lighter one lettered L, each with its ring of
// strongest wind hatched at its true size; a shower's heap with its ▽, a
// fog bank's ≡ and light air's dotted ring; gales hatched across and
// lettered. Each system has an arrow to where it will be in half an hour
// and is lettered with its wind, its force and its motion, the strongest
// first where the letters would crowd.

import { centres, contour, type Grid, levels, type Where } from './contour';
import { PAPER_MARGIN } from './paper';
import type {
  FieldGrid,
  Layers,
  SceneFront,
  SceneSystem,
  SystemDraw,
  WeatherScene,
} from './weather';
import { forceOf } from './words';

/** What the weather is painted with. */
export interface WeatherLook {
  ink: string;
  /** The paper's colour: the halo about letters and lines laid over the wash. */
  paper: string;
  rain: string;
  fog: string;
  /** A cold front's colour and a warm front's. */
  cold: string;
  warm: string;
  squall: string;
  storm: string;
  /** The wind's wash: its hue, the Beaufort force each step begins at and each step's opacity. */
  wash: { colour: string; forces: readonly number[]; tints: readonly number[] };
  /** The wind's barbs stand this far apart, m. */
  barbs: number;
  /** Gusts are drawn where the typical strongest gust is this much over the mean, m/s. */
  gusts: number;
  /** The lip, m. */
  lip: number;
  /** Rain's words: light, moderate and heavy under these, mm an hour. */
  rainWords: readonly number[];
  /** Visibility's words: very poor, poor and moderate under these, m. */
  visibility: readonly number[];
}

/**
 * What a painter draws with: the canvas, where a point of the water lies on
 * it and how many pixels a metre is, the drawing's unit for its lines and
 * letters, px, and the look. The chart's canvas has a unit of a hundredth
 * of the disk's radius; the key's swatches one of their own.
 */
export interface Pen {
  ctx: CanvasRenderingContext2D;
  at: (east: number, north: number) => [number, number];
  k: number;
  u: number;
  look: WeatherLook;
}

/** A knot, m/s. */
const KNOT = 1852 / 3600;

/** Half an hour, s: how far ahead a system's arrow reaches. */
const AHEAD = 1800;

/** The 8-point compass's letters, for a system's motion. */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** The letters' face. */
const SERIF = '"IM Fell English", Georgia, serif';

/**
 * The order systems are lettered in where their letters would crowd, and
 * drawn in, the strongest last so it lies on top: storms first, then lows,
 * the lines, the cells, the patches.
 */
export const SYMBOL_RANK: Record<SystemDraw, number> = {
  spiral: 0,
  low: 1,
  'dash-dot': 2,
  cell: 3,
  dashed: 4,
  heap: 5,
  bank: 6,
  calm: 7,
};

/** A colour #rrggbb at an opacity. */
export function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${Math.round(a * 1000) / 10}%)`;
}

/** A number in [0, 1) from i: the same stipple every paint. */
function grain(i: number): number {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

/** A barb's marks for a wind of so many knots, to the nearest 5: pennants of 50, feathers of 10 and a half feather of 5. */
export function feathers(knots: number): { pennants: number; feathers: number; halves: number } {
  let n = Math.floor(Math.max(knots, 0) / 5 + 0.5);
  const pennants = Math.floor(n / 10);
  n -= 10 * pennants;
  return { pennants, feathers: Math.floor(n / 2), halves: n % 2 };
}

/** The wash's step for a mean wind, m/s: 0 under the first force of forces, then one more for each reached. */
export function washStep(speed: number, forces: readonly number[]): number {
  const f = forceOf(speed);
  let step = 0;
  for (const from of forces) {
    if (f >= from) {
      step++;
    }
  }
  return step;
}

/** The least mean wind, m/s, of a Beaufort force: where the wash's step begins. */
function speedOfForce(force: number): number {
  let lo = 0;
  let hi = 80;
  // forceOf rises with the speed: halve the interval to a ten-thousandth.
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (forceOf(mid) >= force) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/** A system's lettering: "Storm · F9 · 45 kn · NE 5 kn", "Squall line · 35 kn", "Fog". */
export function systemLabel(s: SceneSystem): string {
  const parts = [s.name];
  const wind = Math.round(s.wind / KNOT);
  if (s.ring > 0) {
    parts.push(`F${forceOf(s.wind)}`);
  }
  if (wind >= 1 && s.draw !== 'calm' && s.draw !== 'bank') {
    parts.push(`${wind} kn`);
  }
  const knots = Math.round(s.speed / KNOT);
  if (knots >= 1 && s.length <= 0) {
    const way = POINTS[Math.floor((((s.heading * 180) / Math.PI + 360 + 22.5) % 360) / 45)] ?? 'N';
    parts.push(`${way} ${knots} kn`);
  }
  return parts.join(' · ');
}

/** A system's colour: its cell's or line's, its low's, or the rain's, the fog's and the ink's. */
export function colourOf(draw: SystemDraw, look: WeatherLook): string {
  switch (draw) {
    case 'cell':
    case 'dash-dot':
      return look.squall;
    case 'spiral':
    case 'low':
      return look.storm;
    case 'heap':
    case 'dashed':
      return look.rain;
    case 'bank':
      return look.fog;
  }
  return look.ink;
}

/** A letter's box on the canvas: left, top, right, bottom. */
type Box = [number, number, number, number];

/** Paints the scene on a canvas spanning the paper, with the layers switched on. */
export function paintWeather(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scene: WeatherScene,
  look: WeatherLook,
  layers: Layers,
): void {
  // Painted by the CPU: it is painted afresh every second.
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (ctx === null) {
    return;
  }
  const side = canvas.width;
  const extent = look.lip * PAPER_MARGIN;
  const k = side / (2 * extent);
  const p: Pen = {
    ctx,
    at: (east, north) => [side / 2 + east * k, side / 2 - north * k],
    k,
    u: look.lip * k * 0.01,
    look,
  };
  ctx.clearRect(0, 0, side, side);
  ctx.save();
  // Nothing beyond the lip.
  ctx.beginPath();
  ctx.arc(side / 2, side / 2, look.lip * k, 0, 2 * Math.PI);
  ctx.clip();
  const g = scene.grid;
  if (layers.wash) {
    paintWash(p, g);
  }
  if (layers.fog) {
    paintFog(p, g);
  }
  if (layers.rain) {
    paintRain(p, g);
  }
  if (layers.gusts) {
    paintGusts(p, g);
  }
  if (layers.barbs) {
    paintBarbs(p, g);
  }
  const kept: Box[] = [];
  const isobars = layers.pressure ? paintIsobars(p, g, layers.systems ? scene.systems : []) : null;
  isobars?.centres(kept);
  if (layers.systems) {
    if (scene.gale !== null) {
      paintGale(p, scene.gale);
    }
    const labels: Label[] = [];
    for (const f of scene.fronts) {
      paintFront(p, f, look.lip * 1.05);
      const l = frontLabel(p, f);
      if (l !== null) {
        labels.push(l);
      }
    }
    const systems = [...scene.systems].sort(
      (a, b) => SYMBOL_RANK[b.draw] - SYMBOL_RANK[a.draw] || a.wind - b.wind,
    );
    for (const s of systems) {
      if (s.ring > 0) {
        paintRing(p, s);
      }
    }
    for (const s of systems) {
      paintSystem(p, s);
      paintMotion(p, s);
      labels.push(systemLabelAt(p, s));
    }
    placeLabels(p, labels, kept);
  }
  isobars?.figures(kept);
  ctx.restore();
}

/** The mean wind at a point from the grid, bilinear between its cells: speed, m/s, and where it comes from, rad. */
export function windAt(g: FieldGrid, east: number, north: number): [number, number] {
  const n = g.n;
  const fi = Math.min(Math.max((east / (2 * g.lip) + 0.5) * n - 0.5, 0), n - 1);
  const fj = Math.min(Math.max((0.5 - north / (2 * g.lip)) * n - 0.5, 0), n - 1);
  const i0 = Math.min(Math.floor(fi), n - 2);
  const j0 = Math.min(Math.floor(fj), n - 2);
  const u = fi - i0;
  const v = fj - j0;
  let speed = 0;
  let se = 0;
  let sn = 0;
  for (const [di, dj, w] of [
    [0, 0, (1 - u) * (1 - v)],
    [1, 0, u * (1 - v)],
    [0, 1, (1 - u) * v],
    [1, 1, u * v],
  ] as const) {
    const kk = (j0 + dj) * n + i0 + di;
    const s = g.mean[kk] ?? 0;
    const from = g.from[kk] ?? 0;
    speed += w * s;
    // The direction weighted by the speed, so a calm cell does not turn it.
    se += w * s * Math.sin(from);
    sn += w * s * Math.cos(from);
  }
  return [speed, Math.atan2(se, sn)];
}

/** The wash's picture, four pixels a side for each of the grid's cells: made afresh each paint, its canvas kept. */
let washCanvas: OffscreenCanvas | null = null;

/** The wind's wash: the water tinted a step darker from each force of the look's on, its edges sharp. */
export function paintWash(p: Pen, g: FieldGrid): void {
  const { ctx, look } = p;
  const w = look.wash;
  const n = g.n * 4;
  if (washCanvas === null || washCanvas.width !== n) {
    washCanvas = new OffscreenCanvas(n, n);
  }
  const wctx = washCanvas.getContext('2d', { willReadFrequently: true });
  if (wctx === null) {
    return;
  }
  const from = w.forces.map(speedOfForce);
  const c = Number.parseInt(w.colour.slice(1, 7), 16);
  const rgb = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const a = [0, ...w.tints.map((t) => Math.round(t * 255))];
  const img = wctx.createImageData(n, n);
  const d = img.data;
  const gn = g.n;
  for (let y = 0; y < n; y++) {
    // The pixel's place among the grid's cells, bilinear between their centres.
    const fj = Math.min(Math.max((y + 0.5) / 4 - 0.5, 0), gn - 1);
    const j0 = Math.min(Math.floor(fj), gn - 2);
    const v = fj - j0;
    for (let x = 0; x < n; x++) {
      const fi = Math.min(Math.max((x + 0.5) / 4 - 0.5, 0), gn - 1);
      const i0 = Math.min(Math.floor(fi), gn - 2);
      const uu = fi - i0;
      const kk = j0 * gn + i0;
      const s =
        (1 - v) * ((1 - uu) * (g.mean[kk] ?? 0) + uu * (g.mean[kk + 1] ?? 0)) +
        v * ((1 - uu) * (g.mean[kk + gn] ?? 0) + uu * (g.mean[kk + gn + 1] ?? 0));
      let step = 0;
      while (step < from.length && s >= (from[step] ?? Number.POSITIVE_INFINITY)) {
        step++;
      }
      const o = 4 * (y * n + x);
      d[o] = rgb[0] ?? 0;
      d[o + 1] = rgb[1] ?? 0;
      d[o + 2] = rgb[2] ?? 0;
      d[o + 3] = a[step] ?? 0;
    }
  }
  wctx.putImageData(img, 0, 0);
  const [x0, y0] = p.at(-g.lip, g.lip);
  const size = 2 * g.lip * p.k;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(washCanvas, x0, y0, size, size);
}

/** A grid cell's centre on the canvas. */
function cellAt(p: Pen, g: FieldGrid, i: number, j: number): [number, number] {
  return p.at(((i + 0.5) / g.n - 0.5) * 2 * g.lip, (0.5 - (j + 0.5) / g.n) * 2 * g.lip);
}

/** A wavy line across a fog cell, centred at (x, y), w wide: the fog symbol is lines. */
export function fogWave(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  ctx.beginPath();
  for (let t = 0; t <= 8; t++) {
    const px = x - w / 2 + (t / 8) * w;
    const py = y + Math.sin((t / 8) * 2 * Math.PI) * w * 0.15;
    if (t === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

export function paintFog(p: Pen, g: FieldGrid): void {
  const { ctx, look } = p;
  const cell = (2 * g.lip * p.k) / g.n;
  const poor = look.visibility[1] ?? 1852;
  const veryPoor = look.visibility[0] ?? 400;
  // The wash, a pixel a cell, drawn up smoothed: soft at its edges.
  const n = g.n;
  const wash = new OffscreenCanvas(n, n);
  const wctx = wash.getContext('2d');
  if (wctx !== null) {
    const img = wctx.createImageData(n, n);
    const c = Number.parseInt(look.fog.slice(1, 7), 16);
    for (let kk = 0; kk < n * n; kk++) {
      const v = g.fog[kk] ?? Number.NaN;
      const a = v < poor ? 0.15 + 0.35 * Math.min(1, (poor - v) / poor) : 0;
      img.data.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, Math.round(a * 255)], 4 * kk);
    }
    wctx.putImageData(img, 0, 0);
    const [x0, y0] = p.at(-g.lip, g.lip);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(wash, x0, y0, n * cell, n * cell);
  }
  ctx.strokeStyle = alpha(look.fog, 0.9);
  ctx.lineWidth = Math.max(1, cell / 10);
  for (let j = 0; j < g.n; j++) {
    for (let i = 0; i < g.n; i++) {
      const v = g.fog[j * g.n + i] ?? Number.NaN;
      // A wavy line in every other cell.
      if (v < poor && (i + j) % 2 === 0) {
        const [x, y] = cellAt(p, g, i, j);
        fogWave(ctx, x, y, cell * 0.8);
      }
    }
  }
  // Where it is very poor, outlined.
  const grid: Grid = { side: g.n, step: (2 * g.lip) / g.n, values: g.fog };
  ctx.strokeStyle = look.fog;
  ctx.lineWidth = Math.max(2, cell / 4);
  for (const line of contour(grid, veryPoor)) {
    strokeLine(p, line);
  }
}

function strokeLine(p: Pen, line: Where[]): void {
  const { ctx } = p;
  ctx.beginPath();
  line.forEach(([e, n], i) => {
    const [x, y] = p.at(e, n);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

/** How many dots a cell of rain at a rate gets: light, moderate, heavy, violent. */
export function rainDots(rate: number, words: readonly number[]): number {
  if (!(rate >= 0.1)) {
    return 0;
  }
  return rate < (words[0] ?? 2.5)
    ? 2
    : rate < (words[1] ?? 10)
      ? 4
      : rate < (words[2] ?? 50)
        ? 7
        : 11;
}

export function paintRain(p: Pen, g: FieldGrid): void {
  const { ctx, look } = p;
  const cell = (2 * g.lip * p.k) / g.n;
  ctx.fillStyle = look.rain;
  const r = Math.max(1, cell / 9);
  for (let j = 0; j < g.n; j++) {
    for (let i = 0; i < g.n; i++) {
      const dots = rainDots(g.rain[j * g.n + i] ?? 0, look.rainWords);
      if (dots === 0) {
        continue;
      }
      const [x, y] = cellAt(p, g, i, j);
      for (let d = 0; d < dots; d++) {
        const s = (j * g.n + i) * 16 + d;
        ctx.beginPath();
        ctx.arc(x + (grain(s) - 0.5) * cell, y + (grain(s + 7) - 0.5) * cell, r, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

export function paintGusts(p: Pen, g: FieldGrid): void {
  const { ctx, look } = p;
  const cell = (2 * g.lip * p.k) / g.n;
  ctx.strokeStyle = alpha(look.ink, 0.75);
  ctx.lineWidth = Math.max(1, cell / 12);
  ctx.beginPath();
  for (let j = 0; j < g.n; j += 2) {
    for (let i = j % 4 === 0 ? 0 : 1; i < g.n; i += 2) {
      const kk = j * g.n + i;
      if (!((g.gust[kk] ?? 0) - (g.mean[kk] ?? 0) >= look.gusts)) {
        continue;
      }
      // Downwind: away from where it comes from; on the canvas y runs south.
      const from = g.from[kk] ?? 0;
      const dx = -Math.sin(from);
      const dy = Math.cos(from);
      const [x, y] = cellAt(p, g, i, j);
      for (const t of [-0.8, 0.2]) {
        ctx.moveTo(x + dx * t * cell, y + dy * t * cell);
        ctx.lineTo(x + dx * (t + 0.5) * cell, y + dy * (t + 0.5) * cell);
      }
    }
  }
  ctx.stroke();
}

/**
 * A wind barb at (x, y) on the canvas for a wind of so many knots from a
 * direction, rad: its shaft len px toward where the wind comes from, its
 * marks at the shaft's far end on its clockwise side, as the northern
 * hemisphere's charts draw them, toward the low; a calm an open circle.
 */
export function paintBarb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  from: number,
  knots: number,
  len: number,
): void {
  const m = feathers(knots);
  if (m.pennants + m.feathers + m.halves === 0) {
    ctx.beginPath();
    ctx.arc(x, y, len * 0.14, 0, 2 * Math.PI);
    ctx.stroke();
    return;
  }
  // Toward where it comes from; y runs south. Its clockwise side.
  const dx = Math.sin(from);
  const dy = -Math.cos(from);
  const sx = -dy;
  const sy = dx;
  const tx = x + dx * len;
  const ty = y + dy * len;
  const feather = len * 0.36;
  const gap = len * 0.15;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  let along = 0;
  for (let i = 0; i < m.pennants; i++) {
    const ax = tx - dx * along;
    const ay = ty - dy * along;
    const bx = tx - dx * (along + gap * 1.3);
    const by = ty - dy * (along + gap * 1.3);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + sx * feather, ay + sy * feather);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    along += gap * 1.5;
  }
  // A half feather alone stands in from the shaft's end, as the weather chart draws it.
  if (m.pennants === 0 && m.feathers === 0) {
    along = gap;
  }
  const mark = (l: number) => {
    const ax = tx - dx * along;
    const ay = ty - dy * along;
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + (sx * l + dx * l * 0.4), ay + (sy * l + dy * l * 0.4));
    along += gap;
  };
  ctx.beginPath();
  for (let i = 0; i < m.feathers; i++) {
    mark(feather);
  }
  if (m.halves > 0) {
    mark(feather / 2);
  }
  ctx.stroke();
}

/** The wind's barbs on a square lattice over the water, the look's spacing apart. */
export function paintBarbs(p: Pen, g: FieldGrid): void {
  const { ctx, look } = p;
  const step = look.barbs;
  const reach = look.lip * 0.97;
  const len = step * p.k * 0.55;
  ctx.strokeStyle = look.ink;
  ctx.fillStyle = look.ink;
  ctx.lineWidth = Math.max(1, p.u * 0.4);
  ctx.lineCap = 'round';
  const most = Math.floor(reach / step);
  for (let j = -most; j <= most; j++) {
    for (let i = -most; i <= most; i++) {
      const east = i * step;
      const north = j * step;
      if (east * east + north * north > reach * reach) {
        continue;
      }
      const [speed, from] = windAt(g, east, north);
      const [x, y] = p.at(east, north);
      paintBarb(ctx, x, y, from, speed / KNOT, len);
    }
  }
  ctx.lineCap = 'butt';
}

/** A letter's halo, the paper's, so it reads over the wash and the lines. */
function haloText(p: Pen, text: string, x: number, y: number, colour: string): void {
  const { ctx } = p;
  ctx.lineWidth = Math.max(2, p.u * 0.8);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = alpha(p.look.paper, 0.9);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/** Whether a box overlaps any kept. */
function crowds(box: Box, kept: readonly Box[]): boolean {
  return kept.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]);
}

/** An isobar's stroke: every hPa, a little heavier every 4. */
export function isobarStroke(p: Pen, heavy: boolean): void {
  p.ctx.strokeStyle = alpha(p.look.ink, heavy ? 0.85 : 0.55);
  p.ctx.lineWidth = Math.max(1, p.u * (heavy ? 0.5 : 0.25));
}

/**
 * The isobars every hPa, a little heavier every 4. Their lettering is
 * returned to be done once the systems' own letters are placed, which come
 * first: the highs' and lows' H and L where no system's symbol stands, then
 * each line's figure at its middle where it does not crowd, the lighter
 * lines only with room about them, so a low's crowded rings are not a
 * column of figures.
 */
export function paintIsobars(
  p: Pen,
  g: FieldGrid,
  systems: readonly SceneSystem[],
): { centres: (kept: Box[]) => void; figures: (kept: Box[]) => void } {
  const { ctx, look, u } = p;
  const grid: Grid = { side: g.n, step: (2 * g.lip) / g.n, values: g.pressure };
  const small = Math.round(u * 2.4);
  const lettered: { text: string; x: number; y: number; heavy: boolean }[] = [];
  for (const level of levels(grid, 1)) {
    const heavy = Math.round(level.value) % 4 === 0;
    isobarStroke(p, heavy);
    for (const line of level.lines) {
      strokeLine(p, line);
      if (line.length > 6) {
        const [x, y] = p.at(...(line[Math.floor(line.length / 2)] as Where));
        lettered.push({ text: String(Math.round(level.value)), x, y, heavy });
      }
    }
  }
  const centresOf = (kept: Box[]) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of centres(grid)) {
      // A storm's centre is lettered by the isobars; any other system's own
      // symbol stands at its centre, a low's lettered already.
      if (
        systems.some(
          (s) =>
            s.draw !== 'spiral' &&
            Math.hypot(s.east - c.east, s.north - c.north) < Math.max(s.size, s.length / 2),
        )
      ) {
        continue;
      }
      const [x, y] = p.at(c.east, c.north);
      ctx.font = `${Math.round(u * 6)}px ${SERIF}`;
      haloText(p, c.high ? 'H' : 'L', x, y - u * 2.4, look.ink);
      ctx.font = `italic ${small}px ${SERIF}`;
      haloText(p, String(Math.round(c.value)), x, y + u * 2.2, look.ink);
      kept.push([x - u * 3.5, y - u * 5.5, x + u * 3.5, y + u * 3.6]);
    }
  };
  const figures = (kept: Box[]) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The heavier lines' first.
    lettered.sort((a, b) => Number(b.heavy) - Number(a.heavy));
    for (const l of lettered) {
      ctx.font = `italic ${l.heavy ? Math.round(small * 1.15) : small}px ${SERIF}`;
      const w = ctx.measureText(l.text).width / 2 + u;
      const room = l.heavy ? 0 : u * 6;
      if (!crowds([l.x - w - room, l.y - small - room, l.x + w + room, l.y + small + room], kept)) {
        kept.push([l.x - w, l.y - small, l.x + w, l.y + small]);
        haloText(p, l.text, l.x, l.y, look.ink);
      }
    }
  };
  return { centres: centresOf, figures };
}

/** Hatching across a region already clipped, lines spacing px apart one way, and the other too if both. */
export function hatch(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  spacing: number,
  both: boolean,
): void {
  const h = y1 - y0;
  ctx.beginPath();
  for (let d = x0 - h; d < x1 + h; d += spacing) {
    ctx.moveTo(d, y0);
    ctx.lineTo(d + h, y1);
    if (both) {
      ctx.moveTo(d + h, y0);
      ctx.lineTo(d, y1);
    }
  }
  ctx.stroke();
}

export function paintGale(p: Pen, gale: NonNullable<WeatherScene['gale']>): void {
  const { ctx, look, k } = p;
  const c = (gale.side - 1) / 2;
  const w = gale.spacing * k;
  let se = 0;
  let sn = 0;
  let count = 0;
  ctx.save();
  ctx.beginPath();
  for (let j = 0; j < gale.side; j++) {
    for (let i = 0; i < gale.side; i++) {
      if (gale.on[j * gale.side + i] !== 1) {
        continue;
      }
      const east = (i - c) * gale.spacing;
      const north = (j - c) * gale.spacing;
      const [x, y] = p.at(east, north);
      ctx.rect(x - w / 2, y - w / 2, w, w);
      se += east;
      sn += north;
      count++;
    }
  }
  if (count === 0) {
    ctx.restore();
    return;
  }
  ctx.clip();
  // Hatched across: lines one way, then the other.
  ctx.strokeStyle = alpha(look.storm, 0.8);
  ctx.lineWidth = Math.max(1, w / 10);
  const side = 2 * look.lip * PAPER_MARGIN * k;
  hatch(ctx, 0, 0, side, side, Math.max(4, w / 3), true);
  ctx.restore();
  const [x, y] = p.at(se / count, sn / count);
  ctx.font = `bold italic ${Math.round(p.u * 5)}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  haloText(p, 'Gale', x, y, look.storm);
}

/**
 * A front's line across the disk, reach m either side of the point of it
 * nearest the centre: a cold front's triangles or a warm front's
 * semicircles on the side it moves toward, over a halo of the paper's.
 */
export function paintFront(p: Pen, f: SceneFront, reach: number): void {
  const { ctx, look, u, k } = p;
  // Along the line: across the way it moves, (cos, −sin).
  const point = (s: number, t: number): [number, number] =>
    p.at(f.sin * s + f.cos * t, f.cos * s - f.sin * t);
  const colour = f.warm ? look.warm : look.cold;
  const line = () => {
    ctx.beginPath();
    ctx.moveTo(...point(f.line, -reach));
    ctx.lineTo(...point(f.line, reach));
    ctx.stroke();
  };
  ctx.strokeStyle = alpha(look.paper, 0.85);
  ctx.lineWidth = u * 2;
  line();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(2, u * 0.9);
  line();
  // Its marks every so often, as wide as tall, on the side it moves toward.
  const size = (u * 3.6) / k;
  const every = (u * 11) / k;
  // On the canvas the line runs at this angle, and the way it moves a quarter turn less.
  const along = Math.atan2(f.sin, f.cos);
  for (let t = -reach + every / 2; t <= reach; t += every) {
    ctx.beginPath();
    if (f.warm) {
      const [x, y] = point(f.line, t);
      ctx.arc(x, y, (size / 2) * k, along - Math.PI, along);
    } else {
      ctx.moveTo(...point(f.line, t - size / 2));
      ctx.lineTo(...point(f.line, t + size / 2));
      ctx.lineTo(...point(f.line + size * 0.9, t));
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** The ring of strongest wind of a storm or a low, hatched at its true size. */
export function paintRing(p: Pen, s: SceneSystem): void {
  const { ctx, look, u } = p;
  const [x, y] = p.at(s.east, s.north);
  const r = s.ring * p.k;
  const half = Math.max(r * 0.12, u * 1.2);
  const fade = Math.min(1, 0.35 + s.strength);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + half, 0, 2 * Math.PI);
  ctx.arc(x, y, Math.max(r - half, 0), 0, 2 * Math.PI, true);
  ctx.clip();
  ctx.strokeStyle = alpha(look.storm, 0.7 * fade);
  ctx.lineWidth = Math.max(1, u * 0.3);
  hatch(ctx, x - r - half, y - r - half, x + r + half, y + r + half, Math.max(3, u * 1.3), false);
  ctx.restore();
  ctx.strokeStyle = alpha(look.storm, 0.8 * fade);
  ctx.lineWidth = Math.max(1, u * 0.3);
  for (const rr of [r + half, Math.max(r - half, 0)]) {
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

/** A shower's ▽, h px tall, centred at (x, y). */
export function showerMark(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(x - h * 0.55, y - h * 0.45);
  ctx.lineTo(x + h * 0.55, y - h * 0.45);
  ctx.lineTo(x, y + h * 0.55);
  ctx.closePath();
  ctx.stroke();
}

/** A spiral of arms turning anticlockwise into its centre, out to r px. */
function spiral(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  arms: number,
): void {
  for (let arm = 0; arm < arms; arm++) {
    ctx.beginPath();
    for (let t = 0; t <= 1.001; t += 0.05) {
      const rr = r * (0.12 + 0.88 * t);
      const a = (arm * 2 * Math.PI) / arms - t * 2.6;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (t === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
}

/** A line's ends on the canvas, half px either side of (x, y) along (ax, ay), under a halo of the paper's w wide. */
function lineUnder(
  p: Pen,
  x: number,
  y: number,
  ax: number,
  ay: number,
  half: number,
  w: number,
): void {
  const { ctx } = p;
  ctx.strokeStyle = alpha(p.look.paper, 0.85);
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x - ax * half, y - ay * half);
  ctx.lineTo(x + ax * half, y + ay * half);
  ctx.stroke();
}

/** A system's symbol, by its draw, at its place and size. */
export function paintSystem(p: Pen, s: SceneSystem): void {
  const { ctx, look, u } = p;
  const [x, y] = p.at(s.east, s.north);
  const r = Math.max(s.size * p.k, u * 2.5);
  const colour = colourOf(s.draw, look);
  const fade = Math.min(1, 0.35 + s.strength);
  // On the canvas: the heading clockwise from north, y running south; a
  // line's length across it, (cos, −sin) east and north.
  const hx = Math.sin(s.heading);
  const hy = -Math.cos(s.heading);
  const ax = Math.cos(s.heading);
  const ay = Math.sin(s.heading);
  const ahead = Math.atan2(hy, hx);
  const half = s.length > 0 ? (s.length * p.k) / 2 : r * 2;
  ctx.lineCap = 'butt';
  switch (s.draw) {
    case 'cell': {
      ctx.fillStyle = alpha(colour, 0.6 * fade);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.fill();
      // The gust front: an arc ahead, barbed.
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(2, u * 0.7);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95, ahead - 1, ahead + 1);
      ctx.stroke();
      const barb = Math.max(r * 0.25, u);
      ctx.beginPath();
      for (let t = ahead - 1; t <= ahead + 1.001; t += 0.4) {
        const px = x + Math.cos(t) * r * 0.95;
        const py = y + Math.sin(t) * r * 0.95;
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(t) * barb, py + Math.sin(t) * barb);
      }
      ctx.stroke();
      break;
    }
    case 'heap':
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(1.5, u * 0.45);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.5, u * 0.5);
      showerMark(ctx, x, y, Math.max(r * 0.55, u * 2.2));
      break;
    case 'spiral':
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(2.5, u * 0.9);
      ctx.lineCap = 'round';
      spiral(ctx, x, y, r, 3);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, u * 1.1), 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'low':
      ctx.strokeStyle = alpha(colour, 0.85 * fade);
      ctx.lineWidth = Math.max(1.5, u * 0.5);
      ctx.lineCap = 'round';
      spiral(ctx, x, y, r, 2);
      ctx.font = `bold ${Math.round(u * 5.5)}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      haloText(p, 'L', x, y, colour);
      break;
    case 'bank': {
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(1.5, u * 0.55);
      const w = Math.max(r * 0.8, u * 3.5);
      ctx.beginPath();
      for (const dy of [-1, 0, 1]) {
        ctx.moveTo(x - w / 2, y + dy * u * 1.1);
        ctx.lineTo(x + w / 2, y + dy * u * 1.1);
      }
      ctx.stroke();
      break;
    }
    case 'calm':
      // A ring, the weather chart's calm, about a ring of dots.
      ctx.strokeStyle = alpha(colour, 0.85 * fade);
      ctx.lineWidth = Math.max(1.5, u * 0.45);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.lineWidth = Math.max(2, u * 0.9);
      ctx.lineCap = 'round';
      ctx.setLineDash([0.1, u * 1.8]);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6 - u * 1.4, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    case 'dash-dot': {
      // A line of dash, dot, dot, its barbs on its leading side.
      lineUnder(p, x, y, ax, ay, half, u * 2);
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(2.5, u * 0.9);
      ctx.lineCap = 'round';
      ctx.setLineDash([u * 3, u * 1.3, 0.1, u * 1.3, 0.1, u * 1.3]);
      ctx.beginPath();
      ctx.moveTo(x - ax * half, y - ay * half);
      ctx.lineTo(x + ax * half, y + ay * half);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = Math.max(1.5, u * 0.5);
      ctx.beginPath();
      // A barb for each dash, dot, dot.
      const every = u * 6.9;
      for (let t = -half + every / 2; t <= half; t += every) {
        const px = x + ax * t + hx * u * 0.6;
        const py = y + ay * t + hy * u * 0.6;
        ctx.moveTo(px, py);
        ctx.lineTo(px + hx * u * 1.5 - ax * u * 0.6, py + hy * u * 1.5 - ay * u * 0.6);
      }
      ctx.stroke();
      break;
    }
    case 'dashed': {
      lineUnder(p, x, y, ax, ay, half, u * 1.8);
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = Math.max(2, u * 0.75);
      ctx.setLineDash([u * 2.6, u * 1.6]);
      ctx.beginPath();
      ctx.moveTo(x - ax * half, y - ay * half);
      ctx.lineTo(x + ax * half, y + ay * half);
      ctx.stroke();
      ctx.setLineDash([]);
      // Its showers along it, behind the line.
      ctx.lineWidth = Math.max(1.5, u * 0.5);
      const marks = Math.max(2, Math.round((2 * half) / (u * 12)));
      for (let i = 0; i < marks; i++) {
        const t = -half + ((i + 0.5) / marks) * 2 * half;
        showerMark(ctx, x + ax * t - hx * u * 2.2, y + ay * t - hy * u * 2.2, u * 2.2);
      }
      break;
    }
  }
  ctx.lineCap = 'butt';
}

/** Where a system will be in half an hour: the forecast's place, else on along its heading. */
function aheadOf(s: SceneSystem): { east: number; north: number } {
  return (
    s.ahead ?? {
      east: s.east + Math.sin(s.heading) * s.speed * AHEAD,
      north: s.north + Math.cos(s.heading) * s.speed * AHEAD,
    }
  );
}

/** An arrow from a system to where it will be in half an hour; none if it hardly moves. */
export function paintMotion(p: Pen, s: SceneSystem): void {
  const { ctx, look, u } = p;
  const to = aheadOf(s);
  const [x0, y0] = p.at(s.east, s.north);
  const [x1, y1] = p.at(to.east, to.north);
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < u * 3) {
    return;
  }
  const dx = (x1 - x0) / len;
  const dy = (y1 - y0) / len;
  const colour = colourOf(s.draw, look);
  const head = u * 1.8;
  ctx.strokeStyle = alpha(colour, 0.85);
  ctx.fillStyle = alpha(colour, 0.85);
  ctx.lineWidth = Math.max(1.5, u * 0.45);
  ctx.setLineDash([u * 1.6, u * 1]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - dx * head, y1 - dy * head);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - dx * head * 1.6 - dy * head * 0.7, y1 - dy * head * 1.6 + dx * head * 0.7);
  ctx.lineTo(x1 - dx * head * 1.6 + dy * head * 0.7, y1 - dy * head * 1.6 - dx * head * 0.7);
  ctx.closePath();
  ctx.fill();
}

/** A letter to place: its text, where it would go and how far off it may stand, its colour, its turn, its rank. */
interface Label {
  text: string;
  x: number;
  y: number;
  /** How far from (x, y) its places lie, px; 0 for at (x, y) alone. */
  off: number;
  /** Further places for it, px, when (x, y) is crowded: a front's along its line. */
  more: [number, number][];
  colour: string;
  /** Its turn on the canvas, rad: a front's runs along its line. */
  turn: number;
  rank: number;
  wind: number;
}

function systemLabelAt(p: Pen, s: SceneSystem): Label {
  const [x, y] = p.at(s.east, s.north);
  const r = Math.max(s.size * p.k, p.u * 2.5);
  return {
    text: systemLabel(s),
    x,
    y,
    off: s.length > 0 ? p.u * 3 : r * 0.65 + p.u,
    more: [],
    colour: p.look.ink,
    turn: 0,
    rank: SYMBOL_RANK[s.draw],
    wind: s.wind,
  };
}

/** A front's lettering, along its line behind it, where it is nearest the centre; null near or off the rim. */
function frontLabel(p: Pen, f: SceneFront): Label | null {
  if (Math.abs(f.line) > p.look.lip * 0.9) {
    return null;
  }
  const back = (p.u * 3) / p.k;
  // Behind its line, t along it from the point nearest the centre.
  const at = (t: number) =>
    p.at(f.sin * (f.line - back) + f.cos * t, f.cos * (f.line - back) - f.sin * t);
  const [x, y] = at(0);
  const chord = Math.sqrt(Math.max(p.look.lip ** 2 - f.line ** 2, 0));
  const more = [0.3, -0.3, 0.55, -0.55].map((share) => at(share * chord));
  let turn = Math.atan2(f.sin, f.cos);
  // Kept upright.
  if (turn > Math.PI / 2) {
    turn -= Math.PI;
  } else if (turn < -Math.PI / 2) {
    turn += Math.PI;
  }
  return {
    text: f.warm ? 'Warm front' : 'Cold front',
    x,
    y,
    off: 0,
    more,
    colour: f.warm ? p.look.warm : p.look.cold,
    turn,
    // After the storms and the lows, before the lines and the cells.
    rank: 1.5,
    wind: 0,
  };
}

/** A place for a label off its point toward the centre of the disk, clear of its symbol. */
function towardCentre(l: Label, cx: number, cy: number, w: number, h: number): [number, number] {
  const d = Math.hypot(cx - l.x, cy - l.y) || 1;
  const reach = l.off + Math.hypot(w, h) / 2;
  return [((cx - l.x) / d) * reach, ((cy - l.y) / d) * reach];
}

/** Letters the labels where they do not crowd one another, the storms first: below, above, right or left of each. */
function placeLabels(p: Pen, labels: Label[], kept: Box[]): void {
  const { ctx, u } = p;
  const [cx, cy] = p.at(0, 0);
  const lip = p.look.lip * p.k;
  // Within the lip: each corner of the box.
  const inside = (b: Box) =>
    [b[0], b[2]].every((x) => [b[1], b[3]].every((y) => Math.hypot(x - cx, y - cy) < lip));
  const size = Math.round(u * 5);
  ctx.font = `italic ${size}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  labels.sort((a, b) => a.rank - b.rank || b.wind - a.wind);
  for (const l of labels) {
    const w = ctx.measureText(l.text).width;
    const h = size;
    const places: [number, number][] =
      l.off === 0
        ? [[0, 0], ...l.more.map(([mx, my]): [number, number] => [mx - l.x, my - l.y])]
        : [
            [0, l.off + h / 2],
            [0, -l.off - h / 2],
            [l.off + w / 2, 0],
            [-l.off - w / 2, 0],
            // Near the rim, toward the centre.
            towardCentre(l, cx, cy, w, h),
          ];
    // A turned label's box: the box about its turned rectangle.
    const c = Math.abs(Math.cos(l.turn));
    const s = Math.abs(Math.sin(l.turn));
    const bw = (w * c + h * s) / 2;
    const bh = (w * s + h * c) / 2;
    for (const [dx, dy] of places) {
      const x = l.x + dx;
      const y = l.y + dy;
      const box: Box = [x - bw, y - bh, x + bw, y + bh];
      if (crowds(box, kept) || !inside(box)) {
        continue;
      }
      kept.push(box);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(l.turn);
      haloText(p, l.text, 0, 0, l.colour);
      ctx.restore();
      break;
    }
  }
}

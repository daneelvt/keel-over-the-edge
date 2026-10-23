// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather painted on a canvas of its own over the paper, each
// layer a shape of its own as well as a colour, so it reads without colour
// (WCAG 2.2, 1.4.1; technique G111): the gusts in short broken dashes
// along the wind; rain as a stipple, denser where heavier; fog as a wash
// with wavy lines, outlined where very poor; fronts as a line with
// triangles on the side it moves toward, as a weather chart draws a cold
// front (WMO-No. 485), its forecast band dashed either side; a squall as a
// dark cell with a barbed arc along its gust front; a storm as an
// anticlockwise spiral, as the northern hemisphere's lows turn; a shower's
// heap with its ▽ and fog patches' ≡, the WMO's symbols; light air's open
// circles; gales hatched across and lettered; the isobars every 2 hPa with
// their lows and highs. A forecast's cones are the area their circles
// sweep, faded at the edge, with no centre line and the forecast's place a
// small open circle, as the National Hurricane Center draws its cone
// (Broad and others 2007: the line "subverts the key message").

import { centres, contour, type Grid, levels, type Where } from './contour';
import { PAPER_MARGIN } from './paper';
import type { FieldGrid, Layers, SceneFront, SceneSystem, WeatherScene } from './weather';

/** What the weather is painted with. */
export interface WeatherLook {
  ink: string;
  rain: string;
  fog: string;
  front: string;
  squall: string;
  storm: string;
  /** Gusts are drawn where the typical strongest gust is this much over the mean, m/s. */
  gusts: number;
  /** The lip, m. */
  lip: number;
  /** Rain's words: light, moderate and heavy under these, mm an hour. */
  rainWords: readonly number[];
  /** Visibility's words: very poor, poor and moderate under these, m. */
  visibility: readonly number[];
}

/** The 8-point compass's letters, for a system's motion. */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** A colour #rrggbb at an opacity. */
function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${Math.round(a * 1000) / 10}%)`;
}

/** A number in [0, 1) from i: the same stipple every paint. */
function grain(i: number): number {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

/** Paints the scene on a canvas spanning the paper, with the layers switched on. */
export function paintWeather(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scene: WeatherScene,
  look: WeatherLook,
  layers: Layers,
): void {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (ctx === null) {
    return;
  }
  const side = canvas.width;
  const extent = look.lip * PAPER_MARGIN;
  const k = side / (2 * extent);
  const at = (east: number, north: number): [number, number] => [
    side / 2 + east * k,
    side / 2 - north * k,
  ];
  ctx.clearRect(0, 0, side, side);
  ctx.save();
  // Nothing beyond the lip but the gale's hatching cut at it.
  ctx.beginPath();
  ctx.arc(side / 2, side / 2, look.lip * k, 0, 2 * Math.PI);
  ctx.clip();
  const g = scene.grid;
  const cell = (2 * g.lip * k) / g.n;
  const cellAt = (i: number, j: number): [number, number] =>
    at(((i + 0.5) / g.n - 0.5) * 2 * g.lip, (0.5 - (j + 0.5) / g.n) * 2 * g.lip);
  if (layers.fog) {
    paintFog(ctx, g, look, cell, cellAt, at);
  }
  if (layers.rain) {
    paintRain(ctx, g, look, cell, cellAt);
  }
  if (layers.gusts) {
    paintGusts(ctx, g, look, cell, cellAt);
  }
  if (layers.pressure) {
    paintIsobars(ctx, g, look, k, at);
  }
  if (layers.systems) {
    if (scene.gale !== null) {
      paintGale(ctx, scene.gale, look, k, at);
    }
    for (const r of scene.risks) {
      paintRisk(ctx, r.mark, r.points, r.from, look, k, at);
    }
    for (const f of scene.fronts) {
      paintFront(ctx, f, look, k, at);
    }
    for (const s of scene.forecast) {
      paintCone(ctx, s, look, k, at, true);
    }
    for (const s of scene.systems) {
      if (scene.moment.kind === 'forecast') {
        paintCone(ctx, s, look, k, at, false);
      }
      paintSystem(ctx, s, look, k, at);
    }
  }
  ctx.restore();
}

function paintFog(
  ctx: CanvasRenderingContext2D,
  g: FieldGrid,
  look: WeatherLook,
  cell: number,
  cellAt: (i: number, j: number) => [number, number],
  at: (e: number, n: number) => [number, number],
): void {
  const poor = look.visibility[1] ?? 1852;
  const veryPoor = look.visibility[0] ?? 400;
  // The wash, a pixel a cell, drawn up smoothed: soft at its edges.
  const n = g.n;
  const wash = new OffscreenCanvas(n, n);
  const wctx = wash.getContext('2d');
  if (wctx !== null) {
    const img = wctx.createImageData(n, n);
    const c = Number.parseInt(look.fog.slice(1, 7), 16);
    for (let k = 0; k < n * n; k++) {
      const v = g.fog[k] ?? Number.NaN;
      const a = v < poor ? 0.15 + 0.35 * Math.min(1, (poor - v) / poor) : 0;
      img.data.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, Math.round(a * 255)], 4 * k);
    }
    wctx.putImageData(img, 0, 0);
    const [x0, y0] = at(-g.lip, g.lip);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(wash, x0, y0, n * cell, n * cell);
  }
  ctx.strokeStyle = alpha(look.fog, 0.9);
  ctx.lineWidth = Math.max(1, cell / 10);
  for (let j = 0; j < g.n; j++) {
    for (let i = 0; i < g.n; i++) {
      const v = g.fog[j * g.n + i] ?? Number.NaN;
      if (!(v < poor)) {
        continue;
      }
      const [x, y] = cellAt(i, j);
      // A wavy line in every other cell, as the fog symbol is lines.
      if ((i + j) % 2 === 0) {
        ctx.beginPath();
        for (let t = 0; t <= 8; t++) {
          const px = x - cell * 0.4 + (t / 8) * cell * 0.8;
          const py = y + Math.sin((t / 8) * 2 * Math.PI) * cell * 0.12;
          if (t === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
    }
  }
  // Where it is very poor, outlined.
  const grid: Grid = { side: g.n, step: (2 * g.lip) / g.n, values: g.fog };
  ctx.strokeStyle = look.fog;
  ctx.lineWidth = Math.max(2, cell / 4);
  for (const line of contour(grid, veryPoor)) {
    strokeLine(ctx, line, at);
  }
}

function strokeLine(
  ctx: CanvasRenderingContext2D,
  line: Where[],
  at: (e: number, n: number) => [number, number],
): void {
  ctx.beginPath();
  line.forEach(([e, n], i) => {
    const [x, y] = at(e, n);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function paintRain(
  ctx: CanvasRenderingContext2D,
  g: FieldGrid,
  look: WeatherLook,
  cell: number,
  cellAt: (i: number, j: number) => [number, number],
): void {
  const words = look.rainWords;
  ctx.fillStyle = look.rain;
  const r = Math.max(1, cell / 9);
  for (let j = 0; j < g.n; j++) {
    for (let i = 0; i < g.n; i++) {
      const rate = g.rain[j * g.n + i] ?? 0;
      if (!(rate >= 0.1)) {
        continue;
      }
      // More dots for heavier rain: light, moderate, heavy, violent.
      const dots =
        rate < (words[0] ?? 2.5)
          ? 2
          : rate < (words[1] ?? 10)
            ? 4
            : rate < (words[2] ?? 50)
              ? 7
              : 11;
      const [x, y] = cellAt(i, j);
      for (let d = 0; d < dots; d++) {
        const s = (j * g.n + i) * 16 + d;
        ctx.beginPath();
        ctx.arc(x + (grain(s) - 0.5) * cell, y + (grain(s + 7) - 0.5) * cell, r, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

function paintGusts(
  ctx: CanvasRenderingContext2D,
  g: FieldGrid,
  look: WeatherLook,
  cell: number,
  cellAt: (i: number, j: number) => [number, number],
): void {
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
      const [x, y] = cellAt(i, j);
      for (const t of [-0.8, 0.2]) {
        ctx.moveTo(x + dx * t * cell, y + dy * t * cell);
        ctx.lineTo(x + dx * (t + 0.5) * cell, y + dy * (t + 0.5) * cell);
      }
    }
  }
  ctx.stroke();
}

function paintIsobars(
  ctx: CanvasRenderingContext2D,
  g: FieldGrid,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
): void {
  const grid: Grid = { side: g.n, step: (2 * g.lip) / g.n, values: g.pressure };
  ctx.strokeStyle = alpha(look.ink, 0.7);
  ctx.fillStyle = look.ink;
  ctx.lineWidth = 1.2;
  ctx.font = `italic ${Math.round(look.lip * k * 0.035)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let n = 0;
  for (const level of levels(grid, 2)) {
    for (const line of level.lines) {
      strokeLine(ctx, line, at);
      // Every other line lettered, at its middle, so they do not crowd.
      if (line.length > 6 && n++ % 2 === 0) {
        const [e, nn] = line[Math.floor(line.length / 2)] as Where;
        const [x, y] = at(e, nn);
        ctx.fillText(String(level.value), x, y);
      }
    }
  }
  ctx.font = `${Math.round(look.lip * k * 0.06)}px "IM Fell English", serif`;
  for (const c of centres(grid)) {
    const [x, y] = at(c.east, c.north);
    ctx.fillText(c.high ? 'H' : 'L', x, y - look.lip * k * 0.03);
    ctx.font = `italic ${Math.round(look.lip * k * 0.03)}px "IM Fell English", serif`;
    ctx.fillText(String(Math.round(c.value)), x, y + look.lip * k * 0.025);
    ctx.font = `${Math.round(look.lip * k * 0.06)}px "IM Fell English", serif`;
  }
}

function paintGale(
  ctx: CanvasRenderingContext2D,
  gale: NonNullable<WeatherScene['gale']>,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
): void {
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
      const [x, y] = at(east, north);
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
  const step = Math.max(4, w / 3);
  ctx.beginPath();
  for (let d = -side; d < 2 * side; d += step) {
    ctx.moveTo(d, 0);
    ctx.lineTo(d - side, side);
    ctx.moveTo(d, 0);
    ctx.lineTo(d + side, side);
  }
  ctx.stroke();
  ctx.restore();
  const [x, y] = at(se / count, sn / count);
  ctx.font = `bold italic ${Math.round(look.lip * k * 0.05)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgb(236 224 194 / 90%)';
  ctx.strokeText('Gale', x, y);
  ctx.fillStyle = look.storm;
  ctx.fillText('Gale', x, y);
}

function paintRisk(
  ctx: CanvasRenderingContext2D,
  mark: string,
  points: readonly Where[],
  from: number,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
): void {
  const size = Math.round(look.lip * k * 0.04);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size}px "Alegreya Sans", sans-serif`;
  switch (mark) {
    case 'showers':
      ctx.fillStyle = alpha(look.rain, 0.8);
      for (const [e, n] of points) {
        ctx.fillText('▽', ...at(e, n));
      }
      return;
    case 'fog-patches':
      ctx.fillStyle = alpha(look.fog, 0.9);
      for (const [e, n] of points) {
        ctx.fillText('≡', ...at(e, n));
      }
      return;
    case 'calms':
      ctx.strokeStyle = alpha(look.ink, 0.6);
      ctx.lineWidth = 1.5;
      for (const [e, n] of points) {
        const [x, y] = at(e, n);
        ctx.beginPath();
        ctx.arc(x, y, size / 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
      return;
    case 'squalls': {
      // A barbed band at the windward rim, about where the wind comes from.
      const r = look.lip * 0.94 * k;
      const [cx, cy] = at(0, 0);
      // On the canvas an angle from north clockwise is atan2 about −y.
      const a0 = from - Math.PI / 2 - (50 * Math.PI) / 180;
      const a1 = from - Math.PI / 2 + (50 * Math.PI) / 180;
      ctx.strokeStyle = look.squall;
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1);
      ctx.stroke();
      ctx.beginPath();
      for (let t = a0; t <= a1; t += (a1 - a0) / 9) {
        const x = cx + Math.cos(t) * r;
        const y = cy + Math.sin(t) * r;
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(t + 0.3) * size * 0.6, y - Math.sin(t + 0.3) * size * 0.6);
      }
      ctx.stroke();
      return;
    }
  }
}

function paintFront(
  ctx: CanvasRenderingContext2D,
  f: SceneFront,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
): void {
  const reach = look.lip;
  // Along the line: across the way it moves, (cos, −sin).
  const point = (s: number, t: number): [number, number] =>
    at(f.sin * s + f.cos * t, f.cos * s - f.sin * t);
  if (f.band > 0) {
    ctx.fillStyle = alpha(look.front, 0.08);
    ctx.beginPath();
    ctx.moveTo(...point(f.line - f.band, -reach));
    ctx.lineTo(...point(f.line - f.band, reach));
    ctx.lineTo(...point(f.line + f.band, reach));
    ctx.lineTo(...point(f.line + f.band, -reach));
    ctx.closePath();
    ctx.fill();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = alpha(look.front, 0.7);
    ctx.lineWidth = 1.5;
    for (const s of [f.line - f.band, f.line + f.band]) {
      ctx.beginPath();
      ctx.moveTo(...point(s, -reach));
      ctx.lineTo(...point(s, reach));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = look.front;
  ctx.fillStyle = look.front;
  ctx.lineWidth = Math.max(2.5, look.lip * k * 0.006);
  ctx.beginPath();
  ctx.moveTo(...point(f.line, -reach));
  ctx.lineTo(...point(f.line, reach));
  ctx.stroke();
  // Triangles on the side it moves toward, every 700 m.
  const tri = 260;
  for (let t = -reach; t <= reach; t += 700) {
    const a = point(f.line, t - tri / 2);
    const b = point(f.line, t + tri / 2);
    const c = point(f.line + tri * 0.9, t);
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineTo(...c);
    ctx.closePath();
    ctx.fill();
  }
}

/** A system's colour: its cell's, its low's, or the rain's and the fog's. */
function colourOf(s: SceneSystem, look: WeatherLook): string {
  switch (s.draw) {
    case 'cell':
      return look.squall;
    case 'low':
      return look.storm;
    case 'heap':
      return look.rain;
    case 'bank':
      return look.fog;
  }
  return look.ink;
}

function paintCone(
  ctx: CanvasRenderingContext2D,
  s: SceneSystem,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
  past: boolean,
): void {
  const colour = colourOf(s, look);
  // The area the circles sweep, faint, to the step shown.
  if (!past && s.track.length > 0) {
    ctx.fillStyle = alpha(colour, 0.1);
    ctx.beginPath();
    for (const t of s.track) {
      const [x, y] = at(t.east, t.north);
      ctx.moveTo(x + t.cone * k, y);
      ctx.arc(x, y, Math.max(t.cone * k, 1), 0, 2 * Math.PI);
    }
    ctx.fill();
  }
  // The step's own circle, dashed, its edge faded.
  const [x, y] = at(s.east, s.north);
  const r = Math.max(s.cone * k, 3);
  const fade = ctx.createRadialGradient(x, y, r * 0.6, x, y, r);
  fade.addColorStop(0, alpha(colour, 0));
  fade.addColorStop(1, alpha(colour, 0.22));
  ctx.fillStyle = fade;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.setLineDash(s.forming ? [4, 6] : [10, 6]);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  // The forecast's place: a small open circle.
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, 2 * Math.PI);
  ctx.stroke();
}

function paintSystem(
  ctx: CanvasRenderingContext2D,
  s: SceneSystem,
  look: WeatherLook,
  k: number,
  at: (e: number, n: number) => [number, number],
): void {
  const [x, y] = at(s.east, s.north);
  const r = Math.max(s.size * k, 4);
  const colour = colourOf(s, look);
  const fade = Math.min(1, 0.35 + s.strength);
  const dash = s.forming ? [6, 5] : [];
  ctx.setLineDash(dash);
  // On the canvas: the heading clockwise from north, y running south.
  const ux = Math.sin(s.heading);
  const uy = -Math.cos(s.heading);
  const ahead = Math.atan2(uy, ux);
  switch (s.draw) {
    case 'cell': {
      ctx.fillStyle = alpha(colour, 0.55 * fade);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.fill();
      // The gust front: an arc ahead, barbed.
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95, ahead - 1, ahead + 1);
      ctx.stroke();
      ctx.beginPath();
      for (let t = ahead - 1; t <= ahead + 1.001; t += 0.4) {
        const px = x + Math.cos(t) * r * 0.95;
        const py = y + Math.sin(t) * r * 0.95;
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(t) * r * 0.2, py + Math.sin(t) * r * 0.2);
      }
      ctx.stroke();
      break;
    }
    case 'heap':
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.font = `${Math.round(Math.max(r * 0.6, 10))}px "Alegreya Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▽', x, y);
      break;
    case 'low': {
      // Three arms turning anticlockwise into the centre.
      ctx.strokeStyle = alpha(colour, fade);
      ctx.lineWidth = 3;
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let t = 0; t <= 1.001; t += 0.05) {
          const rr = r * (0.12 + 0.88 * t);
          const a = (arm * 2 * Math.PI) / 3 - t * 2.6;
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
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      break;
    }
    case 'bank':
      ctx.fillStyle = colour;
      ctx.font = `${Math.round(Math.max(r * 0.5, 12))}px "Alegreya Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('≡', x, y);
      break;
    case 'calm':
      ctx.strokeStyle = alpha(colour, 0.7 * fade);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      ctx.stroke();
      break;
  }
  ctx.setLineDash([]);
  // Lettered with its motion: "Squall · NE 9 kn".
  const knots = Math.round(s.speed / (1852 / 3600));
  const way = POINTS[Math.floor((((s.heading * 180) / Math.PI + 360 + 22.5) % 360) / 45)] ?? 'N';
  const text = knots < 1 ? s.name : `${s.name} · ${way} ${knots} kn`;
  ctx.font = `italic ${Math.round(look.lip * k * 0.032)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgb(236 224 194 / 85%)';
  ctx.strokeText(text, x, y + r * 0.65 + 4);
  ctx.fillStyle = look.ink;
  ctx.fillText(text, x, y + r * 0.65 + 4);
}

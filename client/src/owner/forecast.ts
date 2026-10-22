// SPDX-License-Identifier: AGPL-3.0-only

// The forecast on the world page's map, drawn over the truth for the owner,
// who alone may see both: each system's forecast track through its steps,
// its cone swept along it, dashed, a forming low's a band of one width,
// and where the forecast puts it at the tick shown, an open circle beside
// the truth's mark; each front's forecast line at the tick shown with its
// band, and faintly where it will be at each step; the water in a gale at
// the tick shown hatched and lettered; and the risk the regime in force
// brings, which no forecast places. And the forecast's calibration and the
// world's gale warnings, in the few words and rows the cards give them.

import type {
  CalibrationPage,
  ForecastFront,
  ForecastPage,
  ForecastSpell,
  ForecastSystem,
  GaleWarning,
} from './api';
import { brief } from './life';
import { toScreen, type View } from './map';
import { frontLine } from './weather';

/** The forecast's colours, Okabe and Ito's, apart from the truth's. */
export const FORECAST_COLOURS = {
  system: '#56b4e9',
  forming: '#cc79a7',
  front: '#e69f00',
  gale: '#d55e00',
  risk: '#ffffff',
};

/** The tick shown as a step of the forecast, with its fraction: 0 at the issue, the last step at most. */
export function stepOf(f: ForecastPage, at: number): number {
  const s = (at - f.issue) / Math.max(1, f.step);
  return Math.min(Math.max(s, 0), Math.max(0, f.steps - 1));
}

/** Two numbers between a and b, by u. */
function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/**
 * Where the forecast puts a system at a step with its fraction, east, north
 * and its cone's radius, between the steps about it; at the step before
 * alone if it is not alive at the next; null if it is not alive at either.
 */
export function systemAt(s: ForecastSystem, step: number): [number, number, number] | null {
  const k = Math.floor(step);
  const a = s.steps[k];
  const b = s.steps[k + 1];
  const u = step - k;
  if (a === undefined || a[3] <= 0) {
    return b !== undefined && b[3] > 0 && u > 0.5 ? [b[0], b[1], b[2]] : null;
  }
  if (b === undefined || b[3] <= 0 || u === 0) {
    return [a[0], a[1], a[2]];
  }
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

/** A front's forecast line and band at a step with its fraction, between the steps about it; null where it is not crossing. */
export function frontAt(f: ForecastFront, step: number): [number, number] | null {
  const k = Math.floor(step);
  const a = f.lines[k] ?? null;
  const b = f.lines[k + 1] ?? null;
  const u = step - k;
  if (a === null) {
    return b !== null && u > 0.5 ? b : null;
  }
  if (b === null || u === 0) {
    return a;
  }
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
}

/** The spell in force at a tick of a forecast's spells: the last begun by it, or the first. */
export function spellAt(spells: readonly ForecastSpell[], at: number): ForecastSpell | null {
  let out: ForecastSpell | null = spells[0] ?? null;
  for (const s of spells) {
    if (s.begin <= at) {
      out = s;
    }
  }
  return out;
}

/** A regime's risk in a few words: "squally showers (showers, squalls)". */
export function riskWords(s: ForecastSpell): string {
  if (s.risk === '') {
    return '';
  }
  return s.marks.length > 0 ? `${s.risk} (${s.marks.join(', ')})` : s.risk;
}

/** The bits a gale area's base64 carries: point n the bit n mod 8 of byte n / 8. */
export function areaBits(area: string): Uint8Array {
  if (area === '') {
    return new Uint8Array(0);
  }
  const raw = atob(area);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/** The points of a gale area, east and north, on a grid side points a side, grid m apart about the centre. */
export function areaPoints(area: string, side: number, grid: number): [number, number][] {
  const bits = areaBits(area);
  const c = (side - 1) / 2;
  const out: [number, number][] = [];
  for (let n = 0; n < side * side; n++) {
    if (((bits[n >> 3] ?? 0) >> (n & 7)) & 1) {
      out.push([((n % side) - c) * grid, (Math.floor(n / side) - c) * grid]);
    }
  }
  return out;
}

/** A circle on the canvas: its centre and radius. */
export type Circle = [number, number, number];

/**
 * The two lines that touch two circles on their outer sides, each from the
 * first circle to the second: the edges of a cone swept from one to the
 * other. None where one circle holds the other.
 */
export function outerTangents(a: Circle, b: Circle): [[number, number], [number, number]][] {
  const [x1, y1, r1] = a;
  const [x2, y2, r2] = b;
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (d <= Math.abs(r1 - r2) || d === 0) {
    return [];
  }
  const theta = Math.atan2(y2 - y1, x2 - x1);
  const alpha = Math.acos((r1 - r2) / d);
  return [theta + alpha, theta - alpha].map((phi) => {
    const [c, s] = [Math.cos(phi), Math.sin(phi)];
    return [
      [x1 + r1 * c, y1 + r1 * s],
      [x2 + r2 * c, y2 + r2 * s],
    ];
  });
}

/** A row of the calibration's table: what is counted, and at each lead its share inside and its cases. */
export interface CalibrationRow {
  name: string;
  cells: { share: string; cases: number }[];
}

/** The calibration's rows: the systems alive at the issue, the lows forming, the fronts' lines. */
export function calibrationRows(c: CalibrationPage): CalibrationRow[] {
  const row = (name: string, counts: readonly [number, number][]): CalibrationRow => ({
    name,
    cells: counts.map(([inside, cases]) => ({
      share: cases > 0 ? `${Math.round((100 * inside) / cases)}%` : '—',
      cases,
    })),
  });
  return [
    row('Systems alive at the issue', c.alive),
    row('Lows forming', c.forming),
    row("Fronts' lines", c.fronts),
  ];
}

/** When a gale warning was in force, in a few words: "Mon 19 Oct, 18:40 to 20:10", "since …" while it is. */
export function warningSpan(w: GaleWarning, every: number, epoch: number, tps: number): string {
  const ms = (t: number): number => epoch + (t / tps) * 1000;
  return w.inForce
    ? `since ${brief(ms(w.key))}`
    : `${brief(ms(w.key))} to ${brief(ms(w.last + every))}`;
}

/** Text with a dark halo, legible over land and sea. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** A path's line through canvas points, from the first. */
function through(ctx: CanvasRenderingContext2D, points: readonly (readonly number[])[]): void {
  points.forEach(([x = 0, y = 0], k) => {
    if (k === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
}

/** A system's forecast: its track, its cone swept along it, dashed, and where it is forecast at the step shown. */
function drawSystem(
  ctx: CanvasRenderingContext2D,
  v: View,
  s: ForecastSystem,
  step: number,
  name: string,
): void {
  const colour = s.forming ? FORECAST_COLOURS.forming : FORECAST_COLOURS.system;
  const alive = s.steps
    .filter((p) => p[3] > 0)
    .map((p): Circle => {
      const [x, y] = toScreen(v, p[0], p[1]);
      return [x, y, p[2] / v.scale];
    });
  if (alive.length === 0) {
    return;
  }
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  // Its track through its steps, a dot at each.
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  through(ctx, alive);
  ctx.stroke();
  for (const [x, y] of alive) {
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }
  // Its cone: the circle at each step and the lines that sweep them, dashed.
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (const [x, y, r] of alive) {
    if (r > 0.5) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
  }
  for (let k = 1; k < alive.length; k++) {
    const a = alive[k - 1];
    const b = alive[k];
    if (a === undefined || b === undefined) {
      continue;
    }
    for (const [p, q] of outerTangents(a, b)) {
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  // Where it is forecast at the step shown: an open circle.
  const at = systemAt(s, step);
  if (at !== null) {
    const [x, y] = toScreen(v, at[0], at[1]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.font = 'italic 10px "Alegreya Sans", sans-serif';
    ctx.textAlign = 'center';
    label(ctx, `${name}${s.forming ? ', forming' : ''} (forecast)`, x, y - 11);
    ctx.textAlign = 'start';
  }
}

/** A front's forecast: faintly its line at each step, and at the step shown its line, dashed, and its band shaded. */
function drawFront(
  ctx: CanvasRenderingContext2D,
  v: View,
  f: ForecastFront,
  step: number,
  lip: number,
): void {
  const chord = (line: number): [[number, number], [number, number]] | null =>
    frontLine(
      { toward: f.toward, line, knots: 0, depth: 0, enters: 0, leaves: 0, portRoyal: 0 },
      lip,
    );
  const stroke = (ends: [[number, number], [number, number]]): void => {
    const [x0, y0] = toScreen(v, ends[0][0], ends[0][1]);
    const [x1, y1] = toScreen(v, ends[1][0], ends[1][1]);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  };
  ctx.strokeStyle = FORECAST_COLOURS.front;
  ctx.fillStyle = FORECAST_COLOURS.front;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const l of f.lines) {
    const ends = l === null ? null : chord(l[0]);
    if (ends !== null) {
      stroke(ends);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  const now = frontAt(f, step);
  if (now === null) {
    return;
  }
  const [line, band] = now;
  // The band: the strip of the disk within band of the line.
  if (band > 0) {
    const a = (f.toward * Math.PI) / 180;
    const [ue, un] = [Math.sin(a), Math.cos(a)];
    const [we, wn] = [Math.cos(a), -Math.sin(a)];
    const corner = (along: number, across: number): [number, number] =>
      toScreen(v, along * ue + across * we, along * un + across * wn);
    const [cx, cy] = toScreen(v, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, lip / v.scale, 0, 2 * Math.PI);
    ctx.clip();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    const corners = [
      corner(line - band, -lip),
      corner(line - band, lip),
      corner(line + band, lip),
      corner(line + band, -lip),
    ];
    through(ctx, corners);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  const ends = chord(line);
  if (ends !== null) {
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    stroke(ends);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The water in a gale at the step shown: its points' cells hatched, and "Gale" with its force lettered over them. */
function drawGale(ctx: CanvasRenderingContext2D, v: View, f: ForecastPage, step: number): void {
  const g = f.gale;
  const area = g?.areas[Math.round(step)] ?? '';
  if (g === null || area === '') {
    return;
  }
  const points = areaPoints(area, f.galeSide, f.galeGrid);
  const half = f.galeGrid / 2 / v.scale;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  let [sx, sy] = [0, 0];
  ctx.save();
  ctx.beginPath();
  for (const [e, n] of points) {
    const [x, y] = toScreen(v, e, n);
    ctx.rect(x - half, y - half, 2 * half, 2 * half);
    [x0, y0, x1, y1] = [
      Math.min(x0, x - half),
      Math.min(y0, y - half),
      Math.max(x1, x + half),
      Math.max(y1, y + half),
    ];
    sx += x;
    sy += y;
  }
  ctx.clip();
  ctx.strokeStyle = FORECAST_COLOURS.gale;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  // Lines down to the right, every 7 pixels.
  for (let c = x0 - (y1 - y0); c < x1; c += 7) {
    ctx.moveTo(c, y0);
    ctx.lineTo(c + (y1 - y0), y1);
  }
  ctx.stroke();
  ctx.restore();
  ctx.font = 'bold 13px "Alegreya Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = FORECAST_COLOURS.gale;
  label(ctx, `Gale ${g.force}`, sx / points.length, sy / points.length);
  ctx.textAlign = 'start';
}

/** Draws the forecast of f in view v at the tick shown, its systems named by the week's kinds. */
export function drawForecast(
  ctx: CanvasRenderingContext2D,
  v: View,
  f: ForecastPage,
  at: number,
  kinds: readonly { id: string }[],
): void {
  const step = stepOf(f, at);
  drawGale(ctx, v, f, step);
  for (const fr of f.fronts) {
    drawFront(ctx, v, fr, step, f.lip);
  }
  for (const s of f.systems) {
    drawSystem(ctx, v, s, step, s.id || (kinds[s.kind]?.id ?? String(s.kind)));
  }
  // The risk the regime in force brings, above the disk.
  const spell = spellAt(f.spells, at);
  const words = spell === null ? '' : riskWords(spell);
  if (words !== '') {
    const [x, y] = toScreen(v, 0, f.lip);
    ctx.font = 'italic 12px "Alegreya Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = FORECAST_COLOURS.risk;
    label(ctx, `Risk: ${words}`, x, y - 8);
    ctx.textAlign = 'start';
  }
}

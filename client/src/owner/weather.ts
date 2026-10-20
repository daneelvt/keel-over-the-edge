// SPDX-License-Identifier: AGPL-3.0-only

// The weather on the world page's map, in a chart's symbols, each system
// drawn by the shape of the pressure it carries and never by its name: a
// dome a dark cell, darker the stronger it is, with a barbed arc on its
// leading edge, the gusts it drives before it; a low a spiral turning
// anticlockwise inward, as the wind turns round it; a patch with no
// pressure of its own a wavy ring. Each trails its true track for the hour
// after, dashed. A front is a line across the disk, its teeth on the side
// it moves toward. Over the systems the isobars, every 2 hPa and
// labelled, with the highs and the lows marked, so that a dark cell hides
// none of them. And the few words the week's card tells
// the weather in.

import type { Front, PressureGrid, SystemKind, WeatherSystem, WeatherWeek } from './api';
import { type Centre, centres, type Isobar, isobars } from './isobars';
import { canvasAngle, toScreen, type View } from './map';

/** The regimes' colours on the week's strip, by index: calm, told apart in the dark. */
export const REGIME_COLOURS = ['#c9b877', '#6fa88f', '#6f8fb5', '#8f7aa6', '#a9806e'];

export function regimeColour(i: number): string {
  return REGIME_COLOURS[i % REGIME_COLOURS.length] ?? '#888888';
}

/** The colours of the weather's marks, on the map and on the strip alike. */
export const WEATHER_COLOURS = {
  front: '#8cc4ff',
  dome: '#dfe7ee',
  low: '#ff9e7a',
  patch: '#d8dee2',
  isobar: 'rgb(255 255 255 / 42%)',
  high: '#9fc5e8',
  developer: '#e8b450',
};

/** A system's stage, by number. */
export const STAGES = ['growing', 'mature', 'decaying'];

/** The isobars between them, every so many hPa. */
export const ISOBAR_EVERY = 2;

/** A span of ticks from now, in a few words: "in 1 h 05 min", "12 min ago", "now" within the minute. */
export function fromNow(ticks: number, ticksPerSecond: number): string {
  const s = Math.abs(ticks) / ticksPerSecond;
  if (s < 60) {
    return 'now';
  }
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  const words =
    m < 60
      ? `${m} min`
      : h < 48
        ? `${h} h ${String(m % 60).padStart(2, '0')} min`
        : `${Math.floor(h / 24)} d ${h % 24} h`;
  return ticks > 0 ? `in ${words}` : `${words} ago`;
}

/** Where a point is from the disk's centre: "3.2 km at 045°". */
export function whereFrom(east: number, north: number): string {
  const d = Math.hypot(east, north);
  if (d < 50) {
    return 'at the centre';
  }
  const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return `${(d / 1000).toFixed(1)} km at ${String(Math.round(bearing) % 360).padStart(3, '0')}°`;
}

/**
 * A front's line across the disk, its two ends where it meets the lip, east
 * and north; null once it is beyond the lip.
 */
export function frontLine(f: Front, lip: number): [[number, number], [number, number]] | null {
  if (Math.abs(f.line) >= lip) {
    return null;
  }
  const a = (f.toward * Math.PI) / 180;
  // The way it moves, and along its line, square to it.
  const [ue, un] = [Math.sin(a), Math.cos(a)];
  const [we, wn] = [Math.cos(a), -Math.sin(a)];
  const half = Math.sqrt(lip * lip - f.line * f.line);
  return [
    [f.line * ue - half * we, f.line * un - half * wn],
    [f.line * ue + half * we, f.line * un + half * wn],
  ];
}

/** The isobars and the highs and lows of a grid, contoured once a reading. */
const contoured = new WeakMap<PressureGrid, { bars: Isobar[]; marks: Centre[] }>();

function contourOf(g: PressureGrid): { bars: Isobar[]; marks: Centre[] } {
  let c = contoured.get(g);
  if (c === undefined) {
    c = { bars: isobars(g, ISOBAR_EVERY), marks: centres(g) };
    contoured.set(g, c);
  }
  return c;
}

/** Text with a dark halo, legible over land and sea. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

function drawIsobars(ctx: CanvasRenderingContext2D, v: View, g: PressureGrid): void {
  const { bars, marks } = contourOf(g);
  ctx.strokeStyle = WEATHER_COLOURS.isobar;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const b of bars) {
    for (const line of b.lines) {
      line.forEach(([e, n], k) => {
        const [x, y] = toScreen(v, e, n);
        if (k === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
    }
  }
  ctx.stroke();
  // Each line long enough labelled at its middle.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '10px "Alegreya Sans", sans-serif';
  ctx.fillStyle = '#ffffff';
  for (const b of bars) {
    for (const line of b.lines) {
      const mid = line[Math.floor(line.length / 2)];
      if (line.length < 6 || mid === undefined) {
        continue;
      }
      const [x, y] = toScreen(v, mid[0], mid[1]);
      label(ctx, String(Math.round(b.hPa)), x, y);
    }
  }
  for (const m of marks) {
    const [x, y] = toScreen(v, m.east, m.north);
    ctx.font = 'bold 16px "Alegreya Sans", sans-serif';
    ctx.fillStyle = m.high ? WEATHER_COLOURS.high : WEATHER_COLOURS.low;
    label(ctx, m.high ? 'H' : 'L', x, y);
    ctx.font = '10px "Alegreya Sans", sans-serif';
    label(ctx, m.hPa.toFixed(0), x, y + 13);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function drawFront(ctx: CanvasRenderingContext2D, v: View, f: Front, lip: number): void {
  const ends = frontLine(f, lip);
  if (ends === null) {
    return;
  }
  const [x0, y0] = toScreen(v, ends[0][0], ends[0][1]);
  const [x1, y1] = toScreen(v, ends[1][0], ends[1][1]);
  ctx.strokeStyle = WEATHER_COLOURS.front;
  ctx.fillStyle = WEATHER_COLOURS.front;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // Its teeth, about every 28 pixels, pointing the way it moves: north up
  // the canvas, so the canvas's y is the north turned over.
  const length = Math.hypot(x1 - x0, y1 - y0);
  const teeth = Math.floor(length / 28);
  const [dx, dy] = [(x1 - x0) / length, (y1 - y0) / length];
  const a = (f.toward * Math.PI) / 180;
  const [mx, my] = [Math.sin(a), -Math.cos(a)];
  ctx.beginPath();
  for (let k = 0; k < teeth; k++) {
    const c = ((k + 0.5) * length) / teeth;
    const [cx, cy] = [x0 + dx * c, y0 + dy * c];
    ctx.moveTo(cx - dx * 6, cy - dy * 6);
    ctx.lineTo(cx + dx * 6, cy + dy * 6);
    ctx.lineTo(cx + mx * 8, cy + my * 8);
    ctx.closePath();
  }
  ctx.fill();
}

/** A dome: a dark cell, and its barbed arc on the side it moves toward. */
function drawDome(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  heading: number,
  strength: number,
): void {
  ctx.fillStyle = `rgb(6 10 16 / ${Math.round(20 + 55 * strength)}%)`;
  ctx.strokeStyle = WEATHER_COLOURS.dome;
  ctx.globalAlpha = 0.4 + 0.6 * strength;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  const a = canvasAngle(heading);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, a - 1, a + 1);
  ctx.stroke();
  // Its barbs along the arc, outward, about every 12 pixels.
  ctx.fillStyle = WEATHER_COLOURS.dome;
  const barbs = Math.min(7, Math.max(1, Math.floor((2 * r) / 12)));
  const half = Math.min(0.2, 3 / r);
  ctx.beginPath();
  for (let k = 0; k < barbs; k++) {
    const b = a - 1 + ((k + 0.5) * 2) / barbs;
    ctx.moveTo(x + r * Math.cos(b - half), y + r * Math.sin(b - half));
    ctx.lineTo(x + (r + 6) * Math.cos(b), y + (r + 6) * Math.sin(b));
    ctx.lineTo(x + r * Math.cos(b + half), y + r * Math.sin(b + half));
    ctx.closePath();
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * A low: two arms spiralling inward, turning anticlockwise as they go in,
 * as the wind does about it north up. The canvas's angles turn clockwise,
 * so an arm going in turns through falling angles.
 */
function drawLow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  strength: number,
): void {
  ctx.strokeStyle = WEATHER_COLOURS.low;
  ctx.globalAlpha = 0.4 + 0.6 * strength;
  ctx.lineWidth = 1.5 + strength;
  ctx.beginPath();
  for (const arm of [0, Math.PI]) {
    for (let k = 0; k <= 48; k++) {
      const t = k / 48;
      const rr = r * (1 - 0.88 * t);
      const a = arm - t * 1.6 * Math.PI;
      const [px, py] = [x + rr * Math.cos(a), y + rr * Math.sin(a)];
      if (k === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
  }
  ctx.stroke();
  ctx.fillStyle = WEATHER_COLOURS.low;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** A patch with no pressure of its own: a wavy ring, its waves about every 10 pixels. */
function drawPatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  strength: number,
): void {
  const waves = Math.max(8, Math.round((2 * Math.PI * r) / 10));
  ctx.strokeStyle = WEATHER_COLOURS.patch;
  ctx.globalAlpha = 0.35 + 0.65 * strength;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const steps = waves * 8;
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * 2 * Math.PI;
    const rr = r + 2 * Math.sin(waves * a);
    const [px, py] = [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    if (k === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawSystem(
  ctx: CanvasRenderingContext2D,
  v: View,
  s: WeatherSystem,
  kind: SystemKind | undefined,
): void {
  const [x, y] = toScreen(v, s.east, s.north);
  const r = Math.max(5, s.size / v.scale);
  const strength = Math.min(1, Math.max(0, s.strength));
  const shape = kind?.shape;
  const colour =
    shape === 'dome'
      ? WEATHER_COLOURS.dome
      : shape === 'low'
        ? WEATHER_COLOURS.low
        : WEATHER_COLOURS.patch;
  // Its track for the hour after, dashed, a dot at each five minutes.
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  s.track.forEach(([e, n], k) => {
    const [px, py] = toScreen(v, e, n);
    if (k === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [e, n] of s.track.slice(1)) {
    const [px, py] = toScreen(v, e, n);
    ctx.fillRect(px - 1, py - 1, 2, 2);
  }
  if (shape === 'dome') {
    drawDome(ctx, x, y, r, s.heading, strength);
  } else if (shape === 'low') {
    drawLow(ctx, x, y, r, strength);
  } else {
    drawPatch(ctx, x, y, r, strength);
  }
  if (s.developer) {
    // A developer's ringed in gold.
    ctx.strokeStyle = WEATHER_COLOURS.developer;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = 'italic 10px "Alegreya Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  label(ctx, `${kind?.id ?? s.kind}${s.developer ? ' (developer)' : ''}`, x, y + r + 16);
  ctx.textAlign = 'start';
}

/** Draws the weather of w in view v: its systems and their tracks, its isobars, its front. */
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  v: View,
  w: WeatherWeek,
  layers: { systems: boolean; isobars: boolean },
): void {
  if (layers.systems) {
    for (const s of w.systems) {
      drawSystem(ctx, v, s, w.kinds[s.kind]);
    }
  }
  if (layers.isobars) {
    drawIsobars(ctx, v, w.pressure);
  }
  if (layers.systems && w.front !== null) {
    drawFront(ctx, v, w.front, w.lip);
  }
}

// SPDX-License-Identifier: AGPL-3.0-only

// The forecast on the world page's map, drawn over the truth for the owner,
// who alone may see both: each system's track over the forecast's reach,
// made from its record as a phone makes it, a dot every ten minutes, and
// where it is at the tick shown, an open circle beside the truth's mark, a
// line drawn across its motion at its length; each front's line at the
// tick shown, a cold front's triangles or a warm front's semicircles, and
// faintly where it will be at each step; and the water in a gale at the
// tick shown hatched and lettered. The forecast is the truth, so its marks
// lie on the truth's own. And the world's gale warnings and how busy its
// weather has been, in the few words and rows the cards give them.

import type {
  BusyFigures,
  ForecastFront,
  ForecastPage,
  ForecastSpell,
  ForecastSystem,
  GaleWarning,
  SystemKind,
} from './api';
import { brief } from './life';
import { toScreen, type View } from './map';
import { drawFrontLine, drawLine, frontLine, lineEnds } from './weather';

/** The forecast's colours, Okabe and Ito's, apart from the truth's. */
export const FORECAST_COLOURS = {
  system: '#56b4e9',
  storm: '#cc79a7',
  gale: '#d55e00',
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
 * Where the forecast puts a system at a tick, east, north, its strength and
 * the degrees it moves toward, between its track's points about it, every
 * ticks apart; null before its first or after its last.
 */
export function trackAt(
  s: ForecastSystem,
  at: number,
  every: number,
): [number, number, number, number] | null {
  const u = (at - s.from) / Math.max(1, every);
  const k = Math.floor(u);
  const a = s.track[k];
  if (u < 0 || a === undefined) {
    return null;
  }
  const b = s.track[k + 1];
  if (b === undefined) {
    return u === k ? [...a] : null;
  }
  const f = u - k;
  // The heading the shorter way round.
  const turn = ((((b[3] - a[3]) % 360) + 540) % 360) - 180;
  return [
    lerp(a[0], b[0], f),
    lerp(a[1], b[1], f),
    lerp(a[2], b[2], f),
    (a[3] + turn * f + 360) % 360,
  ];
}

/** A front's line at a tick, m from the centre along the way it moves; null where it is not crossing. */
export function frontLineAt(f: ForecastFront, at: number, reach: number): number | null {
  if (f.cross <= 0 || at < f.begin || at > f.begin + f.cross) {
    return null;
  }
  return (2 * reach * (at - f.begin)) / f.cross - reach;
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

/** When a gale warning was in force, in a few words: "Mon 19 Oct, 18:40 to 20:10", "since …" while it is. */
export function warningSpan(w: GaleWarning, every: number, epoch: number, tps: number): string {
  const ms = (t: number): number => epoch + (t / tps) * 1000;
  return w.inForce
    ? `since ${brief(ms(w.key))}`
    : `${brief(ms(w.key))} to ${brief(ms(w.last + every))}`;
}

/** A row of the busy weather's table: what is counted, and its share so far and over the week. */
export interface BusyRow {
  name: string;
  soFar: string;
  week: string;
}

/** The busy weather's rows: the shares of the minutes, %, and the systems on the disk on average, overall and by regime. */
export function busyRows(soFar: BusyFigures, week: BusyFigures): BusyRow[] {
  const pct = (v: number, n: number): string => (n > 0 ? `${v.toFixed(1)}%` : '—');
  const mean = (v: number, n: number): string => (n > 0 ? v.toFixed(1) : '—');
  const row = (name: string, of: (f: BusyFigures) => number): BusyRow => ({
    name,
    soFar: pct(of(soFar), soFar.minutes),
    week: pct(of(week), week.minutes),
  });
  const rows = [
    row('Nothing on the disk', (f) => f.empty),
    row('Rain somewhere', (f) => f.rain),
    row('A storm or a low', (f) => f.lows),
    row('A storm', (f) => f.storms),
    row('A front or a trough', (f) => f.lines),
    {
      name: 'Systems on the disk, on average',
      soFar: mean(soFar.systems, soFar.minutes),
      week: mean(week.systems, week.minutes),
    },
  ];
  week.regimes.forEach((r, i) => {
    const s = soFar.regimes[i];
    rows.push({
      name: `Systems on average, ${r.id}`,
      soFar: mean(s?.systems ?? 0, s?.minutes ?? 0),
      week: mean(r.systems, r.minutes),
    });
  });
  return rows;
}

/** Text with a dark halo, legible over land and sea. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** A system's forecast: its track over the reach, a dot every ten minutes, and where it is at the tick shown. */
function drawSystem(
  ctx: CanvasRenderingContext2D,
  v: View,
  f: ForecastPage,
  s: ForecastSystem,
  at: number,
  kind: SystemKind | undefined,
): void {
  if (s.track.length === 0) {
    return;
  }
  const colour = kind?.storm === true ? FORECAST_COLOURS.storm : FORECAST_COLOURS.system;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  s.track.forEach(([e, n], k) => {
    const [x, y] = toScreen(v, e, n);
    if (k === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  // A dot at every ten minutes from the issue: the track's points are a
  // minute apart.
  s.track.forEach(([e, n], k) => {
    if ((s.from + k * f.every - f.issue) % (10 * f.every) === 0) {
      const [x, y] = toScreen(v, e, n);
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  });
  ctx.globalAlpha = 1;
  // Where it is at the tick shown: an open circle, a line drawn across.
  const now = trackAt(s, at, f.every);
  if (now === null) {
    return;
  }
  const [x, y] = toScreen(v, now[0], now[1]);
  if (s.length > 0) {
    drawLine(
      ctx,
      lineEnds(v, now[0], now[1], s.length, now[3]),
      now[3],
      kind?.symbol ?? '',
      now[2],
    );
    ctx.strokeStyle = colour;
  }
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.font = 'italic 10px "Alegreya Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = colour;
  label(ctx, `${kind?.name || s.id || s.kind} (forecast)`, x, y - 11);
  ctx.textAlign = 'start';
}

/** A front's forecast: faintly its line at each step, and at the tick shown its line, warm or cold. */
function drawFront(
  ctx: CanvasRenderingContext2D,
  v: View,
  f: ForecastPage,
  fr: ForecastFront,
  at: number,
): void {
  const chord = (line: number): [[number, number], [number, number]] | null =>
    frontLine(
      {
        toward: fr.toward,
        line,
        knots: 0,
        depth: 0,
        enters: 0,
        leaves: 0,
        portRoyal: 0,
        warm: fr.warm,
      },
      f.lip,
    );
  const draw = (line: number | null, alpha: number): void => {
    const ends = line === null ? null : chord(line);
    if (ends === null) {
      return;
    }
    const [x0, y0] = toScreen(v, ends[0][0], ends[0][1]);
    const [x1, y1] = toScreen(v, ends[1][0], ends[1][1]);
    drawFrontLine(ctx, x0, y0, x1, y1, fr.toward, fr.warm, alpha);
  };
  for (let k = 0; k < f.steps; k++) {
    draw(frontLineAt(fr, f.issue + k * f.step, f.reach), 0.25);
  }
  ctx.setLineDash([8, 5]);
  draw(frontLineAt(fr, at, f.reach), 1);
  ctx.setLineDash([]);
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
  kinds: readonly SystemKind[],
): void {
  drawGale(ctx, v, f, stepOf(f, at));
  for (const fr of f.fronts) {
    drawFront(ctx, v, f, fr, at);
  }
  for (const s of f.systems) {
    drawSystem(ctx, v, f, s, at, kinds[s.kind]);
  }
}

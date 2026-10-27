// SPDX-License-Identifier: AGPL-3.0-only

// The pocket chart's weather: the wind's wash, the rain, the fog, the
// storms and lows with their rings, the squall lines and troughs and the
// fronts over the disk now, simplified for a picture a few centimetres
// across, from the forecast's own module set to the present; the small
// cells are left to the chart. No barbs and no forecast: the chart has
// those. Drawn by the CPU twice a second, so it is kept to a coarse grid
// and a few strokes.

import type { Forecasting } from './forecasting';
import { frontsAt, gridPoints, type SceneFront, type SceneSystem, systemsOfKeys } from './weather';
import { weatherLooks } from './weatherlayer';
import { alpha, colourOf, type WeatherLook, washStep } from './weatherpaint';

/** The weather the pocket chart draws: a coarse grid of the mean wind, rain and fog, the systems and the fronts. */
export interface PocketWeather {
  n: number;
  lip: number;
  /** The mean wind, m/s. */
  mean: Float64Array;
  rain: Float64Array;
  /** The fog banks' visibility, m. */
  fog: Float64Array;
  systems: SceneSystem[];
  fronts: SceneFront[];
  look: WeatherLook;
}

/** The grid's points a side. */
const N = 24;

let points: Float64Array | null = null;

/** The pocket chart's weather now, or null while the forecast's module is made. */
export function pocketWeather(src: Forecasting): PocketWeather | null {
  const fields = src.fields();
  if (fields === null) {
    return null;
  }
  const looks = weatherLooks();
  const look = looks.scene;
  const tick = src.tick();
  const present = src.present();
  fields.truthAt(present.keys, present.spells, tick);
  points ??= gridPoints(N, look.lip);
  const p = fields.physics;
  const typical = p.typicalSample(points, new Float64Array(3 * N * N));
  const rain = p.rainSample(points, new Float64Array(N * N));
  const mean = new Float64Array(N * N);
  const fog = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    mean[k] = typical[3 * k] ?? 0;
    const air = p.airAt(points[2 * k] ?? 0, points[2 * k + 1] ?? 0, 2);
    fog[k] = look.contrast / Math.max((air[0] ?? 0) + (air[1] ?? 0), 1e-9);
  }
  return {
    n: N,
    lip: look.lip,
    mean,
    rain,
    fog,
    systems: systemsOfKeys(present.keys, tick, look.kinds).filter(
      (s) => s.ring > 0 || s.length > 0,
    ),
    fronts: frontsAt(present.spells, tick, p.frontReach()),
    look: looks.paint,
  };
}

/**
 * Draws the pocket chart's weather, under its islands, on a disk seen
 * tilted: x and y place a point east and north, k pixels a metre across,
 * tilt times that up and down. The wash, fog's grey and rain's dots by the
 * grid's cells; the fronts with three of their triangles or semicircles;
 * a squall line or a trough a short line, solid or dashed; a storm or a low
 * its ring, solid or dashed, about a dot.
 */
export function drawPocketWeather(
  ctx: CanvasRenderingContext2D,
  w: PocketWeather,
  x: (east: number) => number,
  y: (north: number) => number,
  k: number,
  tilt: number,
): void {
  const look = w.look;
  const cell = (2 * w.lip) / w.n;
  const tints = look.wash.tints.map((t) => alpha(look.wash.colour, t));
  for (let j = 0; j < w.n; j++) {
    for (let i = 0; i < w.n; i++) {
      const kk = j * w.n + i;
      const east = ((i + 0.5) / w.n - 0.5) * 2 * w.lip;
      const north = (0.5 - (j + 0.5) / w.n) * 2 * w.lip;
      if (east * east + north * north > w.lip * w.lip) {
        continue;
      }
      const cx = x(east - cell / 2);
      const cy = y(north + cell / 2);
      const step = washStep(w.mean[kk] ?? 0, look.wash.forces);
      if (step > 0) {
        ctx.fillStyle = tints[step - 1] ?? 'transparent';
        // A hair over the cell, so the wash shows no seams.
        ctx.fillRect(cx, cy, cell * k + 0.5, cell * k * tilt + 0.5);
      }
      if ((w.fog[kk] ?? Number.POSITIVE_INFINITY) < 1852) {
        ctx.fillStyle = alpha(look.fog, 0.45);
        ctx.fillRect(cx, cy, cell * k, cell * k * tilt);
      }
      if ((w.rain[kk] ?? 0) >= 0.1) {
        ctx.fillStyle = alpha(look.rain, 0.85);
        ctx.fillRect(x(east) - 1, y(north) - 1, 2, 2);
      }
    }
  }
  for (const f of w.fronts) {
    if (Math.abs(f.line) >= w.lip) {
      continue;
    }
    // The chord of the line within the lip, along (cos, −sin).
    const reach = Math.sqrt(w.lip * w.lip - f.line * f.line);
    const at = (t: number, ahead = 0): [number, number] => [
      x(f.sin * (f.line + ahead) + f.cos * t),
      y(f.cos * (f.line + ahead) - f.sin * t),
    ];
    const colour = f.warm ? look.warm : look.cold;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(...at(-reach));
    ctx.lineTo(...at(reach));
    ctx.stroke();
    const size = 3.5 / k;
    for (const t of [-reach / 2, 0, reach / 2]) {
      ctx.beginPath();
      if (f.warm) {
        // A semicircle: round the leading side from one end of its base to the other.
        for (let s = 0; s <= 6; s++) {
          const a = (s / 6) * Math.PI;
          ctx.lineTo(...at(t - Math.cos(a) * size, Math.sin(a) * size));
        }
      } else {
        ctx.moveTo(...at(t - size));
        ctx.lineTo(...at(t + size));
        ctx.lineTo(...at(t, size * 1.6));
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  for (const s of w.systems) {
    const colour = colourOf(s.draw, look);
    const fade = Math.min(1, 0.35 + s.strength);
    ctx.strokeStyle = alpha(colour, fade);
    ctx.fillStyle = alpha(colour, fade);
    if (s.length > 0) {
      // Along (cos, −sin) of its heading, east and north.
      const ae = Math.cos(s.heading) * (s.length / 2);
      const an = -Math.sin(s.heading) * (s.length / 2);
      ctx.lineWidth = s.draw === 'dash-dot' ? 2.5 : 1.5;
      ctx.setLineDash(s.draw === 'dash-dot' ? [] : [3, 2]);
      ctx.beginPath();
      ctx.moveTo(x(s.east - ae), y(s.north - an));
      ctx.lineTo(x(s.east + ae), y(s.north + an));
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    // A storm's ring solid and heavy, a low's dashed.
    const r = Math.max(s.ring * k, 3);
    ctx.lineWidth = s.draw === 'spiral' ? 2.5 : 1.5;
    ctx.setLineDash(s.draw === 'spiral' ? [] : [3, 2]);
    ctx.beginPath();
    ctx.ellipse(x(s.east), y(s.north), r, r * tilt, 0, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x(s.east), y(s.north), 2, 0, 2 * Math.PI);
    ctx.fill();
  }
}

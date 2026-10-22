// SPDX-License-Identifier: AGPL-3.0-only

// The fog and the lightning on the world page's map. The visibility at
// the sea is shaded by its words, the Met Office's marine ones on the
// game's stage: very poor palest and thickest, then poor, then moderate,
// good unshaded, smoothed between the grid's points; each very poor area
// is outlined, traced between the grid's points where the visibility
// crosses its threshold. Each flash of the last minute is marked where it
// struck, a bolt for one to the sea and a ring for one in the cloud,
// fading with its age. On the lights, a light sounding its fog signal has
// arcs beside it, and one lit by day a halo. And the few words the point
// clicked tells its visibility in, and what makes it.

import type { AirShares, CloudGrid, Flash, LightNow, SkyPoint, VisibilityPage } from './api';
import { gridPoint } from './clouds';
import { rectOf, toScreen, type View } from './map';

/** The colours of the fog's and the lightning's marks. */
export const FOG_COLOURS = {
  fog: [222, 228, 234] as const,
  outline: '#ffffff',
  halo: 'rgb(0 0 0 / 70%)',
  sea: '#f0e442',
  cloud: '#e0b0ff',
  sounding: '#56b4e9',
  byDay: '#fff3c4',
};

/** The fog's opacity by visibility's word: good none, moderate faint, poor stronger, very poor strongest. */
export const FOG_ALPHA = [0, 0.18, 0.36, 0.6] as const;

/** Visibility's words, by their numbers. */
export const VISIBILITY_WORDS = ['good', 'moderate', 'poor', 'very poor'] as const;

/** The Met Office's marine visibilities the words change at on the game's stage, m, until the page is read. */
export const MET_WORDS: [number, number, number] = [400, 1852, 3704];

/** How often the fog and the lightning are read while their layers are shown, ms: a fog signal's blast lasts a few seconds. */
export const VISIBILITY_EVERY = 3000;

/** How long a flash stays on the map, s, and its least opacity, at the end of it. */
export const FLASH_FOR = 60;
const FLASH_LEAST = 0.15;

/** Ticks a second. */
const TICKS = 30;

/** The word of a visibility, m, as a number: 0 good to 3 very poor. */
export function visibilityWordOf(v: number, words: readonly number[]): number {
  const [a = 0, b = 0, c = 0] = words;
  if (!(v >= a)) {
    return 3;
  }
  if (v < b) {
    return 2;
  }
  return v < c ? 1 : 0;
}

/** The visibilities each word spans but good, in words: "under 400", "400 to 1852" and so on, m. */
export function visibilityRanges(words: readonly number[]): string[] {
  const [a, b, c] = words;
  return [`under ${a}`, `${a} to ${b}`, `${b} to ${c}`];
}

/** Whether point i of the grid is within the lip, where the grid has the visibility. */
function inside(g: CloudGrid, i: number, lip: number): boolean {
  const [e, n] = gridPoint(g, i);
  return Math.hypot(e, n) <= lip;
}

/** The visibility's grid as a picture, a pixel a point, shaded by its words. Drawn on the CPU, as the map is. */
export function fogPicture(p: VisibilityPage, into: HTMLCanvasElement): void {
  const g = p.grid;
  into.width = g.side;
  into.height = g.side;
  const ctx = into.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    return;
  }
  const img = ctx.createImageData(g.side, g.side);
  const [r, gr, b] = FOG_COLOURS.fog;
  for (let i = 0; i < g.side * g.side; i++) {
    if (!inside(g, i, p.lip)) {
      continue;
    }
    const a = FOG_ALPHA[visibilityWordOf(g.values[i] ?? 0, p.words)] ?? 0;
    img.data[4 * i] = r;
    img.data[4 * i + 1] = gr;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = Math.round(255 * a);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The outlines of the areas where the grid is under below, as segments
 * [east, north, east, north], m: marching squares over the grid's cells,
 * each crossing found linearly between its points. Points beyond the lip
 * count as over it.
 */
export function outlinesUnder(
  g: CloudGrid,
  below: number,
  lip: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const value = (i: number, j: number): number => {
    const k = j * g.side + i;
    return inside(g, k, lip) ? (g.values[k] ?? 0) : Number.POSITIVE_INFINITY;
  };
  // Where the threshold crosses between two points, as a share of the way.
  const cross = (a: number, b: number): number => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return 0.5;
    }
    return Math.min(Math.max((below - a) / (b - a), 0), 1);
  };
  for (let j = 0; j + 1 < g.side; j++) {
    for (let i = 0; i + 1 < g.side; i++) {
      // The cell's corners: north-west, north-east, south-east, south-west.
      const v = [value(i, j), value(i + 1, j), value(i + 1, j + 1), value(i, j + 1)];
      const under = v.map((x) => x < below);
      const code = under.reduce((c, u, k) => c | (u ? 1 << k : 0), 0);
      if (code === 0 || code === 15) {
        continue;
      }
      const west = g.west + i * g.step;
      const north = g.north - j * g.step;
      const [nw = 0, ne = 0, se = 0, sw = 0] = v;
      // Each edge's crossing: north, east, south, west.
      const edge: [number, number][] = [
        [west + cross(nw, ne) * g.step, north],
        [west + g.step, north - cross(ne, se) * g.step],
        [west + cross(sw, se) * g.step, north - g.step],
        [west, north - cross(nw, sw) * g.step],
      ];
      // The edges each pattern of corners under joins, in pairs.
      const pairs = SEGMENTS[code] ?? [];
      for (let k = 0; k + 1 < pairs.length; k += 2) {
        const a = edge[pairs[k] ?? 0];
        const b = edge[pairs[k + 1] ?? 0];
        if (a !== undefined && b !== undefined) {
          out.push([a[0], a[1], b[0], b[1]]);
        }
      }
    }
  }
  return out;
}

/** Marching squares' table: by the corners under (north-west 1, north-east 2, south-east 4, south-west 8), the edges joined (north 0, east 1, south 2, west 3). */
const SEGMENTS: readonly (readonly number[])[] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [3, 0, 1, 2],
  [0, 2],
  [3, 2],
  [2, 3],
  [0, 2],
  [0, 1, 2, 3],
  [1, 2],
  [1, 3],
  [0, 1],
  [3, 0],
  [],
];

/** Draws the fog's picture of p in view v, each pixel centred on its point, and each very poor area outlined. */
export function drawFog(
  ctx: CanvasRenderingContext2D,
  v: View,
  p: VisibilityPage,
  picture: HTMLCanvasElement,
  outlines: readonly (readonly [number, number, number, number])[],
): void {
  const g = p.grid;
  const half = g.step / 2;
  const far = (g.side - 1) * g.step;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    picture,
    ...rectOf(v, g.west - half, g.north - far - half, g.west + far + half, g.north + half),
  );
  // On a dark halo, legible over the palest fog.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? FOG_COLOURS.halo : FOG_COLOURS.outline;
    ctx.lineWidth = pass === 0 ? 3 : 1.2;
    ctx.beginPath();
    for (const [e0, n0, e1, n1] of outlines) {
      const [x0, y0] = toScreen(v, e0, n0);
      const [x1, y1] = toScreen(v, e1, n1);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** A flash's opacity by its age, s: whole when it struck, fading to its least at FLASH_FOR. */
export function flashAlpha(age: number): number {
  if (!(age >= 0)) {
    return 1;
  }
  return Math.max(FLASH_LEAST, 1 - ((1 - FLASH_LEAST) * age) / FLASH_FOR);
}

/** A flash's age at the page's tick, s. */
export function flashAge(f: Flash, tick: number): number {
  return (tick - f.tick) / TICKS;
}

/** Draws the flashes of p in view v: a bolt for each to the sea, a ring for each in the cloud, the oldest first and faintest. */
export function drawFlashes(ctx: CanvasRenderingContext2D, v: View, p: VisibilityPage): void {
  const flashes = [...p.flashes].sort((a, b) => a.tick - b.tick);
  ctx.save();
  for (const f of flashes) {
    const [x, y] = toScreen(v, f.east, f.north);
    if (x < -10 || y < -10 || x > v.width + 10 || y > v.height + 10) {
      continue;
    }
    ctx.globalAlpha = flashAlpha(flashAge(f, p.tick));
    ctx.strokeStyle = FOG_COLOURS.halo;
    ctx.lineWidth = 1;
    if (f.sea) {
      ctx.fillStyle = FOG_COLOURS.sea;
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 9);
      ctx.lineTo(x - 3, y + 1);
      ctx.lineTo(x, y + 1);
      ctx.lineTo(x - 2, y + 9);
      ctx.lineTo(x + 4, y - 2);
      ctx.lineTo(x + 1, y - 2);
      ctx.lineTo(x + 4, y - 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.strokeStyle = FOG_COLOURS.cloud;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Marks a light as it shows now beside its ring at (x, y), radius r: a halo lit by day, arcs to the east sounding. */
export function drawLightNow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  l: LightNow,
): void {
  ctx.save();
  if (l.byDay) {
    ctx.strokeStyle = FOG_COLOURS.byDay;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
    ctx.stroke();
  }
  if (l.sounding) {
    ctx.strokeStyle = FOG_COLOURS.sounding;
    ctx.lineWidth = 1.5;
    for (const k of [1, 2, 3]) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3 + 4 * k, -Math.PI / 4, Math.PI / 4);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A light as it shows now in a few words: "sounding Dia(1) 20s, lit by day"; "" for nothing to tell. */
export function lightWords(l: LightNow): string {
  const out: string[] = [];
  if (l.sounding) {
    out.push(`sounding ${l.signal}`);
  }
  if (l.byDay) {
    out.push('lit by day');
  }
  return out.join(', ');
}

/** What the air's extinction is made of, by name. */
const AIR_NAMES: Record<keyof AirShares, string> = {
  clear: 'clear air',
  fog: 'fog',
  rain: 'rain',
  mist: 'mist',
};

/** The most visibility the page is given, m: no extinction at all. */
const VISIBILITY_MOST = 99999;

/** The visibility at a point in a few words: how far, its word, and what makes it, the most first. */
export function visibilityWords(s: SkyPoint): string {
  const far = s.visibility >= VISIBILITY_MOST ? 'unlimited' : `${Math.round(s.visibility)} m`;
  const parts = (Object.keys(AIR_NAMES) as (keyof AirShares)[])
    .map((k) => [k, s.air[k]] as const)
    .filter(([, share]) => share >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([k, share]) => `${AIR_NAMES[k]} ${Math.round(100 * share)}%`);
  return `${far}, ${s.visibilityWord}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`;
}

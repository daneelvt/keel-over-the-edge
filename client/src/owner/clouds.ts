// SPDX-License-Identifier: AGPL-3.0-only

// The clouds and the rain on the world page's map. The sheets are shaded
// over the disk and beyond its lip, where they are seen from it, each
// layer a grey of its own, the cirrus faintest and the low cloud darkest,
// smoothed between the grid's points; the fair-weather cumulus are small
// rounds, as big as they are grown; each heaped cloud is outlined by the
// circle its top reaches, from behind its centre to ahead of it along the
// way it moves, its deck dashed, with its top in metres. The rain is
// stippled, the dots the closer the heavier its word, fixed to the world
// as the map pans. And the few words the point clicked tells the sky in.

import type { CloudGrid, CloudsPage, HeapedCloud, SkyPoint } from './api';
import { rectOf, toScreen, type View } from './map';

/** The colours of the clouds' and the rain's marks. */
export const CLOUD_COLOURS = {
  cirrus: [236, 236, 236] as const,
  middle: [176, 176, 176] as const,
  low: [92, 92, 92] as const,
  cumulus: 'rgb(255 255 255 / 60%)',
  outline: '#ffffff',
  halo: 'rgb(0 0 0 / 70%)',
  rain: '#8fd4ff',
};

/** Each sheet's opacity at its whole cover: the cirrus faint, the middle sheet stronger, the low cloud strongest. */
export const SHEET_ALPHA = { cirrus: 0.25, middle: 0.42, low: 0.6 };

/** How often the clouds are read while their layers are shown, ms. */
export const CLOUDS_EVERY = 10_000;

/** Rain's words, by their numbers. */
export const RAIN_WORDS = ['none', 'light', 'moderate', 'heavy', 'violent'] as const;

/** WMO's rates the words change at, mm an hour, until the page is read. */
export const WMO_WORDS: [number, number, number] = [2.5, 10, 50];

/** The least rate that is rain at all, mm an hour. */
const RAIN_LEAST = 0.05;

/** The stipple's dots' spacing, CSS pixels, and their size, by rain's word. */
export const RAIN_SPACING = [0, 13, 8, 5, 3.2];
const RAIN_DOT = [0, 1.3, 1.5, 1.8, 2.1];

/** The word of rain of a rate, mm an hour, as a number: 0 none to 4 violent. */
export function rainWordOf(rate: number, words: readonly number[]): number {
  if (!(rate >= RAIN_LEAST)) {
    return 0;
  }
  const k = words.findIndex((w) => rate < w);
  return k < 0 ? 4 : k + 1;
}

/** The rates each word of rain spans, in words: "under 2.5", "2.5 to 10" and so on. */
export function rainRanges(words: readonly number[]): string[] {
  const [a, b, c] = words;
  return [`under ${a}`, `${a} to ${b}`, `${b} to ${c}`, `${c} and over`];
}

/** Point i of a grid, m east and north of the disk's centre: row by row from the north-west. */
export function gridPoint(
  g: Pick<CloudGrid, 'west' | 'north' | 'step' | 'side'>,
  i: number,
): [number, number] {
  return [g.west + (i % g.side) * g.step, g.north - Math.floor(i / g.side) * g.step];
}

/** The circle a heaped cloud's top reaches: from behind its centre to ahead of it along its heading. */
export function outlineOf(c: HeapedCloud): { east: number; north: number; radius: number } {
  const along = (c.ahead - c.behind) / 2;
  const h = (c.heading * Math.PI) / 180;
  return {
    east: c.east + along * Math.sin(h),
    north: c.north + along * Math.cos(h),
    radius: (c.ahead + c.behind) / 2,
  };
}

/** The three sheets of a point laid one over another, cirrus first: a colour 0 to 255 and its opacity 0 to 1. */
export function sheetShade(
  cirrus: number,
  middle: number,
  low: number,
): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const layers = [
    [CLOUD_COLOURS.cirrus, SHEET_ALPHA.cirrus * cirrus],
    [CLOUD_COLOURS.middle, SHEET_ALPHA.middle * middle],
    [CLOUD_COLOURS.low, SHEET_ALPHA.low * low],
  ] as const;
  for (const [c, cover] of layers) {
    const s = Math.min(Math.max(cover, 0), 1);
    const out = s + a * (1 - s);
    if (out <= 0) {
      continue;
    }
    r = (c[0] * s + r * a * (1 - s)) / out;
    g = (c[1] * s + g * a * (1 - s)) / out;
    b = (c[2] * s + b * a * (1 - s)) / out;
    a = out;
  }
  return [r, g, b, a];
}

/** A shade laid on a colour as #rrggbb: the legend's swatch. */
export function shadeOver(hex: string, shade: readonly number[]): string {
  const a = shade[3] ?? 0;
  const base = [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
  return `#${base
    .map((c, k) =>
      Math.round(c + ((shade[k] ?? 0) - c) * a)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The sheets' grid as a picture, a pixel a point. Drawn on the CPU, as the map is. */
export function sheetsPicture(g: CloudGrid, into: HTMLCanvasElement): void {
  into.width = g.side;
  into.height = g.side;
  const ctx = into.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    return;
  }
  const img = ctx.createImageData(g.side, g.side);
  for (let i = 0; i < g.side * g.side; i++) {
    const [r, gr, b, a] = sheetShade(
      g.values[3 * i] ?? 0,
      g.values[3 * i + 1] ?? 0,
      g.values[3 * i + 2] ?? 0,
    );
    img.data[4 * i] = Math.round(r);
    img.data[4 * i + 1] = Math.round(gr);
    img.data[4 * i + 2] = Math.round(b);
    img.data[4 * i + 3] = Math.round(255 * a);
  }
  ctx.putImageData(img, 0, 0);
}

/** Draws the sheets' picture of c in view v, each pixel centred on its point. */
export function drawSheets(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: CloudsPage,
  picture: HTMLCanvasElement,
): void {
  const g = c.sheets;
  const half = g.step / 2;
  const far = (g.side - 1) * g.step;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    picture,
    ...rectOf(v, g.west - half, g.north - far - half, g.west + far + half, g.north + half),
  );
  ctx.restore();
}

/** A hash of two whole numbers, 0 to 1. */
function hash(i: number, j: number, k: number): number {
  let h = Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ Math.imul(k, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Draws the rain of c in view v: each wet point's square of the grid stippled by its word. */
export function drawRain(ctx: CanvasRenderingContext2D, v: View, c: CloudsPage): void {
  const g = c.rain;
  const half = g.step / 2;
  // The dots stand on a lattice fixed to the world's centre, a little
  // jittered, so they keep their places as the map pans.
  const [ox, oy] = toScreen(v, 0, 0);
  ctx.save();
  ctx.fillStyle = CLOUD_COLOURS.rain;
  for (let i = 0; i < g.side * g.side; i++) {
    const word = rainWordOf(g.values[i] ?? 0, c.words);
    if (word === 0) {
      continue;
    }
    const [e, n] = gridPoint(g, i);
    const [x, y, w, h] = rectOf(v, e - half, n - half, e + half, n + half);
    const x0 = Math.max(x, 0);
    const y0 = Math.max(y, 0);
    const x1 = Math.min(x + w, v.width);
    const y1 = Math.min(y + h, v.height);
    if (x1 <= x0 || y1 <= y0) {
      continue;
    }
    const s = RAIN_SPACING[word] ?? 3;
    const dot = RAIN_DOT[word] ?? 2;
    for (let j = Math.ceil((y0 - oy) / s); oy + j * s < y1; j++) {
      for (let k = Math.ceil((x0 - ox) / s); ox + k * s < x1; k++) {
        const px = ox + (k + 0.8 * (hash(k, j, word) - 0.5)) * s;
        const py = oy + (j + 0.8 * (hash(j, k, word) - 0.5)) * s;
        ctx.fillRect(px - dot / 2, py - dot / 2, dot, dot);
      }
    }
  }
  ctx.restore();
}

/** Draws the cumulus and the heaped clouds of c in view v: each heaped cloud's outline, its deck and its top. */
export function drawHeaped(ctx: CanvasRenderingContext2D, v: View, c: CloudsPage): void {
  ctx.save();
  ctx.fillStyle = CLOUD_COLOURS.cumulus;
  ctx.beginPath();
  for (const cu of c.cumulus) {
    if (cu.grow <= 0) {
      continue;
    }
    const [x, y] = toScreen(v, cu.east, cu.north);
    const r = Math.max(1.5, (cu.radius * cu.grow) / v.scale);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
  ctx.fill();
  // Each drawn on a dark halo, legible over the palest sheet.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? CLOUD_COLOURS.halo : CLOUD_COLOURS.outline;
    ctx.fillStyle = ctx.strokeStyle;
    for (const cl of c.clouds) {
      const o = outlineOf(cl);
      const [x, y] = toScreen(v, o.east, o.north);
      const r = o.radius / v.scale;
      ctx.lineWidth = pass === 0 ? 3.5 : 1.5;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(r, 2), 0, 2 * Math.PI);
      ctx.stroke();
      if (cl.deck > 0) {
        const [dx, dy] = toScreen(v, cl.east, cl.north);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = pass === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.arc(dx, dy, Math.max(cl.deck / v.scale, 2), 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const label = `${Math.round(cl.top)} m`;
      if (pass === 0) {
        ctx.lineWidth = 3;
        ctx.strokeText(label, x + 4, y - r - 3);
      } else {
        ctx.fillText(label, x + 4, y - r - 3);
      }
    }
  }
  ctx.restore();
}

/** What a heaped cloud's form is called. */
const FORM_NAMES: Record<string, string> = {
  cumulus: 'a heaped cumulus',
  cumulonimbus: 'a cumulonimbus',
  storm: "a storm's cloud",
};

/** The sky at a point in a few words. */
export function skyWords(s: SkyPoint): string {
  const rain = s.rainWord === 'none' ? 'no rain' : `rain ${s.rain.toFixed(1)} mm/h, ${s.rainWord}`;
  const pct = (v: number): string => `${Math.round(100 * v)}%`;
  const sheets = `cirrus ${pct(s.sheets.cirrus)}, middle ${pct(s.sheets.middle)}, low ${pct(s.sheets.low)}`;
  const over =
    s.cloud === null
      ? 'no heaped cloud overhead'
      : `under ${FORM_NAMES[s.cloud.form] ?? s.cloud.form}, its top ${Math.round(s.cloud.top)} m`;
  return `${rain}; ${sheets}; ${over}`;
}

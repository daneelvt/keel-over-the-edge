// SPDX-License-Identifier: AGPL-3.0-only

// The chart's key: every symbol the chart's weather is drawn with, each in
// the chart's own drawing on a swatch of its own, with its line. A kind of
// system's line is the weather catalog's for it; the fronts', the wind's,
// the isobars', the rings', the arrows', the gales' and the fields' are the
// chart's look's. Each swatch is painted by the chart's own painters, so
// the key cannot draw a symbol otherwise than the chart does.

import type { KindDraw, SceneFront, SceneSystem, SystemDraw } from './weather';
import {
  alpha,
  fogWave,
  hatch,
  isobarStroke,
  type Pen,
  paintBarb,
  paintFront,
  paintMotion,
  paintRing,
  paintSystem,
  rainDots,
  SYMBOL_RANK,
  type WeatherLook,
} from './weatherpaint';

/** The key's lines for what is not a kind of system, from the chart's look. */
export interface KeyWords {
  cold: string;
  warm: string;
  barbs: string;
  wash: string;
  streaks: string;
  isobars: string;
  ring: string;
  motion: string;
  gale: string;
  gusts: string;
  rain: string;
  fog: string;
}

/** A swatch's size, CSS pixels. */
export const SWATCH = { width: 104, height: 60 } as const;

/** One of the key's entries: its name, its line and how its swatch is painted. */
export interface KeyEntry {
  id: string;
  name: string;
  line: string;
  /** Paints the swatch with a pen whose (0, 0) is the swatch's centre. */
  paint: (p: Pen) => void;
}

/** Metres a pixel of a swatch is: a storm's ring fits it. */
const METRES = 90;

/** A system of a kind as the key shows it: at the swatch's centre, moving east or, a line, north. */
function sample(kind: number, d: KindDraw): SceneSystem {
  const sizes: Record<SystemDraw, number> = {
    spiral: 2300,
    low: 2100,
    'dash-dot': 300,
    cell: 1700,
    dashed: 300,
    heap: 1600,
    bank: 2600,
    calm: 1700,
  };
  const size = sizes[d.draw];
  return {
    slot: 0,
    kind,
    seed: 0,
    draw: d.draw,
    name: d.name,
    east: 0,
    north: d.line ? -600 : 0,
    heading: d.line ? 0 : Math.PI / 2,
    speed: 0,
    size,
    strength: 1,
    length: d.line ? 7000 : 0,
    ring: d.ring * size,
    wind: 0,
    gust: 0,
    ahead: null,
    gone: null,
  };
}

/** A front across the swatch, moving north. */
function front(warm: boolean): SceneFront {
  return { sin: 0, cos: 1, line: -600, warm, speed: 0 };
}

/**
 * The key's entries: each kind of system the catalog has, the strongest
 * first, then its ring and its arrow, the fronts, the wind's three ways,
 * the isobars, a gale and the fields.
 */
export function keyEntries(kinds: readonly KindDraw[], words: KeyWords): KeyEntry[] {
  const out: KeyEntry[] = kinds
    .map((d, kind) => ({ d, kind }))
    .sort((a, b) => SYMBOL_RANK[a.d.draw] - SYMBOL_RANK[b.d.draw])
    .map(({ d, kind }) => ({
      id: `kind-${kind}`,
      name: d.name,
      line: d.key,
      paint: (p: Pen) => {
        const s = sample(kind, d);
        if (s.ring > 0) {
          paintRing(p, s);
        }
        paintSystem(p, s);
      },
    }));
  const ringed = kinds.findIndex((d) => d.ring > 0);
  const moving = kinds.findIndex((d) => !d.line && d.ring === 0);
  if (ringed >= 0) {
    out.push({
      id: 'ring',
      name: 'Ring of strongest wind',
      line: words.ring,
      paint: (p) => paintRing(p, sample(ringed, kinds[ringed] as KindDraw)),
    });
  }
  out.push({
    id: 'motion',
    name: 'Motion',
    line: words.motion,
    paint: (p) => {
      const d = kinds[Math.max(moving, 0)];
      if (d === undefined) {
        return;
      }
      const s = { ...sample(moving, d), size: 900, east: -2600, ahead: { east: 2600, north: 0 } };
      paintSystem(p, s);
      paintMotion(p, s);
    },
  });
  out.push(
    {
      id: 'cold',
      name: 'Cold front',
      line: words.cold,
      paint: (p) => paintFront(p, front(false), 5000),
    },
    {
      id: 'warm',
      name: 'Warm front',
      line: words.warm,
      paint: (p) => paintFront(p, front(true), 5000),
    },
    { id: 'barbs', name: 'Wind barbs', line: words.barbs, paint: paintBarbs },
    { id: 'wash', name: 'Wind strength', line: words.wash, paint: paintWash },
    { id: 'streaks', name: 'Wind streaks', line: words.streaks, paint: paintStreaks },
    { id: 'isobars', name: 'Isobars', line: words.isobars, paint: paintIsobars },
    { id: 'gale', name: 'Gale', line: words.gale, paint: paintGale },
    { id: 'gusts', name: 'Gusts', line: words.gusts, paint: paintGusts },
    { id: 'rain', name: 'Rain', line: words.rain, paint: paintRain },
    { id: 'fog', name: 'Fog over the water', line: words.fog, paint: paintFog },
  );
  return out;
}

/** The swatch's left, top, right and bottom about its centre, px. */
function edges(): [number, number, number, number] {
  const w = SWATCH.width / 2;
  const h = SWATCH.height / 2;
  return [-w, -h, w, h];
}

/** Barbs of 5, 15, 25 and 55 knots from the north, side by side. */
function paintBarbs(p: Pen): void {
  const { ctx, look } = p;
  const [l, , r, b] = edges();
  ctx.strokeStyle = look.ink;
  ctx.fillStyle = look.ink;
  ctx.lineWidth = Math.max(1, p.u * 0.6);
  ctx.lineCap = 'round';
  const speeds = [5, 15, 25, 55];
  speeds.forEach((knots, i) => {
    const x = l + ((i + 0.5) / speeds.length) * (r - l) - 4;
    paintBarb(ctx, x, b - 8, 0, knots, SWATCH.height * 0.66);
  });
  ctx.lineCap = 'butt';
}

/** The wash's steps side by side, the first none. */
function paintWash(p: Pen): void {
  const { ctx, look } = p;
  const [l, t, r, b] = edges();
  const steps = [0, ...look.wash.tints];
  const w = (r - l) / steps.length;
  steps.forEach((a, i) => {
    ctx.fillStyle = alpha(look.wash.colour, a);
    ctx.fillRect(l + i * w, t + 6, w - 2, b - t - 12);
  });
  ctx.fillStyle = look.ink;
  ctx.font = `italic ${Math.round(p.u * 5.5)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ['', ...look.wash.forces.map((f) => `F${f}`)].forEach((text, i) => {
    ctx.fillText(text, l + (i + 0.5) * w - 1, 0);
  });
}

/** A few streaks along the wind, faded at their tails. */
function paintStreaks(p: Pen): void {
  const { ctx, look } = p;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const [x, y, len] of [
    [-40, -14, 34],
    [-6, -2, 44],
    [10, 16, 30],
    [-34, 18, 26],
    [22, -18, 24],
  ] as const) {
    const g = ctx.createLinearGradient(x, y, x + len, y - len * 0.2);
    g.addColorStop(0, alpha(look.ink, 0));
    g.addColorStop(1, alpha(look.ink, 1));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y - len * 0.2);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/** Isobars bending about a low, the middle one of a multiple of 4 and heavier, lettered. */
function paintIsobars(p: Pen): void {
  const { ctx, look } = p;
  const [l, , r] = edges();
  [-16, 0, 16].forEach((dy, i) => {
    isobarStroke(p, i === 1);
    ctx.beginPath();
    for (let x = l; x <= r; x += 4) {
      const y = dy + 10 * Math.cos((x / (r - l)) * Math.PI) - 4;
      if (x === l) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });
  ctx.font = `italic ${Math.round(p.u * 4.5)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = alpha(look.paper, 0.9);
  ctx.strokeText('1012', r - 18, 6);
  ctx.fillStyle = look.ink;
  ctx.fillText('1012', r - 18, 6);
}

/** A square of gale, hatched across and lettered. */
function paintGale(p: Pen): void {
  const { ctx, look } = p;
  const [l, t, r, b] = edges();
  ctx.save();
  ctx.beginPath();
  ctx.rect(l + 8, t + 6, r - l - 16, b - t - 12);
  ctx.clip();
  ctx.strokeStyle = alpha(look.storm, 0.8);
  ctx.lineWidth = 1.5;
  hatch(ctx, l, t, r, b, 7, true);
  ctx.restore();
  ctx.font = `bold italic ${Math.round(p.u * 6)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = alpha(look.paper, 0.9);
  ctx.strokeText('Gale', 0, 0);
  ctx.fillStyle = look.storm;
  ctx.fillText('Gale', 0, 0);
}

/** Gusts' broken dashes, down the wind from the north-west. */
function paintGusts(p: Pen): void {
  const { ctx, look } = p;
  ctx.strokeStyle = alpha(look.ink, 0.75);
  ctx.lineWidth = 1.5;
  const cell = 16;
  const dx = Math.SQRT1_2;
  const dy = Math.SQRT1_2;
  ctx.beginPath();
  for (const [x, y] of [
    [-34, -10],
    [-2, -14],
    [28, -6],
    [-20, 14],
    [12, 14],
  ] as const) {
    for (const t of [-0.8, 0.2]) {
      ctx.moveTo(x + dx * t * cell, y + dy * t * cell);
      ctx.lineTo(x + dx * (t + 0.5) * cell, y + dy * (t + 0.5) * cell);
    }
  }
  ctx.stroke();
}

/** Rain's stipple: light, moderate, heavy and violent, left to right. */
function paintRain(p: Pen): void {
  const { ctx, look } = p;
  const [l, t, r, b] = edges();
  const words = look.rainWords;
  const rates = [1, (words[0] ?? 2.5) + 1, (words[1] ?? 10) + 1, (words[2] ?? 50) + 1];
  const w = (r - l) / rates.length;
  ctx.fillStyle = look.rain;
  rates.forEach((rate, i) => {
    const dots = rainDots(rate, words) * 2;
    for (let d = 0; d < dots; d++) {
      // The same scatter every time.
      const gx = Math.abs(Math.sin((i * 31 + d) * 12.9898) * 43758.5453) % 1;
      const gy = Math.abs(Math.sin((i * 31 + d) * 78.233) * 43758.5453) % 1;
      ctx.beginPath();
      ctx.arc(l + i * w + 3 + gx * (w - 6), t + 8 + gy * (b - t - 16), 1.6, 0, 2 * Math.PI);
      ctx.fill();
    }
  });
}

/** Fog's grey wash, its wavy lines and its outline where very poor. */
function paintFog(p: Pen): void {
  const { ctx, look } = p;
  const [l, t, r, b] = edges();
  ctx.fillStyle = alpha(look.fog, 0.35);
  ctx.beginPath();
  ctx.ellipse(0, 0, (r - l) / 2 - 6, (b - t) / 2 - 6, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = look.fog;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(8, 0, 18, 10, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.strokeStyle = alpha(look.fog, 0.9);
  ctx.lineWidth = 1.5;
  for (const [x, y] of [
    [-28, -10],
    [-30, 10],
    [36, -12],
    [34, 12],
  ] as const) {
    fogWave(ctx, x, y, 16);
  }
}

/** Paints an entry's swatch on a canvas, drawn for the screen's pixels: the paper, then the symbol. */
export function paintSwatch(
  canvas: HTMLCanvasElement,
  e: KeyEntry,
  look: WeatherLook,
  ratio: number,
): void {
  canvas.width = Math.round(SWATCH.width * ratio);
  canvas.height = Math.round(SWATCH.height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = look.paper;
  ctx.fillRect(0, 0, SWATCH.width, SWATCH.height);
  ctx.save();
  ctx.translate(SWATCH.width / 2, SWATCH.height / 2);
  ctx.beginPath();
  ctx.rect(-SWATCH.width / 2, -SWATCH.height / 2, SWATCH.width, SWATCH.height);
  ctx.clip();
  const k = 1 / METRES;
  const pen: Pen = { ctx, at: (east, north) => [east * k, -north * k], k, u: 2.6, look };
  e.paint(pen);
  ctx.restore();
}

// SPDX-License-Identifier: AGPL-3.0-only

// The sea on the world page's map: each sea area shaded by its waves'
// significant height, paler the higher, as foam; an arrow in each area
// with swell, the way the swell travels, longer and heavier the higher it
// is; and hatching over the areas whose waves a current against them
// steepens. And the few words the point clicked tells the sea in.

import type { SeaPage, SeaPoint } from './api';
import { canvasAngle, rectOf, toScreen, type View } from './map';

/** The colours of the sea's marks. */
export const SEA_COLOURS = {
  foam: [255, 255, 255] as const,
  swell: '#ffffff',
  halo: 'rgb(0 0 0 / 70%)',
  raised: '#d55e00',
};

/** The waves' height the shading reaches its palest at, m. */
export const SEA_FULL = 1.5;

/** The foam's opacity at its palest. */
const FOAM_MOST = 0.55;

/** Waves raised by the current by more than this share are hatched. */
export const RAISED = 1.1;

/** How often the sea is read while its layer is shown, ms: its swell changes no faster. */
export const SEA_EVERY = 10_000;

/** The foam's opacity over an area whose waves are hs metres high. */
export function foamOf(hs: number): number {
  return FOAM_MOST * Math.min(Math.max(hs / SEA_FULL, 0), 1);
}

/** The foam over an area of waves hs metres high, laid on a colour as #rrggbb: the legend's swatch. */
export function foamOver(hex: string, hs: number): string {
  const a = foamOf(hs);
  const base = [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
  return `#${base
    .map((c, k) =>
      Math.round(c + ((SEA_COLOURS.foam[k] ?? 255) - c) * a)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The centre of area i of a page, m east and north of the disk's centre; areas run row by row from the south-west. */
export function areaCentre(p: Pick<SeaPage, 'side' | 'size'>, i: number): [number, number] {
  const half = (p.side - 1) / 2;
  return [((i % p.side) - half) * p.size, (Math.floor(i / p.side) - half) * p.size];
}

/** An arrow, its head at its fore end. */
function arrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
): void {
  const dx = Math.cos(angle) * length;
  const dy = Math.sin(angle) * length;
  const hx = x + dx / 2;
  const hy = y + dy / 2;
  const h = Math.min(6, length / 3);
  ctx.moveTo(x - dx / 2, y - dy / 2);
  ctx.lineTo(hx, hy);
  ctx.moveTo(hx - Math.cos(angle - 0.5) * h, hy - Math.sin(angle - 0.5) * h);
  ctx.lineTo(hx, hy);
  ctx.lineTo(hx - Math.cos(angle + 0.5) * h, hy - Math.sin(angle + 0.5) * h);
}

/** Draws the sea of s in view v: its areas' shading, the hatching over the raised, the swell's arrows. */
export function drawSea(ctx: CanvasRenderingContext2D, v: View, s: SeaPage): void {
  const half = s.size / 2;
  const cell = s.size / v.scale;
  const inView = (x: number, y: number): boolean =>
    x > -cell && y > -cell && x < v.width + cell && y < v.height + cell;
  const [r, g, b] = SEA_COLOURS.foam;
  ctx.save();
  // The shading, a rectangle an area, a little over its side so that no
  // seam shows between two.
  s.areas.forEach((a, i) => {
    const alpha = foamOf(a.hs);
    const [e, n] = areaCentre(s, i);
    const [x, y] = toScreen(v, e, n);
    if (alpha <= 0 || !inView(x, y)) {
      return;
    }
    ctx.fillStyle = `rgb(${r} ${g} ${b} / ${(100 * alpha).toFixed(1)}%)`;
    const [rx, ry, rw, rh] = rectOf(v, e - half, n - half, e + half, n + half);
    ctx.fillRect(rx, ry, rw + 0.5, rh + 0.5);
  });
  // The hatching: the raised areas as one clip, and lines across the view
  // every 6 pixels.
  ctx.beginPath();
  let raised = 0;
  s.areas.forEach((a, i) => {
    const [e, n] = areaCentre(s, i);
    const [x, y] = toScreen(v, e, n);
    if (a.raised > RAISED && inView(x, y)) {
      ctx.rect(...rectOf(v, e - half, n - half, e + half, n + half));
      raised++;
    }
  });
  if (raised > 0) {
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = SEA_COLOURS.raised;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = -v.height; k < v.width; k += 6) {
      ctx.moveTo(k, v.height);
      ctx.lineTo(k + v.height, 0);
    }
    ctx.stroke();
    ctx.restore();
  }
  // The swell's arrows, the way it travels: away from where it comes
  // from. Each drawn on a dark halo, legible over the palest foam.
  const longest = Math.max(8, 0.9 * cell);
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? SEA_COLOURS.halo : SEA_COLOURS.swell;
    s.areas.forEach((a, i) => {
      if (a.swellHs <= 0) {
        return;
      }
      const [x, y] = toScreen(v, ...areaCentre(s, i));
      if (!inView(x, y)) {
        return;
      }
      const share = Math.min(a.swellHs / SEA_FULL, 1);
      ctx.lineWidth = 1 + 2 * share + (pass === 0 ? 2 : 0);
      ctx.beginPath();
      arrow(ctx, x, y, canvasAngle(a.from + 180), Math.min(longest, 8 + 22 * share));
      ctx.stroke();
    });
  }
  ctx.restore();
}

/** The sea at a point in a few words. */
export function seaWords(p: SeaPoint): string {
  const wind =
    p.windHs > 0
      ? `wind sea ${p.windHs.toFixed(2)} m, ${p.windPeriod.toFixed(1)} s`
      : 'no wind sea';
  const swell =
    p.swellHs > 0
      ? `swell ${p.swellHs.toFixed(2)} m, ${p.swellPeriod.toFixed(1)} s from ${String(Math.round(p.swellFrom) % 360).padStart(3, '0')}°`
      : 'no swell';
  return `${wind}; ${swell}; current ×${p.current.toFixed(2)}, lee ×${p.lee.toFixed(2)}; Hs ${p.hs.toFixed(2)} m`;
}

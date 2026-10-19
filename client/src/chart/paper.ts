// SPDX-License-Identifier: AGPL-3.0-only

// The chart's paper, painted on a 2D canvas as the period's charts were
// engraved: a laid paper's grain; the parallels of latitude, which here are
// circles about the pole over the main port, one a nautical mile, and the
// meridians, each lettered; the mist band hatched, as charts hatch what is
// not surveyed, with arrows toward the lip where the drain runs; the lip
// itself a heavy rule, the falls beyond it; a compass rose; and each
// charted island's coast inked round its land, which the island's model
// stands on.

import type { IslandModel } from './model';
import { NM } from './store';

/** What the paper is painted with. */
export interface PaperLook {
  paper: string;
  ink: string;
  sea: string;
  mist: string;
  /** A parallel every this many nautical miles; a meridian every this many degrees. */
  parallels: number;
  meridians: number;
  /** The lip and the mist band's inner edge, m from the centre. */
  lip: number;
  band: number;
  /** The degrees the pole sinks a nautical mile: the parallels' latitudes. */
  scale: number;
}

/** The paper reaches this far beyond the lip, as a share of it: the falls' margin. */
export const PAPER_MARGIN = 1.08;

/** Each surface's colour on the chart, by its index: the land's tints. */
export type Tints = readonly string[];

/** A pseudo-random number in [0, 1) from i: the paper's grain, the same on every draw. */
function grain(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Paints the paper on canvas, of side pixels, for a disk whose paper spans
 * PAPER_MARGIN × the lip each way; models are the charted islands' land.
 */
export function paintPaper(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  look: PaperLook,
  models: readonly IslandModel[],
  tints: Tints,
): void {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (ctx === null) {
    return;
  }
  const side = canvas.width;
  const extent = look.lip * PAPER_MARGIN;
  const k = side / (2 * extent); // pixels a metre
  const px = (east: number) => side / 2 + east * k;
  const py = (north: number) => side / 2 - north * k;
  const c = side / 2;

  // The paper, and its grain.
  ctx.fillStyle = look.paper;
  ctx.fillRect(0, 0, side, side);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = `rgba(90, 70, 40, ${0.03 + 0.06 * grain(i + 7)})`;
    ctx.fillRect(grain(i) * side, grain(i + 1) * side, 1 + grain(i + 2) * 2, 1);
  }
  // The sea, a wash inside the lip.
  ctx.beginPath();
  ctx.arc(c, c, look.lip * k, 0, 2 * Math.PI);
  ctx.fillStyle = look.sea;
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;

  // The mist band, hatched.
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, look.lip * k, 0, 2 * Math.PI);
  ctx.arc(c, c, look.band * k, 0, 2 * Math.PI, true);
  ctx.clip();
  ctx.strokeStyle = look.mist;
  ctx.lineWidth = Math.max(1, side / 1400);
  ctx.globalAlpha = 0.55;
  const step = Math.max(6, side / 180);
  for (let x = -side; x < 2 * side; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + side, side);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // The graticule: the parallels and the meridians, lettered.
  ctx.strokeStyle = look.ink;
  ctx.fillStyle = look.ink;
  ctx.lineWidth = Math.max(1, side / 1600);
  ctx.globalAlpha = 0.45;
  ctx.font = `italic ${Math.round(side / 90)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let n = look.parallels; n * NM < look.lip; n += look.parallels) {
    ctx.beginPath();
    ctx.arc(c, c, n * NM * k, 0, 2 * Math.PI);
    ctx.stroke();
    const lat = 90 - look.scale * n;
    ctx.fillText(`${Math.round(lat)}°`, c, c - n * NM * k - side / 160);
  }
  for (let d = 0; d < 360; d += look.meridians) {
    const a = (d * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(
      c + Math.sin(a) * look.parallels * NM * k * 0.15,
      c - Math.cos(a) * look.parallels * NM * k * 0.15,
    );
    ctx.lineTo(c + Math.sin(a) * look.lip * k, c - Math.cos(a) * look.lip * k);
    ctx.stroke();
    if (d % 90 !== 0) {
      ctx.fillText(
        `${d}°`,
        c + Math.sin(a) * (look.lip + 220) * k,
        c - Math.cos(a) * (look.lip + 220) * k,
      );
    }
  }
  ctx.globalAlpha = 1;

  // The drain's arrows, pointing out to the lip.
  ctx.fillStyle = look.ink;
  ctx.globalAlpha = 0.6;
  for (let d = 7.5; d < 360; d += 15) {
    const a = (d * Math.PI) / 180;
    const r0 = (look.band + (look.lip - look.band) * 0.35) * k;
    const r1 = (look.band + (look.lip - look.band) * 0.85) * k;
    const sx = Math.sin(a);
    const sy = -Math.cos(a);
    ctx.beginPath();
    ctx.moveTo(c + sx * r1, c + sy * r1);
    ctx.lineTo(c + sx * r0 - sy * 0.012 * r0, c + sy * r0 + sx * 0.012 * r0);
    ctx.lineTo(c + sx * r0 + sy * 0.012 * r0, c + sy * r0 - sx * 0.012 * r0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // The lip: a heavy rule; beyond it the falls, darker.
  ctx.beginPath();
  ctx.arc(c, c, look.lip * k, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(2, side / 400);
  ctx.strokeStyle = look.ink;
  ctx.stroke();

  // The compass rose, in the south-west.
  rose(ctx, px(-look.lip * 0.62), py(-look.lip * 0.62), look.lip * 0.14 * k, look.ink);

  // The charted islands' coasts: the land inked round, then tinted.
  for (const m of models) {
    const w = Math.max(m.dx * k, 1);
    const h = Math.max(m.dy * k, 1);
    const ring = Math.max(1.5, side / 900);
    ctx.fillStyle = look.ink;
    forCells(m, (x, y) =>
      ctx.fillRect(px(x) - w / 2 - ring, py(y) - h / 2 - ring, w + 2 * ring, h + 2 * ring),
    );
    forCells(m, (x, y, s) => {
      ctx.fillStyle = tints[s] ?? look.paper;
      ctx.fillRect(px(x) - w / 2, py(y) - h / 2, w + 0.5, h + 0.5);
    });
  }
}

/** Calls f with each land cell of m: its centre, m, and its surface. */
function forCells(m: IslandModel, f: (x: number, y: number, surface: number) => void): void {
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.columns; c++) {
      const i = r * m.columns + c;
      if ((m.heights[i] ?? 0) > 0) {
        f(m.x + c * m.dx, m.y + r * m.dy, m.surfaces[i] ?? 0);
      }
    }
  }
}

/** A compass rose of radius r at (x, y): its points, and a fleur-de-lis' place at north. */
function rose(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ink: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(1, r / 60);
  for (const radius of [r, r * 0.92]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.stroke();
  }
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    const len = i % 8 === 0 ? r * 0.95 : i % 4 === 0 ? r * 0.7 : i % 2 === 0 ? r * 0.5 : r * 0.35;
    const wide = i % 8 === 0 ? r * 0.08 : r * 0.05;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * len, -Math.cos(a) * len);
    ctx.lineTo(Math.sin(a + Math.PI / 2) * wide, -Math.cos(a + Math.PI / 2) * wide);
    ctx.lineTo(0, 0);
    ctx.closePath();
    if (i % 2 === 0) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.font = `${Math.round(r / 4)}px "IM Fell English", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', 0, -r * 1.02);
  ctx.restore();
}

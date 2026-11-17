// SPDX-License-Identifier: AGPL-3.0-only

// The world's map as the game's chart screen shows the whole disk: the
// chart's own painters (paintPaper and paintWeather, client/src/chart)
// drawing on sheets laid on the paper and seen through the chart's camera
// (canvas.ts), in the chart's order: the paper, the charted islands'
// coasts, the weather, the boats, the names. Only what the status holds
// is drawn, and it holds only what the week's sailors have charted.
//
// Three things the chart draws from what the status does not carry are
// drawn from what it does: the islands stand on the chart as models of
// their land, and here lie flat, inked round their coasts; the wind's
// wash and the fog's, painted by the chart as pictures of its grid, are
// here the same steps traced as shapes; and the boats, which the chart
// does not show but for the sailor's own, are inked as small boats.

import { contour, type Grid, type Where } from '../../../../client/src/chart/contour.ts';
import { PAPER_MARGIN, type PaperLook, paintPaper } from '../../../../client/src/chart/paper.ts';
import type {
  FieldGrid,
  Layers,
  SceneSystem,
  WeatherScene,
} from '../../../../client/src/chart/weather.ts';
import { paintWeather, type WeatherLook } from '../../../../client/src/chart/weatherpaint.ts';
import { forceOf } from '../../../../client/src/chart/words.ts';
import { COG_HOLE, cogOutline } from '../../../../client/src/render/machinemark.ts';
import { fell, fellItalic } from '../../gen/glyphs.gen.ts';
import type { Status, StatusMap, Weather } from '../status';
import { type Px, type View, wholeDisk, wholeDiskDistance } from './camera';
import { linearOpacity, SheetContext } from './canvas';
import { BOATS, GREEN, GRID, LIP, PAPER, rigOf, WEATHER } from './look';
import { advanceOf, escapeXml, n1, Svg, textAt } from './svg';

/** The table the chart lies on (ChartView's TABLE). */
export const TABLE = '#22303a';

/** The screen the camera frames, px, as the chart screen's on a laptop. */
export const SCREEN: [number, number] = [960, 600];

/** The paper's canvas, px a side (ChartView's PAPER_PIXELS); the weather's is the catalog's. */
const PAPER_PIXELS = 2048;
const WEATHER_PIXELS = 1024;

/** Room about the paper on the table, px. */
const MARGIN = 14;

/** Every layer of the chart's weather but the streaks, which move. */
const LAYERS: Layers = {
  wash: true,
  barbs: true,
  streaks: false,
  gusts: true,
  rain: true,
  fog: true,
  systems: true,
  pressure: true,
};

/** A canvas the painters take: its width, and its context the sheet. */
function canvasOf(ctx: SheetContext): HTMLCanvasElement {
  return {
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

/** The painters' little canvases for pictures of the grid: none here, so they paint none (the washes are traced). */
class NoCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): null {
    return null;
  }
}

/**
 * The least rank lettered from a camera this far off, m: the whole disk
 * names its great islands alone. As rankShown (client/src/chart/view.ts).
 */
export function rankShown(distance: number): number {
  if (distance > 14000) {
    return 3;
  }
  if (distance > 7000) {
    return 2;
  }
  return distance > 3500 ? 1 : 0;
}

/**
 * The status's 32-point weather brought to the chart's own grid, bilinear
 * between its points: its wind by its components, so a calm point does not
 * turn it; fog and pressure from the points within the lip, and none
 * beyond it, as the chart samples them. Fog in metres, the way the wind
 * comes from in radians, as the chart's grid holds them.
 */
export function chartGrid(wx: Weather, lip: number, n: number): FieldGrid {
  const m = wx.n;
  const g: FieldGrid = {
    n,
    lip,
    mean: new Float32Array(n * n),
    from: new Float32Array(n * n),
    gust: new Float32Array(n * n),
    rain: new Float32Array(n * n),
    fog: new Float32Array(n * n),
    pressure: new Float32Array(n * n),
  };
  const rad = Math.PI / 180;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const east = ((i + 0.5) / n - 0.5) * 2 * lip;
      const north = (0.5 - (j + 0.5) / n) * 2 * lip;
      const fi = Math.min(Math.max((east / (2 * lip) + 0.5) * m - 0.5, 0), m - 1);
      const fj = Math.min(Math.max((0.5 - north / (2 * lip)) * m - 0.5, 0), m - 1);
      const i0 = Math.min(Math.floor(fi), m - 2);
      const j0 = Math.min(Math.floor(fj), m - 2);
      const u = fi - i0;
      const v = fj - j0;
      const corners: [number, number][] = [
        [j0 * m + i0, (1 - u) * (1 - v)],
        [j0 * m + i0 + 1, u * (1 - v)],
        [(j0 + 1) * m + i0, (1 - u) * v],
        [(j0 + 1) * m + i0 + 1, u * v],
      ];
      let mean = 0;
      let gust = 0;
      let rain = 0;
      let se = 0;
      let sn = 0;
      let fog = 0;
      let fw = 0;
      let p = 0;
      let pw = 0;
      for (const [k, w] of corners) {
        const s = wx.mean[k] ?? 0;
        mean += w * s;
        gust += w * (wx.gust[k] ?? 0);
        rain += w * (wx.rain[k] ?? 0);
        const from = (wx.from[k] ?? 0) * rad;
        se += w * Math.max(s, 0.01) * Math.sin(from);
        sn += w * Math.max(s, 0.01) * Math.cos(from);
        const f = wx.fog[k];
        if (f !== null && f !== undefined) {
          fog += w * f;
          fw += w;
        }
        const pr = wx.pressure[k];
        if (pr !== null && pr !== undefined) {
          p += w * pr;
          pw += w;
        }
      }
      const at = j * n + i;
      const inside = east * east + north * north <= lip * lip;
      g.mean[at] = mean;
      g.gust[at] = gust;
      g.rain[at] = rain;
      g.from[at] = Math.atan2(se, sn);
      g.fog[at] = inside && fw > 0 ? (fog / fw) * 1000 : Number.NaN;
      g.pressure[at] = inside && pw > 0 ? p / pw : Number.NaN;
    }
  }
  return g;
}

/** The chart's scene of the status's weather, now. */
export function sceneOf(wx: Weather, lip: number): WeatherScene {
  const systems: SceneSystem[] = wx.systems.map((s, i) => ({
    slot: i,
    kind: 0,
    seed: 0,
    draw: s.draw,
    name: s.name,
    east: s.east,
    north: s.north,
    heading: s.heading,
    speed: s.speed,
    size: s.size,
    strength: s.strength,
    length: s.length ?? 0,
    ring: s.ring ?? 0,
    wind: s.wind,
    gust: s.gust,
    // Gone within the half hour: no arrow, as the chart draws it.
    ahead: s.ahead ?? { east: s.east, north: s.north },
    gone: null,
  }));
  return {
    moment: { kind: 'now', tick: 0, minutes: 0, issue: null },
    grid: chartGrid(wx, lip, GRID),
    systems,
    fronts: wx.fronts.map((f) => ({ ...f })),
    gale: null,
  };
}

/** A colour laid over another at an opacity, as a canvas lays it: #rrggbb. */
function over(under: string, top: string, a: number): string {
  const u = Number.parseInt(under.slice(1), 16);
  const t = Number.parseInt(top.slice(1), 16);
  let out = '#';
  for (const shift of [16, 8, 0]) {
    const v = Math.round(((u >> shift) & 255) * (1 - a) + ((t >> shift) & 255) * a);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/** The least mean wind of a Beaufort force, m/s: where a step of the wash begins (as weatherpaint's speedOfForce). */
function speedOfForce(force: number): number {
  let lo = 0;
  let hi = 80;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (forceOf(mid) >= force) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * Where a field over the chart's grid passes a level, as closed rings: the
 * grid edged with a value below every level, so no line runs off it.
 */
function rings(values: ArrayLike<number>, n: number, lip: number, level: number): Where[][] {
  const side = n + 2;
  const padded = new Float64Array(side * side).fill(-1e9);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = values[j * n + i] ?? Number.NaN;
      padded[(j + 1) * side + i + 1] = Number.isNaN(v) ? -1e9 : v;
    }
  }
  const g: Grid = { side, step: (2 * lip) / n, values: padded };
  return contour(g, level);
}

/** A sheet's canvas point for a point of the paper, m. */
function onSheet(ctx: SheetContext, extent: number): (p: Where) => Px {
  const side = ctx.canvas.width;
  const k = side / (2 * extent);
  return ([e, n]) => [side / 2 + e * k, side / 2 - n * k];
}

/**
 * The wind's wash, as paintWash tints the water a step darker from each
 * of the look's forces on, its edges sharp: each step's water traced as
 * rings and filled, each over the last, so where all lie the tint is the
 * strongest step's (client/src/chart/weatherpaint.ts, paintWash).
 */
function traceWash(ctx: SheetContext, g: FieldGrid, look: WeatherLook, extent: number): void {
  const at = onSheet(ctx, extent);
  const base = ctx.linearOver;
  ctx.linearOver = null;
  let below = 0;
  look.wash.forces.forEach((force, step) => {
    const tint = look.wash.tints[step] ?? 0;
    const a = base === null ? tint : linearOpacity(look.wash.colour, tint, base);
    // Laid over the step below: so much more as brings it to the step's own tint.
    const layer = (a - below) / (1 - below);
    below = a;
    const lines = rings(g.mean, g.n, g.lip, speedOfForce(force));
    if (lines.length === 0) {
      return;
    }
    ctx.beginPath();
    for (const line of lines) {
      for (const [i, p] of line.entries()) {
        if (i === 0) {
          ctx.moveTo(...at(p));
        } else {
          ctx.lineTo(...at(p));
        }
      }
      ctx.closePath();
    }
    ctx.globalAlpha = layer;
    ctx.fillStyle = look.wash.colour;
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
  });
  ctx.linearOver = base;
}

/**
 * The fog's wash, as paintFog lays it, soft at its edges, deeper the
 * poorer it is: its alpha 0.15 where it is just poor to 0.5 where nothing
 * is seen, here in four steps traced as rings and softened.
 */
function traceFog(
  ctx: SheetContext,
  g: FieldGrid,
  look: WeatherLook,
  extent: number,
  soft: string,
): void {
  const at = onSheet(ctx, extent);
  const poor = look.visibility[1] ?? 1852;
  // The fog's visibility, negated, so its poorer water is above each level.
  const less = Float64Array.from(g.fog, (v) => (Number.isNaN(v) ? Number.NaN : -v));
  const base = ctx.linearOver;
  ctx.linearOver = null;
  let below = 0;
  for (const share of [1, 0.75, 0.5, 0.25]) {
    const deep = 0.15 + 0.35 * Math.min(1, 1 - share + 0.125);
    const a = base === null ? deep : linearOpacity(look.fog, deep, base);
    const layer = (a - below) / (1 - below);
    below = a;
    const lines = rings(less, g.n, g.lip, -poor * share);
    if (lines.length === 0) {
      continue;
    }
    ctx.beginPath();
    for (const line of lines) {
      for (const [i, p] of line.entries()) {
        if (i === 0) {
          ctx.moveTo(...at(p));
        } else {
          ctx.lineTo(...at(p));
        }
      }
      ctx.closePath();
    }
    ctx.globalAlpha = layer;
    ctx.fillStyle = look.fog;
    ctx.filter = soft;
    ctx.fill('evenodd');
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  }
  ctx.linearOver = base;
}

/**
 * The charted islands' coasts, as paintPaper inks them: the land inked
 * round, a ring as wide as the paper's (its side over 900, at least 1.5
 * px of it), then tinted, here one path stroked under its fill; a rock
 * too small to outline, a dot of ink.
 */
function inkCoasts(
  drawn: Drawn,
  svg: Svg,
  view: View,
  map: StatusMap,
  look: PaperLook,
  extent: number,
  tint: string,
): void {
  // The ring on the screen at the centre: the paper's px there.
  const [x0] = view.project(0, 0);
  const [x1] = view.project((2 * extent) / PAPER_PIXELS, 0);
  const ring = Math.max(1.5, PAPER_PIXELS / 900) * Math.abs(x1 - x0);
  let land = '';
  let rocks = '';
  map.islands.coast.forEach((island, i) => {
    if (island.length === 0) {
      const [x, y] = view.project(map.islands.east[i] ?? 0, map.islands.north[i] ?? 0);
      rocks += `M${n1(x)} ${n1(y)}h0`;
      drawn.rocks.push(map.islands.name[i] ?? '');
      return;
    }
    drawn.coasts.push(map.islands.name[i] ?? '');
    for (const r of island) {
      let e = 0;
      let n = 0;
      for (let k = 0; k < r.length; k += 2) {
        e += (r[k] ?? 0) * 25;
        n += (r[k + 1] ?? 0) * 25;
        const [x, y] = view.project(e, n);
        land += `${k === 0 ? 'M' : 'L'}${n1(x)} ${n1(y)}`;
      }
      land += 'Z';
    }
  });
  svg.path(land, {
    fill: tint,
    stroke: look.ink,
    width: 2 * ring,
    join: 'round',
    strokeUnder: true,
  });
  svg.path(rocks, { stroke: look.ink, width: 4 * ring, cap: 'round' });
}

/**
 * A boat on the map, small and inked: its hull as seen from the side, its
 * sail standing over it, the bow toward where it heads on the screen, and
 * a wake laid on the paper astern of it, which shows its heading in the
 * camera's own perspective; a machine sailor's sail carries the cog
 * (client/src/render/machinemark.ts), in the cloth's ink.
 */
function inkBoat(
  svg: Svg,
  view: View,
  b: Status['map']['boats'][number],
  ink: string,
  cloth: string,
): void {
  const kind = BOATS.find((k) => k.id === b.boat);
  const rig = rigOf(b.boat);
  const length = 6 + 1.9 * Math.sqrt(kind?.lengthOverall ?? 5);
  const h = (b.heading * Math.PI) / 180;
  const [x, y] = view.project(b.east, b.north);
  // The heading on the screen, from a step along it on the paper.
  const [ax, ay] = view.project(b.east + Math.sin(h) * 100, b.north + Math.cos(h) * 100);
  const way = ax - x >= 0 ? 1 : -1;
  // The wake: a few strokes on the paper astern, fading.
  const wake = (from: number, to: number) => {
    const p = view.project(b.east - Math.sin(h) * from, b.north - Math.cos(h) * from);
    const q = view.project(b.east - Math.sin(h) * to, b.north - Math.cos(h) * to);
    return `M${n1(p[0])} ${n1(p[1])}L${n1(q[0])} ${n1(q[1])}`;
  };
  const sternward = Math.hypot(ax - x, ay - y) > 0 ? 100 : 0;
  if (sternward > 0) {
    svg.path(`${wake(60, 260)}${wake(320, 460)}`, {
      stroke: ink,
      width: 1.2,
      opacity: 0.55,
      cap: 'round',
    });
  }
  // The hull, from the side: a sheer and a rounded bottom, the bow higher.
  const half = length / 2;
  const draught = length * 0.16;
  const hull = (dx: number) => {
    const s = (u: number) => n1(x + dx + way * u);
    return `M${s(-half)} ${n1(y - draught * 0.35)}L${s(half)} ${n1(y - draught * 0.75)}Q${s(half * 0.7)} ${n1(y + draught * 0.7)} ${s(0)} ${n1(y + draught * 0.6)}Q${s(-half * 0.85)} ${n1(y + draught * 0.5)} ${s(-half)} ${n1(y - draught * 0.35)}Z`;
  };
  let hulls = hull(0);
  if (rig.hulls === 2) {
    hulls += hull(-way * length * 0.12);
  }
  const mastAt = x - way * length * 0.05;
  const top = y - draught * 0.5 - length * 1.05;
  const foot = y - draught * 0.55;
  const sails: string[] = [];
  let cogAt: [number, number, number] | null = null;
  if (rig.masts > 0) {
    // Square sails on each mast, a course and a topsail.
    for (let m = 0; m < rig.masts; m++) {
      const mx = x + way * (m - (rig.masts - 1) / 2) * length * 0.3;
      const hgt = (foot - top) * (m === 1 ? 1 : 0.88);
      const w = length * 0.24;
      for (const [lo, hi, wide] of [
        [0.08, 0.5, 1],
        [0.55, 0.92, 0.78],
      ] as const) {
        const y0 = foot - hgt * lo;
        const y1 = foot - hgt * hi;
        sails.push(
          `M${n1(mx - (w * wide) / 2)} ${n1(y0)}L${n1(mx + (w * wide) / 2)} ${n1(y0)}L${n1(mx + (w * wide * 0.85) / 2)} ${n1(y1)}L${n1(mx - (w * wide * 0.85) / 2)} ${n1(y1)}Z`,
        );
      }
      if (m === 1) {
        cogAt = [mx, foot - hgt * 0.3, w * 0.32];
      }
    }
    if (rig.jib) {
      const bow = x + way * half;
      sails.push(
        `M${n1(bow + way * length * 0.12)} ${n1(foot - draught * 0.3)}L${n1(x + way * length * 0.3)} ${n1(top + (foot - top) * 0.25)}L${n1(x + way * length * 0.24)} ${n1(foot - (foot - top) * 0.1)}Z`,
      );
    }
  } else {
    // A fore-and-aft rig: the main abaft the mast, and a jib before it.
    const boom = length * (rig.jib ? 0.5 : 0.62);
    sails.push(
      `M${n1(mastAt)} ${n1(top)}L${n1(mastAt)} ${n1(foot)}L${n1(mastAt - way * boom)} ${n1(foot)}Z`,
    );
    if (rig.jib) {
      sails.push(
        `M${n1(mastAt + way * length * 0.06)} ${n1(top + (foot - top) * 0.12)}L${n1(mastAt + way * length * 0.06)} ${n1(foot)}L${n1(mastAt + way * half * 0.95)} ${n1(foot)}Z`,
      );
    }
    cogAt = [mastAt - way * boom * 0.3, foot - (foot - top) * 0.32, boom * 0.2];
  }
  svg.path(sails.join(''), { fill: cloth, stroke: ink, width: 0.9, join: 'round' });
  svg.path(hulls, { fill: ink });
  if (b.machine && cogAt !== null) {
    const [cx, cy, r] = cogAt;
    const o = cogOutline();
    let d = '';
    for (let i = 0; i < o.length; i += 2) {
      d += `${i === 0 ? 'M' : 'L'}${n1(cx + (o[i] ?? 0) * r)} ${n1(cy - (o[i + 1] ?? 0) * r)}`;
    }
    const hole = COG_HOLE * r;
    d += `ZM${n1(cx + hole)} ${n1(cy)}a${n1(hole)} ${n1(hole)} 0 1 0 ${n1(-2 * hole)} 0a${n1(hole)} ${n1(hole)} 0 1 0 ${n1(2 * hole)} 0Z`;
    svg.path(d, { fill: ink, rule: 'evenodd' });
  }
}

/** A name on the chart, lettered as the chart's labels are (client/src/ui/chart.css). */
interface Name {
  text: string;
  east: number;
  north: number;
  rank: number;
  /** Px, its letter spacing in ems, and whether in capitals. */
  size: number;
  spacing: number;
  upper: boolean;
}

/**
 * Letters the names, the worthier first, where they do not crowd one
 * another, each centred over its place with room about it, as ChartView's
 * #placeLabels lays them (client/src/chart/view.ts).
 */
function letterNames(
  drawn: Drawn,
  svg: Svg,
  view: View,
  names: Name[],
  look: PaperLook,
  least: number,
): void {
  const ROOM = 10;
  const kept: [number, number, number, number][] = [];
  for (const l of names) {
    if (l.rank < least) {
      continue;
    }
    const text = l.upper ? l.text.toUpperCase() : l.text;
    const width = advanceOf(fell, text, l.spacing) * l.size + 4;
    const [x, y] = view.project(l.east, l.north);
    const on = x > -40 && x < view.width + 40 && y > -20 && y < view.height + 20;
    const box: [number, number, number, number] = [
      x - width / 2 - ROOM,
      y - 18 - ROOM / 2,
      x + width / 2 + ROOM,
      y + 2 + ROOM / 2,
    ];
    if (!on || kept.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) {
      continue;
    }
    kept.push(box);
    drawn.names.push(l.text);
    // Its line box, 1.1 ems, stands on the place; the letters' baseline within it.
    const asc = fell.ascender / fell.upem;
    const desc = -fell.descender / fell.upem;
    const baseline = y - 1.1 * l.size + ((1.1 - asc - desc) / 2 + asc) * l.size;
    const left = x - (width - 4) / 2;
    svg.text(
      text,
      {
        face: fell,
        faceName: 'r',
        size: l.size,
        fill: look.ink,
        spacing: l.spacing,
        halo: { colour: look.paper, opacity: 0.8, width: 3 },
      },
      textAt(left, baseline),
    );
  }
}

/** The status's names in the chart's lettering order: by rank, islands first, then places. */
function namesOf(map: StatusMap): Name[] {
  const names: Name[] = [];
  map.islands.name.forEach((text, i) => {
    const rank = map.islands.rank[i] ?? 0;
    const great = rank === 3;
    names.push({
      text,
      east: map.islands.east[i] ?? 0,
      north: map.islands.north[i] ?? 0,
      rank,
      size: great ? 18 : 15,
      spacing: great ? 0.06 : 0,
      upper: great,
    });
  });
  map.places.name.forEach((text, i) => {
    names.push({
      text,
      east: map.places.east[i] ?? 0,
      north: map.places.north[i] ?? 0,
      rank: map.places.rank[i] ?? 0,
      size: 13,
      spacing: 0,
      upper: false,
    });
  });
  // Stable: islands before places of the same rank, each table in its own order.
  return names.sort((a, b) => b.rank - a.rank);
}

/** The words a resting map carries. */
export const RESTING = 'The sea is resting';

/** A cartouche in the paper's colours over a map's view box: the sea is resting. */
function restingOverlay(box: readonly number[]): string {
  const svg = new Svg('r');
  const look = PAPER;
  const [x = 0, y = 0, width = 0, height = 0] = box;
  const size = 26;
  const w = advanceOf(fell, RESTING) * size;
  const cx = x + width / 2;
  const cy = y + height * 0.5;
  const pad = 18;
  svg.path(
    `M${n1(cx - w / 2 - pad)} ${n1(cy - size)}h${n1(w + 2 * pad)}v${n1(size * 1.8)}h${n1(-w - 2 * pad)}Z`,
    { fill: look.paper, stroke: look.ink, width: 1.5, opacity: 0.94 },
  );
  svg.text(
    RESTING,
    { face: fell, faceName: 'r', size, fill: look.ink },
    textAt(cx - w / 2, cy + size * 0.3),
  );
  return svg.inner();
}

/** The title a map's picture carries. */
function titleOf(resting: boolean): string {
  return resting ? `The world’s chart: ${RESTING.toLowerCase()}` : 'The world’s chart now';
}

/**
 * A map drawn before, marked resting: the cartouche laid over it and its
 * title saying so. What the Worker serves from its last good copy.
 */
export function markResting(svg: string): string {
  const box = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 0 0').split(' ').map(Number);
  return svg
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeXml(titleOf(true))}</title>`)
    .replace(/<\/svg>$/, `${restingOverlay(box)}</svg>`);
}

/** What a map drew of the status: each island's coast or dot, each name lettered, each boat, each system and front. */
export interface Drawn {
  coasts: string[];
  rocks: string[];
  names: string[];
  boats: number;
  systems: number;
  fronts: number;
}

/** What a map is drawn from: the status, or none; whether the sea rests. */
export interface MapOf {
  status: Status | null;
  resting: boolean;
}

/** The paper's square on the screen, with room about it: the map's view box. */
function frame(view: View, extent: number): [number, number, number, number] {
  const corners = [
    view.project(-extent, -extent),
    view.project(extent, -extent),
    view.project(extent, extent),
    view.project(-extent, extent),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.floor(Math.min(...xs) - MARGIN);
  const y0 = Math.floor(Math.min(...ys) - MARGIN);
  return [
    x0,
    y0,
    Math.ceil(Math.max(...xs) + MARGIN) - x0,
    Math.ceil(Math.max(...ys) + MARGIN) - y0,
  ];
}

/** The map as SVG: the whole disk as the chart shows it, its view box about the paper. */
export function drawMap(of: MapOf): string {
  return drawMapOf(of).svg;
}

/** The map as SVG, and what it drew of the status. */
export function drawMapOf(of: MapOf): { svg: string; drawn: Drawn } {
  const drawn: Drawn = { coasts: [], rocks: [], names: [], boats: 0, systems: 0, fronts: 0 };
  const map = of.status?.map ?? null;
  const lip = map?.lip ?? LIP;
  const look: PaperLook = { ...PAPER, lip, band: map?.band ?? PAPER.band };
  const weatherLook: WeatherLook = { ...WEATHER, lip };
  const view = wholeDisk(lip, SCREEN[0], SCREEN[1]);
  const extent = lip * PAPER_MARGIN;
  const box = frame(view, extent);
  const svg = new Svg();
  svg.raw(
    `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" fill="${TABLE}"/>`,
  );

  // The paper's grain, a fine speckle, where paintPaper strews its own.
  const grain = svg.id('f');
  svg.define(
    `<filter id="${grain}" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0.35 0 0 0 0 0.27 0 0 0 0 0.16 0 0 0 -0.25 0.125"/><feComposite in2="SourceGraphic" operator="in"/></filter>`,
  );
  const paper = new SheetContext(svg, view, PAPER_PIXELS, extent, {
    roman: fell,
    italic: fellItalic,
  });
  paper.dropSpecks = true;
  paper.onSpecks = () => {
    const c = [
      view.project(-extent, extent),
      view.project(extent, extent),
      view.project(extent, -extent),
      view.project(-extent, -extent),
    ];
    svg.path(`M${c.map((p) => `${n1(p[0])} ${n1(p[1])}`).join('L')}Z`, {
      fill: look.paper,
      filter: grain,
    });
  };
  paintPaper(canvasOf(paper), look, [], []);
  if (map !== null) {
    // The land a pale green, as the chart's models of it read from afar:
    // the paper's colour and the plants'.
    inkCoasts(drawn, svg, view, map, look, extent, over(look.paper, GREEN, 0.4));
    const sheet = new SheetContext(svg, view, WEATHER_PIXELS, extent, {
      roman: fell,
      italic: fellItalic,
    });
    // The weather's canvas lies over the paper's as the GPU lays it, over
    // the sea's wash on the paper.
    sheet.linearOver = over(look.paper, look.sea, 0.55);
    const scene = sceneOf(map.weather, lip);
    const soft = svg.id('f');
    svg.define(
      `<filter id="${soft}" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="4"/></filter>`,
    );
    sheet.save();
    sheet.beginPath();
    sheet.arc(
      WEATHER_PIXELS / 2,
      WEATHER_PIXELS / 2,
      (lip * WEATHER_PIXELS) / (2 * extent),
      0,
      2 * Math.PI,
    );
    sheet.clip();
    traceWash(sheet, scene.grid, weatherLook, extent);
    traceFog(sheet, scene.grid, weatherLook, extent, soft);
    sheet.restore();
    const g = globalThis as { OffscreenCanvas?: unknown };
    const had = g.OffscreenCanvas;
    g.OffscreenCanvas = NoCanvas;
    try {
      paintWeather(canvasOf(sheet), scene, weatherLook, LAYERS);
    } finally {
      g.OffscreenCanvas = had;
    }
    drawn.systems = scene.systems.length;
    drawn.fronts = scene.fronts.length;
    for (const b of map.boats) {
      drawn.boats++;
      inkBoat(svg, view, b, look.ink, '#f6efdc');
    }
    letterNames(drawn, svg, view, namesOf(map), look, rankShown(wholeDiskDistance(lip)));
  }
  const picture = svg.toString(box, titleOf(false));
  return { svg: of.resting ? markResting(picture) : picture, drawn };
}

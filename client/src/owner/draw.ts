// SPDX-License-Identifier: AGPL-3.0-only

// Draws the world page's map on a canvas, layer by layer from the bottom:
// the land, drawn once per world by keel as the world generator's preview
// draws it, and an island at the lattice's resolution when zoomed into it;
// the coasts; the gusts, the wind and the current; the rings of the calm
// water, the mist band and the lip; the start area; the islands' names;
// the boats, each pointing its heading, the owner's picked out, with its
// free camera's eye; and the point clicked. The marks are in Okabe and
// Ito's colours, distinguishable in colour-blind vision.

import type {
  Boat,
  Current,
  FeaturesData,
  Group,
  Island,
  Light,
  PlacesData,
  WorldNow,
} from './api';
import { canvasAngle, HALF, rectOf, toScreen, type View } from './map';

export const COLOURS = {
  sea: '#14365e',
  owner: '#d55e00',
  player: '#0072b2',
  ai: '#999999',
  falling: '#cc79a7',
  calm: '#009e73',
  mist: '#cc79a7',
  lip: '#d55e00',
  start: '#e69f00',
  wind: 'rgb(240 228 66 / 65%)',
  current: '#56b4e9',
  eye: '#e69f00',
  pick: '#ffffff',
};

/** The layers, each shown or hidden. */
export interface Layers {
  land: boolean;
  coasts: boolean;
  gusts: boolean;
  wind: boolean;
  current: boolean;
  rings: boolean;
  start: boolean;
  names: boolean;
  places: boolean;
  features: boolean;
  classes: boolean;
  lights: boolean;
  boats: boolean;
}

export const LAYER_NAMES: Record<keyof Layers, string> = {
  land: 'Land',
  coasts: 'Coasts',
  gusts: 'Gusts',
  wind: 'Wind',
  current: 'Current',
  rings: 'Mist band and lip',
  start: 'Start area',
  names: 'Names',
  places: 'Places',
  features: 'Features',
  classes: 'Islands worth seeing',
  lights: 'Lighthouses',
  boats: 'Boats',
};

export function allLayers(): Layers {
  return {
    land: true,
    coasts: true,
    gusts: false,
    wind: true,
    current: false,
    rings: true,
    start: true,
    names: true,
    places: true,
    features: true,
    classes: true,
    lights: true,
    boats: true,
  };
}

/** What the map draws. */
export interface MapData {
  now: WorldNow | null;
  islands: Island[];
  groups: Group[];
  /** The start area's places. */
  start: [number, number][];
  current: Current | null;
  land: HTMLImageElement | null;
  coasts: HTMLImageElement | null;
  /** An island's drawing at the lattice's resolution, by number, once fetched. */
  islandImages: Map<number, HTMLImageElement>;
  /** The gusts' grid drawn, a pixel a point. */
  gusts: HTMLCanvasElement | null;
  /** The point clicked, and the boat chosen. */
  picked: [number, number] | null;
  boat: number | null;
  /** The places and lights, and the light picked, its range drawn. */
  places: PlacesData | null;
  light: number | null;
  /** The features, and the feature picked. */
  features: FeaturesData | null;
}

/** The colours an island's class is ringed in. */
export const CLASS_COLOURS: Record<string, string> = { A: '#f2c14e', B: '#9fc5e8' };

/** Below this many metres a pixel, an island in view is drawn at the lattice's resolution. */
export const ISLAND_DETAIL = 1.5;

/** The gusts' grid as a picture: a gust orange, a lull blue, by how far from the mean, 0.1 m/s a step. */
export function gustPicture(grid: Int8Array, into: HTMLCanvasElement): void {
  const side = Math.round(Math.sqrt(grid.length));
  into.width = side;
  into.height = side;
  const ctx = into.getContext('2d');
  if (ctx === null) {
    return;
  }
  const img = ctx.createImageData(side, side);
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i] ?? 0;
    const t = i * 4;
    if (v === -128) {
      img.data[t + 3] = 0;
      continue;
    }
    // ±3 m/s is the whole range of the colour.
    const a = Math.min(Math.abs(v) / 30, 1);
    if (v >= 0) {
      img.data[t] = 0xd5;
      img.data[t + 1] = 0x5e;
      img.data[t + 2] = 0x00;
    } else {
      img.data[t] = 0x00;
      img.data[t + 1] = 0x72;
      img.data[t + 2] = 0xb2;
    }
    img.data[t + 3] = Math.round(200 * a);
  }
  ctx.putImageData(img, 0, 0);
}

function boatColour(b: Boat): string {
  if (b.falling) {
    return COLOURS.falling;
  }
  if (b.tools) {
    return COLOURS.owner;
  }
  return b.human ? COLOURS.player : COLOURS.ai;
}

function arrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
): void {
  const dx = Math.cos(angle) * length;
  const dy = Math.sin(angle) * length;
  ctx.moveTo(x - dx / 2, y - dy / 2);
  ctx.lineTo(x + dx / 2, y + dy / 2);
  const hx = x + dx / 2;
  const hy = y + dy / 2;
  const h = Math.min(6, length / 3);
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - Math.cos(angle - 0.5) * h, hy - Math.sin(angle - 0.5) * h);
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - Math.cos(angle + 0.5) * h, hy - Math.sin(angle + 0.5) * h);
}

function circle(
  ctx: CanvasRenderingContext2D,
  v: View,
  radius: number,
  colour: string,
  label: string,
): void {
  const [cx, cy] = toScreen(v, 0, 0);
  ctx.strokeStyle = colour;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius / v.scale, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.fillText(label, cx + 4, cy - radius / v.scale - 3);
}

/** Draws the map of d in view v, with the layers shown. */
export function drawMap(ctx: CanvasRenderingContext2D, v: View, d: MapData, layers: Layers): void {
  ctx.save();
  ctx.fillStyle = COLOURS.sea;
  ctx.fillRect(0, 0, v.width, v.height);
  ctx.font = '11px "Alegreya Sans", sans-serif';
  ctx.imageSmoothingEnabled = v.scale > 2;
  const square = rectOf(v, -HALF, -HALF, HALF, HALF);
  if (layers.land && d.land?.complete === true) {
    ctx.drawImage(d.land, ...square);
    // An island zoomed into, at the lattice's resolution.
    if (v.scale < ISLAND_DETAIL) {
      for (const is of d.islands) {
        const img = d.islandImages.get(is.number);
        if (img === undefined || !img.complete) {
          continue;
        }
        const [w, s, e, n] = is.bounds;
        ctx.drawImage(img, ...rectOf(v, w, s, e, n));
      }
    }
  }
  if (layers.coasts && d.coasts?.complete === true) {
    ctx.drawImage(d.coasts, ...square);
  }
  if (layers.gusts && d.gusts !== null) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(d.gusts, ...square);
  }
  const now = d.now;
  if (layers.current && d.current !== null) {
    ctx.strokeStyle = COLOURS.current;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Thinned out when zoomed out: about every 40 pixels.
    const every = Math.max(1, Math.round((40 * v.scale) / d.current.step));
    for (const [e, n, ce, cn] of d.current.points) {
      if (
        Math.round(e / d.current.step) % every !== 0 ||
        Math.round(n / d.current.step) % every !== 0
      ) {
        continue;
      }
      const [x, y] = toScreen(v, e, n);
      const speed = Math.hypot(ce, cn);
      arrow(ctx, x, y, Math.atan2(-cn, ce), Math.min(30, 6 + speed * 20));
    }
    ctx.stroke();
  }
  if (layers.wind && now !== null) {
    ctx.strokeStyle = COLOURS.wind;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [e, n, knots, from] of now.wind.points) {
      const [x, y] = toScreen(v, e, n);
      // Downwind: away from where it comes from.
      arrow(ctx, x, y, canvasAngle(from + 180), Math.min(40, 6 + knots * 1.5));
    }
    ctx.stroke();
  }
  if (layers.rings && now !== null) {
    const w = now.world;
    // The mist band, shaded from where it begins to the lip.
    const [cx, cy] = toScreen(v, 0, 0);
    ctx.fillStyle = 'rgb(204 121 167 / 18%)';
    ctx.beginPath();
    ctx.arc(cx, cy, w.lip / v.scale, 0, 2 * Math.PI);
    ctx.arc(cx, cy, w.mist / v.scale, 0, 2 * Math.PI, true);
    ctx.fill();
    circle(ctx, v, w.calm, COLOURS.calm, 'calm water');
    circle(ctx, v, w.mist, COLOURS.mist, 'mist band');
    circle(ctx, v, w.lip, COLOURS.lip, 'the lip');
  }
  if (layers.start) {
    // Each place a dot, small enough zoomed out that the area shows as a
    // haze of them.
    ctx.fillStyle = COLOURS.start;
    ctx.globalAlpha = v.scale > 4 ? 0.35 : 0.8;
    const r = Math.min(1.5, Math.max(0.5, 3 / v.scale));
    for (const [e, n] of d.start) {
      const [x, y] = toScreen(v, e, n);
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }
  if (layers.names) {
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
    ctx.fillStyle = '#ffffff';
    for (const is of d.islands) {
      if (is.group >= 0 && v.scale > 2) {
        continue; // its group's name shows, zoomed out
      }
      const big = is.kind === 'main' || is.kind === 'landmark';
      if (!big && v.scale > 6) {
        continue;
      }
      const [x, y] = toScreen(v, is.east, is.north);
      ctx.font = `${is.kind === 'main' ? 14 : big ? 12 : 10}px "Alegreya Sans", sans-serif`;
      const ty = y - is.across / 2 / v.scale - 3;
      ctx.strokeText(is.name, x, ty);
      ctx.fillText(is.name, x, ty);
    }
    if (v.scale > 2) {
      ctx.font = 'italic 10px "Alegreya Sans", sans-serif';
      for (const g of d.groups) {
        const [x, y] = toScreen(v, g.east, g.north);
        ctx.strokeText(g.name, x, y + 14);
        ctx.fillText(g.name, x, y + 14);
      }
    }
    ctx.textAlign = 'start';
  }
  if (layers.places && d.places !== null) {
    const kinds = new Map(d.places.kinds.map((k) => [k.id, k]));
    for (const p of d.places.places) {
      const kind = kinds.get(p.kind);
      if (kind?.site === 'light') {
        continue; // drawn with the lights
      }
      const [x, y] = toScreen(v, p.east, p.north);
      ctx.fillStyle = kind?.mark ?? '#ffffff';
      ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
      ctx.lineWidth = 1;
      // A diamond, larger for a port.
      const port = kind?.site === 'harbour';
      const r = port ? 5 : 3.5;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (layers.names && (v.scale < 3 || port)) {
        ctx.font = 'italic 10px "Alegreya Sans", sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeText(p.name, x + 6, y + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(p.name, x + 6, y + 3);
      }
    }
  }
  if (layers.classes) {
    // A ring about each island of class A, a fainter one about class B.
    for (const is of d.islands) {
      const colour = CLASS_COLOURS[is.class];
      if (colour === undefined) {
        continue;
      }
      const [x, y] = toScreen(v, is.east, is.north);
      ctx.strokeStyle = colour;
      ctx.lineWidth = is.class === 'A' ? 2.5 : 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(is.across / 2 / v.scale + 6, 8), 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
  if (layers.features && d.features !== null) {
    const kinds = new Map(d.features.kinds.map((k) => [k.id, k]));
    for (const f of d.features.features) {
      const kind = kinds.get(f.kind);
      const [x, y] = toScreen(v, f.east, f.north);
      // A triangle, hollow for one not seen from the water.
      ctx.fillStyle = kind?.mark ?? '#ffffff';
      ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 4.5);
      ctx.lineTo(x + 4, y + 3);
      ctx.lineTo(x - 4, y + 3);
      ctx.closePath();
      if (f.seen) {
        ctx.fill();
      }
      ctx.stroke();
      if (layers.names && v.scale < 2) {
        const name = kind?.name ?? f.kind;
        ctx.font = '10px "Alegreya Sans", sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeText(name, x + 6, y + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(name, x + 6, y + 3);
      }
    }
  }
  if (layers.lights && d.places !== null) {
    for (const l of d.places.lights) {
      drawLight(ctx, v, l, d);
    }
  }
  if (layers.boats && now !== null) {
    for (const b of now.boats) {
      const [x, y] = toScreen(v, b.east, b.north);
      const colour = boatColour(b);
      if (b.eye !== null) {
        // Its owner's free camera, and a line back to the boat.
        const [ex, ey] = toScreen(v, b.eye[0], b.eye[1]);
        ctx.strokeStyle = COLOURS.eye;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(ex - 5, ey - 4, 10, 8);
      }
      // A boat 4.3 m long at its size, or 10 pixels at least.
      const len = Math.max(10, 4.3 / v.scale);
      const a = canvasAngle(b.heading);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(len / 2, 0);
      ctx.lineTo(-len / 2, len / 3);
      ctx.lineTo(-len / 2, -len / 3);
      ctx.closePath();
      if (b.unseen) {
        ctx.setLineDash([2, 2]);
      }
      ctx.lineWidth = b.boat === d.boat ? 3 : 1.5;
      ctx.strokeStyle = b.boat === d.boat ? COLOURS.pick : colour;
      if (!b.stays) {
        ctx.fillStyle = colour;
        ctx.fill();
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  if (d.picked !== null) {
    const [x, y] = toScreen(v, d.picked[0], d.picked[1]);
    ctx.strokeStyle = COLOURS.pick;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
  }
  // The scale: a nautical mile, or a hundred metres zoomed in.
  const metres = v.scale > 2 ? 1852 : 100;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(16, v.height - 16);
  ctx.lineTo(16 + metres / v.scale, v.height - 16);
  ctx.stroke();
  ctx.fillText(metres === 1852 ? '1 nautical mile' : '100 m', 16, v.height - 22);
  ctx.restore();
}

/** The colours a light's mark shows when it is lit. */
const LIGHT_COLOURS: Record<string, string> = {
  white: '#fff3c4',
  red: '#ff5a3c',
  green: '#3cff7d',
};

/** A lighthouse: a ring, and its range when picked; its flashing shows beside its row in the list. */
function drawLight(ctx: CanvasRenderingContext2D, v: View, l: Light, d: MapData): void {
  const ch = d.places?.characters[l.character];
  const [x, y] = toScreen(v, l.east, l.north);
  const colour = LIGHT_COLOURS[ch?.colour ?? 'white'] ?? '#ffffff';
  if (l.number === d.light) {
    ctx.strokeStyle = colour;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, l.range / v.scale, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#e8b400';
  ctx.fillStyle = '#3b2f22';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, l.role === 'main' ? 6 : 4.5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
}

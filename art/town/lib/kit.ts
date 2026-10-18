// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// A biome's kit of town buildings: one model for each kind of building the
// catalog lists, and its props, each built from the period's buildings of
// that climate by a style (the biome's build.ts gives it). Real sizes: a
// kind's model is its frontage and depth at the middle of its catalog's
// ranges, and the page scales it to each house's own.
//
// A model is built at its kind's most storeys; each vertex carries in its
// second texture coordinate its part (the page colours walls, roofs and
// shutters from the kit's palette, house by house) and its role: fixed, a
// storey's own (its windows, shutters and bands, dropped when the house
// has fewer storeys), or above the walls (the eaves, the roof and the
// chimney, lowered a storey for each storey fewer). Its first texture
// coordinate's x is a window's number, so that the page lights a share of
// a house's windows at night, each its own. Its colour is the part's own
// colour, or for a part the palette colours, a shade.
//
// The front faces −z, the origin is the middle of the footprint on its
// plot, and a node's extras give the frontage, depth and storeys it was
// built at.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { MeshBuilder, srgb, type Vec3 } from '../../lib/mesh.ts';

/** A part of a building, as its second texture coordinate's x names it. */
export const PART = {
  wall: 0,
  timber: 1,
  roof: 2,
  shutter: 3,
  glass: 4,
  stone: 5,
  wood: 6,
  cloth: 7,
  iron: 8,
} as const;

/** A vertex's role, as its second texture coordinate's y names it: 1 + k for storey k's own; ABOVE for what stands above the walls. */
export const FIXED = 0;
export const ABOVE = 4;

/** A storey's height, m, and the roof's above the top storey, as the generator reckons a building's top. */
export const STOREY = 3;

/** How a biome builds. */
export interface Style {
  /** The roof: pitched with gables, hipped, steep with gables, or flat-stepped and white. */
  roof: 'gable' | 'hip' | 'steep' | 'stepped';
  /** The eaves' overhang, m. */
  eaves: number;
  /** A timber frame: corner posts and a band at each floor. */
  timber: boolean;
  /** A gallery along the front, roofed apart from the house. */
  gallery: boolean;
  /** Quoins of dressed stone at the corners. */
  quoins: boolean;
  /** The plinth's height, m. */
  plinth: number;
  /** Fixed colours, #rrggbb: timber and trim, stone, natural wood, iron. */
  timberColour: string;
  stoneColour: string;
  woodColour: string;
  ironColour: string;
  /** Windows a storey per this many metres of wall, and their size, m. */
  windowEvery: number;
  window: [number, number];
}

/** The catalog's kinds of building, as the kit reads them. */
interface Kind {
  id: string;
  prop?: boolean;
  frontage: [number, number];
  depth: [number, number];
  storeys: [number, number];
  stands: string;
  chimney?: number;
  flag?: boolean;
  top?: number;
}

const hex = (c: string): Vec3 => {
  const n = Number.parseInt(c.slice(1), 16);
  return srgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** A building's builder: faces with their part and role. */
class Builder {
  readonly m = new MeshBuilder('town');
  /** The height at or above which a vertex is above the walls; ∞ for a building of fixed storeys. */
  above = Number.POSITIVE_INFINITY;

  /** Moves the vertices from the one given on by dz along z. */
  shift(from: number, dz: number): void {
    for (let i = from; i < this.m.count; i++) {
      this.m.positions[i * 3 + 2] = (this.m.positions[i * 3 + 2] ?? 0) + dz;
    }
  }

  /** A vertex: its colour, part, role and window number. */
  v(p: Vec3, colour: Vec3, part: number, role: number, win = 0): number {
    const r = role === FIXED && p[1] >= this.above - 0.01 ? ABOVE : role;
    return this.m.vertex(p, colour, [win / 64, 0], [part, r]);
  }

  /** A flat quad a-b-c-d, counter-clockwise from its front, facing n. */
  quad(c: Vec3[], n: Vec3, colour: Vec3, part: number, role = FIXED, win = 0): void {
    const k = c.map((p) => {
      const i = this.v(p, colour, part, role, win);
      this.m.normal(i, n);
      return i;
    });
    this.m.triFacing(k[0] as number, k[1] as number, k[2] as number, n);
    this.m.triFacing(k[0] as number, k[2] as number, k[3] as number, n);
  }

  /** A box, its faces flat, of one part; win its window's number, if it is one. */
  box(min: Vec3, max: Vec3, colour: Vec3, part: number, role = FIXED, win = 0): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.quad(
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      [1, 0, 0],
      colour,
      part,
      role,
      win,
    );
    this.quad(
      [
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
        [x0, y0, z0],
      ],
      [-1, 0, 0],
      colour,
      part,
      role,
      win,
    );
    this.quad(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [0, 0, 1],
      colour,
      part,
      role,
      win,
    );
    this.quad(
      [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ],
      [0, 0, -1],
      colour,
      part,
      role,
      win,
    );
    this.quad(
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      [0, 1, 0],
      colour,
      part,
      role,
      win,
    );
  }

  /** A prism standing on a regular polygon of n sides, radius r0 at y0 and r1 at y1, open at the ends. */
  prism(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r0: number,
    r1: number,
    n: number,
    colour: Vec3,
    part: number,
  ): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI;
      const a1 = ((k + 1) / n) * 2 * Math.PI;
      const am = (a0 + a1) / 2;
      const p = (a: number, r: number, y: number): Vec3 => [
        x + r * Math.sin(a),
        y,
        z + r * Math.cos(a),
      ];
      this.quad(
        [p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1)],
        [Math.sin(am), 0, Math.cos(am)],
        colour,
        part,
      );
    }
  }

  /** A cone or pyramid over a polygon of n sides from y0 to a point at y1. */
  spire(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r: number,
    n: number,
    colour: Vec3,
    part: number,
  ): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI + Math.PI / n;
      const a1 = ((k + 1) / n) * 2 * Math.PI + Math.PI / n;
      const am = (a0 + a1) / 2;
      const slope = r / (y1 - y0);
      const nn: Vec3 = [Math.sin(am), slope, Math.cos(am)];
      const i = this.v([x + r * Math.sin(a0), y0, z + r * Math.cos(a0)], colour, part, FIXED);
      const j = this.v([x + r * Math.sin(a1), y0, z + r * Math.cos(a1)], colour, part, FIXED);
      const t = this.v([x, y1, z], colour, part, FIXED);
      for (const q of [i, j, t]) {
        this.m.normal(q, nn);
      }
      this.m.triFacing(i, j, t, nn);
    }
  }
}

/** The walls, windows, shutters, door and frame of a house front, back and sides. */
function walls(
  b: Builder,
  s: Style,
  f: number,
  d: number,
  storeys: number,
  opts: { door: number; shop?: boolean; few?: boolean },
): void {
  const hf = f / 2;
  const hd = d / 2;
  const top = storeys * STOREY;
  const wall: Vec3 = [1, 1, 1];
  // The walls, each one quad to the eaves.
  b.quad(
    [
      [-hf, 0, -hd],
      [hf, 0, -hd],
      [hf, top, -hd],
      [-hf, top, -hd],
    ],
    [0, 0, -1],
    wall,
    PART.wall,
  );
  b.quad(
    [
      [hf, 0, hd],
      [-hf, 0, hd],
      [-hf, top, hd],
      [hf, top, hd],
    ],
    [0, 0, 1],
    wall,
    PART.wall,
  );
  b.quad(
    [
      [hf, 0, -hd],
      [hf, 0, hd],
      [hf, top, hd],
      [hf, top, -hd],
    ],
    [1, 0, 0],
    wall,
    PART.wall,
  );
  b.quad(
    [
      [-hf, 0, hd],
      [-hf, 0, -hd],
      [-hf, top, -hd],
      [-hf, top, hd],
    ],
    [-1, 0, 0],
    wall,
    PART.wall,
  );
  // The plinth.
  const stone = hex(s.stoneColour);
  if (s.plinth > 0) {
    b.box([-hf - 0.06, 0, -hd - 0.06], [hf + 0.06, s.plinth, hd + 0.06], stone, PART.stone);
  }
  // Corner posts or quoins, and the floors' bands.
  const timber = hex(s.timberColour);
  for (const [x, z] of [
    [-hf, -hd],
    [hf, -hd],
    [hf, hd],
    [-hf, hd],
  ] as const) {
    if (s.timber) {
      b.box([x - 0.12, s.plinth, z - 0.12], [x + 0.12, top, z + 0.12], timber, PART.timber);
    } else if (s.quoins) {
      b.box([x - 0.16, 0, z - 0.16], [x + 0.16, top, z + 0.16], stone, PART.stone);
    }
  }
  if (s.timber) {
    for (let k = 1; k < storeys; k++) {
      const y = k * STOREY;
      b.box(
        [-hf - 0.03, y - 0.1, -hd - 0.03],
        [hf + 0.03, y + 0.1, hd + 0.03],
        timber,
        PART.timber,
        1 + k,
      );
    }
  }
  // Windows with shutters either side, a storey's own; the door below.
  const [ww, wh] = s.window;
  const shutter: Vec3 = [1, 1, 1];
  let win = 0;
  const face = (
    along: number,
    n: Vec3,
    at: (u: number, y: number, out: number) => Vec3,
    door: boolean,
  ): void => {
    const every = opts.few === true ? s.windowEvery * 2 : s.windowEvery;
    const count = Math.max(1, Math.floor(along / every));
    for (let k = 0; k < storeys; k++) {
      for (let i = 0; i < count; i++) {
        const u = -along / 2 + (along * (i + 0.5)) / count;
        if (door && k === 0 && Math.abs(u - opts.door) < ww) {
          continue;
        }
        const y0 = k * STOREY + 0.9;
        const y1 = y0 + wh;
        const o = 0.02;
        b.quad(
          [
            at(u - ww / 2, y0, o),
            at(u + ww / 2, y0, o),
            at(u + ww / 2, y1, o),
            at(u - ww / 2, y1, o),
          ],
          n,
          [0.05, 0.05, 0.06],
          PART.glass,
          1 + k,
          win++,
        );
        for (const side of [-1, 1]) {
          const x0 = u + side * (ww / 2 + 0.02);
          const x1 = u + side * (ww + 0.02);
          b.quad(
            [
              at(Math.min(x0, x1), y0, 0.04),
              at(Math.max(x0, x1), y0, 0.04),
              at(Math.max(x0, x1), y1, 0.04),
              at(Math.min(x0, x1), y1, 0.04),
            ],
            n,
            shutter,
            PART.shutter,
            1 + k,
          );
        }
      }
    }
  };
  face(f, [0, 0, -1], (u, y, o) => [u, y, -hd - o], true);
  face(f, [0, 0, 1], (u, y, o) => [-u, y, hd + o], false);
  face(d, [1, 0, 0], (u, y, o) => [hf + o, y, u], false);
  face(d, [-1, 0, 0], (u, y, o) => [-hf - o, y, -u], false);
  // The door: wider for a warehouse's loading, a shop's front.
  const dw = opts.shop === true ? 1.8 : 1.1;
  b.quad(
    [
      [opts.door - dw / 2, 0, -hd - 0.03],
      [opts.door + dw / 2, 0, -hd - 0.03],
      [opts.door + dw / 2, 2.2, -hd - 0.03],
      [opts.door - dw / 2, 2.2, -hd - 0.03],
    ],
    [0, 0, -1],
    shutter,
    PART.shutter,
    FIXED,
  );
}

/** A roof over a footprint, its eaves at y, by the style. */
function roof(
  b: Builder,
  s: Style,
  f: number,
  d: number,
  y: number,
  kind: Style['roof'] = s.roof,
): void {
  const e = s.eaves;
  const hf = f / 2 + e;
  const hd = d / 2 + e;
  const tile: Vec3 = [1, 1, 1];
  const ridge =
    kind === 'steep'
      ? Math.min(hd * 1.3, 6)
      : kind === 'stepped'
        ? Math.min(hd * 0.5, 2)
        : Math.min(hd * 0.75, 4.5);
  const n = (a: Vec3, c: Vec3): Vec3 => a.map((v, i) => v + (c[i] ?? 0)) as Vec3;
  if (kind === 'hip') {
    const r = Math.max(hf - hd, 0.3);
    const front: Vec3 = [0, hd, -ridge];
    const back: Vec3 = [0, hd, ridge];
    b.quad(
      [
        [-hf, y, -hd],
        [hf, y, -hd],
        [r, y + ridge, 0],
        [-r, y + ridge, 0],
      ],
      n(front, [0, 0, 0]),
      tile,
      PART.roof,
    );
    b.quad(
      [
        [hf, y, hd],
        [-hf, y, hd],
        [-r, y + ridge, 0],
        [r, y + ridge, 0],
      ],
      back,
      tile,
      PART.roof,
    );
    for (const side of [-1, 1]) {
      const p0: Vec3 = [side * hf, y, side * hd];
      const p1: Vec3 = [side * hf, y, -side * hd];
      const t: Vec3 = [side * r, y + ridge, 0];
      const nn: Vec3 = [side * ridge, hf - r, 0];
      const i = b.v(p0, tile, PART.roof, FIXED);
      const j = b.v(p1, tile, PART.roof, FIXED);
      const k = b.v(t, tile, PART.roof, FIXED);
      for (const q of [i, j, k]) {
        b.m.normal(q, nn);
      }
      b.m.triFacing(i, j, k, nn);
    }
    return;
  }
  // Gabled, the ridge from side to side; stepped roofs are low and white, in steps.
  b.quad(
    [
      [-hf, y, -hd],
      [hf, y, -hd],
      [hf, y + ridge, 0],
      [-hf, y + ridge, 0],
    ],
    [0, hd, -ridge],
    tile,
    PART.roof,
  );
  b.quad(
    [
      [hf, y, hd],
      [-hf, y, hd],
      [-hf, y + ridge, 0],
      [hf, y + ridge, 0],
    ],
    [0, hd, ridge],
    tile,
    PART.roof,
  );
  if (kind === 'stepped') {
    for (const t of [0.33, 0.66]) {
      const yy = y + ridge * t;
      const zz = hd * (1 - t);
      b.box([-hf, yy, -zz - 0.04], [hf, yy + 0.07, -zz + 0.04], tile, PART.roof);
      b.box([-hf, yy, zz - 0.04], [hf, yy + 0.07, zz + 0.04], tile, PART.roof);
    }
  }
  // The gables, walled.
  const wall: Vec3 = [1, 1, 1];
  const gf = f / 2;
  const gd = d / 2;
  const gr = ridge * (gd / hd);
  for (const side of [-1, 1]) {
    const i = b.v([side * gf, y, -gd], wall, PART.wall, FIXED);
    const j = b.v([side * gf, y, gd], wall, PART.wall, FIXED);
    const k = b.v([side * gf, y + gr, 0], wall, PART.wall, FIXED);
    for (const q of [i, j, k]) {
      b.m.normal(q, [side, 0, 0]);
    }
    b.m.triFacing(i, j, k, [side, 0, 0]);
  }
}

/** A chimney of stone on the roof's ridge, toward a gable. */
function chimney(b: Builder, s: Style, f: number, y: number, ridge: number): void {
  const stone = hex(s.stoneColour);
  const x = f * 0.3;
  b.box([x - 0.35, y + ridge * 0.4, -0.3], [x + 0.35, y + ridge + 1.1, 0.3], stone, PART.stone);
}

/** The ridge's height a roof over this depth rises to. */
function ridgeOf(s: Style, d: number): number {
  const hd = d / 2 + s.eaves;
  return s.roof === 'steep'
    ? Math.min(hd * 1.3, 6)
    : s.roof === 'stepped'
      ? Math.min(hd * 0.5, 2)
      : Math.min(hd * 0.75, 4.5);
}

/** A house of the kind: walls, roof, chimney; a shop front, a warehouse's loading door and hoist, a gallery. */
function house(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const storeys = k.storeys[1];
  const top = storeys * STOREY;
  b.above = top;
  const warehouse = k.stands === 'quayEnd';
  const shop = k.stands === 'quay';
  walls(b, s, f, d, storeys, {
    door: warehouse ? 0 : f * 0.2,
    shop: shop || warehouse,
    few: warehouse,
  });
  roof(b, s, f, d, top);
  if ((k.chimney ?? 0) > 0) {
    chimney(b, s, f, top, ridgeOf(s, d));
  }
  const timber = hex(s.timberColour);
  if (warehouse) {
    // A hoist beam over the loading doors.
    b.box([-0.12, top - 0.6, -d / 2 - 1.2], [0.12, top - 0.35, -d / 2], timber, PART.timber, ABOVE);
  }
  if (shop) {
    // An awning over the shop front.
    b.quad(
      [
        [-f * 0.35, 2.6, -d / 2],
        [f * 0.35, 2.6, -d / 2],
        [f * 0.35, 2.3, -d / 2 - 1.2],
        [-f * 0.35, 2.3, -d / 2 - 1.2],
      ],
      [0, 1, -0.25],
      [1, 1, 1],
      PART.cloth,
    );
  }
  if (s.gallery) {
    // A gallery along the front on posts, its own roof.
    const gd = 2;
    for (const x of [-f / 2, -f / 6, f / 6, f / 2]) {
      b.box([x - 0.08, 0, -d / 2 - gd], [x + 0.08, 2.6, -d / 2 - gd + 0.16], timber, PART.timber);
    }
    b.box(
      [-f / 2 - 0.2, 0, -d / 2 - gd - 0.1],
      [f / 2 + 0.2, 0.3, -d / 2],
      hex(s.woodColour),
      PART.wood,
    );
    b.quad(
      [
        [-f / 2 - 0.3, 2.7, -d / 2 - gd - 0.3],
        [f / 2 + 0.3, 2.7, -d / 2 - gd - 0.3],
        [f / 2 + 0.3, 3.1, -d / 2],
        [-f / 2 - 0.3, 3.1, -d / 2],
      ],
      [0, gd, -0.4],
      [1, 1, 1],
      PART.roof,
    );
  }
}

/** A church: its nave under a steep roof, and at its front a tower with a belfry and a spire, to its top. */
function church(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const tw = Math.min(f * 0.45, 4.5);
  const nd = d - tw;
  // The nave behind the tower, its walls two storeys high with no floors.
  const from = b.m.count;
  walls(b, s, f, nd, 2, { door: f * 0.3, few: true });
  roof(b, s, f, nd, 2 * STOREY, 'steep');
  b.shift(from, tw / 2);
  // The tower at the front.
  const top = k.top ?? 22;
  const cz = -d / 2 + tw / 2;
  const stone = hex(s.stoneColour);
  b.box([-tw / 2, 0, cz - tw / 2], [tw / 2, top - 6, cz + tw / 2], [1, 1, 1], PART.wall);
  b.box(
    [-tw / 2 - 0.1, top - 6.4, cz - tw / 2 - 0.1],
    [tw / 2 + 0.1, top - 6, cz + tw / 2 + 0.1],
    stone,
    PART.stone,
  );
  // The belfry's openings, dark; the door below.
  for (const n of [
    [0, 0, -1],
    [0, 0, 1],
    [1, 0, 0],
    [-1, 0, 0],
  ] as Vec3[]) {
    const c: Vec3 = [n[0] * (tw / 2 + 0.02), top - 8.6, cz + n[2] * (tw / 2 + 0.02)];
    const u: Vec3 = [Math.abs(n[2]) * 0.6, 0, Math.abs(n[0]) * 0.6];
    b.quad(
      [
        [c[0] - u[0], c[1], c[2] - u[2]],
        [c[0] + u[0], c[1], c[2] + u[2]],
        [c[0] + u[0], c[1] + 1.8, c[2] + u[2]],
        [c[0] - u[0], c[1] + 1.8, c[2] - u[2]],
      ],
      n,
      [0.04, 0.04, 0.04],
      PART.glass,
      FIXED,
      63,
    );
  }
  b.quad(
    [
      [-0.7, 0, -d / 2 - 0.03],
      [0.7, 0, -d / 2 - 0.03],
      [0.7, 2.8, -d / 2 - 0.03],
      [-0.7, 2.8, -d / 2 - 0.03],
    ],
    [0, 0, -1],
    [1, 1, 1],
    PART.shutter,
  );
  b.spire(0, cz, top - 6, top, tw * 0.72, 4, [1, 1, 1], PART.roof);
}

/** A tower mill: a tapering round tower, its cap, and four sails. */
function windmill(b: Builder, s: Style, k: Kind, f: number): void {
  const top = (k.top ?? 14) - 2;
  b.prism(0, 0, 0, top, f / 2, f / 3, 12, [1, 1, 1], PART.wall);
  b.spire(0, 0, top, top + 2.2, f / 3 + 0.3, 12, [1, 1, 1], PART.roof);
  const wood = hex(s.woodColour);
  const cloth = hex('#e6dfcc');
  const hub: Vec3 = [0, top - 0.5, -f / 3 - 0.4];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const dx = Math.sin(a);
    const dy = Math.cos(a);
    const px = -dy;
    const py = dx;
    const len = top - 1;
    const p = (t: number, w: number): Vec3 => [
      hub[0] + dx * t + px * w,
      hub[1] + dy * t + py * w,
      hub[2],
    ];
    b.quad([p(0, -0.12), p(len, -0.12), p(len, 0.12), p(0, 0.12)], [0, 0, -1], wood, PART.wood);
    b.quad([p(1.5, 0.15), p(len, 0.15), p(len, 1.6), p(1.5, 1.6)], [0, 0, -1], cloth, PART.cloth);
  }
}

/** A shed of rough boards: a hut, a boat shed, a stage on its posts. */
function shed(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const wood = hex(s.woodColour);
  if (k.stands === 'water') {
    // The stage: a shed on the end of its platform, the platform on posts.
    b.box([-f / 2, -0.25, -d / 2], [f / 2, 0, d / 2], wood, PART.wood);
    for (const x of [-f / 2, f / 2]) {
      for (const z of [-d / 2, 0, d / 2]) {
        b.box([x - 0.12, -2.5, z - 0.12], [x + 0.12, 0, z + 0.12], wood, PART.wood);
      }
    }
    walls(b, s, f * 0.8, d * 0.55, 1, { door: 0, few: true });
    roof(b, s, f * 0.8, d * 0.55, STOREY, 'steep');
    return;
  }
  walls(b, s, f, d, 1, {
    door: k.stands === 'shore' ? 0 : f * 0.2,
    shop: k.stands === 'shore',
    few: true,
  });
  roof(b, s, f, d, STOREY, s.roof === 'hip' ? 'hip' : 'steep');
  if ((k.chimney ?? 0) > 0) {
    chimney(b, s, f, STOREY, ridgeOf({ ...s, roof: 'steep' }, d));
  }
}

/** A flake: a platform of spars on posts, for drying fish. */
function flake(b: Builder, s: Style, f: number, d: number): void {
  const wood = hex(s.woodColour);
  for (const x of [-f / 2, -f / 6, f / 6, f / 2]) {
    for (const z of [-d / 2, d / 2]) {
      b.box([x - 0.08, 0, z - 0.08], [x + 0.08, 1.4, z + 0.08], wood, PART.wood);
    }
  }
  for (let i = 0; i < 9; i++) {
    const z = -d / 2 + (d * i) / 8;
    b.box([-f / 2 - 0.1, 1.4, z - 0.05], [f / 2 + 0.1, 1.5, z + 0.05], wood, PART.wood);
  }
}

/** A slip running down into the water, a hull in frame on it. */
function slip(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const wood = hex(s.woodColour);
  // The ways, falling toward the front, into the water.
  b.quad(
    [
      [-f / 2, -2, -d / 2],
      [f / 2, -2, -d / 2],
      [f / 2, 0.6, d / 2],
      [-f / 2, 0.6, d / 2],
    ],
    [0, 1, -0.1],
    wood,
    PART.wood,
  );
  // The keel and the frames of a hull, rising from it.
  const hull = d * 0.6;
  b.box([-0.2, 0.2, -hull / 2], [0.2, 0.7, hull / 2], wood, PART.wood);
  for (let i = 0; i <= 10; i++) {
    const z = -hull / 2 + (hull * i) / 10;
    const w = Math.sin((Math.PI * (i + 0.5)) / 11) * Math.min(f * 0.35, 3.5);
    const h = (k.top ?? 8) - 2;
    for (const side of [-1, 1]) {
      b.box([side * w - 0.1, 0.5, z - 0.1], [side * w + 0.1, 0.5 + h, z + 0.1], wood, PART.wood);
      b.quad(
        [
          [0, 0.6, z],
          [side * w, 0.6, z],
          [side * w, 0.8, z],
          [0, 0.8, z],
        ],
        [0, 0, -1],
        wood,
        PART.wood,
      );
    }
  }
}

/** The props, by where they stand. */
function prop(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const wood = hex(s.woodColour);
  const iron = hex(s.ironColour);
  const stone = hex(s.stoneColour);
  switch (k.stands) {
    case 'square':
      if (f <= 2) {
        // A well: its stone ring and a frame over it.
        b.prism(0, 0, 0, 0.8, f / 2, f / 2, 8, stone, PART.stone);
        b.box([-f / 2, 0.8, -0.06], [-f / 2 + 0.12, 2.2, 0.06], wood, PART.wood);
        b.box([f / 2 - 0.12, 0.8, -0.06], [f / 2, 2.2, 0.06], wood, PART.wood);
        b.box([-f / 2, 2.1, -0.06], [f / 2, 2.25, 0.06], wood, PART.wood);
      } else {
        // A market stall: a counter, posts and an awning.
        b.box([-f / 2, 0, -d / 2], [f / 2, 0.9, -d / 2 + 0.6], wood, PART.wood);
        for (const x of [-f / 2, f / 2]) {
          for (const z of [-d / 2, d / 2]) {
            b.box([x - 0.05, 0, z - 0.05], [x + 0.05, 2.2, z + 0.05], wood, PART.wood);
          }
        }
        b.quad(
          [
            [-f / 2 - 0.2, 2.1, -d / 2 - 0.3],
            [f / 2 + 0.2, 2.1, -d / 2 - 0.3],
            [f / 2 + 0.2, 2.4, d / 2],
            [-f / 2 - 0.2, 2.4, d / 2],
          ],
          [0, 1, -0.2],
          [1, 1, 1],
          PART.cloth,
        );
      }
      return;
    case 'quay':
      if ((k.top ?? 0) > 0) {
        // A crane: a post, a jib and a fall.
        const h = k.top ?? 8;
        b.box([-0.2, 0, -0.2], [0.2, h - 1, 0.2], wood, PART.wood);
        b.box([-0.12, h - 1.4, -0.12], [0.12, h - 1.1, f], wood, PART.wood);
        b.box([-0.02, 2, f - 0.05], [0.02, h - 1.4, f + 0.05], iron, PART.iron);
      } else {
        // Crates and barrels.
        b.box([-f / 2, 0, -d / 2], [-f / 2 + 1, 0.8, -d / 2 + 1], wood, PART.wood);
        b.box(
          [-f / 2 + 0.1, 0.8, -d / 2 + 0.1],
          [-f / 2 + 0.9, 1.5, -d / 2 + 0.9],
          wood,
          PART.wood,
        );
        b.prism(f / 2 - 0.4, d / 2 - 0.4, 0, 0.9, 0.35, 0.35, 8, wood, PART.wood);
        b.prism(f / 2 - 0.4, -d / 2 + 0.6, 0, 0.9, 0.35, 0.35, 8, wood, PART.wood);
      }
      return;
    case 'edge':
      // A bollard of timber.
      b.prism(0, 0, 0, 0.9, 0.2, 0.17, 8, iron, PART.iron);
      return;
    case 'post':
      // A lantern post: the lantern at its top, where the page's glow is.
      b.box([-0.07, 0, -0.07], [0.07, 3, 0.07], iron, PART.iron);
      b.box([-0.18, 3, -0.18], [0.18, 3.45, 0.18], [1, 0.85, 0.55], PART.glass, FIXED, 62);
      b.spire(0, 0, 3.45, 3.7, 0.24, 4, iron, PART.iron);
      return;
    case 'beach': {
      // A boat drawn up, keel up the beach.
      const half = d / 2;
      const beam = f / 2;
      const ring = (z: number, w: number): Vec3[] => [
        [-w, 0.6, z],
        [-w * 0.6, 0.1, z],
        [w * 0.6, 0.1, z],
        [w, 0.6, z],
      ];
      const rings = [-half, -half * 0.5, 0, half * 0.5, half].map((z) =>
        ring(z, beam * Math.cos((z / half) * 1.2)),
      );
      for (let i = 0; i + 1 < rings.length; i++) {
        const a = rings[i] as Vec3[];
        const c = rings[i + 1] as Vec3[];
        for (let j = 0; j + 1 < a.length; j++) {
          const p0 = a[j] as Vec3;
          const p1 = a[j + 1] as Vec3;
          const p2 = c[j + 1] as Vec3;
          const p3 = c[j] as Vec3;
          const n: Vec3 = [(p0[0] + p1[0]) / 2, -0.5, 0];
          b.quad([p0, p1, p2, p3], n, wood, PART.wood);
        }
      }
      return;
    }
  }
}

/**
 * A wall of rubble stone along x from x0 to x1 at depth z, thick t, its top
 * broken: in steps falling and rising from the heights given at its ends,
 * by its own numbers, so no two ruins break alike.
 */
function brokenWall(
  b: Builder,
  stone: Vec3,
  x0: number,
  x1: number,
  z: number,
  t: number,
  h0: number,
  h1: number,
  seed: number,
  alongZ = false,
): void {
  const pieces = Math.max(2, Math.round(Math.abs(x1 - x0) / 1.6));
  for (let i = 0; i < pieces; i++) {
    const a = x0 + ((x1 - x0) * i) / pieces;
    const c = x0 + ((x1 - x0) * (i + 1)) / pieces;
    const u = (i + 0.5) / pieces;
    const jag = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const h = Math.max(0.4, h0 + (h1 - h0) * u - 0.9 * (jag - Math.floor(jag)));
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    if (alongZ) {
      b.box([z - t / 2, 0, lo], [z + t / 2, h, hi], stone, PART.stone);
    } else {
      b.box([lo, 0, z - t / 2], [hi, h, z + t / 2], stone, PART.stone);
    }
  }
}

/**
 * A ruin: a roofless house of a deserted hamlet, its walls broken and a gap
 * where its door was; a ruined chapel, its nave open to the sky and its
 * west gable standing to its top with the bellcote's opening; a ruined
 * beacon, a roofless watch-house beside its iron fire-basket on a post.
 * Every face is the style's stone: no palette, no glass, nothing lit.
 */
function ruin(b: Builder, s: Style, k: Kind, f: number, d: number): void {
  const stone = hex(s.stoneColour);
  const iron = hex(s.ironColour);
  const t = 0.5;
  const hf = f / 2;
  const hd = d / 2;
  switch (k.stands) {
    case 'hamlet': {
      const h = k.top ?? STOREY;
      // The front, either side of the door's gap; the back; the gable ends.
      brokenWall(b, stone, -hf, -0.6, -hd, t, h * 0.8, h * 0.5, 1);
      brokenWall(b, stone, 0.6, hf, -hd, t, h * 0.4, h * 0.7, 2);
      brokenWall(b, stone, -hf, hf, hd, t, h * 0.6, h * 0.9, 3);
      brokenWall(b, stone, -hd, hd, -hf, t, h, h * 0.6, 4, true);
      brokenWall(b, stone, -hd, hd, hf, t, h * 0.5, h + 0.8, 5, true);
      return;
    }
    case 'chapel': {
      const top = k.top ?? 9;
      brokenWall(b, stone, -hd, hd, -hf, t, 3.2, 2.2, 6, true);
      brokenWall(b, stone, -hd, hd, hf, t, 2.6, 3.4, 7, true);
      brokenWall(b, stone, -hf, hf, hd, t, 3, 1.8, 8);
      // The west gable, whole to its apex, a door below and the bellcote's
      // opening at its top.
      b.box([-hf, 0, -hd - t / 2], [-0.8, top - 2, -hd + t / 2], stone, PART.stone);
      b.box([0.8, 0, -hd - t / 2], [hf, top - 2, -hd + t / 2], stone, PART.stone);
      b.box([-0.8, 2.6, -hd - t / 2], [0.8, top - 2, -hd + t / 2], stone, PART.stone);
      b.box([-0.9, top - 2, -hd - t / 2], [-0.3, top, -hd + t / 2], stone, PART.stone);
      b.box([0.3, top - 2, -hd - t / 2], [0.9, top, -hd + t / 2], stone, PART.stone);
      b.box([-0.9, top - 0.3, -hd - t / 2], [0.9, top, -hd + t / 2], stone, PART.stone);
      return;
    }
    case 'beacon': {
      const top = k.top ?? 7;
      brokenWall(b, stone, -hf, hf, -hd, t, 2.2, 1.4, 9);
      brokenWall(b, stone, -hf, hf, hd, t, 1.6, 2.4, 10);
      brokenWall(b, stone, -hd, hd, -hf, t, 2.4, 1.2, 11, true);
      // The fire-basket on its post, at the watch-house's seaward corner.
      b.box([hf + 0.5, 0, -hd - 0.1], [hf + 0.7, top - 0.9, -hd + 0.1], iron, PART.iron);
      b.prism(hf + 0.6, -hd, top - 0.9, top, 0.3, 0.6, 6, iron, PART.iron);
      return;
    }
  }
}

/** Builds a kind's model at the middle of its sizes. */
function build(s: Style, k: Kind): { node: NodeDef; triangles: number } {
  const b = new Builder();
  const f = (k.frontage[0] + k.frontage[1]) / 2;
  const d = (k.depth[0] + k.depth[1]) / 2;
  if (k.prop === true && k.stands === 'hamlet') {
    // A hamlet's well, dry: its stone ring, its frame long gone.
    b.prism(0, 0, 0, 0.7, f / 2, f / 2, 8, hex(s.stoneColour), PART.stone);
  } else if (k.prop === true) {
    prop(b, s, k, f, d);
  } else {
    switch (k.stands) {
      case 'above':
        church(b, s, k, f, d);
        break;
      case 'summit':
        windmill(b, s, k, f);
        break;
      case 'slope':
      case 'water':
      case 'shore':
        shed(b, s, k, f, d);
        break;
      case 'behind':
        flake(b, s, f, d);
        break;
      case 'slip':
        slip(b, s, k, f, d);
        break;
      case 'hamlet':
      case 'chapel':
      case 'beacon':
        ruin(b, s, k, f, d);
        break;
      default:
        house(b, s, k, f, d);
    }
  }
  const p = b.m.primitive({ colors: true, uvs2: true });
  return {
    node: { name: k.id, extras: { frontage: f, depth: d, storeys: k.storeys[1] }, primitives: [p] },
    triangles: b.m.indices.length / 3,
  };
}

/** Builds the kit whose model is at the art path given, every kind of the catalog's, and reports its triangles. */
export function buildKit(model: string, style: Style): void {
  const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
    world: { towns: { buildings: Kind[]; kits: { biome: string; art: { model: string } }[] } };
  };
  const kit = catalog.world.towns.kits.find((k) => k.art.model === model);
  if (kit === undefined) {
    throw new Error(`no kit in the catalog has the model ${model}`);
  }
  const biome = kit.biome;
  const nodes: NodeDef[] = [];
  const counts: string[] = [];
  for (const k of catalog.world.towns.buildings) {
    const { node, triangles } = build(style, k);
    nodes.push(node);
    counts.push(`${k.id} ${triangles}`);
  }
  // One material: the page makes its own from the vertices' colours and parts.
  const materials: MaterialDef[] = [
    { name: 'town', color: [1, 1, 1], roughness: 0.9, metalness: 0 },
  ];
  const raw = writeGlb([{ name: 'kit', children: nodes }], materials);
  mkdirSync('.dev/art', { recursive: true });
  writeFileSync(`.dev/art/town-${biome}.raw.glb`, raw);
  execFileSync(
    'client/node_modules/.bin/gltfpack',
    [
      '-i',
      `.dev/art/town-${biome}.raw.glb`,
      '-o',
      `art/${kit.art.model}`,
      '-c',
      '-kn',
      '-km',
      '-kv',
      '-ke',
      '-noq',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write(`wrote art/${kit.art.model}: ${counts.join(', ')}\n`);
}

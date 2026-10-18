// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The islands' plants: one model for each kind of plant the catalog lists,
// built in its form at the middle of its sizes, real size (its height grown
// and its crown's width, m), and a far model of a few triangles, each of
// them faceted and opaque, as the tile style draws the land. The page
// scales each plant to its own size and sways it in the wind on the GPU:
// each vertex's first texture coordinate is how much it bends with the
// whole plant (0 at the ground, 1 at its top) and whether it is leaf,
// which moves on its own; its colour the part's, shaded.
//
// The forms: a palm, its trunk leaning and curved, its fronds folded
// strips; a broadleaf tree, clumps of crown on a trunk (holm oak,
// mahogany, sea grape); an umbrella pine, its flat crown on a bare trunk;
// a columnar cypress; a conifer of stacked cones (juniper); krummholz,
// the tuckamore, low, wind-pruned and lopsided; a shrub of a few clumps;
// a tuft of grass blades; a mangrove, its crown on arching prop roots.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { MeshBuilder, srgb, type Vec3 } from '../../lib/mesh.ts';

/** A kind of plant, as the catalog gives it. */
interface Kind {
  id: string;
  form: string;
  height: [number, number];
  crown: [number, number];
  trunk: string;
  leaf: string;
}

const hex = (c: string): Vec3 => {
  const n = Number.parseInt(c.slice(1), 16);
  return srgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const shade = (c: Vec3, f: number): Vec3 => [c[0] * f, c[1] * f, c[2] * f];

/** A small generator of a plant's own numbers, the same on every build. */
function numbers(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** A plant's builder: flat faces, each vertex with its bend and leafiness. */
class Plant {
  readonly m = new MeshBuilder('plants');
  readonly height: number;
  constructor(height: number) {
    this.height = height;
  }

  /** How much a point bends with the plant: none at the ground, all at its top. */
  bend(p: Vec3): number {
    return Math.min(Math.max(p[1] / this.height, 0), 1.2) ** 1.6;
  }

  /** A flat triangle, its front facing out from inside. */
  tri(a: Vec3, b: Vec3, c: Vec3, colour: Vec3, leaf: boolean, inside?: Vec3): void {
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let [p, q, r] = [a, b, c];
    if (inside !== undefined) {
      const m: Vec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      const out: Vec3 = [m[0] - inside[0], m[1] - inside[1], m[2] - inside[2]];
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
        [q, r] = [r, q];
        n = [-n[0], -n[1], -n[2]];
      }
    }
    const k = [p, q, r].map((pt) => {
      const i = this.m.vertex(pt, colour, [this.bend(pt), leaf ? 1 : 0]);
      this.m.normal(i, n);
      return i;
    });
    this.m.tri(k[0] as number, k[1] as number, k[2] as number);
  }

  /** A trunk: a tapering prism of n sides from a to b, its radii r0 and r1. */
  trunk(a: Vec3, b: Vec3, r0: number, r1: number, n: number, colour: Vec3): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI;
      const a1 = ((k + 1) / n) * 2 * Math.PI;
      const p = (c: Vec3, r: number, t: number): Vec3 => [
        c[0] + r * Math.sin(t),
        c[1],
        c[2] + r * Math.cos(t),
      ];
      const f = shade(colour, 0.85 + 0.15 * Math.cos(a0));
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      this.tri(p(a, r0, a0), p(a, r0, a1), p(b, r1, a1), f, false, mid);
      this.tri(p(a, r0, a0), p(b, r1, a1), p(b, r1, a0), f, false, mid);
    }
  }

  /** A clump of crown: an icosahedron about c of radii r, its corners jittered. */
  clump(c: Vec3, r: Vec3, colour: Vec3, rnd: () => number, jitter = 0.18): void {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw: Vec3[] = [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ];
    const pts = raw.map((p) => {
      const l = Math.hypot(p[0], p[1], p[2]);
      const j = 1 + jitter * (rnd() * 2 - 1);
      return [
        c[0] + (p[0] / l) * r[0] * j,
        c[1] + (p[1] / l) * r[1] * j,
        c[2] + (p[2] / l) * r[2] * j,
      ] as Vec3;
    });
    const faces = [
      [0, 11, 5],
      [0, 5, 1],
      [0, 1, 7],
      [0, 7, 10],
      [0, 10, 11],
      [1, 5, 9],
      [5, 11, 4],
      [11, 10, 2],
      [10, 7, 6],
      [7, 1, 8],
      [3, 9, 4],
      [3, 4, 2],
      [3, 2, 6],
      [3, 6, 8],
      [3, 8, 9],
      [4, 9, 5],
      [2, 4, 11],
      [6, 2, 10],
      [8, 6, 7],
      [9, 8, 1],
    ];
    for (const [a, b, d] of faces) {
      const pa = pts[a as number] as Vec3;
      const pb = pts[b as number] as Vec3;
      const pd = pts[d as number] as Vec3;
      // Lit from above: the lower faces darker.
      const up = (pa[1] + pb[1] + pd[1]) / 3 - c[1];
      this.tri(
        pa,
        pb,
        pd,
        shade(colour, 0.82 + 0.18 * Math.sign(up) * Math.min(Math.abs(up) / r[1], 1)),
        true,
        c,
      );
    }
  }

  /** An octahedron about c of radii r: a far crown. */
  octa(c: Vec3, r: Vec3, colour: Vec3, leaf = true): void {
    const x: Vec3[] = [
      [c[0] + r[0], c[1], c[2]],
      [c[0], c[1], c[2] + r[2]],
      [c[0] - r[0], c[1], c[2]],
      [c[0], c[1], c[2] - r[2]],
    ];
    const top: Vec3 = [c[0], c[1] + r[1], c[2]];
    const foot: Vec3 = [c[0], c[1] - r[1], c[2]];
    for (let k = 0; k < 4; k++) {
      const a = x[k] as Vec3;
      const b = x[(k + 1) % 4] as Vec3;
      this.tri(a, b, top, colour, leaf, c);
      this.tri(a, b, foot, shade(colour, 0.78), leaf, c);
    }
  }

  /**
   * A far tree: a ring of five corners of radius r at ringY, an apex above
   * at topY, and below a dark spindle to the ground, which reads as its
   * trunk and its shade: ten faces.
   */
  farCrown(ringY: number, topY: number, r: number, leaf: Vec3, trunk: Vec3): void {
    const ring: Vec3[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * 2 * Math.PI;
      ring.push([r * Math.sin(a), ringY, r * Math.cos(a)]);
    }
    const centre: Vec3 = [0, ringY, 0];
    for (let k = 0; k < 5; k++) {
      const a = ring[k] as Vec3;
      const b = ring[(k + 1) % 5] as Vec3;
      this.tri(a, b, [0, topY, 0], shade(leaf, 0.95 + 0.1 * Math.cos(k)), true, centre);
      this.tri(a, b, [0, 0, 0], shade(leaf, 0.55), false, centre);
    }
    void trunk;
  }

  /** A cone of n sides over a ring of radius r at y0 to its point at y1, about (x, z). */
  cone(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r: number,
    n: number,
    colour: Vec3,
    leaf: boolean,
  ): void {
    const centre: Vec3 = [x, (y0 + y1) / 2, z];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI;
      const a1 = ((k + 1) / n) * 2 * Math.PI;
      const p0: Vec3 = [x + r * Math.sin(a0), y0, z + r * Math.cos(a0)];
      const p1: Vec3 = [x + r * Math.sin(a1), y0, z + r * Math.cos(a1)];
      this.tri(p0, p1, [x, y1, z], shade(colour, 0.85 + 0.15 * Math.cos(a0)), leaf, centre);
      this.tri(p0, p1, [x, y0 - r * 0.15, z], shade(colour, 0.7), leaf, centre);
    }
  }

  /** A blade or a frond: a strip from a along its curve, folded along its rib, w wide. */
  frond(points: Vec3[], w: number, colour: Vec3): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as Vec3;
      const b = points[i + 1] as Vec3;
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const l = Math.hypot(dx, dz) || 1;
      // Across the rib, level; the fold drops each half a little.
      const sx = (-dz / l) * w;
      const sz = (dx / l) * w;
      const t = 1 - i / (points.length - 1);
      const fold = 0.25 * w;
      const la: Vec3 = [a[0] + sx * t, a[1] - fold, a[2] + sz * t];
      const ra: Vec3 = [a[0] - sx * t, a[1] - fold, a[2] - sz * t];
      const tb = 1 - (i + 1) / (points.length - 1);
      const lb: Vec3 = [b[0] + sx * tb, b[1] - fold, b[2] + sz * tb];
      const rb: Vec3 = [b[0] - sx * tb, b[1] - fold, b[2] - sz * tb];
      const c = shade(colour, 0.9 + 0.1 * t);
      this.tri(a, la, b, c, true);
      this.tri(la, lb, b, c, true);
      this.tri(a, b, ra, shade(c, 0.85), true);
      this.tri(ra, b, rb, shade(c, 0.85), true);
    }
  }

  get triangles(): number {
    return this.m.indices.length / 3;
  }
}

/** A plant's near and far models, built in its form. */
function build(k: Kind, seed: number): { near: Plant; far: Plant | null } {
  const h = (k.height[0] + k.height[1]) / 2;
  const c = (k.crown[0] + k.crown[1]) / 2;
  const trunk = hex(k.trunk);
  const leaf = hex(k.leaf);
  const rnd = numbers(seed);
  const near = new Plant(h);
  let far: Plant | null = new Plant(h);
  switch (k.form) {
    case 'palm': {
      // A trunk leaning and curving up; seven fronds arching from its head.
      const lean = 0.08 * h;
      const pts: Vec3[] = [0, 0.33, 0.66, 1].map((t) => [lean * t * t, t * h * 0.94, 0]);
      for (let i = 0; i + 1 < pts.length; i++) {
        near.trunk(pts[i] as Vec3, pts[i + 1] as Vec3, 0.22 - 0.04 * i, 0.18 - 0.04 * i, 5, trunk);
      }
      const head = pts[pts.length - 1] as Vec3;
      const reach = c / 2;
      for (let f = 0; f < 7; f++) {
        const a = (f / 7) * 2 * Math.PI + rnd() * 0.4;
        const sa = Math.sin(a);
        const ca = Math.cos(a);
        const curve: Vec3[] = [0, 0.4, 0.75, 1].map((t) => [
          head[0] + sa * reach * t,
          head[1] + reach * (0.35 * t - 0.75 * t * t),
          head[2] + ca * reach * t,
        ]);
        near.frond(curve, 0.55, shade(leaf, 0.9 + 0.2 * rnd()));
      }
      far.trunk([0, 0, 0], head, 0.22, 0.16, 2, trunk);
      far.octa([head[0], head[1] - 0.6, head[2]], [reach * 0.9, 0.9, reach * 0.9], leaf);
      break;
    }
    case 'broadleaf': {
      // A short trunk and three clumps of crown, wider than tall.
      const base = h * 0.35;
      near.trunk([0, 0, 0], [0, base + 0.2 * h, 0], 0.05 * c, 0.035 * c, 5, trunk);
      const ry = (h - base) / 2;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * 2 * Math.PI + rnd();
        const off = c * 0.18;
        near.clump(
          [Math.sin(a) * off, base + ry * (0.9 + 0.2 * rnd()), Math.cos(a) * off],
          [c * 0.34, ry * 0.85, c * 0.34],
          shade(leaf, 0.9 + 0.2 * rnd()),
          rnd,
        );
      }
      far.farCrown(base + ry * 0.8, h, c / 2, leaf, trunk);
      break;
    }
    case 'umbrella': {
      // A tall bare trunk, forking, under a flat spreading crown.
      const base = h * 0.62;
      near.trunk([0, 0, 0], [0.3, base, 0], 0.035 * c, 0.025 * c, 5, trunk);
      const ry = (h - base) / 2;
      near.clump([0.3, base + ry, 0], [c / 2, ry * 0.7, c / 2], leaf, rnd, 0.12);
      near.clump(
        [0.8, base + ry * 1.3, 0.4],
        [c * 0.3, ry * 0.55, c * 0.3],
        shade(leaf, 1.08),
        rnd,
        0.12,
      );
      far.farCrown(base + ry * 0.7, h, c / 2, leaf, trunk);
      break;
    }
    case 'columnar': {
      // A cypress: a narrow spindle nearly to the ground.
      const r = c / 2;
      near.trunk([0, 0, 0], [0, h * 0.12, 0], r * 0.2, r * 0.18, 4, trunk);
      near.cone(0, 0, h * 0.42, h, r, 7, leaf, true);
      near.cone(0, 0, h * 0.42, h * 0.08, r * 0.95, 7, shade(leaf, 0.9), true);
      far.farCrown(h * 0.35, h, r, leaf, trunk);
      break;
    }
    case 'conifer': {
      // Three cones stacked, each smaller, on a short trunk.
      const r = c / 2;
      near.trunk([0, 0, 0], [0, h * 0.25, 0], r * 0.12, r * 0.08, 4, trunk);
      for (let i = 0; i < 3; i++) {
        const y0 = h * (0.15 + 0.25 * i);
        near.cone(
          0,
          0,
          y0,
          y0 + h * 0.45,
          r * (1 - 0.25 * i),
          6,
          shade(leaf, 0.92 + 0.06 * i),
          true,
        );
      }
      far.farCrown(h * 0.3, h, r, leaf, trunk);
      break;
    }
    case 'krummholz': {
      // Tuckamore: low, matted, pruned by the wind to lean one way.
      near.clump([0, h * 0.45, 0], [c * 0.5, h * 0.45, c * 0.36], leaf, rnd, 0.25);
      near.clump(
        [c * 0.28, h * 0.3, 0.2],
        [c * 0.32, h * 0.3, c * 0.3],
        shade(leaf, 0.9),
        rnd,
        0.25,
      );
      far = null;
      break;
    }
    case 'shrub': {
      // A shrub of three clumps about its root.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * 2 * Math.PI + rnd();
        near.clump(
          [Math.sin(a) * c * 0.2, h * (0.4 + 0.15 * rnd()), Math.cos(a) * c * 0.2],
          [c * 0.32, h * 0.42, c * 0.32],
          shade(leaf, 0.88 + 0.24 * rnd()),
          rnd,
          0.22,
        );
      }
      far = null;
      break;
    }
    case 'tuft': {
      // Blades of grass fanning from a clump, bowed.
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 2 * Math.PI + rnd() * 0.5;
        const lean = c * (0.25 + 0.25 * rnd());
        const blade: Vec3[] = [0, 0.5, 1].map((t) => [
          Math.sin(a) * lean * t * t,
          h * t * (1 - 0.15 * t),
          Math.cos(a) * lean * t * t,
        ]);
        near.frond(blade, 0.05, shade(leaf, 0.85 + 0.3 * rnd()));
      }
      far = null;
      break;
    }
    case 'mangrove': {
      // A crown on a short trunk held up by arching prop roots.
      const base = h * 0.3;
      near.trunk([0, base * 0.6, 0], [0, base + h * 0.2, 0], 0.12, 0.09, 4, trunk);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 2 * Math.PI + rnd() * 0.5;
        const out = c * (0.28 + 0.1 * rnd());
        const foot: Vec3 = [Math.sin(a) * out, -0.3, Math.cos(a) * out];
        const knee: Vec3 = [Math.sin(a) * out * 0.6, base * 0.9, Math.cos(a) * out * 0.6];
        near.trunk(foot, knee, 0.05, 0.05, 3, trunk);
        near.trunk(knee, [0, base * 0.6, 0], 0.05, 0.07, 3, trunk);
      }
      const ry = (h - base) / 2;
      near.clump([0, base + ry, 0], [c / 2, ry * 0.8, c / 2], leaf, rnd);
      near.clump(
        [c * 0.2, base + ry * 1.2, -c * 0.1],
        [c * 0.3, ry * 0.6, c * 0.3],
        shade(leaf, 1.08),
        rnd,
      );
      far.farCrown(base + ry * 0.8, h, c / 2, leaf, trunk);
      break;
    }
    default:
      throw new Error(`no form ${k.form}`);
  }
  return { near, far };
}

/** Builds every kind of plant the catalog lists into the model at its art path, and reports each one's triangles. */
export function buildPlants(): void {
  const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
    world: { flora: { art: { model: string }; kinds: Kind[] } };
  };
  const flora = catalog.world.flora;
  const nodes: NodeDef[] = [];
  const counts: string[] = [];
  flora.kinds.forEach((k, i) => {
    const { near, far } = build(k, 7919 * (i + 1));
    const h = (k.height[0] + k.height[1]) / 2;
    const c = (k.crown[0] + k.crown[1]) / 2;
    const extras = { height: h, crown: c };
    nodes.push({ name: k.id, extras, primitives: [near.m.primitive({ colors: true })] });
    let line = `${k.id} ${near.triangles}`;
    if (far !== null) {
      nodes.push({ name: `${k.id}-far`, extras, primitives: [far.m.primitive({ colors: true })] });
      line += `/${far.triangles}`;
    }
    counts.push(line);
  });
  // One material: the page makes its own from the vertices' colours.
  const materials: MaterialDef[] = [
    { name: 'plants', color: [1, 1, 1], roughness: 0.95, metalness: 0, doubleSided: true },
  ];
  const raw = writeGlb([{ name: 'flora', children: nodes }], materials);
  mkdirSync('.dev/art', { recursive: true });
  writeFileSync('.dev/art/flora.raw.glb', raw);
  execFileSync(
    'client/node_modules/.bin/gltfpack',
    [
      '-i',
      '.dev/art/flora.raw.glb',
      '-o',
      `art/${flora.art.model}`,
      '-c',
      '-kn',
      '-km',
      '-kv',
      '-ke',
      '-noq',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write(`wrote art/${flora.art.model}: ${counts.join(', ')}\n`);
}

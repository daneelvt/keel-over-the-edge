// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The certificates' pendants, worn on a dark cord at the neck, each about
// three centimetres, struck in the period's metals:
//
// - anchor: a copper anchor, its ring, stock, shank, curved arms and
//   flukes;
// - wheel: a bronze ship's wheel, its rim, hub and eight spokes run out
//   to turned handles;
// - compass-rose: a silver compass rose, an eight-pointed star raised on a
//   disc, its north point up;
// - spyglass: a silver spyglass of three draws hung across the chest,
//   its objective end the wider, a little down to the wearer's right;
// - sunburst: a gold sunburst, sixteen rays long and short about a domed
//   boss.
//
// Each is a node of its name, hung from a bail (a small ring square to
// the face) through which the cord runs, the cord's two ends rising from
// it up and back toward the neck, so they pass under the clothes. Its
// origin is where the cord runs through the bail; x across (the wearer's
// left), y up, z out from the chest; its back, the bail's too, lies on
// z = 0. Its colours
// are in its vertices, and its second texture coordinate is each part's
// metalness and roughness (the metal's and the cord's), so one plain
// material draws every part. The catalog's certificates name their
// pendant's node (pendantNode) and the file (pendants.art.model).
//
//   node art/pendants/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type NodeDef, readGlbJson, writeGlb } from '../lib/gltf.ts';
import { add, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../lib/mesh.ts';

/** The model this script writes, as the catalog's pendants.art.model names it. */
const MODEL = 'pendants/pendants.glb';

const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
  pendants: { art: { model: string } };
  certificates: { pendantNode: string }[];
};
if (catalog.pendants.art.model !== MODEL) {
  throw new Error(`the catalog's pendants name ${catalog.pendants.art.model}, not ${MODEL}`);
}

/** The pendant's thickness, and its middle plane's place, m. */
const THICK = 0.0024;
const MID = THICK / 2;
/** The middle of a round pendant's face, below the bail. */
const FACE_Y = -0.0158;
/** How far the cord's ends rise above the bail, how far apart they lean, and how far back. */
const CORD_RISE = 0.028;
const CORD_SPLAY = 0.36;
const CORD_LEAN = 0.62;
const CORD_RADIUS = 0.00075;

/** The most triangles of a pendant with its cord and bail; and the most it may measure. */
const BUDGET = 480;
const MOST_HIGH = 0.032;
const MOST_ACROSS = 0.032;
const LEAST_ACROSS = 0.02;
const MOST_THICK = 0.0075;

/** Each metal's colour (sRGB display values), metalness and roughness. */
interface Metal {
  colour: Vec3;
  metal: number;
  rough: number;
}
const COPPER: Metal = { colour: srgb(0.78, 0.45, 0.27), metal: 0.85, rough: 0.38 };
const BRONZE: Metal = { colour: srgb(0.62, 0.45, 0.24), metal: 0.85, rough: 0.42 };
const SILVER: Metal = { colour: srgb(0.84, 0.85, 0.87), metal: 0.9, rough: 0.3 };
const GOLD: Metal = { colour: srgb(0.92, 0.72, 0.3), metal: 0.95, rough: 0.28 };
/** Silver blackened in its hollows, under a compass rose's star. */
const BLACKENED: Metal = { colour: srgb(0.3, 0.31, 0.34), metal: 0.8, rough: 0.45 };
const CORD: Metal = { colour: srgb(0.16, 0.12, 0.09), metal: 0, rough: 0.92 };

/** A builder of one pendant's parts, each vertex's metal in its second texture coordinate. */
class Part {
  readonly b = new MeshBuilder('pendant');
  readonly m: Metal;
  constructor(m: Metal) {
    this.m = m;
  }

  /** Paints every vertex added since from with this part's metal. */
  paint(from: number): void {
    for (let i = from; i < this.b.count; i++) {
      this.b.colors.splice(i * 3, 3, ...this.m.colour);
      this.b.uvs2.splice(i * 2, 2, this.m.metal, this.m.rough);
    }
  }

  tube(path: Vec3[], radii: number[], segments: number): void {
    const from = this.b.count;
    this.b.tube(path, radii, segments);
    this.paint(from);
  }

  /** A ring of radius r about centre in the plane of u and v, its wire's radius w. */
  ring(centre: Vec3, u: Vec3, v: Vec3, r: number, w: number, steps: number, segments = 4): void {
    const path: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      path.push(add(centre, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a)))));
    }
    this.tube(path, [w], segments);
  }

  /**
   * A flat slab, its outline (x, y, counter-clockwise, star-shaped about
   * its first point's centre) extruded from z0 to z1: a fan front and back,
   * square sides.
   */
  slab(centre: [number, number], outline: [number, number][], z0: number, z1: number): void {
    const from = this.b.count;
    const n = outline.length;
    for (const [z, nz] of [
      [z1, 1],
      [z0, -1],
    ] as [number, number][]) {
      const c = this.b.vertex([centre[0], centre[1], z]);
      this.b.normal(c, [0, 0, nz]);
      const ring = outline.map(([x, y]) => {
        const k = this.b.vertex([x, y, z]);
        this.b.normal(k, [0, 0, nz]);
        return k;
      });
      for (let i = 0; i < n; i++) {
        const a = ring[i] as number;
        const b = ring[(i + 1) % n] as number;
        if (nz > 0) {
          this.b.tri(c, a, b);
        } else {
          this.b.tri(c, b, a);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const [ax, ay] = outline[i] as [number, number];
      const [bx, by] = outline[(i + 1) % n] as [number, number];
      const out = normalize([by - ay, ax - bx, 0]);
      const k = [
        [ax, ay, z0],
        [bx, by, z0],
        [bx, by, z1],
        [ax, ay, z1],
      ].map((p) => {
        const q = this.b.vertex(p as Vec3);
        this.b.normal(q, out);
        return q;
      });
      this.b.quad(k[0] as number, k[1] as number, k[2] as number, k[3] as number);
    }
    this.paint(from);
  }

  /** A disc of radius r about centre, from z0 to z1. */
  disc(centre: [number, number], r: number, z0: number, z1: number, steps: number): void {
    const o: [number, number][] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      o.push([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]);
    }
    this.slab(centre, o, z0, z1);
  }
}

/** A star of points about centre: tips at radii (in turn) and valleys between at inner, the first tip up. */
function star(
  centre: [number, number],
  tips: number[],
  inner: number,
  count: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.PI / 2 + (i / count) * Math.PI * 2;
    const r = tips[i % tips.length] as number;
    out.push([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]);
    const b = a + Math.PI / count;
    out.push([centre[0] + inner * Math.cos(b), centre[1] + inner * Math.sin(b)]);
  }
  return out;
}

/** The bail, a small ring square to the face, and the cord through it, its ends rising to the neck. */
function bailAndCord(metal: Part, cord: Part): void {
  metal.ring([0, -0.0017, MID], [0, 1, 0], [0, 0, 1], 0.0016, 0.00045, 8, 3);
  for (const side of [1, -1]) {
    const path: Vec3[] = [];
    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Out and up, drawing in a little as it rises, and back toward the neck.
      const up = CORD_RISE * t;
      const out = side * CORD_RISE * CORD_SPLAY * (t - 0.18 * t * t);
      path.push([out, up, MID - CORD_LEAN * up]);
    }
    // Through the bail.
    path.unshift([-side * 0.001, -0.0002, MID]);
    cord.tube(path, [CORD_RADIUS], 3);
  }
}

function anchor(m: Part): void {
  const top = -0.0042;
  // The ring the anchor's cable would bend to, under the bail.
  m.ring([0, top - 0.0016, MID], [1, 0, 0], [0, 1, 0], 0.0017, 0.00055, 10);
  const shankTop = top - 0.0034;
  const crown = -0.0262;
  m.tube(
    [
      [0, shankTop, MID],
      [0, crown, MID],
    ],
    [0.0011, 0.0012],
    6,
  );
  // The stock, across near the top.
  const stockY = shankTop - 0.0024;
  m.tube(
    [
      [-0.0074, stockY, MID],
      [0, stockY, MID],
      [0.0074, stockY, MID],
    ],
    [0.0008, 0.001, 0.0008],
    6,
  );
  // The arms, curving up from the crown, and a fluke at each.
  const c: [number, number] = [0, -0.0168];
  const r = 0.0096;
  const arm: Vec3[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = ((200 + (i / 8) * 140) * Math.PI) / 180;
    arm.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), MID]);
  }
  m.tube(arm, [0.0009, 0.0011, 0.0012, 0.0012, 0.0012, 0.0012, 0.0012, 0.0011, 0.0009], 6);
  for (const side of [1, -1]) {
    const a = ((side > 0 ? 340 : 200) * Math.PI) / 180;
    const tip: [number, number] = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    // The fluke: a broad barb along the arm, its point up and out.
    const along = normalize([-Math.sin(a) * side, Math.cos(a) * side, 0]);
    const outward = normalize([Math.cos(a), Math.sin(a), 0]);
    const p = (s: number, o: number): [number, number] => [
      tip[0] + along[0] * s + outward[0] * o,
      tip[1] + along[1] * s + outward[1] * o,
    ];
    const outline = [p(0.0042, 0.0012), p(-0.0018, 0.0026), p(-0.0024, -0.0008), p(0.0004, -0.0012)];
    // Counter-clockwise on the face.
    const area = outline.reduce((s, [x, y], i) => {
      const [nx, ny] = outline[(i + 1) % outline.length] as [number, number];
      return s + x * ny - nx * y;
    }, 0);
    if (area < 0) {
      outline.reverse();
    }
    const cx = outline.reduce((s, q) => s + q[0], 0) / outline.length;
    const cy = outline.reduce((s, q) => s + q[1], 0) / outline.length;
    m.slab([cx, cy], outline, MID - 0.0007, MID + 0.0007);
  }
}

function wheel(m: Part): void {
  const c: Vec3 = [0, FACE_Y, MID];
  m.ring(c, [1, 0, 0], [0, 1, 0], 0.0082, 0.0009, 16);
  m.tube(
    [
      [0, FACE_Y, 0],
      [0, FACE_Y, THICK],
    ],
    [0.0022],
    8,
  );
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 2 + (i / 8) * Math.PI * 2;
    const d: Vec3 = [Math.cos(a), Math.sin(a), 0];
    m.tube(
      [add(c, scale(d, 0.0018)), add(c, scale(d, 0.0098)), add(c, scale(d, 0.0125))],
      [0.0005, 0.0006, 0.0009],
      4,
    );
  }
}

function compassRose(m: Part, other: (metal: Metal) => Part): void {
  // The disc, thin and blackened, with a raised rim; the star over it, thicker.
  other(BLACKENED).disc([0, FACE_Y], 0.0098, 0.0002, THICK * 0.7, 20);
  m.ring([0, FACE_Y, THICK * 0.7], [1, 0, 0], [0, 1, 0], 0.0096, 0.0005, 20);
  m.slab([0, FACE_Y], star([0, FACE_Y], [0.0128, 0.0075], 0.0026, 8), 0, THICK);
  m.disc([0, FACE_Y], 0.0016, THICK, THICK + 0.0005, 8);
}

function spyglass(m: Part): void {
  // Its axis across the chest, tilted down to the wearer's right (−x).
  const tilt = (-14 * Math.PI) / 180;
  const axis: Vec3 = [Math.cos(tilt), Math.sin(tilt), 0];
  const mid: Vec3 = [0, -0.0062, MID + 0.0008];
  const at = (s: number): Vec3 => add(mid, scale(axis, s));
  // From the eyepiece at −x to the objective at +x: the draws, each step
  // out to a band at the next's mouth.
  const stations: [number, number][] = [
    [-0.0145, 0.00216],
    [-0.0125, 0.00216],
    [-0.0122, 0.00176],
    [-0.0068, 0.00176],
    [-0.0066, 0.00243],
    [-0.006, 0.00243],
    [-0.0058, 0.00216],
    [0.0, 0.00216],
    [0.0002, 0.00283],
    [0.0008, 0.00283],
    [0.001, 0.00257],
    [0.0125, 0.00283],
    [0.0128, 0.00324],
    [0.0148, 0.00324],
  ];
  m.tube(
    stations.map(([s]) => at(s)),
    stations.map(([, r]) => r),
    8,
  );
  // The bail's ring clips round its middle.
  m.ring(at(0.0005), [0, 0, 1], normalize([-axis[1], axis[0], 0]), 0.0031, 0.0004, 10);
}

function sunburst(m: Part): void {
  m.slab([0, FACE_Y], star([0, FACE_Y], [0.0122, 0.0092], 0.0058, 16), 0, THICK * 0.8);
  // The boss, domed: two steps.
  m.disc([0, FACE_Y], 0.0052, THICK * 0.8, THICK * 1.15, 16);
  m.disc([0, FACE_Y], 0.0034, THICK * 1.15, THICK * 1.45, 12);
}

const PENDANTS: {
  name: string;
  metal: Metal;
  make: (m: Part, other: (metal: Metal) => Part) => void;
}[] = [
  { name: 'anchor', metal: COPPER, make: anchor },
  { name: 'wheel', metal: BRONZE, make: wheel },
  { name: 'compass-rose', metal: SILVER, make: compassRose },
  { name: 'spyglass', metal: SILVER, make: spyglass },
  { name: 'sunburst', metal: GOLD, make: sunburst },
];

const named = PENDANTS.map((p) => p.name);
for (const c of catalog.certificates) {
  if (!named.includes(c.pendantNode)) {
    throw new Error(`a certificate's pendant ${c.pendantNode} is not built here`);
  }
}

/** A pendant's node: its metal and its cord in one primitive; its extras its size. */
function node(p: (typeof PENDANTS)[number]): NodeDef {
  const metal = new Part(p.metal);
  const cord = new Part(CORD);
  bailAndCord(metal, cord);
  const others: Part[] = [];
  p.make(metal, (m) => {
    const o = new Part(m);
    others.push(o);
    return o;
  });
  for (const o of others) {
    metal.b.append(o.b);
  }
  // The pendant's size, without its cord.
  const pos = metal.b.positions;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] as number, pos[i + k] as number);
      hi[k] = Math.max(hi[k] as number, pos[i + k] as number);
    }
  }
  const size = sub(hi, lo);
  metal.b.append(cord.b);
  // Its back on z = 0: the cord too comes forward with it.
  for (let i = 2; i < metal.b.positions.length; i += 3) {
    metal.b.positions[i] = (metal.b.positions[i] as number) - lo[2];
  }
  const triangles = metal.b.indices.length / 3;
  const fail = (what: string): never => {
    throw new Error(`the ${p.name}: ${what}`);
  };
  if (triangles > BUDGET) {
    fail(`${triangles} triangles, over its ${BUDGET}`);
  }
  if (-lo[1] > MOST_HIGH || size[0] > MOST_ACROSS || size[0] < LEAST_ACROSS || size[2] > MOST_THICK) {
    fail(`it measures ${size.map((x) => (x * 1000).toFixed(1)).join(' × ')} mm`);
  }
  const r = (x: number): number => Math.round(x * 10000) / 10000;
  // No texture of its own: its first texture coordinate is left out.
  const { uvs: _uvs, ...primitive } = metal.b.primitive({ colors: true, uvs2: true });
  return {
    name: p.name,
    primitives: [primitive],
    extras: { across: r(size[0]), high: r(-lo[1]), thick: r(size[2]), triangles },
  };
}

const roots = PENDANTS.map(node);
mkdirSync('.dev/art', { recursive: true });
const raw = writeGlb(roots, [{ name: 'pendant', color: [1, 1, 1], roughness: 0.4, metalness: 0.8 }]);
writeFileSync('.dev/art/pendants.raw.glb', raw);
mkdirSync('art/pendants', { recursive: true });
execFileSync(
  'client/node_modules/.bin/gltfpack',
  ['-i', '.dev/art/pendants.raw.glb', '-o', `art/${MODEL}`, '-c', '-kn', '-km', '-kv', '-ke'],
  { stdio: 'inherit' },
);
const json = readGlbJson(readFileSync(`art/${MODEL}`)) as { nodes: { name: string }[] };
for (const p of PENDANTS) {
  if (!json.nodes.some((n) => n.name === p.name)) {
    throw new Error(`art/${MODEL} lost the ${p.name}`);
  }
}
for (const r of roots) {
  process.stdout.write(`${r.name}: ${JSON.stringify(r.extras)}\n`);
}
process.stdout.write(`wrote art/${MODEL}\n`);

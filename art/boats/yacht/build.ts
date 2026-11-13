// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The yacht: a cruising sloop of our time, of twelve metres, built by a
// shipwright of the period. Her form is the modern boat's: a long, light hull
// with a plumb bow, her greatest beam aft of amidships and a broad, flat
// stern; a fin keel with a bulb and two spade rudders; a coachroof, and a
// cockpit open to the stern with two wheels; a fractional rig with two pairs
// of spreaders and a backstay, a slab-reefed main on a boom and a genoa
// rolled on its stay. Her look is the period's: carvel planking, its
// topsides in the paint her sailor chooses, with a dark sheer strake, a
// cream boot top and a copper bottom; round bronze portlights; a laid deck;
// a varnished coachroof whose windows are small panes in lead cames with
// wooden dead-lights, glazed scuttles and a companion over the stair; an
// oiled-canvas tilt on ash laths; teak benches and a table with folding
// leaves; two spoked wheels on barrels before wooden binnacles with brass
// hoods; small timber capstans where her winches are; iron stanchions and
// pillars round her with two hemp lifelines; a spruce rig on oak
// cross-trees, tarred hemp shrouds set up with deadeyes; a flax main in its
// lazy bag and a flax genoa on a roller of pine; a copper-sheathed fin with
// a lead bulb, oak rudders, an ash bumkin with an iron anchor; a hinged stern
// door; brass lanterns with coloured glass on her pulpit and her stern.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: length and beam, the plan at the sheer, the canoe
// body's draught, the mast's place, the boom's height, the main's luff and
// foot, the genoa's luff, foot, tack and tack's height, the keel's and the
// rudders' places, spans and chords, the rudders' spread, the wheels'
// spread (the sailor's reach), the stance's height. The rest (sheer,
// profile, sections, the coachroof, the cockpit, the rigging) are this
// script's own, the 410's form as her drawings show it, estimates all.
//
// From the model the script also takes what the physics reads of her shape
// (it prints them, for the catalog): the canoe body's waterline beam,
// waterplane and its second moment; the heels at which the windward
// rudder's root and tip leave the water; and the sections and appendages
// tools/lever heels in still water for her righting lever (the hull's
// `lever` data).
//
// It builds the boat twice from the same lines: in full, and the far model,
// with few segments, no seams, cockpit fittings, rigging, lifelines,
// telltales, pennant, lanterns or fittings, a plain deck, and the wheels as
// discs. The catalog's art.model and art.far name them.
//
//   node art/boats/yacht/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PENNANT_WIDTH, pennant, STAFF_TOP, telltales } from '../../lib/fittings.ts';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { add, cross, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../../lib/mesh.ts';

/** The models this script writes, as the catalog's art.model and art.far name them. */
const MODEL = 'boats/yacht.glb';
const FAR_MODEL = 'boats/yacht.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along the hull: a multiple of ten, so the outline's points are among them. */
  stations: number;
  copperRows: number;
  strakes: number;
  seams: boolean;
  plankedDeck: boolean;
  deckStations: number;
  round: number;
  mastStations: number;
  sailRows: number;
  sailCols: number;
  jibRows: number;
  jibCols: number;
  /** Segments round a wheel's rim. */
  rim: number;
  /** Rigging, lifelines, telltales, pennant, lanterns, panes, the cockpit's and deck's fittings. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 60,
  copperRows: 6,
  strakes: 10,
  seams: true,
  plankedDeck: true,
  deckStations: 40,
  round: 12,
  mastStations: 12,
  sailRows: 24,
  sailCols: 10,
  jibRows: 20,
  jibCols: 7,
  rim: 28,
  small: true,
};

const FAR: Detail = {
  stations: 10,
  copperRows: 1,
  strakes: 2,
  seams: false,
  plankedDeck: false,
  deckStations: 10,
  round: 5,
  mastStations: 1,
  sailRows: 8,
  sailCols: 3,
  jibRows: 6,
  jibCols: 2,
  rim: 10,
  small: false,
};

/** The detail being built. */
let D = NEAR;

interface CatalogBoat {
  lengthOverall: number;
  beam: number;
  art: { model: string; far: string };
  physics: {
    hull: {
      displacement: number;
      hullDraught: number;
      centreOfGravity: number;
      outline: number[];
      transom: number;
      stem: number;
    };
    rig: {
      luff: number;
      foot: number;
      boomHeight: number;
      mastPosition: number;
      footStrip: number;
      headStrip: number;
      reefs: number[];
    };
    headsails: {
      headsailLuff: number;
      headsailFoot: number;
      headsailTackHeight: number;
      headsailTack: number;
    };
    foils: {
      boardSpan: number;
      boardChord: number;
      boardPosition: number;
      rudderSpan: number;
      rudderChord: number;
      rudderPosition: number;
    };
    sailor: { sailorSeatHeight: number; hikeReach: number; leeReach: number };
    hulls: { rudderSpread: number };
  };
}

const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
  boats: CatalogBoat[];
};
const boat = catalog.boats.find((b) => b.art.model === MODEL);
if (boat === undefined || boat.art.far !== FAR_MODEL) {
  throw new Error(`no boat in the catalog has the models ${MODEL} and ${FAR_MODEL}`);
}
const { hull, rig, headsails, foils, sailor } = boat.physics;
if (sailor.hikeReach !== sailor.leeReach) {
  throw new Error(
    'the sailor stands at a wheel either side: hikeReach and leeReach are its spread',
  );
}

// --- The hull's lines -------------------------------------------------------
//
// The boat's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bow is -z).

const L = boat.lengthOverall;
const HALF_BEAM = boat.beam / 2;
const TRANSOM_Z = hull.transom;
const BOW_Z = -hull.stem;

/** Station u runs from the transom (0) to the stem (1). */
const zAt = (u: number): number => TRANSOM_Z - u * L;
const uAt = (z: number): number => (TRANSOM_Z - z) / L;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Height of the sheer above the waterline: low aft over her broad stern, rising gently to a high, plumb bow. */
const sheer = (u: number): number => 1.02 + 0.16 * u + 0.22 * u ** 3;

/** Half the beam at the sheer: the catalog's outline, the plan the physics bumps hulls with. */
function halfBeam(u: number): number {
  const o = hull.outline;
  const x = Math.min(1, Math.max(0, u)) * (o.length - 1);
  const i = Math.min(o.length - 2, Math.floor(x));
  const f = x - i;
  return (o[i] ?? 0) * (1 - f) + (o[i + 1] ?? 0) * f;
}

/** Stations along the hull, from the transom (0) to the stem (1). */
const stations = (n = D.stations): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

/** How far the model's sheer, drawn straight between its stations, lies from the outline at most. */
function planDeviation(): number {
  const s = stations();
  let most = 0;
  for (let k = 0; k + 1 < s.length; k++) {
    const a = s[k] ?? 0;
    const b = s[k + 1] ?? 0;
    for (let j = 0; j <= 20; j++) {
      const u = a + ((b - a) * j) / 20;
      const drawn = halfBeam(a) + ((halfBeam(b) - halfBeam(a)) * j) / 20;
      most = Math.max(most, Math.abs(drawn - halfBeam(u)));
    }
  }
  return most;
}

/** Where the canoe body is deepest along the hull, and how far above the water its bottom is at the transom. */
const DEEPEST = 0.47;
const COUNTER = 0.05;

/**
 * Depth of the keel line below the waterline: the canoe body, deepest a
 * little aft of amidships, running out flat to the transom just clear of
 * the water, and forward in a long forefoot to a plumb stem.
 */
function keelDepth(u: number): number {
  const d = hull.hullDraught;
  if (u <= DEEPEST) {
    return d - (d + COUNTER) * ((DEEPEST - u) / DEEPEST) ** 2.2;
  }
  const t = (u - DEEPEST) / (1 - DEEPEST);
  return d * (1 - t ** 2.2) - sheer(1) * t ** 80;
}

/** The section's exponent: firm and flat-floored aft, rounder amidships, a vee forward. */
const sectionExponent = (u: number): number => (u < 0.5 ? 3.5 - 2 * u : 2.5 - 1.6 * (u - 0.5));

/** A point on the starboard half-section at station u, girth fraction g (0 at the keel, 1 at the sheer). */
function section(u: number, g: number): Vec3 {
  const a = (g * Math.PI) / 2;
  const e = 2 / sectionExponent(u);
  const d = keelDepth(u);
  return [halfBeam(u) * Math.sin(a) ** e, -d + (sheer(u) + d) * (1 - Math.cos(a) ** e), zAt(u)];
}

/** The hull's outward normal at u, g. */
function surfaceNormal(at: number, g: number): Vec3 {
  const u = Math.min(at, 0.998);
  const h = 1e-4;
  const alongG = sub(section(u, Math.min(1, g + h)), section(u, Math.max(0, g - h)));
  const alongU = sub(section(Math.min(1, u + h), g), section(Math.max(0, u - h), g));
  const n = normalize(cross(alongU, alongG));
  const out: Vec3 = [alongG[1], -alongG[0], 0];
  return n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0 ? scale(n, -1) : n;
}

/** The girth fraction at height y on the section at u: 0 below the bottom, 1 above the sheer. */
function girthAt(u: number, y: number): number {
  const d = keelDepth(u);
  const h = sheer(u) + d;
  if (h < 1e-6) {
    return 0;
  }
  const f = (y + d) / h;
  if (f <= 0) {
    return 0;
  }
  if (f >= 1) {
    return 1;
  }
  const n = sectionExponent(u);
  return (Math.acos((1 - f) ** (n / 2)) * 2) / Math.PI;
}

/** The hull's half-breadth at height y at station u (0 below its bottom). */
function breadthAt(u: number, y: number): number {
  const g = girthAt(u, y);
  return g <= 0 ? 0 : section(u, g)[0];
}

/** The height of the hull's bottom at x out from the centreline at station u. */
function bottomAt(u: number, x: number): number {
  const b = halfBeam(u);
  if (x >= b) {
    return sheer(u);
  }
  const e = 2 / sectionExponent(u);
  // x = b sin(a)^e: the girth's angle where the section is x out.
  const a = Math.asin(Math.min(1, (x / b) ** (1 / e)));
  const d = keelDepth(u);
  return -d + (sheer(u) + d) * (1 - Math.cos(a) ** e);
}

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'paint', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  // The topsides, in the paint the boat's sailor chooses.
  { name: 'topsides', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'copper', color: [1, 1, 1], roughness: 0.42, metalness: 0.75 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.5, metalness: 0 },
  { name: 'varnish', color: [1, 1, 1], roughness: 0.3, metalness: 0 },
  // Oak and lignum vitae, oiled: the capstans, blocks, cleats, windlass and anchor's stock.
  { name: 'oak', color: [1, 1, 1], roughness: 0.6, metalness: 0 },
  // The tilt's oiled canvas: nobody walks on it.
  { name: 'tilt', color: srgb(0.66, 0.6, 0.45), roughness: 0.7, metalness: 0, doubleSided: true },
  { name: 'spar', color: srgb(0.82, 0.63, 0.36), roughness: 0.35, metalness: 0 },
  { name: 'iron', color: srgb(0.17, 0.17, 0.18), roughness: 0.5, metalness: 0.6 },
  { name: 'flax', color: srgb(0.93, 0.89, 0.78), roughness: 0.85, metalness: 0, doubleSided: true },
  { name: 'bronze', color: srgb(0.74, 0.5, 0.24), roughness: 0.35, metalness: 0.9 },
  { name: 'rope', color: srgb(0.2, 0.15, 0.1), roughness: 0.9, metalness: 0 },
  { name: 'foil', color: srgb(0.5, 0.3, 0.14), roughness: 0.35, metalness: 0 },
  { name: 'lead', color: srgb(0.37, 0.39, 0.41), roughness: 0.55, metalness: 0.4 },
  {
    name: 'bunting',
    color: srgb(0.72, 0.12, 0.1),
    roughness: 0.8,
    metalness: 0,
    doubleSided: true,
  },
  { name: 'wool', color: [1, 1, 1], roughness: 0.9, metalness: 0, doubleSided: true },
  { name: 'brass', color: srgb(0.8, 0.62, 0.26), roughness: 0.3, metalness: 0.9 },
  { name: 'glass', color: [1, 1, 1], roughness: 0.15, metalness: 0 },
];

/** A fixed pseudo-random number in [0, 1) for an integer. */
const jitter = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
};

const shade = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

const TOPSIDES: Vec3 = [1, 1, 1];
const SHEER_STRAKE = srgb(0.165, 0.133, 0.106);
const BOOT = srgb(0.894, 0.851, 0.749);
const COPPER = srgb(0.69, 0.424, 0.25);
const VERDIGRIS = srgb(0.36, 0.52, 0.42);
const SHEER_FROM = 0.9;
const BOOT_FROM = 0.02;
const BOOT_TO = 0.1;
const MAHOGANY = srgb(0.5, 0.25, 0.13);
const DECK = srgb(0.86, 0.76, 0.58);
const TEAK = srgb(0.72, 0.52, 0.32);
const VARNISH = srgb(0.55, 0.3, 0.15);
const OAK = srgb(0.52, 0.38, 0.22);
const LIGNUM = srgb(0.36, 0.27, 0.16);
const ASH = srgb(0.84, 0.74, 0.55);
const GLASS = srgb(0.1, 0.14, 0.17);
const WOOD = srgb(0.48, 0.28, 0.14);

// --- The planking ------------------------------------------------------------

/** A band of the hull between two girth curves, in rows; each vertex coloured by colour(row, station). */
function band(
  m: MeshBuilder,
  from: (u: number) => number,
  to: (u: number) => number,
  rows: number[],
  colour: (row: number, i: number) => Vec3,
): void {
  const grid: number[][] = rows.map(() => []);
  stations().forEach((u, i) => {
    const g0 = from(u);
    const g1 = to(u);
    rows.forEach((s, r) => {
      const g = g0 + (g1 - g0) * s;
      const k = m.vertex(section(u, g), colour(r, i), [s, u]);
      m.normal(k, surfaceNormal(u, g));
      (grid[r] as number[]).push(k);
    });
  });
  for (let r = 0; r + 1 < grid.length; r++) {
    m.strip(grid[r] as number[], grid[r + 1] as number[]);
  }
}

/** The hull's shell: the copper bottom; the boot top, sheer strake and transom in paint; the topsides between. */
function planking(): { copper: MeshBuilder; paint: MeshBuilder; topsides: MeshBuilder } {
  const copper = new MeshBuilder('copper');
  const paint = new MeshBuilder('paint');
  const topsides = new MeshBuilder('topsides');
  const bootFrom = (u: number): number => girthAt(u, BOOT_FROM);
  const bootTo = (u: number): number => girthAt(u, BOOT_TO);
  const side = new MeshBuilder('copper');
  const rows = Array.from({ length: D.copperRows + 1 }, (_, i) => i / D.copperRows);
  band(
    side,
    () => 0,
    bootFrom,
    rows,
    (r, i) => {
      const sheet = Math.floor((i * L) / D.stations / 1.2) * 7 + r;
      const tone = 0.88 + 0.2 * jitter(sheet + 300);
      return shade(mix(COPPER, VERDIGRIS, jitter(sheet + 700) > 0.85 ? 0.35 : 0), tone);
    },
  );
  copper.append(side);
  copper.append(side, true);

  const top = new MeshBuilder('paint');
  const sides = new MeshBuilder('topsides');
  band(top, bootFrom, bootTo, [0, 1], () => BOOT);
  const seam = D.seams ? [0, 0.08, 1] : [0, 1];
  const edge = (k: number): number => (k >= D.strakes ? 1 : (SHEER_FROM * k) / (D.strakes - 1));
  for (let k = 0; k < D.strakes; k++) {
    const f0 = edge(k);
    const f1 = edge(k + 1);
    const sheerStrake = k === D.strakes - 1;
    const base = sheerStrake ? SHEER_STRAKE : TOPSIDES;
    const tone = 0.94 + 0.12 * jitter(k + 40);
    band(
      sheerStrake ? top : sides,
      (u) => lerp(bootTo(u), 1, f0),
      (u) => lerp(bootTo(u), 1, f1),
      seam,
      (r) => shade(base, D.seams && r === 0 ? tone * 0.55 : tone),
    );
  }
  paint.append(top);
  paint.append(top, true);
  paint.append(transom());
  topsides.append(sides);
  topsides.append(sides, true);
  return { copper, paint, topsides };
}

/** The transom: varnished mahogany, flat across the hull's after end. */
function transom(): MeshBuilder {
  const m = new MeshBuilder('paint');
  const ring: number[] = [];
  const n = 2 * D.round;
  for (let i = 0; i <= n; i++) {
    const p = section(0, i / n);
    ring.push(m.vertex(p, MAHOGANY));
  }
  for (let i = n; i >= 0; i--) {
    const p = section(0, i / n);
    ring.push(m.vertex([-p[0], p[1], p[2]], MAHOGANY));
  }
  const mid = m.vertex([0, (sheer(0) - keelDepth(0)) / 2, TRANSOM_Z], MAHOGANY);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[i + 1] as number, [0, 0, 1]);
  }
  return m;
}

/** A rubbing strake along each side just below the sheer, varnished. */
function rubrails(m: MeshBuilder): void {
  const c = shade(MAHOGANY, 0.7);
  for (const s of [1, -1]) {
    const path: Vec3[] = stations(D.stations / 2)
      .filter((u) => u < 0.99)
      .map((u) => [s * (halfBeam(u) + 0.008), sheer(u) - 0.02, zAt(u)]);
    m.tube(path, [0.022], D.small ? 6 : 3, c);
  }
}

/** Round bronze portlights along the topsides, each with its glass, where the 410's long hull ports are. */
const PORTLIGHTS = [-3.6, -2.9, -1.0, -0.3, 0.4];

function portlights(): { bronze: MeshBuilder; glass: MeshBuilder } {
  const bronze = new MeshBuilder('bronze');
  const glass = new MeshBuilder('glass');
  for (const s of [1, -1]) {
    for (const z of PORTLIGHTS) {
      const u = uAt(z);
      const y = sheer(u) - 0.28;
      const g = girthAt(u, y);
      const p = section(u, g);
      const n = surfaceNormal(u, g);
      const out: Vec3 = [s * n[0], n[1], n[2]];
      const at: Vec3 = [s * p[0], p[1], p[2]];
      bronze.tube([add(at, scale(out, -0.005)), add(at, scale(out, 0.02))], [0.085], 12);
      glass.tube([add(at, scale(out, 0.012)), add(at, scale(out, 0.024))], [0.062], 12, GLASS);
    }
  }
  return { bronze, glass };
}

// --- The deck, the cockpit and the coachroof --------------------------------

const CROWN = 0.05;
/** The deck's height at (x, u). */
const deckY = (x: number, u: number): number => {
  const b = halfBeam(u);
  const t = b > 1e-6 ? Math.min(1, Math.abs(x) / b) : 1;
  return sheer(u) + CROWN * (1 - t * t) * (b / HALF_BEAM);
};
const deckAt = (x: number, z: number): number => deckY(x, uAt(z));

/** The coachroof: from forward of the mast to the companionway, where the cockpit begins. */
const HOUSE_FORE = -3.0;
const HOUSE_AFT = 0.15;
/** Its sides' height above the deck, aft and forward; how far they lean in; its roof's crown. */
const HOUSE_H_AFT = 0.4;
const HOUSE_H_FORE = 0.3;
const HOUSE_TUMBLE = 0.08;
const HOUSE_CROWN = 0.06;
/** How far aft its front leans at the roof. */
const HOUSE_RAKE = 0.25;
/** The coachroof's half-width at the deck at z: wide aft, narrowing forward. */
const houseWidth = (z: number): number => 1.35 - 0.4 * smoothstep(HOUSE_AFT, HOUSE_FORE, z);

/** The cockpit: open from the companionway to the stern door, between the side decks. */
const COCKPIT_FORE = HOUSE_AFT;
const SIDE_DECK = 0.4;
const cockpitHalf = (z: number): number => halfBeam(uAt(Math.min(z, TRANSOM_Z))) - SIDE_DECK;
/** The cockpit's sole, level from the companionway to the stern door. */
const SOLE = hull.centreOfGravity + sailor.sailorSeatHeight;
/** The benches along each side, their tops, and how far in from the cockpit's side they reach. */
const BENCH_FORE = 0.35;
const BENCH_AFT = 2.75;
const BENCH_TOP = SOLE + 0.42;
const BENCH_DEPTH = 0.46;
/** The table on the centreline between the benches, its leaves folded down. */
const TABLE_FORE = 0.75;
const TABLE_AFT = 2.35;
const TABLE_HALF = 0.28;
const TABLE_TOP = SOLE + 0.72;

/** The two wheels: their hubs, the stance aft of each, the rim's size. */
const WHEEL_SPREAD = sailor.hikeReach;
const WHEEL_RADIUS = 0.42;
const WHEEL_HANDLE = 0.09;
const WHEEL_SPOKES = 8;
const WHEEL_AHEAD = 0.55;
const WHEEL_UP = 1.05;
const STAND_Z = 4.3;
const WHEEL_Z = STAND_Z - WHEEL_AHEAD;
const WHEEL_Y = SOLE + WHEEL_UP;

/** The deck's planks run fore and aft. */
const PLANK = 0.11;

/** The roof of the coachroof at fraction a across (−1 port, 1 starboard), at z. */
function houseEdge(z: number): { x: number; y: number } {
  const t = (z - HOUSE_FORE) / (HOUSE_AFT - HOUSE_FORE);
  const h = lerp(HOUSE_H_FORE, HOUSE_H_AFT, Math.min(1, Math.max(0, t)));
  return { x: houseWidth(z) - HOUSE_TUMBLE, y: deckAt(0, z) + h };
}
const roofY = (x: number, z: number): number => {
  const e = houseEdge(z);
  const a = Math.min(1, Math.abs(x) / e.x);
  return e.y + HOUSE_CROWN * (1 - a * a);
};
/** Where the coachroof's front meets the roof, raked aft of its foot. */
const ROOF_FORE = HOUSE_FORE + HOUSE_RAKE;

/** Whether the deck between x0 and x1 at z is open: the cockpit, or under the coachroof. */
function open(x0: number, x1: number, z: number): boolean {
  const outer = Math.max(Math.abs(x0), Math.abs(x1));
  if (z > COCKPIT_FORE) {
    return outer <= cockpitHalf(z) + 1e-6;
  }
  return z > HOUSE_FORE && z < HOUSE_AFT && outer <= houseWidth(z) - 0.02;
}

function deckRows(): number[] {
  const us = [
    ...stations(D.deckStations),
    ...stations(10),
    ...[COCKPIT_FORE, HOUSE_FORE].map(uAt),
  ].sort((a, b) => a - b);
  return us.filter((u, i) => i === 0 || u - (us[i - 1] as number) > 1e-6);
}

/** The laid deck: planks fore and aft, each its own tone, its seams payed with pitch. */
function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const us = deckRows();
  const planks = Math.ceil(HALF_BEAM / PLANK - 0.5);
  for (let j = -planks; j <= planks; j++) {
    const x0 = (j - 0.5) * PLANK;
    const x1 = (j + 0.5) * PLANK;
    const tone = 0.88 + 0.22 * jitter(j + 50);
    const c = shade(DECK, tone);
    const seam = shade(c, 0.5);
    let prev: { row: number[]; z: number; in: boolean } | null = null;
    for (const u of us) {
      const b = halfBeam(u);
      const z = zAt(u);
      const inside = Math.min(x1, b) - Math.max(x0, -b) > 1e-4;
      const edge = x0 >= 0 ? b : -b;
      // A plank across the cockpit's side stops at it: the side deck ends
      // there, over the bench, not overhanging it.
      const c = z >= COCKPIT_FORE - 1e-6 ? cockpitHalf(z) : Number.POSITIVE_INFINITY;
      const lo = inside ? Math.max(x0, -b, x0 < c && x1 > c ? c : -b) : edge;
      const hi = inside ? Math.min(x1, b, x0 < -c && x1 > -c ? -c : b) : edge;
      const w = Math.min(0.006, (hi - lo) / 4);
      const xs = [lo, lo + w, hi - w, hi];
      const cs = [seam, c, c, seam];
      const row = xs.map((x, i) => m.vertex([x, deckY(x, u), z], cs[i] as Vec3, [x, u]));
      if (prev !== null && (prev.in || inside) && !open(x0, x1, (prev.z + z) / 2)) {
        m.strip(prev.row, row);
      }
      prev = { row, z, in: inside };
    }
  }
  return m;
}

/** A flat quad, its corners in order, facing n, in one colour. */
function quad(m: MeshBuilder, p: Vec3[], n: Vec3, c: Vec3): void {
  const k = p.map((q) => {
    const i = m.vertex(q, c);
    m.normal(i, n);
    return i;
  });
  m.triFacing(k[0] as number, k[1] as number, k[2] as number, n);
  m.triFacing(k[0] as number, k[2] as number, k[3] as number, n);
}

/** Stations along the cockpit, from its fore end to the transom. */
const cockpitZs = (n: number): number[] =>
  Array.from({ length: n + 1 }, (_, i) => lerp(COCKPIT_FORE, TRANSOM_Z, i / n));

/**
 * The cockpit: its sole laid fore and aft from the companionway to the
 * stern door; its sides down from the side decks; the teak benches along
 * them, their tops and fronts.
 */
function cockpit(m: MeshBuilder): void {
  const n = D.small ? 16 : 4;
  const zs = cockpitZs(n);
  // The sole, in boards, over the dark of their seams.
  const under: number[][] = [[], []];
  for (const z of zs) {
    const w = cockpitHalf(z);
    for (const [k, x] of [-w, w].entries()) {
      (under[k] as number[]).push(m.vertex([x, SOLE - 0.003, z], shade(TEAK, 0.35)));
    }
  }
  for (let k = 0; k < n; k++) {
    const [a, b] = under as [number[], number[]];
    m.triFacing(a[k] as number, a[k + 1] as number, b[k + 1] as number, [0, 1, 0]);
    m.triFacing(a[k] as number, b[k + 1] as number, b[k] as number, [0, 1, 0]);
  }
  const boards = 10;
  for (let i = 0; i < boards; i++) {
    const f0 = -1 + (2 * i) / boards;
    const f1 = -1 + (2 * (i + 1)) / boards;
    const c = shade(TEAK, 0.85 + 0.15 * jitter(i + 90));
    const lo: number[] = [];
    const hi: number[] = [];
    for (const z of zs) {
      const w = cockpitHalf(z);
      lo.push(m.vertex([f0 * w + 0.004, SOLE, z], c));
      hi.push(m.vertex([f1 * w - 0.004, SOLE, z], c));
    }
    for (let k = 0; k < n; k++) {
      m.triFacing(lo[k] as number, lo[k + 1] as number, hi[k + 1] as number, [0, 1, 0]);
      m.triFacing(lo[k] as number, hi[k + 1] as number, hi[k] as number, [0, 1, 0]);
    }
  }
  const sides = shade(DECK, 0.72);
  for (const s of [1, -1]) {
    // The side, from the sole up to the side deck's inner edge.
    for (let k = 0; k < n; k++) {
      const z0 = zs[k] as number;
      const z1 = zs[k + 1] as number;
      const a = cockpitHalf(z0);
      const b = cockpitHalf(z1);
      quad(
        m,
        [
          [s * a, SOLE, z0],
          [s * b, SOLE, z1],
          [s * b, deckAt(s * b, z1), z1],
          [s * a, deckAt(s * a, z0), z0],
        ],
        [-s, 0, 0],
        sides,
      );
    }
    // The bench: its top, laid in teak, and its front down to the sole.
    const bz = Array.from({ length: (D.small ? 8 : 2) + 1 }, (_, i) =>
      lerp(BENCH_FORE, BENCH_AFT, i / (D.small ? 8 : 2)),
    );
    for (let k = 0; k + 1 < bz.length; k++) {
      const z0 = bz[k] as number;
      const z1 = bz[k + 1] as number;
      const o0 = cockpitHalf(z0);
      const o1 = cockpitHalf(z1);
      const slats = D.small ? 4 : 1;
      for (let j = 0; j < slats; j++) {
        const f0 = j / slats;
        const f1 = (j + 1) / slats;
        const x = (o: number, f: number): number => s * (o - BENCH_DEPTH * f);
        const c = shade(TEAK, 0.9 + 0.12 * jitter(j + 30 + k));
        quad(
          m,
          [
            [x(o0, f0), BENCH_TOP, z0],
            [x(o1, f0), BENCH_TOP, z1],
            [x(o1, f1), BENCH_TOP, z1],
            [x(o0, f1), BENCH_TOP, z0],
          ],
          [0, 1, 0],
          c,
        );
      }
      quad(
        m,
        [
          [s * (o0 - BENCH_DEPTH), SOLE, z0],
          [s * (o1 - BENCH_DEPTH), SOLE, z1],
          [s * (o1 - BENCH_DEPTH), BENCH_TOP, z1],
          [s * (o0 - BENCH_DEPTH), BENCH_TOP, z0],
        ],
        [-s, 0, 0],
        shade(TEAK, 0.7),
      );
    }
    for (const z of [BENCH_FORE, BENCH_AFT]) {
      const o = cockpitHalf(z);
      quad(
        m,
        [
          [s * o, SOLE, z],
          [s * (o - BENCH_DEPTH), SOLE, z],
          [s * (o - BENCH_DEPTH), BENCH_TOP, z],
          [s * o, BENCH_TOP, z],
        ],
        [0, 0, z === BENCH_FORE ? -1 : 1],
        shade(TEAK, 0.65),
      );
    }
  }
}

/** The cockpit's table, solid and varnished, its two leaves folded down beside its foot. */
function table(m: MeshBuilder): void {
  const c = VARNISH;
  m.box([-TABLE_HALF, TABLE_TOP - 0.04, TABLE_FORE], [TABLE_HALF, TABLE_TOP, TABLE_AFT], c);
  m.box(
    [-0.08, SOLE, TABLE_FORE + 0.25],
    [0.08, TABLE_TOP - 0.04, TABLE_AFT - 0.25],
    shade(c, 0.8),
  );
  if (D.small) {
    for (const s of [1, -1]) {
      m.box(
        [s * TABLE_HALF - 0.015, TABLE_TOP - 0.42, TABLE_FORE + 0.05],
        [s * TABLE_HALF + 0.015, TABLE_TOP - 0.05, TABLE_AFT - 0.05],
        shade(c, 0.9),
      );
    }
  }
}

/**
 * The coachroof: varnished sides leaning in, a crowned roof laid in planks,
 * its front raked aft, its after end down to the sole with the companion in
 * it; two windows a side of small panes in lead cames, a wooden dead-light
 * hooked open beside each, and glazed scuttles on the roof.
 */
function coachroof(): {
  wood: MeshBuilder;
  roof: MeshBuilder;
  glass: MeshBuilder;
  lead: MeshBuilder;
  brass: MeshBuilder;
} {
  const wood = new MeshBuilder('varnish');
  const roof = new MeshBuilder('deck');
  const glass = new MeshBuilder('glass');
  const lead = new MeshBuilder('lead');
  const brass = new MeshBuilder('brass');
  const n = D.small ? 14 : 3;
  const across = D.small ? 12 : 2;
  const foot = (t: number, s: number): Vec3 => {
    const z = lerp(HOUSE_FORE, HOUSE_AFT, t);
    const w = houseWidth(z);
    return [s * w, deckAt(w, z), z];
  };
  const edge = (t: number, s: number): Vec3 => {
    const z = lerp(ROOF_FORE, HOUSE_AFT, t);
    const e = houseEdge(z);
    return [s * e.x, e.y, z];
  };
  // The sides.
  for (const s of [1, -1]) {
    const feet: number[] = [];
    const tops: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      feet.push(wood.vertex(foot(t, s), VARNISH));
      tops.push(wood.vertex(edge(t, s), VARNISH));
    }
    const out: Vec3 = [s, 0.2, 0];
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = [feet[i], feet[i + 1], tops[i + 1], tops[i]] as number[];
      wood.triFacing(a as number, b as number, c as number, out);
      wood.triFacing(a as number, c as number, d as number, out);
    }
  }
  // The roof, laid in planks fore and aft.
  const planks = D.small ? 12 : 1;
  for (let j = 0; j < planks; j++) {
    const a0 = -1 + (2 * j) / planks;
    const a1 = -1 + (2 * (j + 1)) / planks;
    const c = shade(DECK, 0.9 + 0.18 * jitter(j + 140));
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(ROOF_FORE, HOUSE_AFT, i / n);
      const e = houseEdge(z);
      const row: number[] = [];
      const steps = Math.max(1, Math.round(across / planks));
      for (let q = 0; q <= steps; q++) {
        const a = lerp(a0, a1, q / steps);
        const x = a * e.x;
        row.push(roof.vertex([x, roofY(x, z), z], q === 0 && D.seams ? shade(c, 0.55) : c, [x, z]));
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i++) {
      const r0 = rows[i] as number[];
      const r1 = rows[i + 1] as number[];
      for (let q = 0; q + 1 < r0.length; q++) {
        const [a, b, cc, d] = [r0[q], r0[q + 1], r1[q + 1], r1[q]] as number[];
        roof.triFacing(a as number, b as number, cc as number, [0, 1, 0]);
        roof.triFacing(a as number, cc as number, d as number, [0, 1, 0]);
      }
    }
  }
  // The front and the after end: a fan from the middle of the foot to the roof across.
  for (const [t, n3] of [
    [0, [0, 0.4, -1]],
    [1, [0, 0, 1]],
  ] as [number, Vec3][]) {
    const f = foot(t, 1);
    const z = t === 0 ? ROOF_FORE : HOUSE_AFT;
    const e = houseEdge(z);
    const bottom = t === 1 ? SOLE : f[1];
    const ring: Vec3[] = [
      [-f[0], bottom, f[2]],
      ...Array.from({ length: across + 1 }, (_, j): Vec3 => {
        const x = (-1 + (2 * j) / across) * e.x;
        return [x, roofY(x, z), z];
      }),
      [f[0], bottom, f[2]],
    ];
    const centre = wood.vertex([0, bottom, f[2]], VARNISH);
    wood.normal(centre, n3);
    const ks = ring.map((p) => {
      const k = wood.vertex(p, VARNISH);
      wood.normal(k, n3);
      return k;
    });
    for (let i = 0; i + 1 < ks.length; i++) {
      wood.triFacing(centre, ks[i] as number, ks[i + 1] as number, n3);
    }
  }
  if (!D.small) {
    return { wood, roof, glass, lead, brass };
  }
  // The companion: its doorway, dark, in the after end, the boards in it,
  // and the sliding hatch over it.
  const top = roofY(0, HOUSE_AFT);
  const dark = shade(VARNISH, 0.25);
  quad(
    wood,
    [
      [-0.3, SOLE + 0.15, HOUSE_AFT + 0.003],
      [0.3, SOLE + 0.15, HOUSE_AFT + 0.003],
      [0.3, top - 0.03, HOUSE_AFT + 0.003],
      [-0.3, top - 0.03, HOUSE_AFT + 0.003],
    ],
    [0, 0, 1],
    dark,
  );
  for (let b = 0; b < 3; b++) {
    const y0 = SOLE + 0.15 + b * 0.16;
    wood.box([-0.3, y0, HOUSE_AFT], [0.3, y0 + 0.15, HOUSE_AFT + 0.025], shade(VARNISH, 0.85));
  }
  wood.box(
    [-0.36, top, HOUSE_AFT - 0.7],
    [0.36, top + 0.06, HOUSE_AFT + 0.03],
    shade(VARNISH, 0.8),
  );
  for (const s of [1, -1]) {
    wood.box(
      [s * 0.4 - 0.025, top - 0.01, HOUSE_AFT - 1.2],
      [s * 0.4 + 0.025, top + 0.05, HOUSE_AFT],
      VARNISH,
    );
  }
  // The windows: two a side, each of small panes in lead cames in a
  // varnished frame, and a dead-light hooked open forward of it.
  for (const s of [1, -1]) {
    for (const [t0, t1] of [
      [0.2, 0.42],
      [0.5, 0.82],
    ] as [number, number][]) {
      const [h0, h1] = [0.25, 0.75];
      const on = (t: number, h: number, off: number): Vec3 => {
        const a = foot(t, s);
        const b = edge(t, s);
        const p: Vec3 = [lerp(a[0], b[0], h), lerp(a[1], b[1], h), lerp(a[2], b[2], h)];
        const along = sub(edge(t + 0.01, s), edge(t, s));
        const up = sub(b, a);
        const nn = normalize(cross(along, up));
        const outward = nn[0] * s > 0 ? nn : scale(nn, -1);
        return add(p, scale(outward, off));
      };
      const out: Vec3 = [s, 0.2, 0];
      quad(
        wood,
        [on(t0, h0, 0.006), on(t1, h0, 0.006), on(t1, h1, 0.006), on(t0, h1, 0.006)],
        out,
        shade(VARNISH, 0.7),
      );
      quad(
        glass,
        [
          on(t0 + 0.006, h0 + 0.1, 0.01),
          on(t1 - 0.006, h0 + 0.1, 0.01),
          on(t1 - 0.006, h1 - 0.1, 0.01),
          on(t0 + 0.006, h1 - 0.1, 0.01),
        ],
        out,
        GLASS,
      );
      // The cames: lead bars across and along, the panes small between them.
      const cols = Math.round((t1 - t0) / 0.04);
      for (let c = 1; c < cols; c++) {
        const t = lerp(t0, t1, c / cols);
        lead.tube([on(t, h0 + 0.1, 0.013), on(t, h1 - 0.1, 0.013)], [0.004], 3);
      }
      lead.tube([on(t0, (h0 + h1) / 2, 0.013), on(t1, (h0 + h1) / 2, 0.013)], [0.004], 3);
      // The dead-light, hinged at the window's forward edge, open against the side.
      const d0 = Math.max(0.02, t0 - (t1 - t0) * 0.55);
      quad(
        wood,
        [
          on(d0, h0 + 0.05, 0.03),
          on(t0 - 0.01, h0 + 0.05, 0.03),
          on(t0 - 0.01, h1 - 0.05, 0.03),
          on(d0, h1 - 0.05, 0.03),
        ],
        out,
        shade(WOOD, 0.9),
      );
      brass.tube([on(t0 - 0.012, h0 + 0.12, 0.02), on(t0 - 0.012, h1 - 0.12, 0.02)], [0.008], 4);
    }
  }
  // The scuttles on the roof: glazed lids in varnished frames on brass hinges.
  for (const [z0, z1] of [
    [-2.55, -2.0],
    [-0.95, -0.5],
  ] as [number, number][]) {
    const y = roofY(0, (z0 + z1) / 2);
    wood.box([-0.32, y - 0.02, z0], [0.32, y + 0.07, z1], shade(VARNISH, 0.9));
    quad(
      glass,
      [
        [-0.26, y + 0.071, z0 + 0.06],
        [0.26, y + 0.071, z0 + 0.06],
        [0.26, y + 0.071, z1 - 0.06],
        [-0.26, y + 0.071, z1 - 0.06],
      ],
      [0, 1, 0],
      GLASS,
    );
    lead.tube(
      [
        [0, y + 0.075, z0 + 0.06],
        [0, y + 0.075, z1 - 0.06],
      ],
      [0.005],
      3,
    );
    brass.box([-0.2, y + 0.06, z0 - 0.01], [0.2, y + 0.075, z0 + 0.02]);
  }
  return { wood, roof, glass, lead, brass };
}

/** The tilt over the companionway: oiled canvas on three bent ash laths, from the roof aft to the cockpit. */
const TILT_FORE = -0.55;
const TILT_AFT = HOUSE_AFT;
const TILT_HALF = 1.1;
const TILT_HEIGHT = 0.55;

function tilt(): { canvas: MeshBuilder; laths: MeshBuilder } {
  const canvas = new MeshBuilder('tilt');
  const laths = new MeshBuilder('spar');
  const arcs = D.small ? 14 : 4;
  const arch = (z: number, h: number, a: number): Vec3 => {
    const ang = a * Math.PI;
    const x = -TILT_HALF * Math.cos(ang);
    const base = roofY(x, Math.min(z, HOUSE_AFT - 0.01));
    return [x, base + h * Math.sin(ang) ** 0.7, z];
  };
  // The hoops: the forward one low, the after two at full height.
  const hoops: [number, number][] = [
    [TILT_FORE, 0.12],
    [(TILT_FORE + TILT_AFT) / 2, TILT_HEIGHT * 0.92],
    [TILT_AFT, TILT_HEIGHT],
  ];
  const rows = hoops.map(([z, h]) =>
    Array.from({ length: arcs + 1 }, (_, i) =>
      canvas.vertex(arch(z, h, i / arcs), [1, 1, 1], [i / arcs, z]),
    ),
  );
  for (let r = 0; r + 1 < rows.length; r++) {
    canvas.strip(rows[r] as number[], rows[r + 1] as number[]);
  }
  for (const [z, h] of hoops.slice(1)) {
    laths.tube(
      Array.from({ length: arcs + 1 }, (_, i) => arch(z + 0.01, h + 0.012, i / arcs)),
      [0.014],
      D.small ? 5 : 3,
      ASH,
    );
  }
  return { canvas, laths };
}

// --- Spars, rigging and sails ----------------------------------------------------

const MAST_Z = -rig.mastPosition;
/** The mast is stepped on the coachroof's roof. */
const mastFootY = roofY(0, MAST_Z);
const MAST_TOP = rig.boomHeight + rig.luff + 0.12;
const MAST_FOOT_R = 0.11;
const MAST_HEAD_R = 0.065;
const mastR = (y: number): number =>
  lerp(MAST_FOOT_R, MAST_HEAD_R, Math.max(0, (y - mastFootY) / (MAST_TOP - mastFootY)) ** 2);
/** The genoa's tack, on the furler's reel at the stem; and its head on the forestay. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];
/** The hounds, where the forestay and the cap shrouds meet the mast: I 15.11 m above the sheer. */
const HOUNDS = sheer(uAt(MAST_Z)) + 15.11;
const STAY_TOP: Vec3 = [0, HOUNDS, MAST_Z - mastR(HOUNDS)];
/** How far aft of the tack the genoa's head is, along the forestay. */
const RAKE = (headsails.headsailLuff * (STAY_TOP[2] - TACK[2])) / (STAY_TOP[1] - TACK[1]);
/** Two pairs of spreaders, swept aft: their heights and lengths. */
const SPREADERS: { y: number; length: number }[] = [
  { y: 6.4, length: 1.1 },
  { y: 11.4, length: 0.75 },
];
const SPREADER_SWEEP = (18 * Math.PI) / 180;
/** The shrouds' chainplates, inboard on the side decks by the coachroof: the caps' and the lowers'. */
const CHAIN_X = 1.48;
const CAP_Z = MAST_Z + 0.12;
const LOWER_Z = MAST_Z + 0.5;
const DEADEYE_UP = 0.36;
const DEADEYE_DOWN = 0.14;
const DEADEYE_R = 0.045;

const spreaderTip = (s: number, k: number): Vec3 => {
  const sp = SPREADERS[k] as { y: number; length: number };
  return [s * sp.length * Math.cos(SPREADER_SWEEP), sp.y, sp.length * Math.sin(SPREADER_SWEEP)];
};

/** An iron band round the mast at y. */
function ironBand(m: MeshBuilder, y: number): void {
  const r = mastR(y) + 0.006;
  m.tube(
    [
      [0, y - 0.035, 0],
      [0, y + 0.035, 0],
    ],
    [r],
    D.small ? 12 : 5,
  );
}

/** The mast, in its node's frame: varnished spruce, iron bands, oak cross-trees, and a truck at its head. */
function mast(): { spar: MeshBuilder; iron: MeshBuilder; timber: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const n = D.mastStations;
  const path: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= n; i++) {
    const y = mastFootY - 0.02 + (i / n) * (MAST_TOP - mastFootY + 0.02);
    path.push([0, y, 0]);
    radii.push(mastR(y));
  }
  spar.tube(path, radii, D.round);
  const iron = new MeshBuilder('iron');
  const timber = new MeshBuilder('oak');
  if (!D.small) {
    return { spar, iron, timber };
  }
  for (const y of [mastFootY + 0.15, ...SPREADERS.map((s) => s.y), HOUNDS, MAST_TOP - 0.08]) {
    ironBand(iron, y);
  }
  for (const [k, sp] of SPREADERS.entries()) {
    // The cross-trees, of oak, square across the mast, and the spreaders on them.
    timber.box(
      [-mastR(sp.y) - 0.05, sp.y - 0.04, -0.08],
      [mastR(sp.y) + 0.05, sp.y + 0.04, 0.08],
      OAK,
    );
    for (const s of [1, -1]) {
      spar.tube([[s * mastR(sp.y), sp.y, 0.02], spreaderTip(s, k)], [0.035, 0.022], 6);
    }
  }
  // The truck: a round cap of timber at the masthead, its sheaves' slots dark.
  timber.tube(
    [
      [0, MAST_TOP - 0.01, 0],
      [0, MAST_TOP + 0.07, 0],
    ],
    [MAST_HEAD_R + 0.03],
    10,
    OAK,
  );
  return { spar, iron, timber };
}

const deadeye = (s: number, z: number, up: number): Vec3 => [
  s * CHAIN_X,
  deckAt(CHAIN_X, z) + up,
  z,
];

/**
 * The standing rigging, in the boat's frame: the caps over both spreaders to
 * the hounds, the intermediates to the upper spreaders, the lowers to the
 * lower, each set up with a pair of deadeyes and a lanyard to an iron
 * chainplate on the side deck; the forestay from the stem's head to the
 * hounds, the genoa's roller of pine on it with the brass reel at its foot;
 * and the backstay from the masthead to the transom. Tarred hemp.
 */
function rigging(): {
  rope: MeshBuilder;
  iron: MeshBuilder;
  wood: MeshBuilder;
  brass: MeshBuilder;
  spar: MeshBuilder;
} {
  const rope = new MeshBuilder('rope');
  const iron = new MeshBuilder('iron');
  const wood = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  const spar = new MeshBuilder('spar');
  const R = 0.009;
  const sides = 4;
  const at = (p: Vec3): Vec3 => [p[0], p[1], p[2] + MAST_Z];
  const up = SPREADERS[1] as { y: number };
  const low = SPREADERS[0] as { y: number };
  for (const s of [1, -1]) {
    for (const [z, from] of [
      [CAP_Z, [[s * mastR(HOUNDS), HOUNDS, MAST_Z], at(spreaderTip(s, 1)), at(spreaderTip(s, 0))]],
      [CAP_Z + 0.06, [[s * mastR(up.y), up.y - 0.12, MAST_Z], at(spreaderTip(s, 0))]],
      [LOWER_Z, [[s * mastR(low.y), low.y - 0.15, MAST_Z]]],
    ] as [number, Vec3[]][]) {
      const upper = deadeye(s, z, DEADEYE_UP);
      const lower = deadeye(s, z, DEADEYE_DOWN);
      rope.tube([...from, add(upper, [0, DEADEYE_R, 0])], [R], sides);
      rope.tube([upper, lower], [0.005], sides);
      for (const p of [upper, lower]) {
        wood.tube(
          [
            [p[0] - 0.016, p[1], p[2]],
            [p[0] + 0.016, p[1], p[2]],
          ],
          [DEADEYE_R],
          8,
          shade(VARNISH, 0.45),
        );
      }
      // The chainplate, an iron strap up from the side deck to the lower deadeye.
      const footY = deckAt(CHAIN_X, z);
      iron.box(
        [s * CHAIN_X - 0.012, footY - 0.01, z - 0.022],
        [s * CHAIN_X + 0.012, lower[1] - DEADEYE_R, z + 0.022],
      );
    }
  }
  // The forestay, and the genoa's roller round it: glued yellow pine,
  // turned, from the reel at the tack to the head's swivel.
  rope.tube([TACK, STAY_TOP], [R], sides);
  const dir = normalize(sub(STAY_TOP, TACK));
  const head = add(TACK, scale(dir, headsails.headsailLuff / dir[1] + 0.15));
  spar.tube([add(TACK, scale(dir, 0.05)), head], [0.03, 0.022], 6);
  brass.tube([add(TACK, [0, -0.12, 0]), add(TACK, [0, 0.02, 0])], [0.085], 12);
  brass.tube([head, add(head, scale(dir, 0.12))], [0.03], 6);
  // The furling line, manila, from the reel aft along the deck.
  const reelSide: Vec3 = [0.09, TACK[1] - 0.05, TACK[2]];
  rope.tube(
    [reelSide, [0.6, deckAt(0.6, -4.8) + 0.03, -4.8], [1.1, deckAt(1.1, -2.6) + 0.03, -2.6]],
    [0.006],
    3,
  );
  // The backstay, to the transom's middle.
  rope.tube(
    [
      [0, MAST_TOP - 0.1, MAST_Z + mastR(MAST_TOP)],
      [0, sheer(0) + 0.1, TRANSOM_Z - 0.05],
    ],
    [R],
    sides,
  );
  iron.box([-0.025, sheer(0) - 0.2, TRANSOM_Z - 0.01], [0.025, sheer(0) + 0.1, TRANSOM_Z + 0.01]);
  // The stem's head iron at the tack.
  iron.box([-0.03, TACK[1] - 0.3, TACK[2] - 0.06], [0.03, TACK[1] - 0.1, TACK[2] + 0.06]);
  return { rope, iron, wood, brass, spar };
}

/** The boom's length beyond the main's foot. */
const BOOM_LENGTH = rig.foot + 0.25;

function boom(): { spar: MeshBuilder; iron: MeshBuilder; bag: MeshBuilder; rope: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.08],
      [0, 0, BOOM_LENGTH],
    ],
    [0.075, 0.06],
    D.small ? 10 : 4,
  );
  const iron = new MeshBuilder('iron');
  const bag = new MeshBuilder('flax');
  const rope = new MeshBuilder('rope');
  if (!D.small) {
    return { spar, iron, bag, rope };
  }
  for (const z of [0.15, 1.4, rig.foot + 0.05]) {
    iron.tube(
      [
        [0, 0, z - 0.03],
        [0, 0, z + 0.03],
      ],
      [0.08],
      10,
    );
  }
  // The lazy bag: flax canvas either side of the boom, a trough the main
  // falls into, open at the top along the foot.
  const n = 10;
  for (const s of [1, -1]) {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(0.25, rig.foot - 0.1, i / n);
      const h = 0.28 * Math.sin(Math.PI * Math.min(1, (i / n) * 1.15 + 0.08)) ** 0.5;
      lo.push(bag.vertex([s * 0.06, -0.04, z], [0.85, 0.82, 0.74]));
      hi.push(bag.vertex([s * 0.11, h, z], [0.85, 0.82, 0.74]));
    }
    bag.strip(lo, hi, s < 0);
    // The lazy jacks, hemp, up from the bag's edge.
    for (const z of [1.2, 2.8]) {
      rope.tube(
        [
          [s * 0.11, 0.2, z],
          [s * 0.05, 4.0, 1.4],
        ],
        [0.004],
        3,
      );
    }
  }
  return { spar, iron, bag, rope };
}

/** The kicking strap: a hemp tackle through wooden blocks from the boom down to the mast's foot. */
function vang(): { rope: MeshBuilder; timber: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const timber = new MeshBuilder('oak');
  const top: Vec3 = [0, -0.08, 1.0];
  const foot: Vec3 = [0, mastFootY + 0.18 - rig.boomHeight, 0.13];
  for (const dx of [-0.02, 0, 0.02]) {
    rope.tube([add(top, [dx, -0.08, 0]), add(foot, [dx, 0.08, 0])], [0.006], D.small ? 4 : 3);
  }
  if (D.small) {
    timber.box(add(top, [-0.035, -0.12, -0.05]), add(top, [0.035, 0, 0.05]), OAK);
    timber.box(add(foot, [-0.035, 0, -0.05]), add(foot, [0.035, 0.12, 0.05]), OAK);
  }
  return { rope, timber };
}

/** The main's roach, and its head's width at the headboard. */
const ROACH = 0.45;
const HEAD = 0.2;

const chordAt = (v: number): number =>
  rig.foot * (1 - v) + HEAD * v + ROACH * Math.sin(Math.PI * v) * (1 - v) ** 0.3;

const REEF_ROWS = rig.reefs.slice(1).map((share) => 1 - share);

/** The mainsail, flat in the centreline plane at rest: the luff up the mast's after face, the foot along the boom. */
function sail(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const vs = [
    ...Array.from({ length: D.sailRows + 1 }, (_, i) => i / D.sailRows),
    ...(D.small ? REEF_ROWS : []),
  ].sort((a, b) => a - b);
  const rows: number[][] = [];
  for (const v of vs.filter((v, i) => i === 0 || v - (vs[i - 1] as number) > 1e-6)) {
    const chord = chordAt(v);
    const row: number[] = [];
    for (let j = 0; j <= D.sailCols; j++) {
      const u = j / D.sailCols;
      const along = u * Math.max(chord, 0.01);
      const k = m.vertex(
        [0, 0.03 + v * rig.luff, 0.08 + along],
        [1, 1, 1],
        [along / rig.foot, v],
        [u, v],
      );
      m.normal(k, [1, 0, 0]);
      row.push(k);
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) {
    m.strip(rows[i] as number[], rows[i + 1] as number[], true);
  }
  return m;
}

const JIB_HEAD = 0.08;
const jibChord = (v: number): number => headsails.headsailFoot * (1 - v) + JIB_HEAD * v;

/** The genoa, flat in the centreline plane at rest, in its node's frame (at the tack). */
function jib(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= D.jibRows; i++) {
    const v = i / D.jibRows;
    const chord = jibChord(v);
    const row: number[] = [];
    for (let j = 0; j <= D.jibCols; j++) {
      const u = j / D.jibCols;
      const k = m.vertex(
        [0, v * headsails.headsailLuff, v * RAKE + u * chord],
        [1, 1, 1],
        [(u * chord) / headsails.headsailFoot, v],
        [u, v],
      );
      m.normal(k, [1, 0, 0]);
      row.push(k);
    }
    rows.push(row);
  }
  for (let i = 0; i < D.jibRows; i++) {
    m.strip(rows[i] as number[], rows[i + 1] as number[], true);
  }
  return m;
}

// --- Keel and rudders --------------------------------------------------------

/** A tapering foil: sections from the root down, each its height, its leading and trailing edges and its thickness. */
function foil(m: MeshBuilder, sections: { y: number; z0: number; z1: number; t: number }[]): void {
  const n = D.small ? 10 : 3;
  const rings = sections.map(({ y, z0, z1, t }) => {
    const out: number[] = [];
    for (let i = 0; i <= n * 2; i++) {
      const a = (i / (n * 2)) * 2 * Math.PI;
      const s = (1 - Math.cos(a)) / 2;
      const x = (t / 2) * Math.sin(a) * (1 - 0.6 * s);
      const k = m.vertex([x, y, z0 + s * (z1 - z0)]);
      m.normal(k, [Math.sin(a), 0, -Math.cos(a) * 0.4]);
      out.push(k);
    }
    return out;
  });
  for (let r = 0; r + 1 < rings.length; r++) {
    m.strip(rings[r + 1] as number[], rings[r] as number[], true);
  }
  const last = sections[sections.length - 1] as { y: number; z0: number; z1: number };
  const ring = rings[rings.length - 1] as number[];
  const centre = m.vertex([0, last.y, (last.z0 + last.z1) / 2]);
  m.normal(centre, [0, -1, 0]);
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(centre, ring[i] as number, ring[i + 1] as number, [0, -1, 0]);
  }
}

/** The bulb: its length, its greatest half-breadth, its height over its breadth, and how far aft of the fin's middle it reaches. */
const BULB_LENGTH = 2.1;
const BULB_R = 0.2;
const BULB_FLAT = 0.85;
const BULB_AFT = 0.35;
const keelBottom = (): number => -(hull.hullDraught + foils.boardSpan);
const BULB_Y = keelBottom() + BULB_R * BULB_FLAT;
/** The fin's root, in the keel node's frame: inside the canoe body. */
const keelRoot = (): number => -keelDepth(uAt(-foils.boardPosition)) + 0.05;
/** How far aft the fin's leading edge sweeps from its root to its tip. */
const KEEL_SWEEP = 0.38;
const KEEL_THICK = 0.13;

/** The fin keel, in its node's frame: sheathed in copper, its trailing edge upright, its leading edge raked aft. */
function keel(): MeshBuilder {
  const m = new MeshBuilder('copper');
  const c = foils.boardChord;
  const rows = D.small ? 5 : 1;
  const sections = Array.from({ length: rows + 1 }, (_, i) => {
    const f = i / rows;
    const z0 = -c / 2 + KEEL_SWEEP * f;
    return { y: lerp(keelRoot(), BULB_Y, f), z0, z1: c / 2, t: KEEL_THICK * (c / 2 - z0) };
  });
  foil(m, sections);
  for (let i = 0; i < m.count; i++) {
    const tone = 0.9 + 0.15 * jitter(Math.floor((m.positions[i * 3 + 1] ?? 0) * 3) + 900);
    m.colors.splice(i * 3, 3, COPPER[0] * tone, COPPER[1] * tone, COPPER[2] * tone);
  }
  return m;
}

const bulbShape = (s: number): number => s ** 0.45 * (1 - s) ** 0.9;
const BULB_FULLEST = 0.45 / 1.35;

/** The cast lead bulb, in the keel node's frame: a long torpedo reaching aft of the fin, an L as the 410's. */
function bulb(): MeshBuilder {
  const m = new MeshBuilder('lead');
  const rings = D.small ? 18 : 4;
  const seg = D.small ? 14 : 4;
  const z0 = BULB_AFT - BULB_LENGTH * 0.4;
  const path: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    path.push([0, 0, z0 + s * BULB_LENGTH]);
    radii.push(BULB_R * Math.max(0.02, bulbShape(s) / bulbShape(BULB_FULLEST)));
  }
  m.tube(path, radii, seg);
  for (let i = 0; i < m.count; i++) {
    const y = m.positions[i * 3 + 1] ?? 0;
    m.positions[i * 3 + 1] = BULB_Y + y * BULB_FLAT;
  }
  return m;
}

/** Each rudder's stock: the spread out from the centreline. */
const RUDDER_X = boat.physics.hulls.rudderSpread;
const RUDDER_U = uAt(foils.rudderPosition);
/** Where the hull's bottom is over each stock: the blade's root. */
const RUDDER_ROOT = bottomAt(RUDDER_U, RUDDER_X);
const RUDDER_TIP = -(hull.hullDraught + foils.rudderSpan);

/** A rudder in its stock's frame: an oak blade, sheathed in copper below, its stock of bronze up through the hull to the sole. */
function rudder(): { blade: MeshBuilder; bronze: MeshBuilder } {
  const m = new MeshBuilder('foil');
  const c = foils.rudderChord;
  const rows = D.small ? 3 : 1;
  foil(
    m,
    Array.from({ length: rows + 1 }, (_, i) => {
      const f = i / rows;
      const z0 = -0.1 + 0.05 * f;
      const z1 = z0 + lerp(c, c * 0.75, f);
      return { y: lerp(RUDDER_ROOT + 0.02, RUDDER_TIP, f), z0, z1, t: 0.11 * (z1 - z0) };
    }),
  );
  const bronze = new MeshBuilder('bronze');
  bronze.tube(
    [
      [0, RUDDER_ROOT - 0.05, 0],
      [0, SOLE - 0.05, 0],
    ],
    [0.03],
    D.small ? 8 : 3,
  );
  return { blade: m, bronze };
}

/** The tie bar below the sole joining the two rudders' arms, so they turn as one: drawn, unseen, as the tiller. */
const TIE_Y = SOLE - 0.12;
const TIE_ARM = 0.22;

function tieBar(): MeshBuilder {
  const m = new MeshBuilder('iron');
  m.tube(
    [
      [-RUDDER_X, 0, 0],
      [RUDDER_X, 0, 0],
    ],
    [0.018],
    D.small ? 6 : 3,
  );
  return m;
}

// --- The wheels --------------------------------------------------------------------
//
// Two wheels, one either side of the cockpit aft, each before its own stance:
// the helmsman stands aft of the windward one facing forward, its hub
// WHEEL_AHEAD ahead of the feet and WHEEL_UP above the sole; spoked, with
// turned handles beyond the rim, a barrel on the axle forward of the hub
// that winds the tiller ropes led below, and a wooden binnacle before it
// with its compass under a brass hood and a lamp beside it.

/** A wheel in its node's frame (the hub): the rim in the x-y plane, the spokes and handles, the hub and its barrel. */
function wheel(): { wood: MeshBuilder; brass: MeshBuilder; rope: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  const rope = new MeshBuilder('rope');
  const ring: Vec3[] = [];
  for (let i = 0; i <= D.rim; i++) {
    const a = (i / D.rim) * 2 * Math.PI;
    ring.push([WHEEL_RADIUS * Math.cos(a), WHEEL_RADIUS * Math.sin(a), 0]);
  }
  wood.tube(ring, [0.024], D.small ? 6 : 3, WOOD);
  for (let k = 0; k < WHEEL_SPOKES; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / WHEEL_SPOKES;
    const d: Vec3 = [Math.cos(a), Math.sin(a), 0];
    wood.tube(
      [scale(d, 0.07), scale(d, WHEEL_RADIUS), scale(d, WHEEL_RADIUS + 0.02)],
      [0.016, 0.013, 0.017],
      D.small ? 5 : 3,
      WOOD,
    );
    if (D.small) {
      wood.tube(
        [
          scale(d, WHEEL_RADIUS + 0.02),
          scale(d, WHEEL_RADIUS + 0.05),
          scale(d, WHEEL_RADIUS + 0.08),
          scale(d, WHEEL_RADIUS + WHEEL_HANDLE),
        ],
        [0.016, 0.021, 0.016, 0.009],
        6,
        shade(WOOD, 0.8),
      );
    }
  }
  wood.tube(
    [
      [0, 0, 0.05],
      [0, 0, -0.08],
    ],
    [0.075],
    D.small ? 10 : 4,
    WOOD,
  );
  if (D.small) {
    // The barrel, forward on the axle, its tiller ropes of untarred hemp
    // wound on it and led down through the sole.
    wood.tube(
      [
        [0, 0, -0.1],
        [0, 0, -0.32],
      ],
      [0.085],
      10,
      shade(WOOD, 0.85),
    );
    for (let t = 0; t < 4; t++) {
      const z = -0.13 - t * 0.05;
      rope.tube(
        Array.from({ length: 13 }, (_, i): Vec3 => {
          const a = (i / 12) * 2 * Math.PI;
          return [0.09 * Math.cos(a), 0.09 * Math.sin(a), z - (i / 12) * 0.05];
        }),
        [0.008],
        4,
        srgb(0.62, 0.52, 0.36),
      );
    }
    brass.tube(
      [
        [0, 0, 0.055],
        [0, 0, 0.075],
      ],
      [0.05],
      10,
    );
  }
  return { wood, brass, rope };
}

/** The far model's wheel: a disc of the rim's size, edge on. */
function wheelDisc(): MeshBuilder {
  const m = new MeshBuilder('varnish');
  m.tube(
    [
      [0, 0, 0.02],
      [0, 0, -0.02],
    ],
    [WHEEL_RADIUS + WHEEL_HANDLE * 0.5],
    D.rim,
    WOOD,
  );
  return m;
}

/** The binnacles: before each wheel, a wooden case up from the sole to the axle, a brass hood on it, its glass and lamp. */
function binnacles(): { wood: MeshBuilder; brass: MeshBuilder; glass: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const z = WHEEL_Z - 0.48;
  for (const s of [1, -1]) {
    const x = s * WHEEL_SPREAD;
    wood.box([x - 0.16, SOLE, z - 0.14], [x + 0.16, WHEEL_Y + 0.08, z + 0.17], shade(WOOD, 0.9));
    if (!D.small) {
      continue;
    }
    brass.tube(
      [
        [x, WHEEL_Y + 0.08, z],
        [x, WHEEL_Y + 0.2, z],
        [x, WHEEL_Y + 0.3, z],
      ],
      [0.15, 0.13, 0.03],
      12,
    );
    // The compass's window toward the helm, and the lamp's.
    quad(
      glass,
      [
        [x - 0.08, WHEEL_Y + 0.1, z + 0.172],
        [x + 0.08, WHEEL_Y + 0.1, z + 0.172],
        [x + 0.08, WHEEL_Y + 0.17, z + 0.12],
        [x - 0.08, WHEEL_Y + 0.17, z + 0.12],
      ],
      [0, 0.6, 1],
      srgb(0.7, 0.68, 0.55),
    );
    brass.tube(
      [
        [x + s * 0.2, WHEEL_Y - 0.05, z],
        [x + s * 0.2, WHEEL_Y + 0.08, z],
      ],
      [0.035],
      8,
    );
  }
  return { wood, brass, glass };
}

// --- Fittings on deck ------------------------------------------------------------

/** The capstans, where the 410's winches are: on the side decks forward of the wheels, and on the roof by the companion. */
const CAPSTANS: [number, number, number][] = [
  [cockpitHalf(3.15) + 0.17, 3.15, 1],
  [houseWidth(-0.25) - 0.32, -0.25, 0.8],
];

/** A small capstan at (x, z) on a surface at y: a lignum vitae drum on an oak barrel, an iron pawl ring, a bronze cap with its bar's socket. */
function capstan(
  m: { timber: MeshBuilder; iron: MeshBuilder; bronze: MeshBuilder },
  x: number,
  y: number,
  z: number,
  k: number,
): void {
  const h = 0.24 * k;
  const r = 0.085 * k;
  m.timber.tube(
    [
      [x, y, z],
      [x, y + 0.06 * k, z],
    ],
    [r * 1.35],
    D.small ? 10 : 4,
    OAK,
  );
  m.timber.tube(
    [
      [x, y + 0.06 * k, z],
      [x, y + 0.12 * k, z],
      [x, y + h - 0.03, z],
    ],
    [r, r * 0.82, r * 0.95],
    D.small ? 10 : 4,
    LIGNUM,
  );
  if (D.small) {
    m.iron.tube(
      [
        [x, y + 0.055 * k, z],
        [x, y + 0.075 * k, z],
      ],
      [r * 1.4],
      12,
    );
    m.bronze.tube(
      [
        [x, y + h - 0.03, z],
        [x, y + h, z],
      ],
      [r * 0.8],
      10,
    );
  }
}

/** The iron stanchions' stations along each side, the lifelines' heights above the deck. */
const STANCHIONS = [-4.4, -2.65, -1.25, 0.2, 1.75, 3.25];
const PULPIT_AFT = -4.75;
const PUSHPIT_FORE = 4.6;
const LIFELINES = [0.32, 0.62];
const STANCHION_IN = 0.04;
const edgeAt = (z: number): number => halfBeam(uAt(z)) - STANCHION_IN;

/**
 * The guardrails: iron stanchions on the deck's edge, the bent iron pulpit
 * round the bow and pushpit round the stern on iron legs, and two tarred
 * hemp lifelines between them, set up with lanyards.
 */
function guardrails(): { iron: MeshBuilder; rope: MeshBuilder } {
  const iron = new MeshBuilder('iron');
  const rope = new MeshBuilder('rope');
  const top = LIFELINES[1] as number;
  const r = 0.014;
  for (const s of [1, -1]) {
    for (const z of STANCHIONS) {
      const x = s * edgeAt(z);
      const y = deckAt(x, z);
      iron.tube(
        [
          [x, y, z],
          [x * 1.0, y + top + 0.02, z],
        ],
        [r, r * 0.8],
        6,
      );
      iron.tube(
        [
          [x, y, z],
          [x, y + 0.01, z],
        ],
        [0.03],
        6,
      );
    }
    // The lifelines, from the pulpit's after leg to the pushpit's forward one.
    for (const h of LIFELINES) {
      const pts: Vec3[] = [PULPIT_AFT, ...STANCHIONS, PUSHPIT_FORE].map(
        (z): Vec3 => [s * edgeAt(z), deckAt(edgeAt(z), z) + h, z],
      );
      rope.tube(pts, [0.006], 4);
    }
  }
  // The pulpit: from a leg each side round the stem, its rail at the upper line's height.
  const pulpit: Vec3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const z = lerp(PULPIT_AFT, BOW_Z + 0.25, Math.sin((t * Math.PI) / 2));
    const x = edgeAt(z) * Math.cos((t * Math.PI) / 2) ** 0.6;
    pulpit.push([x, deckAt(0, z) + top + 0.02, z]);
  }
  const both = [
    ...pulpit
      .slice()
      .reverse()
      .map((p): Vec3 => [-p[0], p[1], p[2]]),
    ...pulpit.slice(1),
  ];
  iron.tube(both, [0.016], 6);
  for (const s of [1, -1]) {
    for (const z of [PULPIT_AFT, BOW_Z + 0.9]) {
      const x = s * Math.min(edgeAt(z), edgeAt(PULPIT_AFT));
      const xx = z === PULPIT_AFT ? s * edgeAt(z) : x * 0.75;
      iron.tube(
        [
          [xx, deckAt(xx, z), z],
          [xx, deckAt(0, z) + top + 0.02, z],
        ],
        [0.015],
        6,
      );
    }
  }
  // The pushpit: a rail each side round the quarter to the stern door's posts.
  for (const s of [1, -1]) {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = lerp(PUSHPIT_FORE, TRANSOM_Z - 0.06, Math.sin((t * Math.PI) / 2));
      const x = lerp(edgeAt(z), 0.62, smoothstep(0.55, 1, t));
      pts.push([s * x, sheer(uAt(z)) + top + 0.04, z]);
    }
    iron.tube(pts, [0.016], 6);
    for (const p of [pts[0], pts[4], pts[8]] as Vec3[]) {
      iron.tube([[p[0], deckAt(p[0], p[2]), p[2]], p], [0.015], 6);
    }
  }
  return { iron, rope };
}

/** The bumkin, roller and anchor at the bow; the windlass on the foredeck. */
function groundTackle(): { spar: MeshBuilder; iron: MeshBuilder; timber: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const iron = new MeshBuilder('iron');
  const timber = new MeshBuilder('oak');
  const y = sheer(1) - 0.02;
  // The bumkin, ash, from the foredeck out over the stem.
  spar.box([-0.07, y, BOW_Z - 0.55], [0.07, y + 0.1, BOW_Z + 0.75], ASH);
  if (!D.small) {
    return { spar, iron, timber };
  }
  // The roller in its iron cheeks at the bumkin's end.
  for (const s of [1, -1]) {
    iron.box(
      [s * 0.075 - 0.008, y - 0.05, BOW_Z - 0.6],
      [s * 0.075 + 0.008, y + 0.14, BOW_Z - 0.38],
    );
  }
  timber.tube(
    [
      [-0.06, y + 0.06, BOW_Z - 0.5],
      [0.06, y + 0.06, BOW_Z - 0.5],
    ],
    [0.045],
    10,
    OAK,
  );
  // The anchor, stowed hanging from the roller: its iron shank, crown and
  // arms with their flukes, and its wooden stock square to the arms.
  const ring: Vec3 = [0, y + 0.06, BOW_Z - 0.52];
  const crown: Vec3 = [0, y - 0.62, BOW_Z - 0.6];
  iron.tube([ring, crown], [0.022], 6);
  for (const s of [1, -1]) {
    const arm: Vec3 = [s * 0.26, crown[1] + 0.2, crown[2] + 0.02];
    iron.tube([crown, add(crown, [s * 0.14, 0.04, 0]), arm], [0.02, 0.02, 0.016], 6);
    iron.box(add(arm, [-0.05, -0.02, -0.06]), add(arm, [0.05, 0.06, 0.02]));
  }
  timber.tube([add(ring, [0, -0.08, -0.33]), add(ring, [0, -0.08, 0.33])], [0.03, 0.03], 6, OAK);
  iron.tube(
    [
      [0, y + 0.08, BOW_Z - 0.45],
      [0, y + 0.1, BOW_Z + 0.7],
    ],
    [0.012],
    4,
  );
  // The windlass: a timber barrel across between two oak bitts, its iron pawls.
  const wz = BOW_Z + 1.25;
  const wy = deckAt(0, wz);
  for (const s of [1, -1]) {
    timber.box([s * 0.22 - 0.05, wy, wz - 0.07], [s * 0.22 + 0.05, wy + 0.32, wz + 0.07], OAK);
  }
  timber.tube(
    [
      [-0.17, wy + 0.2, wz],
      [0.17, wy + 0.2, wz],
    ],
    [0.09],
    10,
    LIGNUM,
  );
  iron.box([-0.03, wy + 0.25, wz - 0.12], [0.03, wy + 0.32, wz - 0.04]);
  return { spar, iron, timber };
}

/** The stern door: a hinged timber door across the cockpit's after end, drawn closed, and the hemp ladder stowed on it. */
function sternDoor(): { wood: MeshBuilder; iron: MeshBuilder; rope: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const iron = new MeshBuilder('iron');
  const rope = new MeshBuilder('rope');
  const w = Math.min(0.85, cockpitHalf(TRANSOM_Z) - 0.05);
  const z = TRANSOM_Z + 0.006;
  const boards = D.small ? 6 : 1;
  const top = sheer(0) - 0.04;
  for (let i = 0; i < boards; i++) {
    const y0 = lerp(SOLE - 0.08, top, i / boards);
    const y1 = lerp(SOLE - 0.08, top, (i + 1) / boards) - (D.small ? 0.006 : 0);
    quad(
      wood,
      [
        [-w, y0, z],
        [w, y0, z],
        [w, y1, z],
        [-w, y1, z],
      ],
      [0, 0, 1],
      shade(VARNISH, 0.92 + 0.12 * jitter(i + 300)),
    );
  }
  if (D.small) {
    for (const s of [1, -1]) {
      iron.box(
        [s * (w - 0.18) - 0.06, SOLE - 0.1, z],
        [s * (w - 0.18) + 0.06, SOLE - 0.02, z + 0.02],
      );
      // The ladder, hemp with wooden steps, hanging stowed on the door.
    }
    for (const s of [1, -1]) {
      rope.tube(
        [
          [s * 0.2, top - 0.05, z + 0.03],
          [s * 0.2, SOLE + 0.02, z + 0.03],
        ],
        [0.008],
        4,
      );
    }
    for (let k = 0; k < 3; k++) {
      const y = lerp(top - 0.12, SOLE + 0.08, k / 2);
      wood.box([-0.22, y - 0.02, z + 0.02], [0.22, y + 0.02, z + 0.05], OAK);
    }
  }
  return { wood, iron, rope };
}

/** Cleats of oak on the side decks and the foredeck, where she makes fast. */
function cleats(m: MeshBuilder): void {
  const cleat = (x: number, z: number): void => {
    const y = deckAt(x, z);
    m.box([x - 0.02, y - 0.005, z - 0.08], [x + 0.02, y + 0.04, z + 0.08], OAK);
    m.box([x - 0.016, y + 0.04, z - 0.13], [x + 0.016, y + 0.06, z + 0.13], OAK);
  };
  for (const s of [1, -1]) {
    cleat(s * (edgeAt(5.1) - 0.12), 5.1);
    cleat(s * (edgeAt(-5.2) - 0.18), -5.2);
    cleat(s * (edgeAt(0.9) - 0.15), 0.9);
  }
}

/** The mainsheet's bridle: iron eyes on the roof either side of the companionway, a hemp span between, a wooden block on it. */
const BRIDLE_Z = HOUSE_AFT - 0.12;
const BRIDLE_X = 0.8;
const BRIDLE_Y = roofY(0, BRIDLE_Z) + 0.12;

function bridle(): { iron: MeshBuilder; rope: MeshBuilder; timber: MeshBuilder } {
  const iron = new MeshBuilder('iron');
  const rope = new MeshBuilder('rope');
  const timber = new MeshBuilder('oak');
  for (const s of [1, -1]) {
    const x = s * BRIDLE_X;
    const y = roofY(x, BRIDLE_Z);
    iron.tube(
      [
        [x, y, BRIDLE_Z],
        [x, y + 0.05, BRIDLE_Z],
      ],
      [0.02],
      6,
    );
    rope.tube(
      [
        [x, y + 0.05, BRIDLE_Z],
        [0, BRIDLE_Y, BRIDLE_Z],
      ],
      [0.008],
      4,
    );
  }
  timber.box(
    [-0.04, BRIDLE_Y - 0.02, BRIDLE_Z - 0.05],
    [0.04, BRIDLE_Y + 0.07, BRIDLE_Z + 0.05],
    OAK,
  );
  return { iron, rope, timber };
}

/** The mainsheet's block under the boom, over the bridle's. */
function sheetBlock(): MeshBuilder {
  const m = new MeshBuilder('oak');
  m.box([-0.035, -0.06, -0.05], [0.035, 0.03, 0.05], OAK);
  return m;
}

// --- Lanterns ------------------------------------------------------------------------

const LENS_RED = srgb(0.5, 0.11, 0.09);
const LENS_GREEN = srgb(0.09, 0.38, 0.2);
const LENS_CLEAR = srgb(0.78, 0.77, 0.7);

/** The sidelights, on the pulpit's after legs, and the sternlight on its post at the transom's middle. */
const SIDELIGHT_Z = PULPIT_AFT + 0.02;
const sidelightAt = (s: number): Vec3 => [
  s * (edgeAt(SIDELIGHT_Z) + 0.07),
  deckAt(0, SIDELIGHT_Z) + 0.42,
  SIDELIGHT_Z,
];
const STERNLIGHT: Vec3 = [0, sheer(0) + 0.52, TRANSOM_Z - 0.12];

/** A sidelight in its node's frame: a brass lamp with its coloured glass, and the screen inboard that keeps it from showing across the bow. */
function sidelight(s: number): { brass: MeshBuilder; glass: MeshBuilder; board: MeshBuilder } {
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const board = new MeshBuilder('varnish');
  const lens = s > 0 ? LENS_GREEN : LENS_RED;
  glass.tube(
    [
      [0, -0.05, 0],
      [0, 0.05, 0],
    ],
    [0.045],
    8,
    lens,
  );
  brass.tube(
    [
      [0, 0.05, 0],
      [0, 0.08, 0],
      [0, 0.12, 0],
    ],
    [0.055, 0.042, 0.012],
    8,
  );
  brass.tube(
    [
      [0, -0.08, 0],
      [0, -0.05, 0],
    ],
    [0.05],
    8,
  );
  board.box([-s * 0.07 - 0.008, -0.1, -0.35], [-s * 0.07 + 0.008, 0.12, 0.07], shade(lens, 0.6));
  return { brass, glass, board };
}

/** The sternlight in its node's frame: a six-sided lantern of clear glass in a brass frame on an iron post. */
function sternlight(): { brass: MeshBuilder; glass: MeshBuilder; iron: MeshBuilder } {
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const iron = new MeshBuilder('iron');
  glass.tube(
    [
      [0, -0.06, 0],
      [0, 0.06, 0],
    ],
    [0.05],
    6,
    LENS_CLEAR,
  );
  brass.tube(
    [
      [0, 0.06, 0],
      [0, 0.09, 0],
      [0, 0.14, 0],
    ],
    [0.06, 0.045, 0.012],
    6,
  );
  brass.tube(
    [
      [0, -0.09, 0],
      [0, -0.06, 0],
    ],
    [0.055],
    6,
  );
  iron.tube(
    [
      [0, -0.09, 0],
      [0, sheer(0) - STERNLIGHT[1], 0.06],
    ],
    [0.018],
    5,
  );
  return { brass, glass, iron };
}

// --- The far model's deck --------------------------------------------------------

function plainDeck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const across = [-1, -0.5, 0, 0.5, 1];
  let prev: number[] | null = null;
  for (const u of stations()) {
    const b = halfBeam(u);
    if (b < 1e-4) {
      continue;
    }
    const row = across.map((f) => m.vertex([f * b, deckY(f * b, u), zAt(u)], DECK, [f * b, u]));
    if (prev !== null) {
      m.strip(prev, row);
    }
    prev = row;
  }
  return m;
}

// --- The hull's volume -------------------------------------------------------

const VOLUME_STATIONS = 8;

function sectionAt(m: MeshBuilder, at: number): [number, number][][] {
  const p = m.positions;
  const point = (i: number): Vec3 => [p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0];
  const cuts: [number, number][][] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const tri = [0, 1, 2].map((k) => point(m.indices[t + k] ?? 0));
    const ends: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const a = tri[k] as Vec3;
      const b = tri[(k + 1) % 3] as Vec3;
      if (a[2] - at < 0 !== b[2] - at < 0) {
        const f = (at - a[2]) / (b[2] - a[2]);
        ends.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
      }
    }
    if (ends.length === 2) {
      cuts.push(ends);
    }
  }
  return cuts;
}

function halfBeamAt(cuts: [number, number][][], y: number): number {
  let widest = 0;
  for (const [a, b] of cuts as [[number, number], [number, number]][]) {
    if (a[1] - y < 0 !== b[1] - y < 0) {
      const f = (y - a[1]) / (b[1] - a[1]);
      widest = Math.max(widest, Math.abs(a[0] + f * (b[0] - a[0])));
    }
  }
  return widest;
}

function bilgeExponent(r: number): number {
  let lo = 0.3;
  let hi = 12;
  for (let i = 0; i < 60; i++) {
    const n = (lo + hi) / 2;
    if ((1 - 0.5 ** n) ** (1 / n) < r) {
      lo = n;
    } else {
      hi = n;
    }
  }
  return (lo + hi) / 2;
}

/** The hull's volume, measured from its mesh, for keeping the sea out of it. */
function hullVolume(m: MeshBuilder): { stations: number[][]; bilge: number } {
  let fore = TRANSOM_Z;
  let aft = BOW_Z;
  for (let i = 0; i < m.count; i++) {
    if ((m.positions[i * 3 + 1] ?? 0) < 0) {
      fore = Math.min(fore, m.positions[i * 3 + 2] ?? 0);
      aft = Math.max(aft, m.positions[i * 3 + 2] ?? 0);
    }
  }
  const out: number[][] = [];
  let bilge = 0;
  let measured = 0;
  for (let i = 0; i < VOLUME_STATIONS; i++) {
    const z = aft + ((fore - aft) * i) / (VOLUME_STATIONS - 1);
    const end = i === 0 || i === VOLUME_STATIONS - 1;
    const cuts = end ? [] : sectionAt(m, z);
    let depth = 0;
    for (const cut of cuts) {
      for (const e of cut) {
        depth = Math.max(depth, -e[1]);
      }
    }
    const beam = halfBeamAt(cuts, 0);
    out.push([round4(z), round4(beam), round4(depth)]);
    if (depth > 0.02 && beam > 0) {
      bilge += bilgeExponent(halfBeamAt(cuts, -depth / 2) / beam);
      measured++;
    }
  }
  if (measured === 0) {
    throw new Error('the hull has no section in the water');
  }
  return { stations: out, bilge: round4(bilge / measured) };
}

/** The hull as a solid, for what keeps a sailor out of it. */
function solid(): Record<string, unknown> {
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const u = i / 20;
      return [round4(zAt(u)), round4(halfBeam(u)), round4(sheer(u)), round4(keelDepth(u))];
    }),
    exponent: sectionExponent(0.5),
    cockpit: {
      fore: round4(COCKPIT_FORE),
      aft: round4(TRANSOM_Z),
      halfWidth: round4(cockpitHalf(WHEEL_Z)),
      floor: round4(SOLE),
    },
  };
}

// --- What the physics reads of her shape ----------------------------------------

/**
 * Her sections, for her righting lever (tools/lever): every LEVER_STEP from
 * the stem to the transom, the starboard half of the watertight body,
 * from the keel up the planking to the sheer, across the deck, over the
 * coachroof or down into the cockpit to its sole, to the centreline; and her
 * appendages (the fin, the bulb, the rudders) as small volumes, each its
 * place and its volume. The cockpit is open: it floats nothing.
 */
const LEVER_STEP = 0.25;
const LEVER_POINTS = 14;

function leverData(): Record<string, unknown> {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  const out: [number, number[]][] = [];
  for (let z = BOW_Z + 0.05; z < TRANSOM_Z; z += LEVER_STEP) {
    const u = uAt(z);
    const pts: number[] = [];
    const push = (x: number, y: number): void => {
      pts.push(r(x), r(y));
    };
    for (let i = 0; i <= LEVER_POINTS; i++) {
      const p = section(u, i / LEVER_POINTS);
      push(p[0], p[1]);
    }
    const b = halfBeam(u);
    if (z > COCKPIT_FORE) {
      const w = Math.min(cockpitHalf(z), b);
      push(w, deckAt(w, z));
      push(w, SOLE);
      push(0, SOLE);
    } else if (z > HOUSE_FORE && z < HOUSE_AFT) {
      const w = houseWidth(z);
      push(w, deckAt(w, z));
      if (z > ROOF_FORE) {
        const e = houseEdge(z);
        push(e.x, e.y);
        push(e.x * 0.5, roofY(e.x * 0.5, z));
        push(0, roofY(0, z));
      } else {
        push(0, deckAt(0, z));
      }
    } else {
      push(b * 0.5, deckY(b * 0.5, u));
      push(0, deckY(0, u));
    }
    out.push([r(z), pts]);
  }
  // The appendages, each cut into small volumes.
  const elements: number[][] = [];
  const keelZ = -foils.boardPosition;
  const c = foils.boardChord;
  const rows = 12;
  const along = 8;
  for (let i = 0; i < rows; i++) {
    const f = (i + 0.5) / rows;
    const y0 = lerp(keelRoot() - 0.05, BULB_Y, i / rows);
    const y1 = lerp(keelRoot() - 0.05, BULB_Y, (i + 1) / rows);
    const z0 = -c / 2 + KEEL_SWEEP * f;
    const chord = c / 2 - z0;
    // A foil's section holds about 0.68 of its chord times its thickness.
    const area = 0.68 * chord * KEEL_THICK * chord;
    for (let j = 0; j < along; j++) {
      elements.push([
        0,
        r((y0 + y1) / 2),
        r(keelZ + z0 + chord * ((j + 0.5) / along)),
        r((area * Math.abs(y1 - y0)) / along),
      ]);
    }
  }
  // The bulb, ring by ring, its ellipse's area.
  const bulbRings = 14;
  const z0 = BULB_AFT - BULB_LENGTH * 0.4;
  for (let i = 0; i < bulbRings; i++) {
    const s = (i + 0.5) / bulbRings;
    const rr = BULB_R * Math.max(0.02, bulbShape(s) / bulbShape(BULB_FULLEST));
    const area = Math.PI * rr * rr * BULB_FLAT;
    const len = BULB_LENGTH / bulbRings;
    for (const dx of [-0.5, 0.5]) {
      elements.push([r(dx * rr), r(BULB_Y), r(keelZ + z0 + s * BULB_LENGTH), r((area * len) / 2)]);
    }
  }
  // The rudders, each in a few pieces down its span.
  const rc = foils.rudderChord;
  for (const s of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const y0 = lerp(RUDDER_ROOT, RUDDER_TIP, i / 4);
      const y1 = lerp(RUDDER_ROOT, RUDDER_TIP, (i + 1) / 4);
      const area = 0.68 * rc * 0.11 * rc;
      elements.push([
        r(s * RUDDER_X),
        r((y0 + y1) / 2),
        r(foils.rudderPosition + rc * 0.35),
        r(area * Math.abs(y1 - y0)),
      ]);
    }
  }
  return { step: LEVER_STEP, sections: out, elements };
}

/** The canoe body's waterplane at rest: its beam, its area, its second moment about its centre along the length. */
function waterplane(): { beam: number; area: number; pitch: number; centre: number } {
  let area = 0;
  let moment = 0;
  let beam = 0;
  const n = 400;
  const dz = L / n;
  const strips: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const w = keelDepth(u) > 0 ? 2 * breadthAt(u, 0) : 0;
    beam = Math.max(beam, w);
    strips.push([zAt(u), w]);
    area += w * dz;
    moment += w * dz * zAt(u);
  }
  const centre = moment / area;
  let pitch = 0;
  for (const [z, w] of strips) {
    pitch += w * dz * (z - centre) ** 2;
  }
  return { beam, area, pitch, centre };
}

/** The heels at which the windward rudder's root and tip leave still water, degrees. */
const rudderHeels = (): { lift: number; clear: number } => ({
  lift: (Math.atan2(-RUDDER_ROOT, RUDDER_X) * 180) / Math.PI,
  clear: (Math.atan2(-RUDDER_TIP, RUDDER_X) * 180) / Math.PI,
});

// --- The people's places -------------------------------------------------------

/** The sailor's stance between the wheels, on the sole; the gunwale at its station. */
const STANCE: Vec3 = [0, SOLE, STAND_Z];
const GUNWALE: Vec3 = [halfBeam(uAt(STAND_Z)), sheer(uAt(STAND_Z)), STAND_Z];
/**
 * Where the crew sit on the rail, legs over the side under the lifelines:
 * the starboard deck's edge abreast the coachroof, aft of the shrouds'
 * chainplates (over them a figure sat on the edge has a shroud through its
 * hips) and clear of the stanchions either side.
 */
const RAIL_Z = -0.45;
const RAIL: Vec3 = [halfBeam(uAt(RAIL_Z)), sheer(uAt(RAIL_Z)), RAIL_Z];
/**
 * The crew's stations: on the windward bench, the trimmer at its after end
 * by the primary capstan, one at its forward end and one between; and on
 * the rail forward of the shrouds' chainplates, from by the shrouds to the
 * foredeck, each clear of them and of the stanchions by 0.3 m, and of where
 * the coachroof is crossed (forward of the mast) by a turn at a crouch. Aft
 * of the shrouds the side deck between them and the lifelines is narrower
 * than a body crossing at a crouch, and aft of the mast the boom and the
 * vang lie over the coachroof.
 */
const BENCH_ZS = [2.35, 0.85, 1.6];
const RAIL_ZS = [-1.6, -2.9, -3.5, -4.1];

// --- The model ---------------------------------------------------------------

function model(): NodeDef[] {
  const shell = planking();
  const shellAll = new MeshBuilder('paint');
  shellAll.append(shell.copper);
  shellAll.append(shell.paint);
  shellAll.append(shell.topsides);
  const waterline = hullVolume(shellAll);
  const rails = new MeshBuilder('varnish');
  rubrails(rails);
  const deckMesh = D.plankedDeck ? deck() : plainDeck();
  if (D.plankedDeck) {
    cockpit(deckMesh);
  }
  const house = coachroof();
  const hullParts = [
    shell.copper.primitive({ colors: true }),
    shell.paint.primitive({ colors: true }),
    shell.topsides.primitive({ colors: true }),
    deckMesh.primitive({ colors: true }),
    rails.primitive({ colors: true }),
    house.wood.primitive({ colors: true }),
    house.roof.primitive({ colors: true }),
  ];
  const fixtures = new MeshBuilder('varnish');
  table(fixtures);
  const bin = binnacles();
  hullParts.push(fixtures.primitive({ colors: true }), bin.wood.primitive({ colors: true }));
  const fittings = {
    timber: new MeshBuilder('oak'),
    iron: new MeshBuilder('iron'),
    bronze: new MeshBuilder('bronze'),
  };
  for (const [x, z, k] of CAPSTANS) {
    for (const s of [1, -1]) {
      const y = z > COCKPIT_FORE ? deckAt(x, z) : roofY(x, z);
      capstan(fittings, s * x, y, z, k);
    }
  }
  if (D.small) {
    cleats(fittings.timber);
  }
  const tack = groundTackle();
  hullParts.push(
    fittings.timber.primitive({ colors: true }),
    tack.spar.primitive({ colors: true }),
  );
  const door = sternDoor();
  hullParts.push(door.wood.primitive({ colors: true }));
  const masts = mast();
  const mastParts = [masts.spar.primitive()];
  const spars = boom();
  const boomParts = [spars.spar.primitive()];
  if (D.small) {
    const tilts = tilt();
    const ports = portlights();
    const guards = guardrails();
    const br = bridle();
    hullParts.push(
      house.glass.primitive({ colors: true }),
      house.lead.primitive(),
      house.brass.primitive(),
      tilts.canvas.primitive(),
      tilts.laths.primitive({ colors: true }),
      ports.bronze.primitive(),
      ports.glass.primitive({ colors: true }),
      guards.iron.primitive(),
      guards.rope.primitive(),
      fittings.iron.primitive(),
      fittings.bronze.primitive(),
      tack.iron.primitive(),
      tack.timber.primitive({ colors: true }),
      door.iron.primitive(),
      door.rope.primitive(),
      bin.brass.primitive(),
      bin.glass.primitive({ colors: true }),
      br.iron.primitive(),
      br.rope.primitive(),
      br.timber.primitive({ colors: true }),
    );
    mastParts.push(masts.iron.primitive(), masts.timber.primitive({ colors: true }));
    const r = rigging();
    for (const b of [r.rope, r.iron, r.wood, r.brass, r.spar]) {
      for (let i = 0; i < b.count; i++) {
        b.positions[i * 3 + 2] = (b.positions[i * 3 + 2] ?? 0) - MAST_Z;
      }
    }
    mastParts.push(
      r.rope.primitive(),
      r.iron.primitive(),
      r.wood.primitive({ colors: true }),
      r.brass.primitive(),
      r.spar.primitive(),
    );
    boomParts.push(
      spars.iron.primitive(),
      spars.bag.primitive({ colors: true }),
      spars.rope.primitive(),
    );
    const gooseneck = new MeshBuilder('iron');
    gooseneck.box([-0.05, -0.05, -0.12], [0.05, 0.05, 0.1]);
    boomParts.push(gooseneck.primitive());
  }
  const vangParts = vang();
  const nodes: NodeDef[] = [
    {
      name: 'hull',
      primitives: hullParts,
      extras: {
        waterline,
        plan: { deviation: planDeviation() },
        solid: solid(),
        ...(D === NEAR ? { lever: leverData() } : {}),
      },
    },
    {
      name: 'mast',
      translation: [0, 0, MAST_Z],
      primitives: mastParts,
      // Where her shrouds come down to the side decks: her crew's way along
      // them passes outboard of these.
      extras: {
        chainplates: [CAP_Z, CAP_Z + 0.06, LOWER_Z].map((z) => [CHAIN_X, round4(z)]),
      },
    },
    {
      name: 'boom',
      translation: [0, rig.boomHeight, MAST_Z],
      primitives: boomParts,
      children: [
        {
          name: 'vang',
          primitives: D.small
            ? [vangParts.rope.primitive(), vangParts.timber.primitive({ colors: true })]
            : [vangParts.rope.primitive()],
        },
        ...(D.small
          ? [
              {
                name: 'sheet-boom',
                translation: [0, -0.08, BRIDLE_Z - MAST_Z] as Vec3,
                primitives: [sheetBlock().primitive({ colors: true })],
              },
            ]
          : []),
      ],
    },
    {
      name: 'sail',
      translation: [0, rig.boomHeight, MAST_Z],
      primitives: [sail().primitive({ uvs2: true })],
    },
    {
      name: 'jib',
      translation: TACK,
      extras: { rake: Math.round(RAKE * 1e5) / 1e5 },
      primitives: [jib().primitive({ uvs2: true })],
    },
  ];
  if (D.small) {
    nodes.push(
      {
        name: 'telltales',
        translation: [0, rig.boomHeight, MAST_Z],
        primitives: [telltales(rig, chordAt).primitive({ uvs2: true, colors: true })],
      },
      {
        name: 'pennant',
        translation: [0, MAST_TOP + STAFF_TOP - PENNANT_WIDTH / 2, MAST_Z],
        primitives: [pennant().primitive({ uvs2: true })],
      },
    );
    // The pennant's staff on the truck.
    const staff = new MeshBuilder('brass');
    staff.tube(
      [
        [0, MAST_TOP + 0.07, MAST_Z],
        [0, MAST_TOP + STAFF_TOP, MAST_Z],
      ],
      [0.008, 0.005],
      6,
    );
    (nodes[1] as NodeDef).primitives?.push(
      (() => {
        for (let i = 0; i < staff.count; i++) {
          staff.positions[i * 3 + 2] = (staff.positions[i * 3 + 2] ?? 0) - MAST_Z;
        }
        return staff.primitive();
      })(),
    );
    // The lanterns, each node named as its light and where it is seen from.
    for (const s of [-1, 1]) {
      const l = sidelight(s);
      nodes.push({
        name: s < 0 ? 'port' : 'starboard',
        translation: sidelightAt(s),
        primitives: [
          l.brass.primitive(),
          l.glass.primitive({ colors: true }),
          l.board.primitive({ colors: true }),
        ],
      });
    }
    const st = sternlight();
    nodes.push({
      name: 'stern',
      translation: STERNLIGHT,
      primitives: [st.brass.primitive(), st.glass.primitive({ colors: true }), st.iron.primitive()],
    });
  }
  // The wheels: the `wheel` node at their hubs' height and station on the
  // centreline, each wheel a child at its spread, turned with the rudder.
  const wheels = wheel();
  const wheelPrims = D.small
    ? [
        wheels.wood.primitive({ colors: true }),
        wheels.brass.primitive(),
        wheels.rope.primitive({ colors: true }),
      ]
    : [wheelDisc().primitive({ colors: true })];
  nodes.push({
    name: 'wheel',
    translation: [0, WHEEL_Y, WHEEL_Z],
    extras: {
      wheel: {
        radius: WHEEL_RADIUS,
        spokes: WHEEL_SPOKES,
        handles: WHEEL_HANDLE,
        ahead: WHEEL_AHEAD,
        up: WHEEL_UP,
        spread: WHEEL_SPREAD,
      },
    },
    children: [
      { name: 'wheel-port', translation: [-WHEEL_SPREAD, 0, 0], primitives: wheelPrims },
      { name: 'wheel-starboard', translation: [WHEEL_SPREAD, 0, 0], primitives: wheelPrims },
    ],
  });
  const blade = rudder();
  const rudderPrims = D.small
    ? [blade.blade.primitive(), blade.bronze.primitive()]
    : [blade.blade.primitive()];
  nodes.push(
    {
      name: 'rudder',
      translation: [0, 0, foils.rudderPosition],
      children: [
        { name: 'rudder-port', translation: [-RUDDER_X, 0, 0], primitives: rudderPrims },
        { name: 'rudder-starboard', translation: [RUDDER_X, 0, 0], primitives: rudderPrims },
        { name: 'tiller', translation: [0, TIE_Y, -TIE_ARM], primitives: [tieBar().primitive()] },
      ],
    },
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [keel().primitive({ colors: true })],
      children: [{ name: 'bulb', primitives: [bulb().primitive()] }],
    },
    { name: 'sailor', translation: STANCE },
    { name: 'gunwale', translation: GUNWALE },
    { name: 'rail', translation: RAIL },
    {
      name: 'board-root',
      translation: [0, -keelDepth(uAt(-foils.boardPosition)), -foils.boardPosition],
    },
    // The places the crew's ways read: the coachroof's top, the table, the mainsheet's bridle.
    {
      name: 'coachroof',
      translation: [
        0,
        round4(roofY(0, (ROOF_FORE + HOUSE_AFT) / 2)),
        round4((ROOF_FORE + HOUSE_AFT) / 2),
      ],
      extras: {
        coachroof: {
          fore: round4(ROOF_FORE),
          aft: round4(HOUSE_AFT),
          halfWidth: round4(houseEdge(HOUSE_AFT).x),
        },
      },
    },
    {
      name: 'table',
      translation: [0, round4(TABLE_TOP), round4((TABLE_FORE + TABLE_AFT) / 2)],
      extras: { table: { fore: TABLE_FORE, aft: TABLE_AFT, halfWidth: TABLE_HALF } },
    },
    { name: 'bridle', translation: [0, round4(BRIDLE_Y), round4(BRIDLE_Z)] },
    {
      name: 'bench',
      translation: [round4(cockpitHalf(1.55) - BENCH_DEPTH / 2), round4(BENCH_TOP), 1.55],
      extras: {
        bench: {
          fore: BENCH_FORE,
          aft: BENCH_AFT,
          top: round4(BENCH_TOP),
          inner: round4(cockpitHalf(1.55) - BENCH_DEPTH),
          sole: round4(SOLE),
        },
      },
    },
    {
      name: 'lifelines',
      extras: {
        lifelines: {
          heights: LIFELINES,
          stanchions: STANCHIONS,
          inboard: STANCHION_IN,
          fore: PULPIT_AFT,
          aft: PUSHPIT_FORE,
        },
      },
    },
  );
  return nodes;
}

mkdirSync('.dev/art', { recursive: true });
for (const [detail, path] of [
  [NEAR, MODEL],
  [FAR, FAR_MODEL],
] as const) {
  D = detail;
  const raw = writeGlb([{ name: 'boat', children: model() }], materials);
  const name = path.replace(/^boats\//, '').replace(/\.glb$/, '');
  writeFileSync(`.dev/art/${name}.raw.glb`, raw);
  execFileSync(
    'client/node_modules/.bin/gltfpack',
    [
      '-i',
      `.dev/art/${name}.raw.glb`,
      '-o',
      `art/${path}`,
      '-c',
      '-kn',
      '-km',
      '-kv',
      '-ke',
      '-noq',
    ],
    { stdio: 'inherit' },
  );
}

// What the catalog takes from the model, and the crew's stations.
D = NEAR;
const wp = waterplane();
const heels = rudderHeels();
const station = (at: Vec3): string => `[${at.map((v) => round4(v)).join(', ')}]`;
process.stdout.write(
  `wrote art/${MODEL} and art/${FAR_MODEL}: bow ${BOW_Z.toFixed(2)} m, transom ${TRANSOM_Z.toFixed(2)} m\n` +
    `  waterline beam ${wp.beam.toFixed(3)} m, waterplane ${wp.area.toFixed(2)} m², its second moment ${wp.pitch.toFixed(1)} m⁴ about ${wp.centre.toFixed(2)} m\n` +
    `  the windward rudder's root leaves the water at ${heels.lift.toFixed(1)}°, its tip at ${heels.clear.toFixed(1)}° (root ${RUDDER_ROOT.toFixed(3)} m)\n` +
    `  stations: helm ${station(STANCE)}; bench ${BENCH_ZS.map((z) => station([cockpitHalf(z) - BENCH_DEPTH, BENCH_TOP, z])).join(' ')}; ` +
    `rail ${RAIL_ZS.map((z) => station([halfBeam(uAt(z)), deckY(halfBeam(uAt(z)), uAt(z)), z])).join(' ')}\n`,
);

// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The keelboat: a day-sailing keelboat of our time built by a shipwright of
// the period. A carvel-planked hull, its topsides in the paint its sailor
// chooses, with a dark sheer strake, a cream boot top and a copper bottom; a laid deck with a shallow
// cockpit aft and a varnished cuddy with small panes forward of it; a fin
// keel sheathed in copper with a cast lead bulb, and a rudder under the
// counter with a long tiller and its extension; a fractional sloop rig of
// varnished spruce with iron bands, spreaders, tarred shrouds set up with
// deadeyes, a forestay and a backstay; a cream flax mainsail and a jib on
// its stay; bronze and brass fittings, and at the masthead the brass
// tricolour lantern with the pennant's staff above it.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: length and beam, the plan at the sheer, the
// canoe body's draught, the mast's place, the boom's height, the main's
// luff and foot, the jib's luff, foot, tack and tack's height, the keel's
// and rudder's places, spans and chords, the seat's height. The rest (sheer,
// profile, sections, planking, the cuddy, the rigging) are this script's
// own.
//
// The helm is laid out as the boat the sailors are staged in has it
// (art/sailors/tables.yaml's stage): the side deck as wide, the cockpit's
// floor as far below it, the tiller's hinge as far from the seat; so the
// sailors' clips, placed in that boat, seat the sailor here moved by the
// difference between the two seats, which the `sailor` node carries.
//
// It builds the boat twice from the same lines: in full, and the far model,
// with few segments, no seams, cockpit, rigging, telltales, pennant, lantern
// or fittings, and a plain deck. The catalog's art.model and art.far name
// them.
//
//   node art/boats/keelboat/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  LANTERN_Y,
  lantern,
  PENNANT_WIDTH,
  pennant,
  STAFF_TOP,
  telltales,
} from '../../lib/fittings.ts';
import { type MaterialDef, type NodeDef, readGlbJson, writeGlb } from '../../lib/gltf.ts';
import { add, cross, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../../lib/mesh.ts';

/** The models this script writes, as the catalog's art.model and art.far name them. */
const MODEL = 'boats/keelboat.glb';
const FAR_MODEL = 'boats/keelboat.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along the hull: a multiple of ten, so the outline's points are among them. */
  stations: number;
  /** Rows of the copper bottom, and the strakes of the topsides. */
  copperRows: number;
  strakes: number;
  /** Whether each strake shows its seam, a dark line along its lower edge. */
  seams: boolean;
  /** The deck in planks round the cockpit, or plain; its rows along the hull. */
  plankedDeck: boolean;
  deckStations: number;
  /** Around tubes and blades, and along the mast. */
  round: number;
  mastStations: number;
  /** The mainsail's rows and columns, and the jib's. */
  sailRows: number;
  sailCols: number;
  jibRows: number;
  jibCols: number;
  /** Rigging, telltales, pennant, lantern, panes and the fittings. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 50,
  copperRows: 5,
  strakes: 8,
  seams: true,
  plankedDeck: true,
  deckStations: 25,
  round: 12,
  mastStations: 10,
  sailRows: 24,
  sailCols: 10,
  jibRows: 16,
  jibCols: 6,
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
    sailor: { sailorSeatHeight: number };
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

// --- The stage -----------------------------------------------------------------
//
// The boat the sailors' clips are placed in, read from its model: its seat
// (the gunwale at the seat's station), the side deck's width there, the
// cockpit floor's depth below the gunwale, and the tiller's hinge from the
// seat.

interface Stage {
  gunwale: Vec3;
  seatZ: number;
  sideDeck: number;
  floorDrop: number;
  hinge: Vec3;
}

function readStage(): Stage {
  const tables = readFileSync('art/sailors/tables.yaml', 'utf8');
  const path = /^stage:\s*\n\s+boat:\s*(\S+)/m.exec(tables)?.[1];
  if (path === undefined || path === MODEL) {
    throw new Error(`art/sailors/tables.yaml stages the sailors in ${path ?? 'no boat'}`);
  }
  const g = readGlbJson(readFileSync(`art/${path}`)) as {
    nodes: { name?: string; translation?: number[]; extras?: Record<string, unknown> }[];
  };
  const node = (name: string) => {
    const n = g.nodes.find((x) => x.name === name);
    if (n === undefined) {
      throw new Error(`art/${path} has no node ${name}`);
    }
    return n;
  };
  const at = (name: string): Vec3 => {
    const t = node(name).translation ?? [0, 0, 0];
    return [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  };
  const solid = node('hull').extras?.solid as
    | { cockpit: { halfWidth: number; floor: number } }
    | undefined;
  if (solid === undefined) {
    throw new Error('the stage boat has no hull solid');
  }
  const cockpit = solid.cockpit;
  const gunwale = at('gunwale');
  return {
    gunwale,
    seatZ: at('sailor')[2],
    sideDeck: gunwale[0] - cockpit.halfWidth,
    floorDrop: gunwale[1] - cockpit.floor,
    // The extension's hinge: the rudder's stock, the tiller's head on it, its end.
    hinge: add(add(at('rudder'), at('tiller')), at('extension')),
  };
}

const STAGE = readStage();

// --- The hull's lines -------------------------------------------------------
//
// The boat's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bow is -z).

const L = boat.lengthOverall;
const HALF_BEAM = boat.beam / 2;
/** The transom and the stem: the catalog's, where hulls touch. */
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

/**
 * Height of the sheer above the waterline: nearly straight, as a modern
 * keelboat's is, a little higher at the ends; low enough forward that the
 * jib's foot, level from its tack, clears the foredeck.
 */
const sheer = (u: number): number => 0.69 + 0.012 * (1 - u) ** 2 + 0.022 * u ** 4;

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

/**
 * How far the model's sheer, drawn straight between its stations, lies from
 * the outline at most, in metres: what is drawn is what bumps.
 */
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

/** Where the canoe body is deepest along the hull, and how far above the water its bottom is at the transom (the counter). */
const DEEPEST = 0.55;
const COUNTER = 0.08;

/**
 * Depth of the keel line below the waterline: the canoe body, deepest a
 * little forward of amidships, rising aft to the counter above the water
 * and forward in a round forefoot to the sheer at the stem.
 */
function keelDepth(u: number): number {
  const d = hull.hullDraught;
  if (u <= DEEPEST) {
    return d - (d + COUNTER) * ((DEEPEST - u) / DEEPEST) ** 2;
  }
  return d - (d + sheer(1)) * ((u - DEEPEST) / (1 - DEEPEST)) ** 4.5;
}

/** The section's exponent: a round bilge, a little fuller than an ellipse. */
const SECTION = 2.2;

/** A point on the starboard half-section at station u, girth fraction g (0 at the keel, 1 at the sheer). */
function section(u: number, g: number): Vec3 {
  const a = (g * Math.PI) / 2;
  const e = 2 / SECTION;
  const d = keelDepth(u);
  return [halfBeam(u) * Math.sin(a) ** e, -d + (sheer(u) + d) * (1 - Math.cos(a) ** e), zAt(u)];
}

/**
 * The hull's outward normal at u, g: square to the surface along the hull
 * and round its section, so the strakes, each its own mesh, shade as one
 * smooth hull.
 */
function surfaceNormal(at: number, g: number): Vec3 {
  // At the stem the section is a point: its normal is the one just aft.
  const u = Math.min(at, 0.998);
  const h = 1e-4;
  const alongG = sub(section(u, Math.min(1, g + h)), section(u, Math.max(0, g - h)));
  const alongU = sub(section(Math.min(1, u + h), g), section(Math.max(0, u - h), g));
  const n = normalize(cross(alongU, alongG));
  // Outward: in the section's plane, the girth's tangent turned outboard.
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
  return (Math.acos((1 - f) ** (SECTION / 2)) * 2) / Math.PI;
}

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'paint', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  // The topsides, in the paint the boat's sailor chooses: their vertices
  // carry only each plank's tone, and the game gives them the paint.
  { name: 'topsides', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'copper', color: [1, 1, 1], roughness: 0.42, metalness: 0.75 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.5, metalness: 0 },
  { name: 'varnish', color: [1, 1, 1], roughness: 0.3, metalness: 0 },
  { name: 'canvas', color: srgb(0.88, 0.85, 0.76), roughness: 0.85, metalness: 0 },
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

// --- The planking ------------------------------------------------------------

/** The paint: the topsides in the boat's own (white: their tones alone), a dark sheer strake, a cream boot top. */
const TOPSIDES: Vec3 = [1, 1, 1];
const SHEER_STRAKE = srgb(0.165, 0.133, 0.106);
const BOOT = srgb(0.894, 0.851, 0.749);
/** The copper sheathing, going green here and there. */
const COPPER = srgb(0.69, 0.424, 0.25);
const VERDIGRIS = srgb(0.36, 0.52, 0.42);
/** Where the sheer strake begins, as a share of the topsides' girth. */
const SHEER_FROM = 0.875;
/** The boot top's lower and upper edges, above the waterline. */
const BOOT_FROM = 0.02;
const BOOT_TO = 0.08;
/** The transom's varnished mahogany. */
const MAHOGANY = srgb(0.5, 0.25, 0.13);

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
  // Rows run from the transom forward (-z), girth upward: seen from
  // outside that is counter-clockwise.
  for (let r = 0; r + 1 < grid.length; r++) {
    m.strip(grid[r] as number[], grid[r + 1] as number[]);
  }
}

/**
 * The hull's shell: the copper bottom; the boot top, sheer strake and
 * transom in paint; and the topsides between, in the boat's own paint.
 */
function planking(): { copper: MeshBuilder; paint: MeshBuilder; topsides: MeshBuilder } {
  const copper = new MeshBuilder('copper');
  const paint = new MeshBuilder('paint');
  const topsides = new MeshBuilder('topsides');
  const bootFrom = (u: number): number => girthAt(u, BOOT_FROM);
  const bootTo = (u: number): number => girthAt(u, BOOT_TO);
  const side = new MeshBuilder('copper');
  const rows = Array.from({ length: D.copperRows + 1 }, (_, i) => i / D.copperRows);
  // Sheets about 1.2 m long, each its own tone, a few going green.
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
  // The strakes from the boot top to the sheer, the top one the dark sheer
  // strake, an eighth of the girth; each plank's own tone, its lower edge a
  // dark seam.
  const seam = D.seams ? [0, 0.1, 1] : [0, 1];
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
      .filter((u) => u < 0.985)
      .map((u) => [s * (halfBeam(u) + 0.008), sheer(u) - 0.015, zAt(u)]);
    m.tube(path, [0.02], D.small ? 6 : 3, c);
  }
}

// --- The deck, the cockpit and the cuddy ---------------------------------------

const CROWN = 0.035;
/** The deck's height at (x, u). */
const deckY = (x: number, u: number): number => {
  const b = halfBeam(u);
  const t = b > 1e-6 ? Math.min(1, Math.abs(x) / b) : 1;
  return sheer(u) + CROWN * (1 - t * t) * (b / HALF_BEAM);
};

/** The sailor's station, on the side deck aft by the tiller. */
const SEAT_Z = 1.25;
const SEAT_U = uAt(SEAT_Z);
/** The gunwale at the seat: what the sailor sits by and hikes on. */
const GUNWALE: Vec3 = [halfBeam(SEAT_U), sheer(SEAT_U), SEAT_Z];
/** The cockpit: between the side decks, as wide as the stage's at the seat, its floor as deep. */
const COCKPIT_HALF_WIDTH = GUNWALE[0] - STAGE.sideDeck;
const COCKPIT_FLOOR = GUNWALE[1] - STAGE.floorDrop;
const COCKPIT_AFT = 2.55;
/** The cuddy, between the mast and the cockpit, which begins at its after end. */
const CUDDY_FORE = -0.95;
const CUDDY_AFT = 0.25;
const COCKPIT_FORE = CUDDY_AFT;
/** The cuddy's sides' height above the deck, aft and forward; how far they lean in, and its roof's crown. */
const CUDDY_HEIGHT_AFT = 0.3;
const CUDDY_HEIGHT_FORE = 0.26;
const CUDDY_TUMBLE = 0.06;
const CUDDY_CROWN = 0.045;
/** How far aft its front leans at the roof. */
const CUDDY_RAKE = 0.08;
/** The deck's planks run fore and aft, so the cockpit's sides fall on a seam. */
const PLANK = COCKPIT_HALF_WIDTH / 5.5;
const DECK = srgb(0.86, 0.76, 0.58);
const VARNISH = srgb(0.55, 0.3, 0.15);
const GLASS = srgb(0.1, 0.14, 0.17);

/** The cuddy's half-width at the deck at z: the cockpit's at its after end, narrowing forward. */
const cuddyWidth = (z: number): number =>
  COCKPIT_HALF_WIDTH - 0.19 * smoothstep(CUDDY_AFT, CUDDY_FORE, z);

/** Whether the deck between x0 and x1 at z (between two rows) is open: the cockpit, or under the cuddy. */
function open(x0: number, x1: number, z: number): boolean {
  const outer = Math.max(Math.abs(x0), Math.abs(x1));
  if (z > COCKPIT_FORE && z < COCKPIT_AFT) {
    return outer <= COCKPIT_HALF_WIDTH + 1e-6;
  }
  return z > CUDDY_FORE && z < CUDDY_AFT && outer <= cuddyWidth(z) - 0.02;
}

/** The deck's rows: the deck's stations, the outline's points, and the ends of the cockpit and the cuddy. */
function deckRows(): number[] {
  const us = [
    ...stations(D.deckStations),
    ...stations(10),
    ...[COCKPIT_FORE, COCKPIT_AFT, CUDDY_FORE].map(uAt),
  ].sort((a, b) => a - b);
  return us.filter((u, i) => i === 0 || u - (us[i - 1] as number) > 1e-6);
}

function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const us = deckRows();
  const planks = Math.ceil(HALF_BEAM / PLANK - 0.5);
  for (let j = -planks; j <= planks; j++) {
    const x0 = (j - 0.5) * PLANK;
    const x1 = (j + 0.5) * PLANK;
    const tone = 0.88 + 0.22 * jitter(j + 50);
    const c = shade(DECK, tone);
    const seam = shade(c, 0.55);
    let prev: { row: number[]; z: number; in: boolean } | null = null;
    for (const u of us) {
      const b = halfBeam(u);
      const z = zAt(u);
      // Beyond the sheer the plank ends: its row closed at the edge, so
      // the deck meets the sheer with no gap where it narrows.
      const inside = Math.min(x1, b) - Math.max(x0, -b) > 1e-4;
      const edge = x0 >= 0 ? b : -b;
      const lo = inside ? Math.max(x0, -b) : edge;
      const hi = inside ? Math.min(x1, b) : edge;
      // A dark caulked seam along each plank's edge.
      const w = Math.min(0.006, (hi - lo) / 4);
      const xs = [lo, lo + w, hi - w, hi];
      const cs = [seam, c, c, seam];
      const row = xs.map((x, i) => m.vertex([x, deckY(x, u), z], cs[i] as Vec3, [x, u]));
      // Rows run aft to fore (-z), columns port to starboard (+x): seen
      // from above, counter-clockwise.
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

/** The cockpit: its floor planked fore and aft, its sides and after end down from the deck. */
function cockpit(m: MeshBuilder): void {
  const w = COCKPIT_HALF_WIDTH;
  const f = COCKPIT_FORE;
  const a = COCKPIT_AFT;
  const y = COCKPIT_FLOOR;
  const top = (x: number, z: number): number => deckY(x, uAt(z));
  const sides = shade(DECK, 0.75);
  // The floor's boards.
  const boards = 6;
  for (let i = 0; i < boards; i++) {
    const x0 = -w + (2 * w * i) / boards;
    const x1 = -w + (2 * w * (i + 1)) / boards;
    quad(
      m,
      [
        [x0 + 0.004, y, f],
        [x1 - 0.004, y, f],
        [x1 - 0.004, y, a],
        [x0 + 0.004, y, a],
      ],
      [0, 1, 0],
      shade(DECK, 0.8 + 0.15 * jitter(i + 90)),
    );
    quad(
      m,
      [
        [x0 - 0.004, y - 0.002, f],
        [x0 + 0.004, y - 0.002, f],
        [x0 + 0.004, y - 0.002, a],
        [x0 - 0.004, y - 0.002, a],
      ],
      [0, 1, 0],
      shade(DECK, 0.35),
    );
  }
  quad(
    m,
    [
      [-w, y, a],
      [w, y, a],
      [w, top(w, a), a],
      [-w, top(-w, a), a],
    ],
    [0, 0, -1],
    sides,
  );
  for (const s of [1, -1]) {
    quad(
      m,
      [
        [s * w, y, f],
        [s * w, y, a],
        [s * w, top(s * w, a), a],
        [s * w, top(s * w, f), f],
      ],
      [-s, 0, 0],
      sides,
    );
  }
}

/**
 * The cuddy: varnished sides leaning in, a crowned roof of painted canvas,
 * its front raked aft, its after end down to the cockpit's floor with the
 * companionway in it; two windows of small panes a side, and the sliding
 * hatch over the companionway.
 */
function cuddy(): { wood: MeshBuilder; roof: MeshBuilder; glass: MeshBuilder; brass: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const roof = new MeshBuilder('canvas');
  const glass = new MeshBuilder('glass');
  const brass = new MeshBuilder('brass');
  const n = D.small ? 8 : 2;
  const across = D.small ? 8 : 2;
  /** Along the cuddy, t from its front (0) to its after end (1): the side's foot and the roof's edge. */
  const foot = (t: number, s: number): Vec3 => {
    const z = lerp(CUDDY_FORE, CUDDY_AFT, t);
    const w = cuddyWidth(z);
    return [s * w, deckY(w, uAt(z)), z];
  };
  const height = (t: number): number => lerp(CUDDY_HEIGHT_FORE, CUDDY_HEIGHT_AFT, t);
  const edge = (t: number, s: number): Vec3 => {
    const z = lerp(CUDDY_FORE + CUDDY_RAKE, CUDDY_AFT, t);
    const w = cuddyWidth(z) - CUDDY_TUMBLE;
    return [s * w, deckY(0, uAt(z)) + height(t), z];
  };
  /** The roof at fraction a across (−1 port, 1 starboard), t along. */
  const roofAt = (t: number, a: number): Vec3 => {
    const e = edge(t, 1);
    return [a * e[0], e[1] + CUDDY_CROWN * (1 - a * a), e[2]];
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
  // The roof.
  const grid: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= across; j++) {
      row.push(roof.vertex(roofAt(i / n, -1 + (2 * j) / across)));
    }
    grid.push(row);
  }
  for (let i = 0; i < n; i++) {
    const r0 = grid[i] as number[];
    const r1 = grid[i + 1] as number[];
    for (let j = 0; j < across; j++) {
      const [a, b, c, d] = [r0[j], r0[j + 1], r1[j + 1], r1[j]] as number[];
      roof.triFacing(a as number, b as number, c as number, [0, 1, 0]);
      roof.triFacing(a as number, c as number, d as number, [0, 1, 0]);
    }
  }
  // The front and the after end: a fan from the middle of the foot to the
  // roof's edge across.
  for (const [t, bottom, n3] of [
    [0, deckY(0, uAt(CUDDY_FORE)), [0, 0.3, -1]],
    [1, COCKPIT_FLOOR, [0, 0, 1]],
  ] as [number, number, Vec3][]) {
    const f = foot(t, 1);
    const ring: Vec3[] = [
      [-f[0], t === 1 ? bottom : f[1], f[2]],
      ...Array.from({ length: across + 1 }, (_, j) => roofAt(t, -1 + (2 * j) / across)),
      [f[0], t === 1 ? bottom : f[1], f[2]],
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
    return { wood, roof, glass, brass };
  }
  // The companionway, dark, in the after end; the hatch slid over it.
  const top = roofAt(1, 0)[1];
  const dark = shade(VARNISH, 0.25);
  quad(
    wood,
    [
      [-0.22, COCKPIT_FLOOR + 0.12, CUDDY_AFT + 0.003],
      [0.22, COCKPIT_FLOOR + 0.12, CUDDY_AFT + 0.003],
      [0.22, top - 0.02, CUDDY_AFT + 0.003],
      [-0.22, top - 0.02, CUDDY_AFT + 0.003],
    ],
    [0, 0, 1],
    dark,
  );
  wood.box(
    [-0.27, top, CUDDY_AFT - 0.5],
    [0.27, top + 0.05, CUDDY_AFT + 0.02],
    shade(VARNISH, 0.8),
  );
  // Two windows a side, each of four small panes in a brass frame.
  for (const s of [1, -1]) {
    for (const mid of [0.32, 0.68]) {
      const [t0, t1, h0, h1] = [mid - 0.13, mid + 0.13, 0.32, 0.72];
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
      const frame = [on(t0, h0, 0.004), on(t1, h0, 0.004), on(t1, h1, 0.004), on(t0, h1, 0.004)];
      quad(brass, frame, out, [1, 1, 1]);
      const pane = (a: number, b: number, c: number, d: number): void =>
        quad(
          glass,
          [on(a, c, 0.007), on(b, c, 0.007), on(b, d, 0.007), on(a, d, 0.007)],
          out,
          GLASS,
        );
      const tm = (t0 + t1) / 2;
      const hm = (h0 + h1) / 2;
      const g = 0.006;
      pane(t0 + 0.012, tm - g, h0 + 0.08, hm - 0.03);
      pane(tm + g, t1 - 0.012, h0 + 0.08, hm - 0.03);
      pane(t0 + 0.012, tm - g, hm + 0.03, h1 - 0.08);
      pane(tm + g, t1 - 0.012, hm + 0.03, h1 - 0.08);
    }
  }
  return { wood, roof, glass, brass };
}

// --- Spars, rigging and sails ----------------------------------------------------

const MAST_Z = -rig.mastPosition;
const mastFootY = deckY(0, uAt(MAST_Z));
const MAST_TOP = rig.boomHeight + rig.luff + 0.1;
/** The mast's radius at its foot and its head. */
const MAST_FOOT_R = 0.058;
const MAST_HEAD_R = 0.034;
const mastR = (y: number): number =>
  lerp(MAST_FOOT_R, MAST_HEAD_R, ((y - mastFootY) / (MAST_TOP - mastFootY)) ** 2);
/** The jib's tack, on the stem's fitting, and its head, on the forestay. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];
/** The hounds, where the forestay and the cap shrouds meet the mast: a little above the jib's head (a fractional rig). */
const HOUNDS = TACK[1] + headsails.headsailLuff + 0.45;
/** The forestay, from the tack to the mast's fore side at the hounds. */
const STAY_TOP: Vec3 = [0, HOUNDS, MAST_Z - mastR(HOUNDS)];
/** How far aft of the tack the jib's head is: along the forestay, the jib's luff up. */
const RAKE = (headsails.headsailLuff * (STAY_TOP[2] - TACK[2])) / (STAY_TOP[1] - TACK[1]);
/** The spreaders: their height, length and sweep aft; the shrouds' chainplates' station, and the lowers' root. */
const SPREADER_Y = 4.6;
const SPREADER = 0.62;
const SPREADER_SWEEP = (8 * Math.PI) / 180;
const CAP_Z = MAST_Z + 0.12;
const LOWER_Z = MAST_Z + 0.18;
const LOWER_Y = SPREADER_Y - 0.15;
/**
 * Where the crew sit on the rail with their legs over the side: the
 * starboard deck's edge, the sheer at the outline's half-beam, beside the
 * cuddy a foot aft of the lower shrouds' chainplates (the port side's is
 * its mirror).
 */
const RAIL_Z = LOWER_Z + 0.3;
const RAIL: Vec3 = [halfBeam(uAt(RAIL_Z)), sheer(uAt(RAIL_Z)), RAIL_Z];
/** The deadeyes, above the gunwale: the upper's and the lower's height above the sheer. */
const DEADEYE_UP = 0.24;
const DEADEYE_DOWN = 0.1;
const DEADEYE_R = 0.032;

/** An iron band round the mast at y. */
function ironBand(m: MeshBuilder, y: number): void {
  const r = mastR(y) + 0.004;
  m.tube(
    [
      [0, y - 0.025, 0],
      [0, y + 0.025, 0],
    ],
    [r],
    D.small ? 12 : 5,
  );
}

/** The mast, in its node's frame (at its station): spruce, banded in iron, with its spreaders. */
function mast(): { spar: MeshBuilder; iron: MeshBuilder } {
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
  if (!D.small) {
    return { spar, iron };
  }
  for (const y of [mastFootY + 0.12, SPREADER_Y, HOUNDS, MAST_TOP - 0.06]) {
    ironBand(iron, y);
  }
  for (const s of [1, -1]) {
    spar.tube([[s * mastR(SPREADER_Y), SPREADER_Y, 0], spreaderTip(s, 0)], [0.022, 0.014], 6);
  }
  return { spar, iron };
}

/** A spreader's tip, in the mast's frame shifted by z. */
const spreaderTip = (s: number, z: number): Vec3 => [
  s * SPREADER * Math.cos(SPREADER_SWEEP),
  SPREADER_Y,
  z + SPREADER * Math.sin(SPREADER_SWEEP),
];

/** Where a shroud's deadeyes stand, outside the gunwale at a station: the upper one's middle. */
const deadeye = (s: number, z: number, up: number): Vec3 => [
  s * (halfBeam(uAt(z)) + 0.015),
  sheer(uAt(z)) + up,
  z,
];

/**
 * The standing rigging, in the boat's frame: the cap shrouds over the
 * spreaders to the hounds and the lowers below them, each set up with a
 * pair of deadeyes and a lanyard to a bronze chainplate on the topsides;
 * the forestay from the stem's fitting to the hounds, the jib hanked to it;
 * and the backstay from the masthead to the transom. Tarred hemp.
 */
function rigging(): { rope: MeshBuilder; bronze: MeshBuilder; wood: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  const wood = new MeshBuilder('varnish');
  const R = 0.0055;
  const sides = 4;
  const at = (p: Vec3): Vec3 => [p[0], p[1], p[2] + MAST_Z];
  for (const s of [1, -1]) {
    for (const [z, from] of [
      [CAP_Z, [[s * mastR(HOUNDS), HOUNDS, MAST_Z], at(spreaderTip(s, 0))]],
      [LOWER_Z, [[s * mastR(LOWER_Y), LOWER_Y, MAST_Z]]],
    ] as [number, Vec3[]][]) {
      const upper = deadeye(s, z, DEADEYE_UP);
      const lower = deadeye(s, z, DEADEYE_DOWN);
      rope.tube([...from, add(upper, [0, DEADEYE_R, 0])], [R], sides);
      // The lanyard between the deadeyes, and the deadeyes.
      rope.tube([upper, lower], [0.004], sides);
      for (const p of [upper, lower]) {
        wood.tube(
          [
            [p[0] - 0.012, p[1], p[2]],
            [p[0] + 0.012, p[1], p[2]],
          ],
          [DEADEYE_R],
          8,
          shade(VARNISH, 0.45),
        );
      }
      // The chainplate, down the topsides from the lower deadeye.
      const foot: Vec3 = [s * (halfBeam(uAt(z)) + 0.006), sheer(uAt(z)) - 0.28, z];
      bronze.box(
        [Math.min(lower[0], foot[0]) - 0.004, foot[1], z - 0.016],
        [Math.max(lower[0], foot[0]) + 0.004, lower[1] - DEADEYE_R, z + 0.016],
      );
    }
  }
  rope.tube([TACK, STAY_TOP], [R], sides);
  rope.tube(
    [
      [0, MAST_TOP - 0.08, MAST_Z + mastR(MAST_TOP)],
      [0, sheer(0) + 0.05, TRANSOM_Z - 0.06],
    ],
    [R],
    sides,
  );
  // The stem's fitting at the tack, and the jib's hanks on the stay.
  bronze.box([-0.02, TACK[1] - 0.06, TACK[2] - 0.05], [0.02, TACK[1] + 0.01, TACK[2] + 0.05]);
  for (let v = 0.12; v < 1; v += 0.12) {
    const p: Vec3 = [0, TACK[1] + v * headsails.headsailLuff, TACK[2] + v * RAKE];
    bronze.box(add(p, [-0.012, -0.02, -0.012]), add(p, [0.012, 0.02, 0.012]));
  }
  // The backstay's plate on the transom.
  bronze.box(
    [-0.02, sheer(0) - 0.15, TRANSOM_Z - 0.01],
    [0.02, sheer(0) + 0.05, TRANSOM_Z + 0.008],
  );
  return { rope, bronze, wood };
}

function boom(): { spar: MeshBuilder; iron: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.04],
      [0, 0, rig.foot + 0.08],
    ],
    [0.045],
    D.small ? 10 : 4,
  );
  const iron = new MeshBuilder('iron');
  if (D.small) {
    for (const z of [0.12, rig.foot + 0.02]) {
      iron.tube(
        [
          [0, 0, z - 0.025],
          [0, 0, z + 0.025],
        ],
        [0.049],
        10,
      );
    }
  }
  return { spar, iron };
}

/** The kicking strap, from the boom down to the mast's foot: it swings with the boom. */
function vang(): MeshBuilder {
  const m = new MeshBuilder('rope');
  m.tube(
    [
      [0, -0.04, 0.6],
      [0, mastFootY + 0.12 - rig.boomHeight, 0.07],
    ],
    [0.009],
    D.small ? 5 : 3,
  );
  return m;
}

/** The main's roach, and its head's width at the headboard. */
const ROACH = 0.16;
const HEAD = 0.1;

/** The main's chord at fraction v up the luff, as sail() draws it. */
const chordAt = (v: number): number =>
  rig.foot * (1 - v) + HEAD * v + ROACH * Math.sin(Math.PI * v) * (1 - v) ** 0.3;

/** The heights of the main's reef points, as fractions of its luff: where each reef's tack comes down to the boom. */
const REEF_ROWS = rig.reefs.slice(1).map((share) => 1 - share);

/**
 * The mainsail, flat in the centreline plane at rest: the luff up the
 * mast's after face, the foot along the boom. TEXCOORD_0 maps the sail
 * cloth (the distance along the foot over the foot's length, and the height
 * up the luff); TEXCOORD_1 is (u, v), the fraction of the chord and of the
 * luff, from which the client shapes it (boom angle, twist, camber). A row
 * runs along each reef's points, where the reefed sail folds.
 */
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
        [0, 0.03 + v * rig.luff, 0.04 + along],
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

/** The jib's head's width. */
const JIB_HEAD = 0.05;
const jibChord = (v: number): number => headsails.headsailFoot * (1 - v) + JIB_HEAD * v;

/**
 * The jib, flat in the centreline plane at rest, in its node's frame (at
 * the tack): its luff up the forestay to the head, rake aft of the tack;
 * each height's chord level and aft from the luff, the foot along the deck.
 * TEXCOORD_0 maps the cloth as the main's does; TEXCOORD_1 is (u, v), the
 * fraction of the chord and of the luff, from which the client turns each
 * height's chord about its luff point and cambers it.
 */
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

// --- Keel, rudder and helm ------------------------------------------------------

/**
 * A tapering foil: sections from the root down, each its height, its
 * leading and trailing edges and its thickness; n segments a side, the
 * bottom capped.
 */
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
  // From the root down, each ring clockwise seen from above.
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

/** The bulb: its length, its greatest half-breadth, and its height over its breadth. */
const BULB_LENGTH = 1.05;
const BULB_R = 0.125;
const BULB_FLAT = 0.82;
/** The keel's tip, the bulb's middle: the bulb's bottom is the catalog's draught. */
const keelBottom = (): number => -(hull.hullDraught + foils.boardSpan);
const BULB_Y = keelBottom() + BULB_R * BULB_FLAT;

/**
 * The fin keel, in its node's frame (the keel's station): sheathed in
 * copper, its trailing edge upright and its leading edge raked aft, from
 * inside the canoe body down to the bulb's middle.
 */
function keel(): MeshBuilder {
  const m = new MeshBuilder('copper');
  const root = -keelDepth(uAt(-foils.boardPosition)) + 0.04;
  const c = foils.boardChord;
  const rows = D.small ? 4 : 1;
  const sections = Array.from({ length: rows + 1 }, (_, i) => {
    const f = i / rows;
    const z0 = -c / 2 + 0.17 * f;
    return { y: lerp(root, BULB_Y, f), z0, z1: c / 2, t: 0.12 * (c / 2 - z0) };
  });
  foil(m, sections);
  // Coppered: the sheets' tones on the vertex colours.
  for (let i = 0; i < m.count; i++) {
    const tone = 0.9 + 0.15 * jitter(Math.floor((m.positions[i * 3 + 1] ?? 0) * 3) + 900);
    m.colors.splice(i * 3, 3, COPPER[0] * tone, COPPER[1] * tone, COPPER[2] * tone);
  }
  return m;
}

/** The bulb's breadth along it, s from its nose (0) to its tail (1), fullest a third of the way aft. */
const bulbShape = (s: number): number => s ** 0.45 * (1 - s) ** 0.9;
const BULB_FULLEST = 0.45 / 1.35;

/** The lead bulb under the keel, in the keel node's frame: a torpedo, its nose blunt and its tail drawn out. */
function bulb(): MeshBuilder {
  const m = new MeshBuilder('lead');
  const rings = D.small ? 16 : 4;
  const seg = D.small ? 12 : 4;
  const z0 = -BULB_LENGTH * 0.42;
  const path: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    path.push([0, 0, z0 + s * BULB_LENGTH]);
    radii.push(BULB_R * Math.max(0.02, bulbShape(s) / bulbShape(BULB_FULLEST)));
  }
  m.tube(path, radii, seg);
  // Flattened: its height a share of its breadth, its middle at the keel's tip.
  for (let i = 0; i < m.count; i++) {
    const y = m.positions[i * 3 + 1] ?? 0;
    m.positions[i * 3 + 1] = BULB_Y + y * BULB_FLAT;
  }
  return m;
}

/** The deck at the rudder's stock, and the tiller's head above it. */
const RUDDER_DECK = deckY(0, uAt(foils.rudderPosition));
const RUDDER_HEAD = RUDDER_DECK + 0.05;

/**
 * The rudder, in its node's frame (the stock): a blade hung under the
 * counter, its leading edge a little forward of the stock, from the hull's
 * bottom down to the catalog's depth; its stock up through the deck to the
 * tiller's head.
 */
function rudder(): { blade: MeshBuilder; bronze: MeshBuilder } {
  const m = new MeshBuilder('foil');
  const top = -keelDepth(uAt(foils.rudderPosition)) + 0.03;
  const bottom = -(hull.hullDraught + foils.rudderSpan);
  const c = foils.rudderChord;
  const rows = D.small ? 3 : 1;
  foil(
    m,
    Array.from({ length: rows + 1 }, (_, i) => {
      const f = i / rows;
      const z0 = -0.06 + 0.04 * f;
      const z1 = z0 + lerp(c, c * 0.78, f);
      return { y: lerp(top, bottom, f), z0, z1, t: 0.1 * (z1 - z0) };
    }),
  );
  m.tube(
    [
      [0, top - 0.05, 0],
      [0, RUDDER_HEAD, 0],
    ],
    [0.025],
    D.small ? 8 : 3,
  );
  const bronze = new MeshBuilder('bronze');
  if (D.small) {
    // The stock's collar on the deck, and the tiller's head.
    bronze.tube(
      [
        [0, RUDDER_DECK - 0.01, 0],
        [0, RUDDER_DECK + 0.015, 0],
      ],
      [0.05],
      10,
    );
    bronze.box([-0.032, RUDDER_HEAD - 0.03, -0.05], [0.032, RUDDER_HEAD + 0.03, 0.05]);
  }
  return { blade: m, bronze };
}

/**
 * The extension's hinge: as far from the seat, and as high above the
 * gunwale, as the stage's is; the tiller reaches forward to it from the
 * rudder's head. TILLER_END is its place from the tiller's head.
 */
const HINGE: Vec3 = [
  0,
  GUNWALE[1] + (STAGE.hinge[1] - STAGE.gunwale[1]),
  SEAT_Z + (STAGE.hinge[2] - STAGE.seatZ),
];
const TILLER_END: Vec3 = [0, HINGE[1] - RUDDER_HEAD, HINGE[2] - foils.rudderPosition];

function tiller(): MeshBuilder {
  const m = new MeshBuilder('foil');
  m.tube(
    [[0, 0, 0.03], [0, TILLER_END[1] * 0.4 + 0.02, TILLER_END[2] * 0.45], TILLER_END],
    [0.026, 0.022, 0.016],
    D.small ? 8 : 3,
  );
  return m;
}

/** The tiller extension, hinged at the tiller's end: at rest along it, forward; its grip a knob at its far end. */
const EXTENSION = 1.25;

function extension(): MeshBuilder {
  const m = new MeshBuilder('spar');
  m.tube(
    [
      [0, 0, 0],
      [0, 0, -EXTENSION],
    ],
    [0.012, 0.011],
    6,
  );
  // The hinge's bronze swivel, and the knob.
  m.tube(
    [
      [0, -0.013, 0.012],
      [0, 0.013, 0.012],
    ],
    [0.015],
    6,
    srgb(0.74, 0.5, 0.24),
  );
  m.tube(
    [
      [0, 0, -EXTENSION + 0.01],
      [0, 0, -EXTENSION - 0.02],
    ],
    [0.017],
    6,
  );
  return m;
}

/** The mainsheet's blocks, under the boom and on the cockpit's floor, just forward of the seat. */
const SHEET_Z = SEAT_Z - 0.05;
const SHEET_BLOCK_Y = COCKPIT_FLOOR + 0.06;

function sheetBlock(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.box([-0.022, -0.035, -0.04], [0.022, 0.035, 0.04]);
  m.tube(
    [
      [0, -0.06, 0],
      [0, -0.035, 0],
    ],
    [0.013],
    6,
  );
  return m;
}

/** The bronze on the hull and deck: the mast's collar, the stem band, the jib's sheet tracks and the mooring cleats. */
function fittings(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.tube(
    [
      [0, mastFootY - 0.01, MAST_Z],
      [0, mastFootY + 0.06, MAST_Z],
    ],
    [MAST_FOOT_R + 0.012],
    12,
  );
  // The stem band, from the forefoot up the stem.
  const band: Vec3[] = [];
  for (let i = 0; i <= 8; i++) {
    const u = 0.93 + (0.07 * i) / 8;
    band.push([0, -keelDepth(u) + (i === 0 ? 0.02 : 0), zAt(u) - 0.006]);
  }
  m.tube(band, [0.014], 6);
  for (const s of [1, -1]) {
    // The jib's sheet tracks, on the side decks beside the cuddy.
    const x = s * (cuddyWidth(0) + 0.14);
    m.box(
      [x - 0.012, deckY(x, uAt(0)) - 0.005, -0.75],
      [x + 0.012, deckY(x, uAt(-0.2)) + 0.014, 0.2],
    );
    // A mooring cleat on each quarter.
    const z = COCKPIT_AFT + 0.22;
    const cx = s * 0.55;
    const y = deckY(cx, uAt(z));
    m.box([cx - 0.015, y - 0.005, z - 0.09], [cx + 0.015, y + 0.03, z + 0.09]);
    m.box([cx - 0.012, y + 0.03, z - 0.13], [cx + 0.012, y + 0.05, z + 0.13]);
  }
  // A mooring cleat on the foredeck.
  const z = -3.2;
  const y = deckY(0, uAt(z));
  m.box([-0.015, y - 0.005, z - 0.09], [0.015, y + 0.03, z + 0.09]);
  m.box([-0.012, y + 0.03, z - 0.13], [0.012, y + 0.05, z + 0.13]);
  return m;
}

function gooseneck(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.box([-0.04, -0.04, -0.03], [0.04, 0.04, 0.08]);
  m.tube(
    [
      [0, 0, rig.foot + 0.06],
      [0, 0, rig.foot + 0.12],
    ],
    [0.04],
    8,
  );
  return m;
}

// --- The model ---------------------------------------------------------------

/** The far model's deck: plain, a few strips across. */
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
//
// The sea is not drawn inside a hull. The game keeps it out with a volume it
// can test a point against cheaply: stations along the hull, each with the
// half-beam at the waterline and the depth of the bottom, the sides between
// narrowing below the waterline as a superellipse does. They are measured
// here from the hull's own mesh, so the volume cannot drift from the model.

/** Stations in the hull's volume. */
const VOLUME_STATIONS = 8;

/** Where the plane z = at cuts a mesh's triangles: the cuts' end points, x and y. */
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

/** The widest a section is at height y: the greatest |x| where its cuts cross it. */
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

/** The exponent n of the superellipse whose half-width at half its depth is r of its width: (1 − ½ⁿ)^(1/n) = r. */
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

/**
 * The hull's volume, measured from its mesh: stations from where the
 * counter leaves the water to where the stem does, each [z, half-beam at
 * the waterline, depth of the bottom], in metres in the boat's frame, and
 * the exponent of the sections' narrowing below the waterline.
 */
function hullVolume(m: MeshBuilder): { stations: number[][]; bilge: number } {
  // The waterline's ends: the furthest aft and forward the hull is below it.
  let fore = TRANSOM_Z;
  let aft = BOW_Z;
  for (let i = 0; i < m.count; i++) {
    if ((m.positions[i * 3 + 1] ?? 0) < 0) {
      fore = Math.min(fore, m.positions[i * 3 + 2] ?? 0);
      aft = Math.max(aft, m.positions[i * 3 + 2] ?? 0);
    }
  }
  const round = (v: number): number => Math.round(v * 1e4) / 1e4;
  const out: number[][] = [];
  let bilge = 0;
  let measured = 0;
  for (let i = 0; i < VOLUME_STATIONS; i++) {
    const z = aft + ((fore - aft) * i) / (VOLUME_STATIONS - 1);
    // The ends are the waterline's: no beam, no depth.
    const end = i === 0 || i === VOLUME_STATIONS - 1;
    const cuts = end ? [] : sectionAt(m, z);
    let depth = 0;
    for (const cut of cuts) {
      for (const e of cut) {
        depth = Math.max(depth, -e[1]);
      }
    }
    const beam = halfBeamAt(cuts, 0);
    out.push([round(z), round(beam), round(depth)]);
    if (depth > 0.02 && beam > 0) {
      bilge += bilgeExponent(halfBeamAt(cuts, -depth / 2) / beam);
      measured++;
    }
  }
  if (measured === 0) {
    throw new Error('the hull has no section in the water');
  }
  return { stations: out, bilge: round(bilge / measured) };
}

/**
 * The hull as a solid, for what keeps a sailor out of it: stations from the
 * transom to the stem, each [z, half-beam at the sheer, the sheer's height,
 * the keel's depth], whose sections are superellipses of the exponent; the
 * deck at the sheer; and the cockpit, a box open above its floor.
 */
function solid(): Record<string, unknown> {
  const round = (x: number): number => Math.round(x * 10000) / 10000;
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const u = i / 20;
      return [round(zAt(u)), round(halfBeam(u)), round(sheer(u)), round(keelDepth(u))];
    }),
    exponent: SECTION,
    cockpit: {
      fore: round(COCKPIT_FORE),
      aft: round(COCKPIT_AFT),
      halfWidth: round(COCKPIT_HALF_WIDTH),
      floor: round(COCKPIT_FLOOR),
    },
  };
}

/**
 * Where the sailor sits here against where it sits in the stage's boat:
 * the gunwale at the seat's station, starboard, less the stage's. A
 * sailor's clip, placed in the stage's boat on the starboard side deck,
 * is placed here moved by it (on the port side deck by its mirror).
 */
const RESTAGE: Vec3 = [
  GUNWALE[0] - STAGE.gunwale[0],
  GUNWALE[1] - STAGE.gunwale[1],
  SEAT_Z - STAGE.seatZ,
].map((v) => Math.round(v * 1e5) / 1e5) as Vec3;

/** The boat's nodes at the detail in force. */
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
  const house = cuddy();
  const hullParts = [
    shell.copper.primitive({ colors: true }),
    shell.paint.primitive({ colors: true }),
    shell.topsides.primitive({ colors: true }),
    deckMesh.primitive({ colors: true }),
    rails.primitive({ colors: true }),
    house.wood.primitive({ colors: true }),
    house.roof.primitive(),
  ];
  const masts = mast();
  const mastParts = [masts.spar.primitive()];
  const spars = boom();
  const boomParts = [spars.spar.primitive()];
  if (D.small) {
    hullParts.push(
      house.glass.primitive({ colors: true }),
      house.brass.primitive(),
      fittings().primitive(),
    );
    mastParts.push(masts.iron.primitive());
    // The standing rigging stays with the hull: in the mast's node, its frame.
    const r = rigging();
    for (const b of [r.rope, r.bronze, r.wood]) {
      for (let i = 0; i < b.count; i++) {
        b.positions[i * 3 + 2] = (b.positions[i * 3 + 2] ?? 0) - MAST_Z;
      }
    }
    mastParts.push(r.rope.primitive(), r.bronze.primitive(), r.wood.primitive({ colors: true }));
    boomParts.push(spars.iron.primitive(), gooseneck().primitive());
  }
  const rudderParts = rudder();
  const nodes: NodeDef[] = [
    {
      name: 'hull',
      primitives: hullParts,
      extras: { waterline, plan: { deviation: planDeviation() }, solid: solid() },
    },
    { name: 'mast', translation: [0, 0, MAST_Z], primitives: mastParts },
    {
      name: 'boom',
      translation: [0, rig.boomHeight, MAST_Z],
      primitives: boomParts,
      children: [
        { name: 'vang', primitives: [vang().primitive()] },
        // The mainsheet's block under the boom, over the one on the floor.
        ...(D.small
          ? [
              {
                name: 'sheet-boom',
                translation: [0, -0.07, SHEET_Z - MAST_Z] as Vec3,
                primitives: [sheetBlock().primitive()],
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
    // The jib at its tack: its luff up the forestay, its head rake aft of the tack.
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
    // The lantern's node is named as the light it shows, and is where the
    // light is seen from.
    const l = lantern();
    nodes.push({
      name: 'tricolour',
      translation: [0, MAST_TOP + LANTERN_Y, MAST_Z],
      primitives: [l.brass.primitive(), l.glass.primitive({ colors: true })],
    });
  }
  const rudderPrims = [rudderParts.blade.primitive()];
  if (D.small) {
    rudderPrims.push(rudderParts.bronze.primitive());
  }
  nodes.push(
    {
      name: 'rudder',
      translation: [0, 0, foils.rudderPosition],
      primitives: rudderPrims,
      children: [
        {
          name: 'tiller',
          translation: [0, RUDDER_HEAD, 0],
          primitives: [tiller().primitive()],
          children: D.small
            ? [
                {
                  name: 'extension',
                  translation: TILLER_END,
                  primitives: [extension().primitive()],
                  children: [{ name: 'grip', translation: [0, 0, -EXTENSION] }],
                },
              ]
            : [],
        },
      ],
    },
    // The fin keel, fixed, and its bulb.
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [keel().primitive({ colors: true })],
      children: [{ name: 'bulb', primitives: [bulb().primitive()] }],
    },
    // Where the sailor sits: on the side deck aft, at the seated height;
    // and how its clips, placed in the stage's boat, are moved here.
    {
      name: 'sailor',
      translation: [0, hull.centreOfGravity + sailor.sailorSeatHeight, SEAT_Z],
      extras: { restage: RESTAGE },
    },
    // What the sailor holds and sits by, on the starboard side (the port
    // side's are their mirror): the gunwale at the seat's station, and
    // where the keel leaves the bottom.
    { name: 'gunwale', translation: GUNWALE },
    // The deck's edge where the crew sit on the rail, legs over the side.
    { name: 'rail', translation: RAIL },
    {
      name: 'board-root',
      translation: [0, -keelDepth(uAt(-foils.boardPosition)), -foils.boardPosition],
    },
  );
  if (D.small) {
    nodes.push({
      name: 'sheet',
      translation: [0, SHEET_BLOCK_Y, SHEET_Z],
      primitives: [sheetBlock().primitive()],
    });
  }
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
process.stdout.write(
  `wrote art/${MODEL} and art/${FAR_MODEL}: bow ${BOW_Z.toFixed(2)} m, transom ${TRANSOM_Z.toFixed(2)} m, ` +
    `seat moved ${RESTAGE.map((v) => v.toFixed(3)).join(', ')} m from the stage's\n`,
);

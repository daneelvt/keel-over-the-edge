// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The catamaran: a cruising catamaran of our time, of nearly thirteen
// metres, built by a shipwright of the period. Her form is the modern boat's:
// two long hulls with plumb bows, a knuckle above the water and flared
// topsides, joined by a bridgedeck that carries a saloon and an aft cockpit
// under a hard roof; a fixed mini keel and a suspended rudder under each
// hull; one wheel at a raised helm station to port, up a stair from the
// cockpit, with a double seat behind it; the cockpit's L-shaped bench and
// table to starboard, a lounger to port and a bench along the aft
// crossbeam; nets between the bows forward of the saloon; a fractional
// sloop with one level of spreaders and no backstay, a fully battened main
// on a long boom whose sheet runs on a horse across the roof's after edge,
// and a self-tacking jib on its own horse before the mast.
//
// Her look is the period's, as two hulls cramped together with timbers
// under a railed platform were built: carvel planking, its topsides in the
// paint her sailor chooses, with a dark sheer strake, a cream boot top and a
// copper bottom; round bronze portlights; laid decks; oak beams; a
// varnished round-house of small-paned windows all round with wooden
// dead-lights, two glazed doors in its after bulkhead drawn shut, and its
// planked roof carried aft over the cockpit on varnished posts as a poop;
// a planked helm platform with a varnished settle, a spoked wheel on a
// wooden console with a brass hood, a companion ladder of oak with a bronze
// rail, two small timber capstans; teak benches, a varnished table;
// iron horses, stanchions, pulpits and pushpits with hemp lifelines; hemp
// netting; a spruce rig on oak cross-trees with tarred hemp shrouds on
// deadeyes; a flax main in its lazy bag and a flax jib on a roller of pine;
// copper-sheathed oak keels and rudders; oak steps on the transoms; an
// iron anchor at a timber roller; brass lanterns with coloured glass on the
// forward decks and a poop-lantern on an iron crank at the roof's after
// edge. No engine, no propeller.
//
// Every dimension the physics knows comes from the catalog, so what is drawn
// is what is sailed: length and beam, the plan at the sheer, the hulls'
// spacing, the canoe bodies' draught, the mast's place, the boom's height,
// the main's luff and foot, the jib's luff, foot, tack and tack's height,
// the keels' and the rudders' places, spans and chords, the helm's height.
// The rest (sheer, sections, the bridgedeck, the round-house, the cockpit,
// the rigging) are this script's own, the 42's form as her drawings and
// photographs show it, estimates all.
//
// From the model the script also takes what the physics reads of her shape
// (it prints them, for the catalog): both hulls' waterline beam, waterplane
// and its second moment, and the wetted area; and the sections and
// appendages tools/lever heels in still water for her righting lever (the
// hull's `lever` data), each section the starboard half of the watertight
// body, the bridgedeck and the round-house over it included.
//
// It builds the boat twice from the same lines: in full, and the far model,
// with few segments, no seams, panes, rigging, lifelines, nets' mesh,
// telltales, pennant, lanterns or fittings, plain decks, and the wheel as a
// disc. The catalog's art.model and art.far name them.
//
//   node art/boats/catamaran/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PENNANT_WIDTH, pennant, STAFF_TOP, telltales } from '../../lib/fittings.ts';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { add, cross, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../../lib/mesh.ts';

/** The models this script writes, as the catalog's art.model and art.far name them. */
const MODEL = 'boats/catamaran.glb';
const FAR_MODEL = 'boats/catamaran.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along each hull: a multiple of ten, so the outline's points are among them. */
  stations: number;
  copperRows: number;
  strakes: number;
  seams: boolean;
  plankedDeck: boolean;
  round: number;
  mastStations: number;
  sailRows: number;
  sailCols: number;
  jibRows: number;
  jibCols: number;
  /** Segments round the wheel's rim. */
  rim: number;
  /** Strands of the nets each way; 0 for a plain plate. */
  netStrands: number;
  /** Rigging, lifelines, telltales, pennant, lanterns, panes, the cockpit's and decks' fittings. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 50,
  copperRows: 4,
  strakes: 7,
  seams: true,
  plankedDeck: true,
  round: 10,
  mastStations: 12,
  sailRows: 24,
  sailCols: 10,
  jibRows: 20,
  jibCols: 7,
  rim: 24,
  netStrands: 22,
  small: true,
};

const FAR: Detail = {
  stations: 10,
  copperRows: 1,
  strakes: 2,
  seams: false,
  plankedDeck: false,
  round: 5,
  mastStations: 1,
  sailRows: 8,
  sailCols: 3,
  jibRows: 6,
  jibCols: 2,
  rim: 10,
  netStrands: 0,
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
    hulls: { hullSpacing: number };
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
if (sailor.hikeReach !== 0 || sailor.leeReach !== 0) {
  throw new Error('her one sailor stays at her one wheel: hikeReach and leeReach are 0');
}

// --- The lines -------------------------------------------------------------------
//
// The boat's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bows are -z).
// Each hull is built about its own centreline, half the spacing out: the
// starboard one, and the port one its mirror.

const L = boat.lengthOverall;
const TRANSOM_Z = hull.transom;
const BOW_Z = -hull.stem;
/** Each hull's centreline, out from the boat's. */
const C = boat.physics.hulls.hullSpacing / 2;

/** Station u runs from the transoms (0) to the bows (1). */
const zAt = (u: number): number => TRANSOM_Z - u * L;
const uAt = (z: number): number => (TRANSOM_Z - z) / L;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The catalog's outline: the plan at the sheer, the hulls' outer sides, ending in the bows' points half the spacing out. */
function outline(u: number): number {
  const o = hull.outline;
  const x = Math.min(1, Math.max(0, u)) * (o.length - 1);
  const i = Math.min(o.length - 2, Math.floor(x));
  const f = x - i;
  return (o[i] ?? 0) * (1 - f) + (o[i + 1] ?? 0) * f;
}

/** Each hull's half-breadth at its sheer, about its own centreline: the outline outboard, its mirror inboard. */
const deckHalf = (u: number): number => Math.max(0, outline(u) - C);

/** Height of the sheer above the waterline: low aft over the transoms' steps, rising to high, plumb bows. */
const sheer = (u: number): number => 1.32 + 0.1 * u + 0.28 * u ** 3;

/** Where the canoe bodies are deepest, and how far above the water the bottom is at the transom and at the stem's foot. */
const DEEPEST = 0.45;
const TRANSOM_CLEAR = 0.05;
const STEM_FOOT = 0.05;

/**
 * Depth of a hull's keel line below the waterline: deepest a little aft of
 * amidships, rising in a long run to the transom just clear of the water,
 * and forward to the foot of the plumb stem just below it.
 */
function keelDepth(u: number): number {
  const d = hull.hullDraught;
  if (u <= DEEPEST) {
    return d - (d + TRANSOM_CLEAR) * ((DEEPEST - u) / DEEPEST) ** 2;
  }
  return d - (d - STEM_FOOT) * ((u - DEEPEST) / (1 - DEEPEST)) ** 2.4;
}

/** The knuckle's height above the water, where the bottom's curve meets the flared topsides, and its share of the sheer's half-breadth. */
const KNUCKLE = 0.42;
const KNUCKLE_SHARE = 0.665;
const knuckleHalf = (u: number): number => KNUCKLE_SHARE * deckHalf(u);

/** The bottom's exponent: firm and rounded aft, a fine V forward. */
const bottomN = (u: number): number => lerp(2.5, 1.6, smoothstep(0.35, 1, u));

/** How far up the girth the knuckle is. */
const KNUCKLE_G = 0.62;

/**
 * A point of the starboard hull's section at station u, girth fraction g
 * from the keel (0) to the sheer (1), on its outer (s = 1) or inner (s = −1)
 * side: below the knuckle a superellipse's quarter, symmetric; above it the
 * topsides flaring out straight to the sheer.
 */
function section(u: number, g: number, s: number): Vec3 {
  const bottom = -keelDepth(u);
  const yk = Math.max(KNUCKLE, bottom + 0.05);
  const z = zAt(u);
  if (g <= KNUCKLE_G) {
    const a = ((g / KNUCKLE_G) * Math.PI) / 2;
    const e = 2 / bottomN(u);
    return [
      C + s * knuckleHalf(u) * Math.sin(a) ** e,
      bottom + (yk - bottom) * (1 - Math.cos(a) ** e),
      z,
    ];
  }
  const t = (g - KNUCKLE_G) / (1 - KNUCKLE_G);
  return [C + s * lerp(knuckleHalf(u), deckHalf(u), t), lerp(yk, sheer(u), t), z];
}

/** The girth fraction at height y on the section at u: 0 below the keel, 1 above the sheer. */
function girthAt(u: number, y: number): number {
  if (y <= -keelDepth(u)) {
    return 0;
  }
  if (y >= sheer(u)) {
    return 1;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (section(u, m, 1)[1] < y) {
      lo = m;
    } else {
      hi = m;
    }
  }
  return (lo + hi) / 2;
}

/** A hull's half-breadth at height y at station u, about its own centreline (0 below its keel). */
function breadthAt(u: number, y: number): number {
  const g = girthAt(u, y);
  return g <= 0 ? 0 : section(u, g, 1)[0] - C;
}

/** The hull's outward normal at u, g on side s. */
function surfaceNormal(at: number, g: number, s: number): Vec3 {
  const u = Math.min(Math.max(at, 0.002), 0.998);
  const h = 1e-4;
  const alongG = sub(section(u, Math.min(1, g + h), s), section(u, Math.max(0, g - h), s));
  const alongU = sub(section(Math.min(1, u + h), g, s), section(Math.max(0, u - h), g, s));
  const n = normalize(cross(alongU, alongG));
  const p = section(u, g, s);
  const out: Vec3 = [p[0] - C, p[1] - 0.2, 0];
  return n[0] * out[0] + n[1] * out[1] < 0 ? scale(n, -1) : n;
}

/** Stations along a hull, from the transom (0) to the bow (1). */
const stations = (n = D.stations): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

// --- The bridgedeck, the round-house and the cockpit's plan ---------------------------
//
// The bridgedeck spans between the hulls' inner sides from the nacelle
// forward to the aft crossbeam, its underside clear of the water. On it,
// forward, a locker deck; the round-house from there to its after bulkhead,
// the after bulkhead's port end set forward for the helm's platform; and
// aft of it the cockpit, open down to its sole, to the aft crossbeam.

/** The bridgedeck's underside's height, and its after end (the aft crossbeam's after face). */
const UNDERSIDE = 0.8;
const BRIDGE_AFT = 4.75;
/** The nacelle's foot under the bridgedeck's fore end, and the locker deck's fore edge above it. */
const NACELLE_FOOT = -4.2;
const LOCKERS_FORE = -4.45;
const LOCKERS_Y = 1.5;
/** The round-house: its front's foot, where its raked front meets the roof, its sides, its after bulkhead; the platform's notch's inboard side and fore end. */
const HOUSE_FORE = -3.35;
const ROOF_FRONT = -2.45;
const HOUSE_SIDE = 3.3;
const HOUSE_AFT = 1.65;
const NOTCH_IN = -1.0;
const NOTCH_FORE = 1.2;
/** The roof: its eaves' height over the round-house and the cockpit, lower at its front; its crown; its after edge; how far it overhangs the sides. */
const EAVES = 3.4;
const EAVES_FRONT = 3.17;
const ROOF_CROWN = 0.06;
const ROOF_AFT = BRIDGE_AFT;
const ROOF_OVER = 0.06;
const ROOF_THICK = 0.08;
/** The cockpit's sole, level from the after bulkhead to the aft crossbeam. */
const SOLE = 1.15;

/** The roof's height at x across, z along. */
function roofY(x: number, z: number): number {
  const e = lerp(EAVES_FRONT, EAVES, smoothstep(ROOF_FRONT, ROOF_FRONT + 1.1, z));
  const a = Math.min(1, Math.abs(x) / (HOUSE_SIDE + ROOF_OVER));
  return e + ROOF_CROWN * (1 - a * a);
}

/** The deck's height at x (out from the boat's centreline) at station u: crowned across its hull. */
const DECK_CROWN = 0.03;
function deckY(x: number, u: number): number {
  const half = deckHalf(u);
  const t = half > 1e-6 ? Math.min(1, Math.abs(Math.abs(x) - C) / half) : 1;
  return sheer(u) + DECK_CROWN * (1 - t * t);
}
const deckAt = (x: number, z: number): number => deckY(x, uAt(z));

/** A hull's inner side at height y at z, out from the boat's centreline. */
const innerAt = (z: number, y: number): number => C - breadthAt(uAt(z), y);

// --- The helm and the cockpit's seats -----------------------------------------
//
// The helm station is a platform on the port side against the round-house's
// after bulkhead, up a companion ladder from the cockpit along its inboard
// side; on it a console with the wheel aft of it, the helm standing aft of
// the wheel, and a settle for two behind. In the cockpit, the L-shaped bench
// round the table to starboard, its forward leg along the bulkhead; the
// bench along the aft crossbeam, its back a turned rail; the lounger to port
// aft of the ladder's foot.

/** The platform: its outer and inner sides, its fore and after ends, its top; and the landing at the ladder's head, inboard of it. */
const PLAT_OUT = -3.3;
const PLAT_IN = -1.6;
const PLAT_FORE = NOTCH_FORE;
const PLAT_AFT = 2.95;
const PLAT_Y = 2.15;
const LANDING_AFT = 2.65;
/** The ladder: inboard of the platform, from its foot on the sole aft to its head at the landing; four treads. */
const LADDER_IN = NOTCH_IN;
const LADDER_FOOT = 3.65;
const TREADS = 4;
const LADDER_RAIL = LADDER_IN + 0.03;
const LANDING_RAIL = LADDER_IN - 0.005;
/** The wheel: its stance on the platform, its rim's size, its hub ahead of and above the stance. */
const STANCE: Vec3 = [-2.6, PLAT_Y, 2.15];
const WHEEL_RADIUS = 0.4;
const WHEEL_HANDLE = 0.08;
const WHEEL_SPOKES = 8;
const WHEEL_AHEAD = 0.55;
const WHEEL_UP = 1.05;
const HUB: Vec3 = [STANCE[0], STANCE[1] + WHEEL_UP, STANCE[2] - WHEEL_AHEAD];
/** The console before the wheel. */
const CONSOLE_AFT = NOTCH_FORE + 0.07;
/**
 * The settle: its front edge, its seat's after end where its back stands,
 * its back's height, its top; from the platform's outer side to near its
 * inner.
 */
const SETTLE_FORE = 2.5;
const SETTLE_AFT = PLAT_AFT - 0.06;
const SETTLE_BACK = 0.42;
const SETTLE_TOP = PLAT_Y + 0.45;
const SETTLE_OUT = -3.25;
const SETTLE_IN = -1.75;
/** The cockpit's seats' tops, above the sole. */
const SEAT_TOP = SOLE + 0.45;
/**
 * The L-shaped bench: its long leg along the starboard side, its front
 * edge over the hull's inner side (so the legs of those on it fall clear of
 * the hull's deck to the sole), its forward leg along the bulkhead.
 */
const LBENCH_FRONT = 1.75;
const LBENCH_OUT = 2.25;
const LBENCH_LEG = 2.15;
const LBENCH_INNER = 0.55;
const LBENCH_AFT = 4.05;
/** The table: 1.4 m by 0.72, its top at a table's height above the sole. */
const TABLE: { x0: number; x1: number; z0: number; z1: number; y: number } = {
  x0: 0.7,
  x1: 1.42,
  z0: 2.45,
  z1: 3.85,
  y: SOLE + 0.72,
};
/**
 * The bench along the aft crossbeam: its front edge, its back, its ends;
 * short of the lounger, so the legs of those on it have the sole before it.
 */
const AFT_FRONT = 4.2;
const AFT_BACK = 4.65;
const AFT_PORT = -0.75;
const AFT_STAR = LBENCH_OUT;
/** The lounger: to port, aft of the ladder's foot, along the hull's side. */
const LOUNGER_FRONT = -1.5;
const LOUNGER_OUT = -2.65;
const LOUNGER_FORE = 3.85;
const LOUNGER_AFT = AFT_BACK;
const LOUNGER_TOP = SOLE + 0.4;
/** The round-house's doors: two leaves in its after bulkhead. */
const DOOR_PORT = -0.75;
const DOOR_STAR = 0.55;

/** How far onto a seat from its front edge a seated station is, m: the seat's edge under the thighs. */
const ON_SEAT = 0.04;

/** The people's stations, in the order seats fill: the helm, beside the helm, the L-bench, the aft bench, the lounger. */
const STATIONS: { at: Vec3; pose: string; facing: number }[] = [
  { at: STANCE, pose: 'standing', facing: 0 },
  { at: [-1.95, SETTLE_TOP, SETTLE_FORE + ON_SEAT], pose: 'seated', facing: 0 },
  { at: [0.85, SEAT_TOP, LBENCH_LEG - ON_SEAT], pose: 'seated', facing: 180 },
  { at: [1.45, SEAT_TOP, LBENCH_LEG - ON_SEAT], pose: 'seated', facing: 180 },
  { at: [LBENCH_FRONT + ON_SEAT, SEAT_TOP, 2.8], pose: 'seated', facing: 270 },
  { at: [LBENCH_FRONT + ON_SEAT, SEAT_TOP, 3.35], pose: 'seated', facing: 270 },
  { at: [LBENCH_FRONT + ON_SEAT, SEAT_TOP, 3.9], pose: 'seated', facing: 270 },
  { at: [0.25, SEAT_TOP, AFT_FRONT + ON_SEAT], pose: 'seated', facing: 0 },
  { at: [0.85, SEAT_TOP, AFT_FRONT + ON_SEAT], pose: 'seated', facing: 0 },
  { at: [1.45, SEAT_TOP, AFT_FRONT + ON_SEAT], pose: 'seated', facing: 0 },
  { at: [LOUNGER_FRONT - ON_SEAT, LOUNGER_TOP, 4.05], pose: 'seated', facing: 90 },
  { at: [LOUNGER_FRONT - ON_SEAT, LOUNGER_TOP, 4.5], pose: 'seated', facing: 90 },
];

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'paint', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  // The topsides, in the paint the boat's sailor chooses.
  { name: 'topsides', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'copper', color: [1, 1, 1], roughness: 0.42, metalness: 0.75 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.5, metalness: 0 },
  // The roof's laid planks: nobody walks on them.
  { name: 'roof', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'varnish', color: [1, 1, 1], roughness: 0.3, metalness: 0 },
  // Oak and lignum vitae, oiled: the beams, capstans, cleats, bitts, steps and the anchor's stock.
  { name: 'oak', color: [1, 1, 1], roughness: 0.6, metalness: 0 },
  { name: 'spar', color: srgb(0.82, 0.63, 0.36), roughness: 0.35, metalness: 0 },
  { name: 'iron', color: srgb(0.17, 0.17, 0.18), roughness: 0.5, metalness: 0.6 },
  { name: 'flax', color: srgb(0.93, 0.89, 0.78), roughness: 0.85, metalness: 0, doubleSided: true },
  { name: 'bronze', color: srgb(0.74, 0.5, 0.24), roughness: 0.35, metalness: 0.9 },
  { name: 'rope', color: srgb(0.2, 0.15, 0.1), roughness: 0.9, metalness: 0 },
  // The nets: tarred hemp, drawn as rope is.
  { name: 'net', color: srgb(0.2, 0.15, 0.1), roughness: 0.9, metalness: 0, doubleSided: true },
  { name: 'foil', color: srgb(0.5, 0.3, 0.14), roughness: 0.35, metalness: 0 },
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

const SHEER_STRAKE = srgb(0.165, 0.133, 0.106);
const BOOT = srgb(0.894, 0.851, 0.749);
const WHITE_LEAD = srgb(0.9, 0.88, 0.82);
const COPPER = srgb(0.69, 0.424, 0.25);
const VERDIGRIS = srgb(0.36, 0.52, 0.42);
const BOOT_FROM = 0.03;
const BOOT_TO = 0.13;
const MAHOGANY = srgb(0.5, 0.25, 0.13);
const DECK = srgb(0.86, 0.76, 0.58);
const TEAK = srgb(0.72, 0.52, 0.32);
const VARNISH = srgb(0.55, 0.3, 0.15);
const OAK = srgb(0.52, 0.38, 0.22);
const LIGNUM = srgb(0.36, 0.27, 0.16);
const GLASS = srgb(0.1, 0.14, 0.17);
const WOOD = srgb(0.48, 0.28, 0.14);

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

/** A box between two corners in one colour; skipped if empty. */
function box(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3): void {
  const lo: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  if (hi[0] - lo[0] > 1e-6 && hi[1] - lo[1] > 1e-6 && hi[2] - lo[2] > 1e-6) {
    m.box(lo, hi, c);
  }
}

// --- The planking ------------------------------------------------------------

/** A band of the starboard hull's side s between two girth curves, in rows; each vertex coloured by colour(row, station). */
function band(
  m: MeshBuilder,
  s: number,
  from: (u: number) => number,
  to: (u: number) => number,
  rows: number[],
  colour: (row: number, i: number) => Vec3,
): void {
  const grid: number[][] = rows.map(() => []);
  stations().forEach((u, i) => {
    const g0 = from(u);
    const g1 = to(u);
    rows.forEach((f, r) => {
      const g = g0 + (g1 - g0) * f;
      const k = m.vertex(section(u, g, s), colour(r, i), [f, u]);
      m.normal(k, surfaceNormal(u, g, s));
      (grid[r] as number[]).push(k);
    });
  });
  for (let r = 0; r + 1 < grid.length; r++) {
    const lo = grid[r] as number[];
    const hi = grid[r + 1] as number[];
    for (let i = 0; i + 1 < lo.length; i++) {
      const out = surfaceNormal(stations()[i] as number, (from(0.5) + to(0.5)) / 2, s);
      m.triFacing(lo[i] as number, lo[i + 1] as number, hi[i + 1] as number, [
        out[0],
        out[1],
        0.0001,
      ]);
      m.triFacing(lo[i] as number, hi[i + 1] as number, hi[i] as number, [out[0], out[1], 0.0001]);
    }
  }
}

/** The starboard hull's shell, both its sides: the copper bottom, the boot top and the sheer strake in paint, the topsides between. */
function planking(): { copper: MeshBuilder; paint: MeshBuilder; topsides: MeshBuilder } {
  const copper = new MeshBuilder('copper');
  const paint = new MeshBuilder('paint');
  const topsides = new MeshBuilder('topsides');
  const bootFrom = (u: number): number => girthAt(u, BOOT_FROM);
  const bootTo = (u: number): number => girthAt(u, BOOT_TO);
  const rows = Array.from({ length: D.copperRows + 1 }, (_, i) => i / D.copperRows);
  const SHEER_FROM = 0.9;
  for (const s of [1, -1]) {
    band(
      copper,
      s,
      () => 0,
      bootFrom,
      rows,
      (r, i) => {
        const sheet = Math.floor((i * L) / D.stations / 1.2) * 7 + r + (s > 0 ? 0 : 50);
        const tone = 0.88 + 0.2 * jitter(sheet + 300);
        return shade(mix(COPPER, VERDIGRIS, jitter(sheet + 700) > 0.85 ? 0.35 : 0), tone);
      },
    );
    band(paint, s, bootFrom, bootTo, [0, 1], () => BOOT);
    const seam = D.seams ? [0, 0.08, 1] : [0, 1];
    const edge = (k: number): number => (k >= D.strakes ? 1 : (SHEER_FROM * k) / (D.strakes - 1));
    for (let k = 0; k < D.strakes; k++) {
      const f0 = edge(k);
      const f1 = edge(k + 1);
      const sheerStrake = k === D.strakes - 1;
      const base: Vec3 = sheerStrake ? SHEER_STRAKE : [1, 1, 1];
      const tone = 0.94 + 0.12 * jitter(k + 40 + (s > 0 ? 0 : 20));
      band(
        sheerStrake ? paint : topsides,
        s,
        (u) => lerp(bootTo(u), 1, f0),
        (u) => lerp(bootTo(u), 1, f1),
        seam,
        (r) => shade(base, D.seams && r === 0 ? tone * 0.55 : tone),
      );
    }
  }
  transom(paint);
  return { copper, paint, topsides };
}

/** The transom: varnished mahogany across the hull's after end, keel to sheer. */
function transom(m: MeshBuilder): void {
  const n = 2 * D.round;
  const ring: number[] = [];
  for (let i = 0; i <= n; i++) {
    ring.push(m.vertex(section(0, i / n, 1), MAHOGANY));
  }
  for (let i = n - 1; i >= 1; i--) {
    ring.push(m.vertex(section(0, i / n, -1), MAHOGANY));
  }
  const mid = m.vertex([C, (sheer(0) - keelDepth(0)) / 2, TRANSOM_Z], MAHOGANY);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[(i + 1) % ring.length] as number, [0, 0, 1]);
  }
}

/** A rubbing strake along each side just below the sheer, varnished. */
function rubrails(m: MeshBuilder): void {
  const c = shade(MAHOGANY, 0.7);
  for (const s of [1, -1]) {
    const path: Vec3[] = stations(D.stations / 2)
      .filter((u) => u < 0.99)
      .map((u) => [C + s * (deckHalf(u) + 0.008), sheer(u) - 0.02, zAt(u)]);
    m.tube(path, [0.022], D.small ? 6 : 3, c);
  }
}

/** Round bronze portlights along each hull's outer topsides, each with its glass. */
const PORTLIGHTS = [-4.6, -3.7, -2.4, -1.5, -0.6, 2.4, 3.3];

function portlights(): { bronze: MeshBuilder; glass: MeshBuilder } {
  const bronze = new MeshBuilder('bronze');
  const glass = new MeshBuilder('glass');
  for (const z of PORTLIGHTS) {
    const u = uAt(z);
    const g = girthAt(u, sheer(u) - 0.42);
    const p = section(u, g, 1);
    const n = surfaceNormal(u, g, 1);
    bronze.tube([add(p, scale(n, -0.005)), add(p, scale(n, 0.02))], [0.085], 12);
    glass.tube([add(p, scale(n, 0.012)), add(p, scale(n, 0.024))], [0.062], 12, GLASS);
  }
  return { bronze, glass };
}

// --- The decks -------------------------------------------------------------------

/** The starboard hull's deck: laid planks fore and aft, their seams payed dark, crowned from its inner edge to its outer. */
function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const n = D.plankedDeck ? 14 : 2;
  const cols: number[][] = Array.from({ length: n + 1 }, () => []);
  for (const u of stations()) {
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      const x = C - deckHalf(u) + f * 2 * deckHalf(u);
      const tone = 0.92 + 0.12 * jitter(Math.floor(j / 2) * 17);
      const seam = D.plankedDeck && j % 2 === 0 && j > 0 && j < n ? 0.55 : 1;
      (cols[j] as number[]).push(
        m.vertex([x, deckY(x, u), zAt(u)], shade(DECK, tone * seam), [x, u]),
      );
    }
  }
  for (let j = 0; j < n; j++) {
    const a = cols[j] as number[];
    const b = cols[j + 1] as number[];
    for (let i = 0; i + 1 < a.length; i++) {
      m.triFacing(a[i] as number, a[i + 1] as number, b[i + 1] as number, [0, 1, 0]);
      m.triFacing(a[i] as number, b[i + 1] as number, b[i] as number, [0, 1, 0]);
    }
  }
  return m;
}

/** Stations across the bridgedeck's length, from fore to aft. */
const bridgeZs = (z0: number, z1: number, n: number): number[] =>
  Array.from({ length: n + 1 }, (_, i) => lerp(z0, z1, i / n));

/**
 * The bridgedeck: its underside between the hulls' inner sides, painted
 * white lead; the nacelle curving up from it at its fore end to the locker
 * deck; the aft crossbeam's after face; the locker deck forward of the
 * round-house and the cockpit's sole aft of it, laid in planks.
 */
function bridgedeck(): { paint: MeshBuilder; deck: MeshBuilder; oak: MeshBuilder } {
  const paint = new MeshBuilder('paint');
  const sole = new MeshBuilder('deck');
  const oak = new MeshBuilder('oak');
  const n = D.small ? 30 : 6;
  const zs = bridgeZs(NACELLE_FOOT, BRIDGE_AFT, n);
  // The underside.
  const rows = [-1, 1].map((s) =>
    zs.map((z) => paint.vertex([s * innerAt(z, UNDERSIDE), UNDERSIDE, z], WHITE_LEAD)),
  );
  for (let i = 0; i < n; i++) {
    const [a, b] = rows as [number[], number[]];
    paint.triFacing(a[i] as number, a[i + 1] as number, b[i + 1] as number, [0, -1, 0]);
    paint.triFacing(a[i] as number, b[i + 1] as number, b[i] as number, [0, -1, 0]);
  }
  // The nacelle: from the underside's fore edge up and forward to the locker deck's.
  const arcs = D.small ? 8 : 2;
  const nacelle: number[][] = [];
  for (let k = 0; k <= arcs; k++) {
    const t = k / arcs;
    const a = (t * Math.PI) / 2;
    const y = lerp(UNDERSIDE, LOCKERS_Y, 1 - Math.cos(a));
    const z = lerp(NACELLE_FOOT, LOCKERS_FORE, Math.sin(a));
    nacelle.push([-1, 1].map((s) => paint.vertex([s * innerAt(z, y), y, z], WHITE_LEAD)));
  }
  for (let k = 0; k < arcs; k++) {
    const r0 = nacelle[k] as number[];
    const r1 = nacelle[k + 1] as number[];
    paint.triFacing(r0[0] as number, r0[1] as number, r1[1] as number, [0, -0.5, -1]);
    paint.triFacing(r0[0] as number, r1[1] as number, r1[0] as number, [0, -0.5, -1]);
  }
  // The aft crossbeam's after face, oak, from the underside to the sole.
  const w = innerAt(BRIDGE_AFT, SOLE);
  quad(
    oak,
    [
      [-innerAt(BRIDGE_AFT, UNDERSIDE), UNDERSIDE, BRIDGE_AFT],
      [innerAt(BRIDGE_AFT, UNDERSIDE), UNDERSIDE, BRIDGE_AFT],
      [w, SOLE, BRIDGE_AFT],
      [-w, SOLE, BRIDGE_AFT],
    ],
    [0, 0, 1],
    OAK,
  );
  // The laid decks: the lockers' forward of the round-house, the cockpit's sole aft of it.
  const laid = (z0: number, z1: number, y: number): void => {
    const nz = D.small ? 10 : 2;
    const boards = D.plankedDeck ? 16 : 1;
    const zz = bridgeZs(z0, z1, nz);
    for (let i = 0; i < boards; i++) {
      const f0 = -1 + (2 * i) / boards;
      const f1 = -1 + (2 * (i + 1)) / boards;
      const c = shade(TEAK, 0.85 + 0.15 * jitter(i + 90 + Math.round(y * 10)));
      const gap = D.plankedDeck ? 0.004 : 0;
      const lo = zz.map((z) => sole.vertex([f0 * innerAt(z, y) + gap, y, z], c, [f0, z]));
      const hi = zz.map((z) => sole.vertex([f1 * innerAt(z, y) - gap, y, z], c, [f1, z]));
      for (let k = 0; k < nz; k++) {
        sole.triFacing(lo[k] as number, lo[k + 1] as number, hi[k + 1] as number, [0, 1, 0]);
        sole.triFacing(lo[k] as number, hi[k + 1] as number, hi[k] as number, [0, 1, 0]);
      }
    }
    if (D.plankedDeck) {
      // The seams' pitch below the boards.
      const dark = shade(TEAK, 0.3);
      const a = zz.map((z) => sole.vertex([-innerAt(z, y), y - 0.003, z], dark));
      const b = zz.map((z) => sole.vertex([innerAt(z, y), y - 0.003, z], dark));
      for (let k = 0; k < nz; k++) {
        sole.triFacing(a[k] as number, a[k + 1] as number, b[k + 1] as number, [0, 1, 0]);
        sole.triFacing(a[k] as number, b[k + 1] as number, b[k] as number, [0, 1, 0]);
      }
    }
  };
  laid(LOCKERS_FORE, HOUSE_FORE, LOCKERS_Y);
  laid(NOTCH_FORE, BRIDGE_AFT, SOLE);
  return { paint, deck: sole, oak };
}

// --- The round-house and its roof -----------------------------------------------

/** The round-house's wall's foot on the deck at its side, at z. */
const wallFoot = (z: number): number => deckAt(HOUSE_SIDE, z);
/** How far its sides lean in from the foot to the eaves. */
const TUMBLE = 0.08;

/** The round-house's plan, round from its starboard after corner forward, across the front, aft down the port side and round the helm's notch: points at its foot. */
function housePlan(): { x: number; z: number; y: number }[] {
  const pts: { x: number; z: number; y: number }[] = [];
  pts.push({ x: HOUSE_SIDE, z: HOUSE_AFT, y: wallFoot(HOUSE_AFT) });
  pts.push({ x: HOUSE_SIDE, z: HOUSE_FORE, y: wallFoot(HOUSE_FORE) });
  pts.push({ x: -HOUSE_SIDE, z: HOUSE_FORE, y: wallFoot(HOUSE_FORE) });
  pts.push({ x: -HOUSE_SIDE, z: NOTCH_FORE, y: wallFoot(NOTCH_FORE) });
  pts.push({ x: NOTCH_IN, z: NOTCH_FORE, y: PLAT_Y });
  pts.push({ x: NOTCH_IN, z: HOUSE_AFT, y: SOLE });
  return pts;
}

/**
 * The round-house: varnished walls of panelling, its sides leaning in a
 * little and its front raked aft to the roof; windows all round of small
 * panes in wooden frames, as a stern gallery's lights, a dead-light hooked
 * open beside each; its after bulkhead with two glazed doors, shut; and the
 * roof laid in planks over it and carried aft over the cockpit on varnished
 * posts, open over the helm. Inside, it is drawn shut.
 */
function roundHouse(): {
  wood: MeshBuilder;
  roof: MeshBuilder;
  glass: MeshBuilder;
  frames: MeshBuilder;
  brass: MeshBuilder;
} {
  const wood = new MeshBuilder('varnish');
  const roof = new MeshBuilder('roof');
  const glass = new MeshBuilder('glass');
  const frames = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  /** The wall's top at a point of the plan: the roof's underside there. */
  const top = (x: number, z: number): number => roofY(x, z) - ROOF_THICK;
  /** A wall from a to b along the plan, leaning in by lean at its top, facing out. */
  const wall = (
    a: { x: number; z: number; y: number },
    b: { x: number; z: number; y: number },
    out: Vec3,
    lean: Vec3,
    n: number,
  ): ((t: number, h: number, off: number) => Vec3) => {
    const at = (t: number, h: number, off: number): Vec3 => {
      const x = lerp(a.x, b.x, t);
      const z = lerp(a.z, b.z, t);
      const y0 = lerp(a.y, b.y, t);
      const p0: Vec3 = [x, y0, z];
      const p1: Vec3 = add([x, top(x, z), z], lean);
      const p: Vec3 = [lerp(p0[0], p1[0], h), lerp(p0[1], p1[1], h), lerp(p0[2], p1[2], h)];
      return add(p, scale(normalize(out), off));
    };
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i <= n; i++) {
      lo.push(wood.vertex(at(i / n, 0, 0), VARNISH));
      hi.push(wood.vertex(at(i / n, 1, 0), VARNISH));
    }
    for (let i = 0; i < n; i++) {
      wood.triFacing(lo[i] as number, lo[i + 1] as number, hi[i + 1] as number, out);
      wood.triFacing(lo[i] as number, hi[i + 1] as number, hi[i] as number, out);
    }
    return at;
  };
  const p = housePlan();
  const seg = D.small ? 10 : 2;
  const [aStar, fStar, fPort, nPort, nIn, nAft] = p as [
    { x: number; z: number; y: number },
    { x: number; z: number; y: number },
    { x: number; z: number; y: number },
    { x: number; z: number; y: number },
    { x: number; z: number; y: number },
    { x: number; z: number; y: number },
  ];
  const rake = ROOF_FRONT - HOUSE_FORE;
  const starboard = wall(fStar, aStar, [1, 0.1, 0], [-TUMBLE, 0, 0], seg);
  const port = wall(fPort, nPort, [-1, 0.1, 0], [TUMBLE, 0, 0], seg);
  // The front: raked aft, its sides' top leaning in with them.
  const front = (t: number, h: number, off: number): Vec3 => {
    const x = lerp(fPort.x, fStar.x, t);
    const y0 = wallFoot(HOUSE_FORE);
    const xt = x * (1 - TUMBLE / HOUSE_SIDE);
    const p0: Vec3 = [x, y0, HOUSE_FORE];
    const p1: Vec3 = [xt, top(xt, ROOF_FRONT), ROOF_FRONT];
    const q: Vec3 = [lerp(p0[0], p1[0], h), lerp(p0[1], p1[1], h), lerp(p0[2], p1[2], h)];
    return add(q, scale(normalize([0, rake, -(EAVES_FRONT - y0)]), off));
  };
  {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i <= seg * 2; i++) {
      lo.push(wood.vertex(front(i / (seg * 2), 0, 0), VARNISH));
      hi.push(wood.vertex(front(i / (seg * 2), 1, 0), VARNISH));
    }
    for (let i = 0; i < seg * 2; i++) {
      wood.triFacing(lo[i] as number, lo[i + 1] as number, hi[i + 1] as number, [0, 0.5, -1]);
      wood.triFacing(lo[i] as number, hi[i + 1] as number, hi[i] as number, [0, 0.5, -1]);
    }
  }
  // The sides' gores between the raked front and the leaning sides.
  for (const s of [1, -1]) {
    const foot: Vec3 = [s * HOUSE_SIDE, wallFoot(HOUSE_FORE), HOUSE_FORE];
    const xt = s * (HOUSE_SIDE - TUMBLE);
    quad(
      wood,
      [
        foot,
        [xt, top(xt, ROOF_FRONT), ROOF_FRONT],
        [xt, top(xt, HOUSE_FORE + rake), HOUSE_FORE + rake],
        foot,
      ],
      [s, 0, 0],
      VARNISH,
    );
  }
  // The after bulkhead, starboard of the notch, and the notch's two walls.
  const aft = wall(nAft, aStar, [0, 0, 1], [0, 0, 0], seg);
  const notchSide = wall(nIn, nAft, [1, 0, 0], [0, 0, 0], 2);
  const notchFace = wall(nPort, nIn, [0, 0, 1], [0, 0, 0], 4);
  // The roof: laid planks fore and aft, from its front to its after edge,
  // overhanging the sides; open over the helm, its landing and the head of
  // its ladder, and on aft over the ladder as far as a sailor climbing it
  // stands tall under the roof.
  const rx = HOUSE_SIDE + ROOF_OVER;
  const planks = D.small ? 22 : 2;
  const nz = D.small ? 24 : 4;
  const OPEN = {
    x0: PLAT_OUT - ROOF_OVER - 0.01,
    x1: LADDER_IN + 0.05,
    z0: NOTCH_FORE - 0.1,
    z1: PLAT_AFT + 0.05,
  };
  /** The opening's after part, over the ladder: from its port side, aft to here. */
  const LADDER_OPEN = { x0: PLAT_IN - 0.02, z1: LADDER_FOOT - 0.15 };
  /** The roof's opening across at z: from x0 to x1, or none. */
  const openAt = (z: number): [number, number] | null =>
    z > OPEN.z0 && z < OPEN.z1
      ? [-rx - 1, OPEN.x1]
      : z >= OPEN.z1 && z < LADDER_OPEN.z1
        ? [LADDER_OPEN.x0, OPEN.x1]
        : null;
  const zs = Array.from({ length: nz + 1 }, (_, i) => lerp(ROOF_FRONT, ROOF_AFT, i / nz));
  for (const z of [OPEN.z0, OPEN.z1, LADDER_OPEN.z1]) {
    zs.push(z);
  }
  zs.sort((a, b) => a - b);
  for (let j = 0; j < planks; j++) {
    const x0 = lerp(-rx, rx, j / planks);
    const x1 = lerp(-rx, rx, (j + 1) / planks);
    const c = shade(DECK, 0.85 + 0.18 * jitter(j + 140));
    for (let i = 0; i + 1 < zs.length; i++) {
      const z0 = zs[i] as number;
      const z1 = zs[i + 1] as number;
      // The plank, but where the opening crosses it: none, one or two
      // pieces of it.
      const open = openAt((z0 + z1) / 2);
      const pieces: [number, number][] =
        open === null
          ? [[x0, x1]]
          : [
              [x0, Math.min(x1, open[0])],
              [Math.max(x0, open[1]), x1],
            ];
      for (const [lo, hi] of pieces) {
        if (hi - lo < 1e-6) {
          continue;
        }
        const seamC = D.seams ? shade(c, 0.6) : c;
        const k = [
          roof.vertex([lo, roofY(lo, z0), z0], seamC),
          roof.vertex([hi, roofY(hi, z0), z0], c),
          roof.vertex([hi, roofY(hi, z1), z1], c),
          roof.vertex([lo, roofY(lo, z1), z1], seamC),
        ];
        roof.triFacing(k[0] as number, k[1] as number, k[2] as number, [0, 1, 0]);
        roof.triFacing(k[0] as number, k[2] as number, k[3] as number, [0, 1, 0]);
        // Its underside, varnished, seen from the cockpit.
        if (!D.small) {
          continue;
        }
        const u = [
          wood.vertex([lo, roofY(lo, z0) - ROOF_THICK, z0], shade(VARNISH, 0.8)),
          wood.vertex([hi, roofY(hi, z0) - ROOF_THICK, z0], shade(VARNISH, 0.8)),
          wood.vertex([hi, roofY(hi, z1) - ROOF_THICK, z1], shade(VARNISH, 0.8)),
          wood.vertex([lo, roofY(lo, z1) - ROOF_THICK, z1], shade(VARNISH, 0.8)),
        ];
        wood.triFacing(u[0] as number, u[1] as number, u[2] as number, [0, -1, 0]);
        wood.triFacing(u[0] as number, u[2] as number, u[3] as number, [0, -1, 0]);
      }
    }
  }
  // The roof's edges: a varnished fascia round it, and round the opening.
  const fascia = (a: Vec3, b: Vec3, out: Vec3): void => {
    quad(
      wood,
      [a, b, add(b, [0, -ROOF_THICK - 0.04, 0]), add(a, [0, -ROOF_THICK - 0.04, 0])],
      out,
      shade(VARNISH, 0.9),
    );
  };
  const edgeN = D.small ? 8 : 2;
  for (const s of [1, -1]) {
    for (let i = 0; i < nz; i++) {
      const z0 = lerp(ROOF_FRONT, ROOF_AFT, i / nz);
      const z1 = lerp(ROOF_FRONT, ROOF_AFT, (i + 1) / nz);
      fascia([s * rx, roofY(rx, z0), z0], [s * rx, roofY(rx, z1), z1], [s, 0, 0]);
    }
  }
  for (const [z, out] of [
    [ROOF_FRONT, -1],
    [ROOF_AFT, 1],
  ] as [number, number][]) {
    for (let i = 0; i < edgeN; i++) {
      const x0 = lerp(-rx, rx, i / edgeN);
      const x1 = lerp(-rx, rx, (i + 1) / edgeN);
      fascia([x0, roofY(x0, z), z], [x1, roofY(x1, z), z], [0, 0, out]);
    }
  }
  // Round the opening: its inboard side, its fore end, its after end over
  // the platform, and the ladder's part's port side and after end.
  const ox = OPEN.x1;
  const lx = LADDER_OPEN.x0;
  const lz = LADDER_OPEN.z1;
  fascia([ox, roofY(ox, OPEN.z0), OPEN.z0], [ox, roofY(ox, lz), lz], [-1, 0, 0]);
  fascia([-rx, roofY(rx, OPEN.z0), OPEN.z0], [ox, roofY(ox, OPEN.z0), OPEN.z0], [0, 0, 1]);
  fascia([-rx, roofY(rx, OPEN.z1), OPEN.z1], [lx, roofY(lx, OPEN.z1), OPEN.z1], [0, 0, -1]);
  fascia([lx, roofY(lx, OPEN.z1), OPEN.z1], [lx, roofY(lx, lz), lz], [1, 0, 0]);
  fascia([lx, roofY(lx, lz), lz], [ox, roofY(ox, lz), lz], [0, 0, -1]);
  // The posts carrying the roof over the cockpit, on the hulls' decks and at the opening's after corner.
  const posts: [number, number, number][] = [
    [HOUSE_SIDE - 0.1, ROOF_AFT - 0.12, deckAt(HOUSE_SIDE - 0.1, ROOF_AFT - 0.12)],
    [-(HOUSE_SIDE - 0.1), ROOF_AFT - 0.12, deckAt(HOUSE_SIDE - 0.1, ROOF_AFT - 0.12)],
    [HOUSE_SIDE - 0.1, 3.1, deckAt(HOUSE_SIDE - 0.1, 3.1)],
    [-(HOUSE_SIDE - 0.1), 3.1, deckAt(HOUSE_SIDE - 0.1, 3.1)],
  ];
  for (const [x, z, y] of posts) {
    wood.tube(
      [
        [x, y, z],
        [x, roofY(x, z) - ROOF_THICK, z],
      ],
      [0.06, 0.05],
      D.small ? 8 : 4,
      VARNISH,
    );
  }
  if (!D.small) {
    return { wood, roof, glass, frames, brass };
  }
  // The windows: along each side, across the front and in the after
  // bulkhead's starboard part, each of small panes in a varnished frame,
  // with a dead-light hooked open beside it on the sides.
  const window = (
    at: (t: number, h: number, off: number) => Vec3,
    t0: number,
    t1: number,
    h0: number,
    h1: number,
    out: Vec3,
    cols: number,
    rowsN: number,
    deadlight: boolean,
  ): void => {
    quad(
      frames,
      [at(t0, h0, 0.006), at(t1, h0, 0.006), at(t1, h1, 0.006), at(t0, h1, 0.006)],
      out,
      shade(VARNISH, 0.7),
    );
    quad(
      glass,
      [at(t0, h0, 0.01), at(t1, h0, 0.01), at(t1, h1, 0.01), at(t0, h1, 0.01)],
      out,
      GLASS,
    );
    for (let c = 0; c <= cols; c++) {
      const t = lerp(t0, t1, c / cols);
      frames.tube(
        [at(t, h0, 0.014), at(t, h1, 0.014)],
        [c === 0 || c === cols ? 0.02 : 0.009],
        3,
        shade(VARNISH, 0.85),
      );
    }
    for (let r = 0; r <= rowsN; r++) {
      const h = lerp(h0, h1, r / rowsN);
      frames.tube(
        [at(t0, h, 0.014), at(t1, h, 0.014)],
        [r === 0 || r === rowsN ? 0.02 : 0.009],
        3,
        shade(VARNISH, 0.85),
      );
    }
    if (deadlight) {
      const d0 = t0 - (t1 - t0) * 0.55;
      quad(
        wood,
        [
          at(d0, h0 + 0.03, 0.03),
          at(t0 - 0.005, h0 + 0.03, 0.03),
          at(t0 - 0.005, h1 - 0.03, 0.03),
          at(d0, h1 - 0.03, 0.03),
        ],
        out,
        shade(WOOD, 0.9),
      );
      brass.tube([at(t0 - 0.008, h0 + 0.08, 0.02), at(t0 - 0.008, h1 - 0.08, 0.02)], [0.007], 4);
    }
  };
  for (const [side, at] of [
    [1, starboard],
    [-1, port],
  ] as [number, (t: number, h: number, off: number) => Vec3][]) {
    const len = side > 0 ? HOUSE_AFT - HOUSE_FORE : NOTCH_FORE - HOUSE_FORE;
    const spans = side > 0 ? [0.14, 0.4, 0.66] : [0.16, 0.48];
    for (const t0 of spans) {
      const t1 = t0 + (side > 0 ? 1.0 : 1.2) / len;
      window(
        at,
        t0,
        Math.min(0.97, t1),
        0.38,
        0.8,
        [side, 0.1, 0],
        Math.round(((t1 - t0) * len) / 0.22),
        3,
        true,
      );
    }
  }
  window(front, 0.1, 0.9, 0.18, 0.85, [0, 0.5, -1], 18, 4, false);
  window(aft, 0.6, 0.95, 0.35, 0.82, [0, 0, 1], 6, 3, false);
  // The doors: two leaves of small panes over a panelled foot, shut.
  const doorT = (x: number): number => (x - nAft.x) / (aStar.x - nAft.x);
  for (const [x0, x1] of [
    [DOOR_PORT, (DOOR_PORT + DOOR_STAR) / 2],
    [(DOOR_PORT + DOOR_STAR) / 2, DOOR_STAR],
  ] as [number, number][]) {
    const t0 = doorT(x0);
    const t1 = doorT(x1);
    quad(
      wood,
      [aft(t0, 0, 0.012), aft(t1, 0, 0.012), aft(t1, 0.88, 0.012), aft(t0, 0.88, 0.012)],
      [0, 0, 1],
      shade(VARNISH, 0.75),
    );
    window(aft, t0 + 0.004, t1 - 0.004, 0.36, 0.84, [0, 0, 1], 3, 4, false);
    brass.tube(
      [
        aft(x0 < 0 ? t1 - 0.01 : t0 + 0.01, 0.45, 0.04),
        aft(x0 < 0 ? t1 - 0.01 : t0 + 0.01, 0.52, 0.04),
      ],
      [0.012],
      6,
    );
  }
  // A small window in the notch's face, beside the console.
  window(notchFace, 0.05, 0.25, 0.42, 0.85, [0, 0, 1], 2, 2, false);
  void notchSide;
  return { wood, roof, glass, frames, brass };
}

// --- The helm station ---------------------------------------------------------------

/**
 * The helm station: the platform, planked on top, varnished at its sides,
 * up from the port hull's deck and the cockpit's sole; the landing at the
 * ladder's head; the ladder of oak steps with its bronze rail; the console
 * before the wheel with its brass hood; the settle behind; a bronze rail
 * round the platform's open edges.
 */
function helmStation(): {
  deck: MeshBuilder;
  wood: MeshBuilder;
  oak: MeshBuilder;
  bronze: MeshBuilder;
  brass: MeshBuilder;
  glass: MeshBuilder;
} {
  const top = new MeshBuilder('deck');
  const wood = new MeshBuilder('varnish');
  const oak = new MeshBuilder('oak');
  const bronze = new MeshBuilder('bronze');
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const foot = SOLE - 0.02;
  // The platform and its landing, their tops laid athwartships.
  const planks = D.plankedDeck ? 10 : 1;
  const laid = (x0: number, x1: number, z0: number, z1: number): void => {
    for (let i = 0; i < planks; i++) {
      const za = lerp(z0, z1, i / planks) + (D.plankedDeck ? 0.004 : 0);
      const zb = lerp(z0, z1, (i + 1) / planks) - (D.plankedDeck ? 0.004 : 0);
      quad(
        top,
        [
          [x0, PLAT_Y, za],
          [x1, PLAT_Y, za],
          [x1, PLAT_Y, zb],
          [x0, PLAT_Y, zb],
        ],
        [0, 1, 0],
        shade(TEAK, 0.85 + 0.15 * jitter(i + 400 + Math.round(x0 * 10))),
      );
    }
    if (D.plankedDeck) {
      quad(
        top,
        [
          [x0, PLAT_Y - 0.003, z0],
          [x1, PLAT_Y - 0.003, z0],
          [x1, PLAT_Y - 0.003, z1],
          [x0, PLAT_Y - 0.003, z1],
        ],
        [0, 1, 0],
        shade(TEAK, 0.3),
      );
    }
  };
  laid(PLAT_OUT, PLAT_IN, PLAT_FORE, PLAT_AFT);
  laid(PLAT_IN, LADDER_IN, PLAT_FORE, LANDING_AFT);
  // Its sides, down to the deck or the sole.
  box(wood, [PLAT_OUT, foot, PLAT_AFT - 0.03], [PLAT_IN, PLAT_Y - 0.004, PLAT_AFT], VARNISH);
  box(wood, [PLAT_IN, foot, LANDING_AFT - 0.03], [LADDER_IN, PLAT_Y - 0.004, LANDING_AFT], VARNISH);
  box(wood, [PLAT_IN - 0.03, foot, LANDING_AFT], [PLAT_IN, PLAT_Y - 0.004, PLAT_AFT], VARNISH);
  box(
    wood,
    [PLAT_OUT, deckAt(PLAT_OUT, 2) - 0.02, PLAT_FORE],
    [PLAT_OUT + 0.03, PLAT_Y - 0.004, PLAT_AFT],
    VARNISH,
  );
  // The ladder: oak treads stepping down aft from the landing to the sole, its stringers and the bronze rail.
  const rise = (PLAT_Y - SOLE) / (TREADS + 1);
  const run = (LADDER_FOOT - LANDING_AFT) / TREADS;
  for (let k = 0; k < TREADS; k++) {
    const y = PLAT_Y - rise * (k + 1);
    const z0 = LANDING_AFT + run * k;
    box(
      oak,
      [PLAT_IN + 0.05, y - 0.04, z0],
      [LADDER_IN - 0.05, y, z0 + run + 0.02],
      shade(OAK, 0.95 + 0.1 * jitter(k + 510)),
    );
  }
  for (const x of D.small ? [PLAT_IN + 0.03, LADDER_IN - 0.03] : []) {
    oak.tube(
      [
        [x, PLAT_Y - 0.06, LANDING_AFT],
        [x, SOLE + 0.02, LADDER_FOOT + 0.05],
      ],
      [0.025],
      D.small ? 4 : 3,
      OAK,
    );
  }
  if (D.small) {
    // The rail, on the ladder's inboard side, a little outboard of its
    // treads (a coat's skirts clear of its posts), and round the landing's.
    const rail: Vec3[] = [
      [LADDER_RAIL, SOLE + 0.9, LADDER_FOOT],
      [LADDER_RAIL, PLAT_Y + 0.9, LANDING_AFT],
      [LANDING_RAIL, PLAT_Y + 0.9, LANDING_AFT - 0.05],
      [LANDING_RAIL, PLAT_Y + 0.9, PLAT_FORE + 0.25],
    ];
    bronze.tube(rail, [0.016], 6);
    for (const p of [rail[0], rail[1], rail[3]] as Vec3[]) {
      bronze.tube(
        [[p[0], p[2] > LANDING_AFT ? SOLE + 0.02 + (p[1] - SOLE - 0.9) : PLAT_Y, p[2]], p],
        [0.014],
        5,
      );
    }
    // And round the platform's after side outboard of the settle.
    bronze.tube(
      [
        [PLAT_OUT + 0.02, PLAT_Y + 0.75, PLAT_FORE + 0.3],
        [PLAT_OUT + 0.02, PLAT_Y + 0.75, PLAT_AFT - 0.02],
      ],
      [0.014],
      5,
    );
    for (const z of [PLAT_FORE + 0.3, (PLAT_FORE + PLAT_AFT) / 2, PLAT_AFT - 0.02]) {
      bronze.tube(
        [
          [PLAT_OUT + 0.02, PLAT_Y, z],
          [PLAT_OUT + 0.02, PLAT_Y + 0.75, z],
        ],
        [0.012],
        5,
      );
    }
  }
  // The console before the wheel: a varnished case from the platform up
  // under the hub, the compass under a brass hood on it.
  const cx = HUB[0];
  const cTop = HUB[1] - 0.18;
  box(wood, [cx - 0.22, PLAT_Y, NOTCH_FORE], [cx + 0.22, cTop, CONSOLE_AFT], shade(WOOD, 0.95));
  if (D.small) {
    brass.tube(
      [
        [cx, cTop, NOTCH_FORE + 0.02],
        [cx, cTop + 0.1, NOTCH_FORE + 0.02],
        [cx, cTop + 0.18, NOTCH_FORE + 0.02],
      ],
      [0.12, 0.1, 0.03],
      12,
    );
    quad(
      glass,
      [
        [cx - 0.07, cTop + 0.02, CONSOLE_AFT + 0.002],
        [cx + 0.07, cTop + 0.02, CONSOLE_AFT + 0.002],
        [cx + 0.07, cTop - 0.08, CONSOLE_AFT + 0.002],
        [cx - 0.07, cTop - 0.08, CONSOLE_AFT + 0.002],
      ],
      [0, 0, 1],
      srgb(0.7, 0.68, 0.55),
    );
  }
  // The settle for two: its seat, its back, its ends.
  box(
    wood,
    [SETTLE_OUT, PLAT_Y, SETTLE_FORE],
    [SETTLE_IN, SETTLE_TOP - 0.05, SETTLE_AFT],
    shade(VARNISH, 0.85),
  );
  const slats = D.small ? 5 : 1;
  for (let i = 0; i < slats; i++) {
    const z0 = lerp(SETTLE_FORE, SETTLE_AFT, i / slats) + (D.small ? 0.004 : 0);
    const z1 = lerp(SETTLE_FORE, SETTLE_AFT, (i + 1) / slats) - (D.small ? 0.004 : 0);
    box(
      oak,
      [SETTLE_OUT, SETTLE_TOP - 0.05, z0],
      [SETTLE_IN, SETTLE_TOP, z1],
      shade(TEAK, 0.9 + 0.1 * jitter(i + 600)),
    );
  }
  box(
    wood,
    [SETTLE_OUT, SETTLE_TOP, SETTLE_AFT],
    [SETTLE_IN, SETTLE_TOP + SETTLE_BACK, SETTLE_AFT + 0.06],
    VARNISH,
  );
  return { deck: top, wood, oak, bronze, brass, glass };
}

/** The wheel in its node's frame (the hub): the rim in the x-y plane, the spokes and handles, the hub and its barrel. */
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
          scale(d, WHEEL_RADIUS + 0.045),
          scale(d, WHEEL_RADIUS + 0.065),
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
    // The barrel on the axle forward of the hub, its tiller ropes of
    // untarred hemp wound on it and led below.
    wood.tube(
      [
        [0, 0, -0.1],
        [0, 0, -(HUB[2] - CONSOLE_AFT) + 0.01],
      ],
      [0.085],
      10,
      shade(WOOD, 0.85),
    );
    for (let t = 0; t < 3; t++) {
      const z = -0.13 - t * 0.05;
      rope.tube(
        Array.from({ length: 13 }, (_, i): Vec3 => {
          const a = (i / 12) * 2 * Math.PI;
          return [0.09 * Math.cos(a), 0.09 * Math.sin(a), z - (i / 12) * 0.04];
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
    [WHEEL_RADIUS + WHEEL_HANDLE],
    D.rim,
    WOOD,
  );
  return m;
}

// --- The cockpit's seats and table ---------------------------------------------------

/** A seat: a box from the sole to its top, its top laid in slats along it, its back a board behind. */
function seat(
  wood: MeshBuilder,
  oak: MeshBuilder,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  alongX: boolean,
): void {
  box(wood, [x0, SOLE - 0.01, z0], [x1, y - 0.04, z1], shade(VARNISH, 0.85));
  const slats = D.small ? 4 : 1;
  for (let i = 0; i < slats; i++) {
    const g = D.small ? 0.004 : 0;
    const c = shade(TEAK, 0.9 + 0.12 * jitter(i + Math.round((x0 + z0) * 37)));
    if (alongX) {
      const za = lerp(z0, z1, i / slats) + g;
      const zb = lerp(z0, z1, (i + 1) / slats) - g;
      box(oak, [x0, y - 0.04, za], [x1, y, zb], c);
    } else {
      const xa = lerp(x0, x1, i / slats) + g;
      const xb = lerp(x0, x1, (i + 1) / slats) - g;
      box(oak, [xa, y - 0.04, z0], [xb, y, z1], c);
    }
  }
}

/**
 * The cockpit's furniture: the L-shaped bench to starboard with its backs
 * against the hull's side and the bulkhead; the table, solid and varnished,
 * on a pedestal; the bench along the aft crossbeam, its back a turned oak
 * rail on oak posts; the lounger to port, a planked settle along the hull's
 * side with its back.
 */
function cockpitFurniture(): { wood: MeshBuilder; oak: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const oak = new MeshBuilder('oak');
  // The L-bench's long leg and its forward leg.
  seat(wood, oak, LBENCH_FRONT, LBENCH_OUT, LBENCH_LEG, LBENCH_AFT, SEAT_TOP, false);
  seat(wood, oak, LBENCH_INNER, LBENCH_OUT, HOUSE_AFT + 0.02, LBENCH_LEG, SEAT_TOP, true);
  box(
    wood,
    [LBENCH_OUT, SEAT_TOP, HOUSE_AFT + 0.02],
    [LBENCH_OUT + 0.06, SEAT_TOP + 0.4, LBENCH_AFT],
    VARNISH,
  );
  // The table, and its pedestal toward its inboard side, clear of the
  // knees and coats of those on the bench.
  box(wood, [TABLE.x0, TABLE.y - 0.04, TABLE.z0], [TABLE.x1, TABLE.y, TABLE.z1], VARNISH);
  box(
    wood,
    [TABLE.x0 + 0.17, SOLE, TABLE.z0 + 0.35],
    [TABLE.x0 + 0.23, TABLE.y - 0.04, TABLE.z1 - 0.35],
    shade(VARNISH, 0.8),
  );
  // The aft bench, its back the crossbeam's turned rail.
  seat(wood, oak, AFT_PORT, AFT_STAR, AFT_FRONT, AFT_BACK, SEAT_TOP, true);
  const railY = SEAT_TOP + 0.42;
  oak.tube(
    [
      [LOUNGER_OUT, railY, AFT_BACK + 0.03],
      [AFT_STAR + 0.05, railY, AFT_BACK + 0.03],
    ],
    [0.04],
    D.small ? 8 : 4,
    OAK,
  );
  // (The posts between the stations on it, clear of the backs of those sat there.)
  for (const x of [LOUNGER_OUT + 0.1, -0.05, 0.55, 1.15, 1.75, AFT_STAR]) {
    oak.tube(
      [
        [x, SEAT_TOP - 0.02, AFT_BACK + 0.03],
        [x, railY, AFT_BACK + 0.03],
      ],
      [0.03, 0.025],
      D.small ? 6 : 3,
      OAK,
    );
  }
  // The lounger, and its back along the hull's side.
  seat(wood, oak, LOUNGER_OUT, LOUNGER_FRONT, LOUNGER_FORE, LOUNGER_AFT, LOUNGER_TOP, false);
  box(
    wood,
    [LOUNGER_OUT - 0.06, LOUNGER_TOP, LOUNGER_FORE],
    [LOUNGER_OUT, LOUNGER_TOP + 0.4, LOUNGER_AFT],
    VARNISH,
  );
  return { wood, oak };
}

// --- Beams, nets and the bows -------------------------------------------------------

/** The forward crossbeam: where the jib's furler is set up, the anchor's roller in its middle. */
const BEAM_FORE_Z = -headsails.headsailTack;
const BEAM_Y = sheer(uAt(BEAM_FORE_Z)) + 0.1;
const BEAM_W = 0.13;
const BEAM_D = 0.16;
/** The nets: between the hulls' inner edges, from the forward crossbeam to the nacelle. */
const NET_FORE = BEAM_FORE_Z + BEAM_W / 2 + 0.01;
const NET_AFT = LOCKERS_FORE - 0.02;
const NET_Y = sheer(uAt((NET_FORE + NET_AFT) / 2)) - 0.02;
const netEdge = (z: number, s: number): number => s * (innerAt(z, NET_Y) - 0.04);

/**
 * The forward crossbeam, oak, across from bow to bow, the longitudinal beam
 * from its middle aft to the nacelle carrying the chain's run; and the hemp
 * nets either side of it, laced to the beams and the hulls' inner edges.
 */
function beams(): { oak: MeshBuilder; net: MeshBuilder; iron: MeshBuilder } {
  const oak = new MeshBuilder('oak');
  const net = new MeshBuilder('net');
  const iron = new MeshBuilder('iron');
  const reach = C + 0.1;
  box(
    oak,
    [-reach, BEAM_Y - BEAM_D, BEAM_FORE_Z - BEAM_W / 2],
    [reach, BEAM_Y, BEAM_FORE_Z + BEAM_W / 2],
    OAK,
  );
  box(
    oak,
    [-0.08, NET_Y - 0.1, BEAM_FORE_Z],
    [0.08, NET_Y + 0.04, NET_AFT + 0.03],
    shade(OAK, 0.92),
  );
  if (D.small) {
    // Iron straps where the crossbeam meets each hull.
    for (const s of [1, -1]) {
      box(
        iron,
        [s * (C - 0.25) - 0.03, BEAM_Y - BEAM_D - 0.01, BEAM_FORE_Z - BEAM_W / 2 - 0.01],
        [s * (C - 0.25) + 0.03, BEAM_Y + 0.01, BEAM_FORE_Z + BEAM_W / 2 + 0.01],
        [1, 1, 1],
      );
    }
  }
  const dark: Vec3 = [0.8, 0.8, 0.8];
  for (const s of [1, -1]) {
    const inner = 0.1;
    if (D.netStrands === 0) {
      quad(
        net,
        [
          [s * inner, NET_Y, NET_FORE],
          [netEdge(NET_FORE, s), NET_Y, NET_FORE],
          [netEdge(NET_AFT, s), NET_Y, NET_AFT],
          [s * inner, NET_Y, NET_AFT],
        ],
        [0, 1, 0],
        dark,
      );
      continue;
    }
    const W = 0.014;
    const ribbon = (path: Vec3[], across: Vec3): void => {
      const left = path.map((p) => net.vertex(add(p, scale(across, -W / 2)), dark));
      const right = path.map((p) => net.vertex(add(p, scale(across, W / 2)), dark));
      for (let i = 0; i + 1 < path.length; i++) {
        net.triFacing(left[i] as number, left[i + 1] as number, right[i + 1] as number, [0, 1, 0]);
        net.triFacing(left[i] as number, right[i + 1] as number, right[i] as number, [0, 1, 0]);
      }
    };
    const n = Math.round(D.netStrands / 2);
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      const path: Vec3[] = [];
      for (let i = 0; i <= 6; i++) {
        const z = lerp(NET_FORE, NET_AFT, i / 6);
        const x = lerp(s * inner, netEdge(z, s), f);
        const sag = 0.03 * Math.sin(Math.PI * f) * Math.sin((Math.PI * i) / 6);
        path.push([x, NET_Y - sag, z]);
      }
      ribbon(path, [1, 0, 0]);
    }
    const across = Math.round(((NET_AFT - NET_FORE) * n) / (innerAt(NET_FORE, NET_Y) - inner));
    for (let i = 0; i <= across; i++) {
      const z = lerp(NET_FORE, NET_AFT, i / across);
      const path: Vec3[] = [];
      for (let j = 0; j <= 4; j++) {
        const f = j / 4;
        const sag = 0.03 * Math.sin(Math.PI * f) * Math.sin((Math.PI * i) / across);
        path.push([lerp(s * inner, netEdge(z, s), f), NET_Y - sag + 0.004, z]);
      }
      ribbon(path, [0, 0, 1]);
    }
  }
  return { oak, net, iron };
}

/** The bows' fittings: the anchor at its roller on the crossbeam's middle, its windlass on the locker deck; oak bitts on each bow. */
function groundTackle(): { iron: MeshBuilder; oak: MeshBuilder } {
  const iron = new MeshBuilder('iron');
  const oak = new MeshBuilder('oak');
  const y = BEAM_Y;
  const z = BEAM_FORE_Z;
  // The roller in its iron cheeks, forward of the crossbeam.
  for (const s of [1, -1]) {
    box(
      iron,
      [s * 0.075 - 0.008, y - 0.12, z - 0.35],
      [s * 0.075 + 0.008, y + 0.06, z - 0.05],
      [1, 1, 1],
    );
  }
  oak.tube(
    [
      [-0.06, y - 0.02, z - 0.28],
      [0.06, y - 0.02, z - 0.28],
    ],
    [0.045],
    10,
    OAK,
  );
  // The anchor, hanging stowed from the roller: its shank, arms and flukes, and its wooden stock.
  const ring: Vec3 = [0, y - 0.02, z - 0.3];
  const crown: Vec3 = [0, y - 0.72, z - 0.36];
  iron.tube([ring, crown], [0.024], 6);
  for (const s of [1, -1]) {
    const arm: Vec3 = [s * 0.28, crown[1] + 0.22, crown[2] + 0.02];
    iron.tube([crown, add(crown, [s * 0.15, 0.04, 0]), arm], [0.022, 0.022, 0.017], 6);
    iron.box(add(arm, [-0.05, -0.02, -0.06]), add(arm, [0.05, 0.06, 0.02]));
  }
  oak.tube([add(ring, [0, -0.09, -0.34]), add(ring, [0, -0.09, 0.34])], [0.032], 6, OAK);
  // The chain from the roller aft along the longitudinal beam.
  iron.tube(
    [
      [0, y + 0.0, z - 0.25],
      [0, NET_Y + 0.05, NET_AFT],
    ],
    [0.014],
    4,
  );
  // The windlass on the locker deck: a timber barrel turning upright, its iron pawls.
  const wz = LOCKERS_FORE + 0.4;
  oak.tube(
    [
      [0, LOCKERS_Y, wz],
      [0, LOCKERS_Y + 0.08, wz],
      [0, LOCKERS_Y + 0.3, wz],
    ],
    [0.15, 0.1, 0.11],
    10,
    LIGNUM,
  );
  box(iron, [-0.02, LOCKERS_Y, wz + 0.1], [0.02, LOCKERS_Y + 0.1, wz + 0.2], [1, 1, 1]);
  // The bitts on each bow: two oak posts and their cross-piece.
  for (const s of [1, -1]) {
    const bz = BOW_Z + 0.75;
    const by = deckAt(s * C, bz);
    for (const dx of [-0.11, 0.11]) {
      box(oak, [s * C + dx - 0.04, by, bz - 0.04], [s * C + dx + 0.04, by + 0.24, bz + 0.04], OAK);
    }
    box(
      oak,
      [s * C - 0.15, by + 0.15, bz - 0.025],
      [s * C + 0.15, by + 0.19, bz + 0.025],
      shade(OAK, 0.9),
    );
  }
  return { iron, oak };
}

// --- Guardrails ------------------------------------------------------------------------

/** The stanchions' stations along each hull's outer edge; the lifelines' heights above the deck; the pulpits' and pushpits' ends. */
const STANCHIONS = [-4.6, -3.2, -1.8, -0.4, 1.0, 2.3, 3.6];
const PULPIT_AFT = -5.6;
const PUSHPIT_FORE = 4.7;
const LIFELINES = [0.31, 0.61];
const STANCHION_IN = 0.05;
const edgeAt = (z: number): number => C + deckHalf(uAt(z)) - STANCHION_IN;

/**
 * The guardrails: iron stanchions on each hull's outer edge in iron
 * sockets, the bent iron pulpit round each bow and pushpit round each stern
 * on iron legs, and two tarred hemp lifelines between them.
 */
function guardrails(): { iron: MeshBuilder; rope: MeshBuilder } {
  const iron = new MeshBuilder('iron');
  const rope = new MeshBuilder('rope');
  const top = LIFELINES[1] as number;
  for (const s of [1, -1]) {
    for (const z of STANCHIONS) {
      const x = s * edgeAt(z);
      const y = deckAt(x, z);
      iron.tube(
        [
          [x, y, z],
          [x, y + top + 0.02, z],
        ],
        [0.014, 0.011],
        6,
      );
      iron.tube(
        [
          [x, y, z],
          [x, y + 0.04, z],
        ],
        [0.028],
        6,
      );
    }
    for (const h of LIFELINES) {
      const pts: Vec3[] = [PULPIT_AFT, ...STANCHIONS, PUSHPIT_FORE].map(
        (z): Vec3 => [s * edgeAt(z), deckAt(edgeAt(z), z) + h, z],
      );
      rope.tube(pts, [0.006], 4);
    }
    // The pulpit round this bow: from its leg on the outer edge, round the
    // stem, back to a leg on the inner edge.
    const pulpit: Vec3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = t * Math.PI;
      const z = lerp(PULPIT_AFT, BOW_Z + 0.2, Math.sin(a) ** 0.8);
      const half = deckHalf(uAt(z)) - STANCHION_IN;
      const x = s * (C + half * Math.cos(a));
      pulpit.push([x, deckAt(x, z) + top + 0.02, z]);
    }
    iron.tube(pulpit, [0.016], 6);
    for (const p of [pulpit[0], pulpit[6], pulpit[12]] as Vec3[]) {
      iron.tube([[p[0], deckAt(p[0], p[2]), p[2]], p], [0.015], 6);
    }
    // The pushpit round this stern, from the outer edge round to the inner.
    const push: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = t * Math.PI;
      const z = lerp(PUSHPIT_FORE, TRANSOM_Z - 0.08, Math.sin(a) ** 0.6);
      const half = deckHalf(uAt(z)) - STANCHION_IN;
      const x = s * (C + half * Math.cos(a));
      push.push([x, sheer(uAt(z)) + top + 0.04, z]);
    }
    iron.tube(push, [0.016], 6);
    for (const p of [push[0], push[5], push[10]] as Vec3[]) {
      iron.tube([[p[0], deckAt(p[0], p[2]), p[2]], p], [0.015], 6);
    }
  }
  return { iron, rope };
}

/** The transoms' oak steps, three on each, and the hemp ladder stowed on the starboard one. */
function steps(): { oak: MeshBuilder; rope: MeshBuilder } {
  const oak = new MeshBuilder('oak');
  const rope = new MeshBuilder('rope');
  for (const s of [1, -1]) {
    for (let k = 0; k < 3; k++) {
      const y = lerp(sheer(0) - 0.32, 0.38, k / 2);
      const w = breadthAt(0, y) * 0.75;
      box(
        oak,
        [s * C - w, y - 0.04, TRANSOM_Z],
        [s * C + w, y, TRANSOM_Z + 0.2],
        shade(OAK, 0.95 + 0.1 * jitter(k + 700)),
      );
      if (D.small) {
        for (const dx of [-w + 0.08, w - 0.08]) {
          box(
            oak,
            [s * C + dx - 0.02, y - 0.16, TRANSOM_Z],
            [s * C + dx + 0.02, y - 0.04, TRANSOM_Z + 0.14],
            OAK,
          );
        }
      }
    }
  }
  if (D.small) {
    // The ladder: two hemp sides and wooden steps, hanging stowed on the
    // starboard transom's inboard side.
    const x = C - 0.5;
    for (const dx of [-0.12, 0.12]) {
      rope.tube(
        [
          [x + dx, sheer(0) - 0.05, TRANSOM_Z + 0.02],
          [x + dx, 0.45, TRANSOM_Z + 0.02],
        ],
        [0.008],
        4,
      );
    }
    for (let k = 0; k < 3; k++) {
      const y = lerp(sheer(0) - 0.25, 0.55, k / 2);
      box(oak, [x - 0.14, y - 0.02, TRANSOM_Z + 0.02], [x + 0.14, y + 0.02, TRANSOM_Z + 0.05], OAK);
    }
  }
  return { oak, rope };
}

// --- Spars, rigging and sails ----------------------------------------------------

const MAST_Z = -rig.mastPosition;
/** The mast is stepped on the roof. */
const mastFootY = roofY(0, MAST_Z);
const MAST_TOP = rig.boomHeight + rig.luff + 0.14;
const MAST_FOOT_R = 0.12;
const MAST_HEAD_R = 0.07;
const mastR = (y: number): number =>
  lerp(MAST_FOOT_R, MAST_HEAD_R, Math.max(0, (y - mastFootY) / (MAST_TOP - mastFootY)) ** 2);
/** The jib's tack, on the furler's reel on the forward crossbeam; its head on the forestay. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];
/** The hounds, where the forestay and the shrouds meet the mast: I 15.377 m above the sheer at the mast. */
const HOUNDS = sheer(uAt(MAST_Z)) + 15.377;
const STAY_TOP: Vec3 = [0, HOUNDS, MAST_Z - mastR(HOUNDS)];
/** How far aft of the tack the jib's head is, along the forestay. */
const RAKE = (headsails.headsailLuff * (STAY_TOP[2] - TACK[2])) / (STAY_TOP[1] - TACK[1]);
/** One pair of spreaders, swept aft. */
const SPREADER_Y = 10.6;
const SPREADER_LENGTH = 1.35;
const SPREADER_SWEEP = (20 * Math.PI) / 180;
/** The shrouds' chainplates, on the side decks outboard of the round-house, aft of the mast. */
const CHAIN_X = HOUSE_SIDE + 0.25;
const CAP_Z = MAST_Z + 0.55;
const LOWER_Z = MAST_Z + 0.95;
const DEADEYE_UP = 0.4;
const DEADEYE_DOWN = 0.16;
const DEADEYE_R = 0.05;

const spreaderTip = (s: number): Vec3 => [
  s * SPREADER_LENGTH * Math.cos(SPREADER_SWEEP),
  SPREADER_Y,
  SPREADER_LENGTH * Math.sin(SPREADER_SWEEP),
];

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
  for (const y of [mastFootY + 0.15, SPREADER_Y, HOUNDS, MAST_TOP - 0.08]) {
    const r = mastR(y) + 0.006;
    iron.tube(
      [
        [0, y - 0.035, 0],
        [0, y + 0.035, 0],
      ],
      [r],
      12,
    );
  }
  timber.box(
    [-mastR(SPREADER_Y) - 0.05, SPREADER_Y - 0.045, -0.09],
    [mastR(SPREADER_Y) + 0.05, SPREADER_Y + 0.045, 0.09],
    OAK,
  );
  for (const s of [1, -1]) {
    spar.tube([[s * mastR(SPREADER_Y), SPREADER_Y, 0.02], spreaderTip(s)], [0.04, 0.025], 6);
  }
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
 * The standing rigging, in the boat's frame: the caps over the spreaders to
 * the hounds and the lowers to under the spreaders, each set up with a pair
 * of deadeyes and a lanyard to an iron chainplate on the side deck; the
 * forestay from the forward crossbeam's middle to the hounds, the jib's
 * roller of pine on it with the brass reel at its foot. No backstay.
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
  const R = 0.01;
  const sides = 4;
  const at = (p: Vec3): Vec3 => [p[0], p[1], p[2] + MAST_Z];
  for (const s of [1, -1]) {
    for (const [z, from] of [
      [CAP_Z, [[s * mastR(HOUNDS), HOUNDS, MAST_Z], at(spreaderTip(s))]],
      [LOWER_Z, [[s * mastR(SPREADER_Y), SPREADER_Y - 0.15, MAST_Z]]],
    ] as [number, Vec3[]][]) {
      const upper = deadeye(s, z, DEADEYE_UP);
      const lower = deadeye(s, z, DEADEYE_DOWN);
      rope.tube([...from, add(upper, [0, DEADEYE_R, 0])], [R], sides);
      rope.tube([upper, lower], [0.005], sides);
      for (const p of [upper, lower]) {
        wood.tube(
          [
            [p[0] - 0.018, p[1], p[2]],
            [p[0] + 0.018, p[1], p[2]],
          ],
          [DEADEYE_R],
          8,
          shade(VARNISH, 0.45),
        );
      }
      const footY = deckAt(CHAIN_X, z);
      iron.box(
        [s * CHAIN_X - 0.014, footY - 0.01, z - 0.025],
        [s * CHAIN_X + 0.014, lower[1] - DEADEYE_R, z + 0.025],
      );
    }
  }
  // The forestay, and the jib's roller round it: glued yellow pine, turned,
  // from the reel at the tack to the head's swivel.
  rope.tube([TACK, STAY_TOP], [R], sides);
  const dir = normalize(sub(STAY_TOP, TACK));
  const head = add(TACK, scale(dir, headsails.headsailLuff / dir[1] + 0.15));
  spar.tube([add(TACK, scale(dir, 0.05)), head], [0.032, 0.024], 6);
  brass.tube([add(TACK, [0, -0.14, 0]), add(TACK, [0, 0.02, 0])], [0.09], 12);
  brass.tube([head, add(head, scale(dir, 0.12))], [0.03], 6);
  // The reel's iron pendant down to the crossbeam.
  iron.box([-0.03, BEAM_Y, TACK[2] - 0.05], [0.03, TACK[1] - 0.14, TACK[2] + 0.05]);
  return { rope, iron, wood, brass, spar };
}

/** The boom's length beyond the main's foot. */
const BOOM_LENGTH = rig.foot + 0.3;

function boom(): { spar: MeshBuilder; iron: MeshBuilder; bag: MeshBuilder; rope: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.09],
      [0, 0, BOOM_LENGTH],
    ],
    [0.08, 0.065],
    D.small ? 10 : 4,
  );
  const iron = new MeshBuilder('iron');
  const bag = new MeshBuilder('flax');
  const rope = new MeshBuilder('rope');
  if (!D.small) {
    return { spar, iron, bag, rope };
  }
  for (const z of [0.16, 1.6, rig.foot + 0.05]) {
    iron.tube(
      [
        [0, 0, z - 0.03],
        [0, 0, z + 0.03],
      ],
      [0.085],
      10,
    );
  }
  // The lazy bag: flax canvas either side of the boom, open at the top along the foot; and the lazy jacks.
  const n = 10;
  for (const s of [1, -1]) {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(0.25, rig.foot - 0.1, i / n);
      const h = 0.32 * Math.sin(Math.PI * Math.min(1, (i / n) * 1.15 + 0.08)) ** 0.5;
      lo.push(bag.vertex([s * 0.065, -0.045, z], [0.85, 0.82, 0.74]));
      hi.push(bag.vertex([s * 0.12, h, z], [0.85, 0.82, 0.74]));
    }
    bag.strip(lo, hi, s < 0);
    for (const z of [1.3, 3.1]) {
      rope.tube(
        [
          [s * 0.12, 0.24, z],
          [s * 0.05, 4.6, 1.6],
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
  const top: Vec3 = [0, -0.09, 1.0];
  const foot: Vec3 = [0, mastFootY + 0.18 - rig.boomHeight, 0.15];
  for (const dx of [-0.02, 0, 0.02]) {
    rope.tube([add(top, [dx, -0.08, 0]), add(foot, [dx, 0.08, 0])], [0.006], D.small ? 4 : 3);
  }
  if (D.small) {
    timber.box(add(top, [-0.035, -0.12, -0.05]), add(top, [0.035, 0, 0.05]), OAK);
    timber.box(add(foot, [-0.035, 0, -0.05]), add(foot, [0.035, 0.12, 0.05]), OAK);
  }
  return { rope, timber };
}

/**
 * The main's chord at a fraction of its luff: the foot's full length most
 * of the way up, falling to its square head; the roach set so that its area
 * is the catalog's.
 */
const HEAD = 1.5;
const ROACH_POWER = 3.17;
const chordAt = (v: number): number => rig.foot - (rig.foot - HEAD) * v ** ROACH_POWER;

const REEF_ROWS = rig.reefs.slice(1).map((share) => 1 - share);
/** The battens' heights, fractions of the luff: a fully battened main. */
const BATTENS = [0.14, 0.3, 0.46, 0.62, 0.78, 0.93];

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

/** The self-tacking jib's head's width, and how far its foot rises from the tack to the clew, to clear the round-house's roof. */
const JIB_HEAD = 0.1;
const FOOT_RISE = 1.75;
const jibChord = (v: number): number => headsails.headsailFoot * (1 - v) + JIB_HEAD * v;

/** The jib, flat in the centreline plane at rest, in its node's frame (at the tack): its foot rising aft to the clew. */
function jib(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= D.jibRows; i++) {
    const v = i / D.jibRows;
    const chord = jibChord(v);
    const row: number[] = [];
    for (let j = 0; j <= D.jibCols; j++) {
      const u = j / D.jibCols;
      const rise = FOOT_RISE * u * (1 - v);
      const k = m.vertex(
        [0, v * headsails.headsailLuff + rise, v * RAKE + u * chord],
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

/** The horses: the main sheet's across the roof's after edge, the jib's across the roof before the mast; the main sheet's blocks. */
const MAIN_HORSE_Z = ROOF_AFT - 0.12;
const MAIN_HORSE_X = 2.5;
const JIB_HORSE_Z = TACK[2] + headsails.headsailFoot;
const JIB_HORSE_X = 1.1;
const HORSE_UP = 0.12;

function horses(): { iron: MeshBuilder; oak: MeshBuilder; rope: MeshBuilder } {
  const iron = new MeshBuilder('iron');
  const oak = new MeshBuilder('oak');
  const rope = new MeshBuilder('rope');
  for (const [z, half] of [
    [MAIN_HORSE_Z, MAIN_HORSE_X],
    [JIB_HORSE_Z, JIB_HORSE_X],
  ] as [number, number][]) {
    const pts: Vec3[] = Array.from({ length: 9 }, (_, i) => {
      const x = lerp(-half, half, i / 8);
      return [x, roofY(x, z) + HORSE_UP, z];
    });
    iron.tube(pts, [0.022], D.small ? 6 : 3);
    for (const s of [1, -1]) {
      const x = s * half;
      iron.tube(
        [
          [x, roofY(x, z), z],
          [x, roofY(x, z) + HORSE_UP, z],
        ],
        [0.03],
        6,
      );
    }
    if (D.small) {
      oak.box(
        [-0.05, roofY(0, z) + HORSE_UP - 0.04, z - 0.05],
        [0.05, roofY(0, z) + HORSE_UP + 0.07, z + 0.05],
        OAK,
      );
    }
  }
  if (D.small) {
    // The main sheet's falls from the horse's block up to the boom's.
    for (const dx of [-0.02, 0.02]) {
      rope.tube(
        [
          [dx, roofY(0, MAIN_HORSE_Z) + HORSE_UP + 0.07, MAIN_HORSE_Z],
          [dx, rig.boomHeight - 0.14, MAIN_HORSE_Z],
        ],
        [0.006],
        4,
      );
    }
  }
  return { iron, oak, rope };
}

/** The main sheet's block under the boom, over the horse's. */
function sheetBlock(): MeshBuilder {
  const m = new MeshBuilder('oak');
  m.box([-0.04, -0.07, -0.055], [0.04, 0.03, 0.055], OAK);
  return m;
}

// --- Fittings --------------------------------------------------------------------

/** A small capstan at (x, z) on a surface at y: a lignum vitae drum on an oak barrel, an iron pawl ring, a bronze cap. */
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

/** The capstans at the helm, either side of the console, where the 42's two winches are. */
const CAPSTANS: [number, number][] = [
  [PLAT_OUT + 0.2, NOTCH_FORE + 0.2],
  [HUB[0] + 0.55, NOTCH_FORE + 0.2],
];

/** Cleats of oak on each hull's deck, where she makes fast. */
function cleats(m: MeshBuilder): void {
  const cleat = (x: number, z: number): void => {
    const y = deckAt(x, z);
    m.box([x - 0.02, y - 0.005, z - 0.08], [x + 0.02, y + 0.04, z + 0.08], OAK);
    m.box([x - 0.016, y + 0.04, z - 0.13], [x + 0.016, y + 0.06, z + 0.13], OAK);
  };
  for (const s of [1, -1]) {
    for (const z of [5.3, 1.4, -3.9]) {
      cleat(s * (edgeAt(z) - 0.15), z);
    }
  }
}

// --- Lanterns ------------------------------------------------------------------------

const LENS_RED = srgb(0.5, 0.11, 0.09);
const LENS_GREEN = srgb(0.09, 0.38, 0.2);
const LENS_CLEAR = srgb(0.78, 0.77, 0.7);

/** The sidelights on the forward decks, each on its own hull's outer side, aft of its pulpit; the sternlight hung from its crank at the roof's after edge. */
const SIDELIGHT_Z = PULPIT_AFT + 0.3;
const sidelightAt = (s: number): Vec3 => [
  s * (edgeAt(SIDELIGHT_Z) - 0.12),
  deckAt(edgeAt(SIDELIGHT_Z), SIDELIGHT_Z) + 0.3,
  SIDELIGHT_Z,
];
const STERNLIGHT: Vec3 = [0, roofY(0, ROOF_AFT) - ROOF_THICK - 0.28, ROOF_AFT + 0.12];

/** A sidelight in its node's frame: a brass lamp with its coloured glass, on its post, the screen inboard that keeps it from showing across the bow. */
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
      [0, -0.3, 0],
      [0, -0.05, 0],
    ],
    [0.02, 0.05],
    8,
  );
  board.box([-s * 0.07 - 0.008, -0.1, -0.35], [-s * 0.07 + 0.008, 0.12, 0.07], shade(lens, 0.6));
  return { brass, glass, board };
}

/** The sternlight in its node's frame: a six-sided lantern of clear glass in a brass frame, hung from an iron crank on the roof's after edge. */
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
  const fascia = roofY(0, ROOF_AFT) - ROOF_THICK - 0.02 - STERNLIGHT[1];
  iron.tube(
    [
      [0, 0.14, 0],
      [0, fascia, 0],
      [0, fascia, ROOF_AFT - STERNLIGHT[2] + 0.01],
    ],
    [0.014],
    5,
  );
  return { brass, glass, iron };
}

// --- Keels and rudders --------------------------------------------------------

/** A tapering foil: sections from the root down, each its height, its leading and trailing edges and its thickness. */
function foil(
  m: MeshBuilder,
  sections: { y: number; z0: number; z1: number; t: number }[],
  x: number,
): void {
  const n = D.small ? 10 : 3;
  const rings = sections.map(({ y, z0, z1, t }) => {
    const out: number[] = [];
    for (let i = 0; i <= n * 2; i++) {
      const a = (i / (n * 2)) * 2 * Math.PI;
      const s = (1 - Math.cos(a)) / 2;
      const dx = (t / 2) * Math.sin(a) * (1 - 0.6 * s);
      const k = m.vertex([x + dx, y, z0 + s * (z1 - z0)]);
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
  const centre = m.vertex([x, last.y, (last.z0 + last.z1) / 2]);
  m.normal(centre, [0, -1, 0]);
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(centre, ring[i] as number, ring[i + 1] as number, [0, -1, 0]);
  }
}

/** The keels' bottom; each keel's root inside its canoe body; how far aft its leading edge sweeps; its thickness over its chord. */
const KEEL_BOTTOM = -(hull.hullDraught + foils.boardSpan);
const keelRoot = (): number => -keelDepth(uAt(-foils.boardPosition)) + 0.12;
const KEEL_SWEEP = 0.9;
const KEEL_THICK = 0.075;

/** Each keel's sections in the keel node's frame: long and low, its leading edge raked well aft, its trailing edge near upright. */
function keelSections(): { y: number; z0: number; z1: number; t: number }[] {
  const c = foils.boardChord;
  const rows = D.small ? 5 : 1;
  return Array.from({ length: rows + 1 }, (_, i) => {
    const f = i / rows;
    const z0 = -c / 2 + KEEL_SWEEP * f ** 1.5;
    const z1 = c / 2 - 0.15 * f;
    return { y: lerp(keelRoot(), KEEL_BOTTOM, f), z0, z1, t: KEEL_THICK * c * (1 - 0.35 * f) };
  });
}

/** The two keels, in the keel node's frame: oak sheathed in copper, one under each hull. */
function keels(): MeshBuilder {
  const m = new MeshBuilder('copper');
  for (const s of [1, -1]) {
    foil(m, keelSections(), s * C);
  }
  for (let i = 0; i < m.count; i++) {
    const tone = 0.9 + 0.15 * jitter(Math.floor((m.positions[i * 3 + 1] ?? 0) * 3) + 900);
    m.colors.splice(i * 3, 3, COPPER[0] * tone, COPPER[1] * tone, COPPER[2] * tone);
  }
  return m;
}

/** Where each hull's bottom is over its rudder's stock: the blade's root; its tip. */
const RUDDER_U = uAt(foils.rudderPosition);
const RUDDER_ROOT = -keelDepth(RUDDER_U);
const RUDDER_TIP = -(hull.hullDraught + foils.rudderSpan);

/** A rudder in its stock's frame: an oak blade sheathed in copper, its bronze stock up through the hull to the deck. */
function rudder(): { blade: MeshBuilder; bronze: MeshBuilder } {
  const m = new MeshBuilder('foil');
  const c = foils.rudderChord;
  const rows = D.small ? 3 : 1;
  foil(
    m,
    Array.from({ length: rows + 1 }, (_, i) => {
      const f = i / rows;
      const z0 = -0.12 + 0.06 * f;
      const z1 = z0 + lerp(c, c * 0.72, f);
      return { y: lerp(RUDDER_ROOT + 0.03, RUDDER_TIP, f), z0, z1, t: 0.11 * (z1 - z0) };
    }),
    0,
  );
  const bronze = new MeshBuilder('bronze');
  bronze.tube(
    [
      [0, RUDDER_ROOT - 0.05, 0],
      [0, deckAt(C, foils.rudderPosition) + 0.06, 0],
    ],
    [0.035],
    D.small ? 8 : 3,
  );
  return { blade: m, bronze };
}

/** The tie rod inside the aft crossbeam joining the two rudders' arms, so they turn as one: drawn, unseen, as the tiller. */
const TIE_Y = (UNDERSIDE + SOLE) / 2;
const TIE_ARM = foils.rudderPosition - (BRIDGE_AFT - 0.15);

function tieRod(): MeshBuilder {
  const m = new MeshBuilder('iron');
  m.tube(
    [
      [-C, 0, 0],
      [C, 0, 0],
    ],
    [0.02],
    D.small ? 6 : 3,
  );
  return m;
}

// --- The far model's decks ---------------------------------------------------------

function plainDeck(): MeshBuilder {
  return deck();
}

// --- The hull's volume -------------------------------------------------------
//
// The sea is not drawn inside a hull: a volume of stations along it, each
// with the half-beam at the waterline and the depth of the bottom, measured
// from one hull's own mesh about its centreline, which is offset half the
// spacing either side of the boat's.

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
      widest = Math.max(widest, Math.abs(a[0] + f * (b[0] - a[0]) - C));
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

/** One hull's volume, measured from its mesh, for keeping the sea out of it, and its centreline's offset from the boat's. */
function hullVolume(m: MeshBuilder): { stations: number[][]; bilge: number; offset: number } {
  let fore = TRANSOM_Z;
  let aft = BOW_Z;
  for (let i = 0; i < m.count; i++) {
    if ((m.positions[i * 3 + 1] ?? 0) < 0 && (m.positions[i * 3] ?? 0) > 0) {
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
  return { stations: out, bilge: round4(bilge / measured), offset: C };
}

/**
 * The boat as a solid, for what keeps a sailor out of it: stations from the
 * transoms to the bows, each [z, half-beam of the plan (the hulls' outer
 * sides), the decks' height, the keels' depth], whose sections are
 * superellipses of the exponent; and the cockpit, open from the after
 * bulkhead to the aft crossbeam down to its sole between the hulls' inner
 * sides and, at the helm, the platform.
 */
function solid(): Record<string, unknown> {
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const u = i / 20;
      return [
        round4(zAt(u)),
        round4(outline(u)),
        round4(sheer(u)),
        round4(Math.max(0, keelDepth(u))),
      ];
    }),
    exponent: 2.2,
    cockpit: {
      fore: round4(NOTCH_FORE),
      aft: round4(BRIDGE_AFT),
      halfWidth: round4(-PLAT_OUT),
      floor: round4(SOLE),
    },
  };
}

/**
 * The bridgedeck's plan, for the sea under it and the stations on it: from
 * the nacelle's foot under its fore end to the aft crossbeam, between the hulls'
 * inner sides (their least half-spacing there at the underside); the
 * underside's height; and the top of what stands at its after end, the
 * roof's after edge on the centreline, where her sternlight hangs.
 */
function bridgedeckData(): Record<string, number> {
  let half = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= 40; i++) {
    half = Math.min(half, innerAt(lerp(NACELLE_FOOT, BRIDGE_AFT, i / 40), UNDERSIDE));
  }
  return {
    fore: round4(NACELLE_FOOT),
    aft: round4(BRIDGE_AFT),
    halfWidth: round4(half),
    underside: UNDERSIDE,
    top: round4(roofY(0, ROOF_AFT)),
  };
}

/**
 * Where her people sit, climb and walk, for the clips they are drawn with
 * (art/sailors' stage of her, and the game placing them): each seat's
 * front edge on its top where a clip of it is made (at a station), the way
 * one sat there faces (degrees from ahead toward starboard, as a
 * station's), the floor under the feet, the seat's back (how far behind
 * the edge, and its top over the floor) and its ends along the edge (x
 * or z as the edge runs); the table (its sides, ends and top); the
 * ladder's foot and head on its middle where it is climbed from and to,
 * its run (from its foot to the landing, z), its rise and run a tread,
 * its treads' sides, its rail's line (inboard of the treads, its height
 * over their nosings, and inboard of the landing); the sole where the
 * cockpit is walked; the platform's height; the floors' plans.
 */
function seatsData(): Record<string, unknown> {
  const v = (p: Vec3): number[] => p.map(round4);
  const rise = (PLAT_Y - SOLE) / (TREADS + 1);
  const run = (LADDER_FOOT - LANDING_AFT) / TREADS;
  const mid = (PLAT_IN + LADDER_IN) / 2;
  return {
    helm: {
      at: v([STATIONS[1]?.at[0] ?? 0, SETTLE_TOP, SETTLE_FORE]),
      facing: 0,
      floor: PLAT_Y,
      back: round4(SETTLE_AFT - SETTLE_FORE),
      backTop: round4(SETTLE_TOP + SETTLE_BACK - PLAT_Y),
      along: v([SETTLE_OUT, SETTLE_IN, 0]).slice(0, 2),
    },
    table: {
      at: v([LBENCH_FRONT, SEAT_TOP, 3.35]),
      facing: 270,
      floor: SOLE,
      back: round4(LBENCH_OUT - LBENCH_FRONT),
      backTop: round4(SEAT_TOP + 0.4 - SOLE),
      along: v([LBENCH_LEG, LBENCH_AFT, 0]).slice(0, 2),
      top: v([TABLE.x0, TABLE.x1, TABLE.z0]).concat(round4(TABLE.z1), round4(TABLE.y)),
    },
    beam: {
      at: v([0.85, SEAT_TOP, AFT_FRONT]),
      facing: 0,
      floor: SOLE,
      back: round4(AFT_BACK + 0.03 - AFT_FRONT),
      backTop: round4(SEAT_TOP + 0.42 - SOLE),
      along: v([AFT_PORT, AFT_STAR, 0]).slice(0, 2),
    },
    lounger: {
      at: v([LOUNGER_FRONT, LOUNGER_TOP, 4.05]),
      facing: 90,
      floor: SOLE,
      back: round4(LOUNGER_FRONT - LOUNGER_OUT),
      backTop: round4(LOUNGER_TOP + 0.4 - SOLE),
      along: v([LOUNGER_FORE, LOUNGER_AFT, 0]).slice(0, 2),
    },
    stairs: {
      foot: v([mid, SOLE, LADDER_FOOT + 0.23]),
      head: v([mid - 0.04, PLAT_Y, LANDING_AFT - 0.2]),
      from: round4(LADDER_FOOT),
      to: round4(LANDING_AFT),
      rise: round4(rise),
      run: round4(run),
      treads: TREADS,
      sides: v([PLAT_IN + 0.05, LADDER_IN - 0.05, 0]).slice(0, 2),
      rail: v([LADDER_RAIL, 0.9, LANDING_RAIL]),
    },
    walk: v([-0.21, SOLE, 3.05]),
    platform: PLAT_Y,
    // The floors' plans, x from and to, z from and to: the cockpit's sole
    // between the hulls' inner sides, the helm's platform and its landing.
    floors: {
      sole: [-1.6, LBENCH_FRONT, HOUSE_AFT, BRIDGE_AFT].map(round4),
      platform: [PLAT_OUT, LADDER_IN, PLAT_FORE, PLAT_AFT].map(round4),
    },
  };
}

/** How far the model's plan, drawn straight between its stations, lies from the outline at most, in metres. */
function planDeviation(): number {
  const s = stations();
  let most = 0;
  for (let k = 0; k + 1 < s.length; k++) {
    const a = s[k] ?? 0;
    const b = s[k + 1] ?? 0;
    for (let j = 0; j <= 20; j++) {
      const u = a + ((b - a) * j) / 20;
      const drawn = C + deckHalf(a) + ((deckHalf(b) - deckHalf(a)) * j) / 20;
      most = Math.max(most, Math.abs(drawn - outline(u)));
    }
  }
  return most;
}

// --- What the physics reads of her shape ----------------------------------------

/**
 * Her sections, for her righting lever (tools/lever): every LEVER_STEP from
 * the bows to the transoms, the starboard half of the watertight body. It
 * runs from the centreline round to the centreline: where the bridgedeck
 * is, along its underside to the hull's inner side, down it round the keel
 * and up the outer side to the sheer, across the deck, then over the
 * round-house to its roof, or down into the cockpit to its sole, or across
 * the locker deck; where the hulls stand apart, out along the deck's height
 * to the inner sheer and back (no area), round the hull. The cockpit is
 * open: it floats nothing. Her appendages (the keels, the rudders) are
 * small volumes, each its place and its volume.
 */
const LEVER_STEP = 0.25;
const LEVER_POINTS = 16;

function leverData(): Record<string, unknown> {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  const out: [number, number[]][] = [];
  for (let z = BOW_Z + 0.05; z < TRANSOM_Z; z += LEVER_STEP) {
    const u = uAt(z);
    const pts: number[] = [];
    const push = (x: number, y: number): void => {
      pts.push(r(x), r(y));
    };
    const s = sheer(u);
    const hullRound = (fromG: number): void => {
      // Down the inner side from fromG to the keel, then up the outer side to the sheer.
      for (let i = 0; i <= LEVER_POINTS; i++) {
        const g = fromG * (1 - i / LEVER_POINTS);
        const p = section(u, g, -1);
        push(p[0], p[1]);
      }
      for (let i = 1; i <= LEVER_POINTS; i++) {
        const p = section(u, i / LEVER_POINTS, 1);
        push(p[0], p[1]);
      }
    };
    const bridged = z > NACELLE_FOOT && z < BRIDGE_AFT;
    if (bridged) {
      push(0, UNDERSIDE);
      hullRound(girthAt(u, UNDERSIDE));
      if (z > HOUSE_FORE && z < HOUSE_AFT) {
        push(HOUSE_SIDE, deckAt(HOUSE_SIDE, z));
        const ry =
          z > ROOF_FRONT
            ? roofY(HOUSE_SIDE, z)
            : lerp(
                deckAt(HOUSE_SIDE, z),
                roofY(HOUSE_SIDE, ROOF_FRONT),
                (z - HOUSE_FORE) / (ROOF_FRONT - HOUSE_FORE),
              );
        push(HOUSE_SIDE, ry);
        push(0, ry + (z > ROOF_FRONT ? ROOF_CROWN : 0));
      } else if (z <= HOUSE_FORE) {
        push(C - deckHalf(u), s);
        push(0, LOCKERS_Y);
      } else {
        push(C - deckHalf(u), s);
        push(innerAt(z, SOLE), SOLE);
        push(0, SOLE);
      }
    } else {
      push(0, s);
      push(C - deckHalf(u), s);
      hullRound(1);
      push(C - deckHalf(u), s);
      push(0, s);
    }
    out.push([r(z), pts]);
  }
  // The appendages, each cut into small volumes: the keels, then the rudders.
  const elements: number[][] = [];
  const keelZ = -foils.boardPosition;
  const ks = keelSections();
  for (const sgn of [1, -1]) {
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i] as { y: number; z0: number; z1: number; t: number };
      const b = ks[i + 1] as { y: number; z0: number; z1: number; t: number };
      const y0 = Math.min(a.y, -keelDepth(uAt(keelZ)));
      const chord = (a.z1 - a.z0 + (b.z1 - b.z0)) / 2;
      const t = (a.t + b.t) / 2;
      const area = 0.68 * chord * t;
      const along = 8;
      for (let j = 0; j < along; j++) {
        elements.push([
          r(sgn * C),
          r((y0 + b.y) / 2),
          r(keelZ + (a.z0 + b.z0) / 2 + chord * ((j + 0.5) / along)),
          r((area * Math.abs(y0 - b.y)) / along),
        ]);
      }
    }
  }
  const rc = foils.rudderChord;
  for (const sgn of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const y0 = lerp(RUDDER_ROOT, RUDDER_TIP, i / 4);
      const y1 = lerp(RUDDER_ROOT, RUDDER_TIP, (i + 1) / 4);
      const area = 0.68 * rc * 0.11 * rc;
      elements.push([
        r(sgn * C),
        r((y0 + y1) / 2),
        r(foils.rudderPosition + rc * 0.35),
        r(area * Math.abs(y1 - y0)),
      ]);
    }
  }
  return { step: LEVER_STEP, sections: out, elements };
}

/** Both hulls' waterplane at rest: the beam outside them, their area, its second moment about its centre along the length; and their wetted area. */
function waterplane(): {
  beam: number;
  area: number;
  pitch: number;
  centre: number;
  wetted: number;
} {
  let area = 0;
  let moment = 0;
  let beam = 0;
  let wetted = 0;
  const n = 400;
  const dz = L / n;
  const strips: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const half = keelDepth(u) > 0 ? breadthAt(u, 0) : 0;
    beam = Math.max(beam, C + half);
    strips.push([zAt(u), 2 * 2 * half]);
    area += 2 * 2 * half * dz;
    moment += 2 * 2 * half * dz * zAt(u);
    // The wetted girth of this section, both sides, both hulls.
    if (keelDepth(u) > 0) {
      const g0 = girthAt(u, 0);
      let girth = 0;
      const k = 40;
      for (let j = 0; j < k; j++) {
        const a = section(u, (g0 * j) / k, 1);
        const b = section(u, (g0 * (j + 1)) / k, 1);
        girth += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      wetted += 4 * girth * dz;
    }
  }
  const centre = moment / area;
  let pitch = 0;
  for (const [z, w] of strips) {
    pitch += w * dz * (z - centre) ** 2;
  }
  return { beam: 2 * beam, area, pitch, centre, wetted };
}

// --- The model ---------------------------------------------------------------

/** The gunwale at the helm's station: the outline's half-beam on the starboard deck. */
const GUNWALE: Vec3 = [outline(uAt(STANCE[2])), sheer(uAt(STANCE[2])), STANCE[2]];

function model(): NodeDef[] {
  // One hull, then both: the port one its mirror.
  const shell = planking();
  const one = new MeshBuilder('paint');
  one.append(shell.copper);
  one.append(shell.paint);
  one.append(shell.topsides);
  const waterline = hullVolume(one);
  const both = (m: MeshBuilder): MeshBuilder => {
    const out = new MeshBuilder(m.material);
    out.append(m);
    out.append(m, true);
    return out;
  };
  const rails = new MeshBuilder('varnish');
  rubrails(rails);
  const decks = both(D.plankedDeck ? deck() : plainDeck());
  const bd = bridgedeck();
  const house = roundHouse();
  const helm = helmStation();
  const seats = cockpitFurniture();
  const front = beams();
  const hullParts = [
    both(shell.copper).primitive({ colors: true }),
    both(shell.paint).primitive({ colors: true }),
    both(shell.topsides).primitive({ colors: true }),
    decks.primitive({ colors: true }),
    both(rails).primitive({ colors: true }),
    bd.paint.primitive({ colors: true }),
    bd.deck.primitive({ colors: true }),
    bd.oak.primitive({ colors: true }),
    house.wood.primitive({ colors: true }),
    house.roof.primitive({ colors: true }),
    helm.deck.primitive({ colors: true }),
    helm.wood.primitive({ colors: true }),
    helm.oak.primitive({ colors: true }),
    seats.wood.primitive({ colors: true }),
    seats.oak.primitive({ colors: true }),
    front.oak.primitive({ colors: true }),
    front.net.primitive({ colors: true }),
  ];
  const h = horses();
  const fittings = {
    timber: new MeshBuilder('oak'),
    iron: new MeshBuilder('iron'),
    bronze: new MeshBuilder('bronze'),
  };
  if (D.small) {
    hullParts.push(h.iron.primitive());
    for (const [x, z] of CAPSTANS) {
      capstan(fittings, x, PLAT_Y, z, 0.8);
    }
    cleats(fittings.timber);
    hullParts.push(fittings.timber.primitive({ colors: true }));
  }
  const masts = mast();
  const mastParts = [masts.spar.primitive()];
  const spars = boom();
  const boomParts = [spars.spar.primitive()];
  if (D.small) {
    const ports = portlights();
    const guards = guardrails();
    const tack = groundTackle();
    const st = steps();
    hullParts.push(
      both(ports.bronze).primitive(),
      both(ports.glass).primitive({ colors: true }),
      house.glass.primitive({ colors: true }),
      house.frames.primitive({ colors: true }),
      house.brass.primitive(),
      helm.bronze.primitive(),
      helm.brass.primitive(),
      helm.glass.primitive({ colors: true }),
      guards.iron.primitive(),
      guards.rope.primitive(),
      front.iron.primitive(),
      tack.iron.primitive(),
      tack.oak.primitive({ colors: true }),
      st.oak.primitive({ colors: true }),
      st.rope.primitive(),
      h.oak.primitive({ colors: true }),
      h.rope.primitive(),
      fittings.iron.primitive(),
      fittings.bronze.primitive(),
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
    gooseneck.box([-0.055, -0.055, -0.13], [0.055, 0.055, 0.11]);
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
        bridgedeck: bridgedeckData(),
        ...(D === NEAR ? { lever: leverData() } : {}),
      },
    },
    {
      name: 'mast',
      translation: [0, 0, MAST_Z],
      primitives: mastParts,
      extras: { chainplates: [CAP_Z, LOWER_Z].map((z) => [round4(CHAIN_X), round4(z)]) },
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
                translation: [0, -0.09, MAIN_HORSE_Z - MAST_Z] as Vec3,
                primitives: [sheetBlock().primitive({ colors: true })],
              },
            ]
          : []),
      ],
    },
    {
      name: 'sail',
      translation: [0, rig.boomHeight, MAST_Z],
      extras: { battens: BATTENS },
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
    const staff = new MeshBuilder('brass');
    staff.tube(
      [
        [0, MAST_TOP + 0.07, 0],
        [0, MAST_TOP + STAFF_TOP, 0],
      ],
      [0.008, 0.005],
      6,
    );
    (nodes[1] as NodeDef).primitives?.push(staff.primitive());
    // The lanterns, each node named as its light.
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
  // The wheel at its hub, off the centreline to port, turned with the rudders.
  const w = wheel();
  nodes.push({
    name: 'wheel',
    translation: HUB,
    extras: {
      wheel: {
        radius: WHEEL_RADIUS,
        spokes: WHEEL_SPOKES,
        handles: WHEEL_HANDLE,
        ahead: WHEEL_AHEAD,
        up: WHEEL_UP,
      },
    },
    primitives: D.small
      ? [
          w.wood.primitive({ colors: true }),
          w.brass.primitive(),
          w.rope.primitive({ colors: true }),
        ]
      : [wheelDisc().primitive({ colors: true })],
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
        { name: 'rudder-port', translation: [-C, 0, 0], primitives: rudderPrims },
        { name: 'rudder-starboard', translation: [C, 0, 0], primitives: rudderPrims },
        { name: 'tiller', translation: [0, TIE_Y, -TIE_ARM], primitives: [tieRod().primitive()] },
      ],
    },
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [keels().primitive({ colors: true })],
    },
    // The helm's stance at the wheel, on the platform.
    { name: 'sailor', translation: STANCE },
    // Where her people sit, climb and walk.
    { name: 'seats', extras: { seats: seatsData() } },
    { name: 'gunwale', translation: GUNWALE },
    {
      name: 'board-root',
      translation: [round4(C), round4(-keelDepth(uAt(-foils.boardPosition))), -foils.boardPosition],
    },
  );
  return nodes;
}

// The drawn plan and the sails must be what the physics says.
const mostChord = Math.max(...Array.from({ length: 201 }, (_, i) => chordAt(i / 200)));
if (mostChord > rig.foot + 1e-9) {
  throw new Error(`the main's chord reaches ${mostChord.toFixed(3)} m, past its foot`);
}
for (const u of stations(100)) {
  if (C + deckHalf(u) > outline(u) + 1e-9) {
    throw new Error(`the hull at station ${u.toFixed(2)} is wider than the outline`);
  }
}
if (Math.abs(PLAT_Y - (hull.centreOfGravity + sailor.sailorSeatHeight)) > 1e-6) {
  throw new Error(
    `the catalog's sailor stands at the platform: sailorSeatHeight ${round4(PLAT_Y - hull.centreOfGravity)}`,
  );
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
    {
      stdio: 'inherit',
    },
  );
}

// What the catalog takes from the model, and the people's stations.
D = NEAR;
const wp = waterplane();
const station = (at: Vec3): string => `[${at.map((v) => round4(v)).join(', ')}]`;
let mainArea = 0;
for (let i = 0; i < 1000; i++) {
  mainArea += (chordAt((i + 0.5) / 1000) * rig.luff) / 1000;
}
process.stdout.write(
  `wrote art/${MODEL} and art/${FAR_MODEL}: bows ${BOW_Z.toFixed(2)} m, transoms ${TRANSOM_Z.toFixed(2)} m\n` +
    `  both hulls: outside them at the waterline ${wp.beam.toFixed(3)} m, waterplane ${wp.area.toFixed(2)} m², its second moment ${wp.pitch.toFixed(1)} m⁴ about ${wp.centre.toFixed(2)} m; wetted ${wp.wetted.toFixed(2)} m² (${(wp.wetted / 2).toFixed(2)} a hull)\n` +
    `  the main's drawn area ${mainArea.toFixed(2)} m²; the jib's rake ${RAKE.toFixed(3)} m; the helm's platform ${PLAT_Y.toFixed(3)} m up; the sternlight ${station(STERNLIGHT)}\n` +
    `  stations:\n${STATIONS.map((s) => `      - { at: ${station(s.at)}, pose: ${s.pose}, facing: ${s.facing} }`).join('\n')}\n`,
);

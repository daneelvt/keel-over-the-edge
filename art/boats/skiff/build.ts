// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The skiff: a two-person trapeze skiff of our time built by a shipwright
// of the period. A clinker-planked hull on a skiff's lines (a plumb bow, a
// narrow waterline under flared topsides, a wide flat run aft to an open
// transom), its topsides in the paint its sailor chooses, with a dark sheer
// strake and a varnished transom; a foredeck and side decks laid in planks,
// and an open cockpit; racks of ash off the gunwales out to her beam, a net
// of hemp between rail and gunwale; a fractional rig of varnished spruce
// with iron bands, one pair of swept spreaders and tarred shrouds set up
// with deadeyes; trapeze wires from the hounds to a bronze ring each side;
// a fully battened, square-headed flax main, a self-tacking jib on its
// bronze horse, and a gennaker tacked at the end of an ash bowsprit; an oak
// centreboard and a kick-up rudder on bronze pintles, a tiller with a long
// extension; bronze, brass and iron fittings, and at the masthead the brass
// tricolour lantern with the pennant's staff above it.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: length and the plan at the sheer (the racks'
// rails where they reach past the gunwale), the canoe body's draught, the
// mast's place, the boom's height, the main's luff and foot, the jib's and
// the gennaker's luff, foot, tack and tack's height, the board's and
// rudder's places, spans and chords, the seat's height. The rest (sheer,
// profile, sections, planking, the racks, the rigging) are this script's
// own.
//
// The helm is laid out as the boat the sailors are staged in has it
// (art/sailors/tables.yaml's stage), about the rack's rail, which is this
// boat's gunwale: the side deck as wide (the net and the hull's side deck
// together), the cockpit's floor as far below it, the tiller's hinge as far
// from the seat; the `sailor` node carries the difference between the two
// seats.
//
// It builds the boat twice from the same lines: in full, and the far model,
// with few segments, no laps, net, rigging, telltales, pennant, lantern or
// fittings, and a plain deck. The catalog's art.model and art.far name them.
//
//   node art/boats/skiff/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  blade,
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
const MODEL = 'boats/skiff.glb';
const FAR_MODEL = 'boats/skiff.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along the hull: a multiple of ten and of the racks' end, so the outline's points are among them. */
  stations: number;
  /** The strakes' edges as girth fractions, keel to sheer; the chine is one of them. */
  strakes: number[];
  /** Rows a strake: its girth fractions. */
  strakeRows: number[];
  /** Whether each plank laps the one below, with its land. */
  laps: boolean;
  /** The deck in planks round the cockpit, or plain; its rows along the hull. */
  plankedDeck: boolean;
  deckStations: number;
  /** Around tubes and blades, and along the mast. */
  round: number;
  mastStations: number;
  /** The mainsail's rows and columns, the jib's and the gennaker's. */
  sailRows: number;
  sailCols: number;
  jibRows: number;
  jibCols: number;
  kiteRows: number;
  kiteCols: number;
  /** The racks' struts and net, rigging, telltales, pennant, lantern and the fittings. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 40,
  strakes: [0, 0.15, 0.3, 0.45, 0.6, 0.74, 0.87, 1],
  strakeRows: [0, 0.5, 1],
  laps: true,
  plankedDeck: true,
  deckStations: 20,
  round: 12,
  mastStations: 10,
  sailRows: 24,
  sailCols: 10,
  jibRows: 16,
  jibCols: 6,
  kiteRows: 16,
  kiteCols: 8,
  small: true,
};

const FAR: Detail = {
  stations: 20,
  strakes: [0, 0.45, 0.87, 1],
  strakeRows: [0, 1],
  laps: false,
  plankedDeck: false,
  deckStations: 10,
  round: 5,
  mastStations: 1,
  sailRows: 8,
  sailCols: 3,
  jibRows: 6,
  jibCols: 2,
  kiteRows: 6,
  kiteCols: 3,
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
    downwind: {
      downwindLuff: number;
      downwindFoot: number;
      downwindTackHeight: number;
      downwindTack: number;
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
const { hull, rig, headsails, downwind, foils, sailor } = boat.physics;

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

/** Height of the sheer above the waterline: low aft, rising to the stem's head, where the jib is tacked. */
const sheer = (u: number): number => 0.37 + 0.07 * u * u;

/** The catalog's outline: the plan at the sheer, the racks' rails where they reach past the gunwale. */
function outline(u: number): number {
  const o = hull.outline;
  const x = Math.min(1, Math.max(0, u)) * (o.length - 1);
  const i = Math.min(o.length - 2, Math.floor(x));
  const f = x - i;
  return (o[i] ?? 0) * (1 - f) + (o[i + 1] ?? 0) * f;
}

/**
 * Where the racks end forward, as a station: just forward of the mast,
 * where their rails come in to the gunwale. Aft they reach the transom's
 * corners. Between, the plan is the rails'; forward of them, the hull's.
 */
const RACK_FORE = 0.65;
/** How the gunwale's breadth runs under the racks: its slope at the transom and at the racks' forward end, per station. */
const GUNWALE_AFT_SLOPE = 0.3;
const GUNWALE_FORE_SLOPE = -0.3;

/**
 * Half the hull's beam at its sheer: the outline forward of the racks; under
 * them, a fair curve from the transom's corner to the racks' forward end, a
 * little fuller than its ends, inside the rails.
 */
function hullBeam(u: number): number {
  if (u >= RACK_FORE) {
    return outline(u);
  }
  const t = Math.max(0, u) / RACK_FORE;
  const p0 = outline(0);
  const p1 = outline(RACK_FORE);
  const m0 = GUNWALE_AFT_SLOPE * RACK_FORE;
  const m1 = GUNWALE_FORE_SLOPE * RACK_FORE;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1
  );
}

/** The racks' rails stand this far above the sheer, on their struts. */
const RACK_RISE = 0.07;
/** The rail's top. */
const railTop = (u: number): number => sheer(u) + RACK_RISE;
/** The rail: its breadth and depth, ash, its outer edge on the outline. */
const RAIL_WIDTH = 0.045;
const RAIL_DEPTH = 0.028;

/** Stations along the hull, from the transom (0) to the stem (1). */
const stations = (n = D.stations): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

/** The plan as drawn at a station: the rail's outer edge where the racks are, else the hull's sheer. */
const planAt = (u: number): number =>
  u <= RACK_FORE + 1e-9 ? Math.max(hullBeam(u), outline(u)) : hullBeam(u);

/**
 * How far the model's plan, drawn straight between its stations, lies from
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
      const drawn = planAt(a) + ((planAt(b) - planAt(a)) * j) / 20;
      most = Math.max(most, Math.abs(drawn - outline(u)));
    }
  }
  return most;
}

/** Where the canoe body is deepest along the hull; how far above the water its bottom is at the transom, and below it at the forefoot. */
const DEEPEST = 0.48;
const TRANSOM_LIFT = 0.03;
const FOREFOOT = 0.02;

/**
 * Depth of the keel line below the waterline: the canoe body, deepest a
 * little aft of amidships, rising in a long flat run to the transom just
 * clear of the water, and forward to a forefoot under the plumb stem.
 */
function keelDepth(u: number): number {
  const d = hull.hullDraught;
  if (u <= DEEPEST) {
    return d - (d + TRANSOM_LIFT) * ((DEEPEST - u) / DEEPEST) ** 2;
  }
  return d - (d - FOREFOOT) * ((u - DEEPEST) / (1 - DEEPEST)) ** 2.2;
}

/**
 * The section: a bottom of a superellipse's quarter from the keel to the
 * chine, flat aft and V'd forward, then the topsides flared straight out
 * from the chine to the sheer. The chine is the girth fraction CHINE_G, a
 * strake's edge, so the knuckle falls on a lap.
 */
const CHINE_G = 0.45;
/** The chine's half-breadth, as a share of the sheer's, and its height. */
const CHINE_SHARE = 0.62;
const chineY = (u: number): number => 0.09 + 0.12 * smoothstep(0.5, 1, u);
/** The bottom's exponent: above 2 flat aft, below it V'd forward. */
const bottomN = (u: number): number => lerp(3, 1.8, smoothstep(0.3, 1, u));

/** A point on the starboard half-section at station u, girth fraction g (0 at the keel, 1 at the sheer). */
function section(u: number, g: number): Vec3 {
  const d = keelDepth(u);
  const yc = chineY(u);
  const b = hullBeam(u);
  const c = CHINE_SHARE * b;
  if (g <= CHINE_G) {
    const a = ((g / CHINE_G) * Math.PI) / 2;
    const e = 2 / bottomN(u);
    return [c * Math.sin(a) ** e, -d + (yc + d) * (1 - Math.cos(a) ** e), zAt(u)];
  }
  const t = (g - CHINE_G) / (1 - CHINE_G);
  return [lerp(c, b, t), lerp(yc, sheer(u), t), zAt(u)];
}

/** The section's outward normal in its plane at u, g, from its points between g0 and g1 (a strake's edges). */
function sectionNormal(u: number, g: number, g0: number, g1: number): Vec3 {
  const h = 1e-4;
  const a = section(u, Math.max(g0, g - h));
  const b = section(u, Math.min(g1, g + h));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l, 0];
}

/** The girth fraction at height y on the section at u (between the keel and the sheer). */
function girthAt(u: number, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (section(u, m)[1] < y) {
      lo = m;
    } else {
      hi = m;
    }
  }
  return (lo + hi) / 2;
}

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'timber', color: [1, 1, 1], roughness: 0.32, metalness: 0 },
  // The planking, in the paint the boat's sailor chooses: its vertices
  // carry only each plank's tone, and the game gives them the paint.
  { name: 'topsides', color: [1, 1, 1], roughness: 0.32, metalness: 0 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.45, metalness: 0 },
  { name: 'spar', color: srgb(0.82, 0.63, 0.36), roughness: 0.35, metalness: 0 },
  { name: 'iron', color: srgb(0.17, 0.17, 0.18), roughness: 0.5, metalness: 0.6 },
  { name: 'flax', color: srgb(0.93, 0.89, 0.78), roughness: 0.85, metalness: 0, doubleSided: true },
  { name: 'bronze', color: srgb(0.74, 0.5, 0.24), roughness: 0.35, metalness: 0.9 },
  { name: 'rope', color: srgb(0.24, 0.18, 0.12), roughness: 0.9, metalness: 0 },
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

// --- The planking ------------------------------------------------------------

/** How far each plank's lower edge stands out over the plank below, in metres. */
const LAP = 0.012;
/** The dark sheer strake, the varnished transom, and the timber of the rubbing strake. */
const SHEER_STRAKE = srgb(0.165, 0.133, 0.106);
const MAHOGANY = srgb(0.5, 0.25, 0.13);
const TIMBER = srgb(0.68, 0.42, 0.2);

/**
 * The planking, both sides: the strakes below the sheer strake in the
 * paint (their vertices each plank's tone), the sheer strake dark and
 * bright. Each plank laps the one below, its land a narrow face looking
 * down toward the keel.
 */
function planking(): { painted: MeshBuilder; bright: MeshBuilder } {
  const painted = new MeshBuilder('topsides');
  const bright = new MeshBuilder('timber');
  const strakes = D.strakes;
  const laps = D.laps;
  for (let k = 0; k + 1 < strakes.length; k++) {
    const g0 = strakes[k] as number;
    const g1 = strakes[k + 1] as number;
    const sheerStrake = k + 2 === strakes.length;
    const m = sheerStrake ? bright : painted;
    const tone = 0.9 + 0.2 * jitter(k);
    const rows: number[][] = D.strakeRows.map(() => []);
    const land: number[][] = [[], []];
    stations().forEach((at, i) => {
      // At the stem the section is a line: its normal is the one just aft.
      const u = Math.min(at, 0.999);
      const grain = tone * (0.96 + 0.08 * jitter(k * 100 + i));
      const c: Vec3 = sheerStrake ? shade(SHEER_STRAKE, grain) : [grain, grain, grain];
      D.strakeRows.forEach((s, r) => {
        const g = g0 + (g1 - g0) * s;
        const p = section(at, g);
        const n = sectionNormal(u, g, g0, g1);
        // The garboard meets the keel flush; every other plank laps the one below.
        const lap = k === 0 || !laps ? 0 : LAP * (1 - s) ** 0.8;
        const v = m.vertex([p[0] + n[0] * lap, p[1] + n[1] * lap, p[2]], c, [s, at]);
        (rows[r] as number[]).push(v);
      });
      if (k > 0 && laps) {
        const p = section(at, g0);
        const n = sectionNormal(u, g0, g0, g1);
        const down: Vec3 = [n[1], -n[0], 0];
        const dark = shade(c, 0.35);
        const a = m.vertex(p, dark);
        const b = m.vertex([p[0] + n[0] * LAP, p[1] + n[1] * LAP, p[2]], dark);
        m.normal(a, down);
        m.normal(b, down);
        (land[0] as number[]).push(a);
        (land[1] as number[]).push(b);
      }
    });
    // Rows run from the transom forward (-z), girth upward: seen from
    // outside that is counter-clockwise.
    for (let r = 0; r + 1 < rows.length; r++) {
      m.strip(rows[r] as number[], rows[r + 1] as number[]);
    }
    if (k > 0 && laps) {
      m.strip(land[0] as number[], land[1] as number[]);
    }
  }
  const both = (m: MeshBuilder): MeshBuilder => {
    const out = new MeshBuilder(m.material);
    out.append(m);
    out.append(m, true);
    return out;
  };
  return { painted: both(painted), bright: both(bright) };
}

/**
 * The open transom: varnished mahogany across the hull's after end from the
 * keel up to the cockpit's floor, which runs out over it; and above the
 * floor, outboard of the cockpit, the side decks' after ends.
 */
function transom(m: MeshBuilder): void {
  const n = 2 * D.round;
  const lap = D.laps ? LAP : 0;
  const top = girthAt(0, COCKPIT_FLOOR);
  const ring: number[] = [];
  const at = (g: number, s: number): Vec3 => {
    const p = section(0, g);
    return [s * (p[0] + (g > 0 ? lap : 0)), p[1], TRANSOM_Z];
  };
  for (let i = 0; i <= n; i++) {
    ring.push(m.vertex(at((top * i) / n, 1), MAHOGANY));
  }
  for (let i = n; i >= 0; i--) {
    ring.push(m.vertex(at((top * i) / n, -1), MAHOGANY));
  }
  const mid = m.vertex([0, (COCKPIT_FLOOR - keelDepth(0)) / 2, TRANSOM_Z], MAHOGANY);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[i + 1] as number, [0, 0, 1]);
  }
  // The side decks' ends: from the cockpit's side out to the planking, the floor up to the deck.
  const w = COCKPIT_HALF_WIDTH;
  const ends = D.small ? 6 : 2;
  for (const s of [1, -1]) {
    const pts: Vec3[] = [[s * w, COCKPIT_FLOOR, TRANSOM_Z]];
    for (let i = 0; i <= ends; i++) {
      pts.push(at(top + ((1 - top) * i) / ends, s));
    }
    for (let i = 1; i < ends; i++) {
      const x = s * lerp(hullBeam(0), w, i / ends);
      pts.push([x, deckY(x, 0), TRANSOM_Z]);
    }
    pts.push([s * w, deckY(w, 0), TRANSOM_Z]);
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const centre = m.vertex([cx, cy, TRANSOM_Z], MAHOGANY);
    m.normal(centre, [0, 0, 1]);
    const ks = pts.map((p) => {
      const k = m.vertex(p, MAHOGANY);
      m.normal(k, [0, 0, 1]);
      return k;
    });
    for (let i = 0; i < ks.length; i++) {
      m.triFacing(centre, ks[i] as number, ks[(i + 1) % ks.length] as number, [0, 0, 1]);
    }
  }
}

/** A rubbing strake along each side at the sheer, varnished. */
function rubrails(m: MeshBuilder): void {
  const c = shade(TIMBER, 0.6);
  for (const s of [1, -1]) {
    const path: Vec3[] = stations(D.stations / 2)
      .filter((u) => u < 0.985)
      .map((u) => [s * (hullBeam(u) + 0.006), sheer(u) - 0.012, zAt(u)]);
    m.tube(path, [0.014], D.small ? 6 : 3, c);
  }
}

// --- The deck and the cockpit ---------------------------------------------------

const CROWN = 0.02;
/** The hull's greatest half-beam at the sheer. */
const HULL_HALF_BEAM = Math.max(...Array.from({ length: 101 }, (_, i) => hullBeam(i / 100)));
/** The deck's height at (x, u). */
const deckY = (x: number, u: number): number => {
  const b = hullBeam(u);
  const t = b > 1e-6 ? Math.min(1, Math.abs(x) / b) : 1;
  return sheer(u) + CROWN * (1 - t * t) * (b / HULL_HALF_BEAM);
};

/** The helm's station, on the starboard rack aft. */
const SEAT_Z = 0.55;
const SEAT_U = uAt(SEAT_Z);
/**
 * The gunwale at the seat: the rack's rail, which the sailor sits on and
 * hikes from: on its top, just inside its outer edge.
 */
const GUNWALE: Vec3 = [planAt(SEAT_U) - 0.004, railTop(SEAT_U), SEAT_Z];
/** The cockpit: as far in from the rail as the stage's from its gunwale, its floor as deep; open aft over the transom. */
const COCKPIT_HALF_WIDTH = GUNWALE[0] - STAGE.sideDeck;
const COCKPIT_FLOOR = GUNWALE[1] - STAGE.floorDrop;
const COCKPIT_FORE = -0.42;
const COCKPIT_AFT = TRANSOM_Z;
/** The crew's station, on the port rack forward of the helm, by the shrouds. */
const CREW_Z = -0.25;
/** The deck's planks run fore and aft, so the cockpit's sides fall on a seam. */
const PLANK = COCKPIT_HALF_WIDTH / 4.5;
const DECK = srgb(0.86, 0.76, 0.58);

/** Whether the deck between x0 and x1 at z (between two rows) is open: the cockpit. */
function open(x0: number, x1: number, z: number): boolean {
  const outer = Math.max(Math.abs(x0), Math.abs(x1));
  return z > COCKPIT_FORE && z < COCKPIT_AFT && outer <= COCKPIT_HALF_WIDTH + 1e-6;
}

/** The deck's rows: the deck's stations, the outline's points, the racks' end and the cockpit's forward end. */
function deckRows(): number[] {
  const us = [...stations(D.deckStations), ...stations(10), RACK_FORE, uAt(COCKPIT_FORE)].sort(
    (a, b) => a - b,
  );
  return us.filter((u, i) => i === 0 || u - (us[i - 1] as number) > 1e-6);
}

function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const us = deckRows();
  const planks = Math.ceil(HULL_HALF_BEAM / PLANK - 0.5);
  for (let j = -planks; j <= planks; j++) {
    const x0 = (j - 0.5) * PLANK;
    const x1 = (j + 0.5) * PLANK;
    const tone = 0.88 + 0.22 * jitter(j + 50);
    const c = shade(DECK, tone);
    const seam = shade(c, 0.55);
    let prev: { row: number[]; z: number; in: boolean } | null = null;
    for (const u of us) {
      const b = hullBeam(u);
      const z = zAt(u);
      // Beyond the sheer the plank ends: its row closed at the edge, so
      // the deck meets the sheer with no gap where it narrows.
      const inside = Math.min(x1, b) - Math.max(x0, -b) > 1e-4;
      const edge = x0 >= 0 ? b : -b;
      const lo = inside ? Math.max(x0, -b) : edge;
      const hi = inside ? Math.min(x1, b) : edge;
      // A dark payed seam along each plank's edge.
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

/** The cockpit: its floor planked fore and aft out over the transom, its sides down from the side decks, its forward end. */
function cockpit(m: MeshBuilder): void {
  const w = COCKPIT_HALF_WIDTH;
  const f = COCKPIT_FORE;
  const a = COCKPIT_AFT;
  const y = COCKPIT_FLOOR;
  const top = (x: number, z: number): number => deckY(x, uAt(z));
  const sides = shade(DECK, 0.75);
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
      [-w, y, f],
      [w, y, f],
      [w, top(w, f), f],
      [-w, top(-w, f), f],
    ],
    [0, 0, 1],
    sides,
  );
  // The sides, in a few panels, as the deck rises forward.
  const panels = D.small ? 8 : 2;
  for (const s of [1, -1]) {
    for (let i = 0; i < panels; i++) {
      const z0 = lerp(f, a, i / panels);
      const z1 = lerp(f, a, (i + 1) / panels);
      quad(
        m,
        [
          [s * w, y, z0],
          [s * w, y, z1],
          [s * w, top(s * w, z1), z1],
          [s * w, top(s * w, z0), z0],
        ],
        [-s, 0, 0],
        sides,
      );
    }
  }
}

/** The far model's deck: plain, a few strips across, the cockpit's floor beneath. */
function plainDeck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const across = [-1, -0.5, 0, 0.5, 1];
  let prev: number[] | null = null;
  for (const u of stations()) {
    const b = hullBeam(u);
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

/**
 * Two leather foot straps along the cockpit's floor either side of the
 * centreline, lifted a little between their ends, for the feet of whoever
 * sits out.
 */
function footStraps(m: MeshBuilder): void {
  const fore = -0.15;
  const aft = 1.05;
  const n = 8;
  const leather = srgb(0.36, 0.22, 0.12);
  for (const x of [-0.13, 0.13]) {
    const lower: number[] = [];
    const upper: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = lerp(fore, aft, t);
      const y = COCKPIT_FLOOR + 0.006 + 0.05 * Math.sin(Math.PI * t) ** 0.6;
      for (const [row, dx] of [
        [lower, -0.022],
        [upper, 0.022],
      ] as const) {
        const k = m.vertex([x + dx, y, z], leather);
        m.normal(k, [0, 1, 0]);
        row.push(k);
      }
    }
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = [lower[i], upper[i], upper[i + 1], lower[i + 1]] as number[];
      m.triFacing(a as number, b as number, c as number, [0, 1, 0]);
      m.triFacing(a as number, c as number, d as number, [0, 1, 0]);
    }
  }
}

// --- The racks ---------------------------------------------------------------

/** The racks' stations: the hull's (every other one far off), from the transom to their forward end, which is one. */
function rackStations(): number[] {
  const us = stations().filter((u, i) => u < RACK_FORE - 1e-6 && (D.small || i % 2 === 0));
  return [...us, RACK_FORE];
}

/** The rail's section about its outer top corner, as (out, up), round from the outer face; flat on top. */
const RAIL_SECTION: [number, number][] = [
  [0, -RAIL_DEPTH],
  [0, -0.005],
  [-0.002, 0],
  [-RAIL_WIDTH + 0.002, 0],
  [-RAIL_WIDTH, -0.005],
  [-RAIL_WIDTH, -RAIL_DEPTH],
];

/**
 * The racks: on each side an ash rail along the outline from the transom's
 * corner to forward of the mast, its top flat, on struts off the
 * topsides, posted down to the gunwale at its ends; between rail and
 * gunwale a net of hemp line, which the far model leaves out.
 */
function racks(): { spar: MeshBuilder; rope: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const rope = new MeshBuilder('rope');
  const us = rackStations();
  const ash = srgb(0.93, 0.8, 0.6);
  const profile = D.small
    ? RAIL_SECTION
    : [0, 2, 3, 5].map((k) => RAIL_SECTION[k] as [number, number]);
  for (const s of [1, -1]) {
    // Each face of the rail its own strip, so its edges stay crisp.
    const corner = (u: number, k: number): Vec3 => {
      const [dx, dy] = profile[k % profile.length] as [number, number];
      return [s * (outline(u) + dx), railTop(u) + dy, zAt(u)];
    };
    for (let k = 0; k < profile.length; k++) {
      const a = profile[k] as [number, number];
      const b = profile[(k + 1) % profile.length] as [number, number];
      // Outward from the face, seen from outside the rail: the section runs
      // clockwise seen from aft on the starboard side.
      const n = normalize([s * (b[1] - a[1]), -(b[0] - a[0]), 0]);
      const lower: number[] = [];
      const upper: number[] = [];
      for (const u of us) {
        const p = corner(u, k);
        const q = corner(u, k + 1);
        const i = spar.vertex(p, ash);
        const j = spar.vertex(q, ash);
        spar.normal(i, n);
        spar.normal(j, n);
        lower.push(i);
        upper.push(j);
      }
      for (let i = 0; i + 1 < us.length; i++) {
        const [a0, a1, b1, b0] = [lower[i], lower[i + 1], upper[i + 1], upper[i]] as number[];
        spar.triFacing(a0 as number, a1 as number, b1 as number, n);
        spar.triFacing(a0 as number, b1 as number, b0 as number, n);
      }
    }
    // The rail's ends, capped.
    for (const [u, dir] of [
      [us[0] as number, 1],
      [us[us.length - 1] as number, -1],
    ] as [number, number][]) {
      const n: Vec3 = [0, 0, dir];
      const ks = profile.map((_, k) => {
        const i = spar.vertex(corner(u, k), ash);
        spar.normal(i, n);
        return i;
      });
      for (let k = 1; k + 1 < ks.length; k++) {
        spar.triFacing(ks[0] as number, ks[k] as number, ks[k + 1] as number, n);
      }
    }
    // The posts at its ends, down to the gunwale; the struts between, off the topsides.
    const mid = (u: number): Vec3 => [
      s * (outline(u) - RAIL_WIDTH / 2),
      railTop(u) - RAIL_DEPTH,
      zAt(u) + (u === 0 ? -0.025 : 0),
    ];
    if (!D.small) {
      continue;
    }
    const seg = 6;
    for (const u of [0, RACK_FORE]) {
      const p = mid(u);
      spar.tube([[p[0], deckY(p[0], u) - 0.01, p[2]], p], [0.017], seg, ash);
    }
    for (const u of [0.07, 0.19, 0.31, 0.43, 0.55]) {
      const p = mid(u);
      const g = girthAt(u, sheer(u) - 0.14);
      const foot = section(u, g);
      spar.tube([[s * (foot[0] + 0.005), foot[1], foot[2]], p], [0.016, 0.014], seg, ash);
    }
    // The net: strands across from the gunwale to the rail every few inches,
    // and two along between them.
    const inner = (u: number): Vec3 => [s * (hullBeam(u) + 0.01), sheer(u) + 0.004, zAt(u)];
    const outer = (u: number): Vec3 => [
      s * (outline(u) - RAIL_WIDTH + 0.004),
      railTop(u) - 0.012,
      zAt(u),
    ];
    const spans = (u: number): boolean => outline(u) - RAIL_WIDTH - hullBeam(u) > 0.03;
    const step = 0.07 / L;
    for (let u = 0; u <= RACK_FORE; u += step) {
      if (spans(u)) {
        strand(rope, [inner(u), outer(u)], 0.0035);
      }
    }
    for (const f of [1 / 3, 2 / 3]) {
      const path: Vec3[] = [];
      for (const u of us) {
        if (spans(u)) {
          const a = inner(u);
          const b = outer(u);
          path.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f) - 0.004, a[2]]);
        }
      }
      if (path.length > 1) {
        strand(rope, path, 0.0035);
      }
    }
  }
  return { spar, rope };
}

/** A thin line along a path: three-sided, open at its ends. */
function strand(m: MeshBuilder, path: Vec3[], r: number): void {
  const sides = 3;
  const rings: number[][] = path.map((p, i) => {
    const prev = path[Math.max(0, i - 1)] as Vec3;
    const next = path[Math.min(path.length - 1, i + 1)] as Vec3;
    const t = normalize(sub(next, prev));
    const ref: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a = normalize(cross(t, ref));
    const b = cross(a, t);
    const ring: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const ang = (k / sides) * 2 * Math.PI;
      const d = add(scale(a, Math.cos(ang)), scale(b, Math.sin(ang)));
      const v = m.vertex(add(p, scale(d, r)));
      m.normal(v, d);
      ring.push(v);
    }
    return ring;
  });
  for (let i = 0; i + 1 < rings.length; i++) {
    m.strip(rings[i] as number[], rings[i + 1] as number[], true);
  }
}

// --- Spars, rigging and sails ----------------------------------------------------

const MAST_Z = -rig.mastPosition;
const mastFootY = deckY(0, uAt(MAST_Z));
const MAST_TOP = rig.boomHeight + rig.luff + 0.1;
/** The mast's radius at its foot and its head. */
const MAST_FOOT_R = 0.045;
const MAST_HEAD_R = 0.028;
const mastR = (y: number): number =>
  lerp(MAST_FOOT_R, MAST_HEAD_R, ((y - mastFootY) / (MAST_TOP - mastFootY)) ** 2);
/** The jib's tack, on the stem's head, and its head, on the forestay. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];
/** The hounds, where the forestay, the shrouds and the trapeze wires meet the mast: a little above the jib's head. */
const HOUNDS = TACK[1] + headsails.headsailLuff + 0.2;
/** The forestay, from the tack to the mast's fore side at the hounds. */
const STAY_TOP: Vec3 = [0, HOUNDS, MAST_Z - mastR(HOUNDS)];
/** How far aft of the tack the jib's head is: along the forestay, the jib's luff up. */
const RAKE = (headsails.headsailLuff * (STAY_TOP[2] - TACK[2])) / (STAY_TOP[1] - TACK[1]);
/** The gennaker's tack, at the bowsprit's end, and its head, just forward of the mast below the masthead. */
const KITE_TACK: Vec3 = [0, downwind.downwindTackHeight, -downwind.downwindTack];
const KITE_HEAD_Y = KITE_TACK[1] + downwind.downwindLuff;
const KITE_RAKE = MAST_Z - mastR(KITE_HEAD_Y) - 0.04 - KITE_TACK[2];
/** The spreaders' height; the chainplates' station; the deadeyes above the gunwale. */
const SPREADER_Y = 3.0;
const SPREADER_PUSH = 0.14;
const CHAIN_Z = -0.35;
const CHAIN_U = uAt(CHAIN_Z);
const DEADEYE_UP = 0.2;
const DEADEYE_DOWN = 0.08;
const DEADEYE_R = 0.026;

/** Where a shroud's deadeyes stand, outside the gunwale at the chainplates: the upper one's middle. */
const deadeye = (s: number, up: number): Vec3 => [
  s * (hullBeam(CHAIN_U) + 0.014),
  sheer(CHAIN_U) + up,
  CHAIN_Z,
];

/** A spreader's tip: pushing the shroud out from its straight line, hounds to deadeye. */
function spreaderTip(s: number): Vec3 {
  const from: Vec3 = [s * mastR(HOUNDS), HOUNDS, MAST_Z];
  const to = add(deadeye(s, DEADEYE_UP), [0, DEADEYE_R, 0]);
  const f = (HOUNDS - SPREADER_Y) / (HOUNDS - to[1]);
  const p = add(from, scale(sub(to, from), f));
  return [p[0] + s * SPREADER_PUSH, SPREADER_Y, p[2]];
}

/** Where a shroud is at height y below its spreader. */
function shroudAt(s: number, y: number): Vec3 {
  const tip = spreaderTip(s);
  const to = add(deadeye(s, DEADEYE_UP), [0, DEADEYE_R, 0]);
  const f = (tip[1] - y) / (tip[1] - to[1]);
  return add(tip, scale(sub(to, tip), f));
}

/** The trapeze rings: hanging at a sailor's hip height above the rail, just inside and aft of the shrouds. */
const RING_Y = GUNWALE[1] + 0.95;
const ring = (s: number): Vec3 => {
  const p = shroudAt(s, RING_Y);
  return [p[0] - s * 0.1, RING_Y, p[2] + 0.15];
};
const RING_R = 0.035;

/** An iron band round the mast at y. */
function ironBand(m: MeshBuilder, y: number): void {
  const r = mastR(y) + 0.004;
  m.tube(
    [
      [0, y - 0.022, 0],
      [0, y + 0.022, 0],
    ],
    [r],
    D.small ? 12 : 5,
  );
}

/** The mast, in its node's frame (at its station): spruce, banded in iron, with its spreaders. */
function mast(): { spar: MeshBuilder; iron: MeshBuilder; bronze: MeshBuilder } {
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
  const bronze = new MeshBuilder('bronze');
  if (!D.small) {
    return { spar, iron, bronze };
  }
  for (const y of [mastFootY + 0.1, SPREADER_Y, HOUNDS, MAST_TOP - 0.06]) {
    ironBand(iron, y);
  }
  for (const s of [1, -1]) {
    const tip = spreaderTip(s);
    spar.tube(
      [
        [s * mastR(SPREADER_Y), SPREADER_Y, 0],
        [tip[0], tip[1], tip[2] - MAST_Z],
      ],
      [0.018, 0.011],
      6,
    );
  }
  // The gennaker halyard's sheave box, on the mast's fore side at the head.
  const r = mastR(KITE_HEAD_Y);
  bronze.box([-0.014, KITE_HEAD_Y - 0.03, -r - 0.018], [0.014, KITE_HEAD_Y + 0.05, -r + 0.004]);
  return { spar, iron, bronze };
}

/**
 * The standing rigging, in the boat's frame: the shrouds over the
 * spreaders to the hounds, each set up with a pair of deadeyes and a
 * lanyard to a bronze chainplate on the topsides; the forestay from the
 * stem's head to the hounds, the jib hanked to it. Tarred hemp.
 */
function rigging(): { rope: MeshBuilder; bronze: MeshBuilder; wood: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  const wood = new MeshBuilder('timber');
  const R = 0.0045;
  const sides = 4;
  for (const s of [1, -1]) {
    const upper = deadeye(s, DEADEYE_UP);
    const lower = deadeye(s, DEADEYE_DOWN);
    rope.tube(
      [[s * mastR(HOUNDS), HOUNDS, MAST_Z], spreaderTip(s), add(upper, [0, DEADEYE_R, 0])],
      [R],
      sides,
    );
    rope.tube([upper, lower], [0.0035], sides);
    for (const p of [upper, lower]) {
      wood.tube(
        [
          [p[0] - 0.01, p[1], p[2]],
          [p[0] + 0.01, p[1], p[2]],
        ],
        [DEADEYE_R],
        8,
        shade(MAHOGANY, 0.45),
      );
    }
    // The chainplate, from under the lower deadeye down the flared topsides.
    const side = section(CHAIN_U, girthAt(CHAIN_U, sheer(CHAIN_U) - 0.18));
    const foot: Vec3 = [s * (side[0] + 0.012), side[1], CHAIN_Z];
    const head: Vec3 = [lower[0], lower[1] - DEADEYE_R, CHAIN_Z];
    const rim: Vec3 = [s * (hullBeam(CHAIN_U) + 0.016), sheer(CHAIN_U) - 0.012, CHAIN_Z];
    bronze.tube([head, rim, foot], [0.007, 0.008, 0.008], 6);
  }
  rope.tube([TACK, STAY_TOP], [R], sides);
  // The stem's fitting at the tack, and the jib's hanks on the stay.
  bronze.box([-0.018, TACK[1] - 0.04, TACK[2] - 0.04], [0.018, TACK[1] + 0.008, TACK[2] + 0.04]);
  for (let v = 0.12; v < 1; v += 0.12) {
    const p: Vec3 = [0, TACK[1] + v * headsails.headsailLuff, TACK[2] + v * RAKE];
    bronze.box(add(p, [-0.01, -0.018, -0.01]), add(p, [0.01, 0.018, 0.01]));
  }
  return { rope, bronze, wood };
}

/**
 * The trapeze, in the boat's frame: a wire of tarred hemp each side from
 * the hounds down to a short lanyard and a bronze ring, which hangs, at
 * rest, by the shrouds.
 */
function trapeze(): { rope: MeshBuilder; bronze: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  for (const s of [1, -1]) {
    const from: Vec3 = [s * mastR(HOUNDS), HOUNDS - 0.03, MAST_Z];
    const at = ring(s);
    const top = add(at, [0, RING_R, 0]);
    const dir = normalize(sub(from, top));
    const join = add(top, scale(dir, 0.14));
    rope.tube([from, join], [0.004], 4);
    rope.tube([join, top], [0.003], 4);
    // The ring, in the plane of the wire and the athwartships line.
    const across = normalize(cross(dir, [0, 0, 1]));
    const up = normalize(cross(across, [0, 0, 1]));
    const loop: Vec3[] = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      loop.push(add(at, add(scale(across, RING_R * Math.cos(a)), scale(up, RING_R * Math.sin(a)))));
    }
    bronze.tube(loop, [0.006], 4);
  }
  return { rope, bronze };
}

function boom(): { spar: MeshBuilder; iron: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.04],
      [0, 0, rig.foot + 0.08],
    ],
    [0.035],
    D.small ? 10 : 4,
  );
  const iron = new MeshBuilder('iron');
  if (D.small) {
    for (const z of [0.1, rig.foot + 0.02]) {
      iron.tube(
        [
          [0, 0, z - 0.02],
          [0, 0, z + 0.02],
        ],
        [0.039],
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
      [0, -0.035, 0.5],
      [0, mastFootY + 0.1 - rig.boomHeight, 0.06],
    ],
    [0.008],
    D.small ? 5 : 3,
  );
  return m;
}

/** The main's roach, and its square head's width. */
const ROACH = 0.2;
const HEAD = 0.75;

/** The main's chord at fraction v up the luff, as sail() draws it. */
const chordAt = (v: number): number =>
  rig.foot * (1 - v) + HEAD * v + ROACH * Math.sin(Math.PI * v) * (1 - v) ** 0.3;

/** The heights of the main's reef points, as fractions of its luff: where each reef's tack comes down to the boom. */
const REEF_ROWS = rig.reefs.slice(1).map((share) => 1 - share);
/** Its five full-length battens, as fractions of its luff, in their pockets. */
const BATTENS = [0.16, 0.34, 0.52, 0.7, 0.88];

/**
 * The mainsail, flat in the centreline plane at rest: the luff up the
 * mast's after face, the foot along the boom, its head square. TEXCOORD_0
 * maps the sail cloth (the distance along the foot over the foot's length,
 * and the height up the luff); TEXCOORD_1 is (u, v), the fraction of the
 * chord and of the luff, from which the client shapes it (boom angle,
 * twist, camber). A row runs along each reef's points and each batten.
 */
function sail(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const vs = [
    ...Array.from({ length: D.sailRows + 1 }, (_, i) => i / D.sailRows),
    ...(D.small ? [...REEF_ROWS, ...BATTENS] : []),
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
 * A headsail, flat in the centreline plane at rest, in its node's frame (at
 * the tack): its luff up to the head, luff above the tack and rake aft of
 * it; each height's chord level and aft from the luff. TEXCOORD_0 maps the
 * cloth as the main's does; TEXCOORD_1 is (u, v), the fraction of the chord
 * and of the luff, from which the client turns each height's chord about
 * its luff point and cambers it.
 */
function headsail(
  luff: number,
  foot: number,
  rake: number,
  chord: (v: number) => number,
  rowsN: number,
  colsN: number,
): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= rowsN; i++) {
    const v = i / rowsN;
    const c = chord(v);
    const row: number[] = [];
    for (let j = 0; j <= colsN; j++) {
      const u = j / colsN;
      const k = m.vertex([0, v * luff, v * rake + u * c], [1, 1, 1], [(u * c) / foot, v], [u, v]);
      m.normal(k, [1, 0, 0]);
      row.push(k);
    }
    rows.push(row);
  }
  for (let i = 0; i < rowsN; i++) {
    m.strip(rows[i] as number[], rows[i + 1] as number[], true);
  }
  return m;
}

/** The gennaker's head's width (fuller than a jib's), and its leech's round. */
const KITE_HEAD = 0.35;
const KITE_LEECH = 0.12;
const kiteChord = (v: number): number =>
  downwind.downwindFoot * (1 - v) + KITE_HEAD * v + KITE_LEECH * Math.sin(Math.PI * v);

// --- Foils and the helm -----------------------------------------------------------

/** The centreboard, in its node's frame: oak, from inside its case under the cockpit's floor down to the catalog's depth. */
function centreboard(): MeshBuilder {
  const m = new MeshBuilder('foil');
  blade(
    m,
    -(hull.hullDraught + foils.boardSpan),
    COCKPIT_FLOOR - 0.03,
    -foils.boardChord / 2,
    foils.boardChord / 2,
    0.022,
    D.small ? 10 : 3,
  );
  return m;
}

/** The rudder's head, where the tiller is pinned, above the water astern of the transom. */
const RUDDER_HEAD = 0.45;

/**
 * The kick-up rudder, in its node's frame (the stock): an oak blade from
 * just under the water down to the catalog's depth, in a stock of oak
 * cheeks hung on two bronze pintles in gudgeons on the transom.
 */
function rudder(): { oak: MeshBuilder; bronze: MeshBuilder } {
  const oak = new MeshBuilder('foil');
  const lead = -0.06;
  blade(
    oak,
    -(hull.hullDraught + foils.rudderSpan),
    -0.02,
    lead,
    lead + foils.rudderChord,
    0.02,
    D.small ? 10 : 3,
  );
  // The stock: two cheeks either side of the blade's head; far off, one block.
  if (D.small) {
    for (const s of [1, -1]) {
      oak.box([s > 0 ? 0.01 : -0.026, -0.12, -0.075], [s > 0 ? 0.026 : -0.01, RUDDER_HEAD, 0.09]);
    }
    oak.box([-0.026, RUDDER_HEAD - 0.04, -0.075], [0.026, RUDDER_HEAD, 0.09]);
  } else {
    oak.box([-0.026, -0.12, -0.075], [0.026, RUDDER_HEAD, 0.09]);
  }
  const bronze = new MeshBuilder('bronze');
  if (D.small) {
    const forward = TRANSOM_Z - foils.rudderPosition;
    for (const y of [0.04, 0.22]) {
      bronze.box([-0.03, y - 0.012, forward - 0.002], [0.03, y + 0.012, -0.07]);
      bronze.tube(
        [
          [0, y - 0.05, forward + 0.012],
          [0, y + 0.012, forward + 0.012],
        ],
        [0.007],
        6,
      );
    }
    // The cheeks' bolt, through blade and stock.
    bronze.tube(
      [
        [-0.03, -0.08, 0.02],
        [0.03, -0.08, 0.02],
      ],
      [0.01],
      8,
    );
  }
  return { oak, bronze };
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
  const m = new MeshBuilder('spar');
  m.tube(
    [[0, 0, 0.03], [0, TILLER_END[1] * 0.5 + 0.015, TILLER_END[2] * 0.5], TILLER_END],
    [0.022, 0.019, 0.014],
    D.small ? 8 : 3,
  );
  return m;
}

/** The tiller extension, hinged at the tiller's end: long, to steer from the rack or the wire; at rest along it, forward. */
const EXTENSION = 1.4;

function extension(): MeshBuilder {
  const m = new MeshBuilder('spar');
  m.tube(
    [
      [0, 0, 0],
      [0, 0, -EXTENSION],
    ],
    [0.011, 0.01],
    6,
  );
  m.tube(
    [
      [0, -0.012, 0.012],
      [0, 0.012, 0.012],
    ],
    [0.014],
    6,
    srgb(0.74, 0.5, 0.24),
  );
  m.tube(
    [
      [0, 0, -EXTENSION + 0.01],
      [0, 0, -EXTENSION - 0.02],
    ],
    [0.016],
    6,
  );
  return m;
}

/** The mainsheet's blocks, under the boom and on the cockpit's floor, just forward of the seat. */
const SHEET_Z = SEAT_Z - 0.05;
const SHEET_BLOCK_Y = COCKPIT_FLOOR + 0.06;

/** A wooden block: its shell of elm, on a bronze swivel. */
function sheetBlock(): { wood: MeshBuilder; bronze: MeshBuilder } {
  const wood = new MeshBuilder('timber');
  wood.box([-0.02, -0.032, -0.038], [0.02, 0.032, 0.038], shade(TIMBER, 0.7));
  const bronze = new MeshBuilder('bronze');
  bronze.tube(
    [
      [0, -0.06, 0],
      [0, -0.032, 0],
    ],
    [0.011],
    6,
  );
  return { wood, bronze };
}

/** The bowsprit: ash, from under the foredeck out through the stem to the gennaker's tack. */
const SPRIT_IN: Vec3 = [0, 0.335, -1.95];
const SPRIT_R = 0.024;
const SPRIT_END: Vec3 = [0, KITE_TACK[1] - SPRIT_R, KITE_TACK[2] - 0.03];
const spritAt = (z: number): Vec3 => {
  const f = (z - SPRIT_IN[2]) / (SPRIT_END[2] - SPRIT_IN[2]);
  return add(SPRIT_IN, scale(sub(SPRIT_END, SPRIT_IN), f));
};

function bowsprit(spar: MeshBuilder, iron: MeshBuilder, bronze: MeshBuilder): void {
  spar.tube(
    [SPRIT_IN, SPRIT_END],
    [SPRIT_R, SPRIT_R * 0.85],
    D.small ? 8 : 4,
    srgb(0.93, 0.8, 0.6),
  );
  if (!D.small) {
    return;
  }
  // The bronze lip of its hole in the stem, an iron band just outside it,
  // and the tack's eye at its end.
  bronze.tube([spritAt(BOW_Z + 0.015), spritAt(BOW_Z - 0.012)], [SPRIT_R + 0.012], 10);
  iron.tube([spritAt(BOW_Z - 0.05), spritAt(BOW_Z - 0.09)], [SPRIT_R + 0.003], 10);
  iron.tube(
    [spritAt(SPRIT_END[2] + 0.06), spritAt(SPRIT_END[2] + 0.02)],
    [SPRIT_R * 0.85 + 0.003],
    10,
  );
  bronze.tube(
    [
      [0, KITE_TACK[1] - 0.012, KITE_TACK[2]],
      [0, KITE_TACK[1] + 0.012, KITE_TACK[2]],
    ],
    [0.012],
    6,
  );
}

/**
 * The bronze and iron on the hull and deck: the mast's collar, the stem
 * band, the gudgeons, the jib's self-tacking horse across the foredeck, the
 * gennaker's sheet blocks on the quarters with their fairleads, and cleats.
 */
function fittings(): { bronze: MeshBuilder; wood: MeshBuilder } {
  const m = new MeshBuilder('bronze');
  const wood = new MeshBuilder('timber');
  m.tube(
    [
      [0, mastFootY - 0.01, MAST_Z],
      [0, mastFootY + 0.05, MAST_Z],
    ],
    [MAST_FOOT_R + 0.012],
    12,
  );
  // The stem band, up the plumb stem from the forefoot to the head.
  m.box([-0.012, -keelDepth(1) - 0.01, BOW_Z - 0.008], [0.012, sheer(1) + 0.01, BOW_Z + 0.02]);
  // The gudgeons on the transom.
  for (const y of [0.04, 0.22]) {
    m.box([-0.035, y - 0.02, TRANSOM_Z - 0.004], [0.035, y + 0.02, TRANSOM_Z + 0.012]);
  }
  // The horse: a bronze bar across the foredeck under the jib's clew, on two feet.
  const horseZ = TACK[2] + headsails.headsailFoot - 0.02;
  const hu = uAt(horseZ);
  const half = Math.min(0.36, hullBeam(hu) - 0.12);
  const bar: Vec3[] = [];
  for (let i = 0; i <= 8; i++) {
    const x = -half + (2 * half * i) / 8;
    bar.push([x, deckY(x, hu) + 0.035 + 0.01 * (1 - (x / half) ** 2), horseZ]);
  }
  m.tube(bar, [0.008], 6);
  for (const s of [1, -1]) {
    const x = s * half;
    m.tube(
      [
        [x, deckY(x, hu) - 0.005, horseZ],
        [x, deckY(x, hu) + 0.04, horseZ],
      ],
      [0.012],
      6,
    );
  }
  // The jib's car on the horse.
  m.box([-0.025, deckY(0, hu) + 0.03, horseZ - 0.02], [0.025, deckY(0, hu) + 0.06, horseZ + 0.02]);
  for (const s of [1, -1]) {
    // The gennaker's sheet blocks on the quarters, and a fairlead forward of each.
    const bx = s * (COCKPIT_HALF_WIDTH + 0.09);
    const bz = 1.65;
    const by = deckY(bx, uAt(bz));
    wood.box(
      [bx - 0.02, by + 0.01, bz - 0.04],
      [bx + 0.02, by + 0.075, bz + 0.04],
      shade(TIMBER, 0.7),
    );
    m.box([bx - 0.012, by - 0.003, bz - 0.015], [bx + 0.012, by + 0.012, bz + 0.015]);
    const fz = 0.9;
    const fy = deckY(bx, uAt(fz));
    m.box([bx - 0.015, fy - 0.003, fz - 0.03], [bx + 0.015, fy + 0.025, fz + 0.03]);
    // A cleat on the side deck by the helm, for the jib's sheet.
    const cz = SEAT_Z + 0.3;
    const cy = deckY(bx, uAt(cz));
    m.box([bx - 0.012, cy - 0.003, cz - 0.05], [bx + 0.012, cy + 0.02, cz + 0.05]);
    m.box([bx - 0.01, cy + 0.02, cz - 0.075], [bx + 0.01, cy + 0.035, cz + 0.075]);
  }
  // A mooring cleat on the foredeck.
  const z = -1.55;
  const y = deckY(0, uAt(z));
  m.box([-0.012, y - 0.005, z - 0.07], [0.012, y + 0.025, z + 0.07]);
  m.box([-0.01, y + 0.025, z - 0.1], [0.01, y + 0.04, z + 0.1]);
  return { bronze: m, wood };
}

function gooseneck(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.box([-0.032, -0.032, -0.03], [0.032, 0.032, 0.07]);
  m.tube(
    [
      [0, 0, rig.foot + 0.06],
      [0, 0, rig.foot + 0.11],
    ],
    [0.03],
    8,
  );
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
 * bottom leaves the water aft to where the stem does, each [z, half-beam
 * at the waterline, depth of the bottom], in metres in the boat's frame,
 * and the exponent of the sections' narrowing below the waterline.
 */
function hullVolume(m: MeshBuilder): { stations: number[][]; bilge: number } {
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

/** The solid's sections' exponent. */
const SOLID_EXPONENT = 2.2;

/**
 * The hull as a solid, for what keeps a sailor out of it: stations from the
 * transom to the stem, each [z, half-beam of the plan, its height (the
 * rails' top along the racks, the sheer beyond), the keel's depth], whose
 * sections are superellipses of the exponent: the racks and their net,
 * which a sailor sits and stands on, as the side deck; and the cockpit, a
 * box open above its floor.
 */
function solid(): Record<string, unknown> {
  const round = (x: number): number => Math.round(x * 10000) / 10000;
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const u = i / 20;
      const top = u <= RACK_FORE ? railTop(u) : sheer(u);
      return [round(zAt(u)), round(planAt(u)), round(top), round(keelDepth(u))];
    }),
    exponent: SOLID_EXPONENT,
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
 * the rail at the seat's station, starboard, less the stage's gunwale. A
 * sailor's clip, placed in the stage's boat on the starboard side deck, is
 * placed here moved by it (on the port rack by its mirror).
 */
const RESTAGE: Vec3 = [
  GUNWALE[0] - STAGE.gunwale[0],
  GUNWALE[1] - STAGE.gunwale[1],
  SEAT_Z - STAGE.seatZ,
].map((v) => Math.round(v * 1e5) / 1e5) as Vec3;

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const r5v = (p: Vec3): Vec3 => p.map(r5) as Vec3;

/**
 * The trapeze's points, for the sailor on the wire: the hounds on the
 * mast's axis, each ring's middle (starboard first), and the starboard
 * rail's outer edge on its top at the helm's station.
 */
const TRAPEZE = {
  hounds: r5v([0, HOUNDS, MAST_Z]),
  rings: [r5v(ring(1)), r5v(ring(-1))],
  rackEdge: r5v([planAt(SEAT_U), railTop(SEAT_U), SEAT_Z]),
};

/** The stations of the people aboard, as the catalog should have them: on the racks' rails. */
const STATIONS = {
  helm: r5v(GUNWALE),
  crew: r5v([-(planAt(uAt(CREW_Z)) - 0.004), railTop(uAt(CREW_Z)), CREW_Z]),
};

// --- The model ---------------------------------------------------------------

/** The boat's nodes at the detail in force. */
function model(): NodeDef[] {
  const shell = planking();
  const bright = shell.bright;
  transom(bright);
  const shellAll = new MeshBuilder('topsides');
  shellAll.append(shell.painted);
  shellAll.append(bright);
  const waterline = hullVolume(shellAll);
  const rails = new MeshBuilder('timber');
  if (D.small) {
    rubrails(rails);
  }
  const deckMesh = D.plankedDeck ? deck() : plainDeck();
  if (D.plankedDeck) {
    cockpit(deckMesh);
  }
  const rack = racks();
  const sprit = new MeshBuilder('spar');
  const spritIron = new MeshBuilder('iron');
  const spritBronze = new MeshBuilder('bronze');
  bowsprit(sprit, spritIron, spritBronze);
  rack.spar.append(sprit);
  const hullParts = [
    shell.painted.primitive({ colors: true }),
    bright.primitive({ colors: true }),
    deckMesh.primitive({ colors: true }),
    rack.spar.primitive({ colors: true }),
  ];
  if (D.small) {
    hullParts.push(rails.primitive({ colors: true }));
  }
  const masts = mast();
  const mastParts = [masts.spar.primitive()];
  const spars = boom();
  const boomParts = [spars.spar.primitive()];
  if (D.small) {
    const straps = new MeshBuilder('rope');
    footStraps(straps);
    rack.rope.append(straps);
    const f = fittings();
    f.bronze.append(spritBronze);
    hullParts.push(
      rack.rope.primitive({ colors: true }),
      f.bronze.primitive(),
      f.wood.primitive({ colors: true }),
      spritIron.primitive(),
    );
    mastParts.push(masts.iron.primitive(), masts.bronze.primitive());
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
  const block = sheetBlock();
  const nodes: NodeDef[] = [
    {
      name: 'hull',
      primitives: hullParts,
      // The beam is over the racks' rails, which are spar.
      extras: {
        waterline,
        plan: { deviation: planDeviation(), over: ['spar'] },
        solid: solid(),
      },
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
                translation: [0, -0.065, SHEET_Z - MAST_Z] as Vec3,
                primitives: [block.wood.primitive({ colors: true }), block.bronze.primitive()],
              },
            ]
          : []),
      ],
    },
    {
      name: 'sail',
      translation: [0, rig.boomHeight, MAST_Z],
      // Its battens' heights, as fractions of its luff, for their pockets.
      extras: { battens: BATTENS },
      primitives: [sail().primitive({ uvs2: true })],
    },
    // The jib at its tack: its luff up the forestay, its head rake aft of the tack.
    {
      name: 'jib',
      translation: TACK,
      extras: { rake: r5(RAKE) },
      primitives: [
        headsail(
          headsails.headsailLuff,
          headsails.headsailFoot,
          RAKE,
          jibChord,
          D.jibRows,
          D.jibCols,
        ).primitive({ uvs2: true }),
      ],
    },
    // The gennaker at its tack on the bowsprit's end: its head rake aft of
    // the tack, by the mast below the masthead. The client hides it in its
    // bag and hoists it from the tack.
    {
      name: 'kite',
      translation: KITE_TACK,
      extras: { rake: r5(KITE_RAKE) },
      primitives: [
        headsail(
          downwind.downwindLuff,
          downwind.downwindFoot,
          KITE_RAKE,
          kiteChord,
          D.kiteRows,
          D.kiteCols,
        ).primitive({ uvs2: true }),
      ],
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
  // The trapeze: its wires, lanyards and rings, and its points for the sailor on the wire.
  const t = trapeze();
  nodes.push({
    name: 'trapeze',
    extras: TRAPEZE,
    primitives: D.small ? [t.rope.primitive(), t.bronze.primitive()] : [],
  });
  const rudderPrims = [rudderParts.oak.primitive()];
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
    // The centreboard, through its case under the cockpit's floor.
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [centreboard().primitive()],
    },
    // Where the sailor sits: on the starboard rack aft, at the seated
    // height; and how its clips, placed in the stage's boat, are moved here.
    {
      name: 'sailor',
      translation: [0, hull.centreOfGravity + sailor.sailorSeatHeight, SEAT_Z],
      extras: { restage: RESTAGE },
    },
    // What the sailor holds and sits on, on the starboard side (the port
    // side's are their mirror): the rack's rail at the seat's station, and
    // where the centreboard leaves the bottom.
    { name: 'gunwale', translation: GUNWALE },
    {
      name: 'board-root',
      translation: [0, -keelDepth(uAt(-foils.boardPosition)), -foils.boardPosition],
    },
  );
  if (D.small) {
    nodes.push({
      name: 'sheet',
      translation: [0, SHEET_BLOCK_Y, SHEET_Z],
      primitives: [block.wood.primitive({ colors: true }), block.bronze.primitive()],
    });
  }
  return nodes;
}

// The drawn plan and the sails must be what the physics says.
const mostChord = Math.max(...Array.from({ length: 201 }, (_, i) => chordAt(i / 200)));
if (mostChord > rig.foot + 1e-9) {
  throw new Error(`the main's chord reaches ${mostChord.toFixed(3)} m, past its foot`);
}
const mostKite = Math.max(
  ...Array.from({ length: 201 }, (_, i) => (i / 200) * KITE_RAKE + kiteChord(i / 200)),
);
if (mostKite > downwind.downwindFoot + 1e-9) {
  throw new Error(`the gennaker reaches ${mostKite.toFixed(3)} m aft of its tack, past its foot`);
}
for (const u of stations(100)) {
  if (hullBeam(u) > outline(u) + 1e-9) {
    throw new Error(`the hull at station ${u.toFixed(2)} is wider than the outline`);
  }
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
    `seat moved ${RESTAGE.map((v) => v.toFixed(3)).join(', ')} m from the stage's; ` +
    `stations: helm ${STATIONS.helm.join(', ')}, crew ${STATIONS.crew.join(', ')}; ` +
    `cockpit floor ${COCKPIT_FLOOR.toFixed(4)} m\n`,
);

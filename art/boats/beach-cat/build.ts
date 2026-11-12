// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The beach cat: a beach catamaran of our time built by a shipwright of
// the period. Two narrow, rockered hulls in narrow carvel planking, their
// seams flush and payed, their topsides in the paint the boat's sailor
// chooses, with a dark sheer strake; their tops laid in planks, crowned.
// Two ash beams lashed with tarred hemp to oak pylons on the hulls, ash
// side bars along the hulls' inner sides, and between them a trampoline,
// a net of tarred hemp laced to beams and bars, with leather hiking
// straps across it; a dolphin striker of ash under the front beam, stayed
// with hemp to the bows. A rotating mast of varnished spruce, a teardrop in
// section, banded in iron, stepped on a bronze ball in the front beam; its
// shrouds of tarred hemp set up with deadeyes and lanyards to bronze
// chainplates on the hulls' outer sides; the forestay on a bridle to both
// bows; two trapeze wires a side from the hounds to bronze rings. A
// spruce boom on a bronze gooseneck, its sheet's tackle of wooden blocks
// to a bronze horse on the rear beam; a fully battened flax main with seven
// ash battens, its head square; a flax jib on the forestay. On each
// transom an oak kick-up rudder in a bronze head, their arms of ash joined
// by the crossbar, a long ash extension from its middle; the righting line
// of hemp across the net; and at the masthead the brass tricolour lantern
// with the pennant's staff above it.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: the length and the plan at the sheer (the hulls'
// outer sides, the bows' flat front), the hulls' spacing and their canoe
// bodies' draught, the keels below them (the hulls' lateral planes), the
// mast's place, the boom's height, the main's luff and foot, the jib's
// luff, foot, tack and tack's height, the rudders' places, spans and
// chords, the seat's height. The rest (sheer, rocker, sections, planking,
// the beams and net, the rigging) are this script's own.
//
// It builds the boat twice from the same lines: in full, and the far model,
// with few segments, a plain deck and net, and no lashings, rigging lines,
// telltales, pennant, lantern or fittings. The catalog's art.model and
// art.far name them.
//
//   node art/boats/beach-cat/build.ts   (from the repository root; npm run art in client/)

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
import { add, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../../lib/mesh.ts';

/** The models this script writes, as the catalog's art.model and art.far name them. */
const MODEL = 'boats/beach-cat.glb';
const FAR_MODEL = 'boats/beach-cat.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along a hull: a multiple of ten, so the outline's points are among them. */
  stations: number;
  /** Rows round a hull's section, keel to each sheer. */
  girth: number;
  /** The deck's rows across each hull. */
  deckRows: number;
  /** Around tubes and blades, and along the mast. */
  round: number;
  mastStations: number;
  /** The mainsail's rows and columns, and the jib's. */
  sailRows: number;
  sailCols: number;
  jibRows: number;
  jibCols: number;
  /** The net's strands fore and aft and across, or a plain plate. */
  netStrands: number;
  /** Lashings, rigging lines, telltales, pennant, lantern and fittings. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 40,
  girth: 10,
  deckRows: 6,
  round: 10,
  mastStations: 10,
  sailRows: 24,
  sailCols: 10,
  jibRows: 16,
  jibCols: 6,
  netStrands: 22,
  small: true,
};

const FAR: Detail = {
  stations: 10,
  girth: 3,
  deckRows: 1,
  round: 4,
  mastStations: 1,
  sailRows: 8,
  sailCols: 3,
  jibRows: 5,
  jibCols: 2,
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
      headsailReefs: number[];
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

// --- The stage -----------------------------------------------------------------
//
// The boat the sailors' clips are placed in, read from its model: its seat
// (the gunwale at the seat's station). The sailor's node here carries the
// difference between the two seats.

function readStageGunwale(): { gunwale: Vec3; seatZ: number } {
  const tables = readFileSync('art/sailors/tables.yaml', 'utf8');
  const path = /^stage:\s*\n\s+boat:\s*(\S+)/m.exec(tables)?.[1];
  if (path === undefined || path === MODEL) {
    throw new Error(`art/sailors/tables.yaml stages the sailors in ${path ?? 'no boat'}`);
  }
  const g = readGlbJson(readFileSync(`art/${path}`)) as {
    nodes: { name?: string; translation?: number[] }[];
  };
  const at = (name: string): Vec3 => {
    const t = g.nodes.find((x) => x.name === name)?.translation;
    if (t === undefined) {
      throw new Error(`art/${path} has no node ${name}`);
    }
    return [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  };
  return { gunwale: at('gunwale'), seatZ: at('sailor')[2] };
}

const STAGE = readStageGunwale();

// --- The lines -------------------------------------------------------------------
//
// The boat's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bows are
// -z). Each hull is built about its own centreline, half the spacing out:
// the starboard one, and the port one its mirror.

const L = boat.lengthOverall;
const TRANSOM_Z = hull.transom;
const BOW_Z = -hull.stem;
/** Each hull's centreline, out from the boat's. */
const C = boat.physics.hulls.hullSpacing / 2;

/** Station u runs from the transom (0) to the bows (1). */
const zAt = (u: number): number => TRANSOM_Z - u * L;
const uAt = (z: number): number => (TRANSOM_Z - z) / L;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The catalog's outline: the plan at the sheer, the hulls' outer sides, ending in the bows' points half the spacing out. */
function outline(u: number): number {
  const o = hull.outline;
  const x = Math.min(1, Math.max(0, u)) * (o.length - 1);
  const i = Math.min(o.length - 2, Math.floor(x));
  const f = x - i;
  return (o[i] ?? 0) * (1 - f) + (o[i + 1] ?? 0) * f;
}

/** The hull's half-breadth at its sheer about its own centreline: its outer side to the outline, its inner side flatter, coming to the same point at the bow. */
const outerAt = (u: number): number => Math.max(0, outline(u) - C);
const innerAt = (u: number): number => 0.86 * outerAt(u);

/** Height of the sheer above the waterline: low aft, rising a little to the bows. */
const sheer = (u: number): number => 0.42 + 0.08 * u * u;

/** Where the canoe body is deepest: over the keels' middle. */
const DEEPEST = uAt(-foils.boardPosition);
/** The bottom's depth at the transom, just immersed, and at the forefoot, clear of the water (negative). */
const TRANSOM_DEPTH = 0.02;
const FOREFOOT_DEPTH = -0.05;

/**
 * Depth of the keel line below the waterline: the canoe body, deepest at
 * the keels' middle, rising in a long rocker to the transom, just immersed,
 * and forward to the forefoot under the bow, clear of the water.
 */
function keelDepth(u: number): number {
  const d = hull.hullDraught;
  if (u <= DEEPEST) {
    return d - (d - TRANSOM_DEPTH) * ((DEEPEST - u) / DEEPEST) ** 2;
  }
  return d - (d - FOREFOOT_DEPTH) * ((u - DEEPEST) / (1 - DEEPEST)) ** 1.8;
}

/** The waterline's half-breadth: most of the sheer's, fining to nothing at the bow's entry. */
const waterAt = (u: number): number =>
  0.8 * Math.min(outerAt(u), innerAt(u) / 0.86) * (1 - smoothstep(0.86, 1, u) * 0.15);

/** The bottom's exponent: rounded aft, a V forward. */
const bottomN = (u: number): number => lerp(2.4, 1.6, smoothstep(0.4, 1, u));

/**
 * A point of the starboard hull's section at station u, girth fraction g
 * from the keel (0) to the sheer (1), on its outer (s = 1) or inner (s = −1)
 * side: below the water a superellipse's quarter, symmetric, then the
 * topsides flaring out to the sheer, the outer fuller than the inner.
 */
const WATER_G = 0.45;
function section(u: number, g: number, s: number): Vec3 {
  const bottom = -keelDepth(u);
  const w = waterAt(u);
  const top = s > 0 ? outerAt(u) : innerAt(u);
  const z = zAt(u);
  // The bilge's top: the waterline, or a little above the bottom where it
  // rises clear of the water at the bow.
  const yw = Math.max(0, bottom + 0.03);
  if (g <= WATER_G) {
    const a = ((g / WATER_G) * Math.PI) / 2;
    const e = 2 / bottomN(u);
    return [C + s * w * Math.sin(a) ** e, bottom + (yw - bottom) * (1 - Math.cos(a) ** e), z];
  }
  const t = (g - WATER_G) / (1 - WATER_G);
  const flare = s > 0 ? 1 - (1 - t) ** 1.6 : t;
  return [C + s * lerp(w, top, flare), lerp(yw, sheer(u), t), z];
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
  // The trampoline: a net of tarred hemp, drawn as rope is.
  { name: 'net', color: srgb(0.2, 0.15, 0.1), roughness: 0.9, metalness: 0, doubleSided: true },
  { name: 'foil', color: srgb(0.5, 0.3, 0.14), roughness: 0.35, metalness: 0 },
  { name: 'leather', color: srgb(0.36, 0.22, 0.12), roughness: 0.7, metalness: 0 },
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

/** The dark sheer strake, the varnished transoms, ash, and the deck's planks. */
const SHEER_STRAKE = srgb(0.165, 0.133, 0.106);
const MAHOGANY = srgb(0.5, 0.25, 0.13);
const ASH = srgb(0.86, 0.72, 0.5);
const DECK = srgb(0.86, 0.76, 0.58);

/** Stations along a hull, from the transom (0) to the bows (1). */
const stations = (n = D.stations): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

/** A quad's two triangles wound to face out. */
function quadFacing(m: MeshBuilder, a: number, b: number, c: number, d: number, out: Vec3): void {
  m.triFacing(a, b, c, out);
  m.triFacing(a, c, d, out);
}

// --- The planking ------------------------------------------------------------

/** How the girth runs: rows from the keel (0) up each side to the sheer (1); the top row band is the sheer strake. */
const girthRows = (): number[] => {
  const rows = Array.from({ length: D.girth + 1 }, (_, i) => i / D.girth);
  return D.small ? [...rows.slice(0, -1), 0.93, 1].sort((a, b) => a - b) : rows;
};

/**
 * The starboard hull's shell: narrow carvel planks, flush, each plank band
 * its own tone of the paint; the sheer strake dark and bright. Its port
 * twin is its mirror.
 */
function planking(): { painted: MeshBuilder; bright: MeshBuilder } {
  const painted = new MeshBuilder('topsides');
  const bright = new MeshBuilder('timber');
  const rows = girthRows();
  for (const s of [1, -1]) {
    for (let k = 0; k + 1 < rows.length; k++) {
      const g0 = rows[k] as number;
      const g1 = rows[k + 1] as number;
      const sheerStrake = g0 >= 0.93 - 1e-9;
      const m = sheerStrake ? bright : painted;
      const tone = 0.9 + 0.2 * jitter(k * 7 + (s > 0 ? 0 : 3));
      const lower: number[] = [];
      const upper: number[] = [];
      const outs: Vec3[] = [];
      for (const [i, u] of stations().entries()) {
        const grain = tone * (0.96 + 0.08 * jitter(k * 100 + i));
        const c: Vec3 = sheerStrake ? shade(SHEER_STRAKE, grain) : [grain, grain, grain];
        const a = section(u, g0, s);
        const b = section(u, g1, s);
        lower.push(m.vertex(a, c, [0, u], [0, u]));
        upper.push(m.vertex(b, c, [1, u], [1, u]));
        const mid = add(scale(a, 0.5), scale(b, 0.5));
        outs.push(normalize([mid[0] - C, mid[1] - 0.15, 0.0001]));
      }
      for (let i = 0; i + 1 < lower.length; i++) {
        quadFacing(
          m,
          lower[i] as number,
          lower[i + 1] as number,
          upper[i + 1] as number,
          upper[i] as number,
          outs[i] as Vec3,
        );
      }
    }
  }
  return { painted, bright };
}

/** The transom: varnished mahogany across the hull's after end, keel to sheer. */
function transom(m: MeshBuilder): void {
  const n = Math.max(2, D.girth);
  const ring: number[] = [];
  for (let i = 0; i <= n; i++) {
    ring.push(m.vertex(section(0, i / n, 1), MAHOGANY));
  }
  for (let i = n - 1; i >= 1; i--) {
    ring.push(m.vertex(section(0, i / n, -1), MAHOGANY));
  }
  const mid = m.vertex([C, sheer(0) / 2, TRANSOM_Z], MAHOGANY);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[(i + 1) % ring.length] as number, [0, 0, 1]);
  }
}

// --- The decks ---------------------------------------------------------------

const CROWN = 0.03;
/** The deck's height at x, out from the boat's centreline, at station u: crowned across its hull. */
function deckY(x: number, u: number): number {
  const o = outerAt(u);
  const i = innerAt(u);
  const d = x - C;
  const half = d >= 0 ? o : i;
  const t = half > 1e-6 ? Math.min(1, Math.abs(d) / half) : 1;
  return sheer(u) + CROWN * (1 - t * t);
}

/** The starboard hull's deck: laid planks fore and aft, their seams payed dark, crowned from its inner edge to its outer. */
function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const n = D.deckRows * 2;
  const cols: number[][] = Array.from({ length: n + 1 }, () => []);
  for (const u of stations()) {
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      const x = C - innerAt(u) + f * (innerAt(u) + outerAt(u));
      const tone = 0.92 + 0.12 * jitter(Math.floor(j / 2) * 17);
      const seam = D.small && j % 2 === 0 && j > 0 && j < n ? 0.55 : 1;
      (cols[j] as number[]).push(m.vertex([x, deckY(x, u), zAt(u)], shade(DECK, tone * seam)));
    }
  }
  for (let j = 0; j < n; j++) {
    const a = cols[j] as number[];
    const b = cols[j + 1] as number[];
    for (let i = 0; i + 1 < a.length; i++) {
      quadFacing(
        m,
        a[i] as number,
        a[i + 1] as number,
        b[i + 1] as number,
        b[i] as number,
        [0, 1, 0],
      );
    }
  }
  return m;
}

// --- The platform ------------------------------------------------------------

/** The beams' stations: the front beam carries the mast; the rear beam the mainsheet's horse. */
const FRONT_Z = -rig.mastPosition;
const REAR_Z = 1.95;
/** A beam's half-width and depth, and how high it stands on its pylons above the decks. */
const BEAM_W = 0.05;
const BEAM_D = 0.045;
const PYLON = 0.035;
const beamY = (z: number): number => deckY(C, uAt(z)) + PYLON + BEAM_D;
/** The beams reach out to the hulls' outer sides less a hand. */
const BEAM_REACH = C + 0.15;
/** The trampoline, a little below the beams' tops, between the hulls' inner edges. */
const NET_FORE = FRONT_Z + BEAM_W + 0.01;
const NET_AFT = REAR_Z - BEAM_W - 0.01;
const NET_Y = sheer(uAt((NET_FORE + NET_AFT) / 2)) + 0.025;
const netEdge = (z: number): number => C - innerAt(uAt(z)) - 0.03;

/** A beam: ash, its section a rounded rectangle, across the boat at z. */
function beamAcross(m: MeshBuilder, z: number): void {
  const y = beamY(z) - BEAM_D;
  const ring: [number, number][] = [];
  const corners = D.small ? 3 : 1;
  for (const [cy, cz, a0] of [
    [BEAM_D * 0.6, BEAM_W * 0.6, 0],
    [-BEAM_D * 0.6, BEAM_W * 0.6, 90],
    [-BEAM_D * 0.6, -BEAM_W * 0.6, 180],
    [BEAM_D * 0.6, -BEAM_W * 0.6, 270],
  ] as [number, number, number][]) {
    for (let i = 0; i <= corners; i++) {
      const a = ((a0 + (90 * i) / corners) * Math.PI) / 180;
      ring.push([cy + Math.cos(a) * BEAM_D * 0.4, cz + Math.sin(a) * BEAM_W * 0.4]);
    }
  }
  const xs = D.small
    ? [-BEAM_REACH, -C, -C / 2, 0, C / 2, C, BEAM_REACH]
    : [-BEAM_REACH, BEAM_REACH];
  const rows = xs.map((x) =>
    ring.map(([dy, dz]) => {
      const k = m.vertex([x, y + dy, z + dz], ASH);
      m.normal(k, [0, dy, dz]);
      return k;
    }),
  );
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = rows[r] as number[];
    const b = rows[r + 1] as number[];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const p = ring[i] as [number, number];
      quadFacing(m, a[i] as number, a[j] as number, b[j] as number, b[i] as number, [
        0,
        p[0],
        p[1],
      ]);
    }
  }
  for (const [row, dir] of [
    [rows[0] as number[], -1],
    [rows[rows.length - 1] as number[], 1],
  ] as [number[], number][]) {
    const x = dir * BEAM_REACH;
    const centre = m.vertex([x, y, z], ASH);
    m.normal(centre, [dir, 0, 0]);
    for (let i = 0; i < row.length; i++) {
      m.triFacing(centre, row[i] as number, row[(i + 1) % row.length] as number, [dir, 0, 0]);
    }
  }
}

/** The pylons, oak blocks on the decks under the beams' ends, and the hemp lashing each beam to them. */
function pylons(timber: MeshBuilder, rope: MeshBuilder): void {
  for (const z of [FRONT_Z, REAR_Z]) {
    for (const s of [1, -1]) {
      const y0 = deckY(C, uAt(z)) - 0.01;
      timber.box(
        [s * C - 0.1, y0, z - BEAM_W - 0.015],
        [s * C + 0.1, y0 + PYLON + 0.012, z + BEAM_W + 0.015],
        shade(MAHOGANY, 0.8),
      );
      if (D.small) {
        // Turns of tarred hemp round beam and pylon, either side of the hull's centreline.
        for (const dx of [-0.07, 0.07]) {
          const loop: Vec3[] = [];
          for (let i = 0; i <= 8; i++) {
            const a = (i / 8) * 2 * Math.PI;
            loop.push([
              s * C + dx,
              beamY(z) - BEAM_D - 0.01 + Math.cos(a) * (BEAM_D + 0.012),
              z + Math.sin(a) * (BEAM_W + 0.012),
            ]);
          }
          rope.tube(loop, [0.008], 4);
        }
      }
    }
  }
}

/** The side bars: ash along each hull's inner side from beam to beam, the net laced to them. */
function sideBars(m: MeshBuilder): void {
  for (const s of [1, -1]) {
    const path: Vec3[] = [];
    const n = D.small ? 8 : 2;
    for (let i = 0; i <= n; i++) {
      const z = NET_FORE - 0.02 + ((NET_AFT - NET_FORE + 0.04) * i) / n;
      path.push([s * (netEdge(z) - 0.005), NET_Y + 0.01, z]);
    }
    m.tube(path, [0.022], D.small ? 6 : 3, ASH);
  }
}

/**
 * The trampoline: a net of tarred hemp, its strands fore and aft and
 * across, laced to the beams and the side bars; far off, a plain plate.
 */
function net(): MeshBuilder {
  const m = new MeshBuilder('net');
  const dark: Vec3 = [0.8, 0.8, 0.8];
  if (D.netStrands === 0) {
    const zs = [NET_FORE, (NET_FORE + NET_AFT) / 2, NET_AFT];
    const row = (s: number) => zs.map((z) => m.vertex([s * netEdge(z), NET_Y, z], dark));
    const a = row(-1);
    const b = row(1);
    for (let i = 0; i + 1 < a.length; i++) {
      quadFacing(
        m,
        a[i] as number,
        a[i + 1] as number,
        b[i + 1] as number,
        b[i] as number,
        [0, 1, 0],
      );
    }
    return m;
  }
  const W = 0.012;
  /** A flat ribbon along a path, W wide, facing up. */
  const ribbon = (path: Vec3[], across: Vec3): void => {
    const left = path.map((p) => m.vertex(add(p, scale(across, -W / 2)), dark));
    const right = path.map((p) => m.vertex(add(p, scale(across, W / 2)), dark));
    for (let i = 0; i + 1 < path.length; i++) {
      quadFacing(
        m,
        left[i] as number,
        left[i + 1] as number,
        right[i + 1] as number,
        right[i] as number,
        [0, 1, 0],
      );
    }
  };
  const n = D.netStrands;
  // Fore and aft, across the width, each a slight sag.
  for (let j = 0; j <= n; j++) {
    const f = j / n;
    const path: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      const z = NET_FORE + ((NET_AFT - NET_FORE) * i) / 10;
      const x = (2 * f - 1) * netEdge(z);
      const sag = 0.015 * Math.sin(Math.PI * f) * Math.sin((Math.PI * i) / 10);
      path.push([x, NET_Y - sag, z]);
    }
    ribbon(path, [1, 0, 0]);
  }
  // Across, every as far as the fore-and-aft strands are apart.
  const across = Math.round(((NET_AFT - NET_FORE) * n) / (2 * netEdge(0)));
  for (let i = 0; i <= across; i++) {
    const z = NET_FORE + ((NET_AFT - NET_FORE) * i) / across;
    const e = netEdge(z);
    const path: Vec3[] = [];
    for (let j = 0; j <= 8; j++) {
      const f = j / 8;
      const sag = 0.015 * Math.sin(Math.PI * f) * Math.sin((Math.PI * i) / across);
      path.push([(2 * f - 1) * e, NET_Y - sag + 0.003, z]);
    }
    ribbon(path, [0, 0, 1]);
  }
  return m;
}

/**
 * The hiking straps: leather along the net, one each side of the middle,
 * from the rear beam forward past the crew's station, so the helm's feet
 * and the crew's both go under one; each stands off the net a little more
 * between its ends.
 */
const STRAP_X = 0.45;
const STRAP_AFT = NET_AFT - 0.02;
const STRAP_FORE = -0.5;
const STRAP_R = 0.012;
const strapY = (z: number): number =>
  NET_Y + 0.02 + 0.03 * Math.sin((Math.PI * (STRAP_AFT - z)) / (STRAP_AFT - STRAP_FORE));
function straps(m: MeshBuilder): void {
  for (const x of [-STRAP_X, STRAP_X]) {
    const path: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      const z = STRAP_AFT - ((STRAP_AFT - STRAP_FORE) * i) / 10;
      path.push([x, strapY(z), z]);
    }
    m.tube(path, [STRAP_R], 4);
  }
}

// --- Spars, rigging and sails ----------------------------------------------------

const MAST_Z = -rig.mastPosition;
/** The mast stands on a bronze ball on the front beam. */
const mastFootY = beamY(FRONT_Z) + 0.03;
const MAST_TOP = rig.boomHeight + rig.luff + 0.1;
/** The mast's section: a teardrop, its radius at its foot and head, and its tail aft. */
const MAST_FOOT_R = 0.042;
const MAST_HEAD_R = 0.03;
const mastR = (y: number): number =>
  lerp(MAST_FOOT_R, MAST_HEAD_R, Math.max(0, (y - mastFootY) / (MAST_TOP - mastFootY)) ** 2);
/** The jib's tack, on the bridle's apex between the bows. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];
/** The hounds, where the forestay, the shrouds and the trapeze wires meet the mast: a little above the jib's head. */
const HOUNDS = TACK[1] + headsails.headsailLuff + 0.15;
/** The forestay, from the tack to the mast's fore side at the hounds. */
const STAY_TOP: Vec3 = [0, HOUNDS, MAST_Z - mastR(HOUNDS)];
/** How far aft of the tack the jib's head is: along the forestay, the jib's luff up. */
const RAKE = (headsails.headsailLuff * (STAY_TOP[2] - TACK[2])) / (STAY_TOP[1] - TACK[1]);
/** The bows, where the bridle's legs come down to: each hull's stem head. */
const bowHead = (s: number): Vec3 => [s * C, sheer(1) + 0.01, BOW_Z + 0.06];
/** The chainplates, on each hull's outer side just forward of the front beam. */
const CHAIN_Z = FRONT_Z - 0.18;
const CHAIN_U = uAt(CHAIN_Z);
const DEADEYE_R = 0.024;
const deadeye = (s: number, up: number): Vec3 => [
  s * (C + outerAt(CHAIN_U) + 0.016),
  sheer(CHAIN_U) + up,
  CHAIN_Z,
];

/** The mast, in its node's frame (at its station): spruce, a teardrop in section, banded in iron. */
function mast(): { spar: MeshBuilder; iron: MeshBuilder; bronze: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const n = D.mastStations;
  const round = D.round + 2;
  const rings: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const y = mastFootY + (i / n) * (MAST_TOP - mastFootY);
    const r = mastR(y);
    const ring: number[] = [];
    for (let k = 0; k <= round; k++) {
      const a = (k / round) * 2 * Math.PI;
      // A teardrop: round forward, drawn out to a tail aft (+z).
      const tail = Math.max(0, Math.cos(a)) ** 3 * 0.9 * r;
      const p: Vec3 = [Math.sin(a) * r, y, Math.cos(a) * (r + tail)];
      const v = spar.vertex(p);
      spar.normal(v, [Math.sin(a), 0, Math.cos(a)]);
      ring.push(v);
    }
    rings.push(ring);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    spar.strip(rings[i] as number[], rings[i + 1] as number[], true);
  }
  const top = spar.vertex([0, MAST_TOP, 0]);
  spar.normal(top, [0, 1, 0]);
  const last = rings[rings.length - 1] as number[];
  for (let k = 0; k + 1 < last.length; k++) {
    spar.triFacing(top, last[k] as number, last[k + 1] as number, [0, 1, 0]);
  }
  const iron = new MeshBuilder('iron');
  const bronze = new MeshBuilder('bronze');
  // The bronze ball it turns on, in its step on the front beam.
  bronze.tube(
    [
      [0, mastFootY - 0.035, 0],
      [0, mastFootY - 0.005, 0],
    ],
    [0.03, 0.045],
    D.small ? 10 : 4,
  );
  if (!D.small) {
    return { spar, iron, bronze };
  }
  for (const y of [mastFootY + 0.15, rig.boomHeight - 0.05, HOUNDS, MAST_TOP - 0.06]) {
    const r = mastR(y) + 0.004;
    iron.tube(
      [
        [0, y - 0.02, 0.012],
        [0, y + 0.02, 0.012],
      ],
      [r * 1.35],
      10,
    );
  }
  return { spar, iron, bronze };
}

/**
 * The standing rigging, in the boat's frame: each shroud from the hounds to
 * a pair of deadeyes and a lanyard on a bronze chainplate on the hull's
 * outer side; the forestay from the hounds down to the bridle's apex, the
 * jib hanked to it, and the bridle's legs to each bow; the dolphin
 * striker's stays from under the front beam to the bows. Tarred hemp.
 */
function rigging(): { rope: MeshBuilder; bronze: MeshBuilder; wood: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  const wood = new MeshBuilder('timber');
  const R = 0.0045;
  const sides = 4;
  for (const s of [1, -1]) {
    const upper = deadeye(s, 0.22);
    const lower = deadeye(s, 0.1);
    rope.tube([[s * mastR(HOUNDS), HOUNDS, MAST_Z], add(upper, [0, DEADEYE_R, 0])], [R], sides);
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
    bronze.tube(
      [
        [lower[0], lower[1] - DEADEYE_R, CHAIN_Z],
        [s * (C + outerAt(CHAIN_U) + 0.01), sheer(CHAIN_U) - 0.15, CHAIN_Z],
      ],
      [0.008],
      6,
    );
    // The bridle's leg, from the apex to the bow.
    rope.tube([TACK, bowHead(s)], [R], sides);
    bronze.box(add(bowHead(s), [-0.02, -0.03, -0.02]), add(bowHead(s), [0.02, 0.01, 0.03]));
    // The dolphin striker's stay, from its foot to the bow.
    rope.tube([STRIKER_FOOT, add(bowHead(s), [0, -0.04, 0.02])], [0.004], sides);
  }
  rope.tube([TACK, STAY_TOP], [R], sides);
  bronze.box([-0.025, TACK[1] - 0.03, TACK[2] - 0.03], [0.025, TACK[1] + 0.01, TACK[2] + 0.03]);
  for (let v = 0.12; v < 1; v += 0.12) {
    const p: Vec3 = [0, TACK[1] + v * headsails.headsailLuff, TACK[2] + v * RAKE];
    bronze.box(add(p, [-0.01, -0.018, -0.01]), add(p, [0.01, 0.018, 0.01]));
  }
  return { rope, bronze, wood };
}

/** The dolphin striker: an ash strut down from the front beam's middle. */
const STRIKER_FOOT: Vec3 = [0, beamY(FRONT_Z) - BEAM_D - 0.32, FRONT_Z];

/** The helm's station and seat: on the starboard hull aft, forward of the rear beam. */
const SEAT_Z = 1.25;
const SEAT_U = uAt(SEAT_Z);
/** The gunwale at the seat: the hull's deck at its outer edge, just inside it. */
const GUNWALE: Vec3 = [outline(SEAT_U) - 0.004, deckY(outline(SEAT_U) - 0.004, SEAT_U), SEAT_Z];
/** The crew's station, forward of the helm on the same hull, by the shrouds. */
const CREW_Z = -0.2;

/** The trapeze rings: the helm's at a sailor's hip height above the hull, by the shroud; the crew's forward of it. */
const RING_Y = GUNWALE[1] + 0.95;
const RING_R = 0.035;
const ring = (s: number): Vec3 => [s * (C + 0.05), RING_Y, CHAIN_Z + 0.28];
const crewRing = (s: number): Vec3 => [s * (C + 0.08), RING_Y + 0.05, CHAIN_Z + 0.1];

/** A ring of bronze at at, in the plane across the boat. */
function ringLoop(m: MeshBuilder, at: Vec3, s: number): void {
  const loop: Vec3[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    loop.push(add(at, [s * RING_R * Math.cos(a), RING_R * Math.sin(a), 0]));
  }
  m.tube(loop, [0.006], 4);
}

/**
 * A side's helm's trapeze (s, +1 starboard), in the boat's frame: a wire
 * of tarred hemp from the hounds down to a short lanyard and a bronze
 * ring, which hangs, at rest, by the shroud.
 */
function trapeze(s: number): { rope: MeshBuilder; bronze: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  const from: Vec3 = [s * mastR(HOUNDS), HOUNDS - 0.03, MAST_Z];
  const at = ring(s);
  const top = add(at, [0, RING_R, 0]);
  const dir = normalize(sub(from, top));
  const join = add(top, scale(dir, 0.14));
  rope.tube([from, join], [0.004], 4);
  rope.tube([join, top], [0.003], 4);
  ringLoop(bronze, at, s);
  return { rope, bronze };
}

/** A side's trapeze as a node of its own, named. */
function trapezeSide(name: string, s: number): NodeDef {
  const t = trapeze(s);
  return { name, primitives: [t.rope.primitive(), t.bronze.primitive()] };
}

/**
 * The crew's trapeze wire on side s: from the hounds, forward of the
 * helm's, down to its bronze ring hanging by the shroud. Tarred hemp.
 */
function crewWire(s: number): { rope: MeshBuilder; bronze: MeshBuilder } {
  const rope = new MeshBuilder('rope');
  const bronze = new MeshBuilder('bronze');
  const crew = crewRing(s);
  rope.tube([[s * mastR(HOUNDS), HOUNDS - 0.05, MAST_Z], add(crew, [0, RING_R, 0])], [0.0035], 4);
  ringLoop(bronze, crew, s);
  return { rope, bronze };
}

/** The crew's wire on a side as a node of its own, which the game hides while the crew hangs on it. */
function crewWireSide(name: string, s: number): NodeDef {
  const t = crewWire(s);
  return { name, primitives: [t.rope.primitive(), t.bronze.primitive()] };
}

/** The boom: spruce, a bronze gooseneck at the mast and a band at its end. */
/** The boom's radius: its underside is this far below its axis. */
const BOOM_R = 0.034;

function boom(): { spar: MeshBuilder; iron: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.04],
      [0, 0, rig.foot + 0.08],
    ],
    [BOOM_R],
    D.small ? 10 : 4,
  );
  const iron = new MeshBuilder('iron');
  if (D.small) {
    iron.tube(
      [
        [0, 0, rig.foot + 0.0],
        [0, 0, rig.foot + 0.04],
      ],
      [0.038],
      10,
    );
  }
  return { spar, iron };
}

function gooseneck(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.box([-0.03, -0.03, -0.02], [0.03, 0.03, 0.07]);
  return m;
}

/** The main's roach, and its square head's width. */
const ROACH = 0.32;
const HEAD = 0.95;

/** The main's chord at fraction v up the luff, as sail() draws it. */
const chordAt = (v: number): number =>
  rig.foot * (1 - v) + HEAD * v + ROACH * Math.sin(Math.PI * v) * (1 - v) ** 0.5;

/** The heights of the main's reef points, as fractions of its luff. */
const REEF_ROWS = rig.reefs.slice(1).map((share) => 1 - share);
/** Its seven full-length battens, as fractions of its luff, in their pockets. */
const BATTENS = [0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.9];

/**
 * The mainsail, flat in the centreline plane at rest: the luff up the
 * mast's after face, the foot along the boom, its head square. TEXCOORD_0
 * maps the sail cloth; TEXCOORD_1 is (u, v), the fraction of the chord and
 * of the luff, from which the client shapes it. A row runs along each
 * reef's points and each batten.
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

/** A headsail, flat in the centreline plane at rest, in its node's frame at the tack: as the skiff's. */
function headsail(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const luff = headsails.headsailLuff;
  const foot = headsails.headsailFoot;
  const rows: number[][] = [];
  for (let i = 0; i <= D.jibRows; i++) {
    const v = i / D.jibRows;
    const c = jibChord(v);
    const row: number[] = [];
    for (let j = 0; j <= D.jibCols; j++) {
      const u = j / D.jibCols;
      const k = m.vertex([0, v * luff, v * RAKE + u * c], [1, 1, 1], [(u * c) / foot, v], [u, v]);
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

// --- Foils and the helm -----------------------------------------------------------

/**
 * The hulls' keels, in the daggerboard node's frame (on the centreline at
 * the keels' middle): under each hull's canoe body, the deep run of its
 * asymmetric hull that is its lateral plane, the catalog's span below the
 * body at its middle, fairing into it at its ends, over the catalog's
 * chord. Oak, as a keel is.
 */
function keels(): MeshBuilder {
  const m = new MeshBuilder('timber');
  const n = D.small ? 16 : 4;
  const zc = -foils.boardPosition;
  const half = foils.boardChord / 2;
  const thick = 0.07;
  for (const s of [1, -1]) {
    const top: number[] = [];
    const bottom: number[] = [];
    const outs: Vec3[] = [];
    for (const face of [1, -1]) {
      for (let i = 0; i <= n; i++) {
        const t = -1 + (2 * i) / n;
        const z = zc + t * half;
        const u = uAt(z);
        const deep = keelDepth(u) + foils.boardSpan * Math.max(0, 1 - t * t) ** 0.6;
        const w = thick * 0.5 * Math.max(0.15, 1 - t * t) ** 0.5;
        const a = m.vertex([s * C + face * w, -keelDepth(u) + 0.03, z - zc], [0.55, 0.36, 0.2]);
        const b = m.vertex([s * C + face * w * 0.3, -deep, z - zc], [0.55, 0.36, 0.2]);
        top.push(a);
        bottom.push(b);
        outs.push([face, -0.3, 0]);
      }
    }
    const rowN = n + 1;
    for (let f = 0; f < 2; f++) {
      for (let i = 0; i < n; i++) {
        const k = f * rowN + i;
        quadFacing(
          m,
          top[k] as number,
          top[k + 1] as number,
          bottom[k + 1] as number,
          bottom[k] as number,
          outs[k] as Vec3,
        );
      }
    }
    // The keel's sole, joining its faces along the bottom.
    for (let i = 0; i < n; i++) {
      quadFacing(
        m,
        bottom[i] as number,
        bottom[i + 1] as number,
        bottom[rowN + i + 1] as number,
        bottom[rowN + i] as number,
        [0, -1, 0],
      );
    }
  }
  return m;
}

/** The rudders' heads, where the tiller arms are pinned, above the water astern of the transoms. */
const RUDDER_HEAD = 0.46;
/** The tiller arms reach forward from the heads to the crossbar. */
const ARM = 0.32;
const CROSSBAR_Y = RUDDER_HEAD + 0.04;

/**
 * A kick-up rudder, in its node's frame (its stock, on its hull's
 * centreline): an oak blade down to the catalog's depth, in a bronze head
 * hung on two pintles on the transom, its ash tiller arm forward to the
 * crossbar.
 */
function rudder(): { oak: MeshBuilder; bronze: MeshBuilder; ash: MeshBuilder } {
  const oak = new MeshBuilder('foil');
  const lead = -0.05;
  blade(
    oak,
    -(hull.hullDraught + foils.rudderSpan),
    0.05,
    lead,
    lead + foils.rudderChord,
    0.022,
    D.small ? 10 : 3,
  );
  const bronze = new MeshBuilder('bronze');
  // The head's cheeks, either side of the blade's top.
  bronze.box([-0.028, 0.02, -0.07], [0.028, RUDDER_HEAD, 0.1]);
  const ash = new MeshBuilder('spar');
  ash.tube(
    [
      [0, RUDDER_HEAD - 0.02, -0.02],
      [0, CROSSBAR_Y, -ARM],
    ],
    [0.018, 0.016],
    D.small ? 8 : 3,
  );
  if (D.small) {
    const forward = TRANSOM_Z - foils.rudderPosition;
    for (const y of [0.1, 0.32]) {
      bronze.box([-0.032, y - 0.012, forward - 0.002], [0.032, y + 0.012, -0.065]);
    }
    // The pivot bolt the blade kicks up on.
    bronze.tube(
      [
        [-0.034, 0.08, 0.0],
        [0.034, 0.08, 0.0],
      ],
      [0.012],
      8,
    );
  }
  return { oak, bronze, ash };
}

/** The crossbar, in its node's frame (its middle): ash from arm to arm across the boat. */
function crossbar(): MeshBuilder {
  const m = new MeshBuilder('spar');
  m.tube(
    [
      [-C - 0.02, 0, 0],
      [0, 0.01, 0],
      [C + 0.02, 0, 0],
    ],
    [0.017],
    D.small ? 8 : 3,
  );
  return m;
}

/**
 * The tiller extension, hinged at the crossbar's middle; at rest along it,
 * forward. Long enough to steer from the wire: the Hobie 16's 2.0 m.
 */
const EXTENSION = 2.0;

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

/** The mainsheet's blocks: under the boom's end, and on the horse on the rear beam. */
const SHEET_Z = REAR_Z;
const SHEET_BLOCK_Y = beamY(REAR_Z) + 0.07;

/** A wooden block: its shell of elm, on a bronze swivel. */
function sheetBlock(): { wood: MeshBuilder; bronze: MeshBuilder } {
  const wood = new MeshBuilder('timber');
  wood.box([-0.02, -0.035, -0.03], [0.02, 0.035, 0.03], shade(MAHOGANY, 0.7));
  const bronze = new MeshBuilder('bronze');
  bronze.tube(
    [
      [0, -0.06, 0],
      [0, -0.035, 0],
    ],
    [0.008],
    6,
  );
  return { wood, bronze };
}

/** The bronze and iron on the platform: the horse on the rear beam, the jib's cleats, the hulls' stem bands; and the righting line. */
function fittings(): { bronze: MeshBuilder; rope: MeshBuilder; ash: MeshBuilder } {
  const m = new MeshBuilder('bronze');
  const rope = new MeshBuilder('rope');
  const ash = new MeshBuilder('spar');
  // The horse: a bronze bar across the rear beam, on two feet.
  const y = beamY(REAR_Z);
  const half = 0.6;
  const bar: Vec3[] = [];
  for (let i = 0; i <= 8; i++) {
    const x = -half + (2 * half * i) / 8;
    bar.push([x, y + 0.035 + 0.012 * (1 - (x / half) ** 2), REAR_Z]);
  }
  m.tube(bar, [0.008], 6);
  for (const s of [1, -1]) {
    m.tube(
      [
        [s * half, y - 0.005, REAR_Z],
        [s * half, y + 0.04, REAR_Z],
      ],
      [0.012],
      6,
    );
    // The jib's sheet cleat on the front beam's end.
    const cz = FRONT_Z;
    const cy = beamY(cz);
    m.box([s * 0.85 - 0.012, cy - 0.003, cz - 0.05], [s * 0.85 + 0.012, cy + 0.02, cz + 0.05]);
    // The stem band, up each bow from the forefoot to the head.
    m.box(
      [s * C - 0.012, -keelDepth(1) - 0.02, BOW_Z - 0.006],
      [s * C + 0.012, sheer(1) + 0.01, BOW_Z + 0.02],
    );
  }
  // The car on the horse.
  m.box([-0.03, y + 0.035, REAR_Z - 0.02], [0.03, y + 0.065, REAR_Z + 0.02]);
  // The righting line: hemp from one front pylon to the other, lying on the net.
  const line: Vec3[] = [];
  for (let i = 0; i <= 10; i++) {
    const f = i / 10;
    const x = (2 * f - 1) * (C - 0.05);
    line.push([x, NET_Y + 0.012, NET_FORE + 0.25 + 0.2 * Math.sin(Math.PI * f)]);
  }
  rope.tube(line, [0.007], 4);
  // The dolphin striker, ash, down from the front beam.
  ash.tube([[0, beamY(FRONT_Z) - BEAM_D, FRONT_Z], STRIKER_FOOT], [0.022, 0.016], 6);
  return { bronze: m, rope, ash };
}

// --- The hull's volume -------------------------------------------------------
//
// The sea is not drawn inside a hull: a volume of stations along it, each
// with the half-beam at the waterline and the depth of the bottom, measured
// here from one hull's own mesh about its centreline, which is offset half
// the spacing either side of the boat's.

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

/** The widest a section is at height y about the hull's centreline: the greatest |x − C| where its cuts cross it. */
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

/** The exponent n of the superellipse whose half-width at half its depth is r of its width. */
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
 * One hull's volume, measured from its mesh: stations from where the
 * bottom leaves the water aft to where the bow does, each [z, half-beam at
 * the waterline about its centreline, depth of the bottom], the exponent of
 * the sections' narrowing below the waterline, and the hull's centreline's
 * offset from the boat's.
 */
function hullVolume(m: MeshBuilder): { stations: number[][]; bilge: number; offset: number } {
  let fore = TRANSOM_Z;
  let aft = BOW_Z;
  for (let i = 0; i < m.count; i++) {
    if ((m.positions[i * 3 + 1] ?? 0) < 0 && (m.positions[i * 3] ?? 0) > 0) {
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
  return { stations: out, bilge: round(bilge / measured), offset: C };
}

/** The solid's sections' exponent. */
const SOLID_EXPONENT = 2.2;

/**
 * The boat as a solid, for what keeps a sailor out of it: stations from
 * the transoms to the bows, each [z, half-beam of the plan (the hulls'
 * outer sides), the decks' height, the keels' depth], whose sections are
 * superellipses of the exponent; and the space between the hulls as the
 * cockpit, from beam to beam: nothing but the net is there, which gives
 * under a foot, so it is open down to just above the water.
 */
function solid(): Record<string, unknown> {
  const round = (x: number): number => Math.round(x * 10000) / 10000;
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const u = i / 20;
      return [round(zAt(u)), round(outline(u)), round(sheer(u)), round(Math.max(0, keelDepth(u)))];
    }),
    exponent: SOLID_EXPONENT,
    cockpit: {
      fore: round(NET_FORE),
      aft: round(NET_AFT),
      halfWidth: round(netEdge(SEAT_Z)),
      floor: round(NET_Y - 0.35),
    },
  };
}

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
      const drawn = C + outerAt(a) + ((outerAt(b) - outerAt(a)) * j) / 20;
      most = Math.max(most, Math.abs(drawn - outline(u)));
    }
  }
  return most;
}

/** Where the sailor sits here against where it sits in the stage's boat: a clip placed there is moved by it. */
const RESTAGE: Vec3 = [
  GUNWALE[0] - STAGE.gunwale[0],
  GUNWALE[1] - STAGE.gunwale[1],
  SEAT_Z - STAGE.seatZ,
].map((v) => Math.round(v * 1e5) / 1e5) as Vec3;

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const r5v = (p: Vec3): Vec3 => p.map(r5) as Vec3;

/**
 * The trapeze's points, for the sailor on the wire: the hounds on the
 * mast's axis, the helm's rings (starboard first) and the crew's, and the
 * starboard hull's outer edge on its deck at the helm's station.
 */
const TRAPEZE = {
  hounds: r5v([0, HOUNDS, MAST_Z]),
  rings: [r5v(ring(1)), r5v(ring(-1))],
  crewRings: [r5v(crewRing(1)), r5v(crewRing(-1))],
  rackEdge: r5v([outline(SEAT_U), deckY(outline(SEAT_U) - 0.004, SEAT_U), SEAT_Z]),
};

/**
 * The stations of the people aboard, as the catalog should have them: the
 * helm's on the starboard hull's deck at its outer edge (the gunwale), the
 * crew's at its inner edge, where they sit.
 */
const STATIONS = {
  helm: r5v(GUNWALE),
  crew: r5v([C - innerAt(uAt(CREW_Z)), sheer(uAt(CREW_Z)), CREW_Z]),
};

/** The side bar's top, the hull's deck at its inner and outer edges, and the hiking strap's underside, at a station z. */
function aboardAt(z: number): Record<string, Vec3> {
  const u = uAt(z);
  return {
    inner: r5v([C - innerAt(u), sheer(u), z]),
    outer: r5v([outline(u), deckY(outline(u) - 0.004, u), z]),
    bar: r5v([netEdge(z) - 0.005, NET_Y + 0.01 + 0.022, z]),
    strap: r5v([STRAP_X, strapY(z) - STRAP_R, z]),
  };
}

/**
 * The places the people aboard are posed against, on the starboard side
 * (the port side's their mirror), in the boat's frame: at the helm's and
 * the crew's stations, the hull's deck at its inner edge (by the net's
 * side bar) and at its outer edge, the side bar's top, and the hiking
 * strap's underside, under which the feet go; the net, laced at its height
 * between its fore and aft edges, its middle sagging; the boom's underside
 * at its lowest; and the righting line as it lies on the net, from its end
 * at the starboard pylon to its middle.
 */
const ABOARD = {
  helm: aboardAt(SEAT_Z),
  crew: aboardAt(CREW_Z),
  net: { y: r5(NET_Y), fore: r5(NET_FORE), aft: r5(NET_AFT), sag: 0.015 },
  boom: r5(rig.boomHeight - BOOM_R),
  line: [r5v([C - 0.05, NET_Y + 0.012, NET_FORE + 0.25]), r5v([0, NET_Y + 0.012, NET_FORE + 0.45])],
};

// --- The model ---------------------------------------------------------------

/** The boat's nodes at the detail in force. */
function model(): NodeDef[] {
  // One hull, then both: the port one its mirror.
  const shell = planking();
  transom(shell.bright);
  const one = new MeshBuilder('topsides');
  one.append(shell.painted);
  one.append(shell.bright);
  const waterline = hullVolume(one);
  const both = (m: MeshBuilder): MeshBuilder => {
    const out = new MeshBuilder(m.material);
    out.append(m);
    out.append(m, true);
    return out;
  };
  const painted = both(shell.painted);
  const bright = both(shell.bright);
  const decks = both(deck());
  const ash = new MeshBuilder('spar');
  beamAcross(ash, FRONT_Z);
  beamAcross(ash, REAR_Z);
  sideBars(ash);
  const blocks = new MeshBuilder('timber');
  const lashings = new MeshBuilder('rope');
  pylons(blocks, lashings);
  const hullParts = [
    painted.primitive({ colors: true }),
    bright.primitive({ colors: true }),
    decks.primitive({ colors: true }),
    ash.primitive({ colors: true }),
    blocks.primitive({ colors: true }),
    net().primitive({ colors: true }),
  ];
  const masts = mast();
  const mastParts = [masts.spar.primitive(), masts.bronze.primitive()];
  const spars = boom();
  const boomParts = [spars.spar.primitive(), gooseneck().primitive()];
  if (D.small) {
    const leather = new MeshBuilder('leather');
    straps(leather);
    const f = fittings();
    f.rope.append(lashings);
    hullParts.push(
      leather.primitive(),
      f.bronze.primitive(),
      f.rope.primitive(),
      f.ash.primitive({ colors: true }),
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
    boomParts.push(spars.iron.primitive());
  }
  const block = sheetBlock();
  const nodes: NodeDef[] = [
    {
      name: 'hull',
      primitives: hullParts,
      extras: {
        waterline,
        plan: { deviation: planDeviation() },
        solid: solid(),
      },
    },
    { name: 'mast', translation: [0, 0, MAST_Z], primitives: mastParts },
    {
      name: 'boom',
      translation: [0, rig.boomHeight, MAST_Z],
      primitives: boomParts,
      children: D.small
        ? [
            {
              name: 'sheet-boom',
              translation: [0, -0.065, rig.foot - 0.05] as Vec3,
              primitives: [block.wood.primitive({ colors: true }), block.bronze.primitive()],
            },
          ]
        : [],
    },
    {
      name: 'sail',
      translation: [0, rig.boomHeight, MAST_Z],
      extras: { battens: BATTENS },
      primitives: [sail().primitive({ uvs2: true })],
    },
    // The jib at its tack: its luff up the forestay, its head rake aft of the tack.
    {
      name: 'jib',
      translation: TACK,
      extras: { rake: r5(RAKE) },
      primitives: [headsail().primitive({ uvs2: true })],
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
    const l = lantern();
    nodes.push({
      name: 'tricolour',
      translation: [0, MAST_TOP + LANTERN_Y, MAST_Z],
      primitives: [l.brass.primitive(), l.glass.primitive({ colors: true })],
    });
  }
  // The trapeze: its points for the sailor on the wire, and each side's
  // helm's wire, lanyard and ring a node of its own, which the game hides
  // for the side its sailor is hooked on; the crew's likewise.
  // The places the people aboard are posed against.
  nodes.push({ name: 'aboard', extras: ABOARD });
  nodes.push({
    name: 'trapeze',
    extras: TRAPEZE,
    children: D.small
      ? [
          trapezeSide('trapeze-starboard', 1),
          trapezeSide('trapeze-port', -1),
          crewWireSide('trapeze-crew-starboard', 1),
          crewWireSide('trapeze-crew-port', -1),
        ]
      : [],
  });
  // The rudders on the transoms, each turning on its own stock; the
  // crossbar between their arms, the extension from its middle.
  const rudderSide = (name: string, s: number): NodeDef => {
    const r = rudder();
    const prims = [r.oak.primitive(), r.bronze.primitive(), r.ash.primitive()];
    return { name, translation: [s * C, 0, 0], primitives: prims };
  };
  nodes.push(
    {
      name: 'rudder',
      translation: [0, 0, foils.rudderPosition],
      children: [
        rudderSide('rudder-starboard', 1),
        rudderSide('rudder-port', -1),
        {
          name: 'tiller',
          translation: [0, CROSSBAR_Y, -ARM],
          primitives: [crossbar().primitive()],
          children: [
            {
              name: 'extension',
              translation: [0, 0, 0],
              extras: { length: EXTENSION },
              primitives: D.small ? [extension().primitive()] : [],
              children: [{ name: 'grip', translation: [0, 0, -EXTENSION] }],
            },
          ],
        },
      ],
    },
    // The hulls' keels, their lateral planes.
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [keels().primitive({ colors: true })],
    },
    // Where the sailor sits: on the starboard hull aft, at the seated
    // height; and how its clips, placed in the stage's boat, are moved here.
    {
      name: 'sailor',
      translation: [0, hull.centreOfGravity + sailor.sailorSeatHeight, SEAT_Z],
      extras: { restage: RESTAGE },
    },
    // What the sailor holds and sits on, on the starboard side (the port
    // side's are their mirror): the hull's outer edge at the seat's
    // station, and where the starboard hull's keel leaves its bottom, by
    // which the sailor stands on the lower hull to right her.
    { name: 'gunwale', translation: GUNWALE },
    {
      name: 'board-root',
      translation: r5v([C, -keelDepth(uAt(-foils.boardPosition)), -foils.boardPosition]),
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
for (const u of stations(100)) {
  if (C + outerAt(u) > outline(u) + 1e-9) {
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
  `wrote art/${MODEL} and art/${FAR_MODEL}: bows ${BOW_Z.toFixed(2)} m, transoms ${TRANSOM_Z.toFixed(2)} m, ` +
    `seat moved ${RESTAGE.map((v) => v.toFixed(3)).join(', ')} m from the stage's; ` +
    `stations: helm ${STATIONS.helm.join(', ')}, crew ${STATIONS.crew.join(', ')}; ` +
    `net at ${NET_Y.toFixed(4)} m; rake ${RAKE.toFixed(3)} m\n`,
);

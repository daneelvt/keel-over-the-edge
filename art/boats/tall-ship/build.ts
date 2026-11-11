// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The tall ship: a ship-rigged collier of the eighteenth century, as the
// Endeavour replica is. A carvel hull with copper below a white boot top,
// her topsides in the paint her sailor chooses, a gold wale along the deck
// line and a cream strake under a dark cap rail; a raised quarterdeck aft
// and a low forecastle forward, the waist between them; a flat transom
// with her name and the stern gallery's windows, small windows on the
// quarters; a long keel and deadwood down to the sternpost, and the rudder
// hung on it. Three masts, each in sections (the lower mast, the topmast
// and, on the fore and main, the topgallant mast) with tops, crosstrees,
// caps and iron bands; shrouds set up with deadeyes on the channels, with
// ratlines, the topmast shrouds from the tops, backstays and stays; the
// bowsprit and its jibboom. Square sails on yards: the courses, topsails
// and topgallants on the fore and main masts, the mizzen topsail over the
// bare crossjack yard; the jib, the fore topmast staysail and the spritsail
// under the bowsprit; the mizzen, a gaff sail on its boom. The wheel on the
// quarterdeck, the binnacle before it, red and green sidelights in their
// screens at the rail and a white lantern on the taffrail; the ship's boat
// on the skids in the waist, the capstan, the hatches, the catheads with
// their anchors, and the pennant at the main truck.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: her length and beam, the plan at her widest,
// the hull's and keel's draught, the masts' places (the mainmast's from
// the after group's centre and the mizzen topsail's share of its area),
// the square sails' foot, luff and areas (the topgallants' share of them
// from the first reef, the topsails' reef bands from the second), the
// mizzen's boom, luff, foot and area, the headsails' tack, the jib's luff
// and foot and the others' areas (the spritsail's from the second reef),
// the keel's and rudder's places, spans and chords, the main top at the
// lookout's eye, and the quarterdeck at the helmsman's feet. The rest
// (the sheer, sections, decks, the masts' sections, the rigging) are this
// script's own.
//
// It builds the ship twice from the same lines: in full, and the far
// model, with few segments, no planking's seams, rigging, fittings,
// telltales, pennant or lanterns, and plain decks. The catalog's art.model
// and art.far name them.
//
//   node art/boats/tall-ship/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { telltales } from '../../lib/fittings.ts';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { add, cross, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../../lib/mesh.ts';

/** The models this script writes, as the catalog's art.model and art.far name them. */
const MODEL = 'boats/tall-ship.glb';
const FAR_MODEL = 'boats/tall-ship.far.glb';

/** How finely a model is built. */
interface Detail {
  /** Stations along the hull, besides the outline's points, the breaks and the stem's. */
  stations: number;
  /** More stations in the stem's last twentieth, where it rises. */
  stem: number;
  /** Rows of the copper, the strakes below the gold wale and above it. */
  copperRows: number;
  strakes: number;
  upperStrakes: number;
  /** Whether each strake shows its seam, a dark line along its lower edge. */
  seams: boolean;
  /** The decks in planks, or plain. */
  plankedDeck: boolean;
  /** Around masts, yards and the other round spars. */
  round: number;
  /** The square sails' columns, and each one's rows. */
  squareCols: number;
  courseRows: number;
  topsailRows: number;
  topgallantRows: number;
  /** The mizzen's rows and columns, and the headsails'. */
  gaffRows: number;
  gaffCols: number;
  jibRows: number;
  jibCols: number;
  /** Segments round the wheel's rim. */
  rim: number;
  /** Rigging, fittings, telltales, pennant, lanterns, panes' frames and the boat. */
  small: boolean;
}

const NEAR: Detail = {
  stations: 44,
  stem: 8,
  copperRows: 4,
  strakes: 6,
  upperStrakes: 7,
  seams: true,
  plankedDeck: true,
  round: 10,
  squareCols: 10,
  courseRows: 8,
  topsailRows: 9,
  topgallantRows: 5,
  gaffRows: 12,
  gaffCols: 8,
  jibRows: 10,
  jibCols: 5,
  rim: 24,
  small: true,
};

const FAR: Detail = {
  stations: 10,
  stem: 2,
  copperRows: 1,
  strakes: 1,
  upperStrakes: 1,
  seams: false,
  plankedDeck: false,
  round: 5,
  squareCols: 3,
  courseRows: 2,
  topsailRows: 2,
  topgallantRows: 1,
  gaffRows: 3,
  gaffCols: 2,
  jibRows: 2,
  jibCols: 1,
  rim: 8,
  small: false,
};

/** The detail being built. */
let D = NEAR;

interface CatalogBoat {
  lengthOverall: number;
  beam: number;
  lookout: number;
  lights: string[];
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
      sailArea: number;
      luff: number;
      foot: number;
      boomHeight: number;
      mastPosition: number;
      footStrip: number;
      headStrip: number;
    };
    headsails: {
      headsailArea: number;
      headsailLuff: number;
      headsailFoot: number;
      headsailTackHeight: number;
      headsailTack: number;
      headsailReefs: number[];
    };
    square: {
      squareForeArea: number;
      squareAfterArea: number;
      squareForeMast: number;
      squareAfterMast: number;
      squareFootHeight: number;
      squareLuff: number;
      squareReefs: number[];
    };
    foils: {
      boardSpan: number;
      boardChord: number;
      boardPosition: number;
      rudderSpan: number;
      rudderChord: number;
      rudderPosition: number;
      fixed: number;
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
const { hull, rig, headsails, square, foils, sailor } = boat.physics;

// --- Small helpers -------------------------------------------------------------

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
/** The greater of two, with the corner between them rounded over k. */
const softMax = (a: number, b: number, k: number): number =>
  (a + b + Math.sqrt((a - b) ** 2 + k * k)) / 2;
const DEG = Math.PI / 180;

/** A fixed pseudo-random number in [0, 1) for an integer. */
const jitter = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
};
const shade = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => lerp3(a, b, t);
const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** A flat quad, its corners in order, facing n, in one colour. */
function quad(m: MeshBuilder, p: Vec3[], n: Vec3, c: Vec3 = [1, 1, 1]): void {
  const k = p.map((q) => {
    const i = m.vertex(q, c);
    m.normal(i, n);
    return i;
  });
  m.triFacing(k[0] as number, k[1] as number, k[2] as number, n);
  m.triFacing(k[0] as number, k[2] as number, k[3] as number, n);
}

/** A rope along a path: a thin tube of a few sides, open at its ends. */
function rope(m: MeshBuilder, path: Vec3[], r: number, sides = 3, colour: Vec3 = [1, 1, 1]): void {
  const rings: number[][] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i] as Vec3;
    const t = normalize(
      sub(path[Math.min(path.length - 1, i + 1)] as Vec3, path[Math.max(0, i - 1)] as Vec3),
    );
    const ref: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(t, ref));
    const v = cross(u, t);
    const ring: number[] = [];
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * 2 * Math.PI;
      const d = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      const k = m.vertex(add(p, scale(d, r)), colour);
      m.normal(k, d);
      ring.push(k);
    }
    rings.push(ring);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    m.strip(rings[i] as number[], rings[i + 1] as number[], true);
  }
}

/** Drops a mesh's triangles of no area: rows of a band that close to a point or a line. */
function prune(m: MeshBuilder): MeshBuilder {
  const p = m.positions;
  const kept: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]].map((k) => {
      const j = (k ?? 0) * 3;
      return [p[j] ?? 0, p[j + 1] ?? 0, p[j + 2] ?? 0] as Vec3;
    }) as [Vec3, Vec3, Vec3];
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n[0], n[1], n[2]) > 1e-9) {
      kept.push(m.indices[i] ?? 0, m.indices[i + 1] ?? 0, m.indices[i + 2] ?? 0);
    }
  }
  m.indices.splice(0, m.indices.length, ...kept);
  return m;
}

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'paint', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  // The topsides, in the paint the boat's sailor chooses: their vertices
  // carry only each plank's tone, and the game gives them the paint.
  { name: 'topsides', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'copper', color: [1, 1, 1], roughness: 0.42, metalness: 0.75 },
  { name: 'gilt', color: srgb(0.86, 0.66, 0.3), roughness: 0.38, metalness: 0.5 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.6, metalness: 0 },
  { name: 'rail', color: srgb(0.24, 0.16, 0.11), roughness: 0.4, metalness: 0 },
  { name: 'varnish', color: [1, 1, 1], roughness: 0.3, metalness: 0 },
  { name: 'spar', color: srgb(0.78, 0.6, 0.38), roughness: 0.4, metalness: 0 },
  { name: 'blackwood', color: srgb(0.11, 0.1, 0.09), roughness: 0.6, metalness: 0 },
  { name: 'iron', color: srgb(0.17, 0.17, 0.18), roughness: 0.5, metalness: 0.6 },
  { name: 'flax', color: srgb(0.93, 0.89, 0.78), roughness: 0.85, metalness: 0, doubleSided: true },
  { name: 'rope', color: srgb(0.2, 0.15, 0.1), roughness: 0.9, metalness: 0 },
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

// --- The hull's lines -------------------------------------------------------
//
// The ship's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bow is -z).
// Station u runs from the transom (0) to the stem (1).

const L = boat.lengthOverall;
const HALF_BEAM = boat.beam / 2;
/** The transom and the stem: the catalog's, where hulls touch. */
const TRANSOM_Z = hull.transom;
const BOW_Z = -hull.stem;
const zAt = (u: number): number => TRANSOM_Z - u * L;
const uAt = (z: number): number => (TRANSOM_Z - z) / L;

/**
 * Half the beam at the hull's widest: the catalog's outline, the plan the
 * physics bumps hulls with. Amidships the widest is at the main wale, low
 * on her side, and her topsides tumble home above it; toward the bow it
 * rises to the rail.
 */
function halfBeam(u: number): number {
  const o = hull.outline;
  const x = Math.min(1, Math.max(0, u)) * (o.length - 1);
  const i = Math.min(o.length - 2, Math.floor(x));
  const f = x - i;
  return (o[i] ?? 0) * (1 - f) + (o[i + 1] ?? 0) * f;
}

// --- The masts' places --------------------------------------------------------
//
// The physics has two square groups: the foremast's sails, and the after
// group, the mainmast's with the mizzen topsail, at its centre of area.

const FORE_Z = -square.squareForeMast;
const MIZZEN_Z = -rig.mastPosition;
/** The mizzen topsail's share of the after group's area, from the replica's sail plan. */
const MIZZEN_TOPSAIL_SHARE = 50 / 395;
const MIZZEN_TOPSAIL_AREA = square.squareAfterArea * MIZZEN_TOPSAIL_SHARE;
const MAIN_AREA = square.squareAfterArea - MIZZEN_TOPSAIL_AREA;
/** The mainmast: where the after group's centre of area puts it, given the mizzen's. */
const MAIN_Z = -(
  (square.squareAfterMast * square.squareAfterArea - rig.mastPosition * MIZZEN_TOPSAIL_AREA) /
  MAIN_AREA
);

// --- The decks and the sheer ---------------------------------------------------

/** The upper deck's height at the side: lowest a little aft of amidships, rising to both ends. */
const DECK_MID = 2.8;
const DECK_LOW = 0.45;
const DECK_AFT_RISE = 0.5;
const DECK_FORE_RISE = 0.95;
const deckAt = (u: number): number =>
  DECK_MID +
  DECK_AFT_RISE * Math.max(0, (DECK_LOW - u) / DECK_LOW) ** 2 +
  DECK_FORE_RISE * Math.max(0, (u - DECK_LOW) / (1 - DECK_LOW)) ** 2;
/** The decks' camber at the centreline, for a deck as wide as her beam. */
const CROWN = 0.15;
const crownAt = (u: number): number => CROWN * (halfBeam(u) / HALF_BEAM);

/** The helmsman's station, aft of the mizzen, where the catalog has his feet. */
const SAILOR_Y = hull.centreOfGravity + sailor.sailorSeatHeight;
const SAILOR_Z = MIZZEN_Z + 3.0;
/** How far the quarterdeck stands above the upper deck: as the helmsman stands. */
const QD_RISE = SAILOR_Y - deckAt(uAt(SAILOR_Z)) - crownAt(uAt(SAILOR_Z));
/** The forecastle's rise above the upper deck. */
const FC_RISE = 0.8;
/** The break of the quarterdeck, forward of the mizzen; the forecastle's, forward of the foremast. */
const QD_FORE_Z = MIZZEN_Z - 4.3;
const FC_AFT_Z = FORE_Z - 1.6;
const U_QD = uAt(QD_FORE_Z);
const U_FC = uAt(FC_AFT_Z);

/** The three decks: the quarterdeck, the waist (the upper deck), the forecastle. */
const QUARTERDECK = 0;
const WAIST = 1;
const FORECASTLE = 2;
type Level = typeof QUARTERDECK | typeof WAIST | typeof FORECASTLE;
const RISE: Record<Level, number> = { 0: QD_RISE, 1: 0, 2: FC_RISE };
/** The bulwarks' height above each deck. */
const BULWARK: Record<Level, number> = { 0: 0.95, 1: 1.05, 2: 0.9 };
/** A deck's height at the side. */
const levelAt = (u: number, level: Level): number => deckAt(u) + RISE[level];
/** The deck's surface at x across, at u. */
const deckSurface = (x: number, u: number, level: Level, half: number): number => {
  const t = half > 1e-6 ? Math.min(1, Math.abs(x) / half) : 1;
  return levelAt(u, level) + crownAt(u) * (1 - t * t);
};

/** The rail's rise to the quarterdeck's (forward of its break) and the forecastle's (aft of its). */
const DRIFT = 2.0;
const FC_DRIFT = 1.0;
/** The stem's head, where the bowsprit rests, a little above the forecastle's deck. */
const STEM_HEAD = levelAt(1, FORECASTLE) + 0.25;
/** The rail sweeps down to the stem's head over the bow's last twentieth. */
const BOW_SWEEP = 0.05;

/** The top of the hull's side, the cap rail's underside: over each deck, rising at the breaks. */
function railAt(u: number): number {
  const z = zAt(u);
  const waist = levelAt(u, WAIST) + BULWARK[WAIST];
  const qd = levelAt(u, QUARTERDECK) + BULWARK[QUARTERDECK];
  const fc = levelAt(u, FORECASTLE) + BULWARK[FORECASTLE];
  const r =
    waist +
    (qd - waist) * smoothstep(QD_FORE_Z - DRIFT, QD_FORE_Z, z) +
    (fc - waist) * smoothstep(FC_AFT_Z + FC_DRIFT, FC_AFT_Z, z);
  return lerp(r, STEM_HEAD, smoothstep(1 - BOW_SWEEP, 1, u));
}

// --- The keel line and the sections ---------------------------------------------

const DRAUGHT = hull.hullDraught;
const KEEL_BOTTOM = -(DRAUGHT + foils.boardSpan);
const KEEL_FORE_Z = -foils.boardPosition - foils.boardChord / 2;
const KEEL_AFT_Z = -foils.boardPosition + foils.boardChord / 2;
/** Where the stem's curve leaves the keel: the keel's fore end. */
const U_FORE = Math.min(0.97, uAt(KEEL_FORE_Z));
/** Where the run begins to rise aft, and the transom's foot (a square tuck) just above the boot top. */
const U_RUN = 0.3;
const TUCK_Y = 0.55;

/**
 * The bottom of the hull's body: at the catalog's draught from the run to
 * the forefoot; rising aft to the tuck at the transom's foot, and forward
 * along the stem's curve, upright at its head.
 */
function keelY(u: number): number {
  if (u < U_RUN) {
    return -DRAUGHT + (DRAUGHT + TUCK_Y) * ((U_RUN - u) / U_RUN) ** 1.8;
  }
  if (u > U_FORE) {
    const t = Math.min(1, (u - U_FORE) / (1 - U_FORE));
    return -DRAUGHT + (STEM_HEAD + DRAUGHT) * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
  }
  return -DRAUGHT;
}

/** The main wale's height amidships: the hull's widest. */
const WALE_Y = 1.5;
/** The height of the hull's widest at u: the wale, rising toward each end. */
const wideY = (u: number): number => {
  const k = keelY(u);
  const r = railAt(u);
  const w = softMax(WALE_Y, k + 0.55 * (r - k), 0.6);
  return Math.min(r - 0.02, Math.max(k + 0.02, w));
};
/** How full the sections are below the widest: fine at the ends, full amidships, square at the tuck. */
const fullness = (u: number): number =>
  1.5 +
  1.0 * smoothstep(0.02, 0.35, u) * (1 - smoothstep(0.7, 0.98, u)) +
  3.5 * (1 - smoothstep(0, 0.07, u));
/** The tumblehome: how much narrower than her widest she is at the rail, as a share. */
const tumble = (u: number): number => 0.07 * (1 - smoothstep(0.7, 0.95, u));
/** The share of a section's girth below the widest. */
const G_WIDE = 0.6;

/** A point on the starboard half-section at u, girth fraction g (0 at the keel, 1 at the rail). */
function section(u: number, g: number): Vec3 {
  const b = halfBeam(u);
  const k = keelY(u);
  const r = railAt(u);
  const w = wideY(u);
  if (g <= G_WIDE) {
    const a = (g / G_WIDE) * (Math.PI / 2);
    const e = 2 / fullness(u);
    return [b * Math.sin(a) ** e, w - (w - k) * Math.max(0, Math.cos(a)) ** e, zAt(u)];
  }
  const t = (g - G_WIDE) / (1 - G_WIDE);
  return [b * (1 - tumble(u) * t ** 1.6), w + (r - w) * t, zAt(u)];
}

/** The girth fraction at height y on the section at u: 0 below the keel, 1 above the rail. */
function girthAt(u: number, y: number): number {
  const k = keelY(u);
  const r = railAt(u);
  const w = wideY(u);
  if (y <= k) {
    return 0;
  }
  if (y >= r) {
    return 1;
  }
  if (y < w) {
    const c = Math.min(1, Math.max(0, (w - y) / (w - k))) ** (fullness(u) / 2);
    return (G_WIDE * Math.acos(c)) / (Math.PI / 2);
  }
  return G_WIDE + ((1 - G_WIDE) * (y - w)) / (r - w);
}

/** The hull's half-breadth at height y at u (its outside). */
const breadth = (u: number, y: number): number => section(u, girthAt(u, y))[0];

/** The hull's outward normal at u, g. */
function surfaceNormal(at: number, g: number): Vec3 {
  const u = Math.min(at, 0.999);
  const h = 1e-4;
  const alongG = sub(section(u, Math.min(1, g + h)), section(u, Math.max(0, g - h)));
  const alongU = sub(section(Math.min(1, u + h), g), section(Math.max(0, u - h), g));
  const n = normalize(cross(alongU, alongG));
  const out: Vec3 = [alongG[1], -alongG[0], 0];
  return n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0 ? scale(n, -1) : n;
}

/** The hull's stations, transom to stem: uniform, the outline's points, the breaks, and more up the stem. */
function stations(): number[] {
  const us: number[] = [];
  for (let i = 0; i <= D.stations; i++) {
    us.push(i / D.stations);
  }
  for (let i = 0; i <= 10; i++) {
    us.push(i / 10);
  }
  for (const z of [QD_FORE_Z, FC_AFT_Z]) {
    us.push(uAt(z) - 0.002, uAt(z) + 0.002);
  }
  for (let i = 1; i <= (D.small ? 3 : 1); i++) {
    us.push(uAt(QD_FORE_Z - (DRIFT * i) / 4), uAt(FC_AFT_Z + (FC_DRIFT * i) / 4));
  }
  for (let i = 1; i < D.stem; i++) {
    us.push(1 - (1 - U_FORE) * (1 - i / D.stem) ** 2);
  }
  us.push(U_FORE);
  const sorted = us.filter((u) => u >= 0 && u <= 1).sort((a, b) => a - b);
  return sorted.filter((u, i) => i === 0 || u - (sorted[i - 1] as number) > 1e-5);
}

/** How far the drawn widest plan, straight between stations, lies from the outline at most, in metres. */
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

// --- The planking ------------------------------------------------------------

/** The topsides' tone (the paint is the boat's), the boot top, the cream strake, the inner bulwarks. */
const TOPSIDES: Vec3 = [1, 1, 1];
const BOOT = srgb(0.93, 0.92, 0.88);
const CREAM = srgb(0.89, 0.85, 0.74);
const INNER = srgb(0.55, 0.22, 0.15);
/** The copper sheathing, going green here and there. */
const COPPER = srgb(0.69, 0.424, 0.25);
const VERDIGRIS = srgb(0.36, 0.52, 0.42);
/** The boot top's upper edge above the waterline; the gold wale under the deck line; the cream strake under the rail. */
const BOOT_TO = 0.3;
const goldFrom = (u: number): number => deckAt(u) - 0.34;
const goldTo = (u: number): number => deckAt(u) - 0.12;
const CREAM_STRAKE = 0.14;
/** The bulwarks' thickness, and the cap rail's. */
const BULWARK_T = 0.2;
const CAP = 0.08;

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
    const g1 = Math.max(g0, to(u));
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

/** Strakes between two girth curves, each its own tone, its lower edge a dark seam. */
function strakes(
  m: MeshBuilder,
  from: (u: number) => number,
  to: (u: number) => number,
  n: number,
  seed: number,
): void {
  const seam = D.seams ? [0, 0.1, 1] : [0, 1];
  for (let k = 0; k < n; k++) {
    const tone = 0.94 + 0.12 * jitter(k + seed);
    band(
      m,
      (u) => lerp(from(u), to(u), k / n),
      (u) => lerp(from(u), to(u), (k + 1) / n),
      seam,
      (r) => shade(TOPSIDES, D.seams && r === 0 ? tone * 0.55 : tone),
    );
  }
}

/**
 * The hull's shell: the copper bottom; the boot top and the cream strake in
 * paint; the gold wale; and the topsides between, in the boat's own paint,
 * with the transom.
 */
function planking(): {
  copper: MeshBuilder;
  paint: MeshBuilder;
  topsides: MeshBuilder;
  gilt: MeshBuilder;
} {
  const g = (y: (u: number) => number) => (u: number) => girthAt(u, y(u));
  const water = g(() => 0);
  const boot = g(() => BOOT_TO);
  const gold0 = g(goldFrom);
  const gold1 = g(goldTo);
  const cream = g((u) => railAt(u) - CREAM_STRAKE);

  const side = new MeshBuilder('copper');
  const rows = Array.from({ length: D.copperRows + 1 }, (_, i) => i / D.copperRows);
  band(
    side,
    () => 0,
    water,
    rows,
    (r, i) => {
      const sheet = Math.floor(i / 2) * 7 + r;
      const tone = 0.88 + 0.2 * jitter(sheet + 300);
      return shade(mix(COPPER, VERDIGRIS, jitter(sheet + 700) > 0.85 ? 0.35 : 0), tone);
    },
  );
  const paintSide = new MeshBuilder('paint');
  band(paintSide, water, boot, [0, 1], () => BOOT);
  band(
    paintSide,
    cream,
    () => 1,
    [0, 1],
    () => CREAM,
  );
  const giltSide = new MeshBuilder('gilt');
  band(giltSide, gold0, gold1, [0, 0.5, 1], (r) => (r === 1 ? [1, 1, 1] : [0.8, 0.8, 0.8]));
  const sides = new MeshBuilder('topsides');
  strakes(sides, boot, gold0, D.strakes, 40);
  strakes(sides, gold1, cream, D.upperStrakes, 60);

  const copper = new MeshBuilder('copper');
  const paint = new MeshBuilder('paint');
  const topsides = new MeshBuilder('topsides');
  const gilt = new MeshBuilder('gilt');
  for (const [to, from] of [
    [copper, side],
    [paint, paintSide],
    [gilt, giltSide],
    [topsides, sides],
  ] as [MeshBuilder, MeshBuilder][]) {
    prune(from);
    to.append(from);
    to.append(from, true);
  }
  topsides.append(transom());
  return { copper, paint, topsides, gilt };
}

/** The taffrail's crown: how much higher the transom's top is at the centreline than at the rail. */
const TAFFRAIL_CROWN = 0.2;
/** The transom's top at x across: the rail's height, crowned. */
const transomTop = (x: number): number => {
  const half = breadth(0, railAt(0) - 0.001);
  const t = Math.min(1, Math.abs(x) / half);
  return railAt(0) + TAFFRAIL_CROWN * (1 - t * t);
};

/** The transom's outline, from the tuck up the starboard side, over the crowned top, and down the port side. */
function transomOutline(inset: number): Vec3[] {
  const n = 2 * D.round;
  const right: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const p = section(0, i / n);
    right.push([Math.max(0, p[0] - inset), p[1], p[2]]);
  }
  const top = right[right.length - 1] as Vec3;
  const crown: Vec3[] = [];
  for (let i = 1; i < n; i++) {
    const x = top[0] * (1 - (2 * i) / n);
    crown.push([x, transomTop(x), TRANSOM_Z]);
  }
  const left = right.map((p): Vec3 => [-p[0], p[1], p[2]]).reverse();
  return [...right, ...crown, ...left];
}

/** The transom: flat across the hull's after end, from the tuck to the taffrail, in the boat's paint. */
function transom(): MeshBuilder {
  const m = new MeshBuilder('topsides');
  const ring = transomOutline(0).map((p) => m.vertex(p, TOPSIDES));
  const mid = m.vertex([0, (TUCK_Y + railAt(0)) / 2, TRANSOM_Z], TOPSIDES);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[i + 1] as number, [0, 0, 1]);
  }
  m.triFacing(mid, ring[ring.length - 1] as number, ring[0] as number, [0, 0, 1]);
  return m;
}

// --- The name, and the stern gallery ---------------------------------------------

/**
 * Where the game writes her name on the transom, from her topsides as it
 * reads them: across the after end, in the middle of the topsides' height
 * there, at most a fifth of the transom's breadth high. The stern
 * gallery's windows go above it.
 */
function namePlace(topsides: MeshBuilder): { y: number; height: number; width: number } {
  const p = topsides.positions;
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  for (let i = 2; i < p.length; i += 3) {
    zMin = Math.min(zMin, p[i] ?? 0);
    zMax = Math.max(zMax, p[i] ?? 0);
  }
  const near = 0.02 * (zMax - zMin);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let across = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (zMax - (p[i + 2] ?? 0) <= near) {
      lo = Math.min(lo, p[i + 1] ?? 0);
      hi = Math.max(hi, p[i + 1] ?? 0);
      across = Math.max(across, Math.abs(p[i] ?? 0));
    }
  }
  lo = Math.max(lo, 0.03);
  const height = Math.min(0.5 * (hi - lo), (1.6 * across) / 8);
  return { y: (lo + hi) / 2, height, width: 8 * height };
}

/** The stern gallery: its windows' sill and head, above the name. */
interface Gallery {
  sill: number;
  head: number;
}

/**
 * The stern gallery's windows across the transom, and two small windows on
 * each quarter at the same height: each of six panes, three across, in a
 * gilt frame, with gilt pilasters between and a gilt moulding over and
 * under them. The panes are the `gallery` mesh, which the game lights by
 * night.
 */
function gallery(at: Gallery): { panes: MeshBuilder; gilt: MeshBuilder } {
  const panes = new MeshBuilder('glass');
  const gilt = new MeshBuilder('gilt');
  const glass = srgb(0.1, 0.13, 0.16);
  const { sill, head } = at;
  const across = breadth(0, sill) - 0.45;
  const windows = 5;
  const pilaster = 0.22;
  const w = (2 * across - (windows + 1) * pilaster) / windows;
  const back: Vec3 = [0, 0, 1];
  const z = TRANSOM_Z;
  const frame = 0.06;
  // The mouldings over and under the windows, and the pilasters between.
  if (D.small) {
    gilt.box([-across - 0.1, sill - 0.12, z], [across + 0.1, sill - 0.02, z + 0.06]);
    gilt.box([-across - 0.1, head + 0.02, z], [across + 0.1, head + 0.14, z + 0.06]);
  }
  for (let i = 0; i < windows; i++) {
    const x0 = -across + pilaster + i * (w + pilaster);
    const x1 = x0 + w;
    if (D.small) {
      gilt.box([x0 - pilaster + 0.03, sill - 0.02, z], [x0 - 0.03, head + 0.02, z + 0.05]);
      // The frame round the window and its bars.
      gilt.box([x0, sill, z], [x1, sill + frame, z + 0.03]);
      gilt.box([x0, head - frame, z], [x1, head, z + 0.03]);
      for (let c = 0; c <= 3; c++) {
        const x = x0 + (c * w) / 3;
        gilt.box([x - frame / 2, sill, z], [x + frame / 2, head, z + 0.03]);
      }
      gilt.box(
        [x0, (sill + head) / 2 - frame / 2, z],
        [x1, (sill + head) / 2 + frame / 2, z + 0.03],
      );
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 2; r++) {
          const a = x0 + (c * w) / 3 + frame / 2;
          const b = x0 + ((c + 1) * w) / 3 - frame / 2;
          const lo = r === 0 ? sill + frame : (sill + head) / 2 + frame / 2;
          const hi = r === 0 ? (sill + head) / 2 - frame / 2 : head - frame;
          quad(
            panes,
            [
              [a, lo, z + 0.012],
              [b, lo, z + 0.012],
              [b, hi, z + 0.012],
              [a, hi, z + 0.012],
            ],
            back,
            shade(glass, 0.9 + 0.2 * jitter(i * 6 + c * 2 + r)),
          );
        }
      }
    } else {
      quad(
        panes,
        [
          [x0, sill, z + 0.012],
          [x1, sill, z + 0.012],
          [x1, head, z + 0.012],
          [x0, head, z + 0.012],
        ],
        back,
        glass,
      );
    }
  }
  // The quarters' windows: two a side, on her topsides, square to them.
  for (const s of [1, -1]) {
    for (const zc of [TRANSOM_Z - 1.0, TRANSOM_Z - 2.1]) {
      const u = uAt(zc);
      const half = 0.36;
      const on = (dz: number, y: number, off: number): Vec3 => {
        const uu = uAt(zc + dz);
        return [s * (breadth(uu, y) + off), y, zc + dz];
      };
      const out: Vec3 = normalize([s, 0, 0.15]);
      const mid = (sill + head) / 2;
      quad(
        panes,
        [
          on(-half, sill, 0.03),
          on(half, sill, 0.03),
          on(half, head, 0.03),
          on(-half, head, 0.03),
        ].map((p): Vec3 => [p[0], p[1], p[2]]),
        out,
        glass,
      );
      if (D.small) {
        const x = s * (breadth(u, mid) + 0.02);
        gilt.box(
          [Math.min(x, x + s * 0.05), sill - 0.1, zc - half - 0.1],
          [Math.max(x, x + s * 0.05), sill, zc + half + 0.1],
        );
        gilt.box(
          [Math.min(x, x + s * 0.05), head, zc - half - 0.1],
          [Math.max(x, x + s * 0.05), head + 0.1, zc + half + 0.1],
        );
        gilt.box(
          [Math.min(x, x + s * 0.05), sill, zc - 0.03],
          [Math.max(x, x + s * 0.05), head, zc + 0.03],
        );
      }
    }
  }
  return { panes, gilt };
}

// --- Bulwarks, rails and decks ---------------------------------------------------

/** Each deck's stretch of stations, from aft forward. */
const REGIONS: [Level, number, number][] = [
  [QUARTERDECK, 0, U_QD],
  [WAIST, U_QD, U_FC],
  [FORECASTLE, U_FC, 1],
];

/** The stations within [a, b], with a and b. */
function stationsIn(a: number, b: number): number[] {
  const us = [a, ...stations().filter((u) => u > a + 1e-4 && u < b - 1e-4), b];
  return us;
}

/** The deck's half-width at u: inside the bulwarks at its side's height. */
const deckHalf = (u: number, level: Level): number =>
  Math.max(0, breadth(u, levelAt(u, level)) - BULWARK_T);

/**
 * The bulwarks' inner faces over each deck, painted, and the dark cap rail
 * along the top of the hull's side.
 */
function bulwarks(): { inner: MeshBuilder; rail: MeshBuilder } {
  const inner = new MeshBuilder('paint');
  const rail = new MeshBuilder('rail');
  for (const [level, a, b] of REGIONS) {
    const us = stationsIn(a, b);
    const rows: number[][] = [[], [], []];
    for (const u of us) {
      const y0 = levelAt(u, level) - 0.02;
      const y2 = railAt(u);
      [y0, (y0 + y2) / 2, y2].forEach((y, r) => {
        const x = Math.max(0, breadth(u, Math.min(y, y2 - 0.001)) - BULWARK_T);
        const k = inner.vertex([x, y, zAt(u)], shade(INNER, 0.9 + 0.1 * r));
        (rows[r] as number[]).push(k);
      });
    }
    // Rows run forward (-z), upward: seen from inboard, from port, clockwise.
    for (let r = 0; r < 2; r++) {
      inner.strip(rows[r] as number[], rows[r + 1] as number[], true);
    }
  }
  // The cap rail: its top, and its outer and inner edges.
  const us = stations().filter((u) => u > 0);
  const out: number[][] = [[], [], [], []];
  for (const u of us) {
    const y = railAt(u);
    const x = breadth(u, y - 0.001);
    const xo = x + 0.05;
    const xi = Math.max(0, x - BULWARK_T - 0.04);
    for (const [r, p] of [
      [0, [xo, y - CAP, zAt(u)]],
      [1, [xo, y, zAt(u)]],
      [2, [xi, y, zAt(u)]],
      [3, [xi, y - CAP, zAt(u)]],
    ] as [number, Vec3][]) {
      (out[r] as number[]).push(rail.vertex(p));
    }
  }
  for (let r = 0; r < 3; r++) {
    rail.strip(out[r] as number[], out[r + 1] as number[]);
  }
  const all = new MeshBuilder('paint');
  all.append(inner);
  all.append(inner, true);
  const rails = new MeshBuilder('rail');
  rails.append(rail);
  rails.append(rail, true);
  // The taffrail's cap, across the transom's crowned top.
  const n = 2 * D.round;
  const half = breadth(0, railAt(0) - 0.001) + 0.05;
  const top: number[] = [];
  const back: number[] = [];
  const fore: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = -half + (2 * half * i) / n;
    const y = transomTop(x);
    top.push(rails.vertex([x, y + 0.06, TRANSOM_Z + 0.06]));
    fore.push(rails.vertex([x, y + 0.06, TRANSOM_Z - BULWARK_T - 0.04]));
    back.push(rails.vertex([x, y - CAP, TRANSOM_Z + 0.06]));
  }
  rails.strip(back, top, true);
  rails.strip(top, fore, true);
  // The transom's inner face over the quarterdeck.
  const face = transomOutline(BULWARK_T)
    .filter((p) => p[1] >= levelAt(0, QUARTERDECK) - 0.05)
    .map((p): Vec3 => [p[0], p[1], TRANSOM_Z - BULWARK_T]);
  const mid = all.vertex([0, (levelAt(0, QUARTERDECK) + railAt(0)) / 2, TRANSOM_Z - BULWARK_T]);
  const ring = face.map((p) => all.vertex(p, INNER));
  for (let i = 0; i + 1 < ring.length; i++) {
    all.triFacing(mid, ring[i] as number, ring[i + 1] as number, [0, 0, -1]);
  }
  return { inner: all, rail: rails };
}

/** The decks' planks: their width, and the tone of the pine. */
const PLANK = 0.26;
const DECK = srgb(0.8, 0.71, 0.55);

/** A deck between two stations at a level, in planks fore and aft, or plain. */
function deckPart(m: MeshBuilder, level: Level, a: number, b: number): void {
  const us = stationsIn(a, b);
  if (!D.plankedDeck) {
    const across = [-1, -0.5, 0, 0.5, 1];
    let prev: number[] | null = null;
    for (const u of us) {
      const w = deckHalf(u, level);
      const row = across.map((f) =>
        m.vertex([f * w, deckSurface(f * w, u, level, w), zAt(u)], DECK, [f * w, u]),
      );
      if (prev !== null) {
        m.strip(prev, row);
      }
      prev = row;
    }
    return;
  }
  const planks = Math.ceil(HALF_BEAM / PLANK);
  for (let j = -planks; j < planks; j++) {
    const x0 = j * PLANK;
    const x1 = (j + 1) * PLANK;
    let prev: number[] | null = null;
    let prevIn = false;
    for (const u of us) {
      const w = deckHalf(u, level);
      const inside = Math.min(x1, w) - Math.max(x0, -w) > 1e-4;
      const edge = x0 >= 0 ? w : -w;
      const lo = inside ? Math.max(x0, -w) : edge;
      const hi = inside ? Math.min(x1, w) : edge;
      // Each plank's butts every few metres: a new tone.
      const butt = Math.floor((zAt(u) + 40 + 2.3 * jitter(j + 900)) / 5.5);
      const c = shade(DECK, 0.86 + 0.24 * jitter(j * 31 + butt + 50));
      const row = [lo, hi].map((x) =>
        m.vertex([x, deckSurface(x, u, level, w), zAt(u)], c, [x, u]),
      );
      if (prev !== null && (prevIn || inside)) {
        m.strip(prev, row);
      }
      prev = row;
      prevIn = inside;
    }
  }
}

function decks(): MeshBuilder {
  const m = new MeshBuilder('deck');
  for (const [level, a, b] of REGIONS) {
    deckPart(m, level, a, b);
  }
  return prune(m);
}

/**
 * The ladders at the breaks: this far out from the centreline, their run
 * fore and aft this share of their rise, a step about every so high; half
 * as wide as this; their treads this thick (half) and deep (half); and the
 * breastwork's rail this far clear of a ladder's middle each side.
 */
const LADDER_X = 1.5;
const LADDER_RUN = 0.55;
const LADDER_STEP = 0.3;
const LADDER_HALF = 0.3;
const LADDER_TREAD = 0.025;
const LADDER_DEPTH = 0.09;
const LADDER_GAP = 0.4;

/**
 * A break's ladder on a side (s): its foot on the waist's deck, its head at
 * the raised deck's edge, and how many rises it has (its treads between).
 */
function ladderAt(
  u: number,
  level: Level,
  facing: number,
  s: number,
): { foot: Vec3; head: Vec3; steps: number } {
  const z = zAt(u);
  const x = s * LADDER_X;
  const y0 = deckSurface(x, u, WAIST, deckHalf(u, WAIST));
  const y1 = deckSurface(x, u, level, deckHalf(u, level));
  const run = (y1 - y0) * LADDER_RUN;
  return {
    foot: [x, y0, z + facing * run],
    head: [x, y1, z],
    steps: Math.round((y1 - y0) / LADDER_STEP),
  };
}

/**
 * The breaks of the quarterdeck and the forecastle: each a bulkhead from
 * the waist's deck up to the raised one, with a breastwork rail on
 * balusters along its edge, and ladders down to the waist.
 */
function breaks(): { paint: MeshBuilder; rail: MeshBuilder } {
  const paint = new MeshBuilder('paint');
  const rail = new MeshBuilder('rail');
  for (const [u, level, facing] of [
    [U_QD, QUARTERDECK, -1],
    [U_FC, FORECASTLE, 1],
  ] as [number, Level, number][]) {
    const z = zAt(u);
    const w = deckHalf(u, level);
    const ww = deckHalf(u, WAIST);
    const n = 8;
    const lower: number[] = [];
    const upper: number[] = [];
    for (let i = 0; i <= n; i++) {
      const x = -w + (2 * w * i) / n;
      lower.push(paint.vertex([x, deckSurface(x, u, WAIST, ww), z], INNER));
      upper.push(paint.vertex([x, deckSurface(x, u, level, w), z], INNER));
    }
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = [lower[i], lower[i + 1], upper[i + 1], upper[i]] as number[];
      paint.triFacing(a as number, b as number, c as number, [0, 0, facing]);
      paint.triFacing(a as number, c as number, d as number, [0, 0, facing]);
    }
    if (!D.small) {
      continue;
    }
    // The doors under the quarterdeck's break; the breastwork above.
    const deckY = deckSurface(0, u, level, w);
    const top = deckY + 0.95;
    const zr = z - facing * 0.08;
    const ladder = LADDER_X;
    // The breastwork's rail stops either side of each ladder's head.
    for (const [a, b] of [
      [-w, -ladder - LADDER_GAP],
      [-ladder + LADDER_GAP, ladder - LADDER_GAP],
      [ladder + LADDER_GAP, w],
    ] as [number, number][]) {
      rail.box([a, top - 0.08, zr - 0.07], [b, top, zr + 0.07]);
    }
    for (let x = -w + 0.2; x <= w - 0.1; x += 0.42) {
      if (Math.abs(Math.abs(x) - ladder) < 0.5) {
        continue;
      }
      rail.box([x - 0.03, deckY, zr - 0.03], [x + 0.03, top - 0.08, zr + 0.03]);
    }
    if (level === QUARTERDECK) {
      for (const s of [1, -1]) {
        const x = s * 0.9;
        const y0 = deckSurface(x, u, WAIST, ww);
        quad(
          paint,
          [
            [x - 0.4, y0, z + facing * 0.01],
            [x + 0.4, y0, z + facing * 0.01],
            [x + 0.4, Math.min(deckY - 0.1, y0 + 1.75), z + facing * 0.01],
            [x - 0.4, Math.min(deckY - 0.1, y0 + 1.75), z + facing * 0.01],
          ],
          [0, 0, facing],
          shade(INNER, 0.4),
        );
      }
    }
    // A ladder each side, from the waist up the break.
    for (const s of [1, -1]) {
      const { foot, head, steps } = ladderAt(u, level, facing, s);
      const x = foot[0];
      for (const side of [-LADDER_HALF, LADDER_HALF]) {
        rail.tube([add(foot, [side, 0, 0]), add(head, [side, 0.05, 0])], [0.035], 4);
      }
      for (let i = 1; i < steps; i++) {
        const p = lerp3(foot, head, i / steps);
        rail.box(
          [x - LADDER_HALF, p[1] - LADDER_TREAD, p[2] - LADDER_DEPTH],
          [x + LADDER_HALF, p[1] + LADDER_TREAD, p[2] + LADDER_DEPTH],
        );
      }
    }
  }
  return { paint, rail };
}

// --- The masts ---------------------------------------------------------------
//
// The fore and main masts: the lower mast up to its cap, the topmast and
// the topgallant mast above it, each fidded in line with the one below so
// the yards' joints turn about one axis; the mizzen has no topgallant mast.

/** The courses' foot, and the square sails' height to the topgallant yards. */
const FOOT_Y = square.squareFootHeight;
const SQUARE_LUFF = square.squareLuff;
/** The lookout's eye in the main top, above its floor. */
const EYE = 1.6;
/** The tops' floor: the lookout's eye less his height. */
const TOP_Y = boat.lookout - EYE;
/** The lower yards, slung under the tops. */
const LOWER_YARD_Y = TOP_Y - 1.0;
const COURSE_DEPTH = LOWER_YARD_Y - FOOT_Y;

/**
 * The square sails' shape, as fractions of the lower yard's sail width:
 * the course's foot, the topsail's head, the topgallant's head.
 */
const COURSE_FOOT_W = 1.04;
const TOPSAIL_HEAD_W = 0.7;
const TOPGALLANT_HEAD_W = 0.46;
/**
 * The topgallants' depth: so that their share of a mast's square area is
 * what the first reef takes in (the luff's share, squared, is the area
 * left), the course's depth fixed by the tops.
 */
const TOPGALLANT_DEPTH = (() => {
  const share = 1 - (square.squareReefs[1] ?? 1) ** 2;
  const a = (COURSE_FOOT_W + 1) / 2;
  const b = (1 + TOPSAIL_HEAD_W) / 2;
  const c = (TOPSAIL_HEAD_W + TOPGALLANT_HEAD_W) / 2;
  return (
    (share * (a * COURSE_DEPTH + b * (SQUARE_LUFF - COURSE_DEPTH))) / (c * (1 - share) + share * b)
  );
})();
const TOPSAIL_DEPTH = SQUARE_LUFF - COURSE_DEPTH - TOPGALLANT_DEPTH;
const TOPSAIL_YARD_Y = LOWER_YARD_Y + TOPSAIL_DEPTH;
const TOPGALLANT_YARD_Y = FOOT_Y + SQUARE_LUFF;
/** The lower yard's sail width for a mast of this much square area. */
const sailWidth = (area: number): number =>
  area /
  (((COURSE_FOOT_W + 1) / 2) * COURSE_DEPTH +
    ((1 + TOPSAIL_HEAD_W) / 2) * TOPSAIL_DEPTH +
    ((TOPSAIL_HEAD_W + TOPGALLANT_HEAD_W) / 2) * TOPGALLANT_DEPTH);

/** The mizzen: its gaff's jaws at the top of the luff, its top above them. */
const THROAT_Y = rig.boomHeight + 0.03 + rig.luff;
const MIZZEN_TOP_Y = THROAT_Y + 0.7;
const CROSSJACK_Y = MIZZEN_TOP_Y - 0.9;
const MIZZEN_TOPSAIL_DEPTH = 6.5;
const MIZZEN_TOPSAIL_YARD_Y = CROSSJACK_Y + MIZZEN_TOPSAIL_DEPTH;
const MIZZEN_TOPSAIL_HEAD_W = 0.7;
const MIZZEN_TOPSAIL_FOOT =
  (2 * MIZZEN_TOPSAIL_AREA) / ((1 + MIZZEN_TOPSAIL_HEAD_W) * MIZZEN_TOPSAIL_DEPTH);

interface Mast {
  z: number;
  /** The deck it stands on. */
  level: Level;
  /** The lower mast's radius at the deck and at its head, the topmast's and the topgallant mast's. */
  lower: [number, number];
  topmast: [number, number];
  topgallant: [number, number] | null;
  /** The top's floor, the lower cap, the crosstrees, the topmast's head (cap), the truck. */
  top: number;
  cap: number;
  crosstrees: number | null;
  topmastHead: number;
  truck: number;
  /** The top's half-breadth, and how far it reaches forward and aft of the mast. */
  topHalf: number;
  topFore: number;
  topAft: number;
}

const FORE: Mast = {
  z: FORE_Z,
  level: WAIST,
  lower: [0.3, 0.25],
  topmast: [0.19, 0.14],
  topgallant: [0.11, 0.07],
  top: TOP_Y,
  cap: TOP_Y + 2.6,
  crosstrees: TOPSAIL_YARD_Y + 0.9,
  topmastHead: TOPSAIL_YARD_Y + 2.7,
  truck: TOPGALLANT_YARD_Y + 2.2,
  topHalf: 2.1,
  topFore: 1.0,
  topAft: 1.5,
};
const MAIN: Mast = {
  ...FORE,
  z: MAIN_Z,
  lower: [0.33, 0.27],
  topmast: [0.21, 0.15],
  topgallant: [0.12, 0.07],
  topHalf: 2.3,
  topFore: 1.1,
  topAft: 1.6,
};
const MIZZEN: Mast = {
  z: MIZZEN_Z,
  level: QUARTERDECK,
  lower: [0.24, 0.19],
  topmast: [0.14, 0.08],
  topgallant: null,
  top: MIZZEN_TOP_Y,
  cap: MIZZEN_TOP_Y + 2.0,
  crosstrees: null,
  topmastHead: MIZZEN_TOPSAIL_YARD_Y + 1.1,
  truck: MIZZEN_TOPSAIL_YARD_Y + 1.6,
  topHalf: 1.6,
  topFore: 0.8,
  topAft: 1.1,
};

/** Where a mast stands on its deck. */
const mastFoot = (m: Mast): number => deckSurface(0, uAt(m.z), m.level, 1);

/** A mast's radius at height y. */
function mastR(m: Mast, y: number): number {
  if (y <= m.cap) {
    const f = (y - mastFoot(m)) / (m.cap - mastFoot(m));
    return lerp(m.lower[0], m.lower[1], Math.max(0, f) ** 2);
  }
  if (m.topgallant === null || y <= m.topmastHead) {
    return lerp(m.topmast[0], m.topmast[1], (y - m.top) / (m.topmastHead - m.top));
  }
  return lerp(
    m.topgallant[0],
    m.topgallant[1],
    (y - (m.crosstrees ?? m.top)) / (m.truck - (m.crosstrees ?? m.top)),
  );
}

/**
 * A mast in its node's frame (at its station): the spars varnished, the
 * mastheads, tops, caps and crosstrees black, banded in iron.
 */
function mastSpars(m: Mast): { spar: MeshBuilder; black: MeshBuilder; iron: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const black = new MeshBuilder('blackwood');
  const iron = new MeshBuilder('iron');
  const foot = mastFoot(m) - 0.1;
  const n = D.round;
  // The lower mast to the top, its masthead (black) to the cap.
  spar.tube(
    [
      [0, foot, 0],
      [0, (foot + m.top) / 2, 0],
      [0, m.top, 0],
    ],
    [m.lower[0], mastR(m, (foot + m.top) / 2), mastR(m, m.top)],
    n,
  );
  black.tube(
    [
      [0, m.top - 0.05, 0],
      [0, m.cap, 0],
    ],
    [mastR(m, m.top) + 0.01, m.lower[1]],
    n,
  );
  // The topmast, from the cap; its head black above the crosstrees.
  const topmastTop = m.topgallant === null ? m.truck : m.topmastHead;
  spar.tube(
    [
      [0, m.cap, 0],
      [0, topmastTop - (m.topgallant === null ? 0 : 1.6), 0],
    ],
    [m.topmast[0], mastR(m, topmastTop - 1.6)],
    n,
  );
  if (m.topgallant !== null) {
    black.tube(
      [
        [0, m.topmastHead - 1.6, 0],
        [0, m.topmastHead, 0],
      ],
      [mastR(m, m.topmastHead - 1.6) + 0.01, m.topmast[1]],
      n,
    );
    spar.tube(
      [
        [0, m.topmastHead, 0],
        [0, m.truck, 0],
      ],
      [m.topgallant[0], m.topgallant[1]],
      Math.max(4, n - 2),
    );
  }
  // The caps, the top and the crosstrees.
  const cap = (y: number, r: number, rUp: number): void => {
    black.box([-r - 0.08, y - 0.18, -r - 0.08], [r + 0.08, y + 0.05, r + 2 * rUp + 0.1]);
  };
  cap(m.cap, m.lower[1], m.topmast[0]);
  if (m.topgallant !== null) {
    cap(m.topmastHead, m.topmast[1], m.topgallant[0]);
  }
  black.box([-m.topHalf, m.top - 0.14, -m.topFore], [m.topHalf, m.top, m.topAft]);
  // The truck, a disc on the masthead.
  black.tube(
    [
      [0, m.truck, 0],
      [0, m.truck + 0.12, 0],
    ],
    [0.16],
    n,
  );
  if (m.crosstrees !== null) {
    for (const z of [-0.45, 0.45]) {
      black.box([-1.25, m.crosstrees - 0.1, z - 0.07], [1.25, m.crosstrees + 0.06, z + 0.07]);
    }
    for (const x of [-0.25, 0.25]) {
      black.box([x - 0.07, m.crosstrees - 0.12, -0.9], [x + 0.07, m.crosstrees + 0.04, 0.9]);
    }
  }
  if (D.small) {
    // The trestletrees under the top; the top's rail aft.
    for (const x of [-0.45, 0.45]) {
      black.box(
        [x - 0.09, m.top - 0.42, -m.topFore + 0.1],
        [x + 0.09, m.top - 0.14, m.topAft - 0.1],
      );
    }
    black.box([-m.topHalf, m.top, m.topAft - 0.08], [m.topHalf, m.top + 0.08, m.topAft]);
    for (let x = -m.topHalf + 0.05; x <= m.topHalf; x += m.topHalf / 3) {
      black.box([x - 0.03, m.top, m.topAft - 0.07], [x + 0.03, m.top + 0.75, m.topAft - 0.01]);
    }
    black.box([-m.topHalf, m.top + 0.72, m.topAft - 0.08], [m.topHalf, m.top + 0.8, m.topAft]);
    // Iron bands round the lower mast and the topmast.
    const band = (y: number): void => {
      const r = mastR(m, y) + 0.012;
      iron.tube(
        [
          [0, y - 0.04, 0],
          [0, y + 0.04, 0],
        ],
        [r],
        n,
      );
    };
    for (let y = foot + 1.6; y < m.top - 0.8; y += 1.7) {
      band(y);
    }
    band(m.cap + 1.0);
    band((m.cap + m.topmastHead) / 2);
  }
  return { spar, black, iron };
}

// --- Yards and square sails ------------------------------------------------------
//
// Each mast's yards and their sails are a node at the mast's axis, which
// the game turns about the vertical to brace them: at rest they lie
// square, athwartships. A yard hangs just forward of its mast, its sail
// below it in the yard's upright plane.

/** A yard's place forward of its mast's axis: the mast's radius, the yard's and a little. */
const yardZ = (m: Mast, y: number, r: number): number => -(mastR(m, y) + r + 0.04);

/** A tapering yard across the ship at height y, its arms beyond the sail's head. */
function yard(spar: MeshBuilder, y: number, z: number, half: number, r: number): void {
  const p = (x: number): Vec3 => [x, y, z];
  spar.tube(
    [p(-half), p(-half * 0.6), p(0), p(half * 0.6), p(half)],
    [r * 0.45, r * 0.85, r, r * 0.85, r * 0.45],
    D.round,
  );
}

interface SquareSail {
  name: string;
  /** Its head and foot heights, widths, and its plane (z) in the yards' frame. */
  head: number;
  foot: number;
  headW: number;
  footW: number;
  z: number;
  rows: number;
  /** Rows the sail is reefed or split at, as fractions from the head. */
  at: number[];
  extras: Record<string, unknown>;
}

/**
 * A square sail: a flat grid in its yard's upright plane, its texture
 * coordinates u from the port arm (0) to the starboard arm (1), v from the
 * head (0) to the foot (1), its faces toward aft.
 */
function squareSail(s: SquareSail): MeshBuilder {
  const m = new MeshBuilder('flax');
  const vs = [...Array.from({ length: s.rows + 1 }, (_, i) => i / s.rows), ...s.at].sort(
    (a, b) => a - b,
  );
  const rows: number[][] = [];
  for (const v of vs.filter((v, i) => i === 0 || v - (vs[i - 1] as number) > 1e-4)) {
    const y = lerp(s.head, s.foot, v);
    const w = lerp(s.headW, s.footW, v);
    const row: number[] = [];
    for (let j = 0; j <= D.squareCols; j++) {
      const u = j / D.squareCols;
      const k = m.vertex([(u - 0.5) * w, y, s.z], [1, 1, 1], [u, v]);
      m.normal(k, [0, 0, 1]);
      row.push(k);
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i] as number[];
    const b = rows[i + 1] as number[];
    for (let j = 0; j + 1 < a.length; j++) {
      // From the head (above) down to the foot, port to starboard: facing aft.
      m.triFacing(b[j] as number, b[j + 1] as number, a[j + 1] as number, [0, 0, 1]);
      m.triFacing(b[j] as number, a[j + 1] as number, a[j] as number, [0, 0, 1]);
    }
  }
  return m;
}

/**
 * How deep from its head a trapezium of sail, headW across its head and
 * footW across its foot, depth deep, must be cut to hold area.
 */
function depthFromHead(headW: number, footW: number, deep: number, area: number): number {
  const k = (footW - headW) / (2 * deep);
  if (Math.abs(k) < 1e-9) {
    return area / headW;
  }
  return (-headW + Math.sqrt(headW * headW + 4 * k * area)) / (2 * k);
}

/** The share of a topsail the second reef takes in: the area it leaves the mast, as the catalog's reefs give. */
const REEFED_SHARE = (() => {
  const r1 = (square.squareReefs[1] ?? 1) ** 2;
  const r2 = (square.squareReefs[2] ?? 1) ** 2;
  const width = sailWidth(1);
  const topsail = ((1 + TOPSAIL_HEAD_W) / 2) * TOPSAIL_DEPTH * width;
  return (r1 - r2) / topsail;
})();

/** A topsail's two reef bands, as fractions of its depth from the head. */
function reefBands(headW: number, footW: number, deep: number): number[] {
  const area = ((headW + footW) / 2) * deep;
  return [0.5, 1].map((f) => depthFromHead(headW, footW, deep, f * REEFED_SHARE * area) / deep);
}

/** A yard: its height, radius, half its length, and where its lifts meet the mast. */
interface SquareYard {
  y: number;
  r: number;
  half: number;
  lift: number;
}

/** A mast's yards and sails, in its yards' node's frame (its axis at the courses' foot). */
interface YardsOut {
  spar: MeshBuilder;
  black: MeshBuilder;
  rope: MeshBuilder;
  sails: NodeDef[];
  meshes: MeshBuilder[];
  /** The topsail's yard, its own node: lowered to the reef band when the topsail is reefed. */
  topsailYard: NodeDef;
}

/**
 * A topsail's yard as its own node under its yards' joint, at the yard's
 * middle, with its footropes; its lifts stay with the joint, up to the
 * topmast's head. Its extras say it is the topsail's yard, which the game
 * lowers to the topsail's reef band as the topsail is reefed.
 */
function topsailYard(name: string, y: SquareYard, z: number): NodeDef {
  const spar = new MeshBuilder('spar');
  const ropes = new MeshBuilder('rope');
  yard(spar, 0, 0, y.half, y.r);
  if (D.small) {
    rigYard(ropes, 0, 0, y.half, 0, false);
  }
  return {
    name,
    translation: [0, y.y - FOOT_Y, z],
    extras: { yard: 'topsail' },
    primitives: prims([
      [spar, false],
      [ropes, false],
    ]),
  };
}

/**
 * The fore or main yards: the lower yard, the topsail yard and the
 * topgallant yard, with their sails, the course, topsail and topgallant.
 * Strip 0 of the group's two is the courses and the topsails' foot, half
 * the group's area; the topsail's split says where its foot ends.
 */
function squareYards(
  m: Mast,
  name: string,
  group: string,
  area: number,
  groupArea: number,
): YardsOut {
  const spar = new MeshBuilder('spar');
  const black = new MeshBuilder('blackwood');
  const ropes = new MeshBuilder('rope');
  const w = sailWidth(area);
  // Each yard rides on its sail's head.
  const yards = [
    { y: LOWER_YARD_Y + 0.2, r: 0.2, half: w / 2 + 0.9, lift: m.cap - 0.2 },
    {
      y: TOPSAIL_YARD_Y + 0.15,
      r: 0.15,
      half: (TOPSAIL_HEAD_W * w) / 2 + 0.7,
      lift: m.topmastHead - 0.2,
    },
    {
      y: TOPGALLANT_YARD_Y + 0.1,
      r: 0.1,
      half: (TOPGALLANT_HEAD_W * w) / 2 + 0.5,
      lift: m.truck - 0.4,
    },
  ];
  const zs = yards.map((y) => yardZ(m, y.y, y.r));
  yards.forEach((y, i) => {
    const own = i === 1;
    if (!own) {
      yard(spar, y.y - FOOT_Y, zs[i] as number, y.half, y.r);
    }
    if (D.small) {
      rigYard(ropes, y.y - FOOT_Y, zs[i] as number, y.half, y.lift - FOOT_Y, true, !own);
    }
  });
  const course = { headW: w, footW: COURSE_FOOT_W * w };
  const topsail = { headW: TOPSAIL_HEAD_W * w, footW: w };
  const topgallant = { headW: TOPGALLANT_HEAD_W * w, footW: TOPSAIL_HEAD_W * w };
  // The topsail's foot that is strip 0: with the course, half the group's area.
  const courseArea = ((course.headW + course.footW) / 2) * COURSE_DEPTH;
  const footArea = Math.max(0, groupArea / 2 - courseArea);
  const footDepth =
    TOPSAIL_DEPTH -
    depthFromHead(
      topsail.headW,
      topsail.footW,
      TOPSAIL_DEPTH,
      ((topsail.headW + topsail.footW) / 2) * TOPSAIL_DEPTH - footArea,
    );
  const split = round5(1 - footDepth / TOPSAIL_DEPTH);
  const reefs = reefBands(topsail.headW, topsail.footW, TOPSAIL_DEPTH).map(round5);
  const square = (strip: number, more: Record<string, unknown> = {}) => ({
    square: { group, strip, ...more },
  });
  const sails: SquareSail[] = [
    {
      name: `${name}-course`,
      head: LOWER_YARD_Y - FOOT_Y,
      foot: 0,
      ...course,
      z: zs[0] as number,
      rows: D.courseRows,
      at: [],
      extras: square(0),
    },
    {
      name: `${name}-topsail`,
      head: TOPSAIL_YARD_Y - FOOT_Y,
      foot: LOWER_YARD_Y - FOOT_Y,
      ...topsail,
      z: zs[1] as number,
      rows: D.topsailRows,
      at: [...reefs, split],
      extras: square(1, { split, reefs }),
    },
    {
      name: `${name}-topgallant`,
      head: TOPGALLANT_YARD_Y - FOOT_Y,
      foot: TOPSAIL_YARD_Y - FOOT_Y,
      ...topgallant,
      z: zs[2] as number,
      rows: D.topgallantRows,
      at: [],
      extras: square(1),
    },
  ];
  const meshes = sails.map(squareSail);
  return {
    spar,
    black,
    rope: ropes,
    sails: sails.map((s, i) => ({
      name: s.name,
      extras: s.extras,
      primitives: [(meshes[i] as MeshBuilder).primitive()],
    })),
    meshes,
    topsailYard: topsailYard(`${name}-topsail-yard`, yards[1] as SquareYard, zs[1] as number),
  };
}

/**
 * A yard's footropes: from this far out from its middle to this far in
 * from its arm, this far below it at their ends and sagging this much
 * more at their middle, this far aft of it; in this many lengths.
 */
const FOOTROPE = { from: 0.6, inset: 0.2, below: 0.25, sag: 0.55, aft: 0.12, lengths: 4 };

/** A yard's footrope on a side (s), the yard at height y and z: its points, from the middle out. */
function footrope(y: number, z: number, half: number, s: number): Vec3[] {
  const path: Vec3[] = [];
  for (let i = 0; i <= FOOTROPE.lengths; i++) {
    const f = i / FOOTROPE.lengths;
    const x = s * lerp(FOOTROPE.from, half - FOOTROPE.inset, f);
    path.push([x, y - FOOTROPE.below - FOOTROPE.sag * Math.sin(Math.PI * f), z + FOOTROPE.aft]);
  }
  return path;
}

/** A yard's lifts, from its arms up to the mast, and its footropes, sagging under it; or one of them. */
function rigYard(
  m: MeshBuilder,
  y: number,
  z: number,
  half: number,
  lift: number,
  lifts = true,
  footropes = true,
): void {
  for (const s of [1, -1]) {
    if (lifts) {
      rope(
        m,
        [
          [s * (half - 0.15), y, z],
          [0, lift, -0.1],
        ],
        0.025,
      );
    }
    if (footropes) {
      rope(m, footrope(y, z, half, s), 0.025);
    }
  }
}

/** The mizzen's yards: the bare crossjack yard, and the mizzen topsail on its yard. */
function mizzenYards(): YardsOut {
  const m = MIZZEN;
  const spar = new MeshBuilder('spar');
  const black = new MeshBuilder('blackwood');
  const ropes = new MeshBuilder('rope');
  const footW = MIZZEN_TOPSAIL_FOOT;
  const headW = MIZZEN_TOPSAIL_HEAD_W * footW;
  const yards = [
    { y: CROSSJACK_Y + 0.14, r: 0.14, half: footW / 2 + 0.6, lift: m.cap - 0.2 },
    { y: MIZZEN_TOPSAIL_YARD_Y + 0.1, r: 0.1, half: headW / 2 + 0.5, lift: m.topmastHead - 0.2 },
  ];
  const zs = yards.map((y) => yardZ(m, y.y, y.r));
  yards.forEach((y, i) => {
    const own = i === 1;
    if (!own) {
      yard(spar, y.y - FOOT_Y, zs[i] as number, y.half, y.r);
    }
    if (D.small) {
      rigYard(ropes, y.y - FOOT_Y, zs[i] as number, y.half, y.lift - FOOT_Y, true, !own);
    }
  });
  const reefs = reefBands(headW, footW, MIZZEN_TOPSAIL_DEPTH).map(round5);
  const sail: SquareSail = {
    name: 'mizzen-topsail',
    head: MIZZEN_TOPSAIL_YARD_Y - FOOT_Y,
    foot: CROSSJACK_Y - FOOT_Y,
    headW,
    footW,
    z: zs[1] as number,
    rows: D.topsailRows,
    at: reefs,
    // Wholly above the after group's half-area height: the upper strip.
    extras: { square: { group: 'after', strip: 1, reefs } },
  };
  const mesh = squareSail(sail);
  return {
    spar,
    black,
    rope: ropes,
    sails: [{ name: sail.name, extras: sail.extras, primitives: [mesh.primitive()] }],
    meshes: [mesh],
    topsailYard: topsailYard('mizzen-topsail-yard', yards[1] as SquareYard, zs[1] as number),
  };
}

// --- The mizzen: boom, gaff and sail ------------------------------------------------

/** The gaff sail's luff, aft of the mizzen's axis (its hoops round the mast). */
const LUFF_Z = 0.32;
/** The gaff's peak: its angle above the horizontal, and its length from the throat, for the catalog's area. */
const PEAK = 40 * DEG;
const GAFF = Math.max(
  0.5,
  (2 * rig.sailArea - rig.foot * rig.luff) /
    (rig.foot * Math.sin(PEAK) + rig.luff * Math.cos(PEAK)),
);
/** The sail's corners in the boom's frame (z aft, y up): tack, clew, peak, throat. */
const TACK_PT: [number, number] = [LUFF_Z, 0.03];
const CLEW_PT: [number, number] = [LUFF_Z + rig.foot, 0.03];
const THROAT_PT: [number, number] = [LUFF_Z, 0.03 + rig.luff];
const PEAK_PT: [number, number] = [
  LUFF_Z + GAFF * Math.cos(PEAK),
  0.03 + rig.luff + GAFF * Math.sin(PEAK),
];

/** The mizzen's point at u along the row (luff to leech) and v up (foot to head). */
function gaffPoint(u: number, v: number): Vec3 {
  const luff: [number, number] = [
    lerp(TACK_PT[0], THROAT_PT[0], v),
    lerp(TACK_PT[1], THROAT_PT[1], v),
  ];
  const leech: [number, number] = [
    lerp(CLEW_PT[0], PEAK_PT[0], v),
    lerp(CLEW_PT[1], PEAK_PT[1], v),
  ];
  return [0, lerp(luff[1], leech[1], u), lerp(luff[0], leech[0], u)];
}

/** The mizzen's chord along its row at v. */
const gaffChord = (v: number): number => gaffPoint(1, v)[2] - gaffPoint(0, v)[2];

/**
 * The mizzen, flat in the centreline plane at rest: its luff up the mast,
 * its foot along the boom, its head along the gaff. TEXCOORD_0 maps the
 * cloth (the distance along the foot over the foot's length, and the share
 * of its height); TEXCOORD_1 is (u, v), the fraction along each row from
 * the luff and up the sail, from which the client shapes it.
 */
function gaffSail(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= D.gaffRows; i++) {
    const v = i / D.gaffRows;
    const row: number[] = [];
    for (let j = 0; j <= D.gaffCols; j++) {
      const u = j / D.gaffCols;
      const p = gaffPoint(u, v);
      const k = m.vertex(p, [1, 1, 1], [(p[2] - LUFF_Z) / rig.foot, v], [u, v]);
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

/** The boom, from its jaws round the mast to beyond the clew. */
function boomSpar(): { spar: MeshBuilder; black: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, 0, 0.3],
      [0, 0, rig.foot * 0.5],
      [0, 0, rig.foot + 1.0],
    ],
    [0.15, 0.17, 0.11],
    D.round,
  );
  const black = new MeshBuilder('blackwood');
  if (D.small) {
    for (const s of [1, -1]) {
      black.box([s * 0.27 - 0.05, -0.12, 0], [s * 0.27 + 0.05, 0.12, 0.6]);
    }
  }
  return { spar, black };
}

/** The gaff, from its jaws at the throat up to the peak, in its node's frame (at the throat on the mast's axis). */
function gaffSpar(): { spar: MeshBuilder; black: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const dir: Vec3 = [0, Math.sin(PEAK), Math.cos(PEAK)];
  const from: Vec3 = [0, 0.12, 0.3];
  spar.tube(
    [from, add(from, scale(dir, GAFF * 0.5)), add(from, scale(dir, GAFF + 0.4))],
    [0.12, 0.12, 0.08],
    D.round,
  );
  const black = new MeshBuilder('blackwood');
  if (D.small) {
    for (const s of [1, -1]) {
      black.box([s * 0.22 - 0.05, 0.02, 0], [s * 0.22 + 0.05, 0.24, 0.55]);
    }
  }
  return { spar, black };
}

// --- The bowsprit and the headsails ---------------------------------------------------

/** The bowsprit's steeve, its radius, and how far it reaches outboard of the stem and in. */
const STEEVE = 26 * DEG;
const BOWSPRIT_R = 0.3;
const BOWSPRIT_OUT = 8.4;
const BOWSPRIT_IN = 4.5;
/** Along the bowsprit, and square to it, upward. */
const ALONG: Vec3 = [0, Math.sin(STEEVE), -Math.cos(STEEVE)];
const UP: Vec3 = [0, Math.cos(STEEVE), Math.sin(STEEVE)];
/** The bowsprit's axis where it crosses the stem, and its cap. */
const BOWSPRIT_AT_STEM: Vec3 = [0, STEM_HEAD + BOWSPRIT_R * 0.9, BOW_Z];
const BOWSPRIT_CAP = add(BOWSPRIT_AT_STEM, scale(ALONG, BOWSPRIT_OUT));
/** The jibboom: on top of the bowsprit, through its cap, reaching this far beyond the stem (her length over all less her length on deck). */
const JIBBOOM_REACH = 10.3;
const JIBBOOM_R = 0.17;
const JIBBOOM_FROM = add(add(BOWSPRIT_CAP, scale(ALONG, -2.6)), scale(UP, BOWSPRIT_R + JIBBOOM_R));
const JIBBOOM_END = add(
  JIBBOOM_FROM,
  scale(ALONG, (JIBBOOM_FROM[2] - (BOW_Z - JIBBOOM_REACH)) / Math.cos(STEEVE)),
);

/** The fore topmast's head, where the jib's and staysail's stays meet it. */
const FORE_TOPMAST_HEAD: Vec3 = [
  0,
  FORE.topmastHead - 0.3,
  FORE_Z - mastR(FORE, FORE.topmastHead - 0.3),
];
/** The headsails' tack, where the physics has them. */
const TACK: Vec3 = [0, headsails.headsailTackHeight, -headsails.headsailTack];

interface Headsail {
  name: string;
  /** Its tack, in the ship's frame; its luff's height above it and the head's rake aft; its foot. */
  tack: Vec3;
  height: number;
  rake: number;
  foot: number;
}

/** A headsail tacked at a point, its luff up a stay toward to for luff metres. */
function headsail(name: string, tack: Vec3, to: Vec3, luff: number, foot: number): Headsail {
  const e = normalize(sub(to, tack));
  return { name, tack, height: luff * e[1], rake: luff * e[2], foot };
}

/** A headsail's head's width. */
const JIB_HEAD = 0.12;

/** The headsails' area but the spritsail's: what the second reef leaves. */
const STAYSAILS_AREA = headsails.headsailArea * (headsails.headsailReefs[2] ?? 1) ** 2;
const SPRITSAIL_AREA = headsails.headsailArea - STAYSAILS_AREA;
/** The jib: on the jib stay from the jibboom's end, with the catalog's luff (along the stay) and foot. */
const JIB = headsail(
  'headsail-jib',
  add(JIBBOOM_END, scale(UP, JIBBOOM_R)),
  FORE_TOPMAST_HEAD,
  headsails.headsailLuff,
  headsails.headsailFoot,
);
/** The fore topmast staysail: on its stay from the bowsprit's cap, the rest of the area. */
const STAYSAIL_FOOT = 8.0;
const STAYSAIL = (() => {
  const tack = add(BOWSPRIT_CAP, scale(UP, BOWSPRIT_R));
  const e = normalize(sub(FORE_TOPMAST_HEAD, tack));
  const jibArea = 0.5 * JIB.height * (JIB.foot + JIB_HEAD);
  const height = Math.max(1, (2 * (STAYSAILS_AREA - jibArea)) / (STAYSAIL_FOOT + JIB_HEAD));
  return headsail('headsail-staysail', tack, FORE_TOPMAST_HEAD, height / e[1], STAYSAIL_FOOT);
})();
/** The spritsail: on its yard under the bowsprit, this far out from the stem, hanging this deep. */
const SPRITSAIL_YARD = add(add(BOWSPRIT_AT_STEM, scale(ALONG, 6.4)), [0, -(BOWSPRIT_R + 0.42), 0]);
const SPRITSAIL_DEPTH = Math.min(5.2, SPRITSAIL_YARD[1] - 1.8);
const SPRITSAIL_HEAD = SPRITSAIL_AREA / (1.04 * SPRITSAIL_DEPTH);
const SPRITSAIL_FOOT = 1.08 * SPRITSAIL_HEAD;

/**
 * A headsail, flat in the centreline plane at rest, in its node's frame
 * (at its tack): its luff up its stay to the head, rake aft of the tack;
 * each height's chord level and aft from the luff, its foot level. Its
 * texture coordinates as the keelboat's jib's.
 */
function headsailMesh(h: Headsail): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= D.jibRows; i++) {
    const v = i / D.jibRows;
    const chord = h.foot * (1 - v) + JIB_HEAD * v;
    const row: number[] = [];
    for (let j = 0; j <= D.jibCols; j++) {
      const u = j / D.jibCols;
      const k = m.vertex(
        [0, v * h.height, v * h.rake + u * chord],
        [1, 1, 1],
        [(u * chord) / h.foot, v],
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

/** The bowsprit, its cap, the jibboom, the spritsail yard and the bobstay, in the ship's frame. */
function bowsprit(): { spar: MeshBuilder; black: MeshBuilder; rope: MeshBuilder } {
  const spar = new MeshBuilder('spar');
  const black = new MeshBuilder('blackwood');
  const ropes = new MeshBuilder('rope');
  const heel = add(BOWSPRIT_AT_STEM, scale(ALONG, -BOWSPRIT_IN));
  spar.tube(
    [heel, BOWSPRIT_AT_STEM, add(BOWSPRIT_AT_STEM, scale(ALONG, BOWSPRIT_OUT * 0.6)), BOWSPRIT_CAP],
    [BOWSPRIT_R, BOWSPRIT_R, BOWSPRIT_R * 0.85, BOWSPRIT_R * 0.65],
    D.round,
  );
  spar.tube(
    [JIBBOOM_FROM, lerp3(JIBBOOM_FROM, JIBBOOM_END, 0.5), JIBBOOM_END],
    [JIBBOOM_R, JIBBOOM_R * 0.85, JIBBOOM_R * 0.5],
    D.round,
  );
  // The cap, square to the bowsprit, round its head and the jibboom above it.
  const capAt = add(BOWSPRIT_CAP, scale(UP, JIBBOOM_R));
  black.tube(
    [add(capAt, scale(ALONG, -0.15)), add(capAt, scale(ALONG, 0.12))],
    [BOWSPRIT_R + JIBBOOM_R + 0.08],
    Math.max(4, D.round - 4),
  );
  // The spritsail yard, under the bowsprit.
  const p = (x: number): Vec3 => [x, SPRITSAIL_YARD[1] + 0.13, SPRITSAIL_YARD[2]];
  const half = SPRITSAIL_HEAD / 2 + 0.6;
  spar.tube([p(-half), p(0), p(half)], [0.06, 0.13, 0.06], D.round);
  if (D.small) {
    // The bobstay, from the cap down to the stem's cutwater; the bowsprit's gammoning.
    const stemAt = (y: number): Vec3 => {
      // The stem's fore edge at height y: search its curve.
      let u = 1;
      for (let i = 0; i < 40; i++) {
        const lo = U_FORE;
        const t = i / 40;
        const uu = lerp(lo, 1, t);
        if (keelY(uu) >= y) {
          u = uu;
          break;
        }
      }
      return [0, y, zAt(u)];
    };
    rope(ropes, [add(BOWSPRIT_CAP, scale(UP, -BOWSPRIT_R)), stemAt(0.8)], 0.05, 4);
    for (let i = 0; i < 4; i++) {
      const q = add(BOWSPRIT_AT_STEM, scale(ALONG, 0.6 + i * 0.16));
      black.tube([add(q, [0, 0, 0]), add(q, scale(ALONG, 0.08))], [BOWSPRIT_R + 0.03], 8);
    }
  }
  return { spar, black, rope: ropes };
}

// --- Standing rigging --------------------------------------------------------------

/** The ropes' radii: shrouds and stays, backstays, ratlines. */
const SHROUD_R = 0.032;
const STAY_R = 0.045;
const RATLINE_R = 0.012;
/** How far apart the ratlines are, one above the next. */
const RATLINE_EVERY = 0.42;
/** The deadeyes' radius and thickness. */
const DEADEYE_R = 0.13;

/** A mast's channel: its height, its outer edge out from the hull, its stretch fore and aft. */
interface Channel {
  y: number;
  z0: number;
  z1: number;
}

const channelOf = (m: Mast, z0: number, z1: number): Channel => ({
  y: railAt(uAt(m.z)) - 0.25,
  z0: m.z + z0,
  z1: m.z + z1,
});
const CHANNEL_OUT = 0.7;
const channelX = (c: Channel, z: number): number => breadth(uAt(z), c.y) + CHANNEL_OUT - 0.08;

/** Where a mast's lower shrouds are made fast under its top. */
const shroudHead = (m: Mast): number => m.top - 0.35;

/**
 * A mast's lower shrouds on a side, fore to aft along its channel, in the
 * ship's frame: each from under the top to the upper deadeye's top.
 */
function lowerShrouds(m: Mast, count: number, c: Channel, s: number): [Vec3, Vec3][] {
  const head = shroudHead(m);
  const lines: [Vec3, Vec3][] = [];
  for (let i = 0; i < count; i++) {
    const z = lerp(c.z0 + 0.3, c.z1 - 0.3, i / Math.max(1, count - 1));
    const top: Vec3 = [
      s * mastR(m, head),
      head,
      m.z + lerp(-0.15, 0.25, i / Math.max(1, count - 1)),
    ];
    lines.push([top, [s * channelX(c, z), c.y + 0.85 + DEADEYE_R, z]]);
  }
  return lines;
}

/** The heights of the lower shrouds' lowest and highest ratlines' range. */
const lowerRatlines = (m: Mast, c: Channel): [number, number] => [c.y + 1.3, shroudHead(m) - 0.8];

/**
 * A mast's futtock shrouds on a side, in its node's frame: each from the
 * top's rim down to a band round the mast.
 */
function futtockShrouds(m: Mast, s: number): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  const count = m.topgallant === null ? 2 : 3;
  for (let i = 0; i < count; i++) {
    const z = lerp(-0.4, 0.6, i / Math.max(1, count - 1));
    out.push([
      [s * (m.topHalf - 0.1), m.top - 0.1, z],
      [s * (mastR(m, m.top - 2.2) + 0.02), m.top - 2.2, z * 0.3],
    ]);
  }
  return out;
}

/** Where a mast's topmast shrouds are made fast, under the crosstrees or the topmast's head. */
const topmastShroudHead = (m: Mast): number => (m.crosstrees ?? m.topmastHead) - 0.3;

/**
 * A mast's topmast shrouds on a side, in its node's frame: each from the
 * topmast's head down to the top's rim, over its futtock shroud.
 */
function topmastShrouds(m: Mast, s: number): [Vec3, Vec3][] {
  const head = topmastShroudHead(m);
  return futtockShrouds(m, s).map(([rim]) => [
    [s * mastR(m, head), head, rim[2] * 0.3],
    [rim[0], m.top + 0.15, rim[2]],
  ]);
}

/**
 * A mast's standing rigging, in its node's frame: its lower shrouds from
 * under the top to deadeyes on the channels, with ratlines; the futtock
 * shrouds; the topmast shrouds from the topmast's head to the top's rim,
 * with ratlines; the topgallant shrouds to the crosstrees; the backstays;
 * and the deadeyes, lanyards and chains on the hull, which are in the
 * hull's frame (returned apart).
 */
function shrouds(
  m: Mast,
  count: number,
  c: Channel,
): {
  rope: MeshBuilder;
  hull: { rope: MeshBuilder; wood: MeshBuilder; iron: MeshBuilder; black: MeshBuilder };
} {
  const ropes = new MeshBuilder('rope');
  const hullRope = new MeshBuilder('rope');
  const wood = new MeshBuilder('blackwood');
  const iron = new MeshBuilder('iron');
  const black = new MeshBuilder('blackwood');
  const local = (p: Vec3): Vec3 => [p[0], p[1], p[2] - m.z];
  // The channel: a plank outboard of the rail.
  for (const s of [1, -1]) {
    const x0 = breadth(uAt((c.z0 + c.z1) / 2), c.y) - 0.1;
    black.box(
      [s > 0 ? x0 : -(x0 + CHANNEL_OUT), c.y - 0.07, c.z0],
      [s > 0 ? x0 + CHANNEL_OUT : -x0, c.y + 0.07, c.z1],
    );
  }
  for (const s of [1, -1]) {
    // The lower shrouds, from fore to aft along the channel.
    const lines = lowerShrouds(m, count, c, s);
    for (const [top, end] of lines) {
      const z = end[2];
      const upper: Vec3 = [s * channelX(c, z), c.y + 0.85, z];
      const lower: Vec3 = [s * channelX(c, z), c.y + 0.3, z];
      rope(ropes, [local(top), local(end)], SHROUD_R);
      // The deadeyes and their lanyard; the chain down the topsides.
      rope(hullRope, [upper, lower], 0.018, 3);
      for (const p of [upper, lower]) {
        wood.tube(
          [
            [p[0] - 0.05, p[1], p[2]],
            [p[0] + 0.05, p[1], p[2]],
          ],
          [DEADEYE_R],
          6,
        );
      }
      const footY = goldFrom(uAt(z)) - 0.3;
      rope(
        iron,
        [add(lower, [0, -DEADEYE_R, 0]), [s * (breadth(uAt(z), footY) + 0.03), footY, z]],
        0.03,
        4,
      );
    }
    // Ratlines across the lower shrouds.
    const [from, to] = lowerRatlines(m, c);
    ratlines(
      ropes,
      lines.map(([a, b]) => [local(a), local(b)]),
      from,
      to,
    );
    // The futtock shrouds, from the top's rim down to a band round the mast.
    for (const [rim, band] of futtockShrouds(m, s)) {
      rope(ropes, [rim, band], SHROUD_R * 0.8);
    }
    // The topmast shrouds, from the topmast's head down to the top's rim.
    const tHead = topmastShroudHead(m);
    const tLines = topmastShrouds(m, s);
    for (const [a, b] of tLines) {
      rope(ropes, [a, b], SHROUD_R * 0.85);
      wood.tube([add(b, [-0.04, -0.12, m.z]), add(b, [0.04, -0.12, m.z])], [DEADEYE_R * 0.75], 6);
    }
    ratlines(ropes, tLines, m.top + 0.7, tHead - 0.7);
    // The topgallant shrouds, to the crosstrees' ends.
    if (m.topgallant !== null && m.crosstrees !== null) {
      for (const z of [-0.45, 0.45]) {
        rope(
          ropes,
          [
            [s * mastR(m, m.truck - 1.0), m.truck - 1.0, 0],
            [s * 1.2, m.crosstrees, z],
          ],
          SHROUD_R * 0.6,
        );
      }
    }
    // The backstays: the topmast's two and the topgallant's one, to the channel's after end.
    const backs: [number, number][] = [[tHead, c.z1 + 0.6]];
    if (m.topgallant !== null) {
      backs.push([m.topmastHead - 0.2, c.z1 + 1.3], [m.truck - 1.0, c.z1 + 2.0]);
    }
    for (const [y, z] of backs) {
      const foot: Vec3 = [s * (channelX(c, Math.min(z, c.z1)) + 0.02), c.y + 0.85, z];
      rope(ropes, [[s * mastR(m, y), y, 0.15], local(foot)], SHROUD_R);
      wood.tube(
        [
          [foot[0] - 0.05, foot[1], foot[2]],
          [foot[0] + 0.05, foot[1], foot[2]],
        ],
        [DEADEYE_R],
        6,
      );
    }
  }
  return { rope: ropes, hull: { rope: hullRope, wood, iron, black } };
}

/**
 * Ratlines across a set of shrouds, fore to aft, every 0.42 m from y0 up to
 * y1: a rope through each shroud's point at that height.
 */
function ratlines(m: MeshBuilder, lines: [Vec3, Vec3][], y0: number, y1: number): void {
  for (let y = y0; y <= y1; y += RATLINE_EVERY) {
    const path = lines.map(([a, b]) => lerp3(a, b, (y - a[1]) / (b[1] - a[1])));
    rope(m, path, RATLINE_R);
  }
}

/** The stays, fore and aft, in the ship's frame. */
function stays(): MeshBuilder {
  const m = new MeshBuilder('rope');
  const front = (mast: Mast, y: number): Vec3 => [0, y, mast.z - mastR(mast, y)];
  const back = (mast: Mast, y: number): Vec3 => [0, y, mast.z + mastR(mast, y)];
  const bs = (out: number): Vec3 =>
    add(add(BOWSPRIT_AT_STEM, scale(ALONG, out)), scale(UP, BOWSPRIT_R));
  // The forestay, the fore topmast stay, the jib stay and the fore topgallant stay.
  rope(m, [front(FORE, FORE.top - 0.4), bs(0.8)], STAY_R * 1.3, 4);
  rope(m, [FORE_TOPMAST_HEAD, STAYSAIL.tack], STAY_R, 4);
  rope(m, [add(FORE_TOPMAST_HEAD, [0, 0.15, 0]), JIB.tack], STAY_R, 4);
  rope(m, [front(FORE, FORE.truck - 1.0), add(JIBBOOM_END, scale(UP, JIBBOOM_R))], STAY_R * 0.7, 4);
  // The main stays: to the foremast's foot, the fore top, the fore crosstrees.
  rope(m, [front(MAIN, MAIN.top - 0.4), back(FORE, mastFoot(FORE) + 0.6)], STAY_R * 1.3, 4);
  rope(
    m,
    [front(MAIN, MAIN.topmastHead - 0.3), [0, FORE.top + 0.1, FORE_Z + FORE.topAft]],
    STAY_R,
    4,
  );
  rope(
    m,
    [front(MAIN, MAIN.truck - 1.0), back(FORE, (FORE.crosstrees ?? FORE.top) + 0.2)],
    STAY_R * 0.7,
    4,
  );
  // The mizzen's stays, to the mainmast.
  rope(m, [front(MIZZEN, MIZZEN.top - 0.4), back(MAIN, mastFoot(MAIN) + 1.2)], STAY_R, 4);
  rope(
    m,
    [front(MIZZEN, MIZZEN.topmastHead - 0.2), [0, MAIN.top + 0.1, MAIN_Z + MAIN.topAft]],
    STAY_R * 0.8,
    4,
  );
  return m;
}

// --- Keel, deadwood, rudder ---------------------------------------------------------

/**
 * A plate on the centreline: columns, each [z, top, bottom, half-thickness
 * at the top, at the bottom], in order along it; its two sides, its bottom
 * and its ends, coloured by height.
 */
function plate(
  m: MeshBuilder,
  cols: [number, number, number, number, number][],
  colour: (y: number) => Vec3,
): void {
  const rows = 3;
  for (const s of [1, -1]) {
    const grid: number[][] = [];
    for (const [z, top, bottom, t0, t1] of cols) {
      const col: number[] = [];
      for (let r = 0; r <= rows; r++) {
        const f = r / rows;
        const y = lerp(top, bottom, f);
        const k = m.vertex([s * lerp(t0, t1, f), y, z], colour(y));
        m.normal(k, [s, 0, 0]);
        col.push(k);
      }
      grid.push(col);
    }
    for (let i = 0; i + 1 < grid.length; i++) {
      for (let r = 0; r < rows; r++) {
        const a = (grid[i] as number[])[r] as number;
        const b = (grid[i + 1] as number[])[r] as number;
        const c = (grid[i + 1] as number[])[r + 1] as number;
        const d = (grid[i] as number[])[r + 1] as number;
        m.triFacing(a, b, c, [s, 0, 0]);
        m.triFacing(a, c, d, [s, 0, 0]);
      }
    }
  }
  // The bottom, and the two ends.
  const edge = (i: number, s: number, f: number): number => {
    const [z, top, bottom, t0, t1] = cols[i] as [number, number, number, number, number];
    const y = lerp(top, bottom, f);
    return m.vertex([s * lerp(t0, t1, f), y, z], colour(y));
  };
  for (let i = 0; i + 1 < cols.length; i++) {
    const [a, b, c, d] = [edge(i, -1, 1), edge(i + 1, -1, 1), edge(i + 1, 1, 1), edge(i, 1, 1)];
    for (const k of [a, b, c, d]) {
      m.normal(k, [0, -1, 0]);
    }
    m.triFacing(a, b, c, [0, -1, 0]);
    m.triFacing(a, c, d, [0, -1, 0]);
  }
  for (const [i, dir] of [
    [0, Math.sign((cols[0]?.[0] ?? 0) - (cols[1]?.[0] ?? 0))],
    [
      cols.length - 1,
      Math.sign((cols[cols.length - 1]?.[0] ?? 0) - (cols[cols.length - 2]?.[0] ?? 0)),
    ],
  ] as [number, number][]) {
    const n: Vec3 = [0, 0, dir];
    const [a, b, c, d] = [edge(i, -1, 0), edge(i, 1, 0), edge(i, 1, 1), edge(i, -1, 1)];
    for (const k of [a, b, c, d]) {
      m.normal(k, n);
    }
    m.triFacing(a, b, c, n);
    m.triFacing(a, c, d, n);
  }
}

/** Copper sheathing below the boot top, the hull's paint above. */
const sheathed = (y: number): Vec3 => {
  const tone = 0.9 + 0.15 * jitter(Math.floor(y * 3) + 900);
  return shade(COPPER, tone);
};

/**
 * The keel's half-thickness at its foot, and at its root inside the hull's
 * body: a share of the body's breadth there, so that below a shallow body
 * the keel and deadwood read as the hull's lower part, narrowing to the
 * keel.
 */
const KEEL_FOOT_T = 0.24;
const rootT = (z: number): number => {
  const u = uAt(z);
  return Math.min(1.3, Math.max(KEEL_FOOT_T, 0.42 * breadth(u, keelY(u) + 0.25)));
};

/**
 * The keel, in its node's frame (the keel's station): its root inside the
 * hull's body, its foot at the catalog's draught, its length the catalog's
 * chord; sheathed in copper.
 */
function keel(): MeshBuilder {
  const m = new MeshBuilder('copper');
  const c = foils.boardChord;
  const n = D.small ? 12 : 3;
  const cols: [number, number, number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const z = -c / 2 + (c * i) / n;
    const top = keelY(uAt(z - foils.boardPosition)) + 0.25;
    cols.push([z, top, KEEL_BOTTOM, rootT(z - foils.boardPosition), KEEL_FOOT_T]);
  }
  plate(m, cols, sheathed);
  return m;
}

/** The sternpost, just forward of the rudder's stock. */
const POST_Z = foils.rudderPosition - 0.04;

/**
 * The deadwood aft of the keel to the sternpost, and the gripe forward of it
 * up into the stem: in the keel's node's frame, outside its chord.
 */
function deadwood(): MeshBuilder {
  const m = new MeshBuilder('copper');
  const at = -foils.boardPosition;
  const n = D.small ? 8 : 2;
  const aft: [number, number, number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const z = lerp(KEEL_AFT_Z - 0.3, POST_Z, i / n);
    const top = keelY(uAt(z)) + 0.25;
    const t = Math.max(0.2, rootT(z));
    aft.push([
      z - at,
      Math.max(top, KEEL_BOTTOM + 0.3),
      KEEL_BOTTOM,
      t,
      lerp(KEEL_FOOT_T, 0.2, i / n),
    ]);
  }
  plate(m, aft, sheathed);
  const fore: [number, number, number, number, number][] = [];
  const reach = Math.max(1.6, 0.45 * (1 - U_FORE) * L);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const z = KEEL_FORE_Z + 0.3 - f * (reach + 0.3);
    const top = keelY(uAt(Math.min(z, KEEL_FORE_Z))) + 0.25;
    const s = Math.max(0, (KEEL_FORE_Z - z) / reach);
    const end = keelY(uAt(KEEL_FORE_Z - reach));
    const bottom = Math.min(top - 0.05, KEEL_BOTTOM + (end - KEEL_BOTTOM) * s * s);
    const t = Math.max(0.1, rootT(Math.min(z, KEEL_FORE_Z)) * (1 - 0.6 * f));
    fore.push([z - at, top, bottom, t, KEEL_FOOT_T * (1 - 0.6 * f)]);
  }
  plate(m, fore, sheathed);
  return m;
}

/** The rudder's foot: hung on the sternpost, at the keel's depth. */
const RUDDER_FOOT = KEEL_BOTTOM;
/** Where the rudder's stock enters the counter, and the tiller's head in the great cabin. */
const RUDDER_TOP = keelY(uAt(foils.rudderPosition)) + 0.3;
const TILLER_Y = levelAt(uAt(foils.rudderPosition), WAIST) + 0.7;

/**
 * The rudder, in its node's frame (the stock, on the sternpost): its blade
 * hung at its leading edge, as broad as the catalog's chord at its foot and
 * narrowing upward, copper below the boot top and painted above; its stock
 * up through the counter to the tiller's head; iron straps on the pintles.
 */
function rudder(): { copper: MeshBuilder; paint: MeshBuilder; iron: MeshBuilder } {
  const copper = new MeshBuilder('copper');
  const paint = new MeshBuilder('paint');
  const iron = new MeshBuilder('iron');
  const chord = foils.rudderChord;
  const chordTop = Math.min(chord, 1.1);
  const n = D.small ? 4 : 1;
  const columns = (y0: number, y1: number): [number, number, number, number, number][] => {
    const cols: [number, number, number, number, number][] = [];
    // The trailing edge from (chord, foot) up to (chordTop, top): each column's height below it.
    const edgeAt = (z: number): number =>
      z <= chordTop
        ? RUDDER_TOP
        : RUDDER_FOOT + ((RUDDER_TOP - RUDDER_FOOT) * (chord - z)) / (chord - chordTop);
    for (let i = 0; i <= n; i++) {
      const z = 0.02 + ((chord - 0.02) * i) / n;
      const top = Math.min(y1, edgeAt(z));
      const t0 = lerp(0.2, 0.07, i / n);
      cols.push([z, Math.max(top, y0 + 0.01), y0, t0, t0]);
    }
    return cols;
  };
  const water = Math.min(0, RUDDER_TOP);
  plate(copper, columns(RUDDER_FOOT, water), sheathed);
  if (RUDDER_TOP > water) {
    plate(paint, columns(water, RUDDER_TOP), () => srgb(0.16, 0.14, 0.12));
  }
  // The stock, up to the tiller's head.
  paint.tube(
    [
      [0, RUDDER_TOP - 0.2, 0.05],
      [0, TILLER_Y + 0.15, 0.05],
    ],
    [0.17],
    D.small ? 8 : 4,
    srgb(0.16, 0.14, 0.12),
  );
  if (D.small) {
    for (let i = 0; i < 5; i++) {
      const y = lerp(RUDDER_FOOT + 0.4, RUDDER_TOP - 0.3, i / 4);
      iron.box([-0.23, y - 0.06, -0.12], [0.23, y + 0.06, 0.7]);
    }
  }
  return { copper, paint, iron };
}

/** The tiller in the great cabin, from the rudder's head forward: hidden under the quarterdeck. */
function tiller(): MeshBuilder {
  const m = new MeshBuilder('varnish');
  m.tube(
    [
      [0, 0, 0.1],
      [0, 0.08, -2.4],
    ],
    [0.1, 0.07],
    D.small ? 6 : 3,
    srgb(0.45, 0.27, 0.15),
  );
  return m;
}

// --- The wheel ---------------------------------------------------------------------
//
// The helmsman stands on the quarterdeck facing forward, the wheel before
// him, its axle fore and aft: its hub 0.55 m ahead of his feet and 1.05 m
// above the deck, its rim 0.75 m round, eight spokes with turned handles
// 0.15 m beyond it. The node turns about its own z axis with the rudder.

const WHEEL_RADIUS = 0.75;
const WHEEL_HANDLE = 0.15;
const WHEEL_SPOKES = 8;
const WHEEL_AHEAD = 0.55;
const WHEEL_HEIGHT = 1.05;
const WHEEL_Z = SAILOR_Z - WHEEL_AHEAD;
const WHEEL_Y = SAILOR_Y + WHEEL_HEIGHT;
const WOOD = srgb(0.48, 0.28, 0.14);

/**
 * The wheel in its node's frame (the hub's centre): the rim in the x-y
 * plane, the spokes from the hub through the rim to their handles, the
 * first straight up; the hub, and the barrel forward of it on the same
 * axle, that winds the tiller ropes.
 */
function wheel(): { wood: MeshBuilder; brass: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  const ring: Vec3[] = [];
  for (let i = 0; i <= D.rim; i++) {
    const a = (i / D.rim) * 2 * Math.PI;
    ring.push([WHEEL_RADIUS * Math.cos(a), WHEEL_RADIUS * Math.sin(a), 0]);
  }
  wood.tube(ring, [0.035], D.small ? 6 : 3, WOOD);
  const spokeSides = D.small ? 5 : 3;
  for (let k = 0; k < WHEEL_SPOKES; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / WHEEL_SPOKES;
    const d: Vec3 = [Math.cos(a), Math.sin(a), 0];
    wood.tube(
      [scale(d, 0.12), scale(d, WHEEL_RADIUS), scale(d, WHEEL_RADIUS + 0.03)],
      [0.022, 0.018, 0.024],
      spokeSides,
      WOOD,
    );
    if (D.small) {
      // The handle: turned, swelling and narrowing to a knob.
      wood.tube(
        [
          scale(d, WHEEL_RADIUS + 0.03),
          scale(d, WHEEL_RADIUS + 0.08),
          scale(d, WHEEL_RADIUS + 0.13),
          scale(d, WHEEL_RADIUS + WHEEL_HANDLE),
        ],
        [0.022, 0.03, 0.022, 0.012],
        6,
        shade(WOOD, 0.8),
      );
    }
  }
  wood.tube(
    [
      [0, 0, 0.08],
      [0, 0, -0.12],
    ],
    [0.12],
    D.small ? 10 : 4,
    WOOD,
  );
  wood.tube(
    [
      [0, 0, -0.18],
      [0, 0, -0.95],
    ],
    [0.17],
    D.small ? 10 : 4,
    shade(WOOD, 0.85),
  );
  if (D.small) {
    brass.tube(
      [
        [0, 0, 0.09],
        [0, 0, 0.12],
      ],
      [0.07],
      8,
    );
  }
  return { wood, brass };
}

/** The wheel's stand, the binnacle before it, in the ship's frame. */
function helm(): { wood: MeshBuilder; brass: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const brass = new MeshBuilder('brass');
  const deckY = deckSurface(0, uAt(WHEEL_Z), QUARTERDECK, 1);
  for (const s of [1, -1]) {
    wood.box(
      [s * 0.3 - 0.06, deckY - 0.02, WHEEL_Z - 0.75],
      [s * 0.3 + 0.06, WHEEL_Y + 0.05, WHEEL_Z - 0.6],
      WOOD,
    );
    wood.box(
      [s * 0.3 - 0.06, deckY - 0.02, WHEEL_Z - 0.75],
      [s * 0.3 + 0.06, deckY + 0.12, WHEEL_Z - 0.1],
      WOOD,
    );
  }
  const bz = WHEEL_Z - 1.9;
  const by = deckSurface(0, uAt(bz), QUARTERDECK, 1);
  wood.box([-0.32, by - 0.02, bz - 0.25], [0.32, by + 0.95, bz + 0.25], shade(WOOD, 0.9));
  brass.tube(
    [
      [0, by + 0.95, bz],
      [0, by + 1.15, bz],
      [0, by + 1.3, bz],
    ],
    [0.24, 0.22, 0.05],
    D.small ? 10 : 4,
  );
  return { wood, brass };
}

// --- Lanterns ------------------------------------------------------------------------

/** The glass by day, unlit: each lens the dull colour of its light. */
const LENS_RED = srgb(0.5, 0.11, 0.09);
const LENS_GREEN = srgb(0.09, 0.38, 0.2);
const LENS_CLEAR = srgb(0.78, 0.77, 0.7);

/** Where each light is: the sidelights on the rail abreast of the foremast's shrouds, the sternlight on the taffrail. */
const SIDELIGHT_Z = FORE_Z + 2.6;
const sidelightAt = (s: number): Vec3 => {
  const u = uAt(SIDELIGHT_Z);
  const y = railAt(u) + 0.38;
  return [s * (breadth(u, railAt(u) - 0.001) + 0.24), y, SIDELIGHT_Z];
};
const STERNLIGHT: Vec3 = [0, transomTop(0) - 0.1, TRANSOM_Z + 0.32];

/**
 * A sidelight in its node's frame (the lens's middle): a lamp of brass
 * with its coloured lens toward the bow and outboard, on a board along the
 * rail, and the screen inboard of it that keeps the light from showing
 * across the bow.
 */
function sidelight(s: number): { brass: MeshBuilder; glass: MeshBuilder; board: MeshBuilder } {
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const board = new MeshBuilder('paint');
  const lens = s > 0 ? LENS_GREEN : LENS_RED;
  glass.tube(
    [
      [0, -0.13, 0],
      [0, 0.13, 0],
    ],
    [0.1],
    8,
    lens,
  );
  brass.tube(
    [
      [0, 0.13, 0],
      [0, 0.2, 0],
      [0, 0.28, 0],
    ],
    [0.13, 0.1, 0.03],
    8,
  );
  brass.tube(
    [
      [0, -0.2, 0],
      [0, -0.13, 0],
    ],
    [0.12],
    8,
  );
  // The screen, inboard of the lamp, reaching forward; the shelf under it.
  board.box([-s * 0.16 - 0.02, -0.3, -0.95], [-s * 0.16 + 0.02, 0.32, 0.18], shade(lens, 0.5));
  board.box(
    [Math.min(-s * 0.16, s * 0.16), -0.24, -0.4],
    [Math.max(-s * 0.16, s * 0.16), -0.2, 0.18],
    shade(lens, 0.5),
  );
  return { brass, glass, board };
}

/** The sternlight in its node's frame: a six-sided lantern of clear glass in a brass frame on a bracket. */
function sternlight(): { brass: MeshBuilder; glass: MeshBuilder; iron: MeshBuilder } {
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const iron = new MeshBuilder('iron');
  glass.tube(
    [
      [0, -0.2, 0],
      [0, 0.2, 0],
    ],
    [0.16],
    6,
    LENS_CLEAR,
  );
  brass.tube(
    [
      [0, 0.2, 0],
      [0, 0.28, 0],
      [0, 0.42, 0],
    ],
    [0.2, 0.16, 0.04],
    6,
  );
  brass.tube(
    [
      [0, -0.28, 0],
      [0, -0.2, 0],
    ],
    [0.19],
    6,
  );
  iron.tube(
    [
      [0, -0.28, 0],
      [0, -0.3, -0.33],
    ],
    [0.03],
    4,
  );
  return { brass, glass, iron };
}

// --- Fittings on deck ------------------------------------------------------------------

/** The longboat on the skids in the waist, between the fore and main masts. */
function longboat(): { paint: MeshBuilder; wood: MeshBuilder } {
  const paint = new MeshBuilder('paint');
  const wood = new MeshBuilder('varnish');
  const zc = (FORE_Z + MAIN_Z) / 2 + 0.8;
  const length = 7.0;
  const beam = 1.0;
  const depth = 0.8;
  const u = uAt(zc);
  const y0 = deckSurface(0, u, WAIST, deckHalf(u, WAIST)) + 1.05;
  const n = 10;
  const rows = 4;
  const outer: number[][] = [];
  const inner: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const z = zc + length * (f - 0.5);
    const b = beam * Math.sin(Math.PI * (0.06 + 0.88 * f)) ** 0.7;
    const d = depth * (0.75 + 0.25 * Math.sin(Math.PI * f));
    const o: number[] = [];
    const ins: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const a = (r / rows) * Math.PI;
      const x = -b * Math.cos(a);
      const y = y0 + depth - d * Math.sin(a) ** 0.6;
      o.push(paint.vertex([x, y, z], srgb(0.9, 0.88, 0.82)));
      ins.push(wood.vertex([x * 0.92, Math.min(y0 + depth, y + 0.06), z], WOOD));
    }
    outer.push(o);
    inner.push(ins);
  }
  for (let i = 0; i < n; i++) {
    const a = outer[i] as number[];
    const b = outer[i + 1] as number[];
    const c = inner[i] as number[];
    const d = inner[i + 1] as number[];
    for (let r = 0; r < rows; r++) {
      const mid: Vec3 = [0, y0 + depth / 2, zc];
      const pa = (k: number): Vec3 => [
        paint.positions[k * 3] ?? 0,
        paint.positions[k * 3 + 1] ?? 0,
        paint.positions[k * 3 + 2] ?? 0,
      ];
      const outward = sub(pa(a[r] as number), mid);
      paint.triFacing(a[r] as number, b[r] as number, b[r + 1] as number, outward);
      paint.triFacing(a[r] as number, b[r + 1] as number, a[r + 1] as number, outward);
      wood.triFacing(c[r] as number, d[r] as number, d[r + 1] as number, scale(outward, -1));
      wood.triFacing(c[r] as number, d[r + 1] as number, c[r + 1] as number, scale(outward, -1));
    }
  }
  // The skids it rests on, across the waist on their posts.
  for (const dz of [-2.2, 2.2]) {
    const z = zc + dz;
    const uu = uAt(z);
    const w = deckHalf(uu, WAIST);
    wood.box([-w + 0.3, y0 - 0.12, z - 0.1], [w - 0.3, y0 + 0.05, z + 0.1], shade(WOOD, 0.7));
    for (const s of [1, -1]) {
      const yd = deckSurface(s * 1.4, uu, WAIST, w);
      wood.box(
        [s * 1.4 - 0.08, yd - 0.02, z - 0.08],
        [s * 1.4 + 0.08, y0 - 0.12, z + 0.08],
        shade(WOOD, 0.7),
      );
    }
  }
  return { paint, wood };
}

/** The hatches in the waist, the main and the fore: each its middle and half its breadth; its coaming's height over the deck, and its grating's bars on it. */
const HATCHES: [number, number][] = [
  [MAIN_Z - 3.0, 1.2],
  [FORE_Z + 3.0, 0.9],
];
const HATCH_HEIGHT = 0.35;
const GRATING = 0.02;

/** The capstan, hatches, fife rails, catheads and anchors, and the bitts at the bowsprit's heel. */
function fittings(): { wood: MeshBuilder; black: MeshBuilder; iron: MeshBuilder } {
  const wood = new MeshBuilder('varnish');
  const black = new MeshBuilder('blackwood');
  const iron = new MeshBuilder('iron');
  const on = (z: number, level: Level): number => deckSurface(0, uAt(z), level, 1);
  // The capstan aft of the mainmast.
  const cz = MAIN_Z + 3.4;
  const cy = on(cz, WAIST);
  wood.tube(
    [
      [0, cy - 0.02, cz],
      [0, cy + 0.15, cz],
      [0, cy + 0.75, cz],
      [0, cy + 0.95, cz],
    ],
    [0.55, 0.38, 0.32, 0.55],
    12,
    shade(WOOD, 0.9),
  );
  // Hatches with their gratings, in the waist.
  for (const [z, half] of HATCHES) {
    const y = on(z, WAIST);
    wood.box([-half, y - 0.02, z - half], [half, y + HATCH_HEIGHT, z + half], shade(WOOD, 0.75));
    for (let i = -3; i <= 3; i++) {
      const x = (i * half) / 4;
      black.box(
        [x - 0.03, y + HATCH_HEIGHT, z - half + 0.08],
        [x + 0.03, y + HATCH_HEIGHT + GRATING, z + half - 0.08],
      );
    }
  }
  // Fife rails round the fore and main masts.
  for (const m of [FORE, MAIN]) {
    const y = mastFoot(m);
    const z = m.z;
    for (const [dx, dz] of [
      [-0.9, -0.9],
      [0.9, -0.9],
      [-0.9, 0.9],
      [0.9, 0.9],
    ] as [number, number][]) {
      wood.box(
        [dx - 0.08, y - 0.02, z + dz - 0.08],
        [dx + 0.08, y + 0.9, z + dz + 0.08],
        shade(WOOD, 0.8),
      );
    }
    wood.box([-1.0, y + 0.82, z - 1.0], [1.0, y + 0.92, z - 0.8], shade(WOOD, 0.8));
    wood.box([-1.0, y + 0.82, z + 0.8], [1.0, y + 0.92, z + 1.0], shade(WOOD, 0.8));
  }
  // The bitts at the bowsprit's heel.
  const hz = BOWSPRIT_AT_STEM[2] + BOWSPRIT_IN * Math.cos(STEEVE) - 0.4;
  const hy = on(hz, FORECASTLE);
  for (const s of [1, -1]) {
    black.box([s * 0.42 - 0.12, hy - 0.02, hz - 0.12], [s * 0.42 + 0.12, hy + 1.0, hz + 0.12]);
  }
  black.box([-0.6, hy + 0.7, hz - 0.1], [0.6, hy + 0.85, hz + 0.1]);
  // The catheads, out over the bow from the forecastle's rail, and the anchors hung from them.
  for (const s of [1, -1]) {
    const z = BOW_Z + 2.2;
    const u = uAt(z);
    const y = railAt(u);
    const x = breadth(u, y - 0.001);
    const out: Vec3 = [s * (x + 1.0), y + 0.2, z - 0.7];
    black.tube([[s * (x - 0.6), y - 0.05, z + 0.3], out], [0.13, 0.11], 6);
    // The anchor, stowed hanging: its ring under the cathead, its shank down, its stock across.
    const ring = add(out, [0, -0.2, 0]);
    const crown = add(ring, [0, -2.6, 0.05]);
    iron.tube([ring, crown], [0.07, 0.09], 5);
    iron.tube([add(ring, [0, -0.25, -1.1]), add(ring, [0, -0.25, 1.1])], [0.06], 4);
    for (const dz of [-1, 1]) {
      iron.tube(
        [crown, add(crown, [0, 0.5, dz * 0.65]), add(crown, [0, 0.95, dz * 0.85])],
        [0.07, 0.06, 0.04],
        4,
      );
    }
  }
  // The stem's head and its cutwater above the boot top.
  const path: Vec3[] = [];
  for (let i = 0; i <= 12; i++) {
    const u = lerp(U_FORE + (1 - U_FORE) * 0.35, 1, i / 12);
    path.push([0, keelY(u), zAt(u) - 0.02]);
  }
  black.tube(
    path.filter((p) => p[1] > BOOT_TO),
    [0.1],
    5,
  );
  return { wood, black, iron };
}

// --- The pennant -------------------------------------------------------------------

/** The pennant at the main truck: its length and its width at the staff. */
const PENNANT_LENGTH = 4.5;
const PENNANT_WIDTH = 0.36;
const PENNANT_SEGMENTS = 16;
const PENNANT_STAFF = 0.6;

/**
 * The pennant, at the top of its staff on the main truck: a long tapered
 * strip, at rest streaming aft, level, from the staff. TEXCOORD_1.x is the
 * fraction along it, from which the client streams and flutters it.
 */
function pennant(): MeshBuilder {
  const m = new MeshBuilder('bunting');
  const top: number[] = [];
  const bottom: number[] = [];
  for (let i = 0; i <= PENNANT_SEGMENTS; i++) {
    const f = i / PENNANT_SEGMENTS;
    const half = (PENNANT_WIDTH / 2) * (1 - 0.9 * f);
    for (const [row, y] of [
      [top, half],
      [bottom, -half],
    ] as [number[], number][]) {
      const k = m.vertex([0, y, f * PENNANT_LENGTH], [1, 1, 1], [f, y > 0 ? 1 : 0], [f, 0]);
      m.normal(k, [1, 0, 0]);
      row.push(k);
    }
  }
  m.strip(bottom, top, true);
  return m;
}

// --- The hull's volume -------------------------------------------------------
//
// The sea is not drawn inside a hull. The game keeps it out with a volume it
// can test a point against cheaply: stations along the hull, each with the
// half-beam at the waterline and the depth of the bottom, the sides between
// narrowing below the waterline as a superellipse does. They are measured
// here from the hull's own mesh, so the volume cannot drift from the model.

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
 * The hull's volume, measured from its mesh: stations from where the run
 * leaves the water to where the stem does, each [z, half-beam at the
 * waterline, depth of the bottom], and the exponent of the sections'
 * narrowing below the waterline.
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

/**
 * The hull as a solid, for what keeps a sailor out of it: stations from the
 * transom to the stem, each [z, half-beam at the widest, the rail's height,
 * the keel's depth], as superellipses of the exponent; and the quarterdeck
 * the helmsman stands on, a box open above its floor between the bulwarks.
 */
function solid(): Record<string, unknown> {
  const u = uAt(SAILOR_Z);
  return {
    stations: Array.from({ length: 21 }, (_, i) => {
      const s = i / 20;
      return [round4(zAt(s)), round4(halfBeam(s)), round4(railAt(s)), round4(-keelY(s))];
    }),
    exponent: 2.4,
    cockpit: {
      fore: round4(QD_FORE_Z),
      aft: round4(TRANSOM_Z - BULWARK_T),
      halfWidth: round4(deckHalf(u, QUARTERDECK)),
      floor: round4(SAILOR_Y),
    },
  };
}

// --- The model ---------------------------------------------------------------

/** Every builder of one material merged, as one primitive. */
function merge(material: string, parts: MeshBuilder[]): MeshBuilder {
  const m = new MeshBuilder(material);
  for (const p of parts) {
    if (p.material !== material) {
      throw new Error(`merging ${p.material} into ${material}`);
    }
    m.append(p);
  }
  return m;
}

/** A node's primitives from builders, those with no triangles left out. */
const prims = (parts: [MeshBuilder, boolean][]) =>
  parts.filter(([m]) => m.indices.length > 0).map(([m, colors]) => m.primitive({ colors }));

/** A mesh's area: its triangles', in square metres. */
function area(m: MeshBuilder): number {
  const p = m.positions;
  let sum = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => {
      const j = (m.indices[i + k] ?? 0) * 3;
      return [p[j] ?? 0, p[j + 1] ?? 0, p[j + 2] ?? 0] as Vec3;
    }) as [Vec3, Vec3, Vec3];
    const n = cross(sub(b, a), sub(c, a));
    sum += Math.hypot(n[0], n[1], n[2]) / 2;
  }
  return sum;
}

/** Fails unless each group's sails, as built, have the catalog's area within 1%. */
function checkAreas(groups: [string, number, MeshBuilder[]][]): string {
  return groups
    .map(([name, want, meshes]) => {
      const got = meshes.reduce((s, m) => s + area(m), 0);
      if (Math.abs(got - want) > 0.01 * want) {
        throw new Error(`the ${name} have ${got.toFixed(1)} m² of sail, the catalog ${want} m²`);
      }
      return `${name} ${got.toFixed(1)} m²`;
    })
    .join(', ');
}

/** The gallery's sill and head, as the name places them: computed from the near model's topsides. */
let GALLERY: Gallery | null = null;
/** The sails' areas as built, for the record. */
let AREAS = '';

/** The ship's nodes at the detail in force. */
function model(): NodeDef[] {
  const shell = planking();
  const shellAll = new MeshBuilder('paint');
  shellAll.append(shell.copper);
  shellAll.append(shell.paint);
  shellAll.append(shell.topsides);
  shellAll.append(shell.gilt);
  const waterline = hullVolume(shellAll);
  if (GALLERY === null) {
    const name = namePlace(shell.topsides);
    const sill = name.y + name.height / 2 + 0.22;
    GALLERY = { sill, head: Math.min(sill + 1.0, levelAt(0, QUARTERDECK) - 0.2) };
  }
  const walls = bulwarks();
  const breakParts = breaks();
  const deckMesh = decks();
  const sprit = bowsprit();
  const gal = gallery(GALLERY);
  const hullParts: [MeshBuilder, boolean][] = [
    [shell.copper, true],
    [shell.paint, true],
    [shell.topsides, true],
    [shell.gilt, true],
    [deckMesh, true],
    [merge('paint', [walls.inner, breakParts.paint]), true],
    [merge('rail', [walls.rail, breakParts.rail]), true],
    [sprit.spar, false],
    [sprit.black, false],
    [gal.gilt, false],
  ];
  // The masts, each its own node; their shrouds' deadeyes, lanyards, chains and channels are the hull's.
  const masts: [Mast, string, number, [number, number]][] = [
    [FORE, 'foremast', 5, [-1.0, 3.2]],
    [MAIN, 'mainmast', 5, [-1.0, 3.6]],
    [MIZZEN, 'mast', 3, [-0.6, 2.2]],
  ];
  const mastNodes: NodeDef[] = [];
  const hullRope = new MeshBuilder('rope');
  const hullWood = new MeshBuilder('blackwood');
  const hullIron = new MeshBuilder('iron');
  for (const [m, name, count, [z0, z1]] of masts) {
    const s = mastSpars(m);
    const parts: [MeshBuilder, boolean][] = [
      [s.spar, false],
      [s.black, false],
      [s.iron, false],
    ];
    if (D.small) {
      const r = shrouds(m, count, channelOf(m, z0, z1));
      parts.push([r.rope, false]);
      hullRope.append(r.hull.rope);
      hullIron.append(r.hull.iron);
      hullWood.append(r.hull.black);
      // The deadeyes: those on the channels are in the ship's frame, those
      // at the tops' rims in the mast's frame.
      hullWood.append(r.hull.wood);
    }
    mastNodes.push({ name, translation: [0, 0, m.z], primitives: prims(parts) });
  }
  if (D.small) {
    hullRope.append(stays());
    hullRope.append(sprit.rope);
    const f = fittings();
    const boatParts = longboat();
    const h = helm();
    hullParts.push(
      [hullRope, false],
      [merge('blackwood', [hullWood, f.black]), false],
      [merge('iron', [hullIron, f.iron]), false],
      [merge('varnish', [f.wood, boatParts.wood, h.wood]), true],
      [boatParts.paint, true],
      [h.brass, false],
    );
  }
  const yardsNodes: NodeDef[] = [];
  const foreYards = squareYards(FORE, 'fore', 'fore', square.squareForeArea, square.squareForeArea);
  const mainYards = squareYards(MAIN, 'main', 'after', MAIN_AREA, square.squareAfterArea);
  const mizzenYardsOut = mizzenYards();
  const sailMesh = gaffSail();
  const headsailMeshes = [headsailMesh(JIB), headsailMesh(STAYSAIL)];
  const spritsail = squareSail({
    name: 'spritsail',
    head: 0,
    foot: -SPRITSAIL_DEPTH,
    headW: SPRITSAIL_HEAD,
    footW: SPRITSAIL_FOOT,
    z: 0,
    rows: D.courseRows / 2,
    at: [],
    extras: {},
  });
  if (D === NEAR) {
    AREAS = checkAreas([
      ['fore square sails', square.squareForeArea, foreYards.meshes],
      [
        'after square sails',
        square.squareAfterArea,
        [...mainYards.meshes, ...mizzenYardsOut.meshes],
      ],
      ['mizzen', rig.sailArea, [sailMesh]],
      ['headsails', headsails.headsailArea, [...headsailMeshes, spritsail]],
    ]);
  }
  for (const [name, m, y] of [
    ['fore', FORE, foreYards],
    ['main', MAIN, mainYards],
    ['mizzen', MIZZEN, mizzenYardsOut],
  ] as [string, Mast, YardsOut][]) {
    if (name === 'main') {
      const topsail = y.sails.find((s) => s.name === 'main-topsail');
      if (topsail !== undefined) {
        topsail.extras = { ...topsail.extras, number: true };
      }
    }
    yardsNodes.push({
      name: `${name}-yards`,
      translation: [0, FOOT_Y, m.z],
      primitives: prims([
        [y.spar, false],
        [y.black, false],
        [y.rope, false],
      ]),
      children: [y.topsailYard, ...y.sails],
    });
  }
  const boomParts = boomSpar();
  const gaffParts = gaffSpar();
  const rudderParts = rudder();
  const wheelParts = wheel();
  const headsailNode = (h: Headsail, m: MeshBuilder): NodeDef => ({
    name: h.name,
    translation: sub(h.tack, TACK),
    extras: { rake: round5(h.rake) },
    primitives: [m.primitive({ uvs2: true })],
  });
  const nodes: NodeDef[] = [
    {
      name: 'hull',
      primitives: prims(hullParts),
      extras: {
        waterline,
        // The outline is her plan at her widest, below her rail.
        plan: { deviation: planDeviation(), widest: true },
        solid: solid(),
        name: { on: 'transom' },
      },
      children: mastNodes.filter((n) => n.name !== 'mast'),
    },
    ...mastNodes.filter((n) => n.name === 'mast'),
    {
      name: 'boom',
      translation: [0, rig.boomHeight, MIZZEN_Z],
      primitives: prims([
        [boomParts.spar, false],
        [boomParts.black, false],
      ]),
      children: [
        {
          name: 'gaff',
          translation: [0, THROAT_PT[1], 0],
          extras: { peak: round5(PEAK), length: round5(GAFF) },
          primitives: prims([
            [gaffParts.spar, false],
            [gaffParts.black, false],
          ]),
        },
      ],
    },
    {
      name: 'sail',
      translation: [0, rig.boomHeight, MIZZEN_Z],
      primitives: [sailMesh.primitive({ uvs2: true })],
    },
    // The headsails, about the tack the physics gives them, each at its own.
    {
      name: 'jib',
      translation: TACK,
      children: [
        headsailNode(JIB, headsailMeshes[0] as MeshBuilder),
        headsailNode(STAYSAIL, headsailMeshes[1] as MeshBuilder),
        {
          name: 'spritsail',
          translation: sub(SPRITSAIL_YARD, TACK),
          extras: { spritsail: true },
          primitives: [spritsail.primitive()],
        },
      ],
    },
    ...yardsNodes,
  ];
  if (D.small) {
    nodes.push(
      {
        name: 'telltales',
        translation: [0, rig.boomHeight, MIZZEN_Z],
        primitives: [
          telltales({ luff: rig.luff, footStrip: rig.footStrip, headStrip: rig.headStrip }, (v) =>
            gaffChord(v),
          ).primitive({ uvs2: true, colors: true }),
        ],
      },
      {
        name: 'pennant',
        translation: [0, MAIN.truck + 0.12 + PENNANT_STAFF - PENNANT_WIDTH / 2, MAIN_Z],
        primitives: [pennant().primitive({ uvs2: true })],
      },
    );
    for (const s of [-1, 1]) {
      const l = sidelight(s);
      nodes.push({
        name: s < 0 ? 'port' : 'starboard',
        translation: sidelightAt(s),
        primitives: prims([
          [l.brass, false],
          [l.glass, true],
          [l.board, true],
        ]),
      });
    }
    const st = sternlight();
    nodes.push({
      name: 'stern',
      translation: STERNLIGHT,
      primitives: prims([
        [st.brass, false],
        [st.glass, true],
        [st.iron, false],
      ]),
    });
  }
  nodes.push(
    {
      name: 'gallery',
      primitives: [gal.panes.primitive({ colors: true })],
    },
    {
      name: 'wheel',
      translation: [0, WHEEL_Y, WHEEL_Z],
      extras: { wheel: { radius: WHEEL_RADIUS, spokes: WHEEL_SPOKES, handles: WHEEL_HANDLE } },
      primitives: prims([
        [wheelParts.wood, true],
        [wheelParts.brass, false],
      ]),
    },
    {
      name: 'rudder',
      translation: [0, 0, foils.rudderPosition],
      primitives: prims([
        [rudderParts.copper, true],
        [rudderParts.paint, true],
        [rudderParts.iron, false],
      ]),
      children: [
        {
          name: 'tiller',
          translation: [0, TILLER_Y, 0],
          primitives: [tiller().primitive({ colors: true })],
        },
      ],
    },
    // The keel, fixed, and the deadwood and gripe beyond its chord.
    {
      name: 'daggerboard',
      translation: [0, 0, -foils.boardPosition],
      primitives: [keel().primitive({ colors: true })],
      children: [{ name: 'deadwood', primitives: [deadwood().primitive({ colors: true })] }],
    },
    // Where the helmsman stands: between his feet on the quarterdeck, facing forward.
    { name: 'sailor', translation: [0, SAILOR_Y, SAILOR_Z] },
    // The hull's side at its widest at the helm's station, and where the keel leaves the bottom.
    {
      name: 'gunwale',
      translation: [halfBeam(uAt(SAILOR_Z)), wideY(uAt(SAILOR_Z)), SAILOR_Z],
    },
    {
      name: 'board-root',
      translation: [0, keelY(uAt(-foils.boardPosition)), -foils.boardPosition],
    },
    company(),
  );
  return nodes;
}

// --- The ship's company's places -------------------------------------------------

/** Where the quarterdeck's rail is leant on, and where the main brace leads to it, on the starboard side. */
const RAIL_Z = 7.6;
const BRACE_Z = 11.0;
/** The main brace's fall: from its lead this far forward along the deck and this far inboard, at the lead's height. */
const BRACE_FALL: [number, number] = [2.6, 0.35];

/** The cap rail's inner edge, on its top, at z on the starboard side. */
function railTop(z: number): Vec3 {
  const u = uAt(z);
  const y = railAt(u);
  return [round5(Math.max(0, breadth(u, y - 0.001) - BULWARK_T - 0.04)), round5(y), z];
}

const round3v = (p: Vec3): Vec3 => [round5(p[0]), round5(p[1]), round5(p[2])];

/**
 * Where the ship's company stands, sits, climbs, hauls and lies out, as the
 * sailors' clips are made against: the starboard side's (the port's the
 * mirror), in the ship's frame but for the yard's, which is in its node's.
 * The quarterdeck's rail (the cap's inner edge on its top); the fore hatch's
 * forward edge on its grating, on the centreline, and half its breadth; the
 * quarterdeck's ladder at its break (its foot, its head, its rises, half its
 * width); the main lower shrouds (each from under the top to its deadeye),
 * the lowest and highest heights of their ratlines' range and how far apart
 * they are; the main futtock shrouds (each from the top's rim down to its
 * band) and topmast shrouds (each from the topmast's head down to the rim);
 * the main top (its floor's middle, half its breadth, how far it reaches
 * forward and aft); the main topsail yard's node, its radius and its
 * footrope's points from the middle out; and the main brace's lead on the
 * quarterdeck's rail and a point along its fall.
 */
function company(): NodeDef {
  const ladder = ladderAt(U_QD, QUARTERDECK, -1, 1);
  const channel = channelOf(MAIN, -1.0, 3.6);
  const [from, to] = lowerRatlines(MAIN, channel);
  const inShip = (p: Vec3): Vec3 => round3v([p[0], p[1], p[2] + MAIN.z]);
  const width = sailWidth(MAIN_AREA);
  const topsail = { y: TOPSAIL_YARD_Y + 0.15, r: 0.15, half: (TOPSAIL_HEAD_W * width) / 2 + 0.7 };
  const [hatchZ, hatchHalf] = HATCHES[1] as [number, number];
  const lead = railTop(BRACE_Z);
  return {
    name: 'company',
    extras: {
      rail: railTop(RAIL_Z),
      hatch: {
        edge: round3v([
          0,
          deckSurface(0, uAt(hatchZ), WAIST, 1) + HATCH_HEIGHT + GRATING,
          hatchZ - hatchHalf,
        ]),
        half: hatchHalf,
      },
      ladder: {
        foot: round3v(ladder.foot),
        head: round3v(ladder.head),
        steps: ladder.steps,
        half: LADDER_HALF,
      },
      shrouds: lowerShrouds(MAIN, 5, channel, 1).map(([a, b]) => [round3v(a), round3v(b)]),
      ratlines: { from: round5(from), to: round5(to), every: RATLINE_EVERY },
      futtocks: futtockShrouds(MAIN, 1).map(([a, b]) => [inShip(a), inShip(b)]),
      topmast: topmastShrouds(MAIN, 1).map(([a, b]) => [inShip(a), inShip(b)]),
      top: {
        floor: round3v([0, MAIN.top, MAIN.z]),
        half: MAIN.topHalf,
        fore: MAIN.topFore,
        aft: MAIN.topAft,
      },
      yard: {
        node: 'main-topsail-yard',
        radius: topsail.r,
        footrope: footrope(0, 0, topsail.half, 1).map(round3v),
      },
      brace: { lead, fall: round3v([lead[0] - BRACE_FALL[1], lead[1], lead[2] - BRACE_FALL[0]]) },
    },
  };
}

for (const name of boat.lights) {
  if (!['port', 'starboard', 'stern'].includes(name)) {
    throw new Error(`the tall ship's model has no lantern for the light ${name}`);
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
    `masts at ${[FORE_Z, MAIN_Z, MIZZEN_Z].map((z) => z.toFixed(2)).join(', ')} m, ` +
    `quarterdeck ${QD_RISE.toFixed(2)} m above the waist; ${AREAS}\n`,
);

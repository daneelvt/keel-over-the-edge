// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The Jolly boat: a single-handed dinghy built by a shipwright of the
// period. A clinker-planked hull of varnished timber with a laid deck and a
// cockpit, a varnished spruce mast and boom, a cream flax sail, a
// daggerboard and a rudder with its tiller, and bronze fittings.
//
// Every dimension the physics knows comes from the catalog, so what is
// drawn is what is sailed: length and beam, the mast's place, the boom's
// height, the sail's luff and foot, the board's and rudder's places and
// spans. The rest (sheer, rocker, section shape, planking) are this
// script's own.
//
//   node art/boats/jolly-boat/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { MeshBuilder, srgb, type Vec3 } from '../../lib/mesh.ts';

/** The model this script writes, as the catalog's art.model names it. */
const MODEL = 'boats/jolly-boat.glb';

interface CatalogBoat {
  lengthOverall: number;
  beam: number;
  art: { model: string };
  physics: {
    hull: { hullDraught: number; centreOfGravity: number };
    rig: {
      luff: number;
      foot: number;
      boomHeight: number;
      mastPosition: number;
      footStrip: number;
      headStrip: number;
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
if (boat === undefined) {
  throw new Error(`no boat in the catalog has the model ${MODEL}`);
}
const { hull, rig, foils, sailor } = boat.physics;

// --- The hull's lines -------------------------------------------------------
//
// The boat's frame: origin at the centre of gravity's station on the
// centreline at the waterline; x to starboard, y up, z aft (the bow is -z).

const L = boat.lengthOverall;
const HALF_BEAM = boat.beam / 2;
/** The transom, just forward of the rudder's stock, and the stem. */
const TRANSOM_Z = foils.rudderPosition - 0.1;
const BOW_Z = TRANSOM_Z - L;

/** Station u runs from the transom (0) to the stem (1). */
const zAt = (u: number): number => TRANSOM_Z - u * L;
const uAt = (z: number): number => (TRANSOM_Z - z) / L;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of the sheer above the waterline: low, rising toward the bow. */
const sheer = (u: number): number => 0.3 + 0.09 * u * u;

/** Half the beam at the sheer: a wide transom, the greatest beam aft of amidships, a full bow. */
function halfBeam(u: number): number {
  if (u <= 0.4) {
    return HALF_BEAM * (0.76 + 0.24 * Math.sin(((Math.PI / 2) * u) / 0.4));
  }
  const t = (u - 0.4) / 0.6;
  return HALF_BEAM * Math.max(0, 1 - t ** 2.1) ** 0.62;
}

/** Depth of the keel line below the waterline: a gentle rocker, rising to the sheer at the stem. */
function keelDepth(u: number): number {
  const rocker = hull.hullDraught * (1 - ((u - 0.45) / 0.55) ** 2);
  return rocker - (sheer(u) + rocker) * smoothstep(0.7, 1, u) ** 2;
}

/** The section's exponent: above 2, a flat bottom and slack bilges turning to upright topsides. */
const SECTION = 2.4;

/** A point on the starboard half-section at station u, girth fraction g (0 at the keel, 1 at the sheer). */
function section(u: number, g: number): Vec3 {
  const a = (g * Math.PI) / 2;
  const e = 2 / SECTION;
  const d = keelDepth(u);
  return [halfBeam(u) * Math.sin(a) ** e, -d + (sheer(u) + d) * (1 - Math.cos(a) ** e), zAt(u)];
}

/** The outward normal of the half-section at u, g, in its plane. */
function sectionNormal(u: number, g: number): Vec3 {
  const h = 1e-4;
  const a = section(u, Math.max(0, g - h));
  const b = section(u, Math.min(1, g + h));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l, 0];
}

const STATIONS = 56;
const stations = Array.from({ length: STATIONS + 1 }, (_, i) => i / STATIONS);

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'timber', color: [1, 1, 1], roughness: 0.32, metalness: 0 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.45, metalness: 0 },
  { name: 'spar', color: srgb(0.8, 0.6, 0.34), roughness: 0.35, metalness: 0 },
  { name: 'flax', color: srgb(0.93, 0.89, 0.78), roughness: 0.85, metalness: 0, doubleSided: true },
  { name: 'bronze', color: srgb(0.74, 0.5, 0.24), roughness: 0.35, metalness: 0.9 },
  { name: 'rope', color: srgb(0.3, 0.22, 0.14), roughness: 0.9, metalness: 0 },
  { name: 'foil', color: srgb(0.5, 0.3, 0.14), roughness: 0.35, metalness: 0 },
  {
    name: 'bunting',
    color: srgb(0.72, 0.12, 0.1),
    roughness: 0.8,
    metalness: 0,
    doubleSided: true,
  },
  { name: 'wool', color: [1, 1, 1], roughness: 0.9, metalness: 0, doubleSided: true },
];

/** A fixed pseudo-random number in [0, 1) for an integer. */
const jitter = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
};

// --- The planking ------------------------------------------------------------

/** The strakes' edges as girth fractions, keel to sheer. */
const STRAKES = [0, 0.16, 0.32, 0.47, 0.61, 0.74, 0.87, 1];
/** How far each plank's lower edge stands out over the plank below, in metres. */
const LAP = 0.014;
const TIMBER = srgb(0.68, 0.42, 0.2);

function planking(): MeshBuilder {
  const side = new MeshBuilder('timber');
  for (let k = 0; k + 1 < STRAKES.length; k++) {
    const g0 = STRAKES[k] as number;
    const g1 = STRAKES[k + 1] as number;
    const tone = 0.9 + 0.2 * jitter(k);
    const rows: number[][] = [[], [], []];
    const land: number[][] = [[], []];
    stations.forEach((u, i) => {
      // A little grain along the plank.
      const grain = tone * (0.96 + 0.08 * jitter(k * 100 + i));
      const c: Vec3 = [TIMBER[0] * grain, TIMBER[1] * grain, TIMBER[2] * grain];
      [0, 0.5, 1].forEach((s, r) => {
        const g = g0 + (g1 - g0) * s;
        const p = section(u, g);
        const n = sectionNormal(u, g);
        // The garboard meets the keel flush; every other plank laps the one below.
        const lap = k === 0 ? 0 : LAP * (1 - s) ** 0.8;
        const v = side.vertex([p[0] + n[0] * lap, p[1] + n[1] * lap, p[2]], c, [s, u]);
        (rows[r] as number[]).push(v);
      });
      if (k > 0) {
        // The land: the plank's lower edge, a narrow face looking down toward the keel.
        const p = section(u, g0);
        const n = sectionNormal(u, g0);
        const down: Vec3 = [n[1], -n[0], 0];
        const dark: Vec3 = [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35];
        const a = side.vertex(p, dark);
        const b = side.vertex([p[0] + n[0] * LAP, p[1] + n[1] * LAP, p[2]], dark);
        side.normal(a, down);
        side.normal(b, down);
        (land[0] as number[]).push(a);
        (land[1] as number[]).push(b);
      }
    });
    // Rows run from the transom forward (-z), girth upward: seen from
    // outside that is counter-clockwise.
    side.strip(rows[0] as number[], rows[1] as number[]);
    side.strip(rows[1] as number[], rows[2] as number[]);
    if (k > 0) {
      side.strip(land[0] as number[], land[1] as number[]);
    }
  }
  const both = new MeshBuilder('timber');
  both.append(side);
  both.append(side, true);
  return both;
}

function transom(): MeshBuilder {
  const m = new MeshBuilder('timber');
  const c: Vec3 = [TIMBER[0] * 0.8, TIMBER[1] * 0.8, TIMBER[2] * 0.8];
  const ring: number[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const p = section(0, i / n);
    ring.push(m.vertex([p[0] + LAP, p[1], p[2]], c));
  }
  for (let i = n; i >= 0; i--) {
    const p = section(0, i / n);
    ring.push(m.vertex([-p[0] - LAP, p[1], p[2]], c));
  }
  const mid = m.vertex([0, (sheer(0) - keelDepth(0)) / 2, TRANSOM_Z], c);
  for (const k of [...ring, mid]) {
    m.normal(k, [0, 0, 1]);
  }
  for (let i = 0; i + 1 < ring.length; i++) {
    m.triFacing(mid, ring[i] as number, ring[i + 1] as number, [0, 0, 1]);
  }
  return m;
}

// --- The deck and cockpit ----------------------------------------------------

const CROWN = 0.025;
/** The deck's height at (x, u). */
const deckY = (x: number, u: number): number => {
  const b = halfBeam(u);
  const t = b > 1e-6 ? Math.min(1, Math.abs(x) / b) : 1;
  return sheer(u) + CROWN * (1 - t * t) * (b / HALF_BEAM);
};

/** The deck's planks run fore and aft, PLANK wide; the cockpit spans the middle five. */
const PLANK = 0.11;
const COCKPIT_HALF_WIDTH = 2.5 * PLANK;
const COCKPIT_FORE = -foils.boardPosition + 0.2;
const COCKPIT_AFT = COCKPIT_FORE + 1.5;
const COCKPIT_FLOOR = 0.12;
const DECK = srgb(0.8, 0.62, 0.4);

function deck(): MeshBuilder {
  const m = new MeshBuilder('deck');
  const us = [...stations, uAt(COCKPIT_FORE), uAt(COCKPIT_AFT)].sort((a, b) => a - b);
  const planks = Math.ceil(HALF_BEAM / PLANK - 0.5);
  for (let j = -planks; j <= planks; j++) {
    const x0 = (j - 0.5) * PLANK;
    const x1 = (j + 0.5) * PLANK;
    const tone = 0.88 + 0.22 * jitter(j + 50);
    const c: Vec3 = [DECK[0] * tone, DECK[1] * tone, DECK[2] * tone];
    const seam: Vec3 = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
    let prev: number[] | null = null;
    for (const u of us) {
      const b = halfBeam(u);
      const lo = Math.max(x0, -b);
      const hi = Math.min(x1, b);
      const z = zAt(u);
      const inCockpit =
        Math.abs((x0 + x1) / 2) < COCKPIT_HALF_WIDTH &&
        z > COCKPIT_FORE + 1e-6 &&
        z < COCKPIT_AFT - 1e-6;
      if (hi - lo < 1e-4) {
        prev = null;
        continue;
      }
      // A dark caulked seam along each plank's edge.
      const w = Math.min(0.006, (hi - lo) / 4);
      const xs = [lo, lo + w, hi - w, hi];
      const cs = [seam, c, c, seam];
      const row = xs.map((x, i) => m.vertex([x, deckY(x, u), z], cs[i] as Vec3, [x, u]));
      // Rows run aft to fore (-z), columns port to starboard (+x): seen
      // from above, counter-clockwise.
      if (prev !== null && !inCockpit) {
        m.strip(prev, row);
      }
      prev = inCockpit ? null : row;
    }
  }
  return m;
}

function cockpit(m: MeshBuilder): void {
  const c: Vec3 = [DECK[0] * 0.75, DECK[1] * 0.75, DECK[2] * 0.75];
  const w = COCKPIT_HALF_WIDTH;
  const f = COCKPIT_FORE;
  const a = COCKPIT_AFT;
  const y = COCKPIT_FLOOR;
  const quad = (p: Vec3[], n: Vec3): void => {
    const k = p.map((q) => {
      const i = m.vertex(q, c);
      m.normal(i, n);
      return i;
    });
    m.triFacing(k[0] as number, k[1] as number, k[2] as number, n);
    m.triFacing(k[0] as number, k[2] as number, k[3] as number, n);
  };
  const top = (x: number, z: number): number => deckY(x, uAt(z));
  quad(
    [
      [-w, y, f],
      [w, y, f],
      [w, y, a],
      [-w, y, a],
    ],
    [0, 1, 0],
  );
  quad(
    [
      [-w, y, f],
      [w, y, f],
      [w, top(w, f), f],
      [-w, top(-w, f), f],
    ],
    [0, 0, 1],
  );
  quad(
    [
      [-w, y, a],
      [w, y, a],
      [w, top(w, a), a],
      [-w, top(-w, a), a],
    ],
    [0, 0, -1],
  );
  quad(
    [
      [w, y, f],
      [w, y, a],
      [w, top(w, a), a],
      [w, top(w, f), f],
    ],
    [-1, 0, 0],
  );
  quad(
    [
      [-w, y, f],
      [-w, y, a],
      [-w, top(-w, a), a],
      [-w, top(-w, f), f],
    ],
    [1, 0, 0],
  );
}

function rubrails(m: MeshBuilder): void {
  const c: Vec3 = [TIMBER[0] * 0.6, TIMBER[1] * 0.6, TIMBER[2] * 0.6];
  for (const s of [1, -1]) {
    const path: Vec3[] = stations
      .filter((u) => u < 0.985)
      .map((u) => [s * (halfBeam(u) + 0.006), sheer(u) - 0.012, zAt(u)]);
    m.tube(path, [0.017], 6, c);
  }
}

// --- Spars, sail and foils -----------------------------------------------------

const MAST_Z = -rig.mastPosition;
const mastFootY = deckY(0, uAt(MAST_Z));
const MAST_TOP = rig.boomHeight + rig.luff + 0.1;

function mast(): MeshBuilder {
  const m = new MeshBuilder('spar');
  const n = 8;
  const path: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    path.push([0, mastFootY - 0.02 + t * (MAST_TOP - mastFootY + 0.02), 0]);
    radii.push(0.04 - 0.015 * t * t);
  }
  m.tube(path, radii, 12);
  return m;
}

function boom(): MeshBuilder {
  const m = new MeshBuilder('spar');
  m.tube(
    [
      [0, 0, 0.03],
      [0, 0, rig.foot + 0.08],
    ],
    [0.026],
    10,
  );
  return m;
}

/** The kicking strap, from the boom down to the mast's foot: it swings with the boom. */
function vang(): MeshBuilder {
  const m = new MeshBuilder('rope');
  m.tube(
    [
      [0, -0.03, 0.4],
      [0, mastFootY + 0.08 - rig.boomHeight, 0.05],
    ],
    [0.008],
    5,
  );
  return m;
}

const ROACH = 0.2;
const SAIL_ROWS = 24;
const SAIL_COLS = 10;

/**
 * The sail, flat in the centreline plane at rest: the luff up the mast's
 * after face, the foot along the boom. TEXCOORD_0 maps the sail cloth (the
 * distance along the foot over the foot's length, and the height up the
 * luff); TEXCOORD_1 is (u, v), the fraction of the chord and of the luff,
 * from which the client shapes it (boom angle, twist, camber).
 */
function sail(): MeshBuilder {
  const m = new MeshBuilder('flax');
  const rows: number[][] = [];
  for (let i = 0; i <= SAIL_ROWS; i++) {
    const v = i / SAIL_ROWS;
    const chord = chordAt(v);
    const row: number[] = [];
    for (let j = 0; j <= SAIL_COLS; j++) {
      const u = j / SAIL_COLS;
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
  for (let i = 0; i < SAIL_ROWS; i++) {
    m.strip(rows[i] as number[], rows[i + 1] as number[], true);
  }
  return m;
}

/** The sail's chord at fraction v up the luff, as sail() draws it. */
const chordAt = (v: number): number =>
  rig.foot * (1 - v) + ROACH * Math.sin(Math.PI * v) * (1 - v) ** 0.3;

/** The pennant's length and its width at the staff, in metres. */
const PENNANT_LENGTH = 0.45;
const PENNANT_WIDTH = 0.07;
const PENNANT_SEGMENTS = 16;

/**
 * The pennant at the masthead: a narrow tapered strip, at rest streaming
 * aft, level, from its staff. TEXCOORD_1.x is the fraction along it, from
 * which the client streams it downwind of the apparent wind and flutters it.
 */
function pennant(): MeshBuilder {
  const m = new MeshBuilder('bunting');
  const top: number[] = [];
  const bottom: number[] = [];
  for (let i = 0; i <= PENNANT_SEGMENTS; i++) {
    const f = i / PENNANT_SEGMENTS;
    const half = (PENNANT_WIDTH / 2) * (1 - 0.92 * f);
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

/** A telltale's length and width, in metres, and how far it stands off the cloth. */
const TELLTALE_LENGTH = 0.17;
const TELLTALE_WIDTH = 0.012;
const TELLTALE_OFFSET = 0.004;
const TELLTALE_SEGMENTS = 8;
/** Telltales on the port face are red, on the starboard face green, as sailmakers sew them. */
const PORT = srgb(0.72, 0.1, 0.1);
const STARBOARD = srgb(0.1, 0.5, 0.2);

/**
 * The telltales: a pair at the height of each strip's centre of effort, a
 * short way aft of the luff, one on each face. At rest each streams aft
 * along its face. TEXCOORD_0 is (fraction along the ribbon, ribbon index:
 * the strip × 2, plus 1 on the starboard face); TEXCOORD_1 is the root's
 * (fraction of the chord, fraction of the luff), from which the client
 * finds it on the shaped sail.
 */
function telltales(): MeshBuilder {
  const m = new MeshBuilder('wool');
  [rig.footStrip, rig.headStrip].forEach((height, strip) => {
    const fv = (height * rig.luff - 0.03) / rig.luff;
    const chord = chordAt(fv);
    const along = Math.min(0.35, 0.2 * chord);
    const fu = along / chord;
    for (const face of [-1, 1]) {
      const index = strip * 2 + (face > 0 ? 1 : 0);
      const colour = face > 0 ? STARBOARD : PORT;
      const upper: number[] = [];
      const lower: number[] = [];
      for (let i = 0; i <= TELLTALE_SEGMENTS; i++) {
        const f = i / TELLTALE_SEGMENTS;
        const z = 0.04 + along + f * TELLTALE_LENGTH;
        for (const [row, dy] of [
          [upper, TELLTALE_WIDTH / 2],
          [lower, -TELLTALE_WIDTH / 2],
        ] as [number[], number][]) {
          const k = m.vertex(
            [face * TELLTALE_OFFSET, height * rig.luff + dy, z],
            colour,
            [f, index],
            [fu, fv],
          );
          m.normal(k, [face, 0, 0]);
          row.push(k);
        }
      }
      m.strip(lower, upper, face < 0);
    }
  });
  return m;
}

/** A foil: a thin blade with rounded edges, between heights y0 and y1, its chord from z0 to z1. */
function blade(
  m: MeshBuilder,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  thick: number,
): void {
  const n = 10;
  const ring = (y: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= n * 2; i++) {
      // Around the section: an ellipse-ish foil, its leading edge at z0.
      const a = (i / (n * 2)) * 2 * Math.PI;
      const s = (1 - Math.cos(a)) / 2;
      const x = (thick / 2) * Math.sin(a) * (1 - 0.6 * s);
      const k = m.vertex([x, y, z0 + s * (z1 - z0)]);
      m.normal(k, [Math.sin(a), 0, -Math.cos(a) * 0.4]);
      out.push(k);
    }
    return out;
  };
  const bottom = ring(y0);
  const top = ring(y1);
  // The ring runs clockwise seen from above.
  m.strip(bottom, top, true);
  const cap = (r: number[], y: number, up: boolean): void => {
    const centre = m.vertex([0, y, (z0 + z1) / 2]);
    const n3: Vec3 = [0, up ? 1 : -1, 0];
    m.normal(centre, n3);
    for (let i = 0; i + 1 < r.length; i++) {
      m.triFacing(centre, r[i] as number, r[i + 1] as number, n3);
    }
  };
  cap(bottom, y0, false);
  cap(top, y1, true);
}

function daggerboard(): MeshBuilder {
  const m = new MeshBuilder('foil');
  const deckHere = deckY(0, uAt(-foils.boardPosition));
  blade(
    m,
    -(hull.hullDraught + foils.boardSpan),
    deckHere + 0.14,
    -foils.boardChord / 2,
    foils.boardChord / 2,
    0.024,
  );
  return m;
}

const RUDDER_HEAD = sheer(0) + 0.08;

function rudder(): MeshBuilder {
  const m = new MeshBuilder('foil');
  const lead = -0.07;
  blade(m, -(hull.hullDraught + foils.rudderSpan), -0.02, lead, lead + foils.rudderChord, 0.022);
  m.box([-0.03, -0.04, -0.09], [0.03, RUDDER_HEAD, 0.09]);
  return m;
}

function tiller(): MeshBuilder {
  const m = new MeshBuilder('spar');
  m.tube(
    [
      [0, 0, 0.02],
      [0, 0.03, -0.5],
      [0, 0.08, -1.05],
    ],
    [0.022, 0.019, 0.015],
    8,
  );
  return m;
}

function fittings(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  // The mast's collar at the deck.
  m.tube(
    [
      [0, mastFootY - 0.01, MAST_Z],
      [0, mastFootY + 0.05, MAST_Z],
    ],
    [0.05],
    12,
  );
  // The stem band.
  m.tube(
    [
      [0, sheer(0.97) - 0.06, zAt(0.995)],
      [0, sheer(1) + 0.01, zAt(1) + 0.004],
    ],
    [0.018],
    6,
  );
  // Pintles on the transom, the traveller's eyes, cleats on the cockpit's edge.
  for (const y of [0.0, sheer(0) - 0.05]) {
    m.box([-0.04, y - 0.015, TRANSOM_Z - 0.005], [0.04, y + 0.015, TRANSOM_Z + 0.1]);
  }
  for (const s of [1, -1]) {
    m.box(
      [s * 0.45 - 0.02, sheer(0) - 0.01, TRANSOM_Z - 0.12],
      [s * 0.45 + 0.02, sheer(0) + 0.04, TRANSOM_Z - 0.06],
    );
    const x = s * (COCKPIT_HALF_WIDTH + 0.06);
    const z = COCKPIT_FORE + 0.3;
    m.box([x - 0.015, deckY(x, uAt(z)), z - 0.06], [x + 0.015, deckY(x, uAt(z)) + 0.03, z + 0.06]);
  }
  return m;
}

function gooseneck(): MeshBuilder {
  const m = new MeshBuilder('bronze');
  m.box([-0.035, -0.035, -0.04], [0.035, 0.035, 0.06]);
  m.tube(
    [
      [0, 0, rig.foot + 0.06],
      [0, 0, rig.foot + 0.12],
    ],
    [0.03],
    8,
  );
  return m;
}

// --- The model ---------------------------------------------------------------

const hullMesh = planking();
hullMesh.append(transom());
const rails = new MeshBuilder('timber');
rails.append(hullMesh);
rubrails(rails);
const deckMesh = deck();
cockpit(deckMesh);

const nodes: NodeDef[] = [
  {
    name: 'hull',
    primitives: [
      rails.primitive({ colors: true }),
      deckMesh.primitive({ colors: true }),
      fittings().primitive(),
    ],
  },
  { name: 'mast', translation: [0, 0, MAST_Z], primitives: [mast().primitive()] },
  {
    name: 'boom',
    translation: [0, rig.boomHeight, MAST_Z],
    primitives: [boom().primitive(), gooseneck().primitive()],
    children: [{ name: 'vang', primitives: [vang().primitive()] }],
  },
  {
    name: 'sail',
    translation: [0, rig.boomHeight, MAST_Z],
    primitives: [sail().primitive({ uvs2: true })],
  },
  {
    name: 'telltales',
    translation: [0, rig.boomHeight, MAST_Z],
    primitives: [telltales().primitive({ uvs2: true, colors: true })],
  },
  {
    name: 'pennant',
    translation: [0, MAST_TOP, MAST_Z],
    primitives: [pennant().primitive({ uvs2: true })],
  },
  {
    name: 'rudder',
    translation: [0, 0, foils.rudderPosition],
    primitives: [rudder().primitive()],
    children: [
      {
        name: 'tiller',
        translation: [0, RUDDER_HEAD - 0.02, 0],
        primitives: [tiller().primitive()],
      },
    ],
  },
  {
    name: 'daggerboard',
    translation: [0, 0, -foils.boardPosition],
    primitives: [daggerboard().primitive()],
  },
  // Where the sailor sits: on the side deck by the cockpit, at the seated height.
  {
    name: 'sailor',
    translation: [0, hull.centreOfGravity + sailor.sailorSeatHeight, COCKPIT_FORE + 0.6],
  },
];

const raw = writeGlb([{ name: 'boat', children: nodes }], materials);
mkdirSync('.dev/art', { recursive: true });
writeFileSync('.dev/art/jolly-boat.raw.glb', raw);
execFileSync(
  'client/node_modules/.bin/gltfpack',
  ['-i', '.dev/art/jolly-boat.raw.glb', '-o', `art/${MODEL}`, '-c', '-kn', '-km', '-kv', '-noq'],
  { stdio: 'inherit' },
);
process.stdout.write(
  `wrote art/${MODEL}: bow ${BOW_Z.toFixed(2)} m, transom ${TRANSOM_Z.toFixed(2)} m\n`,
);

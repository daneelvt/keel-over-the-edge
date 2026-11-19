// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The race committee's things in the sea, in the period's materials:
//
// - committee-boat: a gaff cutter of about eleven metres lying at a single
//   anchor, her cable out over the stem, her mainsail furled on its boom
//   with the gaff lowered onto it. Carvel planked, her topsides blacked
//   with a gilt cove line under the sheer, a white boot top and a copper
//   bottom; a laid deck, a varnished skylight and companion, a long tiller.
//   Her mast of varnished spruce with crosstrees and a topmast, tarred
//   shrouds and stays; a bowsprit. Dressed overall: a line from the
//   bowsprit's end over the topmast's head to the boom's end, the signal
//   flags of the catalog bent on it one after another. On the foredeck a
//   small brass signal gun on an oak carriage, its muzzle to starboard,
//   away from the line. Her nodes: gun; muzzle, where the smoke leaves it;
//   halyard, the starboard crosstree's end, where the signals are hoisted;
//   hawse, where her cable leaves the stem; riding-light, her lantern on
//   the forestay.
// - cask-mark: a cask buoy painted madder red with blacked iron hoops, a
//   white spar through it of the catalog's height, a board on the spar for
//   the mark's number, a lantern on an arm near the top. Its nodes:
//   flag-staff, the spar's top, where its flag flies; lantern; number, the
//   board's middle, its faces square to x and z, face metres out.
// - pin-buoy: a smaller cask painted weld yellow with a shorter spar; its
//   nodes flag-staff and lantern.
// - beacon-spar: a tarred pole standing on the bottom with a white band at
//   the water and an iron cage for a topmark, as beacons on reefs were set.
//
// x to starboard, y up, z aft (the bow is -z); each origin on the waterline.
// The flags' designs and the mark's spar are the catalog's
// (world.committee), read from internal/catalog/catalog.gen.json.
//
//   node art/committee/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, writeGlb } from '../lib/gltf.ts';
import { add, MeshBuilder, normalize, scale, srgb, sub, type Vec3 } from '../lib/mesh.ts';

/** The model this script writes, as the catalog's world.committee.art.model names it. */
const MODEL = 'committee/committee.glb';

interface Flag {
  id: string;
  cut: 'flag' | 'pennant';
  rows: string[];
}
interface Committee {
  art: { model: string };
  mark: number;
  dyes: { letter: string; colour: string }[];
  flags: Flag[];
}
const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
  world: { committee: Committee };
};
const committee = catalog.world.committee;
if (committee.art.model !== MODEL) {
  throw new Error(`the catalog's committee names ${committee.art.model}, not ${MODEL}`);
}

/** A colour #rrggbb in linear light. */
function hex(h: string): Vec3 {
  const n = Number.parseInt(h.slice(1), 16);
  return srgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
const DYES = new Map(committee.dyes.map((d) => [d.letter, hex(d.colour)]));

// --- Materials ---------------------------------------------------------------

const materials: MaterialDef[] = [
  { name: 'paint', color: [1, 1, 1], roughness: 0.55, metalness: 0 },
  { name: 'copper', color: [1, 1, 1], roughness: 0.42, metalness: 0.75 },
  { name: 'deck', color: [1, 1, 1], roughness: 0.6, metalness: 0 },
  { name: 'varnish', color: [1, 1, 1], roughness: 0.3, metalness: 0 },
  { name: 'canvas', color: srgb(0.86, 0.82, 0.72), roughness: 0.85, metalness: 0 },
  { name: 'spar', color: srgb(0.82, 0.63, 0.36), roughness: 0.35, metalness: 0 },
  { name: 'iron', color: srgb(0.15, 0.15, 0.16), roughness: 0.5, metalness: 0.6 },
  { name: 'rope', color: srgb(0.18, 0.14, 0.1), roughness: 0.9, metalness: 0 },
  { name: 'tar', color: srgb(0.08, 0.07, 0.06), roughness: 0.7, metalness: 0 },
  { name: 'oak', color: srgb(0.42, 0.29, 0.17), roughness: 0.75, metalness: 0 },
  { name: 'wool', color: [1, 1, 1], roughness: 0.9, metalness: 0, doubleSided: true },
  { name: 'brass', color: srgb(0.8, 0.62, 0.26), roughness: 0.3, metalness: 0.9 },
  { name: 'glass', color: srgb(0.85, 0.8, 0.62), roughness: 0.15, metalness: 0 },
];

const BLACK = srgb(0.055, 0.05, 0.048);
const GILT = srgb(0.78, 0.6, 0.27);
const WHITE = srgb(0.9, 0.88, 0.82);
const COPPER = srgb(0.62, 0.38, 0.22);
const VERDIGRIS = srgb(0.36, 0.5, 0.42);
const DECK = srgb(0.78, 0.7, 0.55);
const TEAK = srgb(0.5, 0.3, 0.15);
const MADDER = hex('#a5312a');
const WELD = hex('#d6a332');

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.min(Math.max(v, a), b);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Points along a straight line, from a to b, n segments. */
function line(a: Vec3, b: Vec3, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(add(a, scale(sub(b, a), i / n)));
  }
  return out;
}

/** Points along a hanging line from a to b, sagging sag m at its middle. */
function sagging(a: Vec3, b: Vec3, sag: number, n: number): Vec3[] {
  return line(a, b, n).map((p, i) => {
    const t = i / n;
    return [p[0], p[1] - 4 * sag * t * (1 - t), p[2]];
  });
}

// --- The committee boat's hull -------------------------------------------------

/** Her length on deck, beam, and her stem and transom along z. */
const LENGTH = 10.6;
const BEAM = 3.3;
const STEM_Z = -LENGTH / 2;
const TRANSOM_Z = LENGTH / 2;
/** Her canoe body's depth below the waterline, and her keel's. */
const CANOE = 0.75;
const KEEL = 1.75;

/** The share of her length from the stem at z. */
const along = (z: number): number => (z - STEM_Z) / LENGTH;

/** Half her breadth at the sheer at t: fine forward, full aft, a transom of 0.6 of her beam. */
function halfBreadth(t: number): number {
  if (t < 0.45) {
    return (BEAM / 2) * Math.sin((Math.PI / 2) * (t / 0.45)) ** 0.75;
  }
  const s = (t - 0.45) / 0.55;
  return (BEAM / 2) * (1 - 0.4 * s * s);
}

/** Her sheer's height above the waterline at t: springing up to the bow, a little to the stern. */
function sheerAt(t: number): number {
  return 0.95 + 0.45 * (1 - t) ** 2.5 + 0.12 * t ** 3;
}

/** Her canoe body's depth at t, rising to the stem. */
function canoeAt(t: number): number {
  return CANOE * Math.sin((Math.PI / 2) * clamp(t / 0.3, 0, 1)) ** 0.6 * (1 - 0.35 * t * t);
}

/** Her keel's depth at t: the forefoot, the long keel, the raked sternpost. */
function keelAt(t: number): number {
  const fore = KEEL * smooth(0, 0.24, t);
  const post = t > 0.86 ? lerp(KEEL - 0.08, canoeAt(1) * 0.6, (t - 0.86) / 0.14) : KEEL;
  return Math.max(canoeAt(t), Math.min(fore, post - 0.08 * t));
}

/** Her section's rows at t, from the sheer down to the keel's foot, starboard side, and each band's colour and material below it. */
function sectionAt(t: number): Vec3[] {
  const hb = halfBreadth(t);
  const ys = sheerAt(t);
  const d = canoeAt(t);
  const k = keelAt(t);
  const z = STEM_Z + t * LENGTH;
  // At the stem the rows close on the centreline.
  const w = Math.max(0.06, 0.09 * smooth(0, 0.05, t));
  return [
    [hb, ys, z],
    [hb * 0.998, ys - 0.11, z],
    [hb * 0.97, 0.12, z],
    [hb * 0.955, -0.02, z],
    [hb * 0.72, -0.4 * d, z],
    [Math.min(w * 1.6, hb * 0.3), -d, z],
    [Math.min(w, hb * 0.2), -k, z],
  ];
}
const BANDS: [Vec3, string][] = [
  [GILT, 'paint'],
  [BLACK, 'paint'],
  [WHITE, 'paint'],
  [COPPER, 'copper'],
  [COPPER, 'copper'],
  [COPPER, 'copper'],
];

function hull(): MeshBuilder[] {
  const stations = 44;
  const ts = Array.from({ length: stations + 1 }, (_, i) => i / stations);
  const sections = ts.map(sectionAt);
  const out = new Map<string, MeshBuilder>();
  const builder = (m: string): MeshBuilder => {
    let b = out.get(m);
    if (b === undefined) {
      b = new MeshBuilder(m);
      out.set(m, b);
    }
    return b;
  };
  for (const side of [1, -1]) {
    BANDS.forEach(([colour, material], r) => {
      const b = builder(material);
      const upper: number[] = [];
      const lower: number[] = [];
      for (const s of sections) {
        const p = s[r] as Vec3;
        const q = s[r + 1] as Vec3;
        upper.push(b.vertex([p[0] * side, p[1], p[2]], colour));
        lower.push(b.vertex([q[0] * side, q[1], q[2]], colour));
      }
      // Rows run from the stem aft (+z): outward on the starboard side.
      b.strip(lower, upper, side < 0);
    });
    // The keel's foot: a flat strip from side to side.
  }
  const foot = builder('copper');
  const ps: number[] = [];
  const ss: number[] = [];
  for (const s of sections) {
    const k = s[6] as Vec3;
    ps.push(foot.vertex([-k[0], k[1], k[2]], VERDIGRIS));
    ss.push(foot.vertex([k[0], k[1], k[2]], VERDIGRIS));
  }
  foot.strip(ss, ps);
  // The transom: a fan from its middle, blacked.
  const tr = builder('paint');
  const last = sections[sections.length - 1] as Vec3[];
  const ring: Vec3[] = [...last.map((p) => [p[0], p[1], p[2]] as Vec3)];
  const back = [...ring].reverse().map((p) => [-p[0], p[1], p[2]] as Vec3);
  const rim = [...ring, ...back];
  const mid = tr.vertex([0, (sheerAt(1) - keelAt(1)) / 2, TRANSOM_Z], BLACK);
  tr.normal(mid, [0, 0, 1]);
  const ks = rim.map((p) => {
    const i = tr.vertex(p, BLACK);
    tr.normal(i, [0, 0, 1]);
    return i;
  });
  for (let i = 0; i < ks.length; i++) {
    tr.triFacing(mid, ks[i] as number, ks[(i + 1) % ks.length] as number, [0, 0, 1]);
  }
  // The deck: cambered, laid in planks of alternating tone.
  const deck = builder('deck');
  const rows: number[][] = [[], [], [], [], []];
  sections.forEach((s, i) => {
    const sh = s[0] as Vec3;
    const tone = i % 2 === 0 ? DECK : scale(DECK, 0.93);
    [-1, -0.5, 0, 0.5, 1].forEach((u, j) => {
      const camber = 0.07 * (1 - u * u);
      const k = deck.vertex([sh[0] * u, sh[1] + camber, sh[2]], tone);
      deck.normal(k, [0, 1, 0]);
      rows[j]?.push(k);
    });
  });
  for (let j = 0; j + 1 < rows.length; j++) {
    deck.strip(rows[j] as number[], rows[j + 1] as number[]);
  }
  // The cap rail, varnished, along each side's sheer.
  const rail = builder('varnish');
  for (const side of [1, -1]) {
    const path = sections.map((s) => {
      const p = s[0] as Vec3;
      return [p[0] * side * 0.985, p[1] + 0.05, p[2]] as Vec3;
    });
    rail.tube(path, [0.045], 4, TEAK);
  }
  return [...out.values()];
}

/** The deck's height at z, on the centreline. */
const deckAt = (z: number): number => sheerAt(along(z)) + 0.07;

// --- Her spars, rigging and sails ------------------------------------------------

const MAST_Z = -1.3;
const MAST_FOOT = deckAt(MAST_Z);
const HOUNDS = 9.6;
const CROSSTREES = 9.9;
const MAST_HEAD = 10.4;
const TOPMAST_HEAD = 13.6;
const BOWSPRIT_END: Vec3 = [0, 1.75, STEM_Z - 3.4];
const STEM_HEAD: Vec3 = [0, sheerAt(0) + 0.05, STEM_Z + 0.05];
const BOOM_END: Vec3 = [0, 2.35, TRANSOM_Z + 1.1];
/** The signal halyard's block: the starboard crosstree's end. */
const HALYARD: Vec3 = [0.95, CROSSTREES - 0.05, MAST_Z];

function spars(): MeshBuilder[] {
  const spar = new MeshBuilder('spar');
  spar.tube(
    [
      [0, MAST_FOOT - 0.1, MAST_Z],
      [0, HOUNDS, MAST_Z],
      [0, MAST_HEAD, MAST_Z],
    ],
    [0.125, 0.105, 0.09],
    10,
  );
  spar.tube(
    [
      [0, CROSSTREES - 0.6, MAST_Z - 0.2],
      [0, TOPMAST_HEAD, MAST_Z - 0.2],
    ],
    [0.065, 0.042],
    8,
  );
  // The crosstrees.
  spar.tube(
    [
      [-0.98, CROSSTREES, MAST_Z],
      [0.98, CROSSTREES, MAST_Z],
    ],
    [0.04, 0.04],
    6,
  );
  // The bowsprit, run out over the stem.
  spar.tube([[0, STEM_HEAD[1] - 0.05, STEM_Z + 1.2], BOWSPRIT_END], [0.11, 0.065], 8);
  // The boom, its end over the counter; the gaff lowered onto the furled sail.
  const boomFoot: Vec3 = [0, MAST_FOOT + 0.9, MAST_Z + 0.15];
  spar.tube([boomFoot, BOOM_END], [0.09, 0.08], 8);
  spar.tube(
    [
      [0, MAST_FOOT + 1.42, MAST_Z + 0.2],
      [0, BOOM_END[1] + 0.48, BOOM_END[2] - 1.6],
    ],
    [0.065, 0.05],
    6,
  );
  // The mainsail furled on the boom, fat at the mast.
  const sail = new MeshBuilder('canvas');
  const furl: Vec3[] = line(
    [0, boomFoot[1] + 0.2, boomFoot[2] + 0.2],
    [0, BOOM_END[1] + 0.17, BOOM_END[2] - 0.4],
    10,
  );
  sail.tube(
    furl,
    furl.map((_, i) => lerp(0.2, 0.1, i / 10) * (1 + 0.12 * Math.sin(i * 2.1))),
    9,
  );
  // The tiller over the transom, and the rudder's head.
  const wood = new MeshBuilder('varnish');
  wood.tube(
    [
      [0, sheerAt(1) + 0.25, TRANSOM_Z - 0.1],
      [0, sheerAt(1) + 0.55, TRANSOM_Z - 2.0],
    ],
    [0.05, 0.035],
    6,
    TEAK,
  );
  // The skylight and the companion, varnished teak.
  wood.box([-0.6, deckAt(0.4) - 0.05, 0.4], [0.6, deckAt(0.4) + 0.32, 1.9], TEAK);
  wood.box([-0.45, deckAt(2.6) - 0.05, 2.4], [0.45, deckAt(2.6) + 0.42, 3.1], TEAK);
  const glass = new MeshBuilder('glass');
  glass.box([-0.5, deckAt(0.4) + 0.32, 0.55], [0.5, deckAt(0.4) + 0.36, 1.75], [0.25, 0.3, 0.3]);
  // The rudder below her counter.
  const rudder = new MeshBuilder('copper');
  rudder.box([-0.05, -1.45, TRANSOM_Z - 0.35], [0.05, 0.2, TRANSOM_Z + 0.25], COPPER);
  return [spar, sail, wood, glass, rudder];
}

/** Her rigging, tarred hemp: shrouds, forestay, the jib's stay, running backstays and the anchor's cable. */
function rigging(): MeshBuilder[] {
  const rope = new MeshBuilder('tar');
  const r = [0.018];
  const hb = halfBreadth(along(MAST_Z));
  for (const side of [1, -1]) {
    for (const dz of [-0.35, 0.45]) {
      rope.tube(
        [
          [0.12 * side, HOUNDS, MAST_Z],
          [hb * side * 0.98, sheerAt(along(MAST_Z + dz)) + 0.08, MAST_Z + dz],
        ],
        r,
        4,
      );
    }
    // The topmast's shroud over the crosstree's end.
    rope.tube(
      [
        [0.05 * side, TOPMAST_HEAD - 0.4, MAST_Z - 0.2],
        [0.97 * side, CROSSTREES, MAST_Z],
        [hb * side * 0.98, sheerAt(along(MAST_Z + 0.1)) + 0.08, MAST_Z + 0.1],
      ],
      [0.012],
      4,
    );
    rope.tube(
      [
        [0.1 * side, HOUNDS - 0.2, MAST_Z],
        [halfBreadth(along(3)) * side * 0.95, deckAt(3), 3],
      ],
      r,
      4,
    );
  }
  rope.tube([[0, HOUNDS, MAST_Z - 0.1], STEM_HEAD], r, 4);
  rope.tube([[0, TOPMAST_HEAD - 0.2, MAST_Z - 0.25], BOWSPRIT_END], [0.014], 4);
  // The anchor's cable, out over the stem and down into the sea ahead.
  const cable = new MeshBuilder('rope');
  cable.tube(
    sagging(STEM_HEAD, [0, -0.6, STEM_Z - 4.5], -0.25, 8),
    [0.035],
    5,
    srgb(0.3, 0.24, 0.16),
  );
  return [rope, cable];
}

// --- The signal flags, bent on the dressing line ----------------------------------

/**
 * A flag hung with its hoist along the line from a to b, its fly falling
 * below: each row of its design a run of quads, a run for each dye, both
 * faces. A pennant tapers to a point.
 */
function flagOn(m: MeshBuilder, f: Flag, a: Vec3, b: Vec3, depth: number): void {
  const rows = f.rows;
  const h = rows.length;
  const w = (rows[0] ?? '').length;
  const down: Vec3 = [0, -1, 0];
  // Hung a little off the vertical, as bunting does with a breath of wind.
  const drop: Vec3 = normalize(add(down, [0.18, 0, 0]));
  const at = (u: number, v: number): Vec3 => {
    // u along the fly (0 at the line), v along the hoist (0 at a).
    const taper = f.cut === 'pennant' ? 1 - 0.9 * u : 1;
    const mid = 0.5 + (v - 0.5) * taper;
    return add(add(a, scale(sub(b, a), mid)), scale(drop, u * depth));
  };
  for (let row = 0; row < h; row++) {
    const s = rows[row] ?? '';
    let c = 0;
    while (c < w) {
      const letter = s[c] ?? '';
      let e = c + 1;
      while (e < w && s[e] === letter) {
        e++;
      }
      const colour = DYES.get(letter) ?? [1, 1, 1];
      const v0 = row / h;
      const v1 = (row + 1) / h;
      const u0 = c / w;
      const u1 = e / w;
      const k = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map((p) => m.vertex(p, colour));
      m.quad(k[0] as number, k[1] as number, k[2] as number, k[3] as number);
      c = e;
    }
  }
}

/** The dressing line, bowsprit's end to topmast's head to boom's end, and every flag of the catalog on it in turn. */
function dressing(): MeshBuilder[] {
  const rope = new MeshBuilder('rope');
  const flags = new MeshBuilder('wool');
  const head: Vec3 = [0, TOPMAST_HEAD - 0.05, MAST_Z - 0.2];
  let n = 0;
  for (const [a, b] of [
    [BOWSPRIT_END, head],
    [head, BOOM_END],
  ] as [Vec3, Vec3][]) {
    const path = sagging(a, b, 0.35, 24);
    rope.tube(path, [0.008], 3, srgb(0.3, 0.26, 0.2));
    // Flags 0.5 m along the line, a gap between each.
    let length = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      length += Math.hypot(...sub(path[i + 1] as Vec3, path[i] as Vec3));
    }
    const pitch = 0.62;
    const count = Math.floor((length - 0.8) / pitch);
    const point = (d: number): Vec3 => {
      let left = d;
      for (let i = 0; i + 1 < path.length; i++) {
        const p = path[i] as Vec3;
        const q = path[i + 1] as Vec3;
        const s = Math.hypot(...sub(q, p));
        if (left <= s) {
          return add(p, scale(sub(q, p), left / s));
        }
        left -= s;
      }
      return path[path.length - 1] as Vec3;
    };
    for (let i = 0; i < count; i++) {
      const d = 0.4 + i * pitch;
      const f = committee.flags[n % committee.flags.length] as Flag;
      n++;
      flagOn(flags, f, point(d), point(d + 0.5), f.cut === 'pennant' ? 0.75 : 0.42);
    }
  }
  return [rope, flags];
}

// --- The signal gun -----------------------------------------------------------

const GUN_Z = -3.5;
const GUN_DECK = deckAt(GUN_Z);
const BORE_Y = GUN_DECK + 0.36;
const MUZZLE: Vec3 = [0.56, BORE_Y, GUN_Z];

/** A small brass gun on an oak carriage, its muzzle to starboard. */
function gun(): MeshBuilder[] {
  const brass = new MeshBuilder('brass');
  // The barrel: the cascabel's knob, the breech, the reinforce, the chase
  // and the muzzle's swell.
  brass.tube(
    [
      [-0.38, BORE_Y, GUN_Z],
      [-0.33, BORE_Y, GUN_Z],
      [-0.3, BORE_Y, GUN_Z],
      [-0.27, BORE_Y, GUN_Z],
      [-0.05, BORE_Y, GUN_Z],
      [-0.04, BORE_Y, GUN_Z],
      [0.46, BORE_Y, GUN_Z],
      [0.5, BORE_Y, GUN_Z],
      [MUZZLE[0], BORE_Y, GUN_Z],
    ],
    [0.03, 0.03, 0.075, 0.085, 0.08, 0.07, 0.055, 0.068, 0.062],
    14,
  );
  // The trunnions.
  brass.tube(
    [
      [0.02, BORE_Y, GUN_Z - 0.13],
      [0.02, BORE_Y, GUN_Z + 0.13],
    ],
    [0.025],
    8,
  );
  const oak = new MeshBuilder('oak');
  oak.box([-0.34, GUN_DECK + 0.08, GUN_Z - 0.16], [0.24, GUN_DECK + 0.3, GUN_Z - 0.1]);
  oak.box([-0.34, GUN_DECK + 0.08, GUN_Z + 0.1], [0.24, GUN_DECK + 0.3, GUN_Z + 0.16]);
  oak.box([-0.3, GUN_DECK + 0.05, GUN_Z - 0.12], [0.2, GUN_DECK + 0.1, GUN_Z + 0.12]);
  const iron = new MeshBuilder('iron');
  // Four little trucks (wheels).
  for (const x of [-0.26, 0.16]) {
    for (const z of [-0.19, 0.19]) {
      iron.tube(
        [
          [x, GUN_DECK + 0.07, GUN_Z + z - 0.03],
          [x, GUN_DECK + 0.07, GUN_Z + z + 0.03],
        ],
        [0.07],
        10,
      );
    }
  }
  return [brass, oak, iron];
}

// --- Lanterns ------------------------------------------------------------------

/** A small lantern hung at p: a brass cap and base round a glass, its middle at p. */
function lanternAt(p: Vec3, size: number): MeshBuilder[] {
  const brass = new MeshBuilder('brass');
  const glass = new MeshBuilder('glass');
  const h = 0.16 * size;
  const r = 0.07 * size;
  glass.tube(
    [
      [p[0], p[1] - h, p[2]],
      [p[0], p[1] + h, p[2]],
    ],
    [r],
    8,
  );
  brass.tube(
    [
      [p[0], p[1] - h - 0.03 * size, p[2]],
      [p[0], p[1] - h, p[2]],
    ],
    [r * 1.15],
    8,
  );
  brass.tube(
    [
      [p[0], p[1] + h, p[2]],
      [p[0], p[1] + h + 0.05 * size, p[2]],
      [p[0], p[1] + h + 0.09 * size, p[2]],
    ],
    [r * 1.2, r * 0.6, 0.012],
    8,
  );
  return [brass, glass];
}

// --- The marks ---------------------------------------------------------------

/** A cask floating upright, its staves in paint between blacked iron hoops, half in the water. */
function cask(radius: number, height: number, paint: Vec3): MeshBuilder[] {
  const staves = new MeshBuilder('paint');
  const hoops = new MeshBuilder('iron');
  const bottom = -height * 0.45;
  const rAt = (y: number): number => {
    const s = (y - bottom) / height - 0.5;
    return radius * (1 - 0.55 * s * s);
  };
  const cuts = [0, 0.08, 0.13, 0.3, 0.35, 0.65, 0.7, 0.87, 0.92, 1];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const y0 = bottom + (cuts[i] as number) * height;
    const y1 = bottom + (cuts[i + 1] as number) * height;
    const hoop = i % 2 === 1;
    const path = line([0, y0, 0], [0, y1, 0], hoop ? 1 : 2);
    (hoop ? hoops : staves).tube(
      path,
      path.map((p) => rAt(p[1]) * (hoop ? 1.015 : 1)),
      12,
      hoop ? [1, 1, 1] : paint,
    );
  }
  return [staves, hoops];
}

/** A spar of white paint from below the cask to its top, with a black band at each metre above the water. */
function spar(from: number, top: number, radius: number): MeshBuilder {
  const m = new MeshBuilder('paint');
  const rAt = (y: number): number => lerp(radius, radius * 0.65, (y - from) / (top - from));
  const cuts = [from];
  for (let k = 1; k < top; k++) {
    cuts.push(k, Math.min(k + 0.18, top));
  }
  cuts.push(top);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const y0 = cuts[i] as number;
    const y1 = cuts[i + 1] as number;
    if (y1 - y0 < 1e-6) {
      continue;
    }
    const band = i % 2 === 1;
    m.tube(
      [
        [0, y0, 0],
        [0, y1, 0],
      ],
      [rAt(y0) * (band ? 1.02 : 1), rAt(y1) * (band ? 1.02 : 1)],
      8,
      band ? BLACK : WHITE,
    );
  }
  return m;
}

/** The number's board: its faces' width, m. */
const BOARD = 0.72;

/** The mark: its cask, spar, number board, lantern and the nodes where its flag, lantern and number go. */
function caskMark(): NodeDef {
  const top = committee.mark;
  const parts: MeshBuilder[] = [...cask(0.42, 1.05, MADDER), spar(-0.6, top, 0.07)];
  // The board for the number: a white box about the spar, a face to each
  // side, its edges blacked.
  const board = new MeshBuilder('paint');
  const by = 2.3;
  const b = BOARD / 2;
  board.box([-b, by - b, -b], [b, by + b, b], WHITE);
  for (const y of [by - b, by + b - 0.05]) {
    board.box([-b - 0.01, y, -b - 0.01], [b + 0.01, y + 0.05, b + 0.01], BLACK);
  }
  for (const [x, z] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as [number, number][]) {
    board.box(
      [x * b - 0.025, by - b, z * b - 0.025],
      [x * b + 0.025, by + b, z * b + 0.025],
      BLACK,
    );
  }
  parts.push(board);
  // The lantern on an arm to starboard, under the flag.
  const lantern: Vec3 = [0.28, top - 0.75, 0];
  const arm = new MeshBuilder('iron');
  arm.tube(
    [
      [0, top - 0.45, 0],
      [0.28, top - 0.45, 0],
      [0.28, top - 0.55, 0],
    ],
    [0.012],
    4,
  );
  parts.push(arm, ...lanternAt(lantern, 1));
  return {
    name: 'cask-mark',
    primitives: merged(parts),
    children: [
      { name: 'flag-staff', translation: [0, top, 0] },
      { name: 'lantern', translation: lantern },
      { name: 'number', translation: [0, by, 0], extras: { face: b + 0.004 } },
    ],
  };
}

/** The pin buoy: a smaller cask in weld yellow, a shorter spar, its lantern and flag. */
function pinBuoy(): NodeDef {
  const top = Math.max(2.5, committee.mark - 2);
  const lantern: Vec3 = [0.24, top - 0.7, 0];
  const arm = new MeshBuilder('iron');
  arm.tube(
    [
      [0, top - 0.4, 0],
      [0.24, top - 0.4, 0],
      [0.24, top - 0.5, 0],
    ],
    [0.012],
    4,
  );
  const parts = [...cask(0.36, 0.9, WELD), spar(-0.5, top, 0.06), arm, ...lanternAt(lantern, 0.9)];
  return {
    name: 'pin-buoy',
    primitives: merged(parts),
    children: [
      { name: 'flag-staff', translation: [0, top, 0] },
      { name: 'lantern', translation: lantern },
    ],
  };
}

/** The beacon: a tarred pole from deep under the water, a white band at the water, an iron cage at its head. */
function beaconSpar(): NodeDef {
  const tar = new MeshBuilder('tar');
  const paint = new MeshBuilder('paint');
  const head = 5.2;
  tar.tube(
    [
      [0, -12, 0],
      [0, -0.3, 0],
    ],
    [0.16, 0.15],
    10,
  );
  paint.tube(
    [
      [0, -0.3, 0],
      [0, 1.6, 0],
    ],
    [0.15, 0.145],
    10,
    WHITE,
  );
  tar.tube(
    [
      [0, 1.6, 0],
      [0, head, 0],
    ],
    [0.145, 0.11],
    10,
  );
  // The cage: four hoops about the pole's head and a ring round its waist.
  const iron = new MeshBuilder('iron');
  const c: Vec3 = [0, head + 0.45, 0];
  const r = 0.42;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    const path: Vec3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      path.push([
        c[0] + r * Math.cos(t) * Math.cos(a),
        c[1] + r * Math.sin(t),
        c[2] + r * Math.cos(t) * Math.sin(a),
      ]);
    }
    iron.tube(path, [0.022], 4);
  }
  const waist: Vec3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    waist.push([c[0] + r * Math.cos(t), c[1], c[2] + r * Math.sin(t)]);
  }
  iron.tube(waist, [0.022], 4);
  iron.tube(
    [
      [0, head - 0.05, 0],
      [0, c[1] + r, 0],
    ],
    [0.03],
    6,
  );
  return { name: 'beacon-spar', primitives: merged([tar, paint, iron]) };
}

// --- Assembling --------------------------------------------------------------

/** Builders as primitives, those of one material merged. */
function merged(parts: MeshBuilder[]): ReturnType<MeshBuilder['primitive']>[] {
  const byMaterial = new Map<string, MeshBuilder>();
  for (const p of parts) {
    const into = byMaterial.get(p.material) ?? new MeshBuilder(p.material);
    into.append(p);
    byMaterial.set(p.material, into);
  }
  return [...byMaterial.values()].map((b) => b.primitive({ colors: true }));
}

function committeeBoat(): NodeDef {
  const ridingLight = add(lineAt([0, HOUNDS, MAST_Z - 0.1], STEM_HEAD, 0.62), [0, -0.3, 0]);
  const parts = [
    ...hull(),
    ...spars(),
    ...rigging(),
    ...dressing(),
    ...gun(),
    ...lanternAt(ridingLight, 1.3),
  ];
  return {
    name: 'committee-boat',
    primitives: merged(parts),
    extras: { length: LENGTH + 3.4, beam: BEAM },
    children: [
      { name: 'gun', translation: [0, BORE_Y, GUN_Z] },
      { name: 'muzzle', translation: MUZZLE },
      { name: 'halyard', translation: HALYARD },
      { name: 'hawse', translation: STEM_HEAD },
      { name: 'riding-light', translation: ridingLight },
    ],
  };
}

/** The point a share t along from a to b. */
function lineAt(a: Vec3, b: Vec3, t: number): Vec3 {
  return add(a, scale(sub(b, a), t));
}

const roots: NodeDef[] = [committeeBoat(), caskMark(), pinBuoy(), beaconSpar()];
mkdirSync('.dev/art', { recursive: true });
const raw = writeGlb(roots, materials);
writeFileSync('.dev/art/committee.raw.glb', raw);
execFileSync(
  'client/node_modules/.bin/gltfpack',
  [
    '-i',
    '.dev/art/committee.raw.glb',
    '-o',
    `art/${MODEL}`,
    '-c',
    '-kn',
    '-km',
    '-kv',
    '-ke',
    '-noq',
  ],
  { stdio: 'inherit' },
);
process.stdout.write(`wrote art/${MODEL}\n`);

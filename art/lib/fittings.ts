// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// What every boat carries alike, whatever her size: the tricolour lantern
// at the masthead with the pennant's staff above it, the pennant, the
// telltales on the mainsail, and the foils' blades.

import { MeshBuilder, srgb, type Vec3 } from './mesh.ts';

// --- The lantern -------------------------------------------------------------

/**
 * A sidelight's arc, in degrees: from right ahead to 22.5° abaft the beam
 * on its own side, green to starboard and red to port. The sternlight is
 * white over what is left, the 135° astern. (International Regulations for
 * Preventing Collisions at Sea, Rule 21.) A sailing vessel of less than
 * 20 m may carry the three in one lantern at the masthead (Rule 25(b)).
 */
const SIDELIGHT_ARC = 112.5;

/** The lantern's glass: its radius and height, in metres, and its panes round. */
const GLASS_RADIUS = 0.036;
const GLASS_HEIGHT = 0.07;
const GLASS_PANES = 32;
/** The glass by day, unlit: each pane the dull colour of its light. */
const GLASS_RED = srgb(0.5, 0.11, 0.09);
const GLASS_GREEN = srgb(0.09, 0.38, 0.2);
const GLASS_CLEAR = srgb(0.78, 0.77, 0.7);
/** The lantern's base stands this far above the masthead, and its glass's middle this far. */
const LANTERN_BASE = 0.02;
export const LANTERN_Y = LANTERN_BASE + GLASS_HEIGHT / 2;
/** The pennant's staff, above the lantern's cap: its top, above the masthead. */
export const STAFF_TOP = LANTERN_Y + GLASS_HEIGHT / 2 + 0.2;

/** The level direction a degrees from right ahead toward starboard. */
const bearingDir = (a: number): Vec3 => {
  const r = (a * Math.PI) / 180;
  return [Math.sin(r), 0, -Math.cos(r)];
};

/**
 * The tricolour lantern, about the middle of its glass: a brass base on the
 * masthead, a ring of glass in three colours, each over its light's arc,
 * with a brass bar where two meet, a brass cap, and the pennant's staff.
 */
export function lantern(): { brass: MeshBuilder; glass: MeshBuilder } {
  const glass = new MeshBuilder('glass');
  const h = GLASS_HEIGHT / 2;
  for (let i = 0; i < GLASS_PANES; i++) {
    const a0 = (i / GLASS_PANES) * 360;
    const a1 = ((i + 1) / GLASS_PANES) * 360;
    const mid = (a0 + a1) / 2;
    const colour =
      mid < SIDELIGHT_ARC ? GLASS_GREEN : mid > 360 - SIDELIGHT_ARC ? GLASS_RED : GLASS_CLEAR;
    const out = bearingDir(mid);
    const corners = [a0, a1].flatMap((a) => {
      const d = bearingDir(a);
      return [-h, h].map((y) => {
        const k = glass.vertex([d[0] * GLASS_RADIUS, y, d[2] * GLASS_RADIUS], colour);
        glass.normal(k, d);
        return k;
      });
    }) as [number, number, number, number];
    glass.triFacing(corners[0], corners[1], corners[2], out);
    glass.triFacing(corners[2], corners[1], corners[3], out);
  }
  const brass = new MeshBuilder('brass');
  // The base, down to the masthead.
  brass.tube(
    [
      [0, -h - LANTERN_BASE - 0.01, 0],
      [0, -h - 0.012, 0],
      [0, -h, 0],
    ],
    [0.03, 0.046, 0.046],
    12,
  );
  // The cap: a rim over the glass, then a cone.
  brass.tube(
    [
      [0, h, 0],
      [0, h + 0.01, 0],
      [0, h + 0.045, 0],
    ],
    [0.05, 0.046, 0.012],
    12,
  );
  // A bar where two colours meet.
  for (const a of [0, SIDELIGHT_ARC, 360 - SIDELIGHT_ARC]) {
    const d = bearingDir(a);
    const r = GLASS_RADIUS + 0.003;
    brass.tube(
      [
        [d[0] * r, -h, d[2] * r],
        [d[0] * r, h, d[2] * r],
      ],
      [0.004],
      4,
    );
  }
  // The pennant's staff.
  brass.tube(
    [
      [0, h + 0.04, 0],
      [0, STAFF_TOP - LANTERN_Y, 0],
    ],
    [0.007, 0.005],
    6,
  );
  return { brass, glass };
}

// --- The pennant -------------------------------------------------------------

/** The pennant's length and its width at the staff, in metres. */
const PENNANT_LENGTH = 0.45;
export const PENNANT_WIDTH = 0.07;
const PENNANT_SEGMENTS = 16;

/**
 * The pennant, at the top of its staff above the lantern: a narrow tapered
 * strip, at rest streaming aft, level, from the staff. TEXCOORD_1.x is the fraction along it, from
 * which the client streams it downwind of the apparent wind and flutters it.
 */
export function pennant(): MeshBuilder {
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

// --- The telltales -------------------------------------------------------------

/** A telltale's length and width, in metres, and how far it stands off the cloth. */
const TELLTALE_LENGTH = 0.17;
export const TELLTALE_WIDTH = 0.012;
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
 * finds it on the shaped sail. The sail's luff stands 0.04 m aft of the
 * mast's centre, its foot 0.03 m above the boom; chordAt is the sail's
 * chord at a fraction of its luff.
 */
export function telltales(
  rig: { luff: number; footStrip: number; headStrip: number },
  chordAt: (v: number) => number,
): MeshBuilder {
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

// --- Foils ---------------------------------------------------------------------

/**
 * A foil: a thin blade with rounded edges, between heights y0 and y1, its
 * chord from z0 to z1, in n segments a side; capped at both ends.
 */
export function blade(
  m: MeshBuilder,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  thick: number,
  n: number,
): void {
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

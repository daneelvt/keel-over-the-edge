// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The bodies of the life in the water: a dolphin, a sea turtle, a flying
// fish and a tarpon, each lofted from its real proportions at a length of
// its own and written as one mesh, a node of that name whose extras give
// the length it was built at. The page scales each to a kind's length,
// paints it in the kind's colours by its vertices' (see body.ts) and bends
// its spine by a wave that grows toward the tail.
//
// Each is faceted, opaque and low in triangles, read from a few metres off
// the bow to a few hundred away on a phone; each is drawn padded to the
// largest, so each is held to a budget.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, readGlbJson, writeGlb } from '../../lib/gltf.ts';
import type { Vec3 } from '../../lib/mesh.ts';
import { Body, type Corner } from './body.ts';

/** A body as it is built: its name, its length, m, and its triangles' budget. */
interface Swimmer {
  name: string;
  length: number;
  budget: number;
  build: (length: number) => Body;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A dolphin, as the Atlantic spotted and the bottlenose: a slender beak, a
 * rounded melon rising from a crease behind it, the body's girth greatest
 * at about two fifths of its length from the snout, a falcate dorsal fin at
 * mid-length a tenth of the length high, pectoral flippers about a sixth of
 * the length, and flukes a fifth of the length across, on a narrow keeled
 * tail stock (Perrin, Encyclopedia of Marine Mammals; NOAA Fisheries). A
 * dark cape over the back dips low on the flank ahead of the dorsal fin;
 * the flanks are paler and the belly pale.
 */
function dolphin(length: number): Body {
  const b = new Body(length);
  const cape = (s: number): number => smooth(0.08, 0.2, s) * (1 - smooth(0.42, 0.62, s));
  const surface = b.loft(
    [
      { s: 0, top: -0.022, bot: -0.022, w: 0 },
      // The beak, about a twentieth of the length (Perrin 2009).
      { s: 0.02, top: -0.01, bot: -0.034, w: 0.012 },
      { s: 0.055, top: 0.0, bot: -0.046, w: 0.022 },
      // The melon rises steeply from the crease behind the beak.
      { s: 0.075, top: 0.04, bot: -0.056, w: 0.04 },
      { s: 0.12, top: 0.072, bot: -0.07, w: 0.058 },
      { s: 0.2, top: 0.09, bot: -0.086, w: 0.074 },
      // Greatest girth, about 0.57 of the length round.
      { s: 0.34, top: 0.098, bot: -0.096, w: 0.084 },
      { s: 0.5, top: 0.09, bot: -0.086, w: 0.074 },
      { s: 0.64, top: 0.07, bot: -0.062, w: 0.05 },
      // The tail stock, deep and narrow, keeled above and below.
      { s: 0.76, top: 0.046, bot: -0.036, w: 0.026 },
      { s: 0.85, top: 0.024, bot: -0.018, w: 0.013 },
      { s: 0.905, top: 0.002, bot: 0.002, w: 0 },
    ],
    10,
    (s, c) => {
      if (c > 0.6) {
        return { r: 1 };
      }
      if (c > 0) {
        return { r: 0.4 + 0.55 * cape(s) };
      }
      if (c > -0.6) {
        return { r: 0.12 };
      }
      return { r: 0 };
    },
  );
  // The dorsal fin: its base from two fifths of the length to past the
  // middle, its tip swept back over its trailing edge's hollow.
  b.fin(
    [
      { lead: [0, 0.083, 0.4], trail: [0, 0.069, 0.56], thick: 0.008 },
      { lead: [0, 0.14, 0.47], trail: [0, 0.138, 0.545], thick: 0.005 },
      { lead: [0, 0.178, 0.545], trail: [0, 0.176, 0.585], thick: 0.003 },
    ],
    [0, 0.196, 0.625],
    [1, 0, 0],
    { r: [1, 1], trail: 0.35, tip: 0.5 },
  );
  // The flukes: swept back from the tail stock to pointed tips, their
  // trailing edges meeting at a notch.
  for (const mirror of [false, true]) {
    b.fin(
      [
        { lead: [0, 0.004, 0.86], trail: [0, 0.0, 0.965], thick: 0.009 },
        { lead: [0.05, 0.002, 0.905], trail: [0.05, 0.0, 0.968], thick: 0.005 },
        { lead: [0.082, 0.0, 0.953], trail: [0.082, 0.0, 0.984], thick: 0.003 },
      ],
      [0.101, 0.0, 1.0],
      [0, 1, 0],
      { r: [1, 0.75], trail: 0.3 },
      false,
      mirror,
    );
  }
  // The pectoral flippers, a sixth of the length, held out and down, swept back.
  for (const mirror of [false, true]) {
    b.fin(
      [
        { lead: [0.05, -0.04, 0.185], trail: [0.048, -0.05, 0.235], thick: 0.01 },
        { lead: [0.096, -0.072, 0.215], trail: [0.088, -0.083, 0.278], thick: 0.006 },
        { lead: [0.13, -0.096, 0.258], trail: [0.122, -0.104, 0.296], thick: 0.003 },
      ],
      [0.153, -0.115, 0.318],
      [0, 1, 0],
      { r: [1, 0.8], trail: 0.25 },
      true,
      mirror,
    );
  }
  // The eye, just above and behind the mouth's corner; the mouth's line
  // along the beak, turning up at its corner; the blowhole on top.
  surface.spot(0.105, -0.008, 0.012, 0.008);
  surface.line(
    [
      [0.012, -0.024],
      [0.05, -0.028],
      [0.086, -0.022],
    ],
    0.004,
  );
  const crown = surface.station(0.14);
  b.quad(
    ...([
      [-0.012, 0, 0.137],
      [-0.012, 0, 0.143],
      [0.012, 0, 0.143],
      [0.012, 0, 0.137],
    ].map(([x, , s]) => ({
      p: b.at([x as number, crown.top + 0.002, s as number]),
      r: 1,
      g: 1,
    })) as [Corner, Corner, Corner, Corner]),
    [0, 1, 0],
  );
  return b;
}

/**
 * A green sea turtle: an oval, low-domed carapace about four fifths of
 * the animal's length from head to hind flippers, a row of five vertebral
 * scutes down its middle between four pairs of costals, and a rim of
 * marginals; a short blunt head; long front flippers, about half the
 * carapace's length, swept back; short, rounded hind ones (NOAA Fisheries;
 * Wyneken, The Anatomy of Sea Turtles 2001). The carapace is the back's
 * colour, the plastron and the skin halfway, the flippers darker above.
 */
function turtle(length: number): Body {
  const b = new Body(length);
  const front = 0.17;
  const back = 0.92;
  const along = (t: number): number => front + t * (back - front);
  // Half the carapace's width, widest a little ahead of its middle; its
  // straight width is about three quarters of its length.
  const width = 0.28;
  const half = (t: number): number => {
    const d = (t - 0.42) / (t < 0.42 ? 0.42 : 0.58);
    return width * Math.sqrt(Math.max(0, 1 - d * d));
  };
  // The rim rises over the neck; the dome is low, its height about a
  // fifth of the carapace's length.
  const rim = (t: number): number => -0.025 + 0.06 * Math.max(0, 1 - t / 0.3) ** 2;
  const dome = (xi: number, t: number): number => {
    // Highest a little ahead of the middle, falling away to the rear.
    const d = (t - 0.4) / (t < 0.4 ? 0.5 : 0.6);
    return rim(t) + 0.13 * Math.sqrt(Math.max(0, 1 - xi * xi)) * Math.max(0, 1 - d * d) ** 0.6;
  };
  const plastron = (t: number): number =>
    -0.075 + 0.04 * (Math.max(0, Math.abs(t - 0.5) - 0.3) / 0.2);
  const seam = 0.6;
  const shell = b.at([0, 0.01, along(0.45)]);
  const want = (cs: Corner[]): Vec3 => {
    const c = cs.reduce<Vec3>((a, x) => [a[0] + x.p[0], a[1] + x.p[1], a[2] + x.p[2]], [0, 0, 0]);
    return [c[0] / cs.length - shell[0], c[1] / cs.length - shell[1], c[2] / cs.length - shell[2]];
  };
  const tri = (a: Corner, c: Corner, d: Corner): void => b.tri(a, c, d, want([a, c, d]));
  const fan = (centre: Corner, ring: Corner[]): void => {
    for (let i = 0; i < ring.length; i++) {
      tri(centre, ring[i] as Corner, ring[(i + 1) % ring.length] as Corner);
    }
  };
  const top = (xi: number, t: number, g: number, lift = 0): Corner => ({
    p: b.at([xi * half(t), dome(Math.abs(xi), t) + lift, along(t)]),
    r: 1,
    g,
  });
  const under = (xi: number, t: number): Corner => ({
    p: b.at([xi * half(t), Math.abs(xi) >= 1 ? dome(1, t) : plastron(t), along(t)]),
    r: 0.5,
  });
  const rows = [0.05, 0.22, 0.4, 0.58, 0.76, 0.93];
  // The vertebral scutes' edges, the costals', and the rim.
  const [v, m] = [0.33, 0.78];
  for (let k = 0; k + 1 < rows.length; k++) {
    const t0 = rows[k] as number;
    const t1 = rows[k + 1] as number;
    const tm = (t0 + t1) / 2;
    // Each scute a low pyramid, its seams dark.
    fan(top(0, tm, 0, 0.003), [
      top(-v, t0, seam),
      top(v, t0, seam),
      top(v, t1, seam),
      top(-v, t1, seam),
    ]);
    for (const side of [1, -1]) {
      fan(top(side * 0.56, tm, 0, 0.002), [
        top(side * v, t0, seam),
        top(side * m, t0, seam),
        top(side * m, t1, seam),
        top(side * v, t1, seam),
      ]);
      const ring = [
        top(side * m, t0, seam),
        top(side, t0, 0.2),
        top(side, t1, 0.2),
        top(side * m, t1, seam),
      ];
      tri(ring[0] as Corner, ring[1] as Corner, ring[2] as Corner);
      tri(ring[0] as Corner, ring[2] as Corner, ring[3] as Corner);
      // The plastron and the bridge to the rim.
      const cols = [side, side * 0.55, -side * 0.55];
      for (let i = 0; i + 1 < cols.length; i++) {
        const a = cols[i] as number;
        const c = cols[i + 1] as number;
        if (side < 0 && i > 0) {
          continue;
        }
        tri(under(a, t0), under(c, t0), under(c, t1));
        tri(under(a, t0), under(c, t1), under(a, t1));
      }
    }
  }
  // The ends: the nuchal over the neck, and the rear's marginals.
  for (const [t, end] of [
    [rows[0] as number, 0],
    [rows[rows.length - 1] as number, 1],
  ] as [number, number][]) {
    const tip: Corner = { p: b.at([0, rim(end), along(end)]), r: 1, g: 0.2 };
    const row = [
      top(-1, t, 0.2),
      top(-m, t, seam),
      top(-v, t, seam),
      top(v, t, seam),
      top(m, t, seam),
      top(1, t, 0.2),
    ];
    for (let i = 0; i + 1 < row.length; i++) {
      tri(tip, row[i] as Corner, row[i + 1] as Corner);
    }
    const low: Corner = { ...tip, r: 0.5, g: 0 };
    const belly = [under(-1, t), under(-0.55, t), under(0.55, t), under(1, t)];
    for (let i = 0; i + 1 < belly.length; i++) {
      tri(low, belly[i] as Corner, belly[i + 1] as Corner);
    }
  }
  // The head and neck, out from under the nuchal: short and blunt, a
  // fifth of the carapace long, its back sunk in the shell.
  const head = b.loft(
    [
      { s: 0, top: 0.0, bot: 0.0, w: 0 },
      { s: 0.03, top: 0.03, bot: -0.035, w: 0.035 },
      { s: 0.09, top: 0.05, bot: -0.045, w: 0.05 },
      { s: 0.15, top: 0.04, bot: -0.045, w: 0.045 },
      { s: 0.26, top: 0.03, bot: -0.06, w: 0.05 },
    ],
    6,
    (_s, c) => ({ r: 0.35 + 0.4 * Math.max(0, c) }),
  );
  head.spot(0.05, 0.012, 0.012, 0.009);
  head.line(
    [
      [0.008, -0.012],
      [0.05, -0.02],
    ],
    0.005,
    0.8,
  );
  // The front flippers: narrow at the shoulder, broad along the forearm,
  // tapering to a point; their span tip to tip about 1.4 times the
  // carapace's length, as a green turtle's in its glide.
  for (const mirror of [false, true]) {
    b.fin(
      [
        { lead: [0.1, -0.03, 0.27], trail: [0.1, -0.04, 0.36], thick: 0.014 },
        { lead: [0.22, -0.045, 0.32], trail: [0.2, -0.05, 0.43], thick: 0.011 },
        { lead: [0.35, -0.055, 0.41], trail: [0.32, -0.058, 0.5], thick: 0.007 },
        { lead: [0.45, -0.062, 0.5], trail: [0.43, -0.063, 0.55], thick: 0.004 },
      ],
      [0.52, -0.065, 0.6],
      [0, 1, 0],
      { r: [0.85, 0.4], trail: 0.3 },
      true,
      mirror,
    );
    // The hind flippers: short and rounded, trailing.
    b.fin(
      [
        { lead: [0.09, -0.045, 0.82], trail: [0.07, -0.05, 0.88], thick: 0.012 },
        { lead: [0.16, -0.05, 0.875], trail: [0.1, -0.055, 0.965], thick: 0.007 },
        { lead: [0.185, -0.053, 0.93], trail: [0.135, -0.056, 0.99], thick: 0.004 },
      ],
      [0.17, -0.056, 1.0],
      [0, 1, 0],
      { r: [0.85, 0.4], trail: 0.3 },
      true,
      mirror,
    );
  }
  // The short tail.
  b.loft(
    [
      { s: 0.86, top: -0.02, bot: -0.06, w: 0.022 },
      { s: 0.95, top: -0.045, bot: -0.045, w: 0 },
    ],
    4,
    () => ({ r: 0.5 }),
  );
  return b;
}

/**
 * A flying fish, as the Atlantic's four-winged: a slim, nearly round body
 * with a blunt head and a large eye; pectoral fins spread as wings, their
 * span about the fish's length; smaller pelvic wings behind them; a small
 * dorsal far back, and a forked tail whose lower lobe is the longer, the
 * one that sculls the water as it takes off (FishBase, Cheilopogon;
 * Fish, Journal of Morphology 1990). Dark blue above, silver below.
 */
function flyingfish(length: number): Body {
  const b = new Body(length);
  const surface = b.loft(
    [
      { s: 0, top: -0.004, bot: -0.004, w: 0 },
      { s: 0.035, top: 0.02, bot: -0.026, w: 0.022 },
      { s: 0.1, top: 0.05, bot: -0.05, w: 0.048 },
      { s: 0.24, top: 0.064, bot: -0.064, w: 0.058 },
      { s: 0.42, top: 0.06, bot: -0.062, w: 0.052 },
      { s: 0.6, top: 0.046, bot: -0.046, w: 0.036 },
      { s: 0.74, top: 0.024, bot: -0.022, w: 0.016 },
      { s: 0.8, top: 0.0, bot: 0.0, w: 0 },
    ],
    6,
    (_s, c) => ({ r: c > 0.6 ? 1 : c > 0 ? 0.8 : 0 }),
  );
  // The wings, high on the flank behind the head, broad rounded fans.
  for (const mirror of [false, true]) {
    b.fin(
      [
        { lead: [0.035, 0.034, 0.215], trail: [0.035, 0.028, 0.275], thick: 0.007 },
        { lead: [0.17, 0.045, 0.235], trail: [0.17, 0.04, 0.44], thick: 0.004 },
        { lead: [0.36, 0.055, 0.3], trail: [0.36, 0.05, 0.53], thick: 0.003 },
      ],
      [0.5, 0.062, 0.45],
      [0, 1, 0],
      { r: [0.85, 0.35], trail: 0.3 },
      true,
      mirror,
    );
    // The pelvic wings, low behind the middle.
    b.fin(
      [
        { lead: [0.02, -0.035, 0.53], trail: [0.02, -0.035, 0.575], thick: 0.005 },
        { lead: [0.12, -0.042, 0.565], trail: [0.12, -0.045, 0.68], thick: 0.003 },
      ],
      [0.2, -0.05, 0.665],
      [0, 1, 0],
      { r: [0.85, 0.35], trail: 0.3 },
      true,
      mirror,
    );
  }
  // The tail: the lower lobe the longer.
  b.fin(
    [
      { lead: [0, -0.018, 0.74], trail: [0, 0.006, 0.845], thick: 0.006 },
      { lead: [0, -0.06, 0.86], trail: [0, -0.04, 0.905], thick: 0.003 },
    ],
    [0, -0.11, 1.0],
    [1, 0, 0],
    { r: [0.7, 0.7], trail: 0.3 },
  );
  b.fin(
    [{ lead: [0, 0.018, 0.74], trail: [0, -0.006, 0.845], thick: 0.006 }],
    [0, 0.08, 0.93],
    [1, 0, 0],
    { r: [0.9, 0.9], trail: 0.3 },
  );
  // The dorsal, small, over the tail's root.
  b.fin(
    [{ lead: [0, 0.036, 0.6], trail: [0, 0.02, 0.72], thick: 0.004 }],
    [0, 0.068, 0.7],
    [1, 0, 0],
    {
      r: [1, 1],
    },
  );
  surface.spot(0.07, 0.012, 0.018, 0.016);
  return b;
}

/**
 * A tarpon: a deep, laterally compressed body about a quarter as deep as
 * it is long; a large upturned mouth, the lower jaw jutting past the upper
 * to the front of the head; a large eye; a single dorsal fin a little
 * behind the middle, its last ray drawn out in a long filament toward the
 * tail; a long-based anal fin, low pectorals and pelvics; and a large,
 * deeply forked tail (FishBase, Megalops atlanticus; Florida Museum).
 * Blue-grey above, bright silver on the flanks and belly.
 */
function tarpon(length: number): Body {
  const b = new Body(length);
  const surface = b.loft(
    [
      // The lower jaw's tip, the front of the fish, high on its head.
      { s: 0, top: 0.035, bot: 0.035, w: 0 },
      { s: 0.03, top: 0.05, bot: 0.0, w: 0.02 },
      { s: 0.075, top: 0.066, bot: -0.062, w: 0.038 },
      { s: 0.15, top: 0.086, bot: -0.098, w: 0.052 },
      { s: 0.26, top: 0.108, bot: -0.118, w: 0.06 },
      // Deepest, about a quarter of the length.
      { s: 0.4, top: 0.12, bot: -0.12, w: 0.058 },
      { s: 0.54, top: 0.098, bot: -0.092, w: 0.05 },
      { s: 0.66, top: 0.068, bot: -0.062, w: 0.036 },
      { s: 0.76, top: 0.04, bot: -0.036, w: 0.022 },
      { s: 0.82, top: 0.034, bot: -0.032, w: 0.016 },
      { s: 0.86, top: 0.0, bot: 0.0, w: 0 },
    ],
    10,
    (_s, c) => ({ r: c > 0.9 ? 1 : c > 0.6 ? 0.85 : c > 0 ? 0.3 : 0 }),
  );
  // The tail's lobes, deeply forked.
  for (const up of [1, -1]) {
    b.fin(
      [
        { lead: [0, 0.032 * up, 0.8], trail: [0, -0.008 * up, 0.875], thick: 0.007 },
        { lead: [0, 0.075 * up, 0.87], trail: [0, 0.055 * up, 0.92], thick: 0.004 },
        { lead: [0, 0.11 * up, 0.94], trail: [0, 0.1 * up, 0.965], thick: 0.002 },
      ],
      [0, 0.14 * up, 1.0],
      [1, 0, 0],
      { r: [0.7, 0.7], trail: 0.5, tip: 0.6 },
    );
  }
  // The dorsal: its front rays the tallest, its edge dark; its last ray a
  // filament trailing toward the tail.
  b.fin(
    [
      { lead: [0, 0.1, 0.44], trail: [0, 0.086, 0.54], thick: 0.006 },
      { lead: [0, 0.17, 0.47], trail: [0, 0.125, 0.535], thick: 0.004 },
    ],
    [0, 0.215, 0.505],
    [1, 0, 0],
    { r: [0.9, 0.9], lead: 0.6, trail: 0.7, tip: 0.9 },
  );
  b.fin(
    [{ lead: [0, 0.088, 0.522], trail: [0, 0.078, 0.548], thick: 0.003 }],
    [0, 0.105, 0.7],
    [1, 0, 0],
    {
      r: [0.9, 0.9],
      lead: 0.8,
      trail: 0.8,
      tip: 0.8,
    },
  );
  // The anal fin, sickle-shaped under the tail's root.
  b.fin(
    [
      { lead: [0, -0.07, 0.58], trail: [0, -0.04, 0.7], thick: 0.006 },
      { lead: [0, -0.12, 0.62], trail: [0, -0.075, 0.69], thick: 0.003 },
    ],
    [0, -0.145, 0.635],
    [1, 0, 0],
    { r: [0.3, 0.3], trail: 0.3 },
  );
  for (const mirror of [false, true]) {
    // The pectorals, low behind the gill cover.
    b.fin(
      [
        { lead: [0.035, -0.075, 0.205], trail: [0.033, -0.088, 0.235], thick: 0.005 },
        { lead: [0.06, -0.1, 0.25], trail: [0.055, -0.115, 0.29], thick: 0.003 },
      ],
      [0.075, -0.13, 0.33],
      [0, 1, 0],
      { r: [0.3, 0.1] },
      false,
      mirror,
    );
    // The pelvics, on the belly under the dorsal's front.
    b.fin(
      [{ lead: [0.02, -0.105, 0.42], trail: [0.018, -0.108, 0.46], thick: 0.003 }],
      [0.04, -0.14, 0.5],
      [0, 1, 0],
      { r: [0.2, 0.1] },
      false,
      mirror,
    );
  }
  // The eye, large and high; the mouth's line slanting down and back from
  // the jaw's tip; the gill cover's edge.
  surface.spot(0.06, 0.035, 0.016, 0.016);
  surface.line(
    [
      [0.006, 0.03],
      [0.045, 0.006],
      [0.085, -0.012],
    ],
    0.005,
  );
  surface.line(
    [
      [0.178, surface.y(0.178, 1)],
      [0.205, surface.y(0.205, 2)],
      [0.205, surface.y(0.205, 3)],
      [0.185, surface.y(0.185, 4)],
    ],
    0.006,
    0.6,
  );
  return b;
}

/** The bodies, the length each is built at and its budget of triangles. */
const SWIMMERS: Swimmer[] = [
  { name: 'dolphin', length: 2.2, budget: 320, build: dolphin },
  { name: 'turtle', length: 1.0, budget: 320, build: turtle },
  { name: 'flyingfish', length: 0.3, budget: 160, build: flyingfish },
  { name: 'tarpon', length: 1.5, budget: 320, build: tarpon },
];

/** Each mesh's extent along x, y and z, m, and its triangles, as the glb's accessors give them. */
export function probe(glb: Uint8Array): Map<string, { size: Vec3; mid: Vec3; triangles: number }> {
  const json = readGlbJson(glb) as {
    nodes: { name: string; mesh?: number }[];
    meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
    accessors: { count: number; min?: number[]; max?: number[] }[];
  };
  const out = new Map<string, { size: Vec3; mid: Vec3; triangles: number }>();
  for (const n of json.nodes) {
    if (n.mesh === undefined) {
      continue;
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let triangles = 0;
    for (const p of json.meshes[n.mesh]?.primitives ?? []) {
      const a = json.accessors[p.attributes.POSITION ?? -1];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, a?.min?.[k] ?? Infinity);
        max[k] = Math.max(max[k] as number, a?.max?.[k] ?? -Infinity);
      }
      triangles += (json.accessors[p.indices]?.count ?? 0) / 3;
    }
    out.set(n.name, {
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      mid: [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2],
      triangles,
    });
  }
  return out;
}

/** Builds the bodies into the model the catalog names, checks each against its length and budget, and reports them. */
export function buildSwimmers(): void {
  const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
    life: { art: { model: string } };
  };
  const nodes: NodeDef[] = SWIMMERS.map((s) => ({
    name: s.name,
    extras: { length: s.length },
    primitives: [s.build(s.length).m.primitive({ colors: true })],
  }));
  // One material: the page makes its own from the vertices' colours.
  const materials: MaterialDef[] = [
    { name: 'swimmers', color: [1, 1, 1], roughness: 0.6, metalness: 0 },
  ];
  const raw = writeGlb([{ name: 'swimmers', children: nodes }], materials);
  mkdirSync('.dev/art', { recursive: true });
  writeFileSync('.dev/art/life.raw.glb', raw);

  const found = probe(raw);
  const faults: string[] = [];
  for (const s of SWIMMERS) {
    const p = found.get(s.name);
    if (p === undefined) {
      faults.push(`${s.name}: missing`);
      continue;
    }
    const [w, h, l] = p.size;
    process.stdout.write(
      `${s.name}: length ${l.toFixed(3)} m, width ${w.toFixed(3)} m, height ${h.toFixed(3)} m, ${p.triangles} triangles\n`,
    );
    if (Math.abs(l - s.length) > 0.02 * s.length) {
      faults.push(`${s.name}: ${l.toFixed(3)} m long, built at ${s.length} m`);
    }
    if (Math.abs(p.mid[2]) > 0.01 * s.length) {
      faults.push(`${s.name}: its middle is ${p.mid[2].toFixed(3)} m off its origin along z`);
    }
    if (p.triangles > s.budget) {
      faults.push(`${s.name}: ${p.triangles} triangles, over its ${s.budget}`);
    }
  }
  if (faults.length > 0) {
    process.stderr.write(`${faults.join('\n')}\n`);
    process.exit(1);
  }

  execFileSync(
    'client/node_modules/.bin/gltfpack',
    [
      '-i',
      '.dev/art/life.raw.glb',
      '-o',
      `art/${catalog.life.art.model}`,
      '-c',
      '-kn',
      '-km',
      '-kv',
      '-ke',
      '-noq',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write(`wrote art/${catalog.life.art.model}\n`);
}

// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// A brown booby perched, awake and asleep: not lofted along its length as
// the swimmers are, but drawn in a frame of its own, metres, its feet on
// the deck, and then set on its feet at y = 0, centred along its length
// and scaled to the length it is built at.
//
// The brown booby (Sula leucogaster): 64-85 cm long; a dark brown head,
// neck, breast, back, wings and long wedge-shaped tail, the brown ending
// in a sharp straight line across the lower breast above a white belly; a
// long, conical, pointed bill, pale yellow, and the bare face about it;
// large webbed feet, yellow (Cornell Lab, Birds of the World; Harrison,
// Seabirds). Perched it stands tilted nose up on short legs, its wings
// folded along its flanks, their tips crossing over the tail; asleep it
// sits hunched on its feet with its head turned back and laid on its
// back, the bill tucked under the scapulars.

import { add, cross, normalize, scale, sub, type Vec3 } from '../../lib/mesh.ts';
import { Body, type Corner } from './body.ts';

/** A body drawn in metres in a frame of its own, each corner placed as its triangle is laid. */
class Placed extends Body {
  place: (p: Vec3) => Vec3 = (p) => p;

  override tri(a: Corner, b: Corner, c: Corner, want: Vec3, paddle = false): void {
    const f = this.place;
    const mid: Vec3 = [
      (a.p[0] + b.p[0] + c.p[0]) / 3,
      (a.p[1] + b.p[1] + c.p[1]) / 3,
      (a.p[2] + b.p[2] + c.p[2]) / 3,
    ];
    const toward = sub(f(add(mid, scale(normalize(want), 0.001))), f(mid));
    super.tri({ ...a, p: f(a.p) }, { ...b, p: f(b.p) }, { ...c, p: f(c.p) }, toward, paddle);
  }
}

/** A ring of a tube: its centre, its heights above and below the centre line, its half-width, and its paint by its c (1 the ring's top, -1 its bottom). */
interface Ring {
  p: Vec3;
  top: number;
  bot: number;
  w: number;
  paint: (c: number) => { r: number; g?: number };
}

const isPoint = (r: Ring): boolean => r.top === 0 && r.bot === 0 && r.w === 0;

/**
 * A tube through rings along a path in the y-z plane, each ring square to
 * the path, its top toward the path's left as it runs forward and up: the
 * back of a neck, the crown of a head. A first ring that is not a point is
 * left open, sunk in the body.
 */
function tube(b: Body, rings: Ring[], sides: number, full = 0.85): void {
  const corners = rings.map((ring, i) => {
    const prev = (rings[Math.max(0, i - 1)] as Ring).p;
    const next = (rings[Math.min(rings.length - 1, i + 1)] as Ring).p;
    const t = normalize(sub(next, prev));
    const across = normalize(sub([1, 0, 0], scale(t, t[0])));
    const up = cross(across, t);
    const out: Corner[] = [];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * 2 * Math.PI;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const x = ring.w * Math.sign(sn) * Math.abs(sn) ** full;
      const y = (c >= 0 ? ring.top : ring.bot) * Math.sign(c) * Math.abs(c) ** full;
      const pt = ring.paint(isPoint(ring) ? 0 : c);
      out.push({ p: add(ring.p, add(scale(across, x), scale(up, y))), r: pt.r, g: pt.g ?? 0 });
    }
    return out;
  });
  for (let i = 0; i + 1 < rings.length; i++) {
    const ra = corners[i] as Corner[];
    const rb = corners[i + 1] as Corner[];
    const centre = scale(add((rings[i] as Ring).p, (rings[i + 1] as Ring).p), 0.5);
    const want = (cs: Corner[]): Vec3 =>
      sub(
        scale(
          cs.reduce<Vec3>((acc, x) => add(acc, x.p), [0, 0, 0]),
          1 / cs.length,
        ),
        centre,
      );
    for (let j = 0; j < sides; j++) {
      const a0 = ra[j] as Corner;
      const a1 = ra[(j + 1) % sides] as Corner;
      const b0 = rb[j] as Corner;
      const b1 = rb[(j + 1) % sides] as Corner;
      if (isPoint(rings[i] as Ring)) {
        b.tri(a0, b0, b1, want([a0, b0, b1]));
      } else if (isPoint(rings[i + 1] as Ring)) {
        b.tri(a0, a1, b0, want([a0, a1, b0]));
      } else {
        b.tri(a0, a1, b1, want([a0, a1, b1]));
        b.tri(a0, b1, b0, want([a0, b1, b0]));
      }
    }
  }
}

/** A thin solid fanned from its outline's middle: a low ridge on each face, its upper face toward up. */
function plate(
  b: Body,
  outline: Vec3[],
  up: Vec3,
  thick: number,
  r: [number, number],
  g = 0,
): void {
  const mid = scale(
    outline.reduce<Vec3>((acc, p) => add(acc, p), [0, 0, 0]),
    1 / outline.length,
  );
  const n = normalize(up);
  for (const side of [1, -1]) {
    const face = side > 0 ? r[0] : r[1];
    const ridge: Corner = { p: add(mid, scale(n, thick * side)), r: face };
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i] as Vec3;
      const q = outline[(i + 1) % outline.length] as Vec3;
      b.tri(ridge, { p, r: face, g }, { p: q, r: face, g }, scale(n, side));
    }
  }
}

/** A sheet of two faces between an upper edge and a lower, closed at a tip: a folded wing. Its outer face is toward out. */
function sheet(
  b: Body,
  upper: Vec3[],
  lower: Vec3[],
  tip: Vec3,
  out: Vec3,
  marks: number[],
  tipMark: number,
): void {
  for (const side of [1, -1]) {
    const want = scale(out, side);
    const u = upper.map((p, i) => ({ p, r: 1, g: marks[i] ?? 0 }));
    const l = lower.map((p, i) => ({ p, r: 1, g: marks[i] ?? 0 }));
    for (let i = 0; i + 1 < u.length; i++) {
      b.quad(u[i] as Corner, u[i + 1] as Corner, l[i + 1] as Corner, l[i] as Corner, want);
    }
    const last = u.length - 1;
    b.tri(u[last] as Corner, { p: tip, r: 1, g: tipMark }, l[last] as Corner, want);
  }
}

/** The bird's pose: how far its body is tilted nose up, degrees; where its body's middle is, m, its feet on the deck at y = 0; how fluffed its feathers are; how far its tail's tip is raised from the body's line, m; and whether it sleeps. */
interface Pose {
  tilt: number;
  centre: Vec3;
  fluff: number;
  tail: number;
  asleep: boolean;
}

const AWAKE: Pose = { tilt: 30, centre: [0, 0.135, 0.02], fluff: 1, tail: 0.075, asleep: false };
const ASLEEP: Pose = { tilt: 10, centre: [0, 0.09, 0.03], fluff: 1.1, tail: 0, asleep: true };

/** Draws the bird in its own frame, metres: its bill toward -z, its feet on y = 0. */
function draw(b: Body, pose: Pose): void {
  const tilt = (pose.tilt * Math.PI) / 180;
  const d: Vec3 = [0, Math.sin(tilt), -Math.cos(tilt)];
  const e: Vec3 = [0, Math.cos(tilt), Math.sin(tilt)];
  const k = pose.fluff;
  // A point t along the body's axis forward of its middle, h above it, x to its right.
  const at = (t: number, h: number, x: number): Vec3 =>
    add(pose.centre, add(scale(d, t), add(scale(e, h * k), [x * k, 0, 0])));
  // The body, from the tail's root forward: brown to the lower breast,
  // white beneath behind it.
  const body: [number, number, number, number, boolean][] = [
    [-0.2, 0, 0, 0, true],
    [-0.185, 0.016, 0.01, 0.02, true],
    [-0.1, 0.052, 0.05, 0.054, true],
    [-0.04, 0.063, 0.066, 0.066, true],
    [0.025, 0.064, 0.072, 0.066, true],
    [0.035, 0.063, 0.072, 0.066, false],
    [0.075, 0.058, 0.068, 0.06, false],
    [0.125, 0.04, 0.046, 0.042, false],
    [0.15, 0, 0, 0, false],
  ];
  tube(
    b,
    body.map(([t, top, bot, w, white]) => ({
      p: at(t, 0, 0),
      top: top * k,
      bot: bot * k,
      w: w * k,
      paint: (c: number) => ({ r: white && c < 0.3 ? 0 : 1 }),
    })),
    8,
  );
  // The neck and head; awake, the bill.
  const ring = (p: Vec3, top: number, bot: number, w: number, r = 1): Ring => ({
    p,
    top,
    bot,
    w,
    paint: () => ({ r }),
  });
  if (pose.asleep) {
    // Turned back and laid on the back, the face sunk under the scapulars.
    tube(
      b,
      [
        ring([0, 0.12, -0.06], 0.04, 0.04, 0.035),
        ring([0, 0.16, -0.05], 0.034, 0.034, 0.03),
        ring([0.004, 0.18, -0.03], 0.035, 0.033, 0.032),
        ring([0.01, 0.185, 0], 0.036, 0.033, 0.034),
        ring([0.018, 0.172, 0.03], 0.026, 0.026, 0.024),
        ring([0.024, 0.15, 0.05], 0, 0, 0),
      ],
      6,
    );
  } else {
    tube(
      b,
      [
        ring([0, 0.21, -0.075], 0.045, 0.045, 0.04),
        ring([0, 0.26, -0.1], 0.038, 0.04, 0.034),
        ring([0, 0.3, -0.115], 0.036, 0.036, 0.032),
        ring([0, 0.33, -0.125], 0.036, 0.036, 0.033),
        ring([0, 0.345, -0.15], 0.038, 0.034, 0.034),
        ring([0, 0.343, -0.18], 0.03, 0.03, 0.027),
        // The bare face at the bill's base, and the bill.
        ring([0, 0.336, -0.205], 0.022, 0.024, 0.019, 0.5),
        ring([0, 0.33, -0.245], 0.013, 0.015, 0.011, 0),
        ring([0, 0.322, -0.28], 0.007, 0.008, 0.006, 0),
        ring([0, 0.314, -0.312], 0, 0, 0, 0),
      ],
      6,
    );
    // The eyes, pale, either side of the head.
    for (const m of [1, -1]) {
      const [x, y, z] = [0.035 * m, 0.352, -0.16];
      b.quad(
        { p: [x, y + 0.006, z], r: 0, g: 0.2 },
        { p: [x, y, z - 0.008], r: 0, g: 0.2 },
        { p: [x, y - 0.006, z], r: 0, g: 0.2 },
        { p: [x, y, z + 0.008], r: 0, g: 0.2 },
        [m, 0, 0],
      );
    }
  }
  // The long wedge of the tail.
  plate(
    b,
    [
      at(-0.17, 0.012, -0.022),
      at(-0.27, 0.012 + pose.tail * 0.4, -0.03),
      at(-0.39, pose.tail, 0),
      at(-0.27, 0.012 + pose.tail * 0.4, 0.03),
      at(-0.17, 0.012, 0.022),
    ],
    e,
    0.006,
    [1, 1],
  );
  for (const m of [1, -1]) {
    // The wings folded along the flanks, their tips crossing over the tail.
    sheet(
      b,
      [
        at(0.1, 0.045, 0.05 * m),
        at(0.03, 0.06, 0.06 * m),
        at(-0.06, 0.056, 0.055 * m),
        at(-0.15, 0.04, 0.036 * m),
      ],
      [
        at(0.085, -0.02, 0.064 * m),
        at(0.02, -0.03, 0.08 * m),
        at(-0.07, -0.024, 0.076 * m),
        at(-0.16, -0.008, 0.048 * m),
      ],
      at(-0.29, 0.02 + pose.tail * 0.5, 0.012 * m),
      [m, 0, 0],
      [0, 0, 0.2, 0.4],
      0.5,
    );
    // The feet, webbed, flat on the deck, their toes forward.
    const back = pose.asleep ? 0.025 : 0;
    const foot = (x: number, z: number): Vec3 => [x * m, 0.004, z + back];
    plate(
      b,
      [
        foot(0.034, 0.012),
        foot(0.072, -0.052),
        foot(0.052, -0.042),
        foot(0.042, -0.068),
        foot(0.03, -0.04),
        foot(0.012, -0.05),
      ],
      [0, 1, 0],
      0.004,
      [0, 0],
    );
    if (!pose.asleep) {
      // The short legs, from under the belly to the feet.
      tube(
        b,
        [
          ring([0.03 * m, 0.09, 0.0], 0.016, 0.016, 0.014, 0),
          ring([0.035 * m, 0.015, 0.002], 0.009, 0.009, 0.009, 0),
          ring([0.036 * m, 0.004, -0.008], 0, 0, 0, 0),
        ],
        4,
        1,
      );
    }
  }
}

/** The bird drawn, then set on its feet, centred along z and scaled to length. */
function perched(length: number, pose: Pose): Body {
  const draft = new Placed(length);
  draw(draft, pose);
  const ps = draft.m.positions;
  let [y0, z0, z1] = [Infinity, Infinity, -Infinity];
  for (let i = 0; i < ps.length; i += 3) {
    y0 = Math.min(y0, ps[i + 1] as number);
    z0 = Math.min(z0, ps[i + 2] as number);
    z1 = Math.max(z1, ps[i + 2] as number);
  }
  const k = length / (z1 - z0);
  const zm = (z0 + z1) / 2;
  const b = new Placed(length);
  b.place = (p) => [p[0] * k, (p[1] - y0) * k, (p[2] - zm) * k];
  draw(b, pose);
  return b;
}

/** A brown booby standing on its feet. */
export function booby(length: number): Body {
  return perched(length, AWAKE);
}

/** A brown booby asleep, sitting on its feet, its head turned back on its back. */
export function boobyAsleep(length: number): Body {
  return perched(length, ASLEEP);
}

// SPDX-License-Identifier: AGPL-3.0-only

// The offline sandbox's lookout: what a boat sees of the world, by the
// sight table the server builds (internal/sight), written beside the
// sandbox's world file. Its looks are the server's, rule for rule, so the
// sandbox charts as a server would; the server's, online, are the ones
// that count.

/** A sight table, as the server exports it. */
export interface SightExport {
  subjects: number;
  rays: number;
  dome: number;
  eyes: number[];
  lnThreshold: number;
  /** Each cell's x, y, the horizon's distance from its top, and its top, m. */
  cells: [number, number, number, number][];
  cellSubjects: number[];
  views: {
    X: number;
    Y: number;
    Top: number;
    Far2: number;
    Subject: number;
    Near: number[];
    Far: number[];
  }[];
  awash: { X: number; Y: number; Reach: number; Subject: number }[];
  lights: { X: number; Y: number; Focal: number; Range: number; LnI: number; Subject: number }[];
  with: Record<string, number[]>;
}

/**
 * The air a look sees through: the optical depth along the straight line
 * from (x0, y0), h0 m above the sea, to (x1, y1), h1 m above it, as the
 * physics module gives it from the weather at the tick, and the depth a
 * thing is seen through at most.
 */
export interface Air {
  depth(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number): number;
  contrast: number;
}

/** The height a cove's or an awash thing's water is looked at, m. */
const WATER_TOP = 1;

/**
 * What a lookout at (x, y), its eye eye m high, sees of what charted does
 * not hold through the air: each subject once, by its index in the table.
 * lit says which lights are lit, by index, and thresholds the ln lux each
 * is seen against (the table's night's for any not given).
 */
export function look(
  t: SightExport,
  x: number,
  y: number,
  eye: number,
  charted: ReadonlySet<number>,
  air: Air,
  lit: readonly boolean[] = [],
  thresholds: readonly number[] = [],
): number[] {
  const out = new Set<number>();
  const seen = (tx: number, ty: number, top: number): boolean =>
    air.depth(x, y, eye, tx, ty, top) <= air.contrast;
  const reach = Math.sqrt(2 * t.dome * eye);
  let e = 0;
  for (let i = 0; i < t.eyes.length; i++) {
    if ((t.eyes[i] ?? 0) <= eye) {
      e = i;
    }
  }
  // Each island over the horizon: its nearest cell over it and its
  // highest, seen along the line to the nearest, or else to the highest.
  const islands = new Map<number, { near: number; d2: number; high: number }>();
  t.cells.forEach(([cx, cy, high, top], i) => {
    const s = t.cellSubjects[i] ?? -1;
    if (charted.has(s)) {
      return;
    }
    const r = reach + high;
    const d2 = (cx - x) ** 2 + (cy - y) ** 2;
    if (d2 > r * r) {
      return;
    }
    const o = islands.get(s);
    if (o === undefined) {
      islands.set(s, { near: i, d2, high: i });
      return;
    }
    if (d2 < o.d2) {
      o.near = i;
      o.d2 = d2;
    }
    if (top > (t.cells[o.high]?.[3] ?? 0)) {
      o.high = i;
    }
  });
  for (const v of t.views) {
    if (charted.has(v.Subject) || out.has(v.Subject)) {
      continue;
    }
    const dx = x - v.X;
    const dy = y - v.Y;
    const d2 = dx * dx + dy * dy;
    if (d2 > v.Far2) {
      continue;
    }
    const d = Math.sqrt(d2);
    let a = Math.atan2(dx, dy);
    if (a < 0) {
      a += 2 * Math.PI;
    }
    let k = Math.floor((a * t.rays) / (2 * Math.PI) + 0.5);
    if (k >= t.rays) {
      k -= t.rays;
    }
    const near = v.Near[e * t.rays + k] ?? -1;
    const far = v.Far[e * t.rays + k] ?? -1;
    if (near >= 0 && d >= near && d <= far && seen(v.X, v.Y, v.Top)) {
      out.add(v.Subject);
    }
  }
  for (const a of t.awash) {
    if (charted.has(a.Subject) || out.has(a.Subject)) {
      continue;
    }
    if ((a.X - x) ** 2 + (a.Y - y) ** 2 <= a.Reach * a.Reach && seen(a.X, a.Y, WATER_TOP)) {
      out.add(a.Subject);
    }
  }
  for (const [s, o] of islands) {
    const n = t.cells[o.near];
    const h = t.cells[o.high];
    if (n === undefined || h === undefined) {
      continue;
    }
    if (seen(n[0], n[1], n[3]) || (o.high !== o.near && seen(h[0], h[1], h[3]))) {
      out.add(s);
    }
  }
  t.lights.forEach((l, i) => {
    if (!lit[i] || charted.has(l.Subject) || out.has(l.Subject)) {
      return;
    }
    const d = Math.hypot(l.X - x, l.Y - y);
    if (d > l.Range) {
      return;
    }
    const tau = air.depth(x, y, eye, l.X, l.Y, l.Focal);
    const thr = thresholds[i] ?? t.lnThreshold;
    if (d < 1 || l.LnI - tau - 2 * Math.log(d) >= thr) {
      out.add(l.Subject);
    }
  });
  return [...out];
}

/** The subjects charted with s: its island's features seen from no water. */
export function chartedWith(t: SightExport, s: number): number[] {
  return t.with[String(s)] ?? [];
}

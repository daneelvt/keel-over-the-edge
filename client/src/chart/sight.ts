// SPDX-License-Identifier: AGPL-3.0-only

// The offline sandbox's lookout: what a boat sees of the world, by the
// sight table the server builds (internal/sight), written beside the
// sandbox's world file. Its looks are the server's, rule for rule, so the
// sandbox charts as a server would; the server's, online, are the ones
// that count.

/** The mist band's visibility, as the table carries it. */
export interface Visibility {
  Band: number;
  Lip: number;
  Clear: number;
  Range: number;
}

/** A sight table, as the server exports it. */
export interface SightExport {
  subjects: number;
  rays: number;
  dome: number;
  eyes: number[];
  visibility: Visibility;
  lnThreshold: number;
  cells: [number, number, number, number][];
  cellSubjects: number[];
  views: {
    X: number;
    Y: number;
    Vis: number;
    Far2: number;
    Subject: number;
    Near: number[];
    Far: number[];
  }[];
  awash: { X: number; Y: number; Reach: number; Subject: number }[];
  lights: { X: number; Y: number; Range: number; Vis: number; LnI: number; Subject: number }[];
  with: Record<string, number[]>;
}

const KOSCHMIEDER = 3.912;
const NAUTICAL_MILE = 1852;
const LN_TWENTIETH = Math.log(0.05);

/** The visual range at the sea r m from the centre, m: physics.VisualRangeAt. */
export function visualRange(v: Visibility, r: number): number {
  const m = Math.min(Math.max((r - v.Band) / (v.Lip - v.Band), 0), 1);
  const clear = KOSCHMIEDER / v.Clear;
  const sigma = Math.max(KOSCHMIEDER / v.Range - clear, 0);
  return KOSCHMIEDER / (clear + sigma * m);
}

/**
 * What a lookout at (x, y), its eye eye m high, sees of what charted does
 * not hold: each subject once, by its index in the table. lit says which
 * lights are lit, by index.
 */
export function look(
  t: SightExport,
  x: number,
  y: number,
  eye: number,
  charted: ReadonlySet<number>,
  lit: readonly boolean[] = [],
): number[] {
  const out = new Set<number>();
  const vis = visualRange(t.visibility, Math.hypot(x, y));
  const reach = Math.sqrt(2 * t.dome * eye);
  let e = 0;
  for (let i = 0; i < t.eyes.length; i++) {
    if ((t.eyes[i] ?? 0) <= eye) {
      e = i;
    }
  }
  t.cells.forEach(([cx, cy, high, cvis], i) => {
    const s = t.cellSubjects[i] ?? -1;
    if (charted.has(s) || out.has(s)) {
      return;
    }
    const r = Math.min(reach + high, vis, cvis);
    if ((cx - x) ** 2 + (cy - y) ** 2 <= r * r) {
      out.add(s);
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
    if (d > vis || d > v.Vis) {
      continue;
    }
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
    if (near >= 0 && d >= near && d <= far) {
      out.add(v.Subject);
    }
  }
  for (const a of t.awash) {
    if (charted.has(a.Subject) || out.has(a.Subject)) {
      continue;
    }
    const r = Math.min(a.Reach, vis);
    if ((a.X - x) ** 2 + (a.Y - y) ** 2 <= r * r) {
      out.add(a.Subject);
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
    const v = Math.min(vis, l.Vis);
    const lnT = (LN_TWENTIETH * NAUTICAL_MILE) / v;
    if (d < 1 || l.LnI + (d / NAUTICAL_MILE) * lnT - 2 * Math.log(d) >= t.lnThreshold) {
      out.add(l.Subject);
    }
  });
  return [...out];
}

/** The subjects charted with s: its island's features seen from no water. */
export function chartedWith(t: SightExport, s: number): number[] {
  return t.with[String(s)] ?? [];
}

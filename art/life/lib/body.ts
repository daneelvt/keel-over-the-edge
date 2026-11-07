// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// A swimmer's body, built of flat triangles, each with its own three
// vertices and its own normal, so that it stays faceted however it is
// packed. Every vertex carries what the page reads to paint and move it:
//
//   colour r  the back's share: 1 the kind's back colour, 0 its belly's
//   colour g  a dark mark: an eye, a mouth, a fin's edge, a seam
//   colour b  1 for a paddle, a part that strokes on its own; 0 for the body
//   uv u      its share along the body, snout tip 0 to tail tip 1, by its z
//   uv v      a paddle's share out from its root to its tip; 0 for the body
//
// A body is laid out as the boats are: +y up, -z toward the snout, +x to
// the animal's right, its origin halfway along its length on its spine.
// Its shapes are given in fractions of its length: x across, y up, and s
// along from the snout tip (0) to the tail tip (1).

import { cross, MeshBuilder, normalize, sub, type Vec3 } from '../../lib/mesh.ts';

/** A corner of a triangle: where it is, its back's share r, its mark g and, on a paddle, its share v out along it. */
export interface Corner {
  p: Vec3;
  r: number;
  g?: number;
  v?: number;
}

/** A ring of the body's loft: at s, its back's and belly's heights, its half-width, and the height of its widest line. */
export interface Station {
  s: number;
  top: number;
  bot: number;
  w: number;
  mid?: number;
}

/** A loft's paint: its back's share and its mark at s, on its ring at c (1 the back's line, -1 the belly's). */
export type Paint = (s: number, c: number) => { r: number; g?: number };

/** A chord across a fin, root to tip: its leading and trailing points (x, y, s) and its half-thickness, fractions of the length. */
export interface Chord {
  lead: Vec3;
  trail: Vec3;
  thick: number;
}

/** A fin's paint: the back's share on its upper face and its lower, and the marks of its edges. */
export interface FinPaint {
  r: [number, number];
  lead?: number;
  trail?: number;
  tip?: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

export class Body {
  readonly m = new MeshBuilder('swimmers');
  readonly length: number;

  constructor(length: number) {
    this.length = length;
  }

  get triangles(): number {
    return this.m.indices.length / 3;
  }

  /** A point given in fractions of the length, in metres. */
  at(p: Vec3): Vec3 {
    const L = this.length;
    return [p[0] * L, p[1] * L, (p[2] - 0.5) * L];
  }

  /** A flat triangle, its front toward want. */
  tri(a: Corner, b: Corner, c: Corner, want: Vec3, paddle = false): void {
    let n = cross(sub(b.p, a.p), sub(c.p, a.p));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) {
      return;
    }
    let [p, q, r] = [a, b, c];
    if (dot(n, want) < 0) {
      [q, r] = [r, q];
      n = [-n[0], -n[1], -n[2]];
    }
    const nn = normalize(n);
    const k = [p, q, r].map((x) => {
      const u = clamp01(x.p[2] / this.length + 0.5);
      const i = this.m.vertex(
        x.p,
        [x.r, x.g ?? 0, paddle ? 1 : 0],
        [u, paddle ? clamp01(x.v ?? 0) : 0],
      );
      this.m.normal(i, nn);
      return i;
    });
    this.m.tri(k[0] as number, k[1] as number, k[2] as number);
  }

  /** A quad a-b-c-d as two flat triangles, their fronts toward want. */
  quad(a: Corner, b: Corner, c: Corner, d: Corner, want: Vec3, paddle = false): void {
    this.tri(a, b, c, want, paddle);
    this.tri(a, c, d, want, paddle);
  }

  /**
   * A loft through stations, each a ring of sides corners from the back's
   * line (c = 1) round by the right flank to the belly's and back by the
   * left. A station of no width and no height is a point, closing the loft.
   * Fullness under 1 swells the rings from their polygon toward a box.
   */
  loft(stations: Station[], sides: number, paint: Paint, fullness = 0.85): Surface {
    const surface = new Surface(this, stations, sides, paint, fullness);
    for (let i = 0; i + 1 < stations.length; i++) {
      const a = stations[i] as Station;
      const b = stations[i + 1] as Station;
      const ra = surface.ring(a);
      const rb = surface.ring(b);
      const mid = (surface.mid(a) + surface.mid(b)) / 2;
      const want = (cs: Corner[]): Vec3 => {
        const c = cs.reduce<Vec3>(
          (acc, x) => [
            acc[0] + x.p[0] / cs.length,
            acc[1] + x.p[1] / cs.length,
            acc[2] + x.p[2] / cs.length,
          ],
          [0, 0, 0],
        );
        return sub(c, [0, mid * this.length, c[2]]);
      };
      for (let j = 0; j < sides; j++) {
        const a0 = ra[j] as Corner;
        const a1 = ra[(j + 1) % sides] as Corner;
        const b0 = rb[j] as Corner;
        const b1 = rb[(j + 1) % sides] as Corner;
        if (isPoint(a)) {
          this.tri(a0, b0, b1, want([a0, b0, b1]));
        } else if (isPoint(b)) {
          this.tri(a0, a1, b0, want([a0, a1, b0]));
        } else {
          this.tri(a0, a1, b1, want([a0, a1, b1]));
          this.tri(a0, b1, b0, want([a0, b1, b0]));
        }
      }
    }
    return surface;
  }

  /**
   * A fin of chords from its root to its tip, a thin solid: a ridge runs
   * along its thickest line, a third of its chord back from its leading
   * edge, and each face falls from it to an edge. Its root is left open,
   * sunk in the body. A paddle's v grows from its root chord to its tip.
   * The right's fin is given; mirror builds the left's.
   */
  fin(chords: Chord[], tip: Vec3, up: Vec3, paint: FinPaint, paddle = false, mirror = false): void {
    const f = (p: Vec3): Vec3 => this.at(mirror ? [-p[0], p[1], p[2]] : p);
    const leads = chords.map((c) => f(c.lead));
    const trails = chords.map((c) => f(c.trail));
    const end = f(tip);
    const root = mix(leads[0] as Vec3, trails[0] as Vec3, 0.5);
    const span = sub(end, root);
    const reach = Math.hypot(span[0], span[1], span[2]);
    const along = normalize(span);
    const v = (p: Vec3): number => dot(sub(p, root), along) / reach;
    let n = normalize(cross(sub(trails[0] as Vec3, leads[0] as Vec3), span));
    const upward: Vec3 = mirror ? [-up[0], up[1], up[2]] : up;
    if (dot(n, upward) < 0) {
      n = [-n[0], -n[1], -n[2]];
    }
    for (const side of [1, -1]) {
      const r = side > 0 ? paint.r[0] : paint.r[1];
      const corner = (p: Vec3, g: number): Corner => ({ p, r, g, v: v(p) });
      const ridge = chords.map((c, i) => {
        const p = mix(leads[i] as Vec3, trails[i] as Vec3, 0.35);
        const t = c.thick * this.length * side;
        return corner([p[0] + n[0] * t, p[1] + n[1] * t, p[2] + n[2] * t], 0);
      });
      const lead = leads.map((p) => corner(p, paint.lead ?? 0));
      const trail = trails.map((p) => corner(p, paint.trail ?? 0));
      const want: Vec3 = [n[0] * side, n[1] * side, n[2] * side];
      for (let i = 0; i + 1 < chords.length; i++) {
        const [l0, l1, m0, m1, t0, t1] = [
          lead[i],
          lead[i + 1],
          ridge[i],
          ridge[i + 1],
          trail[i],
          trail[i + 1],
        ] as Corner[];
        this.quad(l0 as Corner, l1 as Corner, m1 as Corner, m0 as Corner, want, paddle);
        this.quad(m0 as Corner, m1 as Corner, t1 as Corner, t0 as Corner, want, paddle);
      }
      const last = chords.length - 1;
      const top = corner(end, paint.tip ?? paint.trail ?? 0);
      this.tri(lead[last] as Corner, top, ridge[last] as Corner, want, paddle);
      this.tri(ridge[last] as Corner, top, trail[last] as Corner, want, paddle);
    }
  }
}

const isPoint = (st: Station): boolean => st.w === 0 && st.top === st.bot;

/** A loft's surface: its rings, and points on it between them for the marks laid on it. */
export class Surface {
  readonly body: Body;
  readonly stations: Station[];
  readonly sides: number;
  readonly paint: Paint;
  readonly fullness: number;

  constructor(body: Body, stations: Station[], sides: number, paint: Paint, fullness: number) {
    this.body = body;
    this.stations = stations;
    this.sides = sides;
    this.paint = paint;
    this.fullness = fullness;
  }

  mid(st: Station): number {
    return st.mid ?? (st.top + st.bot) / 2;
  }

  /** A ring's corner j, in fractions of the length, and its c. */
  corner(st: Station, j: number): { p: Vec3; c: number } {
    const a = (j / this.sides) * 2 * Math.PI;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const mid = this.mid(st);
    const h = c >= 0 ? st.top - mid : mid - st.bot;
    const e = this.fullness;
    const x = st.w * Math.sign(sn) * Math.abs(sn) ** e;
    const y = mid + h * Math.sign(c) * Math.abs(c) ** e;
    return { p: [x, y, st.s], c };
  }

  ring(st: Station): Corner[] {
    const out: Corner[] = [];
    for (let j = 0; j < this.sides; j++) {
      const { p, c } = this.corner(st, j);
      const pt = this.paint(st.s, isPoint(st) ? 0 : c);
      out.push({ p: this.body.at(p), r: pt.r, g: pt.g ?? 0 });
    }
    return out;
  }

  /** The loft's stations about s, and s's share of the way between them. */
  #bracket(s: number): [Station, Station, number] {
    const st = this.stations;
    let i = 0;
    while (i + 2 < st.length && (st[i + 1] as Station).s < s) {
      i++;
    }
    const a = st[i] as Station;
    const b = st[i + 1] as Station;
    return [a, b, clamp01((s - a.s) / (b.s - a.s))];
  }

  /** The station between the loft's stations at s. */
  station(s: number): Station {
    const [a, b, t] = this.#bracket(s);
    return {
      s,
      top: lerp(a.top, b.top, t),
      bot: lerp(a.bot, b.bot, t),
      w: lerp(a.w, b.w, t),
      mid: lerp(this.mid(a), this.mid(b), t),
    };
  }

  /** The height of the ring's corner j at s: a line through such heights lies along the loft's faces, not across its creases. */
  y(s: number, j: number): number {
    return this.corner(this.station(s), j).p[1];
  }

  /**
   * The point at s on the right flank at height y, fractions of the
   * length: found between the corners of the ring at s, and then laid on
   * the loft's own triangle there, so that a mark sits on its face.
   */
  point(s: number, y: number): Vec3 {
    const st = this.station(s);
    const half = this.sides / 2;
    let j = half - 1;
    let f = 1;
    if (y > this.corner(st, 0).p[1]) {
      [j, f] = [0, 0];
    } else {
      for (let k = 0; k < half; k++) {
        const a = this.corner(st, k).p;
        const b = this.corner(st, k + 1).p;
        if (y <= a[1] && y >= b[1]) {
          [j, f] = [k, a[1] === b[1] ? 0 : (a[1] - y) / (a[1] - b[1])];
          break;
        }
      }
    }
    const [a, b, t] = this.#bracket(s);
    const a0 = this.corner(a, j).p;
    const a1 = this.corner(a, j + 1).p;
    const b0 = this.corner(b, j).p;
    const b1 = this.corner(b, j + 1).p;
    if (isPoint(a) || isPoint(b)) {
      return mix(mix(a0, a1, f), mix(b0, b1, f), t);
    }
    // The quad's two triangles, a0-a1-b1 and a0-b1-b0, as loft() lays them.
    if (f >= t) {
      return [0, 1, 2].map(
        (k) =>
          (a0[k] as number) +
          f * ((a1[k] as number) - (a0[k] as number)) +
          t * ((b1[k] as number) - (a1[k] as number)),
      ) as Vec3;
    }
    return [0, 1, 2].map(
      (k) =>
        (a0[k] as number) +
        t * ((b0[k] as number) - (a0[k] as number)) +
        f * ((b1[k] as number) - (b0[k] as number)),
    ) as Vec3;
  }

  /** The outward normal at s and y on the right flank. */
  normal(s: number, y: number): Vec3 {
    const d = 0.004;
    const a = this.point(s - d, y);
    const b = this.point(s + d, y);
    const c = this.point(s, y + d);
    const e = this.point(s, y - d);
    let n = normalize(cross(sub(b, a), sub(c, e)));
    const out = sub(this.point(s, y), [0, this.mid(this.station(s)), s]);
    if (dot(n, out) < 0) {
      n = [-n[0], -n[1], -n[2]];
    }
    return n;
  }

  /** A dark spot lying on the flank at s, y, both sides: a diamond along by across, fractions of the length. */
  spot(s: number, y: number, along: number, across: number, g = 1): void {
    const n = this.normal(s, y);
    const lift = 0.004;
    const c = this.point(s, y);
    const ts = normalize(sub(this.point(s + 0.01, y), this.point(s - 0.01, y)));
    const ty = normalize(cross(n, ts));
    const p = (a: number, b: number): Vec3 => [
      c[0] + n[0] * lift + ts[0] * a + ty[0] * b,
      c[1] + n[1] * lift + ts[1] * a + ty[1] * b,
      c[2] + n[2] * lift + ts[2] * a + ty[2] * b,
    ];
    this.#mark([p(-along, 0), p(0, across), p(along, 0), p(0, -across)], n, s, y, g);
  }

  /** A dark line lying on the flank through points (s, y), both sides, width wide, fractions of the length. */
  line(points: [number, number][], width: number, g = 1): void {
    const lift = 0.004;
    const rows = points.map(([s, y], i) => {
      const n = this.normal(s, y);
      const c = this.point(s, y);
      const [ps, py] = points[Math.max(0, i - 1)] as [number, number];
      const [ns, ny] = points[Math.min(points.length - 1, i + 1)] as [number, number];
      const t = normalize(sub(this.point(ns, ny), this.point(ps, py)));
      const w = normalize(cross(n, t));
      const at = (k: number): Vec3 => [
        c[0] + n[0] * lift + w[0] * k,
        c[1] + n[1] * lift + w[1] * k,
        c[2] + n[2] * lift + w[2] * k,
      ];
      return { a: at(width / 2), b: at(-width / 2), n };
    });
    for (let i = 0; i + 1 < rows.length; i++) {
      const p = rows[i] as { a: Vec3; b: Vec3; n: Vec3 };
      const q = rows[i + 1] as { a: Vec3; b: Vec3; n: Vec3 };
      const [s, y] = points[i] as [number, number];
      this.#mark([p.a, q.a, q.b, p.b], normalize(mix(p.n, q.n, 0.5)), s, y, g);
    }
  }

  /** A quad of a mark, on the right flank and mirrored on the left. */
  #mark(q: Vec3[], n: Vec3, s: number, y: number, g: number): void {
    const st = this.station(s);
    const h = y >= this.mid(st) ? st.top - this.mid(st) : this.mid(st) - st.bot;
    // The ring's c whose corner stands at this height.
    const f = h === 0 ? 0 : Math.min(Math.max((y - this.mid(st)) / h, -1), 1);
    const r = this.paint(s, Math.sign(f) * Math.abs(f) ** (1 / this.fullness)).r;
    for (const m of [1, -1]) {
      const cs = q.map((p) => ({ p: this.body.at([p[0] * m, p[1], p[2]]), r, g }));
      const want: Vec3 = [n[0] * m, n[1], n[2]];
      this.body.quad(cs[0] as Corner, cs[1] as Corner, cs[2] as Corner, cs[3] as Corner, want);
    }
  }
}

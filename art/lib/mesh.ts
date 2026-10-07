// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// A mesh builder: vertices with colours and texture coordinates, faces
// wound counter-clockwise seen from their front, smooth normals per mesh,
// and a few solids (tubes, boxes) for spars and fittings.

import type { Primitive } from './gltf.ts';

export type Vec3 = [number, number, number];

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly uvs: number[] = [];
  readonly uvs2: number[] = [];
  readonly indices: number[] = [];
  /** Normals given by hand, by vertex; computed for the rest. */
  readonly #given = new Map<number, Vec3>();

  readonly material: string;

  constructor(material: string) {
    this.material = material;
  }

  get count(): number {
    return this.positions.length / 3;
  }

  /** Adds a vertex and returns its index. */
  vertex(
    p: Vec3,
    color: Vec3 = [1, 1, 1],
    uv: [number, number] = [0, 0],
    uv2?: [number, number],
  ): number {
    this.positions.push(p[0], p[1], p[2]);
    this.colors.push(color[0], color[1], color[2]);
    this.uvs.push(uv[0], uv[1]);
    this.uvs2.push(...(uv2 ?? uv));
    return this.count - 1;
  }

  /** Fixes a vertex's normal. */
  normal(i: number, n: Vec3): void {
    this.#given.set(i, normalize(n));
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A triangle wound so that its front faces toward want. */
  triFacing(a: number, b: number, c: number, want: Vec3): void {
    const pa = this.#at(a);
    const n = cross(sub(this.#at(b), pa), sub(this.#at(c), pa));
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) {
      this.tri(a, b, c);
    } else {
      this.tri(a, c, b);
    }
  }

  #at(i: number): Vec3 {
    return [
      this.positions[i * 3] ?? 0,
      this.positions[i * 3 + 1] ?? 0,
      this.positions[i * 3 + 2] ?? 0,
    ];
  }

  /** A quad a-b-c-d, counter-clockwise seen from its front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /** Joins two rows of vertices of the same length into a strip of quads. */
  strip(lower: number[], upper: number[], flip = false): void {
    for (let i = 0; i + 1 < lower.length; i++) {
      const a = lower[i] as number;
      const b = lower[i + 1] as number;
      const c = upper[i + 1] as number;
      const d = upper[i] as number;
      if (flip) {
        this.quad(a, d, c, b);
      } else {
        this.quad(a, b, c, d);
      }
    }
  }

  /** Appends another builder's geometry, mirrored across x = 0 when asked. */
  append(other: MeshBuilder, mirror = false): void {
    const base = this.count;
    for (let i = 0; i < other.count; i++) {
      const x = other.positions[i * 3] ?? 0;
      this.positions.push(
        mirror ? -x : x,
        other.positions[i * 3 + 1] ?? 0,
        other.positions[i * 3 + 2] ?? 0,
      );
      this.colors.push(
        other.colors[i * 3] ?? 1,
        other.colors[i * 3 + 1] ?? 1,
        other.colors[i * 3 + 2] ?? 1,
      );
      this.uvs.push(other.uvs[i * 2] ?? 0, other.uvs[i * 2 + 1] ?? 0);
      this.uvs2.push(other.uvs2[i * 2] ?? 0, other.uvs2[i * 2 + 1] ?? 0);
    }
    const n = other.normals();
    for (let i = 0; i < other.count; i++) {
      const x = n[i * 3] ?? 0;
      this.#given.set(base + i, [mirror ? -x : x, n[i * 3 + 1] ?? 0, n[i * 3 + 2] ?? 0]);
    }
    for (let i = 0; i < other.indices.length; i += 3) {
      const a = (other.indices[i] ?? 0) + base;
      const b = (other.indices[i + 1] ?? 0) + base;
      const c = (other.indices[i + 2] ?? 0) + base;
      // Mirroring turns the winding over.
      if (mirror) {
        this.indices.push(a, c, b);
      } else {
        this.indices.push(a, b, c);
      }
    }
  }

  /** Smooth normals: each vertex's faces' normals, weighted by area. */
  normals(): number[] {
    const n = new Array(this.positions.length).fill(0);
    const p = this.positions;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = (this.indices[i] ?? 0) * 3;
      const b = (this.indices[i + 1] ?? 0) * 3;
      const c = (this.indices[i + 2] ?? 0) * 3;
      const ux = (p[b] ?? 0) - (p[a] ?? 0);
      const uy = (p[b + 1] ?? 0) - (p[a + 1] ?? 0);
      const uz = (p[b + 2] ?? 0) - (p[a + 2] ?? 0);
      const vx = (p[c] ?? 0) - (p[a] ?? 0);
      const vy = (p[c + 1] ?? 0) - (p[a + 1] ?? 0);
      const vz = (p[c + 2] ?? 0) - (p[a + 2] ?? 0);
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (const k of [a, b, c]) {
        n[k] += fx;
        n[k + 1] += fy;
        n[k + 2] += fz;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const g = this.#given.get(i);
      const v = g ?? normalize([n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]);
      n[i * 3] = v[0];
      n[i * 3 + 1] = v[1];
      n[i * 3 + 2] = v[2];
    }
    return n;
  }

  /** The builder as a glTF primitive. */
  primitive(opts: { colors?: boolean; uvs2?: boolean } = {}): Primitive {
    const p: Primitive = {
      material: this.material,
      positions: this.positions,
      normals: this.normals(),
      uvs: this.uvs,
      indices: this.indices,
    };
    if (opts.colors === true) {
      p.colors = this.colors;
    }
    if (opts.uvs2 === true) {
      p.uvs2 = this.uvs2;
    }
    return p;
  }

  /**
   * A tube along a path of points, with a radius at each and a ring of
   * segments, capped at both ends. The rings are square to the path.
   */
  tube(path: Vec3[], radii: number[], segments: number, color: Vec3 = [1, 1, 1]): void {
    const rings: number[][] = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i] as Vec3;
      const prev = path[Math.max(0, i - 1)] as Vec3;
      const next = path[Math.min(path.length - 1, i + 1)] as Vec3;
      const t = normalize(sub(next, prev));
      const ref: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = normalize(cross(t, ref));
      const v = cross(u, t);
      const r = radii[i] ?? radii[radii.length - 1] ?? 0.01;
      const ring: number[] = [];
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * 2 * Math.PI;
        const d: Vec3 = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
        const k = this.vertex(add(p, scale(d, r)), color, [s / segments, i / (path.length - 1)]);
        this.normal(k, d);
        ring.push(k);
      }
      rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++) {
      this.strip(rings[i] as number[], rings[i + 1] as number[], true);
    }
    // Caps: fans facing out of each end.
    for (const [end, dir] of [
      [0, -1],
      [path.length - 1, 1],
    ] as [number, number][]) {
      const p = path[end] as Vec3;
      const other = path[end === 0 ? 1 : end - 1] as Vec3;
      const out = normalize(sub(p, other));
      const centre = this.vertex(p, color);
      this.normal(centre, out);
      const ring = (rings[end] as number[]).map((k) => {
        const q = this.vertex(
          [
            this.positions[k * 3] ?? 0,
            this.positions[k * 3 + 1] ?? 0,
            this.positions[k * 3 + 2] ?? 0,
          ],
          color,
        );
        this.normal(q, out);
        return q;
      });
      // The ring runs clockwise about the path's direction.
      for (let s = 0; s < segments; s++) {
        if (dir > 0) {
          this.tri(centre, ring[s + 1] as number, ring[s] as number);
        } else {
          this.tri(centre, ring[s] as number, ring[s + 1] as number);
        }
      }
    }
  }

  /** A box between two corners, with flat faces. */
  box(min: Vec3, max: Vec3, color: Vec3 = [1, 1, 1]): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const faces: [Vec3, Vec3[]][] = [
      [
        [1, 0, 0],
        [
          [x1, y0, z1],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
        ],
      ],
      [
        [-1, 0, 0],
        [
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
          [x0, y1, z0],
        ],
      ],
      [
        [0, 1, 0],
        [
          [x0, y1, z1],
          [x1, y1, z1],
          [x1, y1, z0],
          [x0, y1, z0],
        ],
      ],
      [
        [0, -1, 0],
        [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x0, y0, z1],
        ],
      ],
      [
        [0, 0, 1],
        [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ],
      ],
      [
        [0, 0, -1],
        [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
        ],
      ],
    ];
    for (const [n, corners] of faces) {
      const k = corners.map((c) => {
        const i = this.vertex(c, color);
        this.normal(i, n);
        return i;
      });
      this.quad(k[0] as number, k[1] as number, k[2] as number, k[3] as number);
    }
  }
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3 | number[]): Vec3 {
  const x = a[0] ?? 0;
  const y = a[1] ?? 0;
  const z = a[2] ?? 0;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** An sRGB colour, as display values, in linear light. */
export function srgb(r: number, g: number, b: number): Vec3 {
  const f = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f(r), f(g), f(b)];
}

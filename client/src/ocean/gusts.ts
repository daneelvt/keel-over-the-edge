// SPDX-License-Identifier: AGPL-3.0-only

// The gust field on the GPU: the field the physics module computes for the
// boats (internal/physics/gusts.go), evaluated once a tile at the tile's
// centre, so that a dark patch seen coming across the water is the gust the
// boat will feel.
//
// The field is gradient noise (Perlin, "Improving Noise", 2002) on a lattice
// that travels downwind with its spell. A lattice corner is hashed by
// integer arithmetic, which wraps the same way on every GPU as in the
// module (WGSL, "modulo 2^bitwidth"; GLSL ES 3.00, 4.1.3), so the corner's
// gradient is the module's exactly. What is left to the GPU's 32-bit floats
// is small: each frame the CPU finds, in 64 bits, the lattice cell the
// floating origin is in and how far across it, for each octave, and the
// shader carries on from there with a tile's few metres. A world position,
// or the hours a field has travelled, never reach the shader.
//
// The cells and the seeds are 32-bit integers. They cross as two halves of
// 16 bits each, in floats, which hold them exactly on every back end.

import { Vector4 } from 'three';
import { Fn, float, floor, If, int, mix, select, uint, uniform, uniformArray } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import type { WeatherGusts } from '../catalog/types.gen';
import { RECORDS, WEATHER } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';

const OCTAVES = WEATHER.octaves;
/** The spells whose fields are mixed at once: one, or two through a change. */
const SPELLS = 2;
/** The octaves' weights, the sum's scale and the lattice's primes: as the physics package has them. */
const WEIGHTS = [1, 0.5, 0.25] as const;
export const GUST_SCALE = 0.7569;
const PRIME_I = 0x8da6b343;
const PRIME_J = 0xd8163841;
const PRIME_K = 0xcb1ab31f;

const F = RECORDS.gustFrame;

/** How a gust looks on a tile (seamaterial.ts): starting values, tuned by eye. */
export const GUST_LOOK = {
  /** A gust, or a lull, shows from this much of the field, and in full from this much. */
  shows: [0.06, 0.5] as [number, number],
  /** Under a gust shown in full the tile's own ripples are this much steeper, and its water this much darker. */
  rough: 0.6,
  dark: 0.28,
  /** In the deepest lull the ripples are this much flatter. */
  smooth: 0.4,
  /** The gusts fade out over this many metres at the tile field's rim. */
  rim: 30,
  /** A spell's gusts show in full from this excess of its gust factor over 1, and at most this many times over. */
  fullAt: 0.3,
  most: 1.5,
};

export interface GustUniforms {
  /** For each spell and octave: the low halves of the origin's cells along, across and in time, and of the seed. */
  readonly low: ReturnType<typeof uniformArray>;
  /** And the high halves. */
  readonly high: ReturnType<typeof uniformArray>;
  /** For each spell and octave: how far the origin is across its cell along, across and in time. */
  readonly frac: ReturnType<typeof uniformArray>;
  /** For each spell: the sine and cosine of its frame's direction, and its share of the mix. */
  readonly frame: ReturnType<typeof uniformArray>;
  /** How many spells have a field: 0, 1 or 2. */
  readonly spells: UniformNode<'float', number>;
  /** How strongly the gusts show: 0 with none, 1 for a spell whose gusts show in full. */
  readonly strength: UniformNode<'float', number>;
}

/** The gust field's frame for a frame of the picture, and the uniforms that carry it. */
export class GustField {
  readonly uniforms: GustUniforms;
  /** 1 to draw the gusts; 0 to draw the water without them (the developer panel, the tests). */
  shown = 1;

  readonly #low: Vector4[] = [];
  readonly #high: Vector4[] = [];
  readonly #frac: Vector4[] = [];
  readonly #frame: Vector4[] = [];
  readonly #invAlong: number[] = [];
  readonly #invAcross: number[] = [];
  readonly #invLife: number[] = [];

  constructor(gusts: WeatherGusts) {
    let along = gusts.gustAlong;
    let across = gusts.gustAcross;
    let life = gusts.gustLife;
    for (let k = 0; k < OCTAVES; k++) {
      // Each octave's cells are half the one before's, as the module halves them.
      this.#invAlong.push(1 / along);
      this.#invAcross.push(1 / across);
      this.#invLife.push(1 / life);
      along *= 0.5;
      across *= 0.5;
      life *= 0.5;
    }
    for (let i = 0; i < SPELLS * OCTAVES; i++) {
      this.#low.push(new Vector4());
      this.#high.push(new Vector4());
      this.#frac.push(new Vector4());
    }
    for (let s = 0; s < SPELLS; s++) {
      this.#frame.push(new Vector4());
    }
    this.uniforms = {
      low: uniformArray(this.#low, 'vec4'),
      high: uniformArray(this.#high, 'vec4'),
      frac: uniformArray(this.#frac, 'vec4'),
      frame: uniformArray(this.#frame, 'vec4'),
      spells: uniform(0),
      strength: uniform(0),
    };
  }

  /** The reciprocals of an octave's cells, along and across, for the shader. */
  cell(k: number): { invAlong: number; invAcross: number } {
    return { invAlong: this.#invAlong[k] ?? 0, invAcross: this.#invAcross[k] ?? 0 };
  }

  /**
   * Brings the uniforms to the field at a time, in ticks, about the
   * floating origin, in the world: from the spells the module holds. With
   * no module, or no spell with gusts, there is no field.
   */
  update(physics: Physics | null, tick: number, originEast: number, originNorth: number): void {
    const u = this.uniforms;
    if (physics === null) {
      u.spells.value = 0;
      u.strength.value = 0;
      return;
    }
    physics.windDrawAt(tick);
    const f = physics.gustFrame();
    const spells = Math.min(f[F.spells] ?? 0, SPELLS);
    u.spells.value = spells;
    const excess = f[F.excess] ?? 0;
    u.strength.value =
      spells === 0 ? 0 : this.shown * Math.min(excess / GUST_LOOK.fullAt, GUST_LOOK.most);
    for (let s = 0; s < spells; s++) {
      const sin = f[F.sin + s] ?? 0;
      const cos = f[F.cos + s] ?? 0;
      (this.#frame[s] as Vector4).set(sin, cos, f[F.share + s] ?? 0, 0);
      // The origin in the field's frame: along the way the air moves, less
      // how far the field has travelled, and across it.
      const along = -(originEast * sin + originNorth * cos) - (f[F.travel + s] ?? 0);
      const across = originEast * cos - originNorth * sin;
      const seconds = f[F.seconds + s] ?? 0;
      for (let k = 0; k < OCTAVES; k++) {
        const i = s * OCTAVES + k;
        const a = along * (this.#invAlong[k] ?? 0);
        const c = across * (this.#invAcross[k] ?? 0);
        const t = seconds * (this.#invLife[k] ?? 0);
        const [fa, fc, ft] = [Math.floor(a), Math.floor(c), Math.floor(t)];
        const seed = f[F.seed + i] ?? 0;
        (this.#low[i] as Vector4).set(low(fa), low(fc), low(ft), low(seed));
        (this.#high[i] as Vector4).set(high(fa), high(fc), high(ft), high(seed));
        (this.#frac[i] as Vector4).set(a - fa, c - fc, t - ft, 0);
      }
    }
  }
}

/** The low and the high 16 bits of a whole number's 32. */
const low = (n: number): number => (n >>> 0) & 0xffff;
const high = (n: number): number => (n >>> 0) >>> 16;

/** Mixes the bits of x (Wellons's lowbias32), as the module does. */
const hash = (x: Node<'uint'>): Node<'uint'> => {
  const h = x.toVar();
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  h.assign(h.mul(uint(0x7feb352d)));
  h.assign(h.bitXor(h.shiftRight(uint(15))));
  h.assign(h.mul(uint(0x846ca68b)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return h as unknown as Node<'uint'>;
};

/**
 * The dot product of (x, y, z) with the gradient a hash's low four bits
 * choose: one of the twelve toward the middles of a cube's edges, as
 * Perlin's improved noise chooses them.
 */
const grad = (
  h: Node<'uint'>,
  x: Node<'float'>,
  y: Node<'float'>,
  z: Node<'float'>,
): Node<'float'> => {
  const b = h.bitAnd(uint(15)).toVar();
  const u = select(b.lessThan(uint(8)), x, y);
  const v = select(b.lessThan(uint(4)), y, select(b.equal(uint(12)).or(b.equal(uint(14))), x, z));
  const su = select(b.bitAnd(uint(1)).equal(uint(0)), u, u.negate());
  const sv = select(b.bitAnd(uint(2)).equal(uint(0)), v, v.negate());
  return su.add(sv) as unknown as Node<'float'>;
};

/** Perlin's quintic, 6t⁵ − 15t⁴ + 10t³. */
const fade = (t: Node<'float'>): Node<'float'> =>
  t
    .mul(t)
    .mul(t)
    .mul(t.mul(t.mul(6).sub(15)).add(10)) as unknown as Node<'float'>;

/** A 32-bit whole number from its halves. */
const whole = (lo: Node<'float'>, hi: Node<'float'>): Node<'uint'> =>
  uint(hi).shiftLeft(uint(16)).bitOr(uint(lo)) as unknown as Node<'uint'>;

/**
 * The gust field at a scene point, x and z from the floating origin: from
 * −1 in the deepest lull to 1 in the strongest gust, as the module's.
 */
export function gustAt(field: GustField): (p: Node<'vec2'>) => Node<'float'> {
  const u = field.uniforms;
  const spell = (p: Node<'vec2'>, s: number): Node<'float'> => {
    const frame = u.frame.element(s) as unknown as Node<'vec4'>;
    // East is the scene's x, north its −z.
    const along = p.x.mul(frame.x).sub(p.y.mul(frame.y)).negate().toVar();
    const across = p.x.mul(frame.y).add(p.y.mul(frame.x)).toVar();
    const sum = float(0).toVar();
    for (let k = 0; k < OCTAVES; k++) {
      const i = s * OCTAVES + k;
      const lo = u.low.element(i) as unknown as Node<'vec4'>;
      const hi = u.high.element(i) as unknown as Node<'vec4'>;
      const fr = u.frac.element(i) as unknown as Node<'vec4'>;
      const { invAlong, invAcross } = field.cell(k);
      const a = fr.x.add(along.mul(invAlong)).toVar();
      const c = fr.y.add(across.mul(invAcross)).toVar();
      const fa = floor(a).toVar();
      const fc = floor(c).toVar();
      // A negative step is added as its two's complement, which wraps to
      // the cell before.
      const ci = whole(lo.x, hi.x)
        .add(uint(int(fa)))
        .toVar();
      const cj = whole(lo.y, hi.y)
        .add(uint(int(fc)))
        .toVar();
      const ck = whole(lo.z, hi.z).toVar();
      const seed = whole(lo.w, hi.w).toVar();
      const x = a.sub(fa).toVar();
      const y = c.sub(fc).toVar();
      const z = fr.z;
      const i0 = ci.mul(uint(PRIME_I)).toVar();
      const i1 = ci.add(uint(1)).mul(uint(PRIME_I)).toVar();
      const j0 = cj.mul(uint(PRIME_J)).toVar();
      const j1 = cj.add(uint(1)).mul(uint(PRIME_J)).toVar();
      const k0 = ck.mul(uint(PRIME_K)).bitXor(seed).toVar();
      const k1 = ck.add(uint(1)).mul(uint(PRIME_K)).bitXor(seed).toVar();
      const x1 = x.sub(1);
      const y1 = y.sub(1);
      const z1 = z.sub(1);
      const at = (hi_: Node<'uint'>, hj: Node<'uint'>, hk: Node<'uint'>) =>
        hash(hi_.bitXor(hj).bitXor(hk) as unknown as Node<'uint'>);
      const n000 = grad(at(i0, j0, k0), x, y, z);
      const n100 = grad(at(i1, j0, k0), x1, y, z);
      const n010 = grad(at(i0, j1, k0), x, y1, z);
      const n110 = grad(at(i1, j1, k0), x1, y1, z);
      const n001 = grad(at(i0, j0, k1), x, y, z1);
      const n101 = grad(at(i1, j0, k1), x1, y, z1);
      const n011 = grad(at(i0, j1, k1), x, y1, z1);
      const n111 = grad(at(i1, j1, k1), x1, y1, z1);
      const fx = fade(x);
      const fy = fade(y);
      const fz = fade(z);
      const near = mix(mix(n000, n100, fx), mix(n010, n110, fx), fy);
      const far = mix(mix(n001, n101, fx), mix(n011, n111, fx), fy);
      sum.addAssign(mix(near, far, fz).mul(WEIGHTS[k] as number));
    }
    return sum
      .mul(1 / GUST_SCALE)
      .clamp(-1, 1)
      .mul(frame.z) as unknown as Node<'float'>;
  };
  return Fn(([p]: [Node<'vec2'>]) => {
    const gust = float(0).toVar();
    If(u.spells.greaterThan(0.5), () => {
      gust.addAssign(spell(p, 0));
    });
    If(u.spells.greaterThan(1.5), () => {
      gust.addAssign(spell(p, 1));
    });
    return gust.clamp(-1, 1);
  }) as unknown as (p: Node<'vec2'>) => Node<'float'>;
}

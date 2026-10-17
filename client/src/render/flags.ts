// SPDX-License-Identifier: AGPL-3.0-only

// Flags ashore: on each harbourmaster's house, and on Port Royal's church
// and windmill, a pennant on its staff that streams with the true wind
// where it flies, gusts and the land's shelter in it, read as the Beaufort
// scale's land specifications read a flag: it hangs limp in light airs and
// is extended from force 3, "light flags extended" (Royal Meteorological
// Society). It flaps at a frequency f with a Strouhal number fL/U nearly
// constant whatever the wind (Taneda 1968): the stronger the wind, the
// quicker the flap. Each port flies its own pair of colours, Port Royal its
// own; no nation's, and no pirate's.
//
// All of them are one instanced draw. The cloth's shape is worked out in
// the vertex shader from world time, so every phone shows the same flap.

import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
} from 'three';
import {
  attribute,
  cos,
  mix,
  normalize,
  positionLocal,
  select,
  sin,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TownFlags } from '../catalog/types.gen';
import { litMaterial } from './materials';

/** A knot, m/s. */
const KNOT = 1852 / 3600;
/** The flags drawn at most. */
export const FLAG_CAPACITY = 64;
/** A flag's staff above its building's top, m. */
export const STAFF = 3.5;
/** The cloth's segments along its length. */
const SEGMENTS = 10;
/** Floats an instance: its staff's top and how extended it flies; the way downwind, its phase and frequency; its two colours. */
const STRIDE = 16;

/** How extended a flag flies in a wind of this many knots: 0 hanging limp, 1 streaming out (Beaufort's light flags extended at force 3). */
export function flagExtension(knots: number, limp: number, extended: number): number {
  const t = Math.min(Math.max((knots - limp) / Math.max(extended - limp, 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
}

/** How often a flag of length m flaps in a wind of speed m/s, Hz: Strouhal's fL/U held. */
export function flapFrequency(speed: number, length: number, strouhal: number): number {
  return (strouhal * Math.max(speed, 0)) / Math.max(length, 0.1);
}

/** The way a flag streams, radians clockwise from north: downwind, away from where the wind comes from. */
export function downwind(from: number): number {
  return from + Math.PI;
}

/** A colour #rrggbb as linear values. */
function linear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/** A flag to draw: its staff's top, m east, north and up; the wind there; its colours' pair, 0 for Port Royal's. */
export interface FlagSeen {
  east: number;
  north: number;
  top: number;
  /** The wind where it flies: speed m/s and where it comes from, radians clockwise from north. */
  speed: number;
  from: number;
  /** Its colours: the catalog's pair's index and one, or past the list for Port Royal's. */
  flag: number;
  seed: number;
}

/**
 * A flag a metre long, its hoist on the staff: each vertex's place along
 * the fly (0 at the staff, 1 at its end) and across the hoist (−0.5 to
 * 0.5), and the staff itself, tagged apart.
 */
function flagGeometry(): BufferGeometry {
  const pos: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  // The cloth: a pennant, tapering to a point.
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    for (const s of [-0.5, 0.5]) {
      pos.push(0, 0, 0);
      along.push(t, s * (1 - 0.85 * t), 0);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  // The staff: a thin square post from the building's top to the flag's.
  const base = pos.length / 3;
  const r = 0.05;
  const corners = [
    [r, r],
    [r, -r],
    [-r, -r],
    [-r, r],
  ];
  for (const [x, z] of corners) {
    pos.push(x ?? 0, -STAFF, z ?? 0, x ?? 0, 0.3, z ?? 0);
    along.push(0, 0, 1, 0, 0, 1);
  }
  for (let k = 0; k < 4; k++) {
    const a = base + k * 2;
    const b = base + ((k + 1) % 4) * 2;
    index.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('flagAt', new Float32BufferAttribute(along, 3));
  g.setIndex(index);
  return g;
}

export class Flags {
  readonly mesh: InstancedMesh;
  /** World time, s: what every phone's flags flap by. */
  readonly time = uniform(0);
  count = 0;
  readonly #buffer: InstancedInterleavedBuffer;
  readonly #cat: TownFlags;
  readonly #colours: [number, number, number][][];

  constructor(cat: TownFlags) {
    this.#cat = cat;
    this.#colours = [...cat.colours.map((p) => p.map(linear)), cat.mainPort.map(linear)];
    const g = flagGeometry();
    this.#buffer = new InstancedInterleavedBuffer(
      new Float32Array(FLAG_CAPACITY * STRIDE),
      STRIDE,
      1,
    );
    this.#buffer.setUsage(DynamicDrawUsage);
    for (const [k, name] of ['flagTop', 'flagWind', 'flagFirst', 'flagSecond'].entries()) {
      g.setAttribute(name, new InterleavedBufferAttribute(this.#buffer, 4, k * 4));
    }
    const top = attribute('flagTop', 'vec4') as unknown as Node<'vec4'>;
    const wind = attribute('flagWind', 'vec4') as unknown as Node<'vec4'>;
    const first = attribute('flagFirst', 'vec4') as unknown as Node<'vec4'>;
    const second = attribute('flagSecond', 'vec4') as unknown as Node<'vec4'>;
    const at = attribute('flagAt', 'vec3') as unknown as Node<'vec3'>;
    const length = cat.length;
    // Downwind in the scene: east is x, north is −z.
    const dir = vec3(sin(wind.x), 0, cos(wind.x).negate());
    const across = vec3(dir.z.negate(), 0, dir.x);
    // The fly falls from hanging down the staff to streaming out downwind.
    const ext = top.w;
    const fly = normalize(mix(vec3(0, -1, 0).add(dir.mul(0.25)), dir.add(vec3(0, -0.12, 0)), ext));
    const t = at.x;
    // A wave runs down the cloth at the flap's frequency, growing toward
    // its end.
    const phase = this.time
      .mul(wind.z)
      .mul(2 * Math.PI)
      .add(wind.y)
      .sub(t.mul(4.2));
    const flap = sin(phase)
      .mul(t)
      .mul(length * 0.16)
      .mul(ext.mul(0.7).add(0.3));
    const cloth = fly
      .mul(t.mul(length))
      .add(vec3(0, at.y.mul(length * 0.5), 0))
      .add(across.mul(flap));
    // Placed by its staff's top, in the scene: its instance's matrix stays
    // the identity.
    const isStaff = at.z.greaterThan(0.5);
    const local = top.xyz.add(select(isStaff, positionLocal, cloth));
    const m = litMaterial(
      { roughness: 0.95, metalness: 0, side: DoubleSide },
      local as unknown as Node<'vec3'>,
    );
    m.name = 'flags';
    const vAt = varying(at);
    m.colorNode = select(
      vAt.z.greaterThan(0.5),
      vec3(0.22, 0.18, 0.14),
      select(vAt.y.greaterThan(0), varying(first.xyz), varying(second.xyz)),
    ) as unknown as Node<'vec3'>;
    this.mesh = new InstancedMesh(g, m, FLAG_CAPACITY);
    this.mesh.name = 'flags';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** The flags seen this frame, placed from the floating origin; time is world time, s. */
  frame(flags: readonly FlagSeen[], origin: { x: number; y: number }, time: number): void {
    this.time.value = time;
    const c = this.#cat;
    const a = this.#buffer.array as Float32Array;
    let n = 0;
    for (const f of flags) {
      if (n >= FLAG_CAPACITY) {
        break;
      }
      const knots = f.speed / KNOT;
      const o = n * STRIDE;
      a[o] = f.east - origin.x;
      a[o + 1] = f.top + STAFF;
      a[o + 2] = -(f.north - origin.y);
      a[o + 3] = flagExtension(knots, c.limp, c.extended);
      a[o + 4] = downwind(f.from);
      a[o + 5] = f.seed * 0.7;
      a[o + 6] = flapFrequency(f.speed, c.length, c.strouhal);
      a[o + 7] = 0;
      const pair =
        this.#colours[Math.min(f.flag - 1, this.#colours.length - 1)] ?? this.#colours[0] ?? [];
      const p = pair[0] ?? [1, 1, 1];
      const q = pair[1] ?? [1, 1, 1];
      a.set([p[0] ?? 1, p[1] ?? 1, p[2] ?? 1, 0, q[0] ?? 1, q[1] ?? 1, q[2] ?? 1, 0], o + 8);
      n++;
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#buffer.needsUpdate = true;
  }
}

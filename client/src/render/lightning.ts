// SPDX-License-Identifier: AGPL-3.0-only

// Lightning on the page: the flashes the physics module finds from each
// squall's and storm's seed, slot by slot of world time, the same on every
// phone and the server (physics.Flashes); a flash lights its own cloud from
// within, more by night ("lights only the cloud it comes from"), and one
// that strikes the sea draws a bolt from the cloud's base to the sea while
// its top clears the horizon.
//
// A bolt is a random walk from its flash's seed, each short segment turning
// about 16° from the last as a real channel does (Hill, as Glassner 2000
// gives it), bent down, with two or three dimmer branches (Jersild 2009);
// each segment a ribbon facing the camera, since a line is a pixel wide on
// WebGPU, blended by the brightest, as NVIDIA's lightning sample draws
// them: one draw for every bolt.
//
// The screen keeps within WCAG 2.3.1's three flashes a second: a flash's
// first stroke is drawn as a pulse; its later strokes, 60 ms apart, change
// its cloud's brightness by under a tenth, under WCAG's general flash
// threshold of opposing changes of 10%, a flicker and not a flash; and a
// pulse within a third of a second of the last drawn joins it. With reduced
// motion there are no pulses: a flash brightens its cloud slowly and fades.
// The flashes themselves are everyone's; only their drawing is held.

import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  InstancedMesh,
  MaxEquation,
  OneFactor,
  type Vector3,
} from 'three';
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  exp,
  float,
  instancedDynamicBufferAttribute,
  normalize,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { basicMaterial, bendScene, horizonDistance } from './materials';

/** A flash as the page keeps it: from the module's flash record. */
export interface FlashSeen {
  /** Its system's slot and the catalog's kind, and its own seed. */
  slot: number;
  kind: number;
  seed: number;
  /** When its first stroke strikes, ticks. */
  tick: number;
  /** Where it strikes, m east and north. */
  east: number;
  north: number;
  /** Whether it strikes the sea, or stays in its cloud. */
  sea: boolean;
  /** Its cloud's base, m. */
  base: number;
  /** Its strokes' times after the first, s: the first is 0. */
  strokes: number[];
}

/** Flashes are kept this long after they strike, s: thunder from 3 nautical miles comes 16 s on, and rolls. */
const KEEP = 60;

/** A drawn pulse lasts about this long, s, its strokes' flicker this long each, and by how much at most. */
const PULSE = 0.18;
const FLICKER = 0.05;
const FLICKER_MOST = 0.09;

/** Pulses closer than this to the last drawn one join it, s: three a second at most (WCAG 2.3.1). */
const PULSE_APART = 1 / 3;

/** With reduced motion a flash brightens its cloud over this long and fades over this, s. */
const SLOW_RISE = 0.8;
const SLOW_FADE = 2.5;

/** How far a flash lights its cloud about it, m. */
const CLOUD_LIT = 900;

/** A bolt's segments, and its branches' at most; the segments drawn at most, for every bolt. */
const BOLT_SEGMENTS = 28;
const BRANCH_SEGMENTS = 7;
export const SEGMENTS_MOST = 256;

/** How far a bolt's segment turns from the last at most, rad: evenly up to twice 16°, about 16° in the mean (Hill). */
const TURN = (32 * Math.PI) / 180;

/** A bolt's width, m, and its branches' brightness beside its own. */
const BOLT_WIDTH = 3.5;
const BRANCH_BRIGHT = 0.45;

/** The bolt's light, linear: a little blue. */
const BOLT_COLOUR = [0.92, 0.95, 1.4] as const;

/** A hash of a number, 0 to 1, for the bolt's walk. */
function hash(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** A bolt's points, m east, up and north of its strike, from its cloud's base at its seed's walk down to the sea. */
export function boltPath(seed: number, base: number): [number, number, number][] {
  const points: [number, number, number][] = [[0, base, 0]];
  const step = (base / BOLT_SEGMENTS) * 1.15;
  let dx = 0;
  let dy = -1;
  let dz = 0;
  let x = 0;
  let y = base;
  let z = 0;
  for (let i = 0; i < BOLT_SEGMENTS; i++) {
    // Turn by up to the turn's angle about a random axis, then lean down.
    const a = (hash(seed, 3 * i) * 2 - 1) * TURN;
    const b = hash(seed, 3 * i + 1) * 2 * Math.PI;
    dx += Math.sin(a) * Math.cos(b);
    dz += Math.sin(a) * Math.sin(b);
    dy = Math.min(dy - 0.12, -0.3);
    const n = Math.hypot(dx, dy, dz);
    dx /= n;
    dy /= n;
    dz /= n;
    x += dx * step;
    y += dy * step;
    z += dz * step;
    points.push([x, y, z]);
  }
  // Bring its end to the strike on the sea, the error spread along it.
  const last = points[points.length - 1] as [number, number, number];
  const ex = last[0];
  const ey = last[1];
  const ez = last[2];
  // Its height from the base's down to the sea's, as the walk fell.
  const fell = Math.max(base - ey, 1);
  return points.map(([px, py, pz], k) => {
    const u = k / BOLT_SEGMENTS;
    return [px - ex * u, base - ((base - py) * base) / fell, pz - ez * u];
  });
}

/** What a frame tells the lightning. */
export interface LightningFrame {
  /** World time, ticks and s. */
  tick: number;
  seconds: number;
  /** The camera, a scene point, its eye's height, m, and the floating origin, m east and north. */
  camera: Vector3;
  origin: { x: number; y: number };
  /** How dark it is, 0 by day to 1 by night: a flash lights its cloud more by night. */
  night: number;
  /** Whether bolts are drawn at all (the sky is drawn). */
  on: boolean;
}

/** A flash's light on its cloud now: where, scene axes, and how bright. */
export interface CloudFlash {
  x: number;
  y: number;
  z: number;
  strength: number;
  radius: number;
}

export class Lightning {
  readonly mesh: InstancedMesh;
  /** The flashes of the last minute, in the order they strike. */
  readonly flashes: FlashSeen[] = [];
  /** Whether the player asked for reduced motion: no pulses. */
  reducedMotion = false;
  /** The brightest flash lighting its cloud now, or none. */
  readonly cloud: CloudFlash = { x: 0, y: 0, z: 0, strength: 0, radius: CLOUD_LIT };
  /** The pulses drawn, world seconds, for the flashing limit's test. */
  readonly pulses: number[] = [];
  /** How many segments are drawn now. */
  segments = 0;
  readonly #segments: InstancedInterleavedBuffer;
  #asked = Number.NaN;
  #lastPulse = Number.NEGATIVE_INFINITY;
  /** Each flash's pulse: when it was drawn from, s, or NaN if it joined the last. */
  readonly #pulseOf = new Map<FlashSeen, number>();

  constructor() {
    this.#segments = new InstancedInterleavedBuffer(new Float32Array(SEGMENTS_MOST * 8), 8, 1);
    this.#segments.setUsage(DynamicDrawUsage);
    const start = instancedDynamicBufferAttribute(
      this.#segments,
      'vec4',
      8,
      0,
    ) as unknown as Node<'vec4'>;
    const end = instancedDynamicBufferAttribute(
      this.#segments,
      'vec4',
      8,
      4,
    ) as unknown as Node<'vec4'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    const a = start.xyz;
    const along = end.xyz.sub(a);
    const toCamera = normalize(cameraPosition.sub(a));
    const side = normalize(cross(along, toCamera)).mul(start.w.mul(0.5));
    const q = a.add(along.mul(corner.y)).add(side.mul(corner.x));
    const m = basicMaterial();
    m.name = 'bolts';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = CustomBlending;
    m.blendEquation = MaxEquation;
    m.blendSrc = OneFactor;
    m.blendDst = OneFactor;
    m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(bendScene(q), 1)));
    const across = varying(corner.x);
    const bright = varying(end.w);
    const core = exp(across.mul(across).mul(-6));
    m.fragmentNode = vec4(
      vec3(...BOLT_COLOUR).mul(core.mul(bright)),
      float(1),
    ) as unknown as Node<'vec4'>;
    const g = new BufferGeometry();
    g.setAttribute('corner', new BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), 2));
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.mesh = new InstancedMesh(g, m, SEGMENTS_MOST);
    this.mesh.name = 'bolts';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Hidden while no bolt is drawn: a draw only while one is.
    this.mesh.visible = false;
  }

  /** Adds a flash of the page's own, as the sandbox makes one: drawn and heard, never the server's. */
  force(f: FlashSeen): void {
    this.flashes.push(f);
    this.flashes.sort((a, b) => a.tick - b.tick);
  }

  /** Forgets every flash: a new world, or a jump in time. */
  clear(): void {
    this.flashes.length = 0;
    this.#pulseOf.clear();
    this.#asked = Number.NaN;
    this.#lastPulse = Number.NEGATIVE_INFINITY;
  }

  /** Asks the module for each slot's flashes as the slot begins, and draws those striking now. */
  frame(physics: Physics | null, f: LightningFrame): void {
    if (physics !== null) {
      this.#ask(physics, f.tick);
    }
    const seconds = f.seconds;
    while (this.flashes.length > 0 && (this.flashes[0] as FlashSeen).tick / 30 < seconds - KEEP) {
      this.#pulseOf.delete(this.flashes.shift() as FlashSeen);
    }
    const o = f.origin;
    const eye = Math.max(f.camera.y, 0.5);
    const c = this.cloud;
    c.strength = 0;
    let n = 0;
    const seg = this.#segments.array as Float32Array;
    for (const fl of this.flashes) {
      const t = seconds - fl.tick / 30;
      const level = this.#level(fl, t, seconds);
      if (!(level > 0.002)) {
        continue;
      }
      const light = level * (0.35 + 0.65 * f.night);
      if (light > c.strength) {
        c.x = fl.east - o.x;
        c.y = fl.base + 250;
        c.z = -(fl.north - o.y);
        c.strength = light;
      }
      // A bolt, while its cloud's base clears the horizon.
      if (!fl.sea || !f.on) {
        continue;
      }
      const d = Math.hypot(fl.east - (f.camera.x + o.x), fl.north - (-f.camera.z + o.y));
      if (d > horizonDistance(eye) + horizonDistance(fl.base)) {
        continue;
      }
      n = this.#bolt(fl, level, o, seg, n);
    }
    this.segments = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#segments.needsUpdate = n > 0;
  }

  /** The slots' flashes not yet asked for, up to the current one: the keyframes held cover their starts. */
  #ask(physics: Physics, tick: number): void {
    const every = physics.slotTicks();
    const now = Math.floor(tick / every);
    let from =
      Number.isNaN(this.#asked) || this.#asked > now || now - this.#asked > 2
        ? now
        : this.#asked + 1;
    for (; from <= now; from++) {
      const v = physics.flashesAt(from);
      const F = RECORDS.flash;
      for (let o = 0; o + SIZES.flash <= v.length; o += SIZES.flash) {
        const strokes: number[] = [];
        const count = v[o + F.strokes] ?? 1;
        for (let k = 0; k < count; k++) {
          strokes.push(v[o + F.stroke + k] ?? 0);
        }
        this.flashes.push({
          slot: v[o + F.slot] ?? 0,
          kind: v[o + F.kind] ?? 0,
          seed: v[o + F.seed] ?? 0,
          tick: v[o + F.tick] ?? 0,
          east: v[o + F.east] ?? 0,
          north: v[o + F.north] ?? 0,
          sea: (v[o + F.sea] ?? 0) === 1,
          base: v[o + F.base] ?? 0,
          strokes,
        });
      }
      this.#asked = from;
    }
    this.flashes.sort((a, b) => a.tick - b.tick);
  }

  /** How brightly a flash t s after its first stroke lights its cloud, 0 to 1, drawn within the flashing limit. */
  #level(fl: FlashSeen, t: number, seconds: number): number {
    const last = fl.strokes[fl.strokes.length - 1] ?? 0;
    if (t < 0 || t > last + (this.reducedMotion ? SLOW_RISE + SLOW_FADE : 1)) {
      return 0;
    }
    if (this.reducedMotion) {
      return t < SLOW_RISE
        ? (t / SLOW_RISE) * 0.6
        : 0.6 * Math.exp(-(t - SLOW_RISE) / (SLOW_FADE / 3));
    }
    let start = this.#pulseOf.get(fl);
    if (start === undefined) {
      start = seconds - t;
      if (start - this.#lastPulse < PULSE_APART) {
        // Too soon after the last pulse drawn: it joins it.
        start = Number.NaN;
      } else {
        this.#lastPulse = start;
        this.pulses.push(start);
        if (this.pulses.length > 64) {
          this.pulses.shift();
        }
      }
      this.#pulseOf.set(fl, start);
    }
    // The pulse, then a flicker of under a tenth at each later stroke, on
    // the pulse's tail.
    const base = Number.isNaN(start) ? 0.5 : Math.exp(-t / PULSE);
    let flicker = 0;
    for (let k = 1; k < fl.strokes.length; k++) {
      const s = t - (fl.strokes[k] ?? 0);
      if (s >= 0 && s < 4 * FLICKER) {
        flicker = Math.max(flicker, FLICKER_MOST * Math.exp(-s / FLICKER));
      }
    }
    const tail = Math.max(base, Number.isNaN(start) ? 0 : 0.5 * Math.exp(-t / 0.6));
    return Math.min(tail * (1 + flicker), 1);
  }

  /** Writes a flash's bolt's segments from n on; returns the next free. */
  #bolt(
    fl: FlashSeen,
    level: number,
    o: { x: number; y: number },
    seg: Float32Array,
    n: number,
  ): number {
    const seed = fl.seed >>> 0;
    const x0 = fl.east - o.x;
    const z0 = -(fl.north - o.y);
    const put = (
      a: [number, number, number],
      b: [number, number, number],
      width: number,
      bright: number,
    ): void => {
      if (n >= SEGMENTS_MOST) {
        return;
      }
      const i = n * 8;
      seg[i] = x0 + a[0];
      seg[i + 1] = a[1];
      seg[i + 2] = z0 + a[2];
      seg[i + 3] = width;
      seg[i + 4] = x0 + b[0];
      seg[i + 5] = b[1];
      seg[i + 6] = z0 + b[2];
      seg[i + 7] = bright;
      n++;
    };
    const path = boltPath(seed, fl.base);
    for (let k = 0; k + 1 < path.length; k++) {
      put(
        path[k] as [number, number, number],
        path[k + 1] as [number, number, number],
        BOLT_WIDTH,
        level,
      );
    }
    // Two or three dimmer branches from the upper half, angled away.
    const branches = 2 + Math.floor(hash(seed, 100) * 2);
    for (let b = 0; b < branches; b++) {
      const at = 1 + Math.floor(hash(seed, 101 + b) * (BOLT_SEGMENTS / 2));
      let p = path[at] as [number, number, number];
      const a = hash(seed, 110 + b) * 2 * Math.PI;
      const len = (fl.base / BOLT_SEGMENTS) * 0.9;
      for (let k = 0; k < BRANCH_SEGMENTS; k++) {
        const wob = (hash(seed, 120 + b * 10 + k) * 2 - 1) * TURN * 2;
        const q: [number, number, number] = [
          p[0] + Math.sin(a + wob) * len * 0.8,
          p[1] - len * 0.6,
          p[2] + Math.cos(a + wob) * len * 0.8,
        ];
        put(p, q, BOLT_WIDTH * 0.5, level * BRANCH_BRIGHT * (1 - k / BRANCH_SEGMENTS));
        p = q;
      }
    }
    return n;
  }
}

/**
 * A flash of the page's own, as the sandbox makes one: the nearest heaped
 * cloud of the cloud records given (or, with none, a squall's base a
 * kilometre north) striking the sea at its centre seconds after tick, with
 * a flash's mean strokes.
 */
export function flashNear(
  heaped: Float64Array,
  east: number,
  north: number,
  tick: number,
  seconds: number,
): FlashSeen {
  const C = RECORDS.cloud;
  let best = -1;
  let d = Number.POSITIVE_INFINITY;
  for (let o = 0; o + SIZES.cloud <= heaped.length; o += SIZES.cloud) {
    const away = Math.hypot((heaped[o + C.east] ?? 0) - east, (heaped[o + C.north] ?? 0) - north);
    if (away < d) {
      best = o;
      d = away;
    }
  }
  return {
    slot: -1,
    kind: -1,
    seed: (tick * 2654435761) >>> 0,
    tick: tick + seconds * 30,
    east: best < 0 ? east : (heaped[best + C.east] ?? east),
    north: best < 0 ? north + 1000 : (heaped[best + C.north] ?? north),
    sea: true,
    base: best < 0 ? 350 : (heaped[best + C.base] ?? 350),
    strokes: [0, 0.06, 0.12, 0.2],
  };
}

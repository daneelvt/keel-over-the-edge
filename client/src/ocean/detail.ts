// SPDX-License-Identifier: AGPL-3.0-only

// The detail band as the sea's material reads it: the waves shorter than
// the boat band's, which are drawn on the tiles and never move a boat. Two
// ways of making it stand behind one interface.
//
// On WebGPU it is Tessendorf's sea ("Simulating Ocean Water", 2001): the
// inverse Fourier transform of the spectrum at the frame's time, run as
// four compute passes a patch.
//
//   1  the spectrum at time t: each wave's amplitude from the JONSWAP
//      spectrum under the wind of the sea below the boat, turned by ωt, as
//      the two complex fields of field.ts
//   2  the transform of every row
//   3  the transform of every column
//   4  the fields put together: the two slopes, the height, and the foam,
//      which is what folds now or what was foam before, spread a little and
//      faded
//
// A transform is one workgroup a row (or a column): its invocations, one a
// texel, load the row into memory they share, run the log₂N stages of the
// radix-2 transform (Cooley and Tukey 1965) between two arrays with a
// barrier after each, and store the row. Every invocation computes its own
// element of a stage from two of the stage before, so nothing is written
// twice. A row of 128 fits the 128 invocations a workgroup that WebGPU's
// compatibility mode allows, and a row of 256 needs the 256 of its core
// limits (WebGPU, "Limits"). The transform's sines and cosines, and the
// order its input is read in, come from a small table made in float64, so
// every GPU runs the same arithmetic.
//
// On the low tier, and wherever compute passes are not to be had, it is a
// loop of the same band made once on the device by field.ts: two of them,
// for a light wind and a fresh one, mixed by the wind, turned to its
// direction and scaled to the band's height.
//
// The patch repeats over the world, so a point's place in it is its world
// position modulo the patch: taken in float64 for the floating origin each
// frame, to which the shader adds the offset from the origin.

import {
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  Vector2,
  Vector4,
} from 'three';
import {
  clamp,
  cos,
  dot,
  exp,
  Fn,
  float,
  floor,
  globalId,
  If,
  int,
  ivec2,
  length,
  localId,
  max,
  mix,
  pow,
  sin,
  sqrt,
  texture,
  texture3D,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import { type ComputeNode, type Node, StorageTexture, type WebGPURenderer } from 'three/webgpu';
import type { WeatherSea } from '../catalog/types.gen';
import type { DetailKind } from '../render/quality';
import { HEIGHT_RANGE, LoopBaker, loopFraction } from './field';
import { BAKED, DETAIL, type FoamLook, foamAt, KNOT, newFoamLook } from './look';
import {
  bandVariance,
  detailPatch,
  finerPatch,
  GRAVITY,
  modesOf,
  newSpectrumInputs,
  type Patch,
  type SpectrumInputs,
  spectrumInputs,
  spreadNorm,
  stepOf,
} from './spectrum';
import { fract1, Turned } from './turn';
import type { SeaUnder } from './under';

const TWO_PI = 2 * Math.PI;
const NAUTICAL_MILE = 1852;

/** What the sea's material reads of the detail band. */
export interface DetailNodes {
  /**
   * The band at the scene point p (x, z from the floating origin): the
   * slope along x and z, the foam (0 to 1), and the height in units of
   * three of its standard deviations. For a fragment.
   */
  fine(p: Node<'vec2'>): Node<'vec4'>;
  /** The same averaged over a tile or so: what tilts and shades a tile as a whole. For the vertex stage. */
  coarse(p: Node<'vec2'>): Node<'vec4'>;
  /** The second, finer patch's slopes at p, or null without one. */
  ripple: ((p: Node<'vec2'>) => Node<'vec2'>) | null;
  /** Whether what fine reads is filtered with distance; if not, the material fades it out itself. */
  filtered: boolean;
}

/** What a frame gives the detail band. */
export interface DetailFrame {
  /** The floating origin, and the boat, in the world: metres east and north. */
  originEast: number;
  originNorth: number;
  boatEast: number;
  boatNorth: number;
  /** World time, in seconds, and how far it moved since the last frame. */
  time: number;
  dt: number;
  /** The sea under the boat. */
  under: SeaUnder;
}

function floatTexture(data: Float32Array, width: number, height: number): DataTexture {
  const t = new DataTexture(data, width, height, RGBAFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** A texture a compute pass writes, at rgba32float: never filtered. */
function workTexture(size: number, name: string): StorageTexture {
  const t = new StorageTexture(size, size);
  t.type = FloatType;
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

/**
 * The transform's table for a length n, one texel an index j: e^(2πi j/n) in
 * red and green, and in blue j with its bits reversed, the index the
 * transform reads its j-th input from.
 */
export function transformTable(n: number): Float32Array {
  const bits = Math.log2(n);
  const data = new Float32Array(n * 4);
  for (let j = 0; j < n; j++) {
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r |= ((j >> b) & 1) << (bits - 1 - b);
    }
    data[j * 4] = Math.cos((TWO_PI * j) / n);
    data[j * 4 + 1] = Math.sin((TWO_PI * j) / n);
    data[j * 4 + 2] = r;
  }
  return data;
}

/**
 * A patch's waves for the spectrum pass, one texel a wave: its phase at
 * time 0 and its opposite's, in turns; its frequency in steps of the loop;
 * and the part of its energy that the wind does not change, w Δk² g / (2ω k).
 */
export function modeTexels(patch: Patch): Float32Array {
  const m = modesOf(patch);
  const dk = stepOf(patch);
  const data = new Float32Array(patch.size * patch.size * 4);
  for (let i = 0; i < m.k.length; i++) {
    const w = m.weight[i] as number;
    if (w === 0) {
      continue;
    }
    const k = m.k[i] as number;
    data[i * 4] = m.phase[i] as number;
    data[i * 4 + 1] = m.phase[m.opposite[i] as number] as number;
    data[i * 4 + 2] = m.step[i] as number;
    data[i * 4 + 3] = (w * dk * dk * GRAVITY) / (2 * Math.sqrt(GRAVITY * k) * k);
  }
  return data;
}

/** Memory a workgroup's invocations share: an array of vec4. */
interface Shared {
  element(i: Node): Node<'vec4'> & { assign(v: Node): void };
}

/** One patch of the band on the GPU: its kernels, its textures, and what the material samples. */
class Cascade {
  readonly patch: Patch;
  /** Whether the patch keeps foam; the finer one does not. */
  readonly foamy: boolean;
  /** The world position of the floating origin within the patch, as texture coordinates. */
  readonly origin = uniform(new Vector2());
  /** The two outputs, written in turn: the slope east and north, the foam, the height. */
  readonly out: [StorageTexture, StorageTexture];
  /** Which of them the last frame wrote. */
  current = 0;
  /** The spectrum's inputs at the last frame. */
  readonly inputs: SpectrumInputs = newSpectrumInputs();

  readonly #sea: WeatherSea;
  readonly #modes: DataTexture;
  readonly #table: DataTexture;
  readonly #spectrumOut: StorageTexture;
  readonly #rowsOut: StorageTexture;
  readonly #spectrum: ComputeNode;
  readonly #rows: ComputeNode;
  readonly #columns: ComputeNode;
  readonly #assemble: [ComputeNode, ComputeNode];
  /** The loop's fraction; then the spectrum's level with the fit and the spreading's norm, its peak, and the waves' direction. */
  readonly #time = uniform(0);
  readonly #level = uniform(0);
  readonly #peak = uniform(1);
  readonly #toward = uniform(new Vector2(1, 0));
  /** The fold's threshold and chop, how much of the foam a frame keeps, and how much it spreads to each neighbour. */
  readonly #fold = uniform(new Vector4(0.5, 1, 0, 0));
  /** The texture nodes the material samples, which follow the output last written. */
  readonly #samplers: { value: StorageTexture }[] = [];
  /** What the inputs were computed from. */
  #from = [Number.NaN, 0, 0, 0];

  constructor(sea: WeatherSea, patch: Patch, foamy: boolean, anisotropy: number) {
    this.#sea = sea;
    this.patch = patch;
    this.foamy = foamy;
    const n = patch.size;
    this.#modes = floatTexture(modeTexels(patch), n, n);
    this.#table = floatTexture(transformTable(n), n, 1);
    this.#spectrumOut = workTexture(n, 'detail spectrum');
    this.#rowsOut = workTexture(n, 'detail rows');
    this.out = [this.#output(anisotropy), this.#output(anisotropy)];
    this.#spectrum = this.#spectrumKernel();
    this.#rows = this.#lineKernel(this.#spectrumOut, this.#rowsOut, false);
    // The columns' output goes back where the spectrum was: it is not read again.
    this.#columns = this.#lineKernel(this.#rowsOut, this.#spectrumOut, true);
    this.#assemble = [this.#assembleKernel(1, 0), this.#assembleKernel(0, 1)];
  }

  #output(anisotropy: number): StorageTexture {
    const t = new StorageTexture(this.patch.size, this.patch.size);
    t.type = HalfFloatType;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    t.name = 'detail';
    return t;
  }

  set anisotropy(a: number) {
    for (const t of this.out) {
      if (t.anisotropy !== a) {
        t.anisotropy = a;
        t.needsUpdate = true;
      }
    }
  }

  /** The level of the output whose texels are nearest a size in metres. */
  levelFor(metres: number): number {
    return Math.max(0, Math.round(Math.log2((metres * this.patch.size) / this.patch.length)));
  }

  /** The output at texture coordinates, as a node that follows the output last written. */
  sample(uv: Node<'vec2'>, level: number | null): Node<'vec4'> {
    const node =
      level === null ? texture(this.out[0], uv) : texture(this.out[0], uv).level(float(level));
    this.#samplers.push(node as unknown as { value: StorageTexture });
    return node as unknown as Node<'vec4'>;
  }

  /** Pass 1: H(k) at the frame's time, as the two fields to transform. */
  #spectrumKernel(): ComputeNode {
    const n = this.patch.size;
    const dk = stepOf(this.patch);
    const sea = this.#sea;
    return Fn(() => {
      const at = ivec2(globalId.xy);
      const m = textureLoad(this.#modes, at);
      const out = vec4(0).toVar();
      If(m.w.greaterThan(0), () => {
        // The wave vector's whole numbers: 0 … n/2 − 1, then −n/2 … −1.
        const index = vec2(at);
        const kv = index.sub(floor(index.mul(2 / n)).mul(n)).mul(dk);
        const k = length(kv);
        const omega = sqrt(k.mul(GRAVITY));
        // JONSWAP: level ω⁻⁵ exp(−5/4 (peak/ω)⁴) γ^r, r = exp(−(ω − peak)² / (2 σ² peak²)).
        const sigma = omega.lessThan(this.#peak).select(sea.sigmaBelow, sea.sigmaAbove);
        const d = omega.sub(this.#peak).div(this.#peak.mul(sigma));
        const r = exp(d.mul(d).mul(-0.5));
        const q = this.#peak.div(omega);
        const q2 = q.mul(q);
        const o2 = omega.mul(omega);
        const s = this.#level
          .mul(exp(q2.mul(q2).mul(-1.25)))
          .mul(pow(float(sea.gamma), r))
          .div(o2.mul(o2).mul(omega));
        // Twice the wave's energy, before the spreading: its amplitude squared.
        const a2 = s.mul(m.w).mul(2);
        const c = dot(kv, this.#toward).div(k);
        // cos²ˢ(θ/2) for the wave and for its opposite, whose cosine is the negative.
        const a = sqrt(a2.mul(pow(c.add(1).mul(0.5), float(sea.spreading))));
        const b = sqrt(a2.mul(pow(float(1).sub(c).mul(0.5), float(sea.spreading))));
        // The turns since the loop began; only their fraction matters, and
        // the phases are brought into half a turn either side of nothing.
        const turned = m.z.mul(this.#time);
        const here = m.x.sub(turned);
        const there = m.y.sub(turned);
        const ph = here.sub(floor(here.add(0.5))).mul(TWO_PI);
        const pt = there.sub(floor(there.add(0.5))).mul(TWO_PI);
        const hr = a
          .mul(cos(ph))
          .add(b.mul(cos(pt)))
          .mul(0.5);
        const hi = a
          .mul(sin(ph))
          .sub(b.mul(sin(pt)))
          .mul(0.5);
        // (1 − k_e) H, whose transform is the height + i · the slope east;
        // i (k_n + k) H, whose transform is the slope north + i · the convergence.
        const east = float(1).sub(kv.x);
        const north = kv.y.add(k);
        out.assign(vec4(east.mul(hr), east.mul(hi), north.mul(hi).negate(), north.mul(hr)));
      });
      textureStore(this.#spectrumOut, at, out);
    })().computeKernel([8, 8, 1]);
  }

  /** Passes 2 and 3: the transform of every row, or of every column, one workgroup each. */
  #lineKernel(from: StorageTexture, to: StorageTexture, columns: boolean): ComputeNode {
    const n = this.patch.size;
    const bits = Math.log2(n);
    const even = workgroupArray('vec4', n) as unknown as Shared;
    const odd = workgroupArray('vec4', n) as unknown as Shared;
    const at = (i: Node<'int'>, line: Node<'int'>): Node =>
      columns ? ivec2(line, i) : ivec2(i, line);
    return Fn(() => {
      const i = int(localId.x);
      const line = int(workgroupId.y);
      // The inputs in bit-reversed order, so that the outputs come in order.
      const reversed = int(textureLoad(this.#table, ivec2(i, 0)).z);
      even.element(i).assign(textureLoad(from, at(reversed, line)));
      workgroupBarrier();
      let read = even;
      let write = odd;
      for (let stage = 1; stage <= bits; stage++) {
        const size = 1 << stage;
        const half = size >> 1;
        // Within its block of `size`, element p is x[p mod half] + w^p x[p mod half + half],
        // w = e^(2πi/size): w^(p + half) = −w^p gives the lower half its minus.
        const p = i.bitAnd(size - 1);
        const lo = i.sub(p).add(p.bitAnd(half - 1));
        const w = textureLoad(this.#table, ivec2(p.mul(n / size), 0));
        const x = read.element(lo);
        const y = read.element(lo.add(half));
        write
          .element(i)
          .assign(
            vec4(
              x.x.add(w.x.mul(y.x)).sub(w.y.mul(y.y)),
              x.y.add(w.y.mul(y.x)).add(w.x.mul(y.y)),
              x.z.add(w.x.mul(y.z)).sub(w.y.mul(y.w)),
              x.w.add(w.y.mul(y.z)).add(w.x.mul(y.w)),
            ),
          );
        workgroupBarrier();
        [read, write] = [write, read];
      }
      textureStore(to, at(i, line), read.element(i));
    })().computeKernel([n, 1, 1]);
  }

  /** Pass 4: the fields as the material reads them, and the foam's memory, from one output into the other. */
  #assembleKernel(before: number, into: number): ComputeNode {
    const n = this.patch.size;
    const prev = this.out[before] as StorageTexture;
    const next = this.out[into] as StorageTexture;
    return Fn(() => {
      const at = ivec2(globalId.xy);
      // Height, slope east, slope north, convergence.
      const f = textureLoad(this.#spectrumOut, at);
      const foam = float(0).toVar();
      if (this.foamy) {
        const wrap = (dx: number, dy: number): Node =>
          ivec2(at.x.add(dx).bitAnd(n - 1), at.y.add(dy).bitAnd(n - 1));
        const was = textureLoad(prev, at).z;
        const around = textureLoad(prev, wrap(1, 0))
          .z.add(textureLoad(prev, wrap(-1, 0)).z)
          .add(textureLoad(prev, wrap(0, 1)).z)
          .add(textureLoad(prev, wrap(0, -1)).z);
        const kept = mix(was, around.mul(0.25), this.#fold.w.mul(4)).mul(this.#fold.z);
        // The Jacobian of the shifted surface, to first order: 1 − chop × convergence.
        const jacobian = float(1).sub(this.#fold.y.mul(f.w));
        foam.assign(max(clamp(this.#fold.x.sub(jacobian).mul(3), 0, 1), kept));
      }
      textureStore(next, at, vec4(f.y, f.z, foam, f.x));
    })().computeKernel([8, 8, 1]);
  }

  /**
   * Runs the four passes for a frame. foam is what the foam does under the
   * boat; dt the world time since the last frame, in seconds: with none, the
   * foam is left as it is.
   */
  step(renderer: WebGPURenderer, f: DetailFrame, foam: FoamLook): void {
    const p = this.patch;
    const n = p.size;
    const u = f.under;
    const from = this.#from;
    if (from[0] !== u.speed || from[1] !== u.fetch || from[2] !== u.east || from[3] !== u.north) {
      this.#from = [u.speed, u.fetch, u.east, u.north];
      spectrumInputs(this.#sea, p, u, this.inputs);
    }
    const s = this.inputs;
    this.#level.value = s.level * s.fit * spreadNorm(this.#sea.spreading);
    this.#peak.value = s.peak;
    this.#toward.value.set(s.east, s.north);
    this.#time.value = loopFraction(f.time, p.period);
    const cell = p.length / n;
    const moving = f.dt > 0;
    this.#fold.value.set(
      foam.threshold,
      foam.chop,
      moving ? Math.exp(-f.dt / foam.decay) : 1,
      moving ? Math.min((DETAIL.spread * f.dt) / (cell * cell), 0.2) : 0,
    );
    // A texel's centre is half a texel into the patch.
    this.origin.value.set(
      fract1(f.originEast / p.length) + 0.5 / n,
      fract1(f.originNorth / p.length) + 0.5 / n,
    );
    const into = 1 - this.current;
    renderer.compute(this.#spectrum, [n / 8, n / 8, 1]);
    renderer.compute(this.#rows, [1, n, 1]);
    renderer.compute(this.#columns, [1, n, 1]);
    renderer.compute(this.#assemble[into] as ComputeNode, [n / 8, n / 8, 1]);
    this.current = into;
    const written = this.out[into] as StorageTexture;
    for (const node of this.#samplers) {
      node.value = written;
    }
  }

  /** The four kernels, for compiling ahead of their first frame. */
  get kernels(): ComputeNode[] {
    return [this.#spectrum, this.#rows, this.#columns, ...this.#assemble];
  }

  /** Forgets the foam: the next frames start from clear water. */
  clear(): void {
    for (const t of this.out) {
      t.dispose();
    }
  }

  dispose(): void {
    for (const t of [this.#modes, this.#table, this.#spectrumOut, this.#rowsOut, ...this.out]) {
      t.dispose();
    }
    for (const k of [this.#spectrum, this.#rows, this.#columns, ...this.#assemble]) {
      k.dispose();
    }
  }
}

/** The band as compute passes: one patch, or two. */
class Transformed {
  readonly first: Cascade;
  readonly second: Cascade | null;
  readonly nodes: DetailNodes;
  /** 1 over three standard deviations of the height, for the height the material reads. */
  readonly #perHeight = uniform(0);
  readonly #sea: WeatherSea;

  constructor(sea: WeatherSea, size: number, patches: number, anisotropy: number) {
    this.#sea = sea;
    const patch = detailPatch(sea, size, DETAIL.patch, DETAIL.period);
    this.first = new Cascade(sea, patch, true, anisotropy);
    this.second =
      patches === 2
        ? new Cascade(
            sea,
            finerPatch(patch, DETAIL.finePatch, DETAIL.fineLongest),
            false,
            anisotropy,
          )
        : null;
    const first = this.first;
    const second = this.second;
    const coords = (c: Cascade, p: Node<'vec2'>): Node<'vec2'> =>
      c.origin.add(vec2(p.x, p.y.negate()).mul(1 / c.patch.length)) as unknown as Node<'vec2'>;
    const read = (c: Cascade, p: Node<'vec2'>, level: number | null): Node<'vec4'> => {
      const t = c.sample(coords(c, p), level);
      // The scene's z runs south.
      return vec4(t.x, t.y.negate(), t.z, t.w.mul(this.#perHeight)) as unknown as Node<'vec4'>;
    };
    this.nodes = {
      fine: (p) => read(first, p, null),
      coarse: (p) => read(first, p, first.levelFor(DETAIL.tileTexel)),
      ripple: second === null ? null : (p) => read(second, p, null).xy as unknown as Node<'vec2'>,
      filtered: true,
    };
  }

  step(renderer: WebGPURenderer, f: DetailFrame, foam: FoamLook): void {
    this.first.step(renderer, f, foam);
    this.second?.step(renderer, f, foam);
    const sigma = Math.sqrt(this.first.inputs.variance);
    this.#perHeight.value = sigma > 1e-6 ? 1 / (3 * sigma) : 0;
  }

  dispose(): void {
    this.first.dispose();
    this.second?.dispose();
  }

  get kernels(): ComputeNode[] {
    return [...this.first.kernels, ...(this.second?.kernels ?? [])];
  }

  get sea(): WeatherSea {
    return this.#sea;
  }
}

function loopTexture(size: number, frames: number, name: string): Data3DTexture {
  const t = new Data3DTexture(
    new Uint8Array(size * size * frames * 4).fill(128),
    size,
    size,
    frames,
  );
  t.format = RGBAFormat;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.wrapR = RepeatWrapping;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.name = name;
  t.needsUpdate = true;
  return t;
}

/** The band as a loop made once: two of them, for a light wind and a fresh one. */
class Baked {
  readonly nodes: DetailNodes;
  /** The bakers, until the loops are whole. */
  bakers: LoopBaker[] | null;
  /** Milliseconds the making took, and the longest of its slices. */
  spent = 0;
  longest = 0;

  readonly #sea: WeatherSea;
  readonly #patch: Patch;
  readonly #fine: Data3DTexture[];
  readonly #coarse: Data3DTexture[];
  /** Each loop's slope range and height's standard deviation. */
  readonly #ranges: number[] = [0, 0];
  readonly #sigmas: number[] = [1, 1];
  /** The floating origin's place in the patch as the wind has it turned. */
  readonly #origin = uniform(new Vector2());
  /** The direction the waves travel toward, east and north. */
  readonly #toward = uniform(new Vector2(1, 0));
  /** Where the frame is in the loop, as the third texture coordinate. */
  readonly #frame = uniform(0);
  /** Each loop's slopes' scale, then each loop's share. */
  readonly #gain = uniform(new Vector4());
  /** The loop as it is turned to the wind. */
  readonly #turned = new Turned(1 / DETAIL.patch, 1 / DETAIL.patch);
  #variance = { speed: Number.NaN, fetch: 0, value: 0 };

  constructor(sea: WeatherSea) {
    this.#sea = sea;
    this.#patch = {
      ...detailPatch(sea, BAKED.size, DETAIL.patch, BAKED.period),
      shortest: BAKED.shortest,
    };
    // As steep as the band the transform draws, so that it folds as often.
    const whole = detailPatch(sea, 128, DETAIL.patch, DETAIL.period);
    this.bakers = BAKED.winds.map((knots) => {
      const wind = {
        speed: knots * KNOT,
        east: 1,
        north: 0,
        fetch: BAKED.fetch * NAUTICAL_MILE,
      };
      const inputs = spectrumInputs(sea, this.#patch, wind, newSpectrumInputs());
      const steeper = spectrumInputs(sea, whole, wind, newSpectrumInputs());
      return new LoopBaker(
        sea,
        this.#patch,
        inputs,
        BAKED.frames,
        BAKED.coarse,
        foamAt(knots, newFoamLook()),
        DETAIL.spread,
        inputs.slope > 0 ? Math.sqrt(steeper.slope / inputs.slope) : 1,
      );
    });
    this.#fine = BAKED.winds.map((_, i) =>
      loopTexture(BAKED.size, BAKED.frames, `detail loop ${i}`),
    );
    this.#coarse = BAKED.winds.map((_, i) =>
      loopTexture(BAKED.coarse, BAKED.frames, `detail loop ${i}, tiles`),
    );

    const toward = this.#toward as unknown as Node<'vec2'>;
    const across = vec2(toward.y.negate(), toward.x);
    const length = this.#patch.length;
    const read = (textures: Data3DTexture[], p: Node<'vec2'>, vertex: boolean): Node<'vec4'> => {
      // East and north of the origin; then down the wind and across it.
      const q = vec2(p.x, p.y.negate());
      const uv = this.#origin.add(vec2(dot(q, toward), dot(q, across)).mul(1 / length));
      const at = vec3(uv, this.#frame);
      const sample = (i: number): Node<'vec4'> => {
        const t = texture3D(textures[i] as Data3DTexture, at);
        return (vertex ? t.level(float(0)) : t) as unknown as Node<'vec4'>;
      };
      const a = sample(0);
      const b = sample(1);
      // A byte b stands for (b − 128) / 127 of its range.
      const value = <T extends 'float' | 'vec2'>(v: Node<T>): Node<T> =>
        (v as unknown as Node<'float'>).mul(255 / 127).sub(128 / 127) as unknown as Node<T>;
      const slope = value(a.xy as Node<'vec2'>)
        .mul(this.#gain.x)
        .add(value(b.xy as Node<'vec2'>).mul(this.#gain.y));
      const world = toward.mul(slope.x).add(across.mul(slope.y));
      const foam = a.z.mul(this.#gain.z).add(b.z.mul(this.#gain.w));
      const height = value(a.w as Node<'float'>)
        .mul(this.#gain.z)
        .add(value(b.w as Node<'float'>).mul(this.#gain.w))
        .mul(HEIGHT_RANGE / 3);
      // The scene's z runs south.
      return vec4(world.x, world.y.negate(), foam, height) as unknown as Node<'vec4'>;
    };
    this.nodes = {
      fine: (p) => read(this.#fine, p, false),
      coarse: (p) => read(this.#coarse, p, true),
      ripple: null,
      filtered: false,
    };
  }

  /** Whether the loops are whole. */
  get ready(): boolean {
    return this.bakers === null;
  }

  /** Makes more of the loops, for at most budget milliseconds; uploads them once whole. */
  bake(budget: number): void {
    const bakers = this.bakers;
    if (bakers === null) {
      return;
    }
    const start = performance.now();
    for (const b of bakers) {
      if (!b.done && !b.work(budget - (performance.now() - start))) {
        break;
      }
      if (performance.now() - start >= budget) {
        break;
      }
    }
    const took = performance.now() - start;
    this.spent += took;
    this.longest = Math.max(this.longest, took);
    if (bakers.every((b) => b.done)) {
      bakers.forEach((b, i) => {
        ((this.#fine[i] as Data3DTexture).image.data as Uint8Array).set(b.loop.texels);
        ((this.#coarse[i] as Data3DTexture).image.data as Uint8Array).set(b.loop.coarseTexels);
        (this.#fine[i] as Data3DTexture).needsUpdate = true;
        (this.#coarse[i] as Data3DTexture).needsUpdate = true;
        this.#ranges[i] = b.loop.slopeRange;
        this.#sigmas[i] = b.loop.sigma;
      });
      this.bakers = null;
    }
  }

  step(f: DetailFrame, budget: number): void {
    this.bake(budget);
    const u = f.under;
    const t = this.#turned;
    t.update(u.east, u.north, f.originEast, f.originNorth, f.boatEast, f.boatNorth);
    // A texel's centre is half a texel into the patch.
    this.#origin.value.set(t.u + 0.5 / BAKED.size, t.v + 0.5 / BAKED.size);
    this.#toward.value.set(t.east, t.north);
    // Between two frames' middles, and round from the last to the first.
    this.#frame.value = (loopFraction(f.time, BAKED.period) * BAKED.frames + 0.5) / BAKED.frames;

    if (!this.ready) {
      this.#gain.value.set(0, 0, 0, 0);
      return;
    }
    const v = this.#variance;
    if (v.speed !== u.speed || v.fetch !== u.fetch) {
      v.speed = u.speed;
      v.fetch = u.fetch;
      v.value = bandVariance(this.#sea, this.#patch, u.speed, u.fetch);
    }
    const sigma = Math.sqrt(v.value);
    const [light, fresh] = BAKED.winds;
    const share = Math.min(Math.max((u.speed / KNOT - light) / (fresh - light), 0), 1);
    // Each loop scaled to the band's height under this wind.
    this.#gain.value.set(
      (((1 - share) * sigma) / (this.#sigmas[0] as number)) * (this.#ranges[0] as number),
      ((share * sigma) / (this.#sigmas[1] as number)) * (this.#ranges[1] as number),
      sigma > 0 ? 1 - share : 0,
      sigma > 0 ? share : 0,
    );
  }

  dispose(): void {
    for (const t of [...this.#fine, ...this.#coarse]) {
      t.dispose();
    }
  }
}

/** What the last frame of the detail band did, for the developer panel and the tests. */
export interface DetailState {
  kind: string;
  /** Whether the low tier's loops are whole, how long they took to make, and the longest slice, ms. */
  baked: boolean;
  bakeSpent: number;
  bakeLongest: number;
}

function sameKind(a: DetailKind, b: DetailKind): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind !== 'fft' || (b.kind === 'fft' && a.size === b.size && a.patches === b.patches);
}

/** The most a frame spends making the low tier's loops, in milliseconds. */
export const BAKE_SLICE = 4;

/**
 * The detail band: whichever way of making it the quality in use asks for.
 * A change is made in two steps: set makes the new band, for new materials
 * to be built and compiled against, while the old one goes on being drawn;
 * commit puts the new one in use, as the materials are swapped.
 */
export class Detail {
  /** The band asked for last: what the materials being built read. */
  kind: DetailKind = { kind: 'none' };
  /** What the materials being built read, or null with no detail band. Changes whenever set returns a change. */
  nodes: DetailNodes | null = null;
  /** In place of the foam under the boat, for the tests: where the surface folds and how long the foam lasts. */
  fold: FoamLook | null = null;

  readonly #sea: WeatherSea;
  #anisotropy = 1;
  /** The band in use, and the one asked for. */
  #active: { kind: DetailKind; transformed: Transformed | null } = {
    kind: { kind: 'none' },
    transformed: null,
  };
  #next: { kind: DetailKind; transformed: Transformed | null } = this.#active;
  #baked: Baked | null = null;

  constructor(sea: WeatherSea) {
    this.#sea = sea;
  }

  /**
   * Chooses how the band is made. When that changes what the material reads,
   * so that the sea's materials must be made again, returns what to call
   * once nothing draws with the old ones: it lets go of what they read.
   * Otherwise null.
   */
  set(kind: DetailKind, anisotropy: number): (() => void) | null {
    this.#anisotropy = anisotropy;
    if (sameKind(kind, this.kind)) {
      const t = this.#next.transformed;
      if (t !== null) {
        t.first.anisotropy = anisotropy;
        if (t.second !== null) {
          t.second.anisotropy = anisotropy;
        }
      }
      return null;
    }
    this.kind = kind;
    // A band asked for and overtaken before it was used is let go at once.
    if (this.#next !== this.#active) {
      this.#next.transformed?.dispose();
    }
    const transformed =
      kind.kind === 'fft' ? new Transformed(this.#sea, kind.size, kind.patches, anisotropy) : null;
    this.#next = { kind, transformed };
    if (transformed !== null) {
      this.nodes = transformed.nodes;
    } else if (kind.kind === 'baked') {
      // The loops are kept once made: a device that comes back to them does not make them again.
      this.#baked ??= new Baked(this.#sea);
      this.nodes = this.#baked.nodes;
    } else {
      this.nodes = null;
    }
    const old = this.#active.transformed;
    return () => {
      if (old !== this.#active.transformed) {
        old?.dispose();
      }
    };
  }

  /** Puts the band asked for in use. */
  commit(): void {
    this.#active = this.#next;
  }

  /** Compiles the transform's kernels off the frame, where the band asked for has any. */
  compile(renderer: WebGPURenderer): Promise<void> {
    const t = this.#next.transformed;
    if (t === null) {
      return Promise.resolve();
    }
    return renderer.compileComputeAsync(t.kernels).then(() => undefined);
  }

  /** Brings the band in use to a frame: on WebGPU its compute passes, on the low tier a slice of its loops. */
  update(renderer: WebGPURenderer, f: DetailFrame): void {
    const a = this.#active;
    if (a.transformed !== null) {
      a.transformed.step(renderer, f, this.fold ?? f.under.foam);
    } else if (a.kind.kind === 'baked') {
      this.#baked?.step(f, BAKE_SLICE);
    } else if (this.#next.kind.kind === 'baked') {
      // The loops are made while the band before them is still drawn.
      this.#baked?.bake(BAKE_SLICE);
    }
  }

  /** The transform's patches in use, for the tests that read them back. */
  get patches(): { first: Cascade; second: Cascade | null } | null {
    return this.#active.transformed;
  }

  /** Clears the foam the transform remembers. */
  clearFoam(): void {
    this.#active.transformed?.first.clear();
  }

  /** Makes the low tier's loops whole at once (the tests' pictures). */
  finishBake(): void {
    while (this.#baked !== null && !this.#baked.ready) {
      this.#baked.bake(1000);
    }
  }

  get state(): DetailState {
    const k = this.#active.kind;
    return {
      kind: k.kind === 'fft' ? `fft ${k.size} × ${k.patches}` : k.kind,
      baked: this.#baked?.ready ?? false,
      bakeSpent: this.#baked?.spent ?? 0,
      bakeLongest: this.#baked?.longest ?? 0,
    };
  }

  get anisotropy(): number {
    return this.#anisotropy;
  }
}

export type { Cascade };

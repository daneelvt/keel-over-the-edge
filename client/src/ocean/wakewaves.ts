// SPDX-License-Identifier: AGPL-3.0-only

// The wake's waves as the sea's material reads them: a small square of
// water that follows the boat, a quarter of its side astern of it, which
// every hull in it pushes on and whose waves run by deep water's own
// dispersion (wakewavescpu.ts has the physics, and the reference in float64).
// Drawn, never felt: no boat rides them, and they never lift a tile; they
// tilt, ripple and light the tiles as the detail band does.
//
// On WebGPU it is the reference's step as four compute passes, by the
// detail band's transform (detail.ts): one workgroup a row or a column, its
// invocations sharing the line and running the radix-2 stages between two
// arrays.
//
//   1  every row of u = h + d: the last step's height, moved by the
//      square's whole texels and the water's drift, damped toward the rim,
//      under the hulls' pressure; transformed
//   2  every column, and then each wave turned by ωΔt with the potential's
//      transform, which is kept from step to step in two textures that
//      take turns; out go (1 − k_e) u' and i (k_n + |k|) u'
//   3  every row back
//   4  every column back: the height, kept for the next step, and the
//      slopes, the convergence and the height for the material, with
//      mipmaps
//
// The forward transform is the inverse one read backwards: its input read
// from n − j, which turns e^(+2πi) into e^(−2πi). The hulls' pressure is
// drawn first into a target of its own, one instance a hull; a target's
// first row is the top of what was drawn, the square's north.
//
// On the low tier, and wherever compute passes are not to be had, the
// reference itself steps the field on the CPU at 64², a few tens of times a
// second, and its outputs are uploaded as half floats with their mipmaps.
// Tessendorf's iWave, a convolution the low tier could run in one fragment
// pass, does not keep deep water's dispersion over the longer of a dinghy's
// waves: with a 13 × 13 kernel its waves across the track came out 8 to 10%
// short at 2.5 and 3.5 m/s.

import {
  AddEquation,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  DynamicDrawUsage,
  FloatType,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RenderTarget,
  RGBAFormat,
  Scene,
  type Texture,
  Vector2,
  Vector4,
} from 'three';
import {
  abs,
  attribute,
  cos,
  exp,
  Fn,
  float,
  floor,
  int,
  ivec2,
  length,
  localId,
  max,
  min,
  mix,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  textureLoad,
  textureStore,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import {
  type ComputeNode,
  MeshBasicNodeMaterial,
  type Node,
  StorageTexture,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu';
import type { WakeWavesKind } from '../render/quality';
import { transformTable } from './detail';
import { HULL_SHAPES } from './hulls';
import { WAKE, WAKE_WAVES } from './look';
import { GRAVITY } from './spectrum';
import {
  type PressureShape,
  rimKept,
  SAMPLES,
  type WakeDamping,
  type WakeHull,
  WakeWavesReference,
} from './wakewavescpu';

/** The most hulls that push on the square in a frame: a full view and the player's own. */
export const WAKE_HULLS = 80;

const TWO_PI = 2 * Math.PI;

/** The damping the look asks for. */
export function wakeDamping(): WakeDamping {
  return {
    rim: WAKE_WAVES.rim,
    rimRate: WAKE_WAVES.rimRate,
    rate: WAKE_WAVES.rate,
    fine: WAKE_WAVES.fine,
  };
}

/** What a frame gives the wake's waves. */
export interface WakeWavesFrame {
  /** The floating origin, and the boat, in the world: metres east and north; the boat's heading. */
  originEast: number;
  originNorth: number;
  boatEast: number;
  boatNorth: number;
  heading: number;
  /** World time since the last frame, in seconds. */
  dt: number;
  /** The current at the boat, m/s east and north: the water the waves are in drifts with it. */
  currentEast: number;
  currentNorth: number;
}

/** Memory a workgroup's invocations share. */
interface Shared {
  element(i: Node): Node<'vec4'> & { assign(v: Node): void };
}

function work(size: number, name: string, red = false): StorageTexture {
  const t = new StorageTexture(size, size);
  t.type = FloatType;
  if (red) {
    t.format = RedFormat;
  }
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

/** What a step needs of the square's placing: the shift, in texels, and whether it starts afresh. */
interface StepInputs {
  dt: number;
  shiftEast: number;
  shiftNorth: number;
  fresh: boolean;
}

/** The field as compute passes. */
class Transformed {
  readonly size: number;
  readonly span: number;
  /** What the material samples: the slopes east and north, the convergence, the height. */
  readonly out: StorageTexture;
  /** The hulls' immersion, drawn by the stamps. */
  readonly pressure: RenderTarget;
  /** The height kept from step to step. */
  readonly #height: StorageTexture;
  /** The potential's transform, in two that take turns. */
  readonly #phi: [StorageTexture, StorageTexture];
  #current = 0;
  readonly #rows: StorageTexture;
  readonly #columns: StorageTexture;
  readonly #table: DataTexture;
  readonly #kernels: {
    rows: ComputeNode;
    columns: [ComputeNode, ComputeNode];
    back: ComputeNode;
    out: ComputeNode;
  };
  /** The shift east and north in texels, dt, and 1 for a fresh start. */
  readonly #step = uniform(new Vector4());
  /** The four passes for each of the potential's two textures, as one pass's list. */
  readonly #lists: [ComputeNode[], ComputeNode[]] = [[], []];

  constructor(size: number, span: number, damping: WakeDamping) {
    this.size = size;
    this.span = span;
    this.out = new StorageTexture(size, size);
    this.out.type = HalfFloatType;
    this.out.wrapS = ClampToEdgeWrapping;
    this.out.wrapT = ClampToEdgeWrapping;
    this.out.magFilter = LinearFilter;
    this.out.minFilter = LinearMipmapLinearFilter;
    this.out.generateMipmaps = true;
    this.out.name = 'wake waves';
    this.pressure = new RenderTarget(size, size, {
      format: RedFormat,
      type: HalfFloatType,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    });
    this.pressure.texture.name = 'wake pressure';
    this.#height = work(size, 'wake height', true);
    this.#phi = [work(size, 'wake potential'), work(size, 'wake potential')];
    this.#rows = work(size, 'wake rows');
    this.#columns = work(size, 'wake columns');
    this.#table = new DataTexture(transformTable(size), size, 1, RGBAFormat, FloatType);
    this.#table.minFilter = NearestFilter;
    this.#table.magFilter = NearestFilter;
    this.#table.generateMipmaps = false;
    this.#table.needsUpdate = true;
    this.#kernels = {
      rows: this.#forwardRows(damping),
      columns: [this.#forwardColumns(0, damping), this.#forwardColumns(1, damping)],
      back: this.#backRows(),
      out: this.#backColumns(),
    };
  }

  /**
   * One line's transform, one workgroup a line: loaded in the order of its
   * bits reversed, then log₂n radix-2 stages between two arrays (detail.ts).
   */
  #line(
    vec: 'vec2' | 'vec4',
    load: (j: Node<'int'>, line: Node<'int'>) => Node,
    store: (i: Node<'int'>, line: Node<'int'>, v: Node<'vec4'>) => void,
  ): ComputeNode {
    const n = this.size;
    const bits = Math.log2(n);
    const even = workgroupArray(vec, n) as unknown as Shared;
    const odd = workgroupArray(vec, n) as unknown as Shared;
    const table = this.#table;
    return Fn(() => {
      const i = int(localId.x);
      const line = int(workgroupId.y);
      const reversed = int(textureLoad(table, ivec2(i, 0)).z);
      even.element(i).assign(load(reversed, line));
      workgroupBarrier();
      let read = even;
      let write = odd;
      for (let stage = 1; stage <= bits; stage++) {
        const size = 1 << stage;
        const half = size >> 1;
        const p = i.bitAnd(size - 1);
        const lo = i.sub(p).add(p.bitAnd(half - 1));
        const w = textureLoad(table, ivec2(p.mul(n / size), 0));
        const x = read.element(lo);
        const y = read.element(lo.add(half));
        const re = x.x.add(w.x.mul(y.x)).sub(w.y.mul(y.y));
        const im = x.y.add(w.y.mul(y.x)).add(w.x.mul(y.y));
        if (vec === 'vec2') {
          write.element(i).assign(vec2(re, im));
        } else {
          write
            .element(i)
            .assign(
              vec4(
                re,
                im,
                x.z.add(w.x.mul(y.z)).sub(w.y.mul(y.w)),
                x.w.add(w.y.mul(y.z)).add(w.x.mul(y.w)),
              ),
            );
        }
        workgroupBarrier();
        [read, write] = [write, read];
      }
      const v = read.element(i);
      store(i, line, (vec === 'vec2' ? vec4(v.x, v.y, 0, 0) : v) as unknown as Node<'vec4'>);
    })().computeKernel([n, 1, 1]);
  }

  /** Pass 1: u = h + d, moved, damped at the rim; every row transformed. */
  #forwardRows(damping: WakeDamping): ComputeNode {
    const n = this.size;
    const s = this.#step as unknown as Node<'vec4'>;
    const height = this.#height;
    const pressure = this.pressure.texture;
    const rows = this.#rows;
    return this.#line(
      'vec2',
      (j, line) => {
        // Read backwards: the forward transform.
        const x = int(n)
          .sub(j)
          .bitAnd(n - 1);
        const y = line;
        const sx = x.add(int(s.x));
        const sy = y.add(int(s.y));
        const inside = sx
          .greaterThanEqual(0)
          .and(sx.lessThan(n))
          .and(sy.greaterThanEqual(0))
          .and(sy.lessThan(n));
        const was = select(
          inside,
          textureLoad(height, ivec2(sx.bitAnd(n - 1), sy.bitAnd(n - 1))).x,
          float(0),
        );
        // Toward the rim, damped (rimKept).
        const half = n / 2;
        const ax = abs(float(x).add(0.5 - half)).div(half);
        const ay = abs(float(y).add(0.5 - half)).div(half);
        const r = max(
          max(ax, ay)
            .sub(1 - damping.rim)
            .div(damping.rim),
          0,
        );
        const kept = exp(s.z.mul(-damping.rimRate).mul(r).mul(r));
        const d = textureLoad(pressure, ivec2(x, int(n - 1).sub(y))).x;
        // A fresh start: the hulls float in their dents, h = −d, u = 0.
        const u = select(s.w.greaterThan(0.5), float(0), was.mul(kept).add(d));
        return vec2(u, 0);
      },
      (i, line, v) => {
        textureStore(rows, ivec2(i, line), v);
      },
    );
  }

  /** Pass 2: every column transformed, then each wave turned; out go A and B, and the potential. */
  #forwardColumns(from: number, damping: WakeDamping): ComputeNode {
    const n = this.size;
    const s = this.#step as unknown as Node<'vec4'>;
    const rows = this.#rows;
    const columns = this.#columns;
    const before = this.#phi[from] as StorageTexture;
    const after = this.#phi[1 - from] as StorageTexture;
    const table = this.#table;
    const dk = TWO_PI / this.span;
    const most = Math.PI / (this.span / n);
    const scale = 1 / (n * n);
    return this.#line(
      'vec2',
      (j, line) =>
        textureLoad(
          rows,
          ivec2(
            line,
            int(n)
              .sub(j)
              .bitAnd(n - 1),
          ),
        ).xy,
      (i, line, v) => {
        const col = line;
        const row = i;
        const at = ivec2(col, row);
        const we = select(col.lessThan(n / 2), col, col.sub(n));
        const wn = select(row.lessThan(n / 2), row, row.sub(n));
        const kv = vec2(float(we), float(wn)).mul(dk);
        const k = length(kv);
        // The potential, moved with the square: e^(2πi s·m/n), from the table, exactly.
        const turn = int(s.x)
          .mul(col)
          .add(int(s.y).mul(row))
          .bitAnd(n - 1);
        const t = textureLoad(table, ivec2(turn, 0));
        const old = textureLoad(before, at);
        const fresh = s.w.greaterThan(0.5);
        const fr = select(fresh, float(0), old.x.mul(t.x).sub(old.y.mul(t.y)));
        const fi = select(fresh, float(0), old.x.mul(t.y).add(old.y.mul(t.x)));
        // Read backwards both ways, the lines made the forward transform.
        const ur = v.x;
        const ui = v.y;
        const omega = sqrt(k.mul(GRAVITY));
        const c = cos(omega.mul(s.z));
        const sn = sin(omega.mul(s.z));
        const fade = exp(s.z.negate().mul(pow(k.div(most), 4).mul(damping.fine).add(damping.rate)));
        const ratio = k.div(max(omega, 1e-6));
        const g = float(GRAVITY).div(max(omega, 1e-6));
        const nyquist = col.equal(n / 2).or(row.equal(n / 2));
        const moving = k.greaterThan(0).and(nyquist.not());
        const nur = select(moving, ur.mul(c).add(ratio.mul(fr).mul(sn)).mul(fade), ur);
        const nui = select(moving, ui.mul(c).add(ratio.mul(fi).mul(sn)).mul(fade), ui);
        const nfr = select(moving, fr.mul(c).sub(g.mul(ur).mul(sn)).mul(fade), float(0));
        const nfi = select(moving, fi.mul(c).sub(g.mul(ui).mul(sn)).mul(fade), float(0));
        const keep = select(nyquist, float(0), float(scale));
        const or = nur.mul(keep);
        const oi = nui.mul(keep);
        const a = float(1).sub(kv.x);
        const b = kv.y.add(k);
        textureStore(after, at, vec4(nfr, nfi, 0, 0));
        textureStore(columns, at, vec4(a.mul(or), a.mul(oi), b.mul(oi).negate(), b.mul(or)));
      },
    );
  }

  /** Pass 3: every row back. */
  #backRows(): ComputeNode {
    const columns = this.#columns;
    const rows = this.#rows;
    return this.#line(
      'vec4',
      (j, line) => textureLoad(columns, ivec2(j, line)),
      (i, line, v) => {
        textureStore(rows, ivec2(i, line), v);
      },
    );
  }

  /** Pass 4: every column back; the height kept, and what the material reads. */
  #backColumns(): ComputeNode {
    const rows = this.#rows;
    const height = this.#height;
    const out = this.out;
    const pressure = this.pressure.texture;
    return this.#line(
      'vec4',
      (j, line) => textureLoad(rows, ivec2(line, j)),
      (i, line, v) => {
        const at = ivec2(line, i);
        const h = v.x.sub(textureLoad(pressure, ivec2(line, int(this.size - 1).sub(i))).x);
        textureStore(height, at, vec4(h, 0, 0, 0));
        textureStore(out, at, vec4(v.y, v.z, v.w, h));
      },
    );
  }

  step(renderer: WebGPURenderer, inputs: StepInputs): void {
    const n = this.size;
    this.#step.value.set(inputs.shiftEast, inputs.shiftNorth, inputs.dt, inputs.fresh ? 1 : 0);
    // One compute pass: its dispatches run in order, each seeing what the
    // one before wrote.
    const k = this.#kernels;
    const list = this.#lists[this.#current] as ComputeNode[];
    list[0] = k.rows;
    list[1] = k.columns[this.#current] as ComputeNode;
    list[2] = k.back;
    list[3] = k.out;
    renderer.compute(list, [1, n, 1]);
    this.#current = 1 - this.#current;
  }

  get kernels(): ComputeNode[] {
    const k = this.#kernels;
    return [k.rows, ...k.columns, k.back, k.out];
  }

  get textures(): Texture[] {
    return [
      this.out,
      this.pressure.texture,
      this.#height,
      ...this.#phi,
      this.#rows,
      this.#columns,
      this.#table,
    ];
  }

  dispose(): void {
    for (const t of [
      this.out,
      this.#height,
      ...this.#phi,
      this.#rows,
      this.#columns,
      this.#table,
    ]) {
      t.dispose();
    }
    this.pressure.dispose();
    for (const k of this.kernels) {
      k.dispose();
    }
  }
}

/** The field on the CPU: the reference, its outputs uploaded as half floats with mipmaps. */
class Stepped {
  readonly size: number;
  readonly span: number;
  readonly field: WakeWavesReference;
  readonly out: DataTexture;
  /** World time gathered since the last step. */
  pending = 0;
  readonly #levels: Float32Array[] = [];

  constructor(size: number, span: number, damping: WakeDamping) {
    this.size = size;
    this.span = span;
    this.field = new WakeWavesReference(size, span, damping);
    const levels: { data: Uint16Array; width: number; height: number }[] = [];
    for (let s = size; s >= 1; s >>= 1) {
      levels.push({ data: new Uint16Array(s * s * 4), width: s, height: s });
      this.#levels.push(new Float32Array(s * s * 4));
    }
    const first = levels[0] as { data: Uint16Array };
    this.out = new DataTexture(first.data, size, size, RGBAFormat, HalfFloatType);
    this.out.mipmaps = levels as unknown as DataTexture['mipmaps'];
    this.out.wrapS = ClampToEdgeWrapping;
    this.out.wrapT = ClampToEdgeWrapping;
    this.out.magFilter = LinearFilter;
    this.out.minFilter = LinearMipmapLinearFilter;
    this.out.generateMipmaps = false;
    this.out.name = 'wake waves';
    this.out.needsUpdate = true;
  }

  /** The reference's outputs, and each level below by the mean of four. */
  upload(): void {
    const f = this.field;
    const n = this.size;
    const top = this.#levels[0] as Float32Array;
    for (let i = 0; i < n * n; i++) {
      top[i * 4] = f.east[i] as number;
      top[i * 4 + 1] = f.north[i] as number;
      top[i * 4 + 2] = f.convergence[i] as number;
      top[i * 4 + 3] = f.h[i] as number;
    }
    let s = n;
    for (let l = 1; l < this.#levels.length; l++) {
      const from = this.#levels[l - 1] as Float32Array;
      const to = this.#levels[l] as Float32Array;
      const half = s >> 1;
      for (let row = 0; row < half; row++) {
        for (let col = 0; col < half; col++) {
          for (let c = 0; c < 4; c++) {
            const a = (2 * row * s + 2 * col) * 4 + c;
            const b = ((2 * row + 1) * s + 2 * col) * 4 + c;
            to[(row * half + col) * 4 + c] =
              ((from[a] as number) +
                (from[a + 4] as number) +
                (from[b] as number) +
                (from[b + 4] as number)) *
              0.25;
          }
        }
      }
      s = half;
    }
    const mips = this.out.mipmaps as unknown as { data: Uint16Array }[];
    this.#levels.forEach((level, l) => {
      const data = (mips[l] as { data: Uint16Array }).data;
      for (let i = 0; i < level.length; i++) {
        data[i] = DataUtils.toHalfFloat(level[i] as number);
      }
    });
    this.out.needsUpdate = true;
  }

  dispose(): void {
    this.out.dispose();
  }
}

/** What the last frame of the wake's waves did, for the panel and the tests. */
export interface WakeWavesState {
  kind: string;
  /** Hulls pushing on the square, steps taken in all, and milliseconds the CPU's last step took. */
  hulls: number;
  steps: number;
  cpuMs: number;
}

/** The wake's waves: whichever way of making them the tier asks for. */
/** One way of making the waves, with what the material reads of it. */
interface Way {
  kind: WakeWavesKind;
  transformed: Transformed | null;
  stepped: Stepped | null;
  /** The texture the material reads. */
  out: Texture;
  /** The floating origin's place in the square, as texture coordinates; 1 over its side; the mipmap of a tile's texels. */
  origin: UniformNode<'vec2', Vector2>;
  perSpan: UniformNode<'float', number>;
  level: UniformNode<'float', number>;
}

function sameKind(a: WakeWavesKind | null, b: WakeWavesKind): boolean {
  return a !== null && a.kind === b.kind && a.size === b.size && a.span === b.span;
}

/**
 * The wake's waves: whichever way of making them the tier asks for. A change
 * is made in two steps, as the detail band's: setKind makes the new way, for
 * new materials to be built and compiled against, while the old one goes on
 * being stepped and drawn; commit puts the new one in use as the materials
 * are swapped.
 */
export class WakeWaves {
  /** The square's centre in the world, on its texels' grid. */
  readonly centre = { east: 0, north: 0 };
  /** 1 to draw the waves, 0 for none (the developer panel's wakes switch). */
  readonly on = uniform(1);
  /** How many times linear theory's height and slopes are drawn. */
  readonly gain = uniform(WAKE_WAVES.gain as number);
  steps = 0;
  cpuMs = 0;

  #active: Way | null = null;
  #next: Way | null = null;
  /** A texture of nothing, read with no waves. */
  readonly #none: DataTexture;
  readonly #noneWay: Way;
  /** The hulls this frame. */
  readonly #hulls: WakeHull[] = Array.from({ length: WAKE_HULLS }, () => ({
    east: 0,
    north: 0,
    heading: 0,
    sink: 0,
    shape: null,
  }));
  /** Each hull's kind's shape's number. */
  readonly #kinds = new Int32Array(WAKE_HULLS);
  #count = 0;
  #shape: PressureShape | null = null;
  /** Each kind's hull, by its index; the first kind's is #shape. */
  readonly #shapes: (PressureShape | null)[] = new Array<PressureShape | null>(HULL_SHAPES).fill(
    null,
  );
  /** The heading the square is placed by, as a direction east and north. */
  readonly #toward = { east: 0, north: 1, set: false };
  /** Where the square is to be this frame. */
  readonly #place = { east: 0, north: 0 };
  /** The water's drift not yet a whole texel, metres east and north. */
  readonly #drift = { east: 0, north: 0 };
  /** Whole texels of drift and of the square's moves the CPU's field has yet to take. */
  readonly #pendingDrift = { east: 0, north: 0 };
  #placed = false;
  readonly #stamps: Mesh;
  readonly #stampData: Float32Array;
  readonly #stampAttr: InstancedBufferAttribute;
  readonly #stampKinds: Float32Array;
  readonly #stampKindAttr: InstancedBufferAttribute;
  /** Each kind's stations, one after another; the first station's last value is its bilge's exponent. */
  readonly #stations: Vector4[] = Array.from({ length: 8 * HULL_SHAPES }, () => new Vector4());
  /** How far a hull reaches from its origin, metres: the stamp's half side. */
  readonly #reach = uniform(3);
  /** The stamps' square: 1 over its side, and a texel's side, metres. */
  readonly #stampPerSpan = uniform(1 / 64);
  readonly #texelSize = uniform(0.25);
  readonly #scene = new Scene();
  readonly #camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
  readonly #damping = wakeDamping();
  readonly #clear = new Color();

  constructor() {
    this.#none = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType);
    this.#none.needsUpdate = true;
    this.#noneWay = this.#way({ kind: 'cpu', size: 64, span: 28 }, null, null, this.#none);
    // The stamps: each hull's waterplane, its immersion at every texel's centre.
    const g = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(2, 2);
    g.setAttribute('position', plane.getAttribute('position'));
    g.setIndex(plane.getIndex());
    this.#stampData = new Float32Array(WAKE_HULLS * 4);
    this.#stampAttr = new InstancedBufferAttribute(this.#stampData, 4);
    this.#stampAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('hull', this.#stampAttr);
    this.#stampKinds = new Float32Array(WAKE_HULLS);
    this.#stampKindAttr = new InstancedBufferAttribute(this.#stampKinds, 1);
    this.#stampKindAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('kind', this.#stampKindAttr);
    g.instanceCount = 0;
    this.#stamps = new Mesh(g, this.#stampMaterial());
    this.#stamps.frustumCulled = false;
    this.#scene.add(this.#stamps);
    this.#camera.updateMatrixWorld();
  }

  /** The stamp: a square about the hull, as wide as it reaches, and its immersion within it (wakewavescpu.ts's immersion). */
  #stampMaterial(): MeshBasicNodeMaterial {
    const hull = attribute<'vec4'>('hull', 'vec4');
    const kindOf = varying(attribute<'float'>('kind', 'float'));
    const stations = uniformArray(this.#stations, 'vec4');
    const m = new MeshBasicNodeMaterial();
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = OneFactor;
    m.blendDst = OneFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneFactor;
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    const reach = this.#reach;
    // The hull's own frame at the corner: x to starboard, z aft, metres.
    const local = positionGeometry.xy.mul(reach);
    const heading = hull.z;
    const c = cos(heading);
    const s = sin(heading);
    // East and north of the hull, from its frame.
    const east = local.x.mul(c).sub(local.y.negate().mul(s));
    const north = local.x.mul(s.negate()).sub(local.y.negate().mul(c));
    m.positionNode = vec3(
      hull.x.add(east.mul(this.#stampPerSpan.mul(2))),
      hull.y.add(north.mul(this.#stampPerSpan.mul(2))),
      -1,
    );
    const at = varying(vec2(local.x, local.y.negate()));
    const sink = varying(hull.w);
    const turn = varying(vec2(c, s));
    const texel = this.#texelSize;
    const first = int(kindOf.add(0.5)).mul(8);
    const bilge = (stations.element(first) as unknown as Node<'vec4'>).w;
    const immersionAt = (x: Node<'float'>, z: Node<'float'>): Node<'float'> => {
      const aft = (stations.element(first) as unknown as Node<'vec4'>).x;
      const fore = (stations.element(first.add(7)) as unknown as Node<'vec4'>).x;
      const t = aft.sub(z).div(aft.sub(fore)).mul(7);
      const k = min(floor(t), 6).max(0);
      const f = t.sub(k);
      const a = stations.element(first.add(int(k))) as unknown as Node<'vec4'>;
      const b = stations.element(first.add(int(k)).add(1)) as unknown as Node<'vec4'>;
      const beam = mix(a.y, b.y, f);
      const depth = mix(a.z, b.z, f).add(sink);
      const across = abs(x).div(max(beam, 1e-4));
      // The transom's step taken over the last tenth of the waterline.
      const end = min(t.div(0.7), 1);
      const ease = end.mul(end).mul(float(3).sub(end.mul(2)));
      const d = depth
        .mul(pow(max(float(1).sub(pow(min(across, 1), bilge)), 0), float(1).div(bilge)))
        .mul(ease);
      const inside = z
        .lessThan(aft)
        .and(z.greaterThan(fore))
        .and(across.lessThan(1))
        .and(beam.greaterThan(0))
        .and(depth.greaterThan(0));
      return select(inside, d, float(0)) as unknown as Node<'float'>;
    };
    m.fragmentNode = Fn(() => {
      // The mean over the texel, at SAMPLES² points, as the reference has
      // it: east and north turned into the hull's frame.
      const sum = float(0).toVar();
      const ce = turn.x;
      const se = turn.y;
      for (let a = 0; a < SAMPLES; a++) {
        for (let b = 0; b < SAMPLES; b++) {
          const de = texel.mul((b + 0.5) / SAMPLES - 0.5);
          const dn = texel.mul((a + 0.5) / SAMPLES - 0.5);
          const x = at.x.add(de.mul(ce)).sub(dn.mul(se));
          const z = at.y.sub(de.mul(se)).sub(dn.mul(ce));
          sum.addAssign(immersionAt(x, z));
        }
      }
      return vec4(sum.div(SAMPLES * SAMPLES), 0, 0, 1);
    })() as unknown as Node<'vec4'>;
    return m;
  }

  /** A kind's hull, by the kind's index (below HULL_SHAPES): each hull pushes the waves by its own. */
  setShape(shape: PressureShape, kind = 0): void {
    if (kind < 0 || kind >= HULL_SHAPES) {
      return;
    }
    if (kind === 0 || this.#shape === null) {
      this.#shape = shape;
    }
    this.#shapes[kind] = shape;
    let reach = 0;
    shape.stations.forEach((s, i) => {
      (this.#stations[kind * 8 + i] as Vector4).set(
        s[0] ?? 0,
        s[1] ?? 0,
        s[2] ?? 0,
        i === 0 ? shape.bilge : 0,
      );
      reach = Math.max(reach, Math.hypot(s[0] ?? 0, s[1] ?? 0));
    });
    // The stamp's square reaches as far as the longest hull's.
    this.#reach.value = Math.max(this.#reach.value, reach + 0.25);
  }

  /** Whether a kind's hull is known. */
  has(kind: number): boolean {
    return this.#shapes[kind] != null;
  }

  #way(
    kind: WakeWavesKind,
    transformed: Transformed | null,
    stepped: Stepped | null,
    out: Texture,
  ): Way {
    return {
      kind,
      transformed,
      stepped,
      out,
      origin: uniform(new Vector2(0.5, 0.5)),
      perSpan: uniform(1 / kind.span),
      level: uniform(
        Math.max(0, Math.round(Math.log2(WAKE_WAVES.tileTexel / (kind.span / kind.size)))),
      ),
    };
  }

  /** The way in use, its kind; null before the first. */
  get kind(): WakeWavesKind | null {
    return this.#active?.kind ?? null;
  }

  /**
   * Chooses how the waves are made: compute is whether the renderer runs
   * compute passes. Returns whether that changes what the material reads,
   * so that the sea's materials must be made again and commit called once
   * they are in.
   */
  setKind(kind: WakeWavesKind, compute: boolean): boolean {
    const chosen: WakeWavesKind =
      kind.kind === 'fft' && !compute ? { kind: 'cpu', size: 64, span: 28 } : kind;
    if (sameKind((this.#next ?? this.#active)?.kind ?? null, chosen)) {
      return false;
    }
    // A way asked for and overtaken before it was used is let go at once.
    if (this.#next !== null && this.#next !== this.#active) {
      this.#disposeWay(this.#next);
    }
    if (sameKind(this.#active?.kind ?? null, chosen)) {
      this.#next = null;
      return true;
    }
    if (chosen.kind === 'fft') {
      const t = new Transformed(chosen.size, chosen.span, this.#damping);
      this.#next = this.#way(chosen, t, null, t.out);
    } else {
      const st = new Stepped(chosen.size, chosen.span, this.#damping);
      this.#next = this.#way(chosen, null, st, st.out);
    }
    return true;
  }

  /** Puts the way asked for in use. Returns what lets go of the old one, once nothing draws with it. */
  commit(): () => void {
    const old = this.#active;
    const next = this.#next;
    if (next === null || next === old) {
      this.#next = null;
      return () => undefined;
    }
    this.#active = next;
    this.#next = null;
    this.#placed = false;
    this.#stampPerSpan.value = 1 / next.kind.span;
    this.#texelSize.value = next.kind.span / next.kind.size;
    return () => {
      if (old !== null && old !== this.#active && old !== this.#next) {
        this.#disposeWay(old);
      }
    };
  }

  #disposeWay(w: Way): void {
    w.transformed?.dispose();
    w.stepped?.dispose();
  }

  /** The way materials built now read: the way asked for. */
  #reading(): Way {
    return this.#next ?? this.#active ?? this.#noneWay;
  }

  /**
   * The waves at the scene point p, at a mipmap level (the texels', or one
   * of about a tile's for the whole tile; null for the sampler's own): the
   * slope along x and z, the convergence and the height, drawn.
   */
  #read(p: Node<'vec2'>, level: Node<'float'> | null): Node<'vec4'> {
    const w = this.#reading();
    const uv = w.origin.add(vec2(p.x, p.y.negate()).mul(w.perSpan));
    const t = texture(w.out, uv);
    const v = (level === null ? t : t.level(level)) as unknown as Node<'vec4'>;
    // Nothing beyond the square.
    const inside = smoothstep(
      0,
      0.02,
      min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y))),
    );
    const g = this.gain.mul(this.on).mul(inside);
    // The scene's z runs south.
    return vec4(v.x, v.y.negate(), v.z, v.w).mul(g) as unknown as Node<'vec4'>;
  }

  /**
   * Whether the scene point p lies within the square, or within margin
   * metres of it: where the waves are worth reading at all.
   */
  covers(p: Node<'vec2'>, margin: number): Node<'bool'> {
    const w = this.#reading();
    const uv = w.origin.add(vec2(p.x, p.y.negate()).mul(w.perSpan));
    const m = w.perSpan.mul(margin);
    return uv
      .greaterThan(m.negate())
      .all()
      .and(uv.lessThan(m.add(1)).all()) as unknown as Node<'bool'>;
  }

  /**
   * The waves at a fragment dist metres from the eye, at a mipmap level
   * of the texels a pixel covers there, so that it may be read where
   * fragments branch.
   */
  fine(p: Node<'vec2'>, dist?: Node<'float'>): Node<'vec4'> {
    if (dist === undefined) {
      return this.#read(p, null);
    }
    const w = this.#reading();
    // A pixel covers some 2 mm a metre away, more where the sea is seen
    // edge on: as many texels' worth of the mipmaps.
    const level = max(dist.mul(0.002).mul(w.perSpan).mul(w.kind.size).log2(), 0);
    return this.#read(p, level as unknown as Node<'float'>);
  }

  /** The waves averaged over a tile or so, read at the tile's centre. */
  coarse(p: Node<'vec2'>): Node<'vec4'> {
    return this.#read(p, this.#reading().level);
  }

  /**
   * How far the waves fold at a place east and north of the floating
   * origin: by how much the Jacobian of their horizontal shift, drawn,
   * falls below the threshold, over the threshold; 0 where they do not.
   */
  foldAt(east: Node<'float'>, north: Node<'float'>): Node<'float'> {
    const v = this.#read(vec2(east, north.negate()) as unknown as Node<'vec2'>, float(0));
    const jacobian = float(1).sub(v.z.mul(WAKE.foldChop));
    return max(float(WAKE.foldThreshold).sub(jacobian), 0).div(
      WAKE.foldThreshold,
    ) as unknown as Node<'float'>;
  }

  /** Forgets every wave: the next step starts from still water. */
  clear(): void {
    this.#placed = false;
  }

  /** Starts a frame's hulls. */
  begin(): void {
    this.#count = 0;
  }

  /** A hull in the world, heading clockwise from north, sitting sink metres deeper than at rest; of a kind, whose hull it is. */
  add(east: number, north: number, heading: number, sink = 0, kind = 0): void {
    if (this.#count >= WAKE_HULLS) {
      return;
    }
    const k = this.#shapes[kind] == null ? 0 : kind;
    const h = this.#hulls[this.#count] as WakeHull;
    h.east = east;
    h.north = north;
    h.heading = heading;
    h.sink = sink;
    h.shape = this.#shapes[k] ?? null;
    this.#kinds[this.#count] = k;
    this.#count++;
  }

  /** Where the square's centre is to be: a quarter of its side astern of the boat, on its texels' grid. */
  #placeFor(f: WakeWavesFrame, k: WakeWavesKind): { east: number; north: number } {
    const texel = k.span / k.size;
    const t = this.#toward;
    const e = Math.sin(f.heading);
    const n = Math.cos(f.heading);
    if (!t.set || !this.#placed) {
      t.east = e;
      t.north = n;
      t.set = true;
    } else if (f.dt > 0) {
      const a = Math.min(f.dt / WAKE_WAVES.headingEase, 1);
      const ne = t.east + (e - t.east) * a;
      const nn = t.north + (n - t.north) * a;
      const l = Math.hypot(ne, nn);
      if (l > 1e-6) {
        t.east = ne / l;
        t.north = nn / l;
      }
    }
    const back = WAKE_WAVES.astern * k.span;
    this.#place.east = Math.round((f.boatEast - t.east * back) / texel) * texel;
    this.#place.north = Math.round((f.boatNorth - t.north * back) / texel) * texel;
    return this.#place;
  }

  /** Brings the waves to a frame: the hulls' pressure, then a step. */
  update(renderer: WebGPURenderer, f: WakeWavesFrame): void {
    const w = this.#active;
    if (w === null) {
      return;
    }
    const k = w.kind;
    const texel = k.span / k.size;
    if (f.dt > WAKE_WAVES.longest) {
      // A page hidden and shown again: what was there is long gone.
      this.#placed = false;
    }
    const fresh = !this.#placed;
    const place = this.#placeFor(f, k);
    let driftEast = 0;
    let driftNorth = 0;
    if (fresh) {
      this.#drift.east = 0;
      this.#drift.north = 0;
    } else if (f.dt > 0) {
      this.#drift.east += f.currentEast * f.dt;
      this.#drift.north += f.currentNorth * f.dt;
      driftEast = Math.trunc(this.#drift.east / texel);
      driftNorth = Math.trunc(this.#drift.north / texel);
      this.#drift.east -= driftEast * texel;
      this.#drift.north -= driftNorth * texel;
    }
    const moved =
      w.transformed !== null &&
      (place.east !== this.centre.east || place.north !== this.centre.north);
    const shiftEast = fresh ? 0 : Math.round((place.east - this.centre.east) / texel) - driftEast;
    const shiftNorth = fresh
      ? 0
      : Math.round((place.north - this.centre.north) / texel) - driftNorth;
    if (fresh || f.dt > 0 || moved) {
      this.#placed = true;
      if (w.transformed !== null) {
        this.centre.east = place.east;
        this.centre.north = place.north;
        this.#pressGPU(renderer, w.transformed, k, place);
        w.transformed.step(renderer, { dt: Math.max(f.dt, 0), shiftEast, shiftNorth, fresh });
        this.steps++;
      } else if (w.stepped !== null) {
        this.#stepCPU(w.stepped, f, place, fresh, driftEast, driftNorth);
        // What the texture holds is of the last step's square.
        this.centre.east = w.stepped.field.centre.east;
        this.centre.north = w.stepped.field.centre.north;
      }
    }
    w.origin.value.set(
      (f.originEast - this.centre.east) / k.span + 0.5,
      (f.originNorth - this.centre.north) / k.span + 0.5,
    );
  }

  #pressGPU(
    renderer: WebGPURenderer,
    t: Transformed,
    k: WakeWavesKind,
    place: { east: number; north: number },
  ): void {
    const half = k.span / 2;
    const reach = this.#reach.value;
    let n = 0;
    for (let i = 0; i < this.#count; i++) {
      const h = this.#hulls[i] as WakeHull;
      const x = (h.east - place.east) / half;
      const y = (h.north - place.north) / half;
      const r = reach / half;
      if (Math.abs(x) > 1 + r || Math.abs(y) > 1 + r || this.#shape === null) {
        continue;
      }
      this.#stampData[n * 4] = x;
      this.#stampData[n * 4 + 1] = y;
      this.#stampData[n * 4 + 2] = h.heading;
      this.#stampData[n * 4 + 3] = h.sink;
      this.#stampKinds[n] = this.#kinds[i] ?? 0;
      n++;
    }
    (this.#stamps.geometry as InstancedBufferGeometry).instanceCount = n;
    this.#stampAttr.needsUpdate = true;
    this.#stampKindAttr.needsUpdate = true;
    const before = renderer.getRenderTarget();
    renderer.getClearColor(this.#clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(t.pressure);
    renderer.render(this.#scene, this.#camera);
    renderer.setRenderTarget(before);
    renderer.setClearColor(this.#clear, alpha);
  }

  #stepCPU(
    s: Stepped,
    f: WakeWavesFrame,
    place: { east: number; north: number },
    fresh: boolean,
    driftEast: number,
    driftNorth: number,
  ): void {
    const field = s.field;
    s.pending += Math.max(f.dt, 0);
    if (fresh) {
      field.clear();
    }
    // Moves of the square between steps add up: the reference takes them in one.
    this.#pendingDrift.east += driftEast;
    this.#pendingDrift.north += driftNorth;
    if (!fresh && s.pending < 1 / WAKE_WAVES.cpuRate) {
      return;
    }
    const start = performance.now();
    if (this.#shape !== null) {
      field.press(this.#shape, this.#hulls, place.east, place.north, this.#count);
    } else {
      field.pressure.fill(0);
    }
    field.step(
      s.pending,
      place.east,
      place.north,
      this.#pendingDrift.east,
      this.#pendingDrift.north,
    );
    this.#pendingDrift.east = 0;
    this.#pendingDrift.north = 0;
    s.pending = 0;
    s.upload();
    this.steps++;
    this.cpuMs = performance.now() - start;
  }

  /** The CPU's field, on the low tier: the tests read it. */
  get reference(): WakeWavesReference | null {
    return this.#active?.stepped?.field ?? null;
  }

  /** The compute field's outputs and pressure, for the tests that read them back. */
  get transformed(): { out: StorageTexture; pressure: RenderTarget; size: number } | null {
    return this.#active?.transformed ?? null;
  }

  /** The kernels of the way asked for, to compile ahead of its first frame. */
  get kernels(): ComputeNode[] {
    return (this.#next ?? this.#active)?.transformed?.kernels ?? [];
  }

  /** Every texture the way in use holds, for counting its memory. */
  get textures(): Texture[] {
    const w = this.#active;
    return w?.transformed?.textures ?? (w?.stepped === null || w === null ? [] : [w.stepped.out]);
  }

  get state(): WakeWavesState {
    const k = this.kind;
    return {
      kind: k === null ? 'none' : `${k.kind} ${k.size}² over ${k.span} m`,
      hulls: this.#count,
      steps: this.steps,
      cpuMs: this.cpuMs,
    };
  }

  dispose(): void {
    if (this.#active !== null) {
      this.#disposeWay(this.#active);
    }
    if (this.#next !== null) {
      this.#disposeWay(this.#next);
    }
    this.#none.dispose();
  }
}

export { rimKept };

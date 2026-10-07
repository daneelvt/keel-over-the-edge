// SPDX-License-Identifier: AGPL-3.0-only

// The physics module: the server's physics package, built to WebAssembly by
// go run ./tools/physics. The client predicts its own boat with it, so
// anything that must agree with the server is computed in the module, never
// with JavaScript's Math, whose last bits differ between browsers.

import { FN, LAYOUT_VERSION, RECORDS, SIZES } from './layout.gen';

export type RecordName = keyof typeof RECORDS;
export type FnName = keyof typeof FN;
export type PhysicsSource = Response | PromiseLike<Response> | BufferSource;

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  layout(): number;
  state(): number;
  control(): number;
  env(): number;
  params(): number;
  out(): number;
  prepare(): void;
  step(): void;
  fnArgs(): number;
  fnResults(): number;
  fnCapacity(): number;
  fn(op: number, n: number): void;
  allocations(): number;
}

const functionExports = [
  '_initialize',
  'layout',
  'state',
  'control',
  'env',
  'params',
  'out',
  'prepare',
  'step',
  'fnArgs',
  'fnResults',
  'fnCapacity',
  'fn',
  'allocations',
] as const satisfies readonly (keyof Exports)[];

const recordNames = Object.keys(RECORDS) as RecordName[];

/** Compiles and starts the physics module. */
export async function loadPhysics(source: PhysicsSource): Promise<Physics> {
  const module = await compile(source);
  if (WebAssembly.Module.imports(module).length > 0) {
    throw new Error('physics module: it imports from its host, and must not');
  }
  return new Physics(await WebAssembly.instantiate(module, {}));
}

async function compile(source: PhysicsSource): Promise<WebAssembly.Module> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return WebAssembly.compile(source);
  }
  const response = await source;
  if (!response.ok) {
    throw new Error(`physics module: ${response.url} answered ${response.status}`);
  }
  // compileStreaming compiles while the bytes arrive, but only from a
  // response served as application/wasm.
  const type = response.headers.get('Content-Type') ?? '';
  if (type.startsWith('application/wasm') && typeof WebAssembly.compileStreaming === 'function') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/** A running physics module and views of its records. */
export class Physics {
  readonly #x: Exports;
  readonly #addresses: Record<RecordName, number>;
  #buffer: ArrayBuffer | undefined;
  #views: Record<RecordName, Float64Array> | undefined;

  constructor(instance: WebAssembly.Instance) {
    const x = instance.exports as unknown as Exports;
    for (const name of functionExports) {
      if (typeof x[name] !== 'function') {
        throw new Error(`physics module: no ${name} export`);
      }
    }
    if (!(x.memory instanceof WebAssembly.Memory)) {
      throw new Error('physics module: no memory export');
    }
    x._initialize();
    // WebAssembly returns an i32, which JavaScript reads as signed.
    const layout = x.layout() >>> 0;
    if (layout !== LAYOUT_VERSION) {
      throw new Error(
        `physics module: layout ${hex32(layout)}, but this client expects ${hex32(LAYOUT_VERSION)}`,
      );
    }
    const addresses = {} as Record<RecordName, number>;
    for (const name of recordNames) {
      addresses[name] = x[name]() >>> 0;
      if (addresses[name] % Float64Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error(`physics module: ${name} is not aligned for a Float64Array`);
      }
    }
    this.#x = x;
    this.#addresses = addresses;
  }

  /**
   * Views of the records, indexed by RECORDS. Growing the module's memory
   * detaches its buffer, even when it grows by nothing, so the views are made
   * again whenever the buffer has changed. Take them afresh after any call
   * into the module rather than keeping them.
   */
  get records(): Readonly<Record<RecordName, Float64Array>> {
    const buffer = this.#x.memory.buffer;
    if (this.#views === undefined || buffer !== this.#buffer) {
      const views = {} as Record<RecordName, Float64Array>;
      for (const name of recordNames) {
        views[name] = new Float64Array(buffer, this.#addresses[name], SIZES[name]);
      }
      this.#views = views;
      this.#buffer = buffer;
    }
    return this.#views;
  }

  /**
   * Derives the boat's constants from the params record. Call it after
   * writing params (writeParams) and before stepping.
   */
  prepare(): void {
    this.#x.prepare();
  }

  /** Advances the state by one step, 1/30 of a second, and writes out. */
  step(): void {
    this.#x.step();
  }

  /**
   * Evaluates one of the physics package's functions on each argument (each
   * pair, for atan2) inside the module, for comparing with the server.
   */
  evaluate(fn: FnName, a: ArrayLike<number>, b?: ArrayLike<number>): Float64Array {
    const x = this.#x;
    const capacity = x.fnCapacity() >>> 0;
    const out = new Float64Array(a.length);
    for (let start = 0; start < a.length; start += capacity) {
      const n = Math.min(capacity, a.length - start);
      const buffer = x.memory.buffer;
      const args = new Float64Array(buffer, x.fnArgs() >>> 0, 2 * capacity);
      for (let i = 0; i < n; i++) {
        args[i] = a[start + i] ?? 0;
        args[capacity + i] = b?.[start + i] ?? 0;
      }
      x.fn(FN[fn], n);
      out.set(new Float64Array(x.memory.buffer, x.fnResults() >>> 0, n), start);
    }
    return out;
  }

  /** How many heap allocations the module has made since it started. */
  get allocations(): number {
    return this.#x.allocations() >>> 0;
  }

  /** The size of the module's memory, in bytes. */
  get memoryBytes(): number {
    return this.#x.memory.buffer.byteLength;
  }

  /** The module's memory, for tests. */
  get memory(): WebAssembly.Memory {
    return this.#x.memory;
  }
}

function hex32(n: number): string {
  return `0x${n.toString(16).padStart(8, '0')}`;
}

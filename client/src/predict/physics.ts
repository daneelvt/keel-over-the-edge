// SPDX-License-Identifier: AGPL-3.0-only

// The physics module: the server's physics package, built to WebAssembly by
// go run ./tools/physics. The client predicts its own boat with it, so
// anything that must agree with the server is computed in the module, never
// with JavaScript's Math, whose last bits differ between browsers.

import { ENCOUNTERS, FN, GROUND, LAYOUT_VERSION, RECORDS, SEA, SIZES, WEATHER } from './layout.gen';
import { SKY_PARAMS } from './params.gen';

export type RecordName = keyof typeof RECORDS;

/**
 * How many values seaParts holds for each area: the wind sea's Hs and peak,
 * the swell's, the Hs with no current, and the wind sea's variance over
 * the band.
 */
export const SEA_PARTS = 6;
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
  seaParams(): number;
  components(): number;
  wave(): number;
  seaPrepare(): void;
  prepare(): void;
  step(): void;
  seaWindow(slot: number, col: number, row: number, size: number): void;
  seaArea(
    slot: number,
    area: number,
    speed: number,
    from: number,
    fetch: number,
    swellHeight: number,
    swellPeriod: number,
    swellFrom: number,
    currentEast: number,
    currentNorth: number,
  ): void;
  seaCurrent(col: number, row: number): void;
  swellInputOf(height: number, period: number, from: number): void;
  seaCurrentValues(): number;
  seaParts(slot: number): number;
  swellAt(x: number, y: number, tick: number): void;
  swellValues(): number;
  leeGrid(slot: number, a0: number, b0: number): void;
  leeValues(): number;
  leeAt(slot: number, x: number, y: number): number;
  seaSeal(slot: number): void;
  seaInputOf(speed: number, from: number, fetch: number): void;
  seaInput(): number;
  seaAmp(slot: number): number;
  seaHs(slot: number): number;
  seaPeak(slot: number): number;
  seaActive(slot: number): number;
  seaCount(slot: number): number;
  seaUse(slot: number): void;
  seaAt(tick: number): void;
  seaDrawAt(tick: number): void;
  waveUnder(
    slot: number,
    x: number,
    y: number,
    heading: number,
    length: number,
    beam: number,
  ): void;
  samplePoints(): number;
  sampleValues(): number;
  seaSample(slot: number, n: number): void;
  weatherParams(): number;
  regime(): number;
  spell(): number;
  wind(): number;
  gustFrame(): number;
  weatherPrepare(): void;
  spellDraw(number: number, seed: number): void;
  spellSet(i: number): void;
  spellGet(i: number): void;
  spellCount(n: number): void;
  windAt(tick: number): void;
  windDrawAt(tick: number): void;
  system(): number;
  systemKind(): number;
  systemRecord(): number;
  systemKindSet(i: number): void;
  keyframeSet(k: number, tick: number): void;
  systemSet(k: number, slot: number): void;
  keyframeCount(n: number): void;
  systemAt(tick: number): void;
  recordSet(slot: number): void;
  recordCount(n: number): void;
  pressure(x: number, y: number): number;
  frontReach(): number;
  meanValues(): number;
  meanSample(n: number): void;
  windPoint(x: number, y: number): void;
  windValues(): number;
  windSample(n: number): void;
  gustFrameAt(): void;
  waveValues(): number;
  waveWind(x: number, y: number, tick: number): void;
  other(): number;
  encounterParams(): number;
  encounterPrepare(): void;
  wake(): number;
  wakeOf(
    x: number,
    y: number,
    heading: number,
    heel: number,
    boom: number,
    vx: number,
    vy: number,
    speed: number,
    from: number,
  ): void;
  wakeOfState(): void;
  wakes(): number;
  wakeCapacity(): number;
  shadowAt(n: number): number;
  course(): number;
  courseTrack(windFrom: number): void;
  courseOf(heading: number, boom: number, windFrom: number): void;
  encounter(): number;
  verdict(): number;
  articlesJudge(): void;
  contact(): number;
  collide(): number;
  skyParams(): number;
  skyPrepare(): void;
  sky(): number;
  skyBody(): number;
  skySize(): number;
  skyTime(worldEpoch: number, worldTime: number): number;
  skyAt(t: number, east: number, north: number): void;
  skyStar(t: number, east: number, north: number, ra: number, dec: number): void;
  skyVector(ra: number, dec: number): void;
  fnArgs(): number;
  fnResults(): number;
  fnCapacity(): number;
  fn(op: number, n: number): void;
  allocations(): number;
  groundParams(): number;
  groundPrepare(): void;
  groundChunk(slot: number, chunk: number): number;
  shelterChunk(slot: number, chunk: number): number;
  groundUse(on: number): void;
  shelterUse(on: number): void;
  hexAt(x: number, y: number): void;
  hexValues(): number;
  shelterGrid(a0: number, b0: number, from: number): void;
  shelterValues(): number;
  shelterSide(): number;
  seaFactor(slot: number, n: number): void;
  factorValues(): number;
  circulation(way: number): void;
  current(x: number, y: number): void;
  currentValues(): number;
  over(): number;
}

const functionExports = [
  '_initialize',
  'layout',
  'state',
  'control',
  'env',
  'params',
  'out',
  'seaParams',
  'components',
  'wave',
  'seaPrepare',
  'prepare',
  'step',
  'seaWindow',
  'seaArea',
  'seaCurrent',
  'swellInputOf',
  'seaCurrentValues',
  'seaParts',
  'swellAt',
  'swellValues',
  'leeGrid',
  'leeValues',
  'leeAt',
  'seaSeal',
  'seaInputOf',
  'seaInput',
  'seaAmp',
  'seaHs',
  'seaPeak',
  'seaActive',
  'seaCount',
  'seaUse',
  'seaAt',
  'seaDrawAt',
  'waveUnder',
  'samplePoints',
  'sampleValues',
  'seaSample',
  'weatherParams',
  'regime',
  'spell',
  'wind',
  'gustFrame',
  'weatherPrepare',
  'spellDraw',
  'spellSet',
  'spellGet',
  'spellCount',
  'windAt',
  'windDrawAt',
  'system',
  'systemKind',
  'systemRecord',
  'systemKindSet',
  'keyframeSet',
  'systemSet',
  'keyframeCount',
  'systemAt',
  'recordSet',
  'recordCount',
  'pressure',
  'frontReach',
  'meanValues',
  'meanSample',
  'windPoint',
  'windValues',
  'windSample',
  'gustFrameAt',
  'waveValues',
  'waveWind',
  'other',
  'encounterParams',
  'encounterPrepare',
  'wake',
  'wakeOf',
  'wakeOfState',
  'wakes',
  'wakeCapacity',
  'shadowAt',
  'course',
  'courseTrack',
  'courseOf',
  'encounter',
  'verdict',
  'articlesJudge',
  'contact',
  'collide',
  'skyParams',
  'skyPrepare',
  'sky',
  'skyBody',
  'skySize',
  'skyTime',
  'skyAt',
  'skyStar',
  'skyVector',
  'fnArgs',
  'fnResults',
  'fnCapacity',
  'fn',
  'allocations',
  'groundParams',
  'groundPrepare',
  'groundChunk',
  'shelterChunk',
  'groundUse',
  'shelterUse',
  'hexAt',
  'hexValues',
  'shelterGrid',
  'shelterValues',
  'shelterSide',
  'seaFactor',
  'factorValues',
  'circulation',
  'current',
  'currentValues',
  'over',
] as const satisfies readonly (keyof Exports)[];

/** A chunk of the ground as the module holds it: views of its memory. */
export interface GroundChunk {
  /** Each hexagon's elevation in decimetres above the sea, column by column. */
  elevation: Int16Array;
  /** Each hexagon's surface, an index into the catalog's surfaces. */
  surface: Uint8Array;
}

const recordNames = Object.keys(RECORDS) as RecordName[];

/**
 * The sky record, as the module's skyAt writes it: the sun's body, the
 * moon's, the moon's lit share (0 new, 1 full) and the stars' matrix,
 * three rows of three, which turns a star's catalogue vector into its
 * direction in the place's east, north and up.
 */
export const SKY = { sun: 0, moon: 5, lit: 10, stars: 11, size: 20 } as const;

/**
 * A body in the sky record, and the record skyStar writes: its direction
 * in the place's east, north and up, its height above the true horizon and
 * its bearing clockwise from north, in radians.
 */
export const BODY = { east: 0, north: 1, up: 2, altitude: 3, bearing: 4, size: 5 } as const;

/** How many values windSample writes for each point, and where each is. */
export const WIND_VALUES = 6;
export const WIND_VALUE = {
  speed: 0,
  from: 1,
  meanSpeed: 2,
  meanFrom: 3,
  gust: 4,
  factor: 5,
} as const;

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
/**
 * A keyframe of the weather systems: its tick, and each slot's system as a
 * system record's values, or undefined for an empty slot.
 */
export interface Keyframe {
  tick: number;
  systems: (ArrayLike<number> | undefined)[];
}

export class Physics {
  readonly #x: Exports;
  readonly #addresses: Record<RecordName, number>;
  #buffer: ArrayBuffer | undefined;
  #views: Record<RecordName, Float64Array> | undefined;
  #systemRecords: Float64Array[] = [];

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
    if (x.wakeCapacity() >>> 0 !== ENCOUNTERS.wakes) {
      throw new Error(
        `physics module: room for ${x.wakeCapacity()} wakes, not ${ENCOUNTERS.wakes}`,
      );
    }
    const skySize = x.skySize() >>> 0;
    if (skySize !== SKY.size) {
      throw new Error(
        `physics module: a sky of ${skySize} values, but this client expects ${SKY.size}`,
      );
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
   * Derives the sea's waves from the seaParams record. Call it after
   * writing seaParams (writeSeaParams) and before prepare.
   */
  prepareSea(): void {
    this.#x.seaPrepare();
  }

  /**
   * Derives the boat's constants from the params record, for the sea's
   * waves. Call it after writing params (writeParams) and after prepareSea,
   * and before stepping.
   */
  prepare(): void {
    this.#x.prepare();
  }

  /**
   * Advances the state by one step, 1/30 of a second, and writes out: in
   * the window seaUse named at the tick seaAt set, or in flat water.
   */
  step(): void {
    this.#x.step();
  }

  /**
   * Places one of the module's windows of sea areas: its first area's column
   * and row, and its areas a side, at most SEA.window. The areas keep what
   * they held until seaArea sets them.
   */
  seaWindow(slot: number, col: number, row: number, size: number): void {
    this.#x.seaWindow(slot, col, row, size);
  }

  /**
   * Sets the inputs of one area of a window, in whole steps, and with them
   * its waves: the wind's speed, the direction it comes from and the fetch;
   * the swell's height, period and direction (SeaInput's steps), none with
   * no height; and the current east and north, which seaCurrent gives.
   */
  seaArea(
    slot: number,
    area: number,
    speed: number,
    from: number,
    fetch: number,
    swellHeight = 0,
    swellPeriod = 0,
    swellFrom = 0,
    currentEast = 0,
    currentNorth = 0,
  ): void {
    this.#x.seaArea(
      slot,
      area,
      speed,
      from,
      fetch,
      swellHeight,
      swellPeriod,
      swellFrom,
      currentEast,
      currentNorth,
    );
  }

  /**
   * The current of the area at a column and row, east and north in its
   * inputs' steps of 0.01 m/s, as the server gives it: at its centre on the
   * open sea, by the world's way (circulation). Written to out.
   */
  seaCurrent(col: number, row: number, out: number[]): number[] {
    this.#x.seaCurrent(col, row);
    const v = new Int32Array(this.#x.memory.buffer, this.#x.seaCurrentValues() >>> 0, 2);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    return out;
  }

  /**
   * A window's partitions: for each area, row by row, SEA_PARTS values, the
   * wind sea's significant height (m) and peak (rad/s), the swell's, the
   * significant height with no current, and the wind sea's variance over the
   * band. A view.
   */
  seaParts(slot: number): Float64Array {
    return new Float64Array(
      this.#x.memory.buffer,
      this.#x.seaParts(slot) >>> 0,
      SEA.window * SEA.window * SEA_PARTS,
    );
  }

  /**
   * The swell at (east, north) at a tick from the system in the
   * systemRecord record: its significant height (m), peak period (s), the
   * direction it comes from (rad) and how far it has come (m). A view.
   */
  swellAt(east: number, north: number, tick: number): Float64Array {
    this.#x.swellAt(east, north, tick);
    return new Float64Array(this.#x.memory.buffer, this.#x.swellValues() >>> 0, 4);
  }

  /**
   * The share of the waves the land's lee leaves at the centres of
   * shelterSide by shelterSide cells from cell (a0, b0), for the sea of a
   * window: row by row from the south, each from the west; 1 where the
   * module holds no shelter, and everywhere while shelterUse is off. A view
   * of the module's memory: read it before the next call.
   */
  /** The share of the waves the land's lee leaves at (east, north), for the sea of a window, as a step feels it. */
  leeAt(slot: number, east: number, north: number): number {
    return this.#x.leeAt(slot, east, north);
  }

  leeGrid(slot: number, a0: number, b0: number): Float64Array {
    const x = this.#x;
    x.leeGrid(slot, a0, b0);
    const n = x.shelterSide();
    return new Float64Array(x.memory.buffer, x.leeValues() >>> 0, n * n);
  }

  /** Makes a window ready, once its areas are set. */
  seaSeal(slot: number): void {
    this.#x.seaSeal(slot);
  }

  /**
   * Rounds a wind (m/s, radians it comes from) and a fetch in metres to an
   * area's inputs, exactly as the server does: its speed, direction and
   * fetch in whole steps, written to out. A negative fetch is open water's.
   */
  seaInputOf(speed: number, from: number, fetch: number, out: number[]): number[] {
    this.#x.seaInputOf(speed, from, fetch);
    const v = new Uint32Array(this.#x.memory.buffer, this.#x.seaInput() >>> 0, 3);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    out[2] = v[2] ?? 0;
    return out;
  }

  /**
   * Rounds a swell (its height in m, its period in s and the radians it
   * comes from) to an area's inputs, exactly as the server does: its
   * height, period and direction in whole steps, written to out.
   */
  swellInputOf(height: number, period: number, from: number, out: number[]): number[] {
    this.#x.swellInputOf(height, period, from);
    const v = new Uint32Array(this.#x.memory.buffer, this.#x.seaInput() >>> 0, 3);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    out[2] = v[2] ?? 0;
    return out;
  }

  /** A window's amplitudes: SEA.components for each area, row by row. A view: copy what must last. */
  seaAmplitudes(slot: number): Float64Array {
    const n = SEA.window * SEA.window * SEA.components;
    return new Float64Array(this.#x.memory.buffer, this.#x.seaAmp(slot) >>> 0, n);
  }

  /** The significant height of each area's waves, in metres. A view. */
  seaHs(slot: number): Float64Array {
    return new Float64Array(
      this.#x.memory.buffer,
      this.#x.seaHs(slot) >>> 0,
      SEA.window * SEA.window,
    );
  }

  /** The frequency of each area's spectral peak, in rad/s. A view. */
  seaPeak(slot: number): Float64Array {
    return new Float64Array(
      this.#x.memory.buffer,
      this.#x.seaPeak(slot) >>> 0,
      SEA.window * SEA.window,
    );
  }

  /** The waves with an amplitude anywhere in a window, ascending. A view. */
  seaActive(slot: number): Int32Array {
    const n = this.#x.seaCount(slot) >>> 0;
    return new Int32Array(this.#x.memory.buffer, this.#x.seaActive(slot) >>> 0, n);
  }

  /** Names the window steps sail in; a negative slot is flat water. */
  seaUse(slot: number): void {
    this.#x.seaUse(slot);
  }

  /** Sets the tick the next steps sail at. */
  seaAt(tick: number): void {
    this.#x.seaAt(tick);
  }

  /** Sets the time waveUnder and seaSample answer for, in ticks, which need not be whole. */
  seaDrawAt(tick: number): void {
    this.#x.seaDrawAt(tick);
  }

  /**
   * The sea under a hull at (east, north) heading heading, over a waterplane
   * length long and beam wide, in a window at the time seaDrawAt set: the
   * wave record, indexed by RECORDS.wave. A view: read it before the next call.
   */
  waveUnder(
    slot: number,
    east: number,
    north: number,
    heading: number,
    length: number,
    beam: number,
  ): Float64Array {
    this.#x.waveUnder(slot, east, north, heading, length, beam);
    return this.records.wave;
  }

  /**
   * The sea at points (east, north of each, in turn) in a window at the time
   * seaDrawAt set: for each point its height, its slope eastward and
   * northward, and the significant height of the waves there.
   */
  seaSample(slot: number, points: ArrayLike<number>): Float64Array {
    const x = this.#x;
    const n = points.length >> 1;
    const out = new Float64Array(4 * n);
    for (let start = 0; start < n; start += SEA.sampleCapacity) {
      const m = Math.min(SEA.sampleCapacity, n - start);
      const into = new Float64Array(x.memory.buffer, x.samplePoints() >>> 0, 2 * m);
      for (let i = 0; i < 2 * m; i++) {
        into[i] = points[2 * start + i] ?? 0;
      }
      x.seaSample(slot, m);
      out.set(new Float64Array(x.memory.buffer, x.sampleValues() >>> 0, 4 * m), 4 * start);
    }
    return out;
  }

  /**
   * The share of the waves the depth leaves at points (east, north of each,
   * in turn), in a window, by the ground the module holds: 1 where it holds
   * none or groundUse is off, 0 on land.
   */
  seaFactor(slot: number, points: ArrayLike<number>, out: Float64Array): Float64Array {
    const x = this.#x;
    const n = points.length >> 1;
    for (let start = 0; start < n; start += SEA.sampleCapacity) {
      const m = Math.min(SEA.sampleCapacity, n - start);
      const into = new Float64Array(x.memory.buffer, x.samplePoints() >>> 0, 2 * m);
      for (let i = 0; i < 2 * m; i++) {
        into[i] = points[2 * start + i] ?? 0;
      }
      x.seaFactor(slot, m);
      out.set(new Float64Array(x.memory.buffer, x.factorValues() >>> 0, m), start);
    }
    return out;
  }

  /**
   * Derives the wind's constants from the weatherParams record. Call it
   * after writing weatherParams (writeWeatherParams) and before setting
   * spells.
   */
  prepareWeather(): void {
    this.#x.weatherPrepare();
  }

  /**
   * Draws into the spell record a spell of the regime in the regime record
   * (writeRegime), from its number and a seed, exactly as the server draws
   * its spells. Its times, its direction and its regime's index are left as
   * the record had them.
   */
  spellDraw(number: number, seed: number): void {
    this.#x.spellDraw(number >>> 0, seed >>> 0);
  }

  /**
   * Makes spells the spells of weather in play, ascending by the tick each
   * begins at: each a spell record's values, at most WEATHER.spells of them.
   */
  setSpells(spells: readonly ArrayLike<number>[]): void {
    const n = Math.min(spells.length, WEATHER.spells);
    for (let i = 0; i < n; i++) {
      this.records.spell.set(spells[i] as ArrayLike<number>);
      this.#x.spellSet(i);
    }
    this.#x.spellCount(n);
  }

  /**
   * Sets the kinds of weather system, each a systemKind record's values, in
   * the catalog's order. Call it after prepareWeather.
   */
  setSystemKinds(kinds: readonly ArrayLike<number>[]): void {
    for (let i = 0; i < Math.min(kinds.length, WEATHER.kinds); i++) {
      this.records.systemKind.set(kinds[i] as ArrayLike<number>);
      this.#x.systemKindSet(i);
    }
  }

  /**
   * Makes keyframes the weather systems' keyframes the wind is computed
   * with, each a tick and its systems by their slots, a system record's
   * values or undefined for an empty slot: at most WEATHER.keySets.
   */
  setKeyframes(keyframes: readonly Keyframe[]): void {
    const n = Math.min(keyframes.length, WEATHER.keySets);
    for (let k = 0; k < n; k++) {
      const key = keyframes[k] as Keyframe;
      this.#x.keyframeSet(k, key.tick);
      key.systems.forEach((s, slot) => {
        if (s !== undefined && slot < WEATHER.systems) {
          this.records.system.set(s);
          this.#x.systemSet(k, slot);
        }
      });
    }
    this.#x.keyframeCount(n);
  }

  /**
   * The keyframe of the system in a systemRecord record's values at a tick,
   * as the server makes the keyframes of its week's: a system record. A
   * view: read it before the next call.
   */
  systemAt(record: ArrayLike<number>, tick: number): Float64Array {
    this.records.systemRecord.set(record);
    this.#x.systemAt(tick);
    return this.records.system;
  }

  /**
   * Makes records, each a systemRecord record's values, the systems the
   * wind is computed with at every tick, in place of keyframes: for a client
   * with no server, which makes its own weather and its own sea. None goes
   * back to keyframes.
   */
  setRecords(records: readonly ArrayLike<number>[]): void {
    const n = Math.min(records.length, WEATHER.systems);
    this.#systemRecords = [];
    for (let i = 0; i < n; i++) {
      this.records.systemRecord.set(records[i] as ArrayLike<number>);
      this.#x.recordSet(i);
      this.#systemRecords.push(Float64Array.from(records[i] as ArrayLike<number>));
    }
    this.#x.recordCount(n);
  }

  /** The records setRecords last set: copies, for whoever raises their swell. */
  get systemRecords(): readonly Float64Array[] {
    return this.#systemRecords;
  }

  /** How far from the centre a front's line enters the disk's reach and leaves it, m. */
  frontReach(): number {
    return this.#x.frontReach();
  }

  /** The pressure at (east, north), hPa, at the time windDrawAt set. */
  pressure(east: number, north: number): number {
    return this.#x.pressure(east, north);
  }

  /**
   * The mean wind, without its gusts or any shelter, at points (east, north
   * of each, in turn) at the time windDrawAt set: its speed and the
   * direction it comes from, written to out, two for each point.
   */
  meanSample(
    points: ArrayLike<number>,
    out: Float64Array,
    count = points.length >> 1,
  ): Float64Array {
    const x = this.#x;
    for (let start = 0; start < count; start += SEA.sampleCapacity) {
      const m = Math.min(SEA.sampleCapacity, count - start);
      const into = new Float64Array(x.memory.buffer, x.samplePoints() >>> 0, 2 * m);
      for (let i = 0; i < 2 * m; i++) {
        into[i] = points[2 * start + i] ?? 0;
      }
      x.meanSample(m);
      out.set(new Float64Array(x.memory.buffer, x.meanValues() >>> 0, 2 * m), 2 * start);
    }
    return out;
  }

  /**
   * Derives grounding's constants from the groundParams record. Call it
   * after writing groundParams.
   */
  prepareGround(): void {
    this.#x.groundPrepare();
  }

  /**
   * Gives one of the module's GROUND.slots slots to a chunk of the ground,
   * by its number, dropping the chunk it held, and returns views of its
   * elevations and surfaces to fill. A chunk the module does not hold is
   * deep water.
   */
  groundChunk(slot: number, chunk: number): GroundChunk {
    const at = this.#x.groundChunk(slot, chunk) >>> 0;
    const buffer = this.#x.memory.buffer;
    return {
      elevation: new Int16Array(buffer, at, GROUND.chunkHexes),
      surface: new Uint8Array(buffer, at + 2 * GROUND.chunkHexes, GROUND.chunkHexes),
    };
  }

  /**
   * Gives a slot to a chunk's shelter, as groundChunk does, and returns a
   * view of its table: for each cell and direction, the factor's byte and
   * the turn's.
   */
  shelterChunk(slot: number, chunk: number): Uint8Array {
    const at = this.#x.shelterChunk(slot, chunk) >>> 0;
    return new Uint8Array(
      this.#x.memory.buffer,
      at,
      GROUND.shelterCells * GROUND.shelterDirections * GROUND.shelterStride,
    );
  }

  /** Says whether steps sail on the ground the module holds, or in the open sea. */
  groundUse(on: boolean): void {
    this.#x.groundUse(on ? 1 : 0);
  }

  /** Says whether windAt reads the land's shelter the module holds. */
  shelterUse(on: boolean): void {
    this.#x.shelterUse(on ? 1 : 0);
  }

  /** How many cells a side shelterGrid answers for. */
  get shelterSide(): number {
    return this.#x.shelterSide();
  }

  /**
   * The shelter's factor for a wind from from over shelterSide by
   * shelterSide cells, from cell (a0, b0) of the whole grid, at each cell's
   * centre: row by row from the south, each from the west. A view of the
   * module's memory: read it before the next call.
   */
  shelterGrid(a0: number, b0: number, from: number): Float64Array {
    const x = this.#x;
    x.shelterGrid(a0, b0, from);
    const n = x.shelterSide();
    return new Float64Array(x.memory.buffer, x.shelterValues() >>> 0, n * n);
  }

  /** The hexagon that holds (east, north), as the server finds it, written to out as q, r. */
  hexAt(east: number, north: number, out: number[]): number[] {
    this.#x.hexAt(east, north);
    const v = new Int32Array(this.#x.memory.buffer, this.#x.hexValues() >>> 0, 2);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    return out;
  }

  /**
   * Sets the env record to the wind and the current at the state's place at
   * a tick: what the next step sails in.
   */
  windAt(tick: number): void {
    this.#x.windAt(tick);
  }

  /** Sets the world's way round the disk for its current: 1 clockwise seen from above, −1 the other way, 0 none. */
  circulation(way: number): void {
    this.#x.circulation(way);
  }

  /**
   * The current at (east, north), on the ground the module holds while
   * groundUse is on: its east and north parts in m/s, written to out.
   */
  current(east: number, north: number, out: number[]): number[] {
    this.#x.current(east, north);
    const v = new Float64Array(this.#x.memory.buffer, this.#x.currentValues() >>> 0, 2);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    return out;
  }

  /** Whether the state's centre of gravity is at or beyond the lip. */
  over(): boolean {
    return this.#x.over() !== 0;
  }

  /** Sets the time windPoint, windSample and gustFrame answer for, in ticks, which need not be whole. */
  windDrawAt(tick: number): void {
    this.#x.windDrawAt(tick);
  }

  /**
   * The wind at (east, north) in full, at the time windDrawAt set: the wind
   * record, indexed by RECORDS.wind. A view: read it before the next call.
   */
  windPoint(east: number, north: number): Float64Array {
    this.#x.windPoint(east, north);
    return this.records.wind;
  }

  /**
   * The wind at points (east, north of each, in turn) at the time
   * windDrawAt set: for each its speed and direction, the mean wind's speed
   * and direction, the gust field and the gust factor, written to out,
   * WIND_VALUES for each point.
   */
  windSample(
    points: ArrayLike<number>,
    out: Float64Array,
    count = points.length >> 1,
  ): Float64Array {
    const x = this.#x;
    for (let start = 0; start < count; start += SEA.sampleCapacity) {
      const m = Math.min(SEA.sampleCapacity, count - start);
      const into = new Float64Array(x.memory.buffer, x.samplePoints() >>> 0, 2 * m);
      for (let i = 0; i < 2 * m; i++) {
        into[i] = points[2 * start + i] ?? 0;
      }
      x.windSample(m);
      out.set(
        new Float64Array(x.memory.buffer, x.windValues() >>> 0, WIND_VALUES * m),
        WIND_VALUES * start,
      );
    }
    return out;
  }

  /**
   * The gust field's frame at the time windDrawAt set: the gustFrame
   * record, indexed by RECORDS.gustFrame. A view.
   */
  gustFrame(): Float64Array {
    this.#x.gustFrameAt();
    return this.records.gustFrame;
  }

  /**
   * The wind that raises the waves at (east, north) at a tick, from the
   * spells in play, as the server makes its own: its speed in m/s and the
   * direction it comes from, in radians, written to out.
   */
  waveWind(east: number, north: number, tick: number, out: number[]): number[] {
    this.#x.waveWind(east, north, tick);
    const v = new Float64Array(this.#x.memory.buffer, this.#x.waveValues() >>> 0, 2);
    out[0] = v[0] ?? 0;
    out[1] = v[1] ?? 0;
    return out;
  }

  /**
   * Derives the encounters' constants from the encounterParams record. Call
   * it after writing them (writeEncounterParams).
   */
  prepareEncounters(): void {
    this.#x.encounterPrepare();
  }

  /**
   * The wake of a boat of the prepared kind at (east, north) heading
   * heading, heeled heel with its boom at boom, moving at (vx, vy) m/s, in
   * a true wind of speed m/s from from: the wake record, indexed by
   * RECORDS.wake. A view: read it before the next call.
   */
  wakeOf(
    east: number,
    north: number,
    heading: number,
    heel: number,
    boom: number,
    vx: number,
    vy: number,
    speed: number,
    from: number,
  ): Float64Array {
    this.#x.wakeOf(east, north, heading, heel, boom, vx, vy, speed, from);
    return this.records.wake;
  }

  /** The wake the state record leaves in the wind of the env record, as the server's step leaves it. A view. */
  wakeOfState(): Float64Array {
    this.#x.wakeOfState();
    return this.records.wake;
  }

  /** The wakes shadowAt considers: ENCOUNTERS.wakes wake records, one after another. A view. */
  get wakes(): Float64Array {
    return new Float64Array(
      this.#x.memory.buffer,
      this.#x.wakes() >>> 0,
      ENCOUNTERS.wakes * SIZES.wake,
    );
  }

  /**
   * Changes the env record, the wind at the state's place, by the shadow of
   * the first n wakes, and returns how many reach it.
   */
  shadowAt(n: number): number {
    return this.#x.shadowAt(n) >>> 0;
  }

  /** Brings the course record to the state, in the true wind from windFrom. */
  courseTrack(windFrom: number): void {
    this.#x.courseTrack(windFrom);
  }

  /**
   * Brings a course, four values as the course record holds them, to a boat
   * heading heading with its boom at boom, in the true wind from windFrom.
   */
  courseOf(c: Float64Array, heading: number, boom: number, windFrom: number): void {
    const r = this.records.course;
    r.set(c);
    this.#x.courseOf(heading, boom, windFrom);
    c.set(this.records.course);
  }

  /** The Articles' verdict on the encounter record's two boats: the verdict record. A view. */
  articlesJudge(): Float64Array {
    this.#x.articlesJudge();
    return this.records.verdict;
  }

  /**
   * Resolves a contact between the state and other records' boats, both
   * of the prepared kind, writing the contact record; whether they touched.
   */
  collide(): boolean {
    return this.#x.collide() !== 0;
  }

  /** The sky's numbers, to write with writeSkyParams before prepareSky. A view. */
  get skyParams(): Float64Array {
    return new Float64Array(this.#x.memory.buffer, this.#x.skyParams() >>> 0, SKY_PARAMS);
  }

  /** Readies the sky from skyParams. Call it before asking about the sky. */
  prepareSky(): void {
    this.#x.skyPrepare();
  }

  /**
   * Sky time, in whole microseconds, at a world's time: the world's epoch
   * in microseconds of UTC since 1970, and the microseconds the world has
   * run since.
   */
  skyTime(worldEpoch: number, worldTime: number): number {
    return this.#x.skyTime(worldEpoch, worldTime);
  }

  /**
   * The sky at sky time t, in microseconds, from the place east and north
   * of the disk's centre, in metres: the sky record, indexed by SKY and
   * BODY. A view: read it before the next call.
   */
  skyAt(t: number, east: number, north: number): Float64Array {
    this.#x.skyAt(t, east, north);
    return new Float64Array(this.#x.memory.buffer, this.#x.sky() >>> 0, SKY.size);
  }

  /**
   * Where the star of a right ascension and declination, in degrees,
   * stands at sky time t from a place: a body, indexed by BODY. A view.
   */
  skyStar(t: number, east: number, north: number, ra: number, dec: number): Float64Array {
    this.#x.skyStar(t, east, north, ra, dec);
    return new Float64Array(this.#x.memory.buffer, this.#x.skyBody() >>> 0, BODY.size);
  }

  /**
   * The catalogue vector of a right ascension and declination, in degrees:
   * the vector the stars' matrix turns. Three values. A view.
   */
  skyVector(ra: number, dec: number): Float64Array {
    this.#x.skyVector(ra, dec);
    return new Float64Array(this.#x.memory.buffer, this.#x.skyBody() >>> 0, 3);
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

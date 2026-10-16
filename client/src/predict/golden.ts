// SPDX-License-Identifier: AGPL-3.0-only

// Runs the physics golden tests inside the WebAssembly module: the scenarios
// of internal/physics/testdata/scenarios.json and the function table of
// golden.json, compared bit for bit with what the server's Go computed. The
// tests run it under Node; the developer page runs it on a phone.

import { ARRAYS, RECORDS, SIZES } from './layout.gen';
import type { FnName, Physics, RecordName } from './physics';

type Values = Record<string, number>;

/** An area's inputs in whole steps: the wind's speed, the direction it comes from, the fetch. */
export type AreaInputs = readonly number[];

/** A record's values by name, arrays as arrays. */
export type RecordValues = Record<string, number | number[]>;

export interface ScenarioFile {
  /** The catalog's sea values. */
  sea: Values;
  params: RecordValues;
  /** The catalog's wind values, for the scenarios that sail in spells of weather. */
  wind?: RecordValues;
  /** The catalog's grounding values, for the scenarios that sail on a terrain. */
  ground?: RecordValues;
  scenarios: Scenario[];
}

/**
 * Gives a terrain's file, testdata/ground/<name>.terrain, unzipped: records
 * one after another, each a chunk's number as a little-endian uint16, a
 * kind byte (1 its ground: its elevations as int16s, then its surfaces; 2
 * its shelter's table), and that.
 */
export type TerrainLoader = (name: string) => Promise<Uint8Array>;

/** The spells of weather a scenario sails in, each by its fields' names, and the tick of step 0. */
export interface ScenarioWeather {
  tick: number;
  spells: RecordValues[];
}

/** The sea a scenario sails in: a window of areas, and the tick of step 0. */
export interface ScenarioSea {
  tick: number;
  col: number;
  row: number;
  size: number;
  areas: AreaInputs[];
}

export interface ScenarioChange {
  at: number;
  control?: Values;
  env?: Values;
  steer?: number;
  /** Replaces the inputs of the sea's areas; window, with it, moves the sea's window. */
  areas?: AreaInputs[];
  window?: readonly number[];
  /** Replaces the spells of weather in play. */
  spells?: RecordValues[];
}

export interface Scenario {
  name: string;
  steps: number;
  state?: Values;
  control?: Values;
  env?: Values;
  sea?: ScenarioSea;
  /** If present, each step's wind is the wind at the boat at the step's tick, and env is not used. */
  weather?: ScenarioWeather;
  /** If present, the terrain the scenario sails on: its ground, and the land's shelter for its wind. */
  terrain?: string;
  changes?: ScenarioChange[];
}

export interface GoldenFile {
  layout: string;
  scenarios: { name: string; digest: string; checkpoints: Checkpoint[] }[];
  functions: { name: string; args: string[][]; results: string[] }[];
}

export interface Checkpoint {
  step: number;
  state: Record<string, string>;
}

/** Must match checkpointEvery in internal/physics/golden_test.go. */
const checkpointEvery = 600;

export interface ScenarioResult {
  digest: string;
  checkpoints: Checkpoint[];
}

/**
 * Steps a scenario as the Go test does, hashing the state and Out after
 * every step.
 */
export async function runScenario(
  physics: Physics,
  file: Pick<ScenarioFile, 'sea' | 'params' | 'wind' | 'ground'>,
  scenario: Scenario,
  terrain?: TerrainLoader,
): Promise<ScenarioResult> {
  const r = physics.records;
  for (const v of Object.values(r)) {
    v.fill(0);
  }
  physics.groundUse(false);
  physics.shelterUse(false);
  if (scenario.terrain !== undefined) {
    if (terrain === undefined || file.ground === undefined) {
      throw new Error(`${scenario.name}: a terrain, and nothing to load it or no ground values`);
    }
    setRecord(physics.records.groundParams, 'groundParams', file.ground);
    physics.prepareGround();
    const sheltered = loadTerrain(physics, await terrain(scenario.terrain));
    physics.groundUse(true);
    physics.shelterUse(sheltered);
  }
  setFields(physics, 'seaParams', file.sea);
  physics.prepareSea();
  setRecord(physics.records.params, 'params', file.params);
  physics.prepare();
  const weather = scenario.weather;
  if (weather !== undefined) {
    if (file.wind === undefined) {
      throw new Error(`${scenario.name}: a weather, and no wind values`);
    }
    if (scenario.sea !== undefined && scenario.sea.tick !== weather.tick) {
      throw new Error(`${scenario.name}: the sea's tick is not the weather's`);
    }
    setRecord(physics.records.weatherParams, 'weatherParams', file.wind);
    physics.prepareWeather();
    physics.setSpells(weather.spells.map(spellOf));
  }
  setFields(physics, 'state', scenario.state);
  setFields(physics, 'control', scenario.control);
  setFields(physics, 'env', scenario.env);
  // The module's first window is the scenario's sea; with none, flat water.
  const sea = scenario.sea;
  let col = sea?.col ?? 0;
  let row = sea?.row ?? 0;
  const setAreas = (areas: AreaInputs[]): void => {
    if (sea === undefined || areas.length !== sea.size * sea.size) {
      throw new Error(`${scenario.name}: ${areas.length} areas for its sea`);
    }
    physics.seaWindow(0, col, row, sea.size);
    for (const [i, a] of areas.entries()) {
      physics.seaArea(0, i, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
    }
    physics.seaSeal(0);
  };
  physics.seaUse(sea === undefined ? -1 : 0);
  if (sea !== undefined) {
    setAreas(sea.areas);
  }

  const stateBytes = r.state.byteLength;
  const stepBytes = stateBytes + r.out.byteLength;
  const all = new Uint8Array(scenario.steps * stepBytes);
  const checkpoints: Checkpoint[] = [];
  const changes = scenario.changes ?? [];
  let next = 0;
  let steering = false;
  let target = 0;
  for (let i = 0; i < scenario.steps; i++) {
    for (; next < changes.length && changes[next]?.at === i; next++) {
      const change = changes[next];
      setFields(physics, 'control', change?.control);
      setFields(physics, 'env', change?.env);
      if (change?.control?.helm !== undefined) {
        steering = false;
      }
      if (change?.steer !== undefined) {
        steering = true;
        target = change.steer;
      }
      if (change?.areas !== undefined) {
        col = change.window?.[0] ?? col;
        row = change.window?.[1] ?? row;
        setAreas(change.areas);
      }
      if (change?.spells !== undefined) {
        if (weather === undefined) {
          throw new Error(`${scenario.name}: spells for a scenario with no weather`);
        }
        physics.setSpells(change.spells.map(spellOf));
      }
    }
    if (steering) {
      const rec = physics.records;
      rec.control[RECORDS.control.helm] = steer(target, rec.state);
    }
    if (sea !== undefined) {
      physics.seaAt(sea.tick + i);
    }
    if (weather !== undefined) {
      physics.windAt(weather.tick + i);
    }
    physics.step();
    const { state: s, out: o } = physics.records;
    all.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), i * stepBytes);
    all.set(new Uint8Array(o.buffer, o.byteOffset, o.byteLength), i * stepBytes + stateBytes);
    const n = i + 1;
    if (n % checkpointEvery === 0 || n === scenario.steps) {
      const state: Record<string, string> = {};
      for (const [name, index] of Object.entries(RECORDS.state)) {
        state[name] = toHex(s[index] ?? Number.NaN);
      }
      checkpoints.push({ step: n, state });
    }
  }
  if (next !== changes.length) {
    throw new Error(`${scenario.name}: change ${next} is out of order or past the last step`);
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return {
    digest: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
    checkpoints,
  };
}

/**
 * Writes a terrain's chunks into the module's slots, in turn, and reports
 * whether it holds any shelter.
 */
function loadTerrain(physics: Physics, raw: Uint8Array): boolean {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let at = 0;
  let groundSlot = 0;
  let shelterSlot = 0;
  while (at < raw.byteLength) {
    const chunk = v.getUint16(at, true);
    const kind = v.getUint8(at + 2);
    at += 3;
    if (kind === 1) {
      const into = physics.groundChunk(groundSlot++, chunk);
      for (let i = 0; i < into.elevation.length; i++) {
        into.elevation[i] = v.getInt16(at + 2 * i, true);
      }
      at += 2 * into.elevation.length;
      into.surface.set(raw.subarray(at, at + into.surface.length));
      at += into.surface.length;
    } else if (kind === 2) {
      const into = physics.shelterChunk(shelterSlot++, chunk);
      into.set(raw.subarray(at, at + into.length));
      at += into.length;
    } else {
      throw new Error(`a terrain's record of kind ${kind}`);
    }
  }
  return shelterSlot > 0;
}

/**
 * The scenarios' heading-hold, the twin of steer in golden_test.go. It uses
 * only operations IEEE 754 rounds exactly, so it gives the same bits as Go.
 */
export function steer(target: number, state: Float64Array): number {
  let off = target - (state[RECORDS.state.heading] ?? 0);
  if (off > Math.PI) {
    off -= 2 * Math.PI;
  } else if (off < -Math.PI) {
    off += 2 * Math.PI;
  }
  const helm = 2 * off - 0.8 * (state[RECORDS.state.yawRate] ?? 0);
  return Math.max(-1, Math.min(1, helm));
}

/**
 * Sets a record's fields from values by name, numbers or arrays of the
 * field's length; an unknown name, or an array of another length, is an
 * error.
 */
export function setRecord(view: Float64Array, record: RecordName, values: RecordValues): void {
  const fields: Record<string, number> = RECORDS[record];
  const lengths: Record<string, number> = ARRAYS[record];
  for (const [name, value] of Object.entries(values)) {
    const index = fields[name];
    if (index === undefined) {
      throw new Error(`${record} has no field ${name}`);
    }
    if (Array.isArray(value)) {
      if (value.length !== lengths[name]) {
        throw new Error(`${record}.${name} has ${value.length} values, not ${lengths[name]}`);
      }
      view.set(value, index);
    } else {
      view[index] = value;
    }
  }
}

/** A spell record's values from a spell by its fields' names. */
export function spellOf(values: RecordValues): Float64Array {
  const s = new Float64Array(SIZES.spell);
  setRecord(s, 'spell', values);
  return s;
}

/** A record's values by its fields' names, arrays as arrays. */
export function recordValues(record: RecordName, view: ArrayLike<number>): RecordValues {
  const lengths: Record<string, number> = ARRAYS[record];
  const out: RecordValues = {};
  for (const [name, index] of Object.entries(RECORDS[record])) {
    const n = lengths[name];
    out[name] =
      n === undefined
        ? (view[index] ?? 0)
        : Array.from({ length: n }, (_, i) => view[index + i] ?? 0);
  }
  return out;
}

function setFields(physics: Physics, record: RecordName, values: Values | undefined): void {
  const fields: Record<string, number> = RECORDS[record];
  const view = physics.records[record];
  for (const [name, value] of Object.entries(values ?? {})) {
    const index = fields[name];
    if (index === undefined) {
      throw new Error(`${record} has no field ${name}`);
    }
    view[index] = value;
  }
}

export interface GoldenReport {
  scenarios: number;
  /** Scenarios on a terrain, left out for want of a loader. */
  skipped: number;
  values: number;
  problems: string[];
}

/**
 * Runs every scenario and function of the golden files; lists what
 * differs. Without a terrain loader, the scenarios on a terrain are left
 * out.
 */
export async function checkGolden(
  physics: Physics,
  scenarios: ScenarioFile,
  golden: GoldenFile,
  terrain?: TerrainLoader,
): Promise<GoldenReport> {
  const report: GoldenReport = { scenarios: 0, skipped: 0, values: 0, problems: [] };
  for (const [i, scenario] of scenarios.scenarios.entries()) {
    const want = golden.scenarios[i];
    if (want?.name !== scenario.name) {
      report.problems.push(`golden.json has no results for ${scenario.name}`);
      continue;
    }
    if (scenario.terrain !== undefined && terrain === undefined) {
      report.skipped++;
      continue;
    }
    const got = await runScenario(physics, scenarios, scenario, terrain);
    report.scenarios++;
    if (got.digest !== want.digest) {
      const at = got.checkpoints.findIndex(
        (c, j) => JSON.stringify(c.state) !== JSON.stringify(sorted(want.checkpoints[j]?.state)),
      );
      const step = at < 0 ? 'between checkpoints' : `by step ${got.checkpoints[at]?.step}`;
      report.problems.push(`${scenario.name}: differs from the server ${step}`);
    }
  }
  for (const f of golden.functions) {
    const a = (f.args[0] ?? []).map(fromHex);
    const b = f.args[1]?.map(fromHex);
    const got = physics.evaluate(f.name as FnName, a, b);
    for (const [i, r] of f.results.entries()) {
      report.values++;
      const g = got[i] ?? Number.NaN;
      const w = fromHex(r);
      if (toHex(g) !== r && !(Number.isNaN(g) && Number.isNaN(w))) {
        report.problems.push(
          `${f.name}(${a[i]}${b ? `, ${b[i]}` : ''}) = ${g}, the server has ${w}`,
        );
      }
    }
  }
  return report;
}

/** The record's names in the order RECORDS gives them, as the Go test writes. */
function sorted(state: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(RECORDS.state)) {
    out[name] = state?.[name] ?? '';
  }
  return out;
}

const scratch = new DataView(new ArrayBuffer(8));

/** The IEEE 754 bits of x, as the Go test writes them. */
export function toHex(x: number): string {
  scratch.setFloat64(0, x);
  return `0x${scratch.getBigUint64(0).toString(16).padStart(16, '0')}`;
}

export function fromHex(s: string): number {
  scratch.setBigUint64(0, BigInt(s));
  return scratch.getFloat64(0);
}

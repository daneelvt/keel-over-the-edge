// SPDX-License-Identifier: AGPL-3.0-only

// Runs the physics golden tests inside the WebAssembly module: the scenarios
// of internal/physics/testdata/scenarios.json and the function table of
// golden.json, compared bit for bit with what the server's Go computed. The
// tests run it under Node; the developer page runs it on a phone.

import { RECORDS } from './layout.gen';
import type { FnName, Physics, RecordName } from './physics';

type Values = Record<string, number>;

export interface ScenarioFile {
  params: Values;
  scenarios: Scenario[];
}

export interface Scenario {
  name: string;
  steps: number;
  state?: Values;
  control?: Values;
  env?: Values;
  changes?: { at: number; control?: Values; env?: Values }[];
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

/** Steps a scenario as the Go test does, hashing the state after every step. */
export async function runScenario(
  physics: Physics,
  params: Values,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const r = physics.records;
  for (const v of Object.values(r)) {
    v.fill(0);
  }
  setFields(physics, 'params', params);
  setFields(physics, 'state', scenario.state);
  setFields(physics, 'control', scenario.control);
  setFields(physics, 'env', scenario.env);

  const stateBytes = r.state.byteLength;
  const all = new Uint8Array(scenario.steps * stateBytes);
  const checkpoints: Checkpoint[] = [];
  const changes = scenario.changes ?? [];
  let next = 0;
  for (let i = 0; i < scenario.steps; i++) {
    for (; next < changes.length && changes[next]?.at === i; next++) {
      setFields(physics, 'control', changes[next]?.control);
      setFields(physics, 'env', changes[next]?.env);
    }
    physics.step();
    const s = physics.records.state;
    all.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), i * stateBytes);
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
  values: number;
  problems: string[];
}

/** Runs every scenario and function of the golden files; lists what differs. */
export async function checkGolden(
  physics: Physics,
  scenarios: ScenarioFile,
  golden: GoldenFile,
): Promise<GoldenReport> {
  const report: GoldenReport = { scenarios: 0, values: 0, problems: [] };
  for (const [i, scenario] of scenarios.scenarios.entries()) {
    const want = golden.scenarios[i];
    if (want?.name !== scenario.name) {
      report.problems.push(`golden.json has no results for ${scenario.name}`);
      continue;
    }
    const got = await runScenario(physics, scenarios.params, scenario);
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

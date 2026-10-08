// SPDX-License-Identifier: AGPL-3.0-only

// Recording a sail. From a starting state, the recorder keeps each change of
// control or wind with the step it applied to, in the format of the physics
// golden scenarios (internal/physics/testdata/scenarios.json), so a sail
// found strange in play can become a test: the Go runner replays it and must
// reach the state the sandbox reached. It allocates only when a control or
// the wind changes, never per frame.

import { toHex } from '../predict/golden';
import { ARRAYS, RECORDS } from '../predict/layout.gen';

type Values = Record<string, number>;

export interface RecordedChange {
  at: number;
  control?: Values;
  env?: Values;
}

export interface RecordedScenario {
  name: string;
  steps: number;
  state: Values;
  control: Values;
  env: Values;
  changes: RecordedChange[];
  /** The state after the last step, each field's IEEE 754 bits in hexadecimal. */
  end: Record<string, string>;
}

export interface Recording {
  description: string;
  params: Record<string, number | number[]>;
  scenarios: RecordedScenario[];
}

/** A record's fields by name, as the golden scenarios name them. */
export function fieldsOf(record: keyof typeof RECORDS, view: Float64Array): Values {
  const out: Values = {};
  for (const [name, index] of Object.entries(RECORDS[record])) {
    out[name] = view[index] ?? 0;
  }
  return out;
}

/** The params record by name, arrays as arrays. */
export function paramsOf(view: Float64Array): Record<string, number | number[]> {
  const lengths: Record<string, number> = ARRAYS.params;
  const out: Record<string, number | number[]> = {};
  for (const [name, index] of Object.entries(RECORDS.params)) {
    const n = lengths[name];
    out[name] = n === undefined ? (view[index] ?? 0) : Array.from(view.subarray(index, index + n));
  }
  return out;
}

export class Recorder {
  #start: { state: Values; control: Values; env: Values } | null = null;
  #changes: RecordedChange[] = [];
  #steps = 0;
  #helm = 0;
  #sheet = 0;
  #speed = 0;
  #from = 0;

  /** Starts a recording from this state, controls and wind. */
  start(state: Float64Array, control: Float64Array, env: Float64Array): void {
    this.#start = {
      state: fieldsOf('state', state),
      control: fieldsOf('control', control),
      env: fieldsOf('env', env),
    };
    this.#changes = [];
    this.#steps = 0;
    this.#helm = control[RECORDS.control.helm] ?? 0;
    this.#sheet = control[RECORDS.control.sheet] ?? 0;
    this.#speed = env[RECORDS.env.windSpeed] ?? 0;
    this.#from = env[RECORDS.env.windFrom] ?? 0;
  }

  /** Notes the controls and wind of the step about to be taken. */
  step(helm: number, sheet: number, speed: number, from: number): void {
    if (this.#start === null) {
      return;
    }
    if (!Object.is(helm, this.#helm) || !Object.is(sheet, this.#sheet)) {
      const control: Values = {};
      if (!Object.is(helm, this.#helm)) {
        control.helm = helm;
      }
      if (!Object.is(sheet, this.#sheet)) {
        control.sheet = sheet;
      }
      this.#change().control = control;
      this.#helm = helm;
      this.#sheet = sheet;
    }
    if (!Object.is(speed, this.#speed) || !Object.is(from, this.#from)) {
      this.#change().env = { windSpeed: speed, windFrom: from };
      this.#speed = speed;
      this.#from = from;
    }
    this.#steps++;
  }

  /** Steps recorded since the start. */
  get steps(): number {
    return this.#steps;
  }

  /** The recording, ending in state, as a scenario file of one scenario. */
  recording(name: string, params: Float64Array, state: Float64Array): Recording {
    const start = this.#start ?? { state: {}, control: {}, env: {} };
    const end: Record<string, string> = {};
    for (const [field, index] of Object.entries(RECORDS.state)) {
      end[field] = toHex(state[index] ?? Number.NaN);
    }
    return {
      description:
        'A sail recorded in the sandbox. Each change applies before the step it names, counting from 0; end is the state the sandbox reached after the last step. The params are the boat the sandbox sailed.',
      params: paramsOf(params),
      scenarios: [
        {
          name,
          steps: this.#steps,
          state: start.state,
          control: start.control,
          env: start.env,
          changes: this.#changes.map((c) => ({ ...c })),
          end,
        },
      ],
    };
  }

  #change(): RecordedChange {
    const last = this.#changes[this.#changes.length - 1];
    if (last !== undefined && last.at === this.#steps) {
      return last;
    }
    const c: RecordedChange = { at: this.#steps };
    this.#changes.push(c);
    return c;
  }
}

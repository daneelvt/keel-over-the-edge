// SPDX-License-Identifier: AGPL-3.0-only

// Recording a sail. From a starting state, the recorder keeps each change of
// control, weather or sea with the step it applied to, in the format of the physics
// golden scenarios (internal/physics/testdata/scenarios.json), so a sail
// found strange in play can become a test: the Go runner replays it and must
// reach the state the sandbox reached. It allocates only when a control,
// the weather or the sea changes, never per frame.

import { PILOT_IDLE, type PilotControl } from '../input/pilot';
import {
  type RecordValues,
  recordValues,
  type ScenarioSea,
  type ScenarioWeather,
  toHex,
} from '../predict/golden';
import { RECORDS, SEA } from '../predict/layout.gen';

type Values = Record<string, number>;

/**
 * A developer's weather, as the server's command has it: its mode (0 the
 * world's own, 1 a regime held, 2 a steady wind), the regime's index, and
 * the wind's speed in steps of 0.01 m/s and direction in 65536ths of a turn.
 */
export interface WeatherSet {
  mode: number;
  regime: number;
  speed: number;
  dir: number;
}

export interface RecordedChange {
  at: number;
  control?: Values;
  /** The sea's areas from this step on, and its window's first area. */
  areas?: number[][];
  window?: number[];
  /**
   * The spells of weather in play from this step on; and, when the sandbox
   * set them as a server would at a developer's command given at this step,
   * the command, so that a server can be given it too.
   */
  spells?: RecordValues[];
  set?: WeatherSet;
}

/** The sea of a step: the window in effect, and a stamp that changes when it does. */
export interface StepSea {
  readonly stamp: number;
  readonly col: number;
  readonly row: number;
  areas(): number[][];
}

/** The weather of a step: the spells in play, a count of their changes, and the command behind the last. */
export interface StepWeather {
  readonly version: number;
  readonly spells: readonly ArrayLike<number>[];
  readonly set: WeatherSet | null;
}

export interface RecordedScenario {
  name: string;
  steps: number;
  state: Values;
  control: Values;
  /** Not used: the wind is the weather's. */
  env: Values;
  /** The sea of the first step, and its tick; the spells in play then. */
  sea: ScenarioSea;
  weather: ScenarioWeather;
  changes: RecordedChange[];
  /** The state after the last step, each field's IEEE 754 bits in hexadecimal. */
  end: Record<string, string>;
}

export interface Recording {
  description: string;
  /** The catalog's sea values the sandbox sailed in, and its wind values. */
  sea: Values;
  params: RecordValues;
  wind: RecordValues;
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

export class Recorder {
  #start: { state: Values; control: Values } | null = null;
  #sea: ScenarioSea | null = null;
  #weather: ScenarioWeather | null = null;
  #stamp = -1;
  #version = -1;
  #changes: RecordedChange[] = [];
  #steps = 0;
  #helm = 0;
  #sheet = 0;
  readonly #pilot = { mode: 0, target: 0, order: 0, way: 0 };

  /** Starts a recording from this state and these controls. */
  start(state: Float64Array, control: Float64Array): void {
    this.#start = { state: fieldsOf('state', state), control: fieldsOf('control', control) };
    this.#sea = null;
    this.#weather = null;
    this.#changes = [];
    this.#steps = 0;
    this.#helm = control[RECORDS.control.helm] ?? 0;
    this.#sheet = control[RECORDS.control.sheet] ?? 0;
    this.#pilot.mode = control[RECORDS.control.pilot] ?? 0;
    this.#pilot.target = control[RECORDS.control.target] ?? 0;
    this.#pilot.order = control[RECORDS.control.order] ?? 0;
    this.#pilot.way = control[RECORDS.control.way] ?? 0;
  }

  /** Notes the controls, the weather and the sea of the step about to be taken into tick. */
  step(
    helm: number,
    sheet: number,
    tick: number,
    sea: StepSea,
    weather: StepWeather,
    pilot: PilotControl = PILOT_IDLE,
  ): void {
    if (this.#start === null) {
      return;
    }
    if (this.#sea === null) {
      this.#sea = { tick, col: sea.col, row: sea.row, size: SEA.window, areas: sea.areas() };
    } else if (sea.stamp !== this.#stamp) {
      const c = this.#change();
      c.areas = sea.areas();
      c.window = [sea.col, sea.row];
    }
    this.#stamp = sea.stamp;
    const spells = (): RecordValues[] => weather.spells.map((s) => recordValues('spell', s));
    if (this.#weather === null) {
      this.#weather = { tick, spells: spells() };
    } else if (weather.version !== this.#version) {
      const c = this.#change();
      c.spells = spells();
      if (weather.set !== null) {
        c.set = { ...weather.set };
      }
    }
    this.#version = weather.version;
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
    const was = this.#pilot;
    if (
      pilot.mode !== was.mode ||
      pilot.target !== was.target ||
      pilot.order !== was.order ||
      pilot.way !== was.way
    ) {
      const c = this.#change();
      c.control = {
        ...c.control,
        pilot: pilot.mode,
        target: pilot.target,
        order: pilot.order,
        way: pilot.way,
      };
      was.mode = pilot.mode;
      was.target = pilot.target;
      was.order = pilot.order;
      was.way = pilot.way;
    }
    this.#steps++;
  }

  /** Steps recorded since the start. */
  get steps(): number {
    return this.#steps;
  }

  /** The recording, ending in state, as a scenario file of one scenario. */
  recording(
    name: string,
    seaParams: Float64Array,
    params: Float64Array,
    weatherParams: Float64Array,
    state: Float64Array,
  ): Recording {
    const start = this.#start ?? { state: {}, control: {} };
    const end: Record<string, string> = {};
    for (const [field, index] of Object.entries(RECORDS.state)) {
      end[field] = toHex(state[index] ?? Number.NaN);
    }
    return {
      description:
        "A sail recorded in the sandbox. Each change applies before the step it names, counting from 0; end is the state the sandbox reached after the last step. The params are the boat the sandbox sailed, sea the catalog's sea values it sailed in and wind its wind values. A scenario's sea is the window of sea areas about the boat at step 0 and that step's tick, and its weather the spells in play then; a change's areas and window are the sea's from that step on, its spells the spells in play from it on, and its set the developer's weather the sandbox was given at that step, which a server given the same at that step's tick answers with the same spell.",
      sea: fieldsOf('seaParams', seaParams),
      params: recordValues('params', params),
      wind: recordValues('weatherParams', weatherParams),
      scenarios: [
        {
          name,
          steps: this.#steps,
          state: start.state,
          control: start.control,
          env: { windSpeed: 0, windFrom: 0 },
          sea: this.#sea ?? { tick: 0, col: 0, row: 0, size: SEA.window, areas: [] },
          weather: this.#weather ?? { tick: 0, spells: [] },
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

// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox steps the boat the server would: every golden scenario fed
// through its driver gives golden.json's digest, bit for bit, and a sail it
// records replays in the golden runners to the state it reached. The Go
// test (internal/physics/recording_test.go) replays the same file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import {
  fromHex,
  type GoldenFile,
  runScenario,
  type ScenarioFile,
  steer,
  toHex,
} from '../predict/golden';
import { LAYOUT_VERSION, RECORDS } from '../predict/layout.gen';
import { loadPhysics, Physics } from '../predict/physics';
import type { Recording } from './record';
import { KNOT, Sandbox, START, startSandbox, windFromQuery } from './sandbox';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
const testdata = new URL('../../../internal/physics/testdata/', import.meta.url);
const fixture = new URL('recordings/sandbox-sail.json', testdata);
const boat = catalog.boats[0].physics;

function readJSON<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

describe('the sandbox', () => {
  test('starts at the centre, at rest, heading 090°, in 10 knots from the north', async () => {
    const s = await startSandbox(bytes, boat);
    const c = s.states.current;
    expect(c[RECORDS.state.x]).toBe(0);
    expect(c[RECORDS.state.y]).toBe(0);
    expect(c[RECORDS.state.heading]).toBe(Math.PI / 2);
    expect(c[RECORDS.state.surge]).toBe(0);
    expect(s.wind.speed).toBeCloseTo(5.1444, 4);
    expect(s.wind.from).toBe(0);
  });

  test('refuses a module with another layout, saying so', async () => {
    const real = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
    const exports = { ...real.exports, layout: () => LAYOUT_VERSION ^ 1 };
    expect(() => new Physics({ exports } as WebAssembly.Instance)).toThrow(
      /physics module: layout 0x[0-9a-f]{8}, but this client expects/,
    );
  });

  test('reads ?wind=knots,degrees', () => {
    const w = windFromQuery(new URLSearchParams('wind=12,45'));
    expect(w?.speed).toBeCloseTo(12 * KNOT, 12);
    expect(w?.from).toBeCloseTo(Math.PI / 4, 12);
    expect(windFromQuery(new URLSearchParams('wind=8'))?.from).toBe(0);
    expect(windFromQuery(new URLSearchParams('wind=8,-90'))?.from).toBeCloseTo(1.5 * Math.PI, 12);
    expect(windFromQuery(new URLSearchParams('wind=fast'))).toBeNull();
    expect(windFromQuery(new URLSearchParams(''))).toBeNull();
  });

  test('every golden scenario through the driver gives the server’s bits', async () => {
    const scenarios = readJSON<ScenarioFile>(new URL('scenarios.json', testdata));
    const golden = readJSON<GoldenFile>(new URL('golden.json', testdata));
    const physics = await loadPhysics(bytes);
    for (const [k, sc] of scenarios.scenarios.entries()) {
      const s = new Sandbox(physics, boat, { ...START, heading: 0, sheet: 0 });
      s.setState(sc.state ?? {});
      let helm = sc.control?.helm ?? 0;
      let sheet = sc.control?.sheet ?? 0;
      s.setWind(sc.env?.windSpeed ?? 0, sc.env?.windFrom ?? 0);
      const record = 15 + 19;
      const all = new Float64Array(sc.steps * record);
      const changes = sc.changes ?? [];
      let next = 0;
      let steering = false;
      let target = 0;
      for (let i = 0; i < sc.steps; i++) {
        for (; next < changes.length && changes[next]?.at === i; next++) {
          const c = changes[next];
          helm = c?.control?.helm ?? helm;
          sheet = c?.control?.sheet ?? sheet;
          if (c?.env !== undefined) {
            s.setWind(c.env.windSpeed ?? s.wind.speed, c.env.windFrom ?? s.wind.from);
          }
          if (c?.control?.helm !== undefined) {
            steering = false;
          }
          if (c?.steer !== undefined) {
            steering = true;
            target = c.steer;
          }
        }
        if (steering) {
          helm = steer(target, s.states.current);
        }
        s.step(helm, sheet);
        all.set(s.states.current, i * record);
        all.set(s.out, i * record + 15);
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      expect(hex, sc.name).toBe(golden.scenarios[k]?.digest);
    }
  });
});

/**
 * A scripted sail through the input layer's resolution: trim in, bear away,
 * tack, a change of wind, ease out. Returns the sandbox's recording.
 */
async function scriptedSail(): Promise<Recording> {
  const s = await startSandbox(bytes, boat);
  s.record();
  for (let i = 0; i < 1800; i++) {
    let helm = 0;
    let sheet = 0.5;
    if (i >= 30) {
      sheet = 0.3;
    }
    if (i >= 300 && i < 360) {
      helm = 0.37 * Math.sin(((i - 300) / 60) * Math.PI);
    }
    if (i >= 700 && i < 790) {
      helm = -1;
      sheet = 0.1;
    }
    if (i >= 790 && i < 1200) {
      sheet = 0.2;
    }
    if (i === 1000) {
      s.setWind(12 * KNOT, (20 * Math.PI) / 180);
    }
    if (i >= 1200) {
      sheet = 0.2 + ((i - 1200) / 600) * 0.3;
    }
    s.step(quantiseHelm(helm), quantiseSheet(sheet));
  }
  return s.recorded('sandbox-sail');
}

describe('a recorded sail', () => {
  test('replays in the golden runner to the state the sandbox reached', async () => {
    const rec = await scriptedSail();
    const sc = rec.scenarios[0];
    if (sc === undefined) {
      throw new Error('no scenario');
    }
    expect(sc.steps).toBe(1800);
    // Changes only where a control or the wind changed.
    expect(sc.changes.length).toBeGreaterThan(5);
    expect(sc.changes.length).toBeLessThan(700);
    const replay = await runScenario(await loadPhysics(bytes), rec.params, sc);
    expect(replay.checkpoints.at(-1)?.state).toEqual(sc.end);
    // The boat sailed: it is well away from where it started.
    expect(Math.hypot(fromHex(sc.end.x ?? '0x0'), fromHex(sc.end.y ?? '0x0'))).toBeGreaterThan(50);
  });

  test('is the file the Go runner replays', async () => {
    const rec = await scriptedSail();
    const text = `${JSON.stringify(rec, null, 1)}\n`;
    if (process.env.UPDATE_RECORDING === '1') {
      writeFileSync(fixture, text);
    }
    expect(readFileSync(fixture, 'utf8')).toBe(text);
  });

  test('its params are the catalog boat’s, as the golden scenarios have them', async () => {
    const rec = await scriptedSail();
    const scenarios = readJSON<ScenarioFile>(new URL('scenarios.json', testdata));
    expect(rec.params).toEqual(scenarios.params);
    expect(rec.scenarios[0]?.end.heading).toBe(toHex(fromHex(rec.scenarios[0]?.end.heading ?? '')));
  });
});

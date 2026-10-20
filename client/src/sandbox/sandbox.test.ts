// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox steps the boat the server would: every golden scenario fed
// through its driver gives golden.json's digest, bit for bit, and a sail it
// records replays in the golden runners to the state it reached. The Go
// test (internal/physics/recording_test.go) replays the same file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { PILOT_WIND, PilotInput } from '../input/pilot';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import {
  fromHex,
  type GoldenFile,
  runScenario,
  type ScenarioFile,
  spellOf,
  steer,
  toHex,
} from '../predict/golden';
import { LAYOUT_VERSION, RECORDS, SIZES } from '../predict/layout.gen';
import { loadPhysics, Physics } from '../predict/physics';
import type { Recording } from './record';
import {
  FRONT,
  KNOT,
  Sandbox,
  START,
  STEADY,
  seaFromQuery,
  startSandbox,
  weatherFromQuery,
  windFromQuery,
} from './sandbox';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
const testdata = new URL('../../../internal/physics/testdata/', import.meta.url);
const fixture = new URL('recordings/sandbox-sail.json', testdata);
const boat = catalog.boats[0].physics;
const sea = catalog.weather;

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
  test('starts at the centre, at rest, heading 090°, in a steady 10 knots from the north', async () => {
    const s = await startSandbox(bytes, boat, sea);
    const c = s.states.current;
    expect(c[RECORDS.state.x]).toBe(0);
    expect(c[RECORDS.state.y]).toBe(0);
    expect(c[RECORDS.state.heading]).toBe(Math.PI / 2);
    expect(c[RECORDS.state.surge]).toBe(0);
    // 10 knots in the steps a wind is rounded to: 5.14 m/s.
    expect(s.wind.speed).toBeCloseTo(5.14, 12);
    expect(s.wind.from).toBe(0);
    expect(s.wind.meanSpeed).toBe(s.wind.speed);
    expect(s.wind.gust).toBe(0);
    expect(s.regime).toBe(STEADY);
    expect(s.weather.spells).toHaveLength(1);
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

  test('reads ?sea=calm, breeze, fresh or gale as its wind', () => {
    expect(seaFromQuery(new URLSearchParams('sea=gale'))?.speed).toBeCloseTo(34 * KNOT, 12);
    expect(seaFromQuery(new URLSearchParams('sea=calm'))?.speed).toBeCloseTo(6 * KNOT, 12);
    expect(seaFromQuery(new URLSearchParams('sea=breeze'))?.from).toBe(0);
    expect(seaFromQuery(new URLSearchParams('sea=flat'))).toBeNull();
    expect(seaFromQuery(new URLSearchParams(''))).toBeNull();
  });

  test('raises the sea its wind gives, and sails in it', async () => {
    const s = await startSandbox(bytes, boat, sea, {
      ...START,
      wind: { speed: 34 * KNOT, from: 0 },
    });
    const slot = s.seas.slotAt(s.tick + 1);
    expect(slot).toBeGreaterThanOrEqual(0);
    const hs = s.physics.seaHs(slot);
    // A gale over six miles of open water: about a metre.
    expect(hs[0]).toBeGreaterThan(0.8);
    expect(hs[0]).toBeLessThan(1.2);
    expect(Array.from(hs).every((h) => h === hs[0])).toBe(true);
    expect(s.physics.seaActive(slot).length).toBeGreaterThan(80);
    for (let i = 0; i < 300; i++) {
      s.step(0, 0.5);
    }
    const c = s.states.current;
    expect(
      Math.abs(c[RECORDS.state.heave] ?? 0) + Math.abs(c[RECORDS.state.pitch] ?? 0),
    ).toBeGreaterThan(0.01);
    expect(Math.abs(s.out[RECORDS.out.waveHeight] ?? 0)).toBeGreaterThan(0);
  });

  test('a change of wind blows from the second after next, and the sea follows it over minutes, as the server’s does', async () => {
    const s = await startSandbox(bytes, boat, sea);
    const hs = (): number => s.physics.seaHs(s.seas.slotAt(s.tick))[0] ?? 0;
    // The state is at tick 1; steps sail into ticks 2, 3 …
    for (let i = 0; i < 40; i++) {
      s.step(0, 0.5);
    }
    const before = hs();
    const breeze = s.wind.speed;
    s.setWind(34 * KNOT, 0); // given at the step into tick 42
    const stamp = s.sea.stamp;
    let blewAt = 0;
    let changedAt = 0;
    for (let i = 0; i < 80; i++) {
      s.step(0, 0.5);
      if (blewAt === 0 && s.wind.speed !== breeze) {
        blewAt = s.tick;
      }
      if (changedAt === 0 && hs() !== before) {
        changedAt = s.tick;
      }
    }
    // Tick 42 is in the second from 30: the wind blows from tick 90, and the
    // sea of the second from 90, fixed a second before, is the first to
    // feel it.
    expect(blewAt).toBe(90);
    expect(changedAt).toBe(90);
    expect(s.wind.speed).toBeCloseTo(17.49, 12);
    expect(s.sea.stamp).toBeGreaterThan(stamp);
    // A little at first: the sea lags the wind.
    expect(hs()).toBeLessThan(1.2 * before);
    for (let i = 0; i < 12 * 60 * 30; i++) {
      s.step(0, 1);
    }
    expect(hs()).toBeGreaterThan(3 * before);
  });

  test('sails in a spell of a regime, with its gusts, when asked', async () => {
    const s = await startSandbox(bytes, boat, sea, { ...START, weather: 'trade' });
    expect(s.regime).toBe('trade');
    const regime = sea.regimes.find((r) => r.id === 'trade');
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    let gusts = 0;
    for (let i = 0; i < 1800; i++) {
      s.step(0, 0.6);
      lo = Math.min(lo, s.wind.speed);
      hi = Math.max(hi, s.wind.speed);
      gusts = Math.max(gusts, Math.abs(s.wind.gust));
      // The step sailed in the wind read for it.
      expect(s.records.env[RECORDS.env.windSpeed]).toBe(s.wind.speed);
    }
    expect(hi).toBeGreaterThan(1.1 * lo);
    expect(gusts).toBeGreaterThan(0.3);
    // At the centre the wind is 0.65 of the spell's, softened by the refuge.
    const [least, most] = regime?.wind.speed ?? [0, 0];
    expect(s.wind.meanSpeed / KNOT).toBeGreaterThan(0.6 * (least ?? 0));
    expect(s.wind.meanSpeed / KNOT).toBeLessThan(0.7 * (most ?? 0));
    // Back to a steady wind: the mean wind at the boat, held.
    const mean = s.wind.meanSpeed;
    s.setWeather(STEADY);
    for (let i = 0; i < 90; i++) {
      s.step(0, 0.6);
    }
    expect(s.regime).toBe(STEADY);
    expect(s.wind.gust).toBe(0);
    expect(Math.abs(s.wind.speed - mean)).toBeLessThan(0.006);
  });

  test('meets a squall three minutes in, and its gust front, with ?weather=squall', async () => {
    // Three miles out, where a squall is whole.
    const s = await startSandbox(bytes, boat, sea, { ...START, east: 5556, weather: 'squall' });
    s.step(0, 0.6);
    const before = s.wind.meanSpeed;
    let most = 0;
    let mostAt = 0;
    for (let i = 0; i < 5 * 60 * 30; i++) {
      s.step(0, 0.6);
      if (s.wind.meanSpeed > most) {
        most = s.wind.meanSpeed;
        mostAt = i;
      }
    }
    expect(most).toBeGreaterThan(1.5 * before);
    // The boat sails on meanwhile: within a minute of three.
    expect(Math.abs(mostAt / 30 - 180)).toBeLessThan(60);
  });

  test('meets a front three minutes in, the wind veering as it passes, with ?weather=front', async () => {
    const s = await startSandbox(bytes, boat, sea, { ...START, east: 5556, weather: FRONT });
    s.step(0, 0.6);
    const before = s.wind.meanFrom;
    for (let i = 0; i < 4 * 60 * 30; i++) {
      s.step(0, 0.6);
    }
    const veered = ((((s.wind.meanFrom - before) * 180) / Math.PI + 540) % 360) - 180;
    expect(veered).toBeGreaterThan(25);
  });

  test('reads ?weather=steady, front, a regime’s id or a kind of system’s', () => {
    expect(weatherFromQuery(new URLSearchParams('weather=stormy'), sea)).toBe('stormy');
    expect(weatherFromQuery(new URLSearchParams('weather=fog'), sea)).toBe('fog');
    expect(weatherFromQuery(new URLSearchParams('weather=front'), sea)).toBe(FRONT);
    expect(weatherFromQuery(new URLSearchParams('weather=steady'), sea)).toBe(STEADY);
    expect(weatherFromQuery(new URLSearchParams('weather=doldrums'), sea)).toBeNull();
    expect(weatherFromQuery(new URLSearchParams(''), sea)).toBeNull();
  });

  test('its window of the sea follows the boat', async () => {
    const s = await startSandbox(bytes, boat, sea);
    expect([s.sea.col, s.sea.row]).toEqual([16, 16]);
    s.place(1000, -700, 0);
    expect([s.sea.col, s.sea.row]).toEqual([18, 14]);
    // Sailing 30 m past an area's edge leaves it; 80 m past moves it.
    const edge = (20 - 18 + 0.5) * 463;
    s.setState({ x: edge - 5, surge: 0 });
    const stamp = s.sea.stamp;
    s.step(0, 1);
    expect(s.sea.col).toBe(18);
    s.setState({ x: edge + 80 });
    expect(s.sea.col).toBe(19);
    expect(s.sea.stamp).toBeGreaterThan(stamp);
  });

  test('every golden scenario in a weather, through the driver, gives the server’s bits', async () => {
    const scenarios = readJSON<ScenarioFile>(new URL('scenarios.json', testdata));
    const golden = readJSON<GoldenFile>(new URL('golden.json', testdata));
    const physics = await loadPhysics(bytes);
    let ran = 0;
    for (const [k, sc] of scenarios.scenarios.entries()) {
      const weather = sc.weather;
      if (weather === undefined || sc.sea !== undefined || sc.terrain !== undefined) {
        // The sandbox makes its own wind and sea, on open water: a scenario
        // with a wind given step by step, a sea or a terrain is not its to
        // sail. A recorded sail, below, has both of the first.
        continue;
      }
      ran++;
      const s = new Sandbox(physics, boat, sea, { ...START, heading: 0, sheet: 0 });
      // The scenarios without a sea are in flat water.
      s.sea.options.flat = true;
      // Step 0 sails into the weather's tick.
      s.tick = weather.tick - 1;
      s.weather.set(weather.spells.map(spellOf));
      s.setCirculation(weather.circulation ?? 0);
      s.setState(sc.state ?? {});
      let helm = sc.control?.helm ?? 0;
      let sheet = sc.control?.sheet ?? 0;
      // The autopilot's control, as the scenario gives it.
      const pilot = {
        mode: sc.control?.pilot ?? 0,
        target: sc.control?.target ?? 0,
        order: sc.control?.order ?? 0,
        way: sc.control?.way ?? 0,
      };
      const record = SIZES.state + SIZES.out;
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
          pilot.mode = c?.control?.pilot ?? pilot.mode;
          pilot.target = c?.control?.target ?? pilot.target;
          pilot.order = c?.control?.order ?? pilot.order;
          pilot.way = c?.control?.way ?? pilot.way;
          if (c?.spells !== undefined) {
            s.weather.set(c.spells.map(spellOf));
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
        s.step(helm, sheet, pilot);
        all.set(s.states.current, i * record);
        all.set(s.out, i * record + SIZES.state);
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      expect(hex, sc.name).toBe(golden.scenarios[k]?.digest);
    }
    expect(ran).toBeGreaterThanOrEqual(6);
  });
});

/**
 * A scripted sail through the input layer's resolution: trim in, bear away,
 * a trade spell with its gusts, a tack, a steady wind again, ease out; then
 * the autopilot on at the boat's angle to the wind, and a tack on it.
 * Returns the sandbox's recording.
 */
async function scriptedSail(): Promise<Recording> {
  const s = await startSandbox(bytes, boat, sea);
  s.record();
  const pilot = new PilotInput();
  for (let i = 0; i < 1800; i++) {
    if (i === 1300) {
      pilot.engage(PILOT_WIND, s.states.current[RECORDS.state.heading] ?? 0, s.wind.meanFrom);
    }
    if (i === 1500) {
      pilot.tack(s.wind.meanFrom);
    }
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
    if (i === 400) {
      s.setWeather('trade');
    }
    if (i === 1000) {
      s.setWind(12 * KNOT, (20 * Math.PI) / 180);
    }
    if (i >= 1200) {
      sheet = 0.2 + ((i - 1200) / 600) * 0.3;
    }
    s.step(quantiseHelm(helm), quantiseSheet(sheet), pilot);
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
    // Changes only where a control, the weather or the sea changed.
    expect(sc.changes.length).toBeGreaterThan(5);
    expect(sc.changes.length).toBeLessThan(700);
    const replay = await runScenario(await loadPhysics(bytes), rec, sc);
    expect(replay.checkpoints.at(-1)?.state).toEqual(sc.end);
    // It began in a steady 10 knots and its sea.
    expect(sc.sea.tick).toBe(2);
    expect(sc.weather.tick).toBe(2);
    expect(sc.weather.spells).toHaveLength(1);
    expect(sc.weather.spells[0]).toMatchObject({ steady: 1, speed: 514, from: 0, begin: 0 });
    expect(sc.sea.areas).toHaveLength(25);
    expect(sc.sea.areas[0]).toEqual([514, 0, 11112]);
    // The trade spell is asked for at step 400, which sails into tick 402,
    // and the steady wind at step 1000, into tick 1002: each as a server's
    // developer would set it, to blow from the second after next.
    const sets = sc.changes.filter((c) => c.spells !== undefined);
    expect(sets.map((c) => [c.at, c.set?.mode, c.spells?.at(-1)?.begin])).toEqual([
      [400, 1, 450],
      [1000, 2, 1050],
    ]);
    expect(sets[0]?.spells?.at(-1)).toMatchObject({ steady: 0, regime: 1, gust: 1300, drift: 0 });
    expect(sets[1]?.set).toEqual({ mode: 2, regime: 0, speed: 617, dir: 3641 });
    // The sea follows the wave wind: from the second the trade spell
    // begins, tick 450, every area's waves change each second.
    const seaChanges = sc.changes.filter((c) => c.areas !== undefined).map((c) => c.at);
    expect(seaChanges[0]).toBe(448);
    expect(seaChanges.every((at, i) => i === 0 || at - (seaChanges[i - 1] ?? 0) === 30)).toBe(true);
    expect(seaChanges.length).toBe(46);
    // The boat sailed: it is well away from where it started.
    expect(Math.hypot(fromHex(sc.end.x ?? '0x0'), fromHex(sc.end.y ?? '0x0'))).toBeGreaterThan(40);
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
    expect(rec.sea).toEqual(scenarios.sea);
    expect(rec.wind).toEqual(scenarios.wind);
    expect(rec.scenarios[0]?.end.heading).toBe(toHex(fromHex(rec.scenarios[0]?.end.heading ?? '')));
  });
});

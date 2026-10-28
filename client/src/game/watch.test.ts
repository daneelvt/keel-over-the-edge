// SPDX-License-Identifier: AGPL-3.0-only

// The watching driver, with the physics module under Node: a run of
// headers, recorded from a boat stepped as the server steps it, drawn at
// the near band's delay between the two either side; its Out the
// module's one step from the header at or before the render tick, never
// one ahead; a boat held past its newest header; and a fall's end counted
// as a start again. And Online watching: the headers drawn by it, no
// controls sent, a later Welcome on the same connection keeping what was
// handed, the own boat back with its notice, and a watch ended or refused.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { PilotInput } from '../input/pilot';
import type { FromWorker, LightSeen, ToWorker, WatchingTold } from '../net/messages';
import { Online, type Port } from '../net/online';
import { newSnapshot, type OwnSnapshot, writeSnapshot } from '../net/snapshot';
import { FLEET_RECORD_BYTES } from '../net/view';
import { lerpAngle, newPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { steadySpell } from '../predict/weather';
import { BOAT_IN_THE_WATER, endedText } from '../ui/watchwords';
import { NEAR_DELAY } from './fleet';
import { WatchDriver } from './watch';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
const boat = catalog.boats[0].physics;
const S = RECORDS.state;
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

/** A module readied as the page's is, in a steady 12 knots from the north. */
async function predictor(): Promise<Predictor> {
  const p = new Predictor(await loadPhysics(bytes), boat, catalog.weather, catalog.world);
  p.weather.set([steadySpell(p.physics, 6, 0, 0)]);
  return p;
}

async function watcher(): Promise<WatchDriver> {
  const p = await predictor();
  return new WatchDriver(p.physics, p.seas, p.weather, p.wakes);
}

const controls = (t: number): [number, number] => [300 + ((t * 37) % 400), 400 + ((t * 11) % 300)];

/**
 * A run of headers as a server sends them: a boat from the start, heading
 * east, stepped with controls that change every tick, its header taken
 * every second tick, with the controls in force.
 */
async function run(from: number, headers: number): Promise<OwnSnapshot[]> {
  const server = await predictor();
  const sn = newSnapshot();
  sn.tick = from;
  sn.state[S.y] = -20;
  sn.state[S.heading] = Math.PI / 2;
  server.reset(sn);
  const out: OwnSnapshot[] = [];
  let [helm, sheet] = controls(from);
  while (out.length < headers) {
    if ((server.tick - from) % 2 === 0) {
      const h = newSnapshot();
      h.tick = server.tick;
      h.helm = helm;
      h.sheet = sheet;
      h.state.set(server.states.current);
      out.push(h);
    }
    [helm, sheet] = controls(server.tick + 1);
    server.stepIndices(helm, sheet);
  }
  return out;
}

describe('the watching driver', () => {
  test('draws the boat between the headers either side of the near band’s render tick', async () => {
    const headers = await run(1000, 12);
    const w = await watcher();
    for (const h of headers) {
      w.receive(h);
    }
    const newest = headers[headers.length - 1] as OwnSnapshot;
    // The near band's delay behind the newest header, and a fraction more.
    const rt = newest.tick - NEAR_DELAY - 0.25;
    const clock = { steps: 0, alpha: 0 };
    w.at(rt, clock);
    expect(clock.steps + clock.alpha).toBe(rt);
    const pose = w.states.blend(clock.alpha, newPose());
    // rt lies between the headers at newest − 6 and newest − 4.
    const a = headers[headers.length - 4] as OwnSnapshot;
    const b = headers[headers.length - 3] as OwnSnapshot;
    expect(a.tick).toBeLessThan(rt);
    expect(b.tick).toBeGreaterThan(rt);
    const f = (rt - a.tick) / (b.tick - a.tick);
    const mix = (i: number) => (a.state[i] ?? 0) + ((b.state[i] ?? 0) - (a.state[i] ?? 0)) * f;
    expect(pose.east).toBeCloseTo(mix(S.x), 9);
    expect(pose.north).toBeCloseTo(mix(S.y), 9);
    expect(pose.boom).toBeCloseTo(mix(S.boom), 9);
    expect(pose.heading).toBeCloseTo(
      lerpAngle(a.state[S.heading] ?? 0, b.state[S.heading] ?? 0, f),
      9,
    );
    // The boat moved between them: the blend is not either.
    expect(Math.abs((b.state[S.x] ?? 0) - (a.state[S.x] ?? 0))).toBeGreaterThan(0);
  });

  test('its Out is the module’s one step from the header at or before the render tick', async () => {
    const headers = await run(2000, 10);
    const w = await watcher();
    for (const h of headers) {
      w.receive(h);
    }
    const a = headers[headers.length - 3] as OwnSnapshot;
    w.at(a.tick + 1.5, { steps: 0, alpha: 0 });
    // The module's one step from a's state with a's controls, as the server takes it.
    const one = await predictor();
    one.reset(a);
    one.stepIndices(a.helm, a.sheet);
    expect(Array.from(w.out)).toEqual(Array.from(one.out));
    expect(w.helm).toBe(a.helm);
    expect(w.sheet).toBe(a.sheet);
    // Never the next header's, a tick short of it.
    const b = headers[headers.length - 2] as OwnSnapshot;
    one.reset(b);
    one.stepIndices(b.helm, b.sheet);
    expect(Array.from(w.out)).not.toEqual(Array.from(one.out));
  });

  test('past the newest header the boat is held there', async () => {
    const headers = await run(3000, 4);
    const w = await watcher();
    for (const h of headers) {
      w.receive(h);
    }
    const newest = headers[headers.length - 1] as OwnSnapshot;
    w.at(newest.tick + 5.5, { steps: 0, alpha: 0 });
    expect(Array.from(w.states.previous)).toEqual(Array.from(newest.state));
    expect(Array.from(w.states.current)).toEqual(Array.from(newest.state));
  });

  test('a header older than the newest is let go; one of the same tick replaces it', async () => {
    const headers = await run(4000, 3);
    const w = await watcher();
    for (const h of headers) {
      w.receive(h);
    }
    w.receive(headers[0] as OwnSnapshot);
    expect(w.newest).toBe(headers[2]?.tick);
    const again = newSnapshot();
    again.tick = headers[2]?.tick ?? 0;
    again.state.set(headers[2]?.state ?? []);
    again.state[S.x] = 77;
    w.receive(again);
    w.at(again.tick, { steps: 0, alpha: 0 });
    expect(w.states.previous[S.x]).toBe(77);
  });

  test('a boat over the lip and back at the start counts a start again', async () => {
    const headers = await run(5000, 3);
    const w = await watcher();
    const [a, b, c] = headers as [OwnSnapshot, OwnSnapshot, OwnSnapshot];
    w.receive(a);
    b.over = b.tick;
    w.receive(b);
    w.at(b.tick, { steps: 0, alpha: 0 });
    expect(w.over).toBe(b.tick);
    w.receive(c);
    w.at(c.tick, { steps: 0, alpha: 0 });
    expect(w.over).toBe(0);
    expect(w.restarts).toBe(1);
  });

  test('forgets its headers for another boat', async () => {
    const w = await watcher();
    for (const h of await run(6000, 3)) {
      w.receive(h);
    }
    w.reset();
    expect(w.started).toBe(false);
    expect(w.newest).toBeNaN();
  });
});

class FakePort implements Port {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  readonly sent: ToWorker[] = [];
  postMessage(m: ToWorker): void {
    this.sent.push(m);
  }
  deliver(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
}

describe('watching online', () => {
  const welcome = (watching: WatchingTold | null, first: boolean): FromWorker => ({
    type: 'welcome',
    boat: 1,
    rejoined: false,
    kind: 0,
    tick: 100,
    epochUs: 0,
    world: 'w',
    land: false,
    circulation: 0,
    tools: false,
    light: null,
    endsUs: 0,
    closingUs: 0,
    zone: '',
    watching,
    first,
  });
  const mary: WatchingTold = { sailor: 'Iron Mary', machine: true, mine: true };
  const record = (sn: OwnSnapshot): ArrayBuffer => {
    const r = new ArrayBuffer(FLEET_RECORD_BYTES);
    writeSnapshot(sn, new DataView(r));
    return r;
  };

  async function online() {
    const p = await predictor();
    const port = new FakePort();
    const helmsman = {
      helm: { target: 0 },
      sheet: { target: 0.5 },
      pilot: new PilotInput(),
      beforeStep: null,
      clock: { steps: 0, alpha: 0 },
    };
    const o = new Online(port, p, helmsman);
    const drivers: string[] = [];
    o.onDriver = (d) => drivers.push(d === p ? 'predictor' : 'watcher');
    const lights: (number[] | 'all')[] = [];
    o.onLights = (_l: LightSeen[], drop) => lights.push(drop);
    return { o, p, port, helmsman, drivers, lights };
  }

  test('the headers are the watched boat’s: drawn by the watching driver, and no controls sent', async () => {
    const { o, p, port, helmsman, drivers } = await online();
    port.deliver(welcome(mary, true));
    expect(o.watching.value).toEqual(mary);
    expect(o.spectating.value).toBe(true);
    expect(drivers).toEqual(['watcher']);
    const headers = await run(100, 8);
    for (const h of headers) {
      port.deliver({ type: 'snapshot', data: record(h) });
    }
    await o.ready;
    expect(p.started).toBe(false);
    o.clock = { have: true, rough: false, offset: 0, target: 0, at: 0, rtt: 0 };
    helmsman.helm.target = 1;
    for (let i = 0; i < 5; i++) {
      o.frame(1 / 60);
    }
    expect(port.sent.filter((m) => m.type === 'input')).toEqual([]);
    // The controls shown are the boat's, as its header has them.
    expect(helmsman.helm.target).not.toBe(1);
    // The world clock is the near band's render tick, the boats about it drawn at.
    expect(helmsman.clock.steps + helmsman.clock.alpha).toBeCloseTo(o.fleet.near.tick, 6);
  });

  test('a later Welcome on the connection keeps what it was handed; a new connection’s does not', async () => {
    const { port, lights } = await online();
    port.deliver(welcome(null, true));
    port.deliver(welcome(mary, false));
    port.deliver(welcome({ ...mary, sailor: 'Ann Bonny', machine: false, mine: false }, false));
    expect(lights).toEqual(['all']);
    port.deliver(welcome(mary, true));
    expect(lights).toEqual(['all', 'all']);
  });

  test('the own boat back after a watch: the notice, and its prediction afresh', async () => {
    const { o, p, port, drivers } = await online();
    port.deliver(welcome(mary, true));
    port.deliver({ type: 'status', status: 'sailing', waitMs: 0, reason: '' });
    for (const h of await run(100, 2)) {
      port.deliver({ type: 'snapshot', data: record(h) });
    }
    port.deliver(welcome(null, false));
    expect(o.notice.value?.text).toBe(BOAT_IN_THE_WATER);
    expect(o.watching.value).toBeNull();
    expect(o.spectating.value).toBe(false);
    expect(drivers).toEqual(['watcher', 'predictor']);
    const own = newSnapshot();
    own.tick = 300;
    port.deliver({ type: 'snapshot', data: record(own) });
    expect(p.started).toBe(true);
    expect(p.tick).toBe(300);
  });

  test('a watch ended leaves the boat held and says why; one refused while sailing, a line', async () => {
    const { o, port } = await online();
    port.deliver(welcome(null, true));
    port.deliver({ type: 'status', status: 'sailing', waitMs: 0, reason: '' });
    port.deliver({ type: 'watchEnded', why: 'quick', sailor: 'Iron Mary' });
    expect(o.notice.value?.text).toBe(endedText('quick', 'Iron Mary'));
    expect(o.spectating.value).toBe(false);
    port.deliver(welcome(mary, false));
    port.deliver({ type: 'watchEnded', why: 'left', sailor: 'Iron Mary' });
    port.deliver({ type: 'status', status: 'idle', waitMs: 0, reason: '' });
    expect(o.watching.value).toBeNull();
    expect(o.ended.value).toEqual({ why: 'left', sailor: 'Iron Mary' });
    expect(o.spectating.value).toBe(true);
  });

  test('the spectators’ queue: its place, and the own boat out of the water', async () => {
    const { o, port, drivers } = await online();
    port.deliver(welcome(null, true));
    port.deliver({ type: 'queued', position: 12, waiting: 40, spectators: true });
    expect(o.watchPlace.value).toEqual({ position: 12, waiting: 40 });
    expect(o.place.value).toBeNull();
    expect(o.spectating.value).toBe(true);
    expect(drivers).toEqual(['watcher']);
    port.deliver(welcome(mary, false));
    expect(o.watchPlace.value).toBeNull();
  });

  test('the running light: for the own machine sailor watched, as told of that watch only', async () => {
    const { o, port } = await online();
    port.deliver(welcome(mary, true));
    expect(o.lamp.value).toBe('');
    port.deliver({ type: 'lamp', state: 'helm' });
    expect(o.lamp.value).toBe('helm');
    port.deliver({ type: 'lamp', state: 'quiet' });
    expect(o.lamp.value).toBe('quiet');
    // A new watch: what was told of the last lights nothing.
    port.deliver(welcome({ ...mary, sailor: 'Iron Kate' }, false));
    expect(o.lamp.value).toBe('');
    port.deliver({ type: 'lamp', state: 'helm' });
    expect(o.lamp.value).toBe('helm');
    // Another's machine sailor, or a human's boat: never, whatever comes.
    port.deliver(welcome({ ...mary, mine: false }, false));
    port.deliver({ type: 'lamp', state: 'helm' });
    expect(o.lamp.value).toBe('');
    port.deliver(welcome({ sailor: 'Ann Bonny', machine: false, mine: false }, false));
    port.deliver({ type: 'lamp', state: 'helm' });
    expect(o.lamp.value).toBe('');
    // The watch ended: out.
    port.deliver(welcome(mary, false));
    port.deliver({ type: 'lamp', state: 'helm' });
    port.deliver({ type: 'watchEnded', why: 'left', sailor: 'Iron Mary' });
    expect(o.lamp.value).toBe('');
    // Sailing: none.
    port.deliver(welcome(null, false));
    port.deliver({ type: 'lamp', state: 'helm' });
    expect(o.lamp.value).toBe('');
  });

  test('watching, sailing and stopping go to the worker', async () => {
    const { o, port } = await online();
    o.watch('Iron Mary');
    o.sail();
    o.unwatch();
    expect(port.sent).toEqual([
      { type: 'watch', sailor: 'Iron Mary' },
      { type: 'sail' },
      { type: 'unwatch' },
    ]);
  });
});

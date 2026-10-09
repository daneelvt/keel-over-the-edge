// SPDX-License-Identifier: AGPL-3.0-only

// The predictor and its pacing, with the physics module under Node: a
// snapshot equal to the prediction changes nothing; one that differs puts
// the boat back and steps exactly the ticks since, with the controls kept;
// the drawn boat eases the difference away over 100 ms, unless it is over
// 3 m or 20°; a snapshot older than the ticks kept is let go. And Online's
// pacing: every step due in one frame, up to 30, the controls
// starting at the indices in force, inputs only when they change, and none
// for a tick an input could no longer reach.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { BEHIND, newClockState } from '../net/clock';
import type { FromWorker, ToWorker } from '../net/messages';
import { Online, type Port } from '../net/online';
import { RELOAD_EVERY, reloadForVersion } from '../net/reload';
import { NO_MARGIN, newSnapshot, type OwnSnapshot, writeSnapshot } from '../net/snapshot';
import { FLEET_RECORD_BYTES } from '../net/view';
import { newPose } from './blend';
import { RECORDS } from './layout.gen';
import { loadPhysics } from './physics';
import { helmOf, Predictor, RING, SMOOTHING, SNAP_DISTANCE } from './predictor';

const wasm = new URL('./physics.wasm', import.meta.url);
const boat = catalog.boats[0].physics;
const S = RECORDS.state;
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

async function predictor(): Promise<Predictor> {
  return new Predictor(await loadPhysics(bytes), boat);
}

/** The server's start: on the grid, heading east, at rest, in 10 knots from the north. */
function start(tick: number): OwnSnapshot {
  const sn = newSnapshot();
  sn.tick = tick;
  sn.helm = 512;
  sn.sheet = 512;
  sn.windSpeed = (10 * 1852) / 3600;
  sn.state[S.y] = -20;
  sn.state[S.heading] = Math.PI / 2;
  return sn;
}

/** The snapshot of the predictor's state at its tick. */
function snapshotOf(p: Predictor): OwnSnapshot {
  const sn = start(p.tick);
  sn.state.set(p.states.current);
  return sn;
}

const controls = (i: number): [number, number] => [256 + ((i * 37) % 512), 300 + ((i * 11) % 400)];

describe('the predictor', () => {
  test('a snapshot equal to the prediction changes nothing', async () => {
    const p = await predictor();
    p.snapshot(start(100));
    expect(p.counts.resets).toBe(1);
    for (let i = 0; i < 10; i++) {
      p.stepIndices(...controls(i));
    }
    // A second predictor stepped alike plays the server.
    const server = await predictor();
    server.reset(start(100));
    for (let i = 0; i < 6; i++) {
      server.stepIndices(...controls(i));
    }
    const o = p.snapshot(snapshotOf(server));
    expect(o).toMatchObject({ corrected: false, reset: false, stale: false });
  });

  test('one that differs replays exactly the ticks since, with the controls kept', async () => {
    const p = await predictor();
    p.snapshot(start(100));
    for (let i = 0; i < 20; i++) {
      p.stepIndices(...controls(i));
    }
    // The server's boat at tick 110 was elsewhere: nudged half a metre.
    const server = await predictor();
    server.reset(start(100));
    for (let i = 0; i < 10; i++) {
      server.stepIndices(...controls(i));
    }
    const sn = snapshotOf(server);
    sn.state[S.x] = (sn.state[S.x] ?? 0) + 0.5;
    // What the replay should reach: the server's tick 110, stepped to 120
    // with the controls predicted.
    const want = await predictor();
    want.reset(sn);
    for (let i = 10; i < 20; i++) {
      want.stepIndices(...controls(i));
    }
    const o = p.snapshot(sn);
    expect(o.corrected).toBe(true);
    expect(p.tick).toBe(120);
    expect(Array.from(p.states.current)).toEqual(Array.from(want.states.current));
    expect(Array.from(p.states.previous)).toEqual(Array.from(want.states.previous));
    expect(o.distance).toBeGreaterThan(0.1);
    expect(o.distance).toBeLessThan(SNAP_DISTANCE);
    // The drawn boat keeps where it was, and eases toward the new place.
    const pose = newPose();
    const offset = p.offset.east;
    expect(Math.abs(offset)).toBeCloseTo(o.distance, 6);
    p.decorate(pose, SMOOTHING);
    expect(p.offset.east).toBeCloseTo(offset * Math.exp(-1), 9);
    p.decorate(pose, 1);
    expect(Math.abs(p.offset.east)).toBeLessThan(1e-4);
  });

  test('a correction over 3 m is drawn at once', async () => {
    const p = await predictor();
    p.snapshot(start(100));
    for (let i = 0; i < 5; i++) {
      p.stepIndices(512, 512);
    }
    const sn = snapshotOf(p);
    sn.tick = 103;
    const server = await predictor();
    server.reset(start(100));
    for (let i = 0; i < 3; i++) {
      server.stepIndices(512, 512);
    }
    sn.state.set(server.states.current);
    sn.state[S.y] = (sn.state[S.y] ?? 0) + 10;
    const o = p.snapshot(sn);
    expect(o.corrected).toBe(true);
    expect(o.distance).toBeGreaterThan(SNAP_DISTANCE);
    expect(p.offset).toEqual({ east: 0, north: 0, heading: 0 });
  });

  test('a snapshot older than the ticks kept is let go; one newer resets', async () => {
    const p = await predictor();
    p.snapshot(start(100));
    for (let i = 0; i < RING + 5; i++) {
      p.stepIndices(512, 512);
    }
    expect(p.snapshot(start(101)).stale).toBe(true);
    expect(p.tick).toBe(100 + RING + 5);
    expect(p.snapshot(start(500)).reset).toBe(true);
    expect(p.tick).toBe(500);
  });
});

/** A port that keeps what the page sends. */
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

describe('pacing online', () => {
  async function online() {
    const p = await predictor();
    const port = new FakePort();
    const helmsman = {
      helm: { target: 0 },
      sheet: { target: 0.5 },
      beforeStep: null,
      clock: { steps: 0, alpha: 0 },
    };
    const o = new Online(port, p, helmsman);
    port.deliver({ type: 'welcome', boat: 1, rejoined: false, kind: 0, tick: 100 });
    const sn = start(100);
    sn.helm = 300;
    sn.sheet = 700;
    o.reconcile(sn, 0);
    // A clock whose world time at local time t is t + 100/30 s, round trip 0.
    o.clock = { ...newClockState(), have: true, offset: 0, target: 0, at: 0 };
    return { o, p, port, helmsman };
  }
  const worldAt = (tick: number) => (tick * 1e6) / 30;

  test('the controls start at the indices in force', async () => {
    const { helmsman } = await online();
    expect(helmsman.helm.target).toBe(helmOf(300));
    expect(helmsman.sheet.target).toBe(700 / 1024);
  });

  test('a frame takes the steps due; inputs only when the controls change', async () => {
    const { o, p, port, helmsman } = await online();
    // m is 2: at world tick 100 the boat should be at 102.
    o.pace(worldAt(100));
    expect(p.tick).toBe(102);
    // A slow frame: ten ticks later, all ten steps at once.
    o.pace(worldAt(110));
    expect(p.tick).toBe(112);
    // The controls held are the server's: nothing sent.
    expect(port.sent.filter((m) => m.type === 'input')).toEqual([]);
    helmsman.helm.target = 0.5;
    o.pace(worldAt(111));
    const inputs = port.sent.filter((m) => m.type === 'input');
    expect(inputs).toEqual([{ type: 'input', seq: 113, helm: 768, sheet: 700 }]);
    // Drawn the fraction of the way the clock is.
    expect(helmsman.clock.steps).toBe(112);
  });

  test('a snapshot ahead of the prediction starts it again; a frame takes 30 steps at most', async () => {
    const { o, p } = await online();
    o.pace(worldAt(100));
    const later = start(200);
    later.margin = NO_MARGIN;
    o.reconcile(later, worldAt(201));
    expect(p.tick).toBe(200);
    o.pace(worldAt(300));
    expect(p.tick).toBe(200 + BEHIND);
  });

  test('a step for a tick an input could not reach with a tick to spare keeps the server’s controls', async () => {
    const { o, p, port, helmsman } = await online();
    o.clock = { ...o.clock, rtt: 200_000 };
    helmsman.helm.target = 1;
    // Half the round trip is three ticks: an input sent at world tick 100
    // reaches tick 103, and one stamped 104 has a tick to spare. The boat,
    // at 100, steps 101 to 103 with what the server holds, then 104 and 105
    // (m is 2) with the player's helm.
    o.pace(worldAt(100));
    expect(p.tick).toBe(105);
    expect(port.sent.filter((m) => m.type === 'input')).toEqual([
      { type: 'input', seq: 104, helm: 1024, sheet: 700 },
    ]);
  });

  test('a late input raises m, once a round trip', async () => {
    const { o } = await online();
    const sn = start(102);
    sn.margin = -3;
    o.reconcile(sn, 1_000);
    expect(o.ahead.m).toBe(6);
    sn.margin = -5;
    o.reconcile(sn, 2_000);
    expect(o.ahead.m).toBe(6);
  });
});

describe('the queue and the fleet online', () => {
  test('the place in the queue is shown until the sea is', async () => {
    const p = await predictor();
    const port = new FakePort();
    const o = new Online(port, p, {
      helm: { target: 0 },
      sheet: { target: 0.5 },
      beforeStep: null,
      clock: { steps: 0, alpha: 0 },
    });
    port.deliver({ type: 'status', status: 'queued', waitMs: 0, reason: '' });
    port.deliver({ type: 'queued', position: 3, waiting: 9 });
    expect(o.place.value).toEqual({ position: 3, waiting: 9 });
    port.deliver({ type: 'queued', position: 1, waiting: 4 });
    expect(o.place.value).toEqual({ position: 1, waiting: 4 });
    port.deliver({ type: 'welcome', boat: 1, rejoined: false, kind: 0, tick: 100 });
    port.deliver({ type: 'status', status: 'sailing', waitMs: 0, reason: '' });
    expect(o.place.value).toBeNull();
  });

  test('each snapshot record is read, its boats given to the fleet, and handed back', async () => {
    const p = await predictor();
    const port = new FakePort();
    const o = new Online(port, p, {
      helm: { target: 0 },
      sheet: { target: 0.5 },
      beforeStep: null,
      clock: { steps: 0, alpha: 0 },
    });
    port.deliver({ type: 'welcome', boat: 1, rejoined: false, kind: 0, tick: 100 });
    const record = new ArrayBuffer(FLEET_RECORD_BYTES);
    writeSnapshot(start(100), new DataView(record));
    port.deliver({ type: 'snapshot', data: record });
    expect(p.started).toBe(true);
    // The record held no other boat.
    o.fleet.update(0, 0);
    expect(o.fleet.count).toBe(0);
    expect(port.sent.filter((m) => m.type === 'return').map((m) => m.type)).toEqual(['return']);
  });
});

describe('the reload after 4002', () => {
  test('once a minute at most', () => {
    const store = new Map<string, string>();
    const marks = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(reloadForVersion(marks, 1_000_000)).toBe(true);
    expect(reloadForVersion(marks, 1_000_000 + RELOAD_EVERY - 1)).toBe(false);
    expect(reloadForVersion(marks, 1_000_000 + RELOAD_EVERY)).toBe(true);
    expect(reloadForVersion(null, Date.now())).toBe(true);
  });
});

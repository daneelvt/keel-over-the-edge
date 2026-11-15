// SPDX-License-Identifier: AGPL-3.0-only

// A page hidden and shown again, with the physics module under Node: shown
// after more than two seconds, it snaps to the newest snapshot (nothing
// left waiting for a frame, the boat watched or predicted from it, the
// other boats' render ticks set from it, the wakes forgotten, the worker
// asked to set the clock at once, the page told to cover it); shown
// sooner, nothing changes. And the own boat far behind with nothing newer
// from the server held where it was, not sailed on alone.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { PilotInput } from '../input/pilot';
import { RECORDS } from '../predict/layout.gen';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { steadySpell } from '../predict/weather';
import { TICKS_PER_SECOND } from './clock';
import type { FromWorker, ToWorker, WatchingTold } from './messages';
import { Online, type Port, SNAP_AFTER } from './online';
import { newSnapshot, writeSnapshot } from './snapshot';
import { CHANGE, FLEET_META, FLEET_RECORD_BYTES, fleetOf, SLOT, slotAt } from './view';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
const S = RECORDS.state;
const TICK_US = 1e6 / TICKS_PER_SECOND;
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
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

const mary: WatchingTold = { sailor: 'Iron Mary', machine: true, mine: true, look: 0 };

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
  harbour: null,
  endsUs: 0,
  closingUs: 0,
  zone: '',
  watching,
  aboard: null,
  look: 0,
  boatLook: 0,
  boatName: '',
  first,
});

/**
 * A snapshot's record of tick, which came at its tick: the boat in view at
 * east metres, heading east, and another boat in view slot 0 beside it.
 */
function record(tick: number, east: number, entered = false): ArrayBuffer {
  const r = new ArrayBuffer(FLEET_RECORD_BYTES);
  const sn = newSnapshot();
  sn.tick = tick;
  sn.state[S.x] = east;
  sn.state[S.y] = -20;
  sn.state[S.heading] = Math.PI / 2;
  writeSnapshot(sn, new DataView(r));
  const f = fleetOf(r);
  f[FLEET_META.tick] = tick;
  f[FLEET_META.received] = tick * TICK_US;
  const o = slotAt(0);
  f[o + SLOT.present] = 1;
  f[o + SLOT.change] = entered ? CHANGE.entered : CHANGE.none;
  f[o + SLOT.sampled] = 1;
  f[o + SLOT.x] = east;
  f[o + SLOT.y] = 0;
  return r;
}

async function online() {
  const p = new Predictor(
    await loadPhysics(bytes),
    catalog.boats[0].physics,
    catalog.weather,
    catalog.world,
  );
  p.weather.set([steadySpell(p.physics, 6, 0, 0)]);
  const port = new FakePort();
  const helmsman = {
    helm: { target: 0 },
    sheet: { target: 0.5 },
    pilot: new PilotInput(),
    beforeStep: null,
    clock: { steps: 0, alpha: 0 },
  };
  const o = new Online(port, p, helmsman);
  let snaps = 0;
  o.onSnap = () => snaps++;
  let wakes = 0;
  const reset = p.wakes.reset.bind(p.wakes);
  p.wakes.reset = () => {
    wakes++;
    reset();
  };
  // World time is real time, from the world's tick 0.
  o.clock = { have: true, rough: false, offset: 0, target: 0, at: 0, rtt: 0 };
  return {
    o,
    p,
    port,
    helmsman,
    snaps: () => snaps,
    wakes: () => wakes,
    returned: () => port.sent.filter((m) => m.type === 'return').length,
  };
}

/** Watching, a second of the boat's snapshots taken, at world time now's tick. */
async function watching(now: number) {
  const t = await online();
  t.port.deliver(welcome(mary, true));
  t.port.deliver({ type: 'status', status: 'sailing', waitMs: 0, reason: '' });
  const tick = Math.floor(now / TICK_US);
  for (let k = 15; k >= 0; k--) {
    t.port.deliver({ type: 'snapshot', data: record(tick - 2 * k, 100 - k, k === 15) });
    t.o.frame(1 / 60);
  }
  return { ...t, tick };
}

describe('a page shown again', () => {
  test('after more than two seconds hidden, watching: the snap, from the newest snapshot', async () => {
    const now = Date.now() * 1000;
    const t = await watching(now);
    const { o, port } = t;
    expect(o.fleet.near.tick).not.toBeNaN();
    expect(o.newest()?.tick).toBe(t.tick);
    o.shown(false, now);
    expect(port.sent.at(-1)).toEqual({ type: 'hidden', on: true });
    // Two snapshots came before the worker heard: waiting for a frame.
    port.deliver({ type: 'snapshot', data: record(t.tick + 2, 101) });
    port.deliver({ type: 'snapshot', data: record(t.tick + 4, 102) });
    expect(o.mostQueued).toBe(2);
    const wakes = t.wakes();
    const returned = t.returned();
    expect(o.shown(true, now + SNAP_AFTER + 1)).toBe(true);
    // Nothing left waiting for a frame: both handed back.
    expect(t.returned()).toBe(returned + 2);
    expect(port.sent.at(-1)).toEqual({ type: 'hidden', on: false, settle: true });
    expect(t.snaps()).toBe(1);
    expect(t.wakes()).toBe(wakes + 1);
    // The boat watched and the boats about it start again from the next.
    expect(o.newest()).toBeNull();
    expect(o.fleet.near.tick).toBeNaN();
    expect(o.snapped.value).toBe(0);
    // The newest snapshot, handed over: taken at once, the boat drawn by it.
    const tick = t.tick + 2 * 15 * 120;
    port.deliver({ type: 'snapshot', data: record(tick, 2000) });
    expect(o.snapped.value).toBe(1);
    expect(o.newest()).toEqual({ tick, east: 2000, north: -20 });
    o.frame(1 / 60);
    expect(o.fleet.count).toBe(1);
    expect(o.fleet.drawn[0]?.east).toBe(2000);
    expect(o.fleet.drawn[0]?.speed).toBe(0);
  });

  test('within two seconds: nothing changes', async () => {
    const now = Date.now() * 1000;
    const t = await watching(now);
    const { o, port } = t;
    o.shown(false, now);
    port.deliver({ type: 'snapshot', data: record(t.tick + 2, 101) });
    const returned = t.returned();
    const near = o.fleet.near.tick;
    expect(o.shown(true, now + SNAP_AFTER - 1)).toBe(false);
    expect(port.sent.at(-1)).toEqual({ type: 'hidden', on: false, settle: false });
    expect(t.returned()).toBe(returned);
    expect(t.snaps()).toBe(0);
    expect(o.fleet.near.tick).toBe(near);
    expect(o.newest()?.tick).toBe(t.tick);
    // The snapshot waiting is taken with the next frame, as any other.
    o.frame(1 / 60);
    expect(o.newest()?.tick).toBe(t.tick + 2);
  });

  test('sailing: the prediction starts again from the newest snapshot', async () => {
    const t = await online();
    const { o, p, port } = t;
    port.deliver(welcome(null, true));
    port.deliver({ type: 'snapshot', data: record(300, 10) });
    expect(p.started).toBe(true);
    o.shown(false, 0);
    o.shown(true, 10_000_000);
    expect(p.started).toBe(false);
    port.deliver({ type: 'snapshot', data: record(600, 50) });
    expect(p.started).toBe(true);
    expect(p.tick).toBe(600);
    expect(o.snapped.value).toBe(1);
  });

  test('a connection made again snaps too; a later Welcome on the same one does not', async () => {
    const t = await online();
    t.port.deliver(welcome(null, true));
    t.port.deliver(welcome(mary, false));
    expect(t.snaps()).toBe(0);
    t.port.deliver(welcome(mary, true));
    expect(t.snaps()).toBe(1);
    t.port.deliver({ type: 'snapshot', data: record(900, 10) });
    expect(t.o.snapped.value).toBe(1);
  });
});

describe('the own boat far behind', () => {
  test('with nothing newer from the server: held where it was, not sailed on alone', async () => {
    const t = await online();
    const { o, p, port, helmsman } = t;
    port.deliver(welcome(null, true));
    port.deliver({ type: 'snapshot', data: record(300, 10) });
    const at = 300 * TICK_US;
    o.pace(at);
    const tick = p.tick;
    expect(tick).toBeGreaterThan(300);
    // Five seconds on and no snapshot: held, the world clock with it.
    for (let i = 1; i <= 3; i++) {
      o.pace(at + 5_000_000 + i * 16_000);
      expect(p.tick).toBe(tick);
      expect(helmsman.clock.steps + helmsman.clock.alpha).toBeCloseTo(tick, 6);
    }
    // A newer one: from it, at once.
    const sn = newSnapshot();
    sn.tick = 450;
    sn.state[S.x] = 40;
    o.reconcile(sn, at + 5_000_000);
    o.pace(at + 5_100_000);
    expect(p.tick).toBeGreaterThanOrEqual(450);
    expect(p.tick).toBeLessThan(460);
  });
});

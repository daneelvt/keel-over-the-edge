// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { PilotInput } from '../input/pilot';
import { RECORDS } from '../predict/layout.gen';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { steadySpell } from '../predict/weather';
import { LIFTED_SOON } from '../ui/homewords';
import type { FromWorker, ToWorker } from './messages';
import { Online, type Port } from './online';
import { newSnapshot, writeSnapshot } from './snapshot';
import { FLEET_RECORD_BYTES } from './view';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
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

const welcome: FromWorker = {
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
  watching: null,
  aboard: null,
  look: 0,
  boatLook: 0,
  boatName: '',
  first: true,
};

/** The own boat's snapshot of tick, east of the centre by x. */
function snapshot(tick: number, x: number): FromWorker {
  const sn = newSnapshot();
  sn.tick = tick;
  sn.state[RECORDS.state.x] = x;
  const r = new ArrayBuffer(FLEET_RECORD_BYTES);
  writeSnapshot(sn, new DataView(r));
  return { type: 'snapshot', data: r };
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
  o.clock = { have: true, rough: false, offset: 0, target: 0, at: 0, rtt: 0 };
  let covered = 0;
  o.onLift = () => covered++;
  return { o, p, port, covered: () => covered };
}

describe('the way home on the game connection', () => {
  test('asked of the worker; asked again too soon, said so and counted refused', async () => {
    const { o, port, covered } = await online();
    port.deliver(welcome);
    o.home();
    expect(port.sent.at(-1)).toEqual({ type: 'home' });
    port.deliver({ type: 'lifted', tick: 0, soon: true });
    expect(o.unlifted.value).toBe(1);
    expect(o.lifted.value).toBe(0);
    expect(o.notice.value?.text).toBe(LIFTED_SOON);
    expect(covered()).toBe(0);
  });

  test('lifted: counted in at its first snapshot, the boat predicted afresh from there', async () => {
    const { o, p, port, covered } = await online();
    port.deliver(welcome);
    port.deliver(snapshot(100, 900));
    expect(p.started).toBe(true);
    o.home();
    port.deliver({ type: 'lifted', tick: 104, soon: false });
    // Asked for here: the page covered its screen itself.
    expect(covered()).toBe(0);
    port.deliver(snapshot(102, 902));
    o.frame(1 / 60);
    expect(o.lifted.value).toBe(0);
    const resets = p.counts.resets;
    port.deliver(snapshot(104, 10));
    o.frame(1 / 60);
    expect(o.lifted.value).toBe(1);
    expect(p.counts.resets).toBe(resets + 1);
    expect(Math.abs((p.states.current[RECORDS.state.x] ?? 0) - 10)).toBeLessThan(5);
  });

  test('aboard, a lift the skipper asked for: the page told to cover its screen; one whose snapshot came first, counted at once', async () => {
    const { o, port, covered } = await online();
    port.deliver(welcome);
    port.deliver(snapshot(100, 900));
    port.deliver(snapshot(106, 10));
    o.frame(1 / 60);
    port.deliver({ type: 'lifted', tick: 106, soon: false });
    expect(covered()).toBe(1);
    expect(o.lifted.value).toBe(1);
  });
});

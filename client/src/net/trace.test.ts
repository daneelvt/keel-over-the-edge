// SPDX-License-Identifier: AGPL-3.0-only

// The Go client's sails, recorded by internal/edge/edgetest, replayed
// through this client's own code: every message it sent the net worker's
// session sends, at the same times; every snapshot's other boats decode to
// the view the Go client decoded; and every snapshot the predictor
// reconciles as the Go client did, tick for tick: none corrected without
// loss, the same ones at 200 ms and 2% loss. The fleet's traces are three
// sailors sailing together among other boats.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import fleet from '../../../shared/protocol/testdata/trace-fleet.json';
import lossy from '../../../shared/protocol/testdata/trace-lossy.json';
import none from '../../../shared/protocol/testdata/trace-none.json';
import { catalog } from '../catalog';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { Session } from '../workers/net/session';
import { newSnapshot, type OwnSnapshot, readSnapshot } from './snapshot';
import { Q, VIEW_SLOTS, VIEW_STRIDE, type View } from './view';

interface TraceEvent {
  t: number;
  in?: string;
  view?: string;
  dropped?: boolean;
  out?: string;
  timer?: boolean;
  reset?: boolean;
  step?: number[];
  input?: number[];
  snap?: { tick: number; stale?: boolean; reset?: boolean; corrected?: boolean; distance?: number };
}

interface Trace {
  lag: string;
  events: TraceEvent[];
}

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

function bytesOf(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const versions = { catalog: '', physicsLayout: 0, build: 'edgetest' };

/**
 * internal/client's ViewDigest: a 32-bit FNV-1a hash of each held slot's
 * number and fields, as little-endian int32s.
 */
function viewDigest(v: View): string {
  let h = 0x811c9dc5;
  const put = (x: number) => {
    for (let k = 0; k < 4; k++) {
      h = Math.imul(h ^ ((x >>> (8 * k)) & 0xff), 0x01000193) >>> 0;
    }
  };
  for (let slot = 0; slot < VIEW_SLOTS; slot++) {
    if (v.used[slot] !== 1) {
      continue;
    }
    put(slot);
    for (const f of [
      Q.kind,
      Q.flags,
      Q.x,
      Q.y,
      Q.heading,
      Q.heel,
      Q.boom,
      Q.rudder,
      Q.sailor,
      Q.sail,
    ]) {
      put(v.q[slot * VIEW_STRIDE + f] ?? 0);
    }
  }
  return h.toString(16).padStart(8, '0');
}

async function replay(
  trace: Trace,
): Promise<{ corrections: number; snapshots: number; others: number }> {
  const predictor = new Predictor(await loadPhysics(bytes), catalog.boats[0].physics);
  const session = new Session(versions);
  session.frameMs = 17;
  const snapshots = new Map<number, OwnSnapshot>();
  let latest: OwnSnapshot | null = null;
  const expected: string[] = [];
  let corrections = 0;
  let reconciled = 0;
  let others = 0;
  trace.events.forEach((e, i) => {
    const where = `event ${i} at ${e.t}`;
    if (e.out !== undefined) {
      if (i === 0) {
        // The Hello, which carries the Go build's versions.
        session.open(e.t);
        expect(e.out.slice(0, 4), where).toBe('010a');
        return;
      }
      expect(expected.shift(), where).toBe(e.out);
    } else if (e.in !== undefined) {
      const b = bytesOf(e.in);
      const r = session.receive(e.t, b);
      expect(r.kind === 'dropped', where).toBe(e.dropped ?? false);
      if (r.kind === 'dropped') {
        expected.push(...r.out.map(hexOf));
      }
      if (r.kind === 'snapshot') {
        const sn = newSnapshot();
        expect(readSnapshot(new DataView(b.buffer), sn), where).toBeNull();
        snapshots.set(sn.tick, sn);
        expect(viewDigest(r.view), `${where}: the view of snapshot ${sn.tick}`).toBe(e.view);
        others += r.view.length;
      }
    } else if (e.timer) {
      const { out, dead } = session.time(e.t);
      expect(dead, where).toBe(false);
      expected.push(...out.map(hexOf));
    } else if (e.input !== undefined) {
      const [seq = 0, helm = 0, sheet = 0] = e.input;
      expected.push(hexOf(session.input(e.t, seq, helm, sheet)));
    } else if (e.step !== undefined) {
      const [tick = 0, helm = 0, sheet = 0] = e.step;
      predictor.stepIndices(helm, sheet);
      expect(predictor.tick, where).toBe(tick);
    } else if (e.snap !== undefined) {
      const sn = snapshots.get(e.snap.tick);
      if (sn === undefined) {
        throw new Error(`${where}: no snapshot of tick ${e.snap.tick}`);
      }
      const o = predictor.snapshot(sn);
      expect(
        { stale: o.stale, reset: o.reset, corrected: o.corrected },
        `${where}: snapshot ${e.snap.tick}`,
      ).toEqual({
        stale: e.snap.stale ?? false,
        reset: e.snap.reset ?? false,
        corrected: e.snap.corrected ?? false,
      });
      expect(o.distance).toBeCloseTo(e.snap.distance ?? 0, 9);
      if (o.corrected) {
        corrections++;
      }
      reconciled++;
      latest = sn;
    } else if (e.reset && latest !== null) {
      predictor.reset(latest);
    }
  });
  expect(expected).toEqual([]);
  return { corrections, snapshots: reconciled, others };
}

describe('the Go client’s traces', () => {
  test('without lag: the same messages, and no correction at all', async () => {
    const r = await replay(none as Trace);
    expect(r.snapshots).toBeGreaterThan(250);
    expect(r.corrections).toBe(0);
  });

  test('at 200 ms and 2% loss: the same messages, the same corrections', async () => {
    const r = await replay(lossy as Trace);
    expect(r.corrections).toBeGreaterThan(0);
  });

  test('three sailing together at 200 ms and 2% loss: each view as Go decoded it', async () => {
    expect(fleet.length).toBe(3);
    for (const trace of fleet as Trace[]) {
      const r = await replay(trace);
      expect(r.snapshots).toBeGreaterThan(100);
      expect(r.others / r.snapshots).toBeGreaterThan(2);
    }
  });
});

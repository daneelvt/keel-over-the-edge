// SPDX-License-Identifier: AGPL-3.0-only

// The Go test client's sails, recorded by internal/edge/edgetest, replayed
// through this client's own code: every message it sent the net worker's
// session sends, at the same times, and every snapshot the predictor
// reconciles as the Go client did, tick for tick: none corrected without
// loss, the same ones at 200 ms and 2% loss.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import lossy from '../../../shared/protocol/testdata/trace-lossy.json';
import none from '../../../shared/protocol/testdata/trace-none.json';
import { catalog } from '../catalog';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { Session } from '../workers/net/session';
import { newSnapshot, type OwnSnapshot, readSnapshot } from './snapshot';

interface TraceEvent {
  t: number;
  in?: string;
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

async function replay(trace: Trace): Promise<{ corrections: number; snapshots: number }> {
  const predictor = new Predictor(await loadPhysics(bytes), catalog.boats[0].physics);
  const session = new Session(versions);
  session.frameMs = 17;
  const snapshots = new Map<number, OwnSnapshot>();
  let latest: OwnSnapshot | null = null;
  const expected: string[] = [];
  let corrections = 0;
  let reconciled = 0;
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
      if (r.kind === 'snapshot') {
        const sn = newSnapshot();
        expect(readSnapshot(new DataView(b.buffer), sn), where).toBeNull();
        snapshots.set(sn.tick, sn);
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
  return { corrections, snapshots: reconciled };
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
});

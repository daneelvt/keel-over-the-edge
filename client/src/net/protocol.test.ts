// SPDX-License-Identifier: AGPL-3.0-only

// The wire format against the vectors the Go tests write: every golden
// snapshot's header reads to its fields and writes back to its bytes, its
// entries decode against its base to the view Go made, every stream of
// the corpus is refused or read as Go reads it, and every message Go
// encoded decodes, and encodes again, to the same bytes.

import { describe, expect, it } from 'vitest';
import corpus from '../../../shared/protocol/testdata/entries.json';
import messages from '../../../shared/protocol/testdata/messages.json';
import snapshots from '../../../shared/protocol/testdata/snapshots.json';
import { RECORDS } from '../predict/layout.gen';
import { decodeClient, decodeServer, encodeClient, encodeServer } from './frame';
import {
  HEADER_SIZE,
  KIND_MESSAGE,
  NO_MARGIN,
  newSnapshot,
  readSnapshot,
  snapshotTick,
  writeSnapshot,
} from './snapshot';
import {
  applyEntries,
  CHANGE,
  FLEET_META,
  FLEET_RECORD_BYTES,
  fleetOf,
  HEADING_STEP,
  Q,
  SLOT,
  slotAt,
  VIEW_SLOTS,
  VIEW_STRIDE,
  View,
  ViewRing,
  writeRecord,
} from './view';

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bits(v: number): string {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v);
  return `0x${d.getBigUint64(0).toString(16).padStart(16, '0')}`;
}

interface GoldenBoat {
  slot: number;
  kind: number;
  flags: number;
  x: number;
  y: number;
  heading: number;
  heel: number;
  boom: number;
  rudder: number;
  sailor: number;
  sail: number;
}

/** A view's boats as the golden vectors list them. */
function boatsOf(v: View): GoldenBoat[] {
  const out: GoldenBoat[] = [];
  for (let slot = 0; slot < VIEW_SLOTS; slot++) {
    if (v.used[slot] !== 1) {
      continue;
    }
    const at = (f: number): number => v.q[slot * VIEW_STRIDE + f] ?? 0;
    out.push({
      slot,
      kind: at(Q.kind),
      flags: at(Q.flags),
      x: at(Q.x),
      y: at(Q.y),
      heading: at(Q.heading),
      heel: at(Q.heel),
      boom: at(Q.boom),
      rudder: at(Q.rudder),
      sailor: at(Q.sailor),
      sail: at(Q.sail),
    });
  }
  return out;
}

function slotsWhere(a: Uint8Array, value: number): number[] {
  const out: number[] = [];
  a.forEach((v, i) => {
    if (v === value) {
      out.push(i);
    }
  });
  return out;
}

describe('the snapshot', () => {
  it('reads and writes every golden header as Go does', () => {
    expect(snapshots.length).toBeGreaterThan(0);
    for (const g of snapshots) {
      const b = bytes(g.bytes);
      const s = newSnapshot();
      expect(readSnapshot(new DataView(b.buffer), s), g.name).toBeNull();
      expect(s.tick, g.name).toBe(Number(g.tick));
      expect(snapshotTick(new DataView(b.buffer)), g.name).toBe(Number(g.tick));
      expect([s.base, s.flags, s.seq, s.margin, s.helm, s.sheet], g.name).toEqual([
        g.base,
        g.flags,
        g.seq,
        g.margin,
        g.helm,
        g.sheet,
      ]);
      expect([bits(s.windSpeed), bits(s.windFrom)], g.name).toEqual(g.wind);
      for (const [name, i] of Object.entries(RECORDS.state)) {
        expect(bits(s.state[i] ?? 0), `${g.name}: ${name}`).toBe(
          (g.state as Record<string, string>)[name],
        );
      }
      const out = new Uint8Array(HEADER_SIZE);
      writeSnapshot(s, new DataView(out.buffer));
      expect(hex(out), g.name).toBe(g.bytes.slice(0, 2 * HEADER_SIZE));
    }
  });

  it('decodes each golden snapshot against its base to the view Go made', () => {
    const ring = new ViewRing();
    for (const g of snapshots) {
      const b = bytes(g.bytes);
      const s = newSnapshot();
      expect(readSnapshot(new DataView(b.buffer), s)).toBeNull();
      const v = ring.decode(new DataView(b.buffer), s);
      if (!(v instanceof View)) {
        throw new Error(`${g.name}: ${v}`);
      }
      expect(boatsOf(v), g.name).toEqual(g.view);
      expect(slotsWhere(ring.changes, CHANGE.entered), g.name).toEqual(g.entered);
      expect(slotsWhere(ring.changes, CHANGE.updated), g.name).toEqual(g.updated);
      expect(slotsWhere(ring.changes, CHANGE.left), g.name).toEqual(g.left);
      expect(slotsWhere(ring.sampled, 1), g.name).toEqual(g.sampled);
    }
  });

  it('drops a snapshot whose base it no longer holds', () => {
    const ring = new ViewRing();
    const s = newSnapshot();
    const delta = snapshots.find((g) => g.base !== 0);
    const b = bytes(delta?.bytes ?? '');
    readSnapshot(new DataView(b.buffer), s);
    expect(ring.decode(new DataView(b.buffer), s)).toBe('missing');
  });

  it('agrees with Go on every stream of the corpus, refusal for refusal', () => {
    const bases = new Map<string, View>([['', new View()]]);
    const ring = new ViewRing();
    for (const g of snapshots) {
      const b = bytes(g.bytes);
      const s = newSnapshot();
      readSnapshot(new DataView(b.buffer), s);
      const v = ring.decode(new DataView(b.buffer), s);
      const keep = new View();
      keep.copyFrom(v as View);
      bases.set(g.name, keep);
    }
    const changes = new Uint8Array(VIEW_SLOTS);
    let accepted = 0;
    corpus.forEach((c, i) => {
      const v = new View();
      v.copyFrom(bases.get(c.base) as View);
      const b = bytes(c.bytes);
      const err = applyEntries(new DataView(b.buffer), 0, c.n, v, changes);
      expect(err === null, `case ${i}: ${err}`).toBe(c.ok);
      if (c.ok) {
        accepted++;
        expect(boatsOf(v), `case ${i}`).toEqual(c.view ?? []);
        expect(Array.from(changes).join(''), `case ${i}`).toBe(c.changes);
      }
    });
    expect(accepted).toBeGreaterThan(20);
  });

  it('refuses what is not a snapshot it can read', () => {
    const good = bytes(snapshots[1]?.bytes ?? '');
    const s = newSnapshot();
    const refused = (b: Uint8Array<ArrayBuffer>) => readSnapshot(new DataView(b.buffer), s);
    expect(refused(good)).toBeNull();
    expect(refused(new Uint8Array(0))).not.toBeNull();
    expect(refused(good.slice(0, HEADER_SIZE - 1))).not.toBeNull();
    const kind = good.slice();
    kind[0] = KIND_MESSAGE;
    expect(refused(kind)).not.toBeNull();
    const layout = good.slice();
    layout[1] = 1;
    expect(refused(layout)).not.toBeNull();
    const helm = good.slice();
    helm[19] = 0x01;
    helm[20] = 0x04;
    expect(refused(helm)).not.toBeNull();
    const flags = good.slice();
    flags[12] = 2;
    expect(refused(flags)).not.toBeNull();
    const entries = good.slice();
    entries[159] = 129;
    expect(refused(entries)).not.toBeNull();
  });

  it('writes a record of the view in metres and radians for the page', () => {
    const ring = new ViewRing();
    const g = snapshots[0];
    const b = bytes(g?.bytes ?? '');
    const s = newSnapshot();
    readSnapshot(new DataView(b.buffer), s);
    const v = ring.decode(new DataView(b.buffer), s) as View;
    const record = new ArrayBuffer(FLEET_RECORD_BYTES);
    writeRecord(record, b, v, ring.changes, ring.sampled, s.flags, 1234);
    const f = fleetOf(record);
    expect(f[FLEET_META.tick]).toBe(s.tick);
    expect(f[FLEET_META.received]).toBe(1234);
    expect(f[FLEET_META.boats]).toBe(g?.view.length);
    const one = slotAt(1);
    expect(f[one + SLOT.present]).toBe(1);
    expect(f[one + SLOT.change]).toBe(CHANGE.entered);
    expect(f[one + SLOT.x]).toBeCloseTo(12.34, 10);
    expect(f[one + SLOT.y]).toBeCloseTo(-56.78, 10);
    expect(f[one + SLOT.heading]).toBeCloseTo(Math.PI / 2, 10);
    expect(f[one + SLOT.sailor]).toBeCloseTo(0.95, 10);
    const two = slotAt(2);
    expect([f[two + SLOT.far], f[two + SLOT.mode], f[two + SLOT.kind]]).toEqual([1, 1, 300]);
    expect(f[two + SLOT.heading]).toBeCloseTo(-HEADING_STEP, 12);
    expect(f[two + SLOT.heel]).toBeCloseTo(-Math.PI, 12);
    expect(f[slotAt(3) + SLOT.present]).toBe(0);
    // The own boat reads from the record as from the snapshot.
    const own = newSnapshot();
    expect(readSnapshot(new DataView(record), own)).toBeNull();
    expect(own.tick).toBe(s.tick);
  });

  it('starts with no margin', () => {
    expect(newSnapshot().margin).toBe(NO_MARGIN);
  });
});

describe('the envelopes', () => {
  // The messages internal/protocol's test encodes, in its order.
  const clients = [
    {
      body: {
        case: 'hello',
        value: {
          protocol: '0275db3b9388b186',
          catalog: '0123456789abcdef',
          physicsLayout: 0x2457976f,
          build: 'dev',
        },
      },
    },
    {
      body: {
        case: 'input',
        value: { seq: 727706170, helm: 1024, sheet: 3, ackTick: 727706164n },
      },
    },
    { body: { case: 'input', value: { ackTick: 1n << 40n, ackOnly: true } } },
    {
      body: {
        case: 'ping',
        value: { clientTimeUs: 123456789n, ackTick: 42n, rttMs: 200, frameMs: 17 },
      },
    },
    { body: { case: 'command', value: { body: { case: 'resync', value: {} } } } },
  ] as const;
  const servers = [
    {
      body: {
        case: 'welcome',
        value: {
          world: '0199c2a4-5f7e-7c3a-9d0e-123456789abc',
          tick: 727706164n,
          worldTimeUs: 24256872133333n,
          boat: 7n,
          kind: 0,
          rejoined: true,
        },
      },
    },
    { body: { case: 'pong', value: { clientTimeUs: 123456789n, worldTimeUs: 24256872133333n } } },
    { body: { case: 'queued', value: { position: 12, waiting: 40 } } },
  ] as const;

  it('encodes each message to the bytes Go encodes, and decodes them', () => {
    const fromClient = messages.filter((m) => m.from === 'client');
    const fromServer = messages.filter((m) => m.from === 'server');
    expect(fromClient.length).toBe(clients.length);
    expect(fromServer.length).toBe(servers.length);
    clients.forEach((m, i) => {
      const want = fromClient[i]?.bytes ?? '';
      expect(hex(encodeClient(m)), m.body.case).toBe(want);
      const back = decodeClient(bytes(want));
      expect(back.body.case).toBe(m.body.case);
      expect(hex(encodeClient(back))).toBe(want);
    });
    servers.forEach((m, i) => {
      const want = fromServer[i]?.bytes ?? '';
      expect(hex(encodeServer(m)), m.body.case).toBe(want);
      const back = decodeServer(bytes(want));
      expect(back.body.case).toBe(m.body.case);
      expect(back.body.value).toMatchObject(m.body.value);
    });
  });

  it('refuses another kind, and an empty body', () => {
    const pong = encodeServer(servers[1]);
    expect(() => decodeServer(new Uint8Array([2, ...pong.subarray(1)]))).toThrow();
    expect(() => decodeServer(new Uint8Array([KIND_MESSAGE]))).toThrow();
    expect(() => decodeServer(new Uint8Array(0))).toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// The wire format against the vectors the Go tests write: every golden
// snapshot reads to its fields and writes back to its bytes, and every
// message Go encoded decodes, and encodes again, to the same bytes.

import { describe, expect, it } from 'vitest';
import messages from '../../../shared/protocol/testdata/messages.json';
import snapshots from '../../../shared/protocol/testdata/snapshots.json';
import { RECORDS } from '../predict/layout.gen';
import { decodeClient, decodeServer, encodeClient, encodeServer } from './frame';
import {
  KIND_MESSAGE,
  NO_MARGIN,
  newSnapshot,
  readSnapshot,
  SNAPSHOT_SIZE,
  writeSnapshot,
} from './snapshot';

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

describe('the own-boat snapshot', () => {
  it('reads and writes every golden vector as Go does', () => {
    expect(snapshots.length).toBeGreaterThan(0);
    for (const g of snapshots) {
      const b = bytes(g.bytes);
      expect(b.length).toBe(SNAPSHOT_SIZE);
      const s = newSnapshot();
      expect(readSnapshot(new DataView(b.buffer), s), g.name).toBeNull();
      expect(s.tick, g.name).toBe(Number(g.tick));
      expect([s.seq, s.margin, s.helm, s.sheet], g.name).toEqual([
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
      const out = new Uint8Array(SNAPSHOT_SIZE);
      writeSnapshot(s, new DataView(out.buffer));
      expect(hex(out), g.name).toBe(g.bytes);
    }
  });

  it('refuses what is not a snapshot it can read', () => {
    const good = bytes(snapshots[1]?.bytes ?? '');
    const s = newSnapshot();
    const refused = (b: Uint8Array<ArrayBuffer>) => readSnapshot(new DataView(b.buffer), s);
    expect(refused(good)).toBeNull();
    expect(refused(new Uint8Array(0))).not.toBeNull();
    expect(refused(good.slice(0, SNAPSHOT_SIZE - 1))).not.toBeNull();
    const kind = good.slice();
    kind[0] = KIND_MESSAGE;
    expect(refused(kind)).not.toBeNull();
    const layout = good.slice();
    layout[1] = 2;
    expect(refused(layout)).not.toBeNull();
    const helm = good.slice();
    helm[16] = 0x01;
    helm[17] = 0x04;
    expect(refused(helm)).not.toBeNull();
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

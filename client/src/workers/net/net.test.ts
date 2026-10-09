// SPDX-License-Identifier: AGPL-3.0-only

// The net worker with a fake socket and fake timers: the clock's estimate
// and its slew; the Pings' schedule and the empty Inputs; a connection
// gone quiet; what each close code leads to; the session check after a
// failed upgrade; and the waits a wake cuts short.

import { describe, expect, test } from 'vitest';
import { applied, Clock, SET_BEYOND } from '../../net/clock';
import { decodeClient, encodeServer } from '../../net/frame';
import type { FromWorker } from '../../net/messages';
import { HEADER_SIZE, newSnapshot, writeSnapshot } from '../../net/snapshot';
import { FLEET_META, FLEET_RECORD_BYTES, fleetOf } from '../../net/view';
import { NetWorker, type Socket } from './net';
import { afterClose, backoff, WAIT_CAP } from './policy';
import { ACK_AFTER, BURST_EVERY, PING_EVERY, PONG_TIMEOUT, Session } from './session';

const versions = { catalog: 'c', physicsLayout: 1, build: 'test' };

describe('the clock', () => {
  test('the estimate is the median offset of the lowest round trips', () => {
    const c = new Clock();
    // Ten samples: the eight fastest have offsets 100…107 µs; two slow ones lie.
    const rtts = [10_000, 10_100, 10_200, 10_300, 10_400, 10_500, 10_600, 10_700, 90_000, 95_000];
    let now = 1_000_000;
    rtts.forEach((rtt, i) => {
      const offset = i < 8 ? 100 + i : 50_000;
      now += 100_000;
      c.sample(now - rtt, now + offset - rtt / 2, now);
    });
    expect(c.state.target).toBe(103.5);
    expect(c.state.rtt).toBe(10_350);
  });

  test('it moves at most 1 ms per 100 ms, and is set at once past 250 ms', () => {
    const c = new Clock();
    c.sample(0, 1_000, 0); // offset 1000, rtt 0: the first sets the clock
    expect(c.state.offset).toBe(1_000);
    for (let i = 1; i <= 8; i++) {
      c.sample(i * 100_000, i * 100_000 + 50_000, i * 100_000); // offset 50 ms
    }
    // The median of the eight best: offset 50 ms, wanted; the clock moves toward it.
    expect(c.state.target).toBe(50_000);
    const at = c.state.at;
    expect(c.worldUs(at + 100_000) - (at + 100_000)).toBeCloseTo(c.state.offset + 1_000, 6);
    // Far off, as after a page hidden for a while: set at once.
    const far = { have: true, rough: false, offset: 0, target: SET_BEYOND + 1, at: 0, rtt: 0 };
    expect(applied(far, 1)).toBe(SET_BEYOND + 1);
    expect(applied({ ...far, target: SET_BEYOND }, 100_000)).toBe(1_000);
  });

  test('a Welcome sets it roughly; the first Pong sets it at once', () => {
    const c = new Clock();
    c.welcome(5_000_000, 1_000_000);
    expect(c.state.rough).toBe(true);
    c.sample(1_000_000, 5_150_000, 1_200_000); // rtt 200 ms: offset 4.05 s
    expect(c.state.rough).toBe(false);
    expect(c.state.offset).toBe(4_050_000);
  });
});

describe('the session', () => {
  function welcomed(): Session {
    const s = new Session(versions);
    s.open(0);
    s.receive(
      0,
      encodeServer({
        body: { case: 'welcome', value: { tick: 10n, worldTimeUs: 1_000_000n, boat: 1n } },
      }),
    );
    return s;
  }

  test('8 Pings 100 ms apart after the Welcome, then one every 2 s', () => {
    const s = welcomed();
    const pings: number[] = [];
    let now = 0;
    for (let i = 0; i < 400; i++) {
      now = s.deadline();
      if (now > 10_000_000) {
        break;
      }
      for (const b of s.time(now).out) {
        if (decodeClient(b).body.case === 'ping') {
          pings.push(now);
        }
      }
      // Keep the connection from going quiet.
      s.receive(
        now,
        encodeServer({
          body: { case: 'pong', value: { clientTimeUs: BigInt(now), worldTimeUs: 0n } },
        }),
      );
    }
    expect(pings.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * BURST_EVERY));
    expect((pings[8] ?? 0) - (pings[7] ?? 0)).toBe(PING_EVERY);
    expect((pings[9] ?? 0) - (pings[8] ?? 0)).toBe(PING_EVERY);
  });

  test('an empty Input after 100 ms of silence, with the newest snapshot’s tick', () => {
    const s = welcomed();
    for (let i = 0; i < 8; i++) {
      s.time(s.deadline());
    }
    const b = snapshotBytes(1234);
    const t = 800_000;
    s.receive(t, b);
    s.input(t, 1240, 512, 512);
    expect(s.deadline()).toBe(t + ACK_AFTER);
    const out = s.time(t + ACK_AFTER).out.map(decodeClient);
    const ack = out.find((m) => m.body.case === 'input');
    expect(ack?.body.value).toMatchObject({ ackOnly: true, ackTick: 1234n });
  });

  test('no Pong for 6 s: dead', () => {
    const s = welcomed();
    expect(s.time(PONG_TIMEOUT - 1).dead).toBe(false);
    expect(s.time(PONG_TIMEOUT).dead).toBe(true);
  });

  test('a snapshot whose base is gone is dropped, and a Resync asked for', () => {
    const s = welcomed();
    expect(s.receive(1, snapshotBytes(100)).kind).toBe('snapshot');
    expect(s.receive(2, snapshotBytes(102, 2)).kind).toBe('snapshot');
    const r = s.receive(3, snapshotBytes(110, 4));
    expect(r.kind).toBe('dropped');
    if (r.kind === 'dropped') {
      expect(r.out.map((b) => decodeClient(b).body)).toMatchObject([
        { case: 'command', value: { body: { case: 'resync' } } },
      ]);
    }
    // A dropped snapshot is not acknowledged.
    const next = s.time(s.deadline()).out.map(decodeClient)[0];
    expect(next?.body.value).toMatchObject({ ackTick: 102n });
  });

  test('while queued: a Ping every 2 s and nothing else, until the Welcome', () => {
    const s = new Session(versions);
    s.open(0);
    expect(s.deadline()).toBe(Number.POSITIVE_INFINITY);
    const r = s.receive(
      1_000,
      encodeServer({ body: { case: 'queued', value: { position: 3, waiting: 7 } } }),
    );
    expect(r).toEqual({ kind: 'queued', position: 3, waiting: 7 });
    expect(s.deadline()).toBe(1_000 + PING_EVERY);
    const out = s.time(1_000 + PING_EVERY).out.map((b) => decodeClient(b).body.case);
    expect(out).toEqual(['ping']);
    expect(s.time(1_000 + PING_EVERY + ACK_AFTER).out).toEqual([]);
  });
});

/** A snapshot of tick, with no other boats, against the snapshot base ticks before it. */
function snapshotBytes(tick: number, base = 0): Uint8Array<ArrayBuffer> {
  const sn = newSnapshot();
  sn.tick = tick;
  sn.base = base;
  const b = new Uint8Array(HEADER_SIZE);
  writeSnapshot(sn, new DataView(b.buffer));
  return b;
}

describe('after a close', () => {
  const top = () => 0.999999;
  test('each code leads where it should', () => {
    expect(afterClose(1000, 0, true, top)).toEqual({ kind: 'stop' });
    expect(afterClose(4001, 0, true, top)).toEqual({ kind: 'replaced' });
    expect(afterClose(4002, 0, true, top)).toEqual({ kind: 'version' });
    expect(afterClose(4003, 0, true, top)).toEqual({ kind: 'removed' });
    expect(afterClose(1006, 0, false, top)).toEqual({ kind: 'check' });
    const wait = (code: number, attempt: number, r: () => number) => {
      const p = afterClose(code, attempt, true, r);
      return p.kind === 'wait' ? p.ms : -1;
    };
    expect(wait(1012, 0, () => 0)).toBe(500);
    expect(wait(1012, 5, top)).toBeCloseTo(5000, 0);
    for (const [code, base] of [
      [1013, 2000],
      [1008, 1000],
      [1009, 1000],
      [1003, 1000],
      [1006, 500],
    ] as const) {
      expect(wait(code, 0, top)).toBeCloseTo(base, 0);
      expect(wait(code, 1, top)).toBeCloseTo(2 * base, 0);
      expect(wait(code, 20, top)).toBeLessThanOrEqual(WAIT_CAP);
      expect(wait(code, 3, () => 0)).toBe(0);
    }
  });

  test('waits are drawn uniformly under the doubling ceiling', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const draws = Array.from({ length: 10_000 }, () => backoff(2, 500, random));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(Math.max(...draws)).toBeLessThan(2000);
    expect(mean).toBeGreaterThan(950);
    expect(mean).toBeLessThan(1050);
  });
});

/** A fake socket the tests open, feed and close. */
class FakeSocket implements Socket {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closedWith: number | null = null;
  constructor(readonly url: string) {}
  send(data: Uint8Array<ArrayBuffer>): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1005;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  deliver(b: Uint8Array<ArrayBuffer>): void {
    this.onmessage?.({ data: b.buffer } as MessageEvent);
  }
  end(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }
}

/** A worker with fake everything, and a clock the test moves. */
function harness(me = 200) {
  let now = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  let next = 1;
  const sockets: FakeSocket[] = [];
  const posted: FromWorker[] = [];
  let asked = 0;
  const net = new NetWorker({
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    post: (m) => posted.push(m),
    me: async () => {
      asked++;
      return me;
    },
    now: () => now,
    setTimeout: (f, ms) => {
      timers.set(next, { at: now + ms * 1000, f });
      return next++;
    },
    clearTimeout: (id) => timers.delete(id),
    random: () => 0.5,
  });
  /** Moves the clock by ms, running each timer due on the way. */
  const advance = async (ms: number) => {
    const end = now + ms * 1000;
    for (;;) {
      let first: [number, { at: number; f: () => void }] | undefined;
      for (const e of timers) {
        if (e[1].at <= end && (first === undefined || e[1].at < first[1].at)) {
          first = e;
        }
      }
      if (first === undefined) {
        break;
      }
      timers.delete(first[0]);
      now = Math.max(now, first[1].at);
      first[1].f();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  const statuses = () => posted.flatMap((m) => (m.type === 'status' ? [m.status] : []));
  const welcome = (s: FakeSocket) =>
    s.deliver(
      encodeServer({
        body: { case: 'welcome', value: { tick: 2n, worldTimeUs: 0n, boat: 7n, rejoined: false } },
      }),
    );
  return {
    net,
    sockets,
    posted,
    statuses,
    welcome,
    advance,
    asked: () => asked,
    start: () => net.handle({ type: 'start', url: 'ws://x/ws', versions }),
  };
}

describe('the net worker', () => {
  test('connects, says Hello, and passes the Welcome and the snapshots on', () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    expect(s.binaryType).toBe('arraybuffer');
    s.open();
    expect(decodeClient(s.sent[0] as Uint8Array).body.case).toBe('hello');
    h.welcome(s);
    s.deliver(snapshotBytes(4));
    expect(h.posted.map((m) => m.type)).toEqual([
      'status',
      'welcome',
      'clock',
      'status',
      'snapshot',
    ]);
    expect(h.statuses()).toEqual(['connecting', 'sailing']);
    const record = h.posted.at(-1);
    if (record?.type !== 'snapshot') {
      throw new Error('no record');
    }
    expect(record.data.byteLength).toBe(FLEET_RECORD_BYTES);
    expect(fleetOf(record.data)[FLEET_META.tick]).toBe(4);
  });

  test('the records the page hands back are filled again: none made after the first', () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    h.welcome(s);
    for (let i = 0; i < 1000; i++) {
      s.deliver(snapshotBytes(4 + 2 * i, i === 0 ? 0 : 2));
      const m = h.posted.at(-1);
      if (m?.type === 'snapshot') {
        h.net.handle({ type: 'return', data: m.data });
      }
    }
    expect(h.posted.filter((m) => m.type === 'snapshot').length).toBe(1000);
    expect(h.net.made).toBe(1);
  });

  test('queued: the place is passed on, and the sea follows the Welcome', () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    s.deliver(encodeServer({ body: { case: 'queued', value: { position: 2, waiting: 5 } } }));
    s.deliver(encodeServer({ body: { case: 'queued', value: { position: 1, waiting: 4 } } }));
    expect(h.posted.filter((m) => m.type === 'queued')).toEqual([
      { type: 'queued', position: 2, waiting: 5 },
      { type: 'queued', position: 1, waiting: 4 },
    ]);
    h.welcome(s);
    expect(h.statuses()).toEqual(['connecting', 'queued', 'sailing']);
  });

  test('no Pong for 6 s: the connection is closed, and made again', async () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    h.welcome(s);
    await h.advance(6_000);
    expect(s.closedWith).toBe(4000);
    expect(h.statuses()).toContain('waiting');
    await h.advance(1_000);
    expect(h.sockets.length).toBe(2);
  });

  test('a failure before the Welcome asks whether the session lives', async () => {
    const gone = harness(401);
    gone.start();
    (gone.sockets[0] as FakeSocket).end(1006);
    await gone.advance(0);
    expect(gone.asked()).toBe(1);
    expect(gone.statuses().at(-1)).toBe('signed-out');
    await gone.advance(60_000);
    expect(gone.sockets.length).toBe(1);

    const alive = harness(200);
    alive.start();
    (alive.sockets[0] as FakeSocket).end(1006);
    await alive.advance(0);
    expect(alive.statuses().at(-1)).toBe('waiting');
    await alive.advance(1_000);
    expect(alive.sockets.length).toBe(2);
  });

  test('1012: back in 0.5 to 5 s; a wake cuts the wait short', async () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    h.welcome(s);
    s.end(1012);
    const wait = h.posted.findLast((m) => m.type === 'status');
    expect(wait).toMatchObject({ status: 'waiting', waitMs: 2750 });
    h.net.handle({ type: 'wake' });
    expect(h.sockets.length).toBe(2);
  });

  test('4001: no reconnecting until the player takes over', async () => {
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    h.welcome(s);
    s.end(4001);
    expect(h.statuses().at(-1)).toBe('replaced');
    await h.advance(60_000);
    expect(h.sockets.length).toBe(1);
    h.net.handle({ type: 'takeover' });
    expect(h.sockets.length).toBe(2);
  });

  test('4002 and 4003 stop; the page going closes with 1000', () => {
    for (const [code, status] of [
      [4002, 'version'],
      [4003, 'removed'],
    ] as const) {
      const h = harness();
      h.start();
      const s = h.sockets[0] as FakeSocket;
      s.open();
      h.welcome(s);
      s.end(code);
      expect(h.statuses().at(-1)).toBe(status);
    }
    const h = harness();
    h.start();
    const s = h.sockets[0] as FakeSocket;
    s.open();
    h.net.handle({ type: 'stop' });
    expect(s.closedWith).toBe(1000);
    s.end(1000);
    expect(h.statuses().at(-1)).toBe('stopped');
  });

  test('the attempts’ waits double, and start again after a Welcome', async () => {
    const h = harness();
    h.start();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = h.sockets.at(-1) as FakeSocket;
      s.open();
      h.welcome(s);
      s.end(1008);
      const m = h.posted.findLast((p) => p.type === 'status');
      waits.push(m?.type === 'status' ? m.waitMs : -1);
      await h.advance(20_000);
    }
    // random() is 0.5: half the ceiling, which starts again from 1 s each
    // time, since each connection was welcomed.
    expect(waits).toEqual([500, 500, 500, 500]);
    // Without a Welcome in between, they double.
    const more: number[] = [];
    for (let i = 0; i < 3; i++) {
      (h.sockets.at(-1) as FakeSocket).end(1008);
      const m = h.posted.findLast((p) => p.type === 'status');
      more.push(m?.type === 'status' ? m.waitMs : -1);
      await h.advance(20_000);
    }
    expect(more).toEqual([1000, 2000, 4000]);
  });
});

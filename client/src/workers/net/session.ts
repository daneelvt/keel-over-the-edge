// SPDX-License-Identifier: AGPL-3.0-only

// A game connection's state in the net worker: what to send, and when,
// given what arrived and when. It does no I/O and reads no clock; the
// worker gives it each event with its time (µs) and calls time() at
// deadline(). The Go test client keeps the same state the same way
// (internal/client/net.go), and the tests replay its traces here.
//
// After a Welcome it sends 8 Pings 100 ms apart, so the clock is good
// within a second, then one every 2 s; every message carries the newest
// snapshot's tick, and after 100 ms with nothing sent an empty Input does;
// with no Pong for 6 s the connection is taken for dead. While it waits in
// the queue for a boat it pings every 2 s, and sends nothing else. Each
// snapshot's other boats are decoded against its base among the last few
// views; one whose base is gone is dropped, and a Resync asked for.

import { Clock } from '../../net/clock';
import { decodeServer, encodeClient } from '../../net/frame';
import type { Welcome } from '../../net/gen/keel/v1/game_pb';
import { KIND_SNAPSHOT, newSnapshot, readSnapshot } from '../../net/snapshot';
import { PROTOCOL_VERSION } from '../../net/version.gen';
import { type View, ViewRing } from '../../net/view';

export const BURST_PINGS = 8;
export const BURST_EVERY = 100_000;
export const PING_EVERY = 2_000_000;
export const ACK_AFTER = 100_000;
export const PONG_TIMEOUT = 6_000_000;

/** What the client's Hello carries. */
export interface Versions {
  catalog: string;
  physicsLayout: number;
  build: string;
}

/** What a message from the server was. */
export type Received =
  | { kind: 'welcome'; welcome: Welcome }
  /** The view stays valid until a few more snapshots are decoded; the ring's changes and sampled are its. */
  | { kind: 'snapshot'; tick: number; flags: number; view: View }
  /** Its base was gone: out asks for a full snapshot. */
  | { kind: 'dropped'; tick: number; out: Uint8Array<ArrayBuffer>[] }
  | { kind: 'queued'; position: number; waiting: number }
  /** The server is about to restart, in about inMs. */
  | { kind: 'restart'; inMs: number }
  | { kind: 'pong' }
  | { kind: 'other' };

export class Session {
  readonly clock = new Clock();
  /** The other boats' views, the last few. */
  readonly views = new ViewRing();
  /** The frame time Pings report, ms. */
  frameMs = 0;

  #versions: Versions;
  readonly #header = newSnapshot();
  #welcomed = false;
  /** Queued for a boat: Pings keep the connection alive. */
  #waiting = false;
  #ackTick = 0;
  #lastSent = 0;
  #lastHeard = 0;
  #pingsLeft = 0;
  #nextPing = -1;

  constructor(versions: Versions) {
    this.#versions = versions;
  }

  get welcomed(): boolean {
    return this.#welcomed;
  }

  /** The newest snapshot's tick. */
  get ackTick(): number {
    return this.#ackTick;
  }

  /** Starts a connection: the Hello to send. */
  open(now: number): Uint8Array<ArrayBuffer>[] {
    this.#welcomed = false;
    this.#waiting = false;
    this.#ackTick = 0;
    this.#pingsLeft = 0;
    this.#nextPing = -1;
    this.views.reset();
    const v = this.#versions;
    return [
      this.#encode(now, {
        body: {
          case: 'hello',
          value: {
            protocol: PROTOCOL_VERSION,
            catalog: v.catalog,
            physicsLayout: v.physicsLayout,
            build: v.build,
          },
        },
      }),
    ];
  }

  /** Takes a server's message. Throws on one it cannot read. */
  receive(now: number, b: Uint8Array): Received {
    if (b.length > 0 && b[0] === KIND_SNAPSHOT) {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const sn = this.#header;
      const err = readSnapshot(v, sn);
      if (err !== null) {
        throw new Error(err);
      }
      const view = this.views.decode(v, sn);
      if (view === 'missing') {
        const resync = this.#encode(now, {
          body: { case: 'command', value: { body: { case: 'resync', value: {} } } },
        });
        return { kind: 'dropped', tick: sn.tick, out: [resync] };
      }
      if (typeof view === 'string') {
        throw new Error(view);
      }
      this.#ackTick = Math.max(this.#ackTick, sn.tick);
      return { kind: 'snapshot', tick: sn.tick, flags: sn.flags, view };
    }
    const m = decodeServer(b);
    switch (m.body.case) {
      case 'queued':
        this.#lastHeard = now;
        if (!this.#waiting && !this.#welcomed) {
          this.#waiting = true;
          this.#nextPing = now + PING_EVERY;
        }
        return { kind: 'queued', position: m.body.value.position, waiting: m.body.value.waiting };
      case 'welcome':
        this.clock.welcome(Number(m.body.value.worldTimeUs), now);
        this.#welcomed = true;
        this.#waiting = false;
        this.#lastHeard = now;
        this.#pingsLeft = BURST_PINGS;
        this.#nextPing = now;
        return { kind: 'welcome', welcome: m.body.value };
      case 'pong':
        this.clock.sample(Number(m.body.value.clientTimeUs), Number(m.body.value.worldTimeUs), now);
        this.#lastHeard = now;
        return { kind: 'pong' };
      case 'restart':
        this.#lastHeard = now;
        return { kind: 'restart', inMs: m.body.value.inMs };
    }
    return { kind: 'other' };
  }

  /** The page's controls for tick seq. */
  input(now: number, seq: number, helm: number, sheet: number): Uint8Array<ArrayBuffer> {
    return this.#encode(now, {
      body: {
        case: 'input',
        value: { seq: seq >>> 0, helm, sheet, ackTick: BigInt(this.#ackTick) },
      },
    });
  }

  /** When time() must next be called; Infinity before the Welcome, unless queued. */
  deadline(): number {
    if (this.#waiting) {
      return Math.min(this.#nextPing, this.#lastHeard + PONG_TIMEOUT);
    }
    if (!this.#welcomed) {
      return Number.POSITIVE_INFINITY;
    }
    let d = Math.min(this.#lastSent + ACK_AFTER, this.#lastHeard + PONG_TIMEOUT);
    if (this.#nextPing >= 0) {
      d = Math.min(d, this.#nextPing);
    }
    return d;
  }

  /** What is due at now; dead when the connection has gone quiet. */
  time(now: number): { out: Uint8Array<ArrayBuffer>[]; dead: boolean } {
    const out: Uint8Array<ArrayBuffer>[] = [];
    if (!this.#welcomed && !this.#waiting) {
      return { out, dead: false };
    }
    if (now - this.#lastHeard >= PONG_TIMEOUT) {
      return { out, dead: true };
    }
    if (this.#waiting) {
      if (now >= this.#nextPing) {
        this.#nextPing = now + PING_EVERY;
        out.push(
          this.#encode(now, {
            body: {
              case: 'ping',
              value: {
                clientTimeUs: BigInt(Math.round(now)),
                ackTick: 0n,
                rttMs: Math.round(this.clock.state.rtt / 1000),
                frameMs: this.frameMs,
              },
            },
          }),
        );
      }
      return { out, dead: false };
    }
    if (this.#nextPing >= 0 && now >= this.#nextPing) {
      if (this.#pingsLeft > 0) {
        this.#pingsLeft--;
      }
      this.#nextPing = now + (this.#pingsLeft > 0 ? BURST_EVERY : PING_EVERY);
      out.push(
        this.#encode(now, {
          body: {
            case: 'ping',
            value: {
              clientTimeUs: BigInt(Math.round(now)),
              ackTick: BigInt(this.#ackTick),
              rttMs: Math.round(this.clock.state.rtt / 1000),
              frameMs: this.frameMs,
            },
          },
        }),
      );
    }
    if (now - this.#lastSent >= ACK_AFTER) {
      out.push(
        this.#encode(now, {
          body: { case: 'input', value: { ackTick: BigInt(this.#ackTick), ackOnly: true } },
        }),
      );
    }
    return { out, dead: false };
  }

  #encode(now: number, m: Parameters<typeof encodeClient>[0]): Uint8Array<ArrayBuffer> {
    this.#lastSent = now;
    return encodeClient(m);
  }
}

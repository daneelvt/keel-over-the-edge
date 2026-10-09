// SPDX-License-Identifier: AGPL-3.0-only

// A game connection's state in the net worker: what to send, and when,
// given what arrived and when. It does no I/O and reads no clock; the
// worker gives it each event with its time (µs) and calls time() at
// deadline(). The Go test client keeps the same state the same way
// (internal/edge/edgetest/net.go), and the tests replay its traces here.
//
// After a Welcome it sends 8 Pings 100 ms apart, so the clock is good
// within a second, then one every 2 s; every message carries the newest
// snapshot's tick, and after 100 ms with nothing sent an empty Input does;
// with no Pong for 6 s the connection is taken for dead.

import { Clock } from '../../net/clock';
import { decodeServer, encodeClient } from '../../net/frame';
import type { Welcome } from '../../net/gen/keel/v1/game_pb';
import { KIND_SNAPSHOT, SNAPSHOT_SIZE } from '../../net/snapshot';
import { PROTOCOL_VERSION } from '../../net/version.gen';

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
  | { kind: 'snapshot'; tick: number }
  | { kind: 'pong' }
  | { kind: 'other' };

const TWO_32 = 2 ** 32;

export class Session {
  readonly clock = new Clock();
  /** The frame time Pings report, ms. */
  frameMs = 0;

  #versions: Versions;
  #welcomed = false;
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
    this.#ackTick = 0;
    this.#pingsLeft = 0;
    this.#nextPing = -1;
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
      if (b.length !== SNAPSHOT_SIZE) {
        throw new Error('a snapshot of the wrong size');
      }
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const tick = v.getInt32(6, true) * TWO_32 + v.getUint32(2, true);
      this.#ackTick = Math.max(this.#ackTick, tick);
      return { kind: 'snapshot', tick };
    }
    const m = decodeServer(b);
    switch (m.body.case) {
      case 'welcome':
        this.clock.welcome(Number(m.body.value.worldTimeUs), now);
        this.#welcomed = true;
        this.#lastHeard = now;
        this.#pingsLeft = BURST_PINGS;
        this.#nextPing = now;
        return { kind: 'welcome', welcome: m.body.value };
      case 'pong':
        this.clock.sample(Number(m.body.value.clientTimeUs), Number(m.body.value.worldTimeUs), now);
        this.#lastHeard = now;
        return { kind: 'pong' };
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

  /** When time() must next be called; Infinity before the Welcome. */
  deadline(): number {
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
    if (!this.#welcomed) {
      return { out, dead: false };
    }
    if (now - this.#lastHeard >= PONG_TIMEOUT) {
      return { out, dead: true };
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

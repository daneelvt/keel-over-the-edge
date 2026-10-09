// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of the game connection. It starts the net worker, takes
// its records, and each frame reconciles the snapshots that came and steps
// the player's boat to the tick it should be at: the world time the clock
// estimates, plus half a round trip, plus m ticks of margin, at most four
// steps a frame. Running ahead adds no felt delay: the boat answers the
// helm on the frame it is moved; the server applies each input at the tick
// it was stepped for, so the boat it sails is the boat drawn.

import { signal } from '@preact/signals';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import {
  helmIndex,
  helmOf,
  type Outcome,
  type Predictor,
  sheetIndex,
  sheetOf,
} from '../predict/predictor';
import {
  Ahead,
  aheadTicks,
  BEHIND,
  type ClockState,
  MAX_STEPS,
  newClockState,
  nowUs,
  worldUs,
} from './clock';
import type { FromWorker, HelloVersions, Status, ToWorker } from './messages';
import { NO_MARGIN, newSnapshot, type OwnSnapshot, readSnapshot } from './snapshot';

/** The page's thread's end of the worker. */
export interface Port {
  postMessage(m: ToWorker): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
}

/** What Online steers: the controls the player holds, and the world clock it sets. */
export interface Helmsman {
  readonly helm: { target: number };
  readonly sheet: { target: number };
  /** Called before each step (the browser tests script controls). */
  beforeStep: (() => void) | null;
  readonly clock: { steps: number; alpha: number };
}

/** How the connection looks to the player. */
export interface Notice {
  text: string;
  /** Offer to take the boat back from another device. */
  takeover: boolean;
}

const EPSILON = 1e-9;
/** How often the frame time is sent, µs. */
const FRAME_EVERY = 2_000_000;

export class Online {
  readonly status = signal<Status>('connecting');
  readonly notice = signal<Notice | null>(null);
  /** The round trip, ms, for the menu; −1 until measured. */
  readonly rtt = signal(-1);
  readonly ahead = new Ahead();
  clock: ClockState = newClockState();
  boat = 0;
  /** The latest margin a snapshot carried, and the lowest of the last few seconds. */
  lastMargin = NO_MARGIN;
  traffic = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };
  /** Resolves with the first snapshot: the sea can be shown. */
  readonly ready: Promise<void>;

  readonly #port: Port;
  readonly #predictor: Predictor;
  readonly #helmsman: Helmsman;
  readonly #queued: ArrayBuffer[] = [];
  readonly #scratch = newSnapshot();
  readonly #latest = newSnapshot();
  #haveLatest = false;
  /** The indices last sent; the first snapshot after a Welcome sets them. */
  #sent = [-1, -1];
  #fresh = false;
  #hadBoat = false;
  #ready: () => void = () => {};
  readonly #frames = new Float64Array(120);
  #frameN = 0;
  #frameSent = 0;
  #noticeUntil = 0;

  constructor(port: Port, predictor: Predictor, helmsman: Helmsman) {
    this.#port = port;
    this.#predictor = predictor;
    this.#helmsman = helmsman;
    this.ready = new Promise((resolve) => {
      this.#ready = resolve;
    });
    port.onmessage = (ev) => this.#receive(ev.data);
  }

  /** Connects: the worker keeps connecting until stopped. */
  start(url: string, versions: HelloVersions): void {
    this.#port.postMessage({ type: 'start', url, versions });
  }

  /** The network is back, or the page shown again: stop waiting. */
  wake(): void {
    this.#port.postMessage({ type: 'wake' });
  }

  takeOver(): void {
    this.#port.postMessage({ type: 'takeover' });
  }

  stop(): void {
    this.#port.postMessage({ type: 'stop' });
  }

  #receive(m: FromWorker): void {
    switch (m.type) {
      case 'status':
        this.status.value = m.status;
        this.#describe(m.status, m.reason);
        break;
      case 'welcome':
        if (this.#hadBoat && !m.rejoined) {
          this.notice.value = { text: 'Your boat has returned to port.', takeover: false };
          this.#noticeUntil = nowUs() + 6_000_000;
        }
        this.#hadBoat = true;
        this.boat = m.boat;
        this.#fresh = true;
        break;
      case 'snapshot':
        if (this.#predictor.started) {
          this.#queued.push(m.data);
        } else if (readSnapshot(new DataView(m.data), this.#scratch) === null) {
          // The first: it starts the prediction, and the sea can be shown.
          this.reconcile(this.#scratch, nowUs());
        }
        break;
      case 'clock':
        this.clock = m.clock;
        if (!m.clock.rough) {
          this.rtt.value = m.clock.rtt / 1000;
        }
        break;
      case 'traffic':
        this.traffic = m;
        break;
    }
  }

  #describe(status: Status, reason: string): void {
    switch (status) {
      case 'sailing':
        if (nowUs() >= this.#noticeUntil) {
          this.notice.value = null;
        }
        return;
      case 'waiting':
      case 'connecting':
        if (this.#hadBoat) {
          this.notice.value = { text: 'Reconnecting…', takeover: false };
        }
        return;
      case 'replaced':
        this.notice.value = { text: 'You are playing on another device.', takeover: true };
        return;
      case 'removed':
        this.notice.value = {
          text: reason === '' ? 'You were removed from the sea.' : reason,
          takeover: false,
        };
        return;
      default:
        return;
    }
  }

  /** Reconciles one snapshot; the tests call it directly. */
  reconcile(sn: OwnSnapshot, now: number): Outcome {
    this.ahead.margin(sn.margin, now, this.clock.rtt);
    this.lastMargin = sn.margin;
    if (this.#fresh) {
      // On each connection the controls start at the indices the server
      // holds, so a reconnect does not jerk the helm.
      this.#fresh = false;
      this.#sent[0] = sn.helm;
      this.#sent[1] = sn.sheet;
      this.#helmsman.helm.target = helmOf(sn.helm);
      this.#helmsman.sheet.target = sheetOf(sn.sheet);
    }
    const o = this.#predictor.snapshot(sn);
    this.#latest.tick = sn.tick;
    this.#latest.seq = sn.seq;
    this.#latest.helm = sn.helm;
    this.#latest.sheet = sn.sheet;
    this.#latest.margin = sn.margin;
    this.#latest.windSpeed = sn.windSpeed;
    this.#latest.windFrom = sn.windFrom;
    this.#latest.state.set(sn.state);
    this.#haveLatest = true;
    if (this.#predictor.started) {
      this.#ready();
    }
    return o;
  }

  /** The page's frame: dt seconds since the last. */
  frame(dt: number): void {
    const now = nowUs();
    this.#frameTime(dt, now);
    for (const data of this.#queued) {
      if (readSnapshot(new DataView(data), this.#scratch) === null) {
        this.reconcile(this.#scratch, now);
      }
    }
    this.#queued.length = 0;
    if (this.#noticeUntil > 0 && now >= this.#noticeUntil && this.status.value === 'sailing') {
      this.#noticeUntil = 0;
      this.notice.value = null;
    }
    this.pace(now);
  }

  /** Steps the boat to the tick it should be at, at now (µs). */
  pace(now: number): void {
    const p = this.#predictor;
    const c = this.clock;
    if (!p.started || !c.have) {
      return;
    }
    const world = worldUs(c, now);
    const due = aheadTicks(world, c.rtt, this.ahead.m);
    const target = Math.ceil(due);
    if (target - p.tick > BEHIND && this.#haveLatest && this.#latest.tick > p.tick) {
      p.reset(this.#latest);
    }
    // A step for a tick an input sent now would reach too late keeps the
    // controls the server holds; so do all until the clock knows the round
    // trip.
    const reach = c.rough ? Number.POSITIVE_INFINITY : Math.ceil(aheadTicks(world, c.rtt, 0));
    const h = this.#helmsman;
    for (let n = Math.min(MAX_STEPS, target - p.tick); n > 0; n--) {
      if (p.tick + 1 < reach) {
        p.stepIndices(this.#sent[0] ?? 512, this.#sent[1] ?? 512);
        continue;
      }
      h.beforeStep?.();
      const helm = helmIndex(quantiseHelm(h.helm.target));
      const sheet = sheetIndex(quantiseSheet(h.sheet.target));
      p.stepIndices(helm, sheet);
      if (helm !== this.#sent[0] || sheet !== this.#sent[1]) {
        this.#sent[0] = helm;
        this.#sent[1] = sheet;
        this.#port.postMessage({ type: 'input', seq: p.tick, helm, sheet });
      }
    }
    // World time for everything else that moves (the sea): the boat's
    // tick, drawn the fraction of the way the clock is.
    h.clock.steps = p.tick - 1;
    h.clock.alpha = Math.min(Math.max(due - p.tick + 1, 0), 1 - EPSILON);
  }

  #frameTime(dt: number, now: number): void {
    this.#frames[this.#frameN % this.#frames.length] = dt * 1000;
    this.#frameN++;
    if (now - this.#frameSent < FRAME_EVERY) {
      return;
    }
    this.#frameSent = now;
    const n = Math.min(this.#frameN, this.#frames.length);
    const v = Array.from(this.#frames.subarray(0, n)).sort((a, b) => a - b);
    this.#port.postMessage({ type: 'frame', ms: v[Math.ceil(0.95 * n) - 1] ?? 0 });
  }
}

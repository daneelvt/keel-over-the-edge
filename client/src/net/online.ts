// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of the game connection. It starts the net worker, takes
// its records, and each frame reconciles the snapshots that came and steps
// the player's boat to the tick it should be at: the world time the clock
// estimates, plus half a round trip, plus m ticks of margin. Running ahead
// adds no felt delay: the boat answers the helm on the frame it is moved;
// the server applies each input at the tick it was stepped for, so the
// boat it sails is the boat drawn. The other boats in each snapshot go to
// the fleet, which draws them a little in the past; each record goes back
// to the worker once read.

import { signal } from '@preact/signals';
import { Fleet } from '../game/fleet';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import { RECORDS } from '../predict/layout.gen';
import {
  helmIndex,
  helmOf,
  type Outcome,
  type Predictor,
  sheetIndex,
  sheetOf,
} from '../predict/predictor';
import { queueLines } from '../ui/queue';
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
import { FLEET_META, fleetOf } from './view';

/** The page's thread's end of the worker. */
export interface Port {
  postMessage(m: ToWorker, transfer?: Transferable[]): void;
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

/** A place in the queue for a boat, and how many wait. */
export interface Place {
  position: number;
  waiting: number;
}

const EPSILON = 1e-9;
/** How many snapshots' own boat are kept for ownAt (the tests). */
const OWN_KEPT = 64;
/** How often the frame time is sent, µs. */
const FRAME_EVERY = 2_000_000;

export class Online {
  readonly status = signal<Status>('connecting');
  readonly notice = signal<Notice | null>(null);
  /** The round trip, ms, for the menu; −1 until measured. */
  readonly rtt = signal(-1);
  /** The place in the queue while the sea is full, or null. */
  readonly place = signal<Place | null>(null);
  /** The other boats. */
  readonly fleet = new Fleet();
  /** The latest snapshots' sizes, bytes, for the panel. */
  snapshotBytes = 0;
  /** The last OWN_KEPT snapshots' own boat, as the server had it: tick, east, north, heading. */
  readonly #own = new Float64Array(OWN_KEPT * 4).fill(Number.NaN);
  #ownNext = 0;
  readonly ahead = new Ahead();
  clock: ClockState = newClockState();
  boat = 0;
  /** The latest margin a snapshot carried, and the lowest of the last few seconds. */
  lastMargin = NO_MARGIN;
  traffic = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0, resyncs: 0 };
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
        if (m.status !== 'queued') {
          this.place.value = null;
        }
        this.#describe(m.status, m.reason);
        break;
      case 'queued':
        this.place.value = { position: m.position, waiting: m.waiting };
        if (this.#hadBoat) {
          // Back after the boat returned to port, and the sea is full.
          this.notice.value = { text: queueLines(this.place.value).join(' '), takeover: false };
        }
        break;
      case 'welcome':
        if (this.#hadBoat && !m.rejoined) {
          this.notice.value = { text: 'Your boat has returned to port.', takeover: false };
          this.#noticeUntil = nowUs() + 6_000_000;
        }
        this.#hadBoat = true;
        this.boat = m.boat;
        this.#fresh = true;
        // A new connection's views start afresh: the boats fade out, and
        // in again with its first snapshot.
        this.fleet.clear();
        break;
      case 'snapshot':
        if (this.#predictor.started) {
          this.#queued.push(m.data);
        } else {
          // The first: it starts the prediction, and the sea can be shown.
          this.#take(m.data, nowUs());
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
    const k = this.#ownNext * 4;
    this.#own[k] = sn.tick;
    this.#own[k + 1] = sn.state[RECORDS.state.x] ?? 0;
    this.#own[k + 2] = sn.state[RECORDS.state.y] ?? 0;
    this.#own[k + 3] = sn.state[RECORDS.state.heading] ?? 0;
    this.#ownNext = (this.#ownNext + 1) % OWN_KEPT;
    if (this.#predictor.started) {
      this.#ready();
    }
    return o;
  }

  /** Reads a snapshot's record: its own boat reconciled, its other boats to the fleet; then hands it back. */
  #take(data: ArrayBuffer, now: number): void {
    if (readSnapshot(new DataView(data), this.#scratch) === null) {
      this.reconcile(this.#scratch, now);
      const f = fleetOf(data);
      this.snapshotBytes = f[FLEET_META.bytes] ?? 0;
      this.fleet.add(f, worldUs(this.clock, f[FLEET_META.received] ?? now));
    }
    this.#port.postMessage({ type: 'return', data }, [data]);
  }

  /**
   * The own boat as the server had it at tick, between the snapshots
   * either side of it among the last few, or null (the tests).
   */
  ownAt(tick: number): { east: number; north: number; heading: number } | null {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < OWN_KEPT; i++) {
      const t = this.#own[i * 4] ?? Number.NaN;
      if (t <= tick && (lo < 0 || t > (this.#own[lo * 4] ?? 0))) {
        lo = i;
      }
      if (t >= tick && (hi < 0 || t < (this.#own[hi * 4] ?? 0))) {
        hi = i;
      }
    }
    if (lo < 0 || hi < 0) {
      return null;
    }
    const o = this.#own;
    const t0 = o[lo * 4] ?? 0;
    const t1 = o[hi * 4] ?? 0;
    const f = t1 > t0 ? (tick - t0) / (t1 - t0) : 0;
    const h0 = o[lo * 4 + 3] ?? 0;
    const h1 = o[hi * 4 + 3] ?? 0;
    const turn = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    return {
      east: (o[lo * 4 + 1] ?? 0) + ((o[hi * 4 + 1] ?? 0) - (o[lo * 4 + 1] ?? 0)) * f,
      north: (o[lo * 4 + 2] ?? 0) + ((o[hi * 4 + 2] ?? 0) - (o[lo * 4 + 2] ?? 0)) * f,
      heading: h0 + turn * f,
    };
  }

  /** The page's frame: dt seconds since the last. */
  frame(dt: number): void {
    const now = nowUs();
    this.#frameTime(dt, now);
    for (const data of this.#queued) {
      this.#take(data, now);
    }
    this.#queued.length = 0;
    if (this.#noticeUntil > 0 && now >= this.#noticeUntil && this.status.value === 'sailing') {
      this.#noticeUntil = 0;
      this.notice.value = null;
    }
    this.pace(now);
    if (this.clock.have) {
      this.fleet.update(worldUs(this.clock, now), dt);
    }
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
    // A step for a tick an input sent now would not reach with a tick to
    // spare, as when catching up after a slow frame, keeps the controls the
    // server holds; so do all until the clock knows the round trip.
    const reach = c.rough ? Number.POSITIVE_INFINITY : Math.ceil(aheadTicks(world, c.rtt, 0)) + 1;
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

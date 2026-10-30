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
//
// The connection may watch another sailor's boat instead: then the
// snapshots' headers are the watched boat's, and the watching driver
// draws it at the near band's render tick, the world clock set there, so
// it and the boats about it share one timeline; nothing is predicted and
// no controls are sent. A Welcome begins each watch, and another brings
// the own boat back, its prediction started afresh; what the connection
// was handed before (the chart, the land, the lights and caps) stands.

import { computed, signal } from '@preact/signals';
import { catalog } from '../catalog';
import type { FallShape } from '../edge/over';
import type { BoatDriver } from '../game/driver';
import { Fleet } from '../game/fleet';
import { Floater } from '../game/float';
import { WatchDriver } from '../game/watch';
import { type PilotControl, PilotInput } from '../input/pilot';
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
import type { WorldEnd } from '../ui/countdown';
import { queueLines } from '../ui/queue';
import { BOAT_IN_THE_WATER, endedText, type WatchEndWhy } from '../ui/watchwords';
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
import type {
  BumpTold,
  CapSeen,
  ChartEntry,
  ChunksHanded,
  ForecastTold,
  FromWorker,
  HelloVersions,
  LampState,
  LightSeen,
  PastTold,
  PlaceSeen,
  Status,
  ToWorker,
  Traffic,
  WatchingTold,
  WeatherKeyframe,
  WeatherSpells,
} from './messages';
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
  readonly pilot: PilotInput;
  /** Called before each step (the browser tests script controls). */
  beforeStep: (() => void) | null;
  readonly clock: { steps: number; alpha: number };
  /** How the boats that go over the lip are drawn falling, or null for no edge. */
  readonly fallShape?: FallShape | null;
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

/** A watch ended or refused: why, and the sailor's name. */
export interface WatchEnd {
  why: WatchEndWhy;
  sailor: string;
}

/** What the connection line says from the bell until the boat is back. */
export const BELL_TEXT =
  'The harbourmaster rings the bell: the harbour closes for a moment. Your boat will wait for you.';

const EPSILON = 1e-9;
/** How many snapshots' own boat are kept for ownAt (the tests). */
const OWN_KEPT = 64;
/** How often the frame time is sent, µs. */
const FRAME_EVERY = 2_000_000;
/** A line about the connection that goes by itself shows this long, µs. */
const NOTICE_FOR = 6_000_000;

export class Online {
  readonly status = signal<Status>('connecting');
  readonly notice = signal<Notice | null>(null);
  /** The round trip, ms, for the menu; −1 until measured. */
  readonly rtt = signal(-1);
  /** The place in the queue while the sea is full, or null. */
  readonly place = signal<Place | null>(null);
  /** The account carries the owner's flag: the free camera is the player's. */
  readonly tools = signal(false);
  /** The boat watched, from its Welcome; null while the connection sails or is idle. */
  readonly watching = signal<WatchingTold | null>(null);
  /** The last watch ended or refused, until the next Welcome. */
  readonly ended = signal<WatchEnd | null>(null);
  /** The place in the spectators' queue, while all the places to watch are taken, or null. */
  readonly watchPlace = signal<Place | null>(null);
  /** How many watch the own boat. */
  readonly watchers = signal(0);
  /** What the server last told of the AI of the own machine sailor watched, and of which watch. */
  readonly #lamp = signal<{ state: LampState; of: WatchingTold } | null>(null);
  /**
   * The running light of the own machine sailor's AI, while it is watched:
   * '' for none. Only as told for the watch under way, so a word of an
   * earlier one lights nothing.
   */
  readonly lamp = computed(() => lampShown(this.watching.value, this.#lamp.value));
  /** The boat drawn is not the own: one watched, or the last one held while none is. */
  readonly spectating = signal(false);
  /** What draws the boat: the predictor while the connection sails, the watching driver while it watches. */
  driver: BoatDriver;
  /** Told each time the driver changes. */
  onDriver: ((d: BoatDriver) => void) | null = null;
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
  /** The world's epoch, in microseconds of UTC since 1970, as the latest Welcome told it. */
  epochUs = 0;
  /** Called with the world's epoch at each Welcome: the sky is counted from it. */
  onEpoch: ((epochUs: number) => void) | null = null;
  /** Told of each bump the server tells of: the game knocks, shakes and says the verdict. */
  onBump: ((b: BumpTold) => void) | null = null;
  /** Told of each Welcome's world, and whether its land is sailed. */
  onWorld: ((world: string, land: boolean) => void) | null = null;
  /** The world of the latest Welcome, and its end, ms of UTC, 0 for none known. */
  world = '';
  endsMs = 0;
  /** Told of each Welcome's world's end. */
  onEnd: ((end: WorldEnd) => void) | null = null;
  /** Told of the chunks of land the server hands. */
  onChunks: ((c: ChunksHanded) => void) | null = null;
  /** Told of the places in chunks just handed. */
  onPlaces: ((p: PlaceSeen[]) => void) | null = null;
  /** Told of the world's chart: whole after each Welcome, then what is charted. */
  onChart: ((entries: ChartEntry[], whole: boolean) => void) | null = null;
  /** Told of each forecast as it is issued, with what has been after a Welcome. */
  onForecast: ((f: ForecastTold, past: PastTold | null) => void) | null = null;
  /** Told of the weather as it is sent: the spells in play, or null to keep them, and keyframes. */
  onWeather: ((spells: WeatherSpells | null, keyframes: WeatherKeyframe[]) => void) | null = null;
  /** Told of lights come into range, and lights to drop; and at each Welcome, of the main port's light, with all others dropped. */
  onLights: ((lights: LightSeen[], drop: number[] | 'all') => void) | null = null;
  /** Islands' caps come into sight, and those to drop: all of them for a new connection. */
  onCaps: ((caps: CapSeen[], drop: number[] | 'all') => void) | null = null;
  /** The latest margin a snapshot carried, and the lowest of the last few seconds. */
  lastMargin = NO_MARGIN;
  traffic: Traffic = {
    bytesIn: 0,
    bytesOut: 0,
    messagesIn: 0,
    messagesOut: 0,
    resyncs: 0,
    controls: 0,
  };
  /** Resolves with the first snapshot: the sea can be shown. */
  readonly ready: Promise<void>;

  readonly #port: Port;
  readonly #predictor: Predictor;
  readonly #watcher: WatchDriver;
  readonly #helmsman: Helmsman;
  /** Floats the other boats on the sea drawn under them. */
  readonly #floater: Floater;
  readonly #queued: ArrayBuffer[] = [];
  readonly #scratch = newSnapshot();
  readonly #latest = newSnapshot();
  #haveLatest = false;
  /** The indices last sent; the first snapshot after a Welcome sets them. */
  #sent = [-1, -1];
  /** The autopilot's control last sent, as the first snapshot after a Welcome sets it. */
  readonly #sentPilot = new PilotInput();
  #fresh = false;
  #hadBoat = false;
  /** A watch began, or the connection was idle, since the own boat's last Welcome. */
  #away = false;
  /** The bell rang: the server is restarting, and the boat waits. */
  #bell = false;
  #ready: () => void = () => {};
  readonly #frames = new Float64Array(120);
  #frameN = 0;
  #frameSent = 0;
  #noticeUntil = 0;

  constructor(port: Port, predictor: Predictor, helmsman: Helmsman) {
    this.#port = port;
    this.#predictor = predictor;
    this.#watcher = new WatchDriver(
      predictor.physics,
      predictor.seas,
      predictor.weather,
      predictor.wakes,
    );
    this.driver = predictor;
    this.#helmsman = helmsman;
    this.#floater = new Floater(predictor.physics, predictor.seas, catalog.boats);
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

  /**
   * The owner's free camera: off the boat over (east, north), height up,
   * metres, or back on it. The server hears it only from an account with
   * the owner's flag.
   */
  roam(on: boolean, east: number, north: number, height: number): void {
    this.#port.postMessage({ type: 'roam', on, east, north, height });
  }

  takeOver(): void {
    this.#port.postMessage({ type: 'takeover' });
  }

  /** Watches a sailor's boat: a boat sailed leaves the water at once. */
  watch(sailor: string): void {
    this.#port.postMessage({ type: 'watch', sailor });
  }

  /** A boat: a new one at the start, or a place in the queue, while a watch goes on. */
  sail(): void {
    this.#port.postMessage({ type: 'sail' });
  }

  /** Stops watching, without sailing: the boat watched is held where it was. */
  unwatch(): void {
    this.#port.postMessage({ type: 'unwatch' });
    if (this.watching.value !== null) {
      this.watching.value = null;
      this.#away = true;
    }
  }

  /** Whether the boat drawn is one watched, not the own boat. */
  get watched(): boolean {
    return this.driver === this.#watcher;
  }

  #use(d: BoatDriver): void {
    if (this.driver !== d) {
      this.driver = d;
      this.spectating.value = d === this.#watcher;
      this.onDriver?.(d);
    }
  }

  /** A line in place of the connection's for NOTICE_FOR, at now (µs): its own, or the page's. */
  say(text: string, now = nowUs()): void {
    this.notice.value = { text, takeover: false };
    this.#noticeUntil = now + NOTICE_FOR;
  }

  stop(): void {
    this.#port.postMessage({ type: 'stop' });
  }

  #receive(m: FromWorker): void {
    switch (m.type) {
      case 'status':
        this.status.value = m.status;
        if (m.status !== 'queued' && m.status !== 'sailing' && m.status !== 'idle') {
          // The connection is gone: its places in the queues with it.
          this.place.value = null;
          this.watchPlace.value = null;
        }
        this.#describe(m.status, m.reason);
        break;
      case 'queued':
        if (m.spectators) {
          this.watchPlace.value = { position: m.position, waiting: m.waiting };
          if (!this.watched) {
            // The own boat has left the water to watch: held where it was.
            this.#watcher.reset();
            this.#watcher.holdFrom(this.#predictor);
            this.#predictor.started = false;
            this.#use(this.#watcher);
          }
          break;
        }
        this.place.value = { position: m.position, waiting: m.waiting };
        if (this.#hadBoat && this.watching.value === null) {
          // Back after the boat returned to port, and the sea is full.
          this.notice.value = { text: queueLines(this.place.value).join(' '), takeover: false };
        }
        break;
      case 'watchEnded': {
        this.ended.value = { why: m.why, sailor: m.sailor };
        this.watchPlace.value = null;
        if (!this.watched && this.status.value === 'sailing') {
          // Refused while the own boat sails: it sails on.
          this.say(endedText(m.why, m.sailor));
          break;
        }
        this.watching.value = null;
        this.#lamp.value = null;
        this.#away = true;
        break;
      }
      case 'watchers':
        this.watchers.value = m.count;
        break;
      case 'lamp': {
        const w = this.watching.value;
        this.#lamp.value = w?.machine && w.mine ? { state: m.state, of: w } : null;
        break;
      }
      case 'restart':
        this.#bell = true;
        this.notice.value = { text: BELL_TEXT, takeover: false };
        break;
      case 'sea':
        // Ahead of the tick it applies from: the prediction takes it at once.
        this.#predictor.seas.receive(m.sea);
        break;
      case 'weather':
        // Ahead of the tick any of it changes the wind from, as the sea is.
        this.#predictor.weather.receive(m.spells, m.keyframes, m.coming);
        this.onWeather?.(m.spells, m.keyframes);
        break;
      case 'forecast':
        this.onForecast?.(m.forecast, m.past);
        break;
      case 'bump':
        this.onBump?.(m.bump);
        break;
      case 'chunks':
        this.onChunks?.(m.chunks);
        break;
      case 'places':
        this.onPlaces?.(m.places);
        break;
      case 'lights':
        this.onLights?.(m.lights, m.drop);
        break;
      case 'caps':
        this.onCaps?.(m.caps, m.drop);
        break;
      case 'chart':
        this.onChart?.(m.entries, m.whole);
        break;
      case 'tools':
        this.tools.value = m.on;
        break;
      case 'welcome':
        if (m.watching !== null) {
          if (this.#bell) {
            this.notice.value = null;
          }
          this.#away = true;
        } else if (this.#away) {
          // From watching, or idle: the own boat in the water at the start.
          this.say(BOAT_IN_THE_WATER);
        } else if (this.#hadBoat && !m.rejoined) {
          this.say('Your boat has returned to port.');
        } else if (this.#bell) {
          this.notice.value = null;
        }
        this.#bell = false;
        if (m.watching === null) {
          this.#hadBoat = true;
          this.#away = false;
          this.place.value = null;
        }
        this.boat = m.boat;
        this.epochUs = m.epochUs;
        this.onEpoch?.(m.epochUs);
        this.onWorld?.(m.world, m.land);
        this.world = m.world;
        this.endsMs = m.endsUs / 1000;
        this.onEnd?.({
          world: m.world,
          ends: m.endsUs / 1000,
          closing: m.closingUs / 1000,
          zone: m.zone,
          epoch: m.epochUs / 1000,
        });
        if (m.first) {
          // A new connection is sent the lights in range again; a later
          // Welcome on it, nothing it holds.
          this.onLights?.(m.light === null ? [] : [m.light], 'all');
          this.onCaps?.([], 'all');
        }
        this.tools.value = m.tools;
        this.#predictor.setCirculation(m.circulation);
        this.watching.value = m.watching;
        this.#lamp.value = null;
        this.ended.value = null;
        this.watchPlace.value = null;
        if (m.watching !== null) {
          // Another boat's headers: none of the last one's, and no prediction.
          this.watchers.value = 0;
          this.#watcher.reset();
          if (!this.watched) {
            this.#watcher.holdFrom(this.#predictor);
          }
          this.#predictor.started = false;
          this.#use(this.#watcher);
        } else if (this.driver !== this.#predictor) {
          // The own boat again: its prediction starts from its first snapshot.
          this.#predictor.started = false;
          this.#use(this.#predictor);
        }
        this.#fresh = true;
        // A snapshot still waiting for a frame is the last connection's:
        // its controls are not this boat's.
        this.#queued.length = 0;
        // A new connection's views start afresh: the boats fade out, and
        // in again with its first snapshot.
        this.fleet.clear();
        this.#predictor.wakes.reset();
        break;
      case 'snapshot':
        if (this.watched ? this.#watcher.started : this.#predictor.started) {
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
        if (nowUs() >= this.#noticeUntil && !this.#bell) {
          this.notice.value = null;
        }
        return;
      case 'waiting':
      case 'connecting':
        // After the bell its line stays, through the close and the
        // reconnecting, until the boat is back.
        if ((this.#hadBoat || this.#away) && !this.#bell) {
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

  /** The world clock's now as UTC, ms since 1970; NaN before a Welcome. */
  utcMs(now = nowUs()): number {
    if (!this.clock.have || this.epochUs === 0) {
      return Number.NaN;
    }
    return (this.epochUs + worldUs(this.clock, now)) / 1000;
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
      this.#sentPilot.set(sn);
      this.#helmsman.helm.target = helmOf(sn.helm);
      this.#helmsman.sheet.target = sheetOf(sn.sheet);
      this.#helmsman.pilot.set(sn);
    }
    const o = this.#predictor.snapshot(sn);
    this.#latest.tick = sn.tick;
    this.#latest.seq = sn.seq;
    this.#latest.helm = sn.helm;
    this.#latest.sheet = sn.sheet;
    this.#latest.mode = sn.mode;
    this.#latest.way = sn.way;
    this.#latest.order = sn.order;
    this.#latest.target = sn.target;
    this.#latest.margin = sn.margin;
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
      const f = fleetOf(data);
      // The other boats' samples first: the steps the reconciliation
      // replays sail in their shadow, and the watched boat's step.
      this.#predictor.wakes.observe(f);
      if (this.watched) {
        this.#watcher.receive(this.#scratch);
        this.#ready();
      } else {
        this.reconcile(this.#scratch, now);
      }
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

  /** How much the page draws: its tier (1 low … 3 high) and its pixel ratio, for the server. */
  quality(tier: number, scale: number): void {
    this.#port.postMessage({ type: 'quality', tier, scale });
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
    const watched = this.watched;
    if (!watched) {
      this.pace(now);
    }
    if (this.clock.have) {
      this.fleet.update(worldUs(this.clock, now), dt);
      if (watched) {
        this.#drawWatched();
      }
      const c = this.#helmsman.clock;
      this.#floater.apply(this.fleet.drawn, this.fleet.count, c.steps + c.alpha, dt);
      this.fleet.fall(this.#helmsman.fallShape ?? null);
    }
  }

  /**
   * The watched boat at the near band's render tick, or at its newest
   * header until the band has one; the world clock set there, and the
   * controls it sails with shown as the screen shows the own boat's.
   */
  #drawWatched(): void {
    const w = this.#watcher;
    const near = this.fleet.near.tick;
    const h = this.#helmsman;
    if (!w.started) {
      // Idle, or waiting to watch: the boat held, the world going on.
      if (!Number.isNaN(near)) {
        h.clock.steps = Math.floor(near);
        h.clock.alpha = near - h.clock.steps;
      }
      return;
    }
    w.at(Number.isNaN(near) ? w.newest : near, h.clock);
    h.helm.target = helmOf(w.helm);
    h.sheet.target = sheetOf(w.sheet);
    h.pilot.set(w.pilot);
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
        p.stepIndices(this.#sent[0] ?? 512, this.#sent[1] ?? 512, this.#sentPilot);
        continue;
      }
      h.beforeStep?.();
      const helm = helmIndex(quantiseHelm(h.helm.target));
      const sheet = sheetIndex(quantiseSheet(h.sheet.target));
      const pilot = h.pilot;
      p.stepIndices(helm, sheet, pilot);
      if (helm !== this.#sent[0] || sheet !== this.#sent[1] || !samePilot(pilot, this.#sentPilot)) {
        this.#sent[0] = helm;
        this.#sent[1] = sheet;
        this.#sentPilot.set(pilot);
        this.#port.postMessage({
          type: 'input',
          seq: p.tick,
          helm,
          sheet,
          pilot: pilot.mode,
          target: pilot.target,
          order: pilot.order,
          way: pilot.way,
        });
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

function samePilot(a: PilotControl, b: PilotControl): boolean {
  return a.mode === b.mode && a.target === b.target && a.order === b.order && a.way === b.way;
}

/** The running light shown for a watch: as told for that same watch of an own machine sailor, else none. */
export function lampShown(
  watching: WatchingTold | null,
  told: { state: LampState; of: WatchingTold } | null,
): '' | LampState {
  if (
    watching === null ||
    !watching.machine ||
    !watching.mine ||
    told === null ||
    told.of !== watching
  ) {
    return '';
  }
  return told.state;
}

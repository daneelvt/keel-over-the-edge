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

import { PILOT_IDLE, type PilotControl } from '../../input/pilot';
import { Clock } from '../../net/clock';
import { decodeServer, encodeClient } from '../../net/frame';
import {
  BumpPart,
  type ChartEntry as ChartEntryWire,
  ChartSubject,
  type Light,
  type Place,
  type Welcome,
} from '../../net/gen/keel/v1/game_pb';
import type {
  BumpTold,
  ChartEntry,
  ChunksHanded,
  LightSeen,
  PlaceSeen,
  SeaAreas,
  WeatherKeyframe,
  WeatherSpells,
} from '../../net/messages';
import { KIND_SNAPSHOT, newSnapshot, readSnapshot } from '../../net/snapshot';
import { PROTOCOL_VERSION } from '../../net/version.gen';
import { POSITION_STEP, type View, ViewRing } from '../../net/view';
import { keyframeRecord, spellRecord } from '../../net/weather';

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
/** A bump's part, as the page names it. */
const PARTS: Record<number, BumpTold['part']> = {
  [BumpPart.UNSPECIFIED]: 'seen',
  [BumpPart.YOURS]: 'yours',
  [BumpPart.THEIRS]: 'theirs',
  [BumpPart.NONE]: 'none',
};

export type Received =
  | { kind: 'welcome'; welcome: Welcome }
  /** The view stays valid until a few more snapshots are decoded; the ring's changes and sampled are its. */
  | { kind: 'snapshot'; tick: number; flags: number; view: View }
  /** Its base was gone: out asks for a full snapshot. */
  | { kind: 'dropped'; tick: number; out: Uint8Array<ArrayBuffer>[] }
  | { kind: 'queued'; position: number; waiting: number }
  /** The server is about to restart, in about inMs. */
  | { kind: 'restart'; inMs: number }
  /** The sea about the boat. */
  | { kind: 'sea'; sea: SeaAreas }
  | { kind: 'weather'; spells: WeatherSpells | null; keyframes: WeatherKeyframe[] }
  | { kind: 'bump'; bump: BumpTold }
  /** The addresses of chunks of the land, by number. */
  | { kind: 'chunks'; chunks: ChunksHanded }
  /** The places in chunks just handed. */
  | { kind: 'places'; places: PlaceSeen[] }
  /** Lights come into range, and lights to drop. */
  | { kind: 'lights'; lights: LightSeen[]; drop: number[] }
  /** The account's owner's flag was set or cleared. */
  | { kind: 'tools'; on: boolean }
  /** The world's chart: whole, or what was charted since. */
  | { kind: 'chart'; entries: ChartEntry[]; whole: boolean }
  | { kind: 'pong' }
  | { kind: 'other' };

export class Session {
  readonly clock = new Clock();
  /** The other boats' views, the last few. */
  readonly views = new ViewRing();
  /** The frame time Pings report, ms. */
  frameMs = 0;
  /** The tier and the pixel ratio, in hundredths, Pings report; 0 unknown. */
  tier = 0;
  renderScale = 0;

  #versions: Versions;
  readonly #header = newSnapshot();
  #welcomed = false;
  /** The world of the last Welcome: a Welcome to another is a new world's. */
  #world = '';
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
        if (this.#world !== '' && m.body.value.world !== this.#world) {
          this.clock.reset();
        }
        this.#world = m.body.value.world;
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
      case 'seaAreas': {
        this.#lastHeard = now;
        const a = m.body.value;
        return {
          kind: 'sea',
          sea: {
            tick: Number(a.tick),
            col: a.col,
            row: a.row,
            size: a.size,
            speed: a.speed,
            from: a.from,
            fetch: a.fetch,
          },
        };
      }
      case 'weatherSystems':
        this.#lastHeard = now;
        return {
          kind: 'weather',
          spells: m.body.value.keepSpells ? null : m.body.value.spells.map(spellRecord),
          keyframes: m.body.value.keyframes.map(keyframeRecord),
        };
      case 'chunks': {
        this.#lastHeard = now;
        const c = m.body.value;
        if (c.number.length !== c.path.length) {
          throw new Error('chunks with numbers and addresses that do not pair');
        }
        return { kind: 'chunks', chunks: { numbers: [...c.number], paths: [...c.path] } };
      }
      case 'tools':
        this.#lastHeard = now;
        return { kind: 'tools', on: m.body.value.on };
      case 'places':
        this.#lastHeard = now;
        return { kind: 'places', places: m.body.value.places.map(placeSeen) };
      case 'lights':
        this.#lastHeard = now;
        return {
          kind: 'lights',
          lights: m.body.value.lights.map(lightSeen),
          drop: [...m.body.value.drop],
        };
      case 'chart':
        this.#lastHeard = now;
        return { kind: 'chart', entries: m.body.value.entries.map(chartEntry), whole: true };
      case 'charted':
        this.#lastHeard = now;
        return { kind: 'chart', entries: m.body.value.entries.map(chartEntry), whole: false };
      case 'bump': {
        this.#lastHeard = now;
        const v = m.body.value;
        return {
          kind: 'bump',
          bump: {
            tick: Number(v.tick),
            east: v.x * POSITION_STEP,
            north: v.y * POSITION_STEP,
            closing: v.closing / 100,
            part: PARTS[v.part] ?? 'seen',
            article: v.article,
          },
        };
      }
    }
    return { kind: 'other' };
  }

  /** The page's controls for tick seq: the helm's and sheet's indices, and the autopilot's control. */
  input(
    now: number,
    seq: number,
    helm: number,
    sheet: number,
    pilot: PilotControl = PILOT_IDLE,
  ): Uint8Array<ArrayBuffer> {
    return this.#encode(now, {
      body: {
        case: 'input',
        value: {
          seq: seq >>> 0,
          helm,
          sheet,
          ackTick: BigInt(this.#ackTick),
          pilot: pilot.mode,
          target: pilot.target,
          order: pilot.order,
          way: pilot.way,
        },
      },
    });
  }

  /**
   * The owner's free camera: off the boat over (east, north), height up,
   * metres, or back on it.
   */
  roam(
    now: number,
    on: boolean,
    east: number,
    north: number,
    height: number,
  ): Uint8Array<ArrayBuffer> {
    return this.#encode(now, {
      body: {
        case: 'command',
        value: {
          body: {
            case: 'roam',
            value: {
              on,
              east: Math.round(east * 100),
              north: Math.round(north * 100),
              height: Math.max(0, Math.round(height * 100)),
            },
          },
        },
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
                tier: this.tier,
                renderScale: this.renderScale,
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
              tier: this.tier,
              renderScale: this.renderScale,
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

/** A turn in 65536ths, in radians. */
const TURN = (2 * Math.PI) / 65536;

/** A place as the page draws it, from the server's. */
export function placeSeen(p: Place): PlaceSeen {
  return {
    number: p.number,
    kind: p.kind,
    east: p.east / 100,
    north: p.north / 100,
    heading: p.heading * TURN,
    ground: p.ground / 100,
    tower: p.tower / 100,
    daymark: p.daymark,
    rig: p.rig,
    age: p.age,
    sunk: p.sunk,
    heel: p.heel * TURN,
  };
}

/** A light as the page shows it, from the server's. */
export function lightSeen(l: Light): LightSeen {
  return {
    number: l.number,
    east: l.east / 100,
    north: l.north / 100,
    focal: l.focal / 100,
    character: l.character,
    phase: Number(l.phase),
    range: l.range,
  };
}

/** A subject kind as the page names it, or null. */
function subjectOf(s: ChartSubject): ChartEntry['subject'] | null {
  switch (s) {
    case ChartSubject.ISLAND:
      return 'island';
    case ChartSubject.PLACE:
      return 'place';
    case ChartSubject.FEATURE:
      return 'feature';
  }
  return null;
}

/** A chart's entry as the page reads it, from the server's. */
export function chartEntry(e: ChartEntryWire): ChartEntry {
  const b = e.bounds;
  return {
    subject: subjectOf(e.subject) ?? 'island',
    number: e.number,
    sort: e.sort,
    name: e.name,
    east: e.east / 100,
    north: e.north / 100,
    by: e.by,
    ai: e.ai,
    at: Number(e.whenMs),
    worth: e.worth / 10,
    island: e.island - 1,
    group: e.group,
    bounds:
      b.length === 4
        ? [(b[0] ?? 0) / 100, (b[1] ?? 0) / 100, (b[2] ?? 0) / 100, (b[3] ?? 0) / 100]
        : null,
    highest: e.highest / 100,
    zone: e.zone,
    className: e.class,
    model: e.model,
    light: e.light - 1,
    character: e.character,
    focal: e.focal / 100,
    range: e.range,
    ship: e.ship,
    sunk: e.sunk,
    withSubject: subjectOf(e.withSubject),
    withNumber: e.withNumber,
  };
}

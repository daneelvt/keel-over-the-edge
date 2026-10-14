// SPDX-License-Identifier: AGPL-3.0-only

// The records the page and its net worker send each other: one closed set
// each way. A snapshot crosses as a record (view.ts: its header as it came,
// then the other boats in metres and radians), its ArrayBuffer transferred,
// not copied; the page hands each back once it has read it, and the worker
// fills it again, so neither side allocates per snapshot.

import type { ClockState } from './clock';

/**
 * What raises the waves about the boat, as the server sends it: a square of
 * sea areas, size a side, from the area at column col and row row, each with
 * the wind that raises its waves (speed in steps of 0.01 m/s, the direction
 * it comes from in 65536ths of a turn) and its fetch in metres, row by row
 * from the south-west. It applies from tick on.
 */
export interface SeaAreas {
  tick: number;
  col: number;
  row: number;
  size: number;
  speed: number[];
  from: number[];
  fetch: number[];
}

/**
 * The spells of weather in play, as the server sends them: each a spell
 * record's values in the physics module's order (RECORDS.spell), whole
 * numbers all. They replace those held.
 */
export type WeatherSpells = number[][];

/**
 * A bump, as the server tells it: the tick, where (metres east and north),
 * how fast the hulls closed (m/s), and the connection's part: its boat's
 * fault ('yours'), the other's ('theirs'), no one's ('none'), or a bump
 * it only saw ('seen'), with the Article, as the rulebook numbers the rule,
 * for the first three.
 */
export interface BumpTold {
  tick: number;
  east: number;
  north: number;
  closing: number;
  part: 'yours' | 'theirs' | 'none' | 'seen';
  article: string;
}

/** What the net worker's Hello carries besides the protocol version. */
export interface HelloVersions {
  catalog: string;
  physicsLayout: number;
  build: string;
}

export type ToWorker =
  /** Connect to url, and keep connecting. */
  | { type: 'start'; url: string; versions: HelloVersions }
  /** The controls stepped for tick seq: the helm and sheet indices, and the autopilot's control. */
  | {
      type: 'input';
      seq: number;
      helm: number;
      sheet: number;
      pilot: number;
      target: number;
      order: number;
      way: number;
    }
  /** The page's frame time's 95th percentile, ms, for the server's metrics. */
  | { type: 'frame'; ms: number }
  /** How much the page draws: its tier (1 low … 3 high) and its pixel ratio, for the server's metrics. */
  | { type: 'quality'; tier: number; scale: number }
  /** Stop waiting: the network is back, or the page is shown again. */
  | { type: 'wake' }
  /** The player chose to take the boat back from another device. */
  | { type: 'takeover' }
  /** The page is going: close with 1000. */
  | { type: 'stop' }
  /** A snapshot record read, for the worker to fill again. */
  | { type: 'return'; data: ArrayBuffer };

/** Where the connection stands. */
export type Status =
  /** Opening, or open and waiting for the Welcome. */
  | 'connecting'
  /** Welcomed: snapshots arrive. */
  | 'sailing'
  /** The sea is full: waiting in the queue for a boat. */
  | 'queued'
  /** Closed, waiting to try again. */
  | 'waiting'
  /** Another device took the boat. */
  | 'replaced'
  /** The session is gone: the start screen. */
  | 'signed-out'
  /** Client and server differ: reload. */
  | 'version'
  /** The player was removed. */
  | 'removed'
  /** Stopped for good. */
  | 'stopped';

export type FromWorker =
  | { type: 'status'; status: Status; waitMs: number; reason: string }
  | {
      type: 'welcome';
      boat: number;
      rejoined: boolean;
      kind: number;
      tick: number;
      /** The world's epoch, in microseconds of UTC since 1970: sky time counts from it and the world's time. */
      epochUs: number;
    }
  /** A snapshot record: view.ts's FLEET_RECORD_BYTES. */
  | { type: 'snapshot'; data: ArrayBuffer }
  /** The place in the queue, 1 for the next, and how many wait. */
  | { type: 'queued'; position: number; waiting: number }
  /** The server is about to restart, in about inMs: the bell. */
  | { type: 'restart'; inMs: number }
  /** The sea about the boat, for the prediction and the drawing. */
  | { type: 'sea'; sea: SeaAreas }
  /** The spells of weather in play, for the prediction's wind and the drawing of the gusts. */
  | { type: 'weather'; spells: WeatherSpells }
  /** The boat, or one near it, touched another. */
  | { type: 'bump'; bump: BumpTold }
  | { type: 'clock'; clock: ClockState }
  | ({ type: 'traffic' } & Traffic);

/** What has crossed the connection, as the worker counts it. */
export interface Traffic {
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
  /** Snapshots dropped for want of their base, each with a Resync asked for. */
  resyncs: number;
}

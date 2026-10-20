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
 * A keyframe of the weather systems, as the server sends it: its tick, and
 * each system by its slot, a system record's values in the physics
 * module's order (RECORDS.system), whole numbers all.
 */
export interface WeatherKeyframe {
  tick: number;
  systems: [slot: number, values: number[]][];
}

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

/**
 * Chunks of the land the server handed: each one's number on the world's
 * grid and its address, a path on the play origin to fetch it from, nearest
 * first. The client never makes an address itself.
 */
export interface ChunksHanded {
  numbers: number[];
  paths: string[];
}

/**
 * A place the server handed with the chunk it stands in: its number, its
 * kind (the catalog's index), where it is (metres east and north) and the
 * way it faces (radians clockwise from north); a lighthouse's ground and
 * tower (metres) and daymark; a wreck's rig and age (the catalog's indices),
 * whether she is sunk, and her heel (radians, to starboard). Never a name.
 */
export interface PlaceSeen {
  number: number;
  kind: number;
  east: number;
  north: number;
  heading: number;
  ground: number;
  tower: number;
  daymark: number;
  rig: number;
  age: number;
  sunk: boolean;
  heel: number;
}

/**
 * A lighthouse's light, sent once the eye is within its range: its number,
 * where it is (metres east and north), its height above the sea (metres),
 * its character (the catalog's index), its phase (microseconds of world
 * time) and its nominal range (metres). Never a name.
 */
export interface LightSeen {
  number: number;
  east: number;
  north: number;
  focal: number;
  character: number;
  phase: number;
  range: number;
}

/** What can be charted: an island, a place or a feature. */
export type ChartSubject = 'island' | 'place' | 'feature';

/**
 * A subject of the world's chart, as the server tells of it once charted:
 * what it is (its subject, its number among the world's of its kind, and
 * its sort, the catalog's index of an island's size class or a place's or
 * a feature's kind), its name (none for a feature), where it is (metres
 * east and north), who charted it (the sailor's name, empty for one known
 * from the start or charted with another) and when (ms of UTC), and its
 * worth. An island's model's address and its bounds, highest and zone; a
 * lighthouse's light; a wreck's ship. Names reach the page only here.
 */
export interface ChartEntry {
  subject: ChartSubject;
  number: number;
  sort: number;
  name: string;
  east: number;
  north: number;
  by: string;
  ai: boolean;
  at: number;
  worth: number;
  /** The island it is on or by, by number; −1 for none. */
  island: number;
  group: string;
  /** An island's land's bounds, metres: west, south, east, north. */
  bounds: [number, number, number, number] | null;
  highest: number;
  /** 0 the centre, 1 the middle waters, 2 the rim. */
  zone: number;
  className: string;
  model: string;
  /** A lighthouse's light's number, −1 for none; its character's index, its height and its range, metres. */
  light: number;
  character: number;
  focal: number;
  range: number;
  ship: string;
  sunk: boolean;
  /** The subject it was charted with, if any. */
  withSubject: ChartSubject | null;
  withNumber: number;
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
  /**
   * The owner's free camera: off the boat over (east, north), height up,
   * metres, or back on it. Only an account with the owner's flag is heard.
   */
  | { type: 'roam'; on: boolean; east: number; north: number; height: number }
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
      /** The world's ID, which its chunks carry. */
      world: string;
      /** Whether the world's land is sailed: chunks come, and the prediction steps on them. */
      land: boolean;
      /** The world's way round the disk for its current: 1 clockwise seen from above, −1 the other way, 0 none. */
      circulation: number;
      /** The account carries the owner's flag: the free camera is its. */
      tools: boolean;
      /** The main port's light, seen from everywhere; null in a world without land. */
      light: LightSeen | null;
      /** When the world ends and its last days begin, µs of UTC since 1970; 0 for no end known. */
      endsUs: number;
      closingUs: number;
      /** The zone the schedule's ends are published in; "" for UTC. */
      zone: string;
    }
  /** The account's owner's flag was set or cleared. */
  | { type: 'tools'; on: boolean }
  /** A snapshot record: view.ts's FLEET_RECORD_BYTES. */
  | { type: 'snapshot'; data: ArrayBuffer }
  /** The place in the queue, 1 for the next, and how many wait. */
  | { type: 'queued'; position: number; waiting: number }
  /** The server is about to restart, in about inMs: the bell. */
  | { type: 'restart'; inMs: number }
  /** The sea about the boat, for the prediction and the drawing. */
  | { type: 'sea'; sea: SeaAreas }
  /**
   * The spells of weather in play, for the prediction's wind and the
   * drawing of the gusts, or null if those held still are; and keyframes
   * of the weather systems, each replacing any held of its tick.
   */
  | { type: 'weather'; spells: WeatherSpells | null; keyframes: WeatherKeyframe[] }
  /** The boat, or one near it, touched another. */
  | { type: 'bump'; bump: BumpTold }
  /** Chunks of the land the boat could see: their addresses to fetch. */
  | { type: 'chunks'; chunks: ChunksHanded }
  /** The places in chunks just handed. */
  | { type: 'places'; places: PlaceSeen[] }
  /** Lights come into range, and lights to drop, by number. */
  | { type: 'lights'; lights: LightSeen[]; drop: number[] }
  /** The world's chart: whole after a Welcome, or what was charted since. */
  | { type: 'chart'; entries: ChartEntry[]; whole: boolean }
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

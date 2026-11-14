// SPDX-License-Identifier: AGPL-3.0-only

// The records the page and its net worker send each other: one closed set
// each way. A snapshot crosses as a record (view.ts: its header as it came,
// then the other boats in metres and radians), its ArrayBuffer transferred,
// not copied; the page hands each back once it has read it, and the worker
// fills it again, so neither side allocates per snapshot.

import type { Harbour } from '../predict/physics';
import type { WatchEndWhy } from '../ui/watchwords';
import type { ClockState } from './clock';

/**
 * What raises the waves about the boat, as the server sends it: a square of
 * sea areas, size a side, from the area at column col and row row, each with
 * the wind that raises its waves (speed in steps of 0.01 m/s, the direction
 * it comes from in 65536ths of a turn) and its fetch in metres, row by row
 * from the south-west. It applies from tick on. Each area's swell (height
 * in centimetres, none if 0, period in steps of 0.01 s, direction as the
 * wind's) comes only when it changed: empty, it is the last sent's. Its
 * current is not sent: the client works it out as the server does.
 */
export interface SeaAreas {
  tick: number;
  col: number;
  row: number;
  size: number;
  speed: number[];
  from: number[];
  fetch: number[];
  swellHeight?: number[];
  swellPeriod?: number[];
  swellFrom?: number[];
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
/**
 * An island's cap, as the server sends it: its number, its centre east and
 * north and its width, m, each to 50 m.
 */
export interface CapSeen {
  number: number;
  east: number;
  north: number;
  width: number;
}

export interface WeatherKeyframe {
  tick: number;
  systems: [slot: number, values: number[]][];
}

/**
 * A forecast, as the server issues it or the sandbox makes it: its head
 * (RECORDS.forecastHead, each system's slot among it), each of its spells
 * (RECORDS.spell) and each of its systems' records (RECORDS.systemRecord)
 * as the physics module's records' values, whole numbers all; and the
 * gale warning in force, or null. It is the truth: the server's keyframes
 * at any tick it knows are made from it.
 */
export interface ForecastTold {
  head: number[];
  spells: number[][];
  systems: number[][];
  gale: GaleTold | null;
}

/**
 * A gale warning in force: the issue it came into force at, its key; the
 * steps it blows at, a bit each, and the first; its force, 8 to 12; the
 * direction its wind first blows from, radians clockwise from north; its
 * strongest point, m east and north; and the nearest charted island or
 * place, by subject and number, or null.
 */
export interface GaleTold {
  key: number;
  steps: number;
  first: number;
  force: number;
  from: number;
  east: number;
  north: number;
  place: { subject: ChartSubject; number: number } | null;
}

/**
 * What has been, for a client just come: the issue of ninety minutes
 * before, the truth's keyframes at each five minutes since and the spells
 * in play over them, each a spell record's values.
 */
export interface PastTold {
  issue: ForecastTold;
  truth: WeatherKeyframe[];
  spells: number[][];
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

/** A point of a race's course, m east and north of the world's centre. */
export interface RacePoint {
  east: number;
  north: number;
}

/** A boat in a race as told: its race number, its skipper's name as the reader may see it ("" for one not named: their boat's name and number), its boat's name, whether a machine sailor's, whether the reader's own. */
export interface RaceEntrantIn {
  number: number;
  name: string;
  boat: string;
  machine: boolean;
  me: boolean;
}

/**
 * A race under way as the server tells it: its number in the world, its
 * link's code and its name ("" until read); its boats' kind, an index into
 * the catalog's boats; whether a time trial's run; its warning and start,
 * world ticks (a trial's start 0 until its boat crosses); the start line's
 * ends, the pin's then the committee boat's, and the finish line's; the
 * marks laid, each left to a side (1 starboard, −1 port, 0 a gate's); the
 * way sailed, start to finish; its legs, the points of the way a boat
 * makes for in turn, each a mark's number (0 a line); where it lies and
 * how far it reaches, m; its laps and its expected time, s; its boats; or,
 * gone, its course taken up.
 */
export interface RaceToldIn {
  race: number;
  code: string;
  name: string;
  boat: number;
  trial: boolean;
  run: number;
  warning: number;
  start: number;
  pin: RacePoint | null;
  committee: RacePoint | null;
  finish: [RacePoint, RacePoint] | null;
  marks: { east: number; north: number; number: number; side: number }[];
  way: RacePoint[];
  legs: { mark: number; east: number; north: number }[];
  east: number;
  north: number;
  reach: number;
  laps: number;
  expected: number;
  entrants: RaceEntrantIn[];
  gone: boolean;
}

/** A signal from a race's committee boat: what it signals, whether its gun fires, and a finish's boat and place. */
export interface RaceSignalIn {
  race: number;
  signal: 'warning' | 'preparatory' | 'start' | 'recall' | 'finish' | 'other';
  gun: boolean;
  number: number;
  place: number;
}

/** How a boat stands in its race. */
export type RacerStateIn =
  | 'dns'
  | 'placed'
  | 'racing'
  | 'finished'
  | 'retired'
  | 'placedAtEnd'
  | 'other';

/** A boat in a race's picture: its number; where, m, and its heading, degrees; its place (0 none); its gap to the first, s; seconds added; its state; the leg it makes for; its way to go, m; its cheers. */
export interface RacerAtIn {
  number: number;
  east: number;
  north: number;
  heading: number;
  place: number;
  gap: number;
  added: number;
  state: RacerStateIn;
  leg: number;
  toGo: number;
  cheers: number;
}

/** A race as it stands, every two seconds: the world's tick it was taken at, and every boat; eye, the number of the boat the page sails or watches (0 none). */
export interface RacePictureIn {
  race: number;
  tick: number;
  racers: RacerAtIn[];
  eye: number;
}

/** The crowd's cheers for a boat in a race, gathered every two seconds: how many since the last, how many cheered it within ten seconds, and whether the page's own cheer is among them. */
export interface RaceCheeredIn {
  race: number;
  number: number;
  count: number;
  crowd: number;
  mine: boolean;
}

/** A race's boat to watch: its race by number (0 for none) or its link's code, and its race number (0: the boat the game chooses). */
export interface RaceWatchAsk {
  race: number;
  code: string;
  number: number;
}

/** What a race's committee saw: a bump (number at fault, other bumped, by article, added seconds), a boat over early, a mark missed, a boat asked if it races still, a boat retired, a mark rounded (in place). */
export interface RaceCallIn {
  race: number;
  kind: 'bump' | 'overEarly' | 'missedMark' | 'drifting' | 'retired' | 'rounded' | 'other';
  number: number;
  other: number;
  article: string;
  mark: number;
  added: number;
  place: number;
}

/** A boat home: its place as it stands, its time from the start, ms, and the seconds added. */
export interface RaceFinishIn {
  race: number;
  number: number;
  place: number;
  elapsedMs: number;
  added: number;
}

/** What a boat came to: its place (0 none), how it ended (finished, placed, dns, ret), its time, ms (0 not home), seconds added, marks rounded, way still to go, m, a trial's medal and its awards. */
export interface RaceResultIn {
  number: number;
  place: number;
  how: string;
  elapsedMs: number;
  added: number;
  marks: number;
  toGo: number;
  medal: string;
  awards: string[];
}

/** A race's results as it ends, and whether its prizes were given. */
export interface RaceResultsIn {
  race: number;
  code: string;
  prizes: boolean;
  results: RaceResultIn[];
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
 * time), its nominal range (metres) and its lighthouse's fog signal (the
 * catalog's index). Never a name.
 */
export interface LightSeen {
  number: number;
  east: number;
  north: number;
  focal: number;
  character: number;
  phase: number;
  range: number;
  fogSignal: number;
}

/**
 * An encounter with the sea's life, as the server tells of it once the eye
 * is within its reach, and again when it changes: its id and revision, its
 * kind (the catalog's index), its start and end (ticks), its centre (metres
 * east and north), its heading (radians clockwise from north) and speed
 * (m/s), how many, its own seed, and the boat it is with: 0 none, 1 the
 * page's own boat or the one it watches, 2 + n the boat in view slot n,
 * 255 a boat the page does not see; and the encounter on whose patch it
 * comes, '' for none.
 */
export interface LifeSeen {
  id: string;
  rev: number;
  kind: number;
  start: number;
  end: number;
  east: number;
  north: number;
  heading: number;
  speed: number;
  count: number;
  seed: number;
  with: number;
  over: string;
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

/** A kind of island course: round an island, a tour of islands, port to port, round a lighthouse. */
export type CourseKind = 'round' | 'tour' | 'passage' | 'light';

/**
 * An island course open for racing, as the server tells of it once every
 * place it names is charted: its number among the world's, its kind and
 * name; its way, the shortest a boat sails, from the start to the finish,
 * points in metres east and north; its length, m; what it rounds or
 * passes, in order, each to its side; and the boats it suits, each by its
 * kind (the catalog's index) with its expected time in the typical wind, s.
 */
export interface CourseOpen {
  number: number;
  kind: CourseKind;
  name: string;
  way: [number, number][];
  length: number;
  rounds: { subject: ChartSubject; number: number; starboard: boolean }[];
  boats: { kind: number; seconds: number }[];
}

/** Whose boat a connection watches, as its Welcome says. */
/** The AI of an own machine sailor watched: at the helm, or gone quiet. */
export type LampState = 'helm' | 'quiet';

export interface WatchingTold {
  /** The sailor's name, as players see it. */
  sailor: string;
  /** A machine sailor, sailed by an AI agent; one of the account's own. */
  machine: boolean;
  mine: boolean;
  /** The sailor's look code. */
  look: number;
}

/** Whose boat the connection is aboard, as its crew, and its seat there. */
export interface AboardTold {
  /** The skipper's name, as players see it, and look code. */
  skipper: string;
  look: number;
  seat: number;
}

/**
 * Someone aboard a boat: their seat, look, name ("" for a spectator), a
 * machine sailor, the connection's own; whether the connection's account
 * mutes or blocks them; and whether they are its shipmate.
 */
export interface PersonTold {
  seat: number;
  look: number;
  name: string;
  machine: boolean;
  you: boolean;
  muted: boolean;
  blocked: boolean;
  shipmate: boolean;
  /** They wear the winner's cockade, for a race won in the world. */
  cockade?: boolean;
}

/**
 * Who is aboard the boat sailed, aboard or watched, the skipper (seat 0)
 * first, and the seat of whoever holds the controls. Whoever holds them
 * stands at the helm (station 0), the skipper at the holder's station,
 * everyone else at the station of their seat.
 */
export interface CrewTold {
  people: PersonTold[];
  holder: number;
}

/** Who is aboard a boat in view, by its view slot: each person's seat, look and machine mark, and the holder's seat; never a name. */
export interface ViewCrewTold {
  slot: number;
  people: { seat: number; look: number; machine: boolean; cockade?: boolean }[];
  holder: number;
}

/**
 * A boat's prizes, by its view slot as of the next snapshot, or the own
 * boat's (the boat sailed or watched): its prize code (render/prizes.ts)
 * and its race number while it races, 0 for none.
 */
export interface BoatPrizeTold {
  slot: number;
  own: boolean;
  prizes: number;
  number: number;
}

/** A knock waiting for the skipper's answer, or, gone, no longer waiting. */
export interface KnockCardTold {
  id: number;
  sailor: string;
  look: number;
  gone: boolean;
  /** A machine sailor sent aboard by its owner (their sailor's name), knocking on skipper's boat, the player's own machine sailor's. */
  machine?: { owner: string; skipper: string };
  /** A shipmate of the skipper's, knocking from their shipmates list. */
  shipmate?: boolean;
}

/** How the connection's own knock stands, or why it was refused. */
export type KnockStateTold =
  | 'waiting'
  | 'let'
  | 'not-now'
  | 'lapsed'
  | 'ended'
  | 'not-at-sea'
  | 'full'
  | 'closed'
  | 'busy'
  | 'often'
  | 'crowded'
  | 'own'
  | 'first'
  | 'try-again'
  | 'withdrawn'
  | 'away'
  | 'other';

/** The connection's own knock: how it stands, and the boat it is for. */
export interface KnockingTold {
  state: KnockStateTold;
  skipper: string;
  kind: number;
  boat: string;
  /** The player's machine sailor the knock sends aboard; absent or "" for the player. */
  machine?: string;
}

/** The controls offered to the connection, by whom and for how long; or, gone, no longer. */
export interface HandedTold {
  from: string;
  seconds: number;
  gone: boolean;
}

/** Why a line was not said; '' for a line said (or refused for a word, which is never told). */
export type ChatRefusalTold =
  | ''
  | 'contact'
  | 'long'
  | 'fast'
  | 'silent'
  | 'nobody'
  /** A shipmate's message: they aren't in the game, and nothing is kept for later. */
  | 'away'
  /** A shipmate's message: the game's owner has shipmates' messages off. */
  | 'resting';

/**
 * A line said aboard: its number (for mute, block and report), the
 * sender's seat, name and whether a machine sailor said it, when (ms of
 * UTC), and its text, all player text. To its sender it comes back with
 * you and echo (its Say's id), said or refused. A message between
 * shipmates names its thread: the other shipmate's account ID (to its
 * sender, whom it was to; to its receiver, who sent it); "" for a line
 * aboard.
 */
export interface ChatTold {
  id: number;
  seat: number;
  name: string;
  machine: boolean;
  at: number;
  text: string;
  you: boolean;
  echo: number;
  refused: ChatRefusalTold;
  thread: string;
}

/**
 * How chat stands for the connection: on; off by the game's owner; off by
 * the player's own switch; resting, until a time (ms of UTC, 0 until the
 * owner looks); and whether the Rules of the sea are still to be accepted.
 */
export interface ChatStateTold {
  status: 'on' | 'off' | 'own-off' | 'resting';
  until: number;
  rules: boolean;
}

/** A mute or a block in force or ended, for the person named; full: the list is full and nothing changed. */
export interface TiedTold {
  name: string;
  muted: boolean;
  blocked: boolean;
  full: boolean;
}

/** Someone aboard, for mute, block and report: by their seat, or by a line of theirs. */
export type WhoTold = { seat: number } | { line: number };

/** Why a player is reported, in the order offered. */
export type ReportReasonTold =
  | 'child'
  | 'sexual'
  | 'bullying'
  | 'hate'
  | 'threats'
  | 'scam'
  | 'cheating'
  | 'other';

/** Why the connection left the boat it was aboard. */
export type AshoreWhyTold = 'chose' | 'put' | 'left' | 'other';

/** What the net worker's Hello carries besides the protocol version. */
export interface HelloVersions {
  catalog: string;
  physicsLayout: number;
  build: string;
}

export type ToWorker =
  /** Connect to url, and keep connecting. */
  | { type: 'start'; url: string; versions: HelloVersions }
  /** The controls stepped for tick seq: the helm and sheet indices, the autopilot's control and the reef. */
  | {
      type: 'input';
      seq: number;
      helm: number;
      sheet: number;
      pilot: number;
      target: number;
      order: number;
      way: number;
      reef: number;
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
  /**
   * Watch a sailor's boat, rather than sail: asked at once on an open
   * connection, and by every Hello from then on.
   */
  | { type: 'watch'; sailor: string }
  /** Watch a race's boat, as watch does a sailor's. */
  | { type: 'watchRace'; ask: RaceWatchAsk }
  /** Cheer the boat watched in a race. */
  | { type: 'cheer' }
  /** A boat again, as a new connection gets one: the Hellos from then on ask for it too. */
  | { type: 'sail' }
  /** Stop watching, without sailing: the connection is idle. */
  | { type: 'unwatch' }
  /** Ask to come aboard by a link's token, or, without one, the boat a shipmate (their account ID) skippers. */
  | { type: 'knock'; token: string; machine: string; shipmate?: string }
  /** The skipper's answer to a knock. */
  | { type: 'answer'; knock: number; let: boolean }
  /** Offer the controls to the person in that seat. */
  | { type: 'hand'; to: number }
  /** Take the controls offered; the skipper's, take them back at once. */
  | { type: 'take' }
  /** Give the controls back to the skipper. */
  | { type: 'giveBack' }
  /** Go ashore (who 0), or, the skipper's, put the person in seat who ashore. */
  | { type: 'ashore'; who: number }
  /** Retires the boat from the race it sails in. */
  | { type: 'raceRetire' }
  /** Close the boat to knocks for this voyage, or open it again. */
  | { type: 'closeKnocks'; closed: boolean }
  /** Come aboard the own machine sailor watched, without knocking: knocking tells how it stands. */
  | { type: 'comeAboard' }
  /**
   * Say a line aboard, or, with to (a shipmate's account ID), a message to
   * that shipmate; id is the page's own number, which its echo carries.
   */
  | { type: 'say'; text: string; id: number; to?: string }
  /** Mute someone aboard, or no longer. */
  | { type: 'mute'; who: WhoTold; on: boolean }
  /** Block someone aboard, or no longer. */
  | { type: 'block'; who: WhoTold; on: boolean }
  /** Report someone aboard, with a note for the game's owner. */
  | { type: 'report'; who: WhoTold; reason: ReportReasonTold; note: string }
  /** The page is going: close with 1000. */
  | { type: 'stop' }
  /** A snapshot record read, for the worker to fill again. */
  | { type: 'return'; data: ArrayBuffer };

/** Where the connection stands. */
export type Status =
  /** Opening, or open and waiting for the Welcome. */
  | 'connecting'
  /** Welcomed: snapshots arrive, of the own boat or of the one watched. */
  | 'sailing'
  /** The sea is full: waiting in the queue for a boat, or for a place to watch. */
  | 'queued'
  /** Open, with no boat and watching none: a watch ended or was refused. */
  | 'idle'
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
      /** The world's harbour, m east and north of the centre; null in a world without land. */
      harbour: Harbour | null;
      /** When the world ends and its last days begin, µs of UTC since 1970; 0 for no end known. */
      endsUs: number;
      closingUs: number;
      /** The zone the schedule's ends are published in; "" for UTC. */
      zone: string;
      /** The boat watched, whose the boat and kind are; null for the connection's own. */
      watching: WatchingTold | null;
      /** The boat the connection is aboard as crew, whose the boat and kind are; null for none. */
      aboard: AboardTold | null;
      /** The look code of the boat's sailor: the connection's own, or the one watched. */
      look: number;
      /** The boat's own look code, its paint, cloth and sail number; and its name, "" for none. */
      boatLook: number;
      boatName: string;
      /**
       * The connection's first Welcome. A later one, a watch begun or the
       * own boat back, is sent nothing again that the connection was
       * handed: its chart, forecast, land, lights and caps stand.
       */
      first: boolean;
    }
  /** The account's owner's flag was set or cleared. */
  | { type: 'tools'; on: boolean }
  /** A snapshot record: view.ts's FLEET_RECORD_BYTES. */
  | { type: 'snapshot'; data: ArrayBuffer }
  /** The place in the queue, 1 for the next, and how many wait: for a boat, or for a place to watch. */
  | { type: 'queued'; position: number; waiting: number; spectators: boolean }
  /** A watch ended, or was refused: why, and the sailor's name. */
  | { type: 'watchEnded'; why: WatchEndWhy; sailor: string }
  /** How many watch the connection's own boat. */
  | { type: 'watchers'; count: number }
  /** A knock on the skipper's boat, or one no longer waiting. */
  | { type: 'knockCard'; card: KnockCardTold }
  /** How the connection's own knock stands. */
  | { type: 'knocking'; knocking: KnockingTold }
  /** Who is aboard the boat sailed, aboard or watched. */
  | { type: 'crew'; crew: CrewTold }
  /** The controls offered to the connection, or the offer gone. */
  | { type: 'handed'; handed: HandedTold }
  /** The connection left the boat it was aboard: its own boat's Welcome, or a Queued, follows. */
  | { type: 'ashore'; why: AshoreWhyTold }
  /** A line said aboard, or the connection's own back, said or refused. */
  | { type: 'chat'; chat: ChatTold }
  /** How chat stands for the connection. */
  | { type: 'chatState'; state: ChatStateTold }
  /** A mute or a block in force, or ended. */
  | { type: 'tied'; tied: TiedTold }
  /** A report received, or (ok false) not kept. */
  | { type: 'reported'; ok: boolean }
  /** The account's shipmates changed: the list is to be read again. Never what changed. */
  | { type: 'shipmates' }
  /** Whether the AI of the own machine sailor watched attends to it: at the helm, or quiet. */
  | { type: 'lamp'; state: LampState }
  /** The sailor of the boat sailed or watched changed their look, at Port Royal: its code. */
  | { type: 'look'; look: number }
  /** The boat sailed or watched was given a new look in port: its boat look code and name. */
  | { type: 'boatLook'; look: number; name: string }
  /** The names of boats in view, by view slot, as of the next snapshot: player text, "" for none. */
  | { type: 'boatNames'; names: { slot: number; name: string }[] }
  /** What boats in view, and the own boat, fly for their skippers' races in the world. */
  | { type: 'boatPrizes'; prizes: BoatPrizeTold[] }
  /** Who is aboard boats in view, by view slot, as of the next snapshot: no people for nobody but the skipper. */
  | { type: 'crews'; crews: ViewCrewTold[] }
  /** The server is about to restart, in about inMs: the bell. */
  | { type: 'restart'; inMs: number }
  /** The sea about the boat, for the prediction and the drawing. */
  | { type: 'sea'; sea: SeaAreas }
  /**
   * The spells of weather in play, for the prediction's wind and the
   * drawing of the gusts, or null if those held still are; and keyframes
   * of the weather systems, each replacing any held of its tick; and the
   * coming front, a coming record's values, which replaces any held.
   */
  | {
      type: 'weather';
      spells: WeatherSpells | null;
      keyframes: WeatherKeyframe[];
      coming: number[];
    }
  /** Islands whose caps come into sight, and islands to drop, by number. */
  | { type: 'caps'; caps: CapSeen[]; drop: number[] }
  /** The boat, or one near it, touched another. */
  | { type: 'bump'; bump: BumpTold }
  /** A race told, or taken up; a signal from its committee boat. */
  | { type: 'raceTold'; told: RaceToldIn }
  | { type: 'raceSignal'; signal: RaceSignalIn }
  /** A race's picture, a call, a boat home, its results. */
  | { type: 'racePicture'; picture: RacePictureIn }
  | { type: 'raceCall'; call: RaceCallIn }
  | { type: 'raceFinish'; finish: RaceFinishIn }
  | { type: 'raceResults'; results: RaceResultsIn }
  /** The crowd's cheers for a boat of the race. */
  | { type: 'raceCheered'; cheered: RaceCheeredIn }
  /** Chunks of the land the boat could see: their addresses to fetch. */
  | { type: 'chunks'; chunks: ChunksHanded }
  /** The places in chunks just handed. */
  | { type: 'places'; places: PlaceSeen[] }
  /** Lights come into range, and lights to drop, by number. */
  | { type: 'lights'; lights: LightSeen[]; drop: number[] }
  /** The sea's life come within reach or changed, and encounters to drop, by id. */
  | { type: 'life'; life: LifeSeen[]; drop: string[] }
  /** The world's chart: whole after a Welcome, or what was charted since; and the courses open. */
  | { type: 'chart'; entries: ChartEntry[]; courses: CourseOpen[]; whole: boolean }
  /** The forecast as it is issued, with what has been after a Welcome. */
  | { type: 'forecast'; forecast: ForecastTold; past: PastTold | null }
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
  /** Inputs sent that carried the controls, not only an acknowledgement. */
  controls: number;
}

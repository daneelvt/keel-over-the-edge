// SPDX-License-Identifier: AGPL-3.0-only

// What the world page reads and asks of keel's internal listener, under
// /owner/api/, beside the page itself: the world as it is now (once a
// second), the gusts' grid, the islands, the places and lights, the
// current and the land, once a world; the world's life, and its week of
// weather at a tick, every few seconds; the pressure at a point clicked;
// the next world's terrain and week under next/ once it is made; and the
// controls, each a POST of JSON.

/** A boat at sea, as the page shows it. */
export interface Boat {
  boat: number;
  account: string;
  sailor: string;
  human: boolean;
  kind: string;
  east: number;
  north: number;
  /** Degrees clockwise from north. */
  heading: number;
  knots: number;
  /** Metres inside the lip. */
  fromLip: number;
  connected: boolean;
  /** Seconds of its grace left, 0 while connected. */
  grace: number;
  falling: boolean;
  stays: boolean;
  unseen: boolean;
  tools: boolean;
  /** Its owner's free camera, east and north, while it roams. */
  eye: [number, number] | null;
}

/** A connection waiting for a boat. */
export interface Waiting {
  account: string;
  sailor: string;
  tools: boolean;
  /** Seconds waited. */
  waited: number;
  connected: boolean;
}

export interface WorldInfo {
  number: number;
  id: string;
  seed: string;
  generator: number;
  digest: string;
  epoch: string;
  made: string;
  /** The lip, the mist band's beginning and the calm water's ring, m from the centre. */
  lip: number;
  mist: number;
  calm: number;
}

export interface Weather {
  regime: string;
  steady: boolean;
  held: boolean;
  knots: number;
  from: number;
  drift: number;
  gust: number;
  next: number;
  nextIn: number;
}

/** world.json: the world as it is now. */
export interface WorldNow {
  tick: number;
  worldTime: number;
  hour: number;
  world: WorldInfo;
  weather: Weather;
  /** The mean wind: east, north, knots, the degrees it comes from. */
  wind: { step: number; points: [number, number, number, number][] };
  boats: Boat[];
  queue: Waiting[];
}

export interface Island {
  number: number;
  name: string;
  kind: string;
  biome: string;
  size: string;
  zone: string;
  group: number;
  east: number;
  north: number;
  across: number;
  area: number;
  highest: number;
  /** Its drawing's bounds: west, south, east, north. */
  bounds: [number, number, number, number];
  /** Where a boat is put to sail to it. */
  approach: [number, number];
  /** Its scenic quality, by the seven factors and in all, and its class, A, B or C. */
  score: number;
  class: string;
  scenery: Record<string, number>;
  /** Its age, if volcanic; its features' kinds; the plants that grow on it. */
  age?: string;
  features: string[];
  flora: string[];
}

/** A kind of feature as the page lists and marks it. */
export interface FeatureKind {
  id: string;
  name: string;
  site: string;
  mark: string;
}

/** A feature: its kind, island, place and height, and where a boat sees it from. */
export interface Feature {
  number: number;
  kind: string;
  island: number;
  east: number;
  north: number;
  height: number;
  size: number;
  seen: boolean;
  approach: [number, number] | null;
}

export interface FeaturesData {
  kinds: FeatureKind[];
  features: Feature[];
}

/** A subject charted: by whom (empty for one known from the start or charted with another), when (ms), and its worth. */
export interface Charted {
  subject: 'island' | 'place' | 'feature';
  number: number;
  by: string;
  ai: boolean;
  at: number;
  worth: number;
}

/** charted.json: what is charted, the oldest first, and how many there are to chart. */
export interface ChartedData {
  subjects: number;
  charted: Charted[];
}

export interface Group {
  number: number;
  name: string;
  east: number;
  north: number;
  members: number[];
}

/** A kind of place, as the page lists and marks it. */
export interface PlaceKind {
  id: string;
  name: string;
  /** The rule its sites are found by: harbour, light, wreck … */
  site: string;
  mark: string;
}

/** A light's character: its notation, colour and steps (ms, light and dark in turn). */
export interface LightCharacter {
  notation: string;
  colour: string;
  steps: number[];
}

/** A place: a port, a lighthouse, a reef, a wreck. */
export interface Place {
  number: number;
  kind: string;
  name: string;
  island: number;
  east: number;
  north: number;
  zone: string;
  details: {
    depth?: number;
    shelter?: string;
    across?: number;
    mouth?: number;
    length?: number;
    offshore?: boolean;
    offers: string[];
    ship?: {
      name: string;
      language: string;
      rig: string;
      cargo: string;
      age: string;
      sunk: boolean;
      heel: number;
    };
  };
  /** Where a boat is put to sail to it, or null if there is nowhere. */
  approach: [number, number] | null;
}

/** A lighthouse's light. */
export interface Light {
  number: number;
  place: number;
  name: string;
  role: string;
  east: number;
  north: number;
  focal: number;
  tower: number;
  /** Its nominal range, m. */
  range: number;
  character: number;
  notation: string;
  /** As charts write it: Fl(3) W 15s 85m 4.5M. */
  chart: string;
  /** µs of world time. */
  phase: number;
}

/** places.json: the kinds of place, the characters, and the world's places and lights. */
export interface PlacesData {
  kinds: PlaceKind[];
  characters: LightCharacter[];
  places: Place[];
  lights: Light[];
}

/** A town: Port Royal's, a port's or a fishing village's. */
export interface Town {
  number: number;
  kind: 'main' | 'port' | 'village';
  name: string;
  island: number;
  east: number;
  north: number;
  buildings: number;
  /** Its buildings and props, by their kinds' names. */
  counts: Record<string, number>;
  /** Its piers', jetty's and mole's lengths, m. */
  piers: number[];
  streets: number;
  moorings: number;
  /** Where a teleport to its harbour puts a boat, or null if none may. */
  harbour: [number, number] | null;
}

/** towns.json: the world's towns. */
export interface TownsData {
  towns: Town[];
}

/** current.json: east, north, and the current there east and north, m/s. */
export interface Current {
  step: number;
  points: [number, number, number, number][];
}

/** What is at a point clicked. */
export interface Point {
  east: number;
  north: number;
  elevation: number;
  fromLip: number;
  island: string;
  number: number;
  off: number;
  /** Why a boat may not be put there, or "" if it may. */
  water: string;
}

/** A run of one of keel's jobs about the world's life. Times are ms of UTC, 0 for none. */
export interface JobRun {
  /** next-world, closing, switch, sessions or worlds. */
  job: string;
  due: number;
  started: number;
  /** 0 while it runs. */
  finished: number;
  outcome: 'ok' | 'failed' | 'skipped' | '';
  detail: string;
  attempts: number;
}

/** The next world: its number, its seed, when it was made and its terrain stored. */
export interface NextWorld {
  number: number;
  /** A whole number to 2⁶⁴, so a string. */
  seed: string;
  created: number;
  stored: boolean;
  storedAt: number;
  attempts: number;
  generationMs: number;
}

/**
 * lifecycle.json: the world's life. Times are ms of UTC, 0 for none; now is
 * keel's clock, which the page counts by.
 */
export interface Lifecycle {
  now: number;
  schedule: string;
  /** The schedule's zone, "" for a schedule of periods. */
  zone: string;
  world: number;
  began: number;
  ends: number;
  closing: boolean;
  closingFrom: number;
  nextMadeAt: number;
  /** The last moment the next world may be made again. */
  remakeUntil: number;
  switching: boolean;
  next: NextWorld | null;
  runs: JobRun[];
}

/** A kind of weather system: its name, and the shape of the pressure it carries: dome, low or none. */
export interface SystemKind {
  id: string;
  shape: string;
}

/**
 * A spell of the week's weather, from its beginning to the next's, ticks.
 * A spell with a front has it cross the disk from its beginning, over
 * cross ticks, its line over the centre halfway.
 */
export interface Spell {
  begin: number;
  end: number;
  /** Its regime, by index into the regimes' names. */
  regime: number;
  /** Degrees the wind comes from, its knots at mid-disk, and the pressure, hPa. */
  from: number;
  knots: number;
  pressure: number;
  front: boolean;
  /** Degrees: the way its front moves. */
  toward: number;
  cross: number;
  /** A developer's, holding the weather. */
  held: boolean;
}

/** A weather system alive at the tick shown. */
export interface WeatherSystem {
  slot: number;
  /** Its kind, by index into the kinds. */
  kind: number;
  east: number;
  north: number;
  /** Its radius, m. */
  size: number;
  /** Its life and swell, 1 at full. */
  strength: number;
  /** 0 growing, 1 mature, 2 decaying. */
  stage: number;
  /** Degrees: the way it moves. */
  heading: number;
  knots: number;
  born: number;
  gone: number;
  developer: boolean;
  /** Where it truly is every five minutes for the hour after, while it lives, the first point now. */
  track: [number, number][];
}

/** A front crossing the disk: its line square to the way it moves, line metres from the centre along it. */
export interface Front {
  toward: number;
  line: number;
  knots: number;
  /** hPa. */
  depth: number;
  enters: number;
  leaves: number;
  /** The tick its line passes Port Royal. */
  portRoyal: number;
}

/**
 * The pressure over the disk, hPa: side by side points, step metres apart,
 * row by row from the north-west, null beyond the lip.
 */
export interface PressureGrid {
  step: number;
  side: number;
  values: (number | null)[];
}

/** weather.json: a world's week of weather, and its weather at a tick. */
export interface WeatherWeek {
  /** The world's tick now, 0 for a world not begun, and the tick shown. */
  now: number;
  at: number;
  ticksPerSecond: number;
  /** Tick 0, ms of UTC. */
  epoch: number;
  /** The tick the week reaches to, and the tick the world ends at. */
  until: number;
  ends: number;
  /** Ticks between keyframes. */
  every: number;
  lip: number;
  mainPort: [number, number];
  /** The regimes' names, by index. */
  regimes: string[];
  kinds: SystemKind[];
  spells: Spell[];
  /** The ticks the week's storms are born at. */
  storms: number[];
  /** The spell in effect at the tick shown, and the next to begin after it. */
  spell: Spell | null;
  next: Spell | null;
  systems: WeatherSystem[];
  front: Front | null;
  pressure: PressureGrid;
}

/** pressure.json: the pressure at a point, its change over the quarter of an hour before, and the barometer's words. */
export interface PressureAt {
  at: number;
  hPa: number;
  change: number;
  tendency: string;
}

/** The gusts' grid: GUST_SIDE a side over the square of the land's chart, a signed byte a point. */
export const GUST_STEP = 0.1;
export const NO_GUST = -128;

/** The page's API, relative to the page: /owner/api/. */
const BASE = 'api/';

async function get(path: string): Promise<Response> {
  const res = await fetch(BASE + path, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function getJSON<T>(path: string): Promise<T> {
  return (await get(path)).json() as Promise<T>;
}

export async function getBytes(path: string): Promise<Int8Array> {
  return new Int8Array(await (await get(path)).arrayBuffer());
}

/**
 * A world's weather under prefix ("" for the current world's, "next/" for
 * the next's), at a tick or now; null for a world with no week of weather.
 */
export async function getWeather(prefix: string, at: number | null): Promise<WeatherWeek | null> {
  const path = `${prefix}weather.json${at === null ? '' : `?at=${Math.round(at)}`}`;
  const res = await fetch(BASE + path, { cache: 'no-store' });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<WeatherWeek>;
}

/** The pressure at a point of the current world, at a tick or now. */
export function getPressure(east: number, north: number, at: number | null): Promise<PressureAt> {
  const tick = at === null ? '' : `&at=${Math.round(at)}`;
  return getJSON<PressureAt>(
    `pressure.json?east=${east.toFixed(2)}&north=${north.toFixed(2)}${tick}`,
  );
}

/** A URL of the land's drawings, for an image. */
export function drawing(path: string): string {
  return BASE + path;
}

/** What a control answered: ok, or why not. */
export interface Answer {
  ok: boolean;
  status: number;
  text: string;
}

/** The controls, each under /owner/api/. */
export type Control = 'flag' | 'place' | 'unseen' | 'world' | 'next';

/** Works a control: a POST of JSON, done on any 2xx (202 for one under way). */
export async function control(path: Control, body: unknown): Promise<Answer> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: (await res.text()).trim() };
}

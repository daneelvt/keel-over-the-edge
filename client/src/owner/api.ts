// SPDX-License-Identifier: AGPL-3.0-only

// What the world page reads and asks of keel's internal listener, under
// /owner/api/, beside the page itself: the world as it is now (once a
// second), the gusts' grid, the islands, the places and lights, the
// current and the land, once a world; and the controls, each a POST of
// JSON.

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

/** Works a control: a POST of JSON. */
export async function control(
  path: 'flag' | 'place' | 'unseen' | 'world',
  body: unknown,
): Promise<Answer> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: (await res.text()).trim() };
}

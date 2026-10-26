// SPDX-License-Identifier: AGPL-3.0-only

// What the world page reads and asks of keel's internal listener, under
// /owner/api/, beside the page itself: the world as it is now (once a
// second), the gusts' grid, the islands, the places and lights, the
// current and the land, once a world; the world's life, and its week of
// weather at a tick, every few seconds; the pressure at a point clicked;
// the sea, its areas' waves and swell and the waves at a point clicked,
// every ten seconds while it is shown; the clouds and the rain, every ten
// seconds while either is shown; the forecast at the tick shown, with how
// well it has held so far and the world's gale warnings, while it is
// shown; a place's box and outlook at the tick shown, for a point, an
// island or a place picked; the next world's terrain and week under next/
// once it is made; the players' accounts, searched by name, id or token,
// and an account's card; and the controls, each a POST of JSON, among them
// the token lifetime of AI apps' grants, an account's machine sailors and
// priority, and an account stopped, started again, its tokens revoked or
// deleted.

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
  /** A machine sailor's boat, as the world holds it. */
  machine: boolean;
  /** The account's priority, which its next join takes; and whether this boat was given as a priority account's. */
  priority: boolean;
  admitted: boolean;
  /** A machine boat's agent, while keel knows of it. */
  agent?: Agent;
}

/** A machine boat's agent: its app, the seconds since its last call (null for none), how long its observe has waited so far and its calls refused. */
export interface Agent {
  app: string;
  sinceCall: number | null;
  waiting: number;
  refusals: number;
}

/**
 * Admission by kind: the boats at sea and the places waiting, of humans and
 * of machine sailors; the machine sailors' cap and the places kept for
 * them; and the rules their agents are held to: the silence, s (0 when not
 * told), and the budgets of orders and looks.
 */
export interface Admission {
  humans: number;
  machines: number;
  humansWaiting: number;
  machinesWaiting: number;
  aiCap: number;
  aiReserve: number;
  aiSilence: number;
  aiOrders?: string;
  aiLooks?: string;
}

/** A connection waiting for a boat. */
export interface Waiting {
  account: string;
  sailor: string;
  tools: boolean;
  /** Seconds waited. */
  waited: number;
  connected: boolean;
  /** A machine sailor's place, and its position among those of its kind, 1 for the head. */
  machine: boolean;
  position: number;
  /** The account's priority, and whether this place waits as a priority account's. */
  priority: boolean;
  admitted: boolean;
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
  admission: Admission;
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

/**
 * accounts.json: the players' accounts, those made in the last week, and
 * those seen in the last day; the accounts stopped, of humans and of
 * machine sailors; and, while sign-in for AI apps runs, the machine
 * sailors, those made in the last week, the grants live by kind, and the
 * token lifetime, s.
 */
export interface AccountsData {
  total: number;
  week: number;
  today: number;
  stopped?: { human: number; ai: number };
  machines?: {
    total: number;
    week: number;
    grants: { app?: number; connection?: number };
    lifetime: number;
  };
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
  /** Its position as charts write it: 67°24′N 045°12′. */
  position: string;
  elevation: number;
  fromLip: number;
  island: string;
  number: number;
  off: number;
  /** Why a boat may not be put there, or "" if it may. */
  water: string;
  /** The sky there now; null for a world not yet sailed. */
  sky: SkyPoint | null;
}

/** The sky at a point: its rain, the three sheets' cover, the heaped cloud over it, and its visibility. */
export interface SkyPoint {
  /** mm an hour, and its word. */
  rain: number;
  rainWord: 'none' | 'light' | 'moderate' | 'heavy' | 'violent';
  /** Each sheet's cover, 0 to 1. */
  sheets: { cirrus: number; middle: number; low: number };
  /** The heaped cloud overhead, the tallest if more than one; null for none. */
  cloud: { form: CloudForm; slot: number; top: number } | null;
  /** The visibility at the sea 2 m up, m, its word, and each thing's share of the air's extinction, 0 to 1. */
  visibility: number;
  visibilityWord: VisibilityWord;
  air: AirShares;
}

/** Visibility's words, the Met Office's marine ones. */
export type VisibilityWord = 'good' | 'moderate' | 'poor' | 'very poor';

/** The shares of the air's extinction at a point, 0 to 1: the clear air's, the fog's, the rain's and the mist's. */
export interface AirShares {
  clear: number;
  fog: number;
  rain: number;
  mist: number;
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
  /** The version of the world generator it was made by. */
  generator: number;
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
  /** When the schedule makes the next world: in the past for a world begun inside its last day. */
  nextMadeAt: number;
  /** The last moment the next world may be made or begun by hand. */
  remakeUntil: number;
  switching: boolean;
  /** Whether a next world is being made now, on the schedule or by hand. */
  making: boolean;
  /** The version of the world generator keel makes worlds with now. */
  generator: number;
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
  /** The significant height of its swell at its edge at full strength, m; 0 for a kind that raises none. */
  swell: number;
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

/** A sea area: its waves, its swell, and how much the current raises its waves. */
export interface SeaArea {
  /** The waves' significant height, m, and the wind sea's and the swell's. */
  hs: number;
  windHs: number;
  swellHs: number;
  /** The swell's peak period, s, and the degrees it comes from. */
  period: number;
  from: number;
  /** The waves' height over their height in still water: above 1 where a current against them steepens them. */
  raised: number;
  /** The wind the waves are raised by: the degrees it comes from, and its knots. */
  windFrom: number;
  windKnots: number;
}

/** The sea at a point: its wind sea and its swell, the current's and the lee's factors, and the waves' height there. */
export interface SeaPoint {
  east: number;
  north: number;
  /** m and s. */
  windHs: number;
  windPeriod: number;
  swellHs: number;
  swellPeriod: number;
  /** Degrees the swell comes from. */
  swellFrom: number;
  /** How much the current raises the wind sea along its way. */
  current: number;
  /** The share of the waves the land's lee leaves, 1 in open water. */
  lee: number;
  /** The waves' significant height there, in the lee, m. */
  hs: number;
}

/**
 * sea.json: the sea now, side areas a side, each size metres across, row by
 * row from the south-west, the disk's centre at the middle one's; and the
 * sea at a point if one was asked about.
 */
export interface SeaPage {
  tick: number;
  side: number;
  size: number;
  areas: SeaArea[];
  point?: SeaPoint;
}

/** A heaped cloud's form. */
export type CloudForm = 'cumulus' | 'cumulonimbus' | 'storm';

/** A heaped cloud: a squall's, a shower's or a storm's. Distances in m. */
export interface HeapedCloud {
  form: CloudForm;
  /** Its system's slot. */
  slot: number;
  east: number;
  north: number;
  /** Degrees, the way it moves. */
  heading: number;
  /** Its system's radius. */
  size: number;
  /** Its cloud strength, 0 to 1. */
  cloud: number;
  base: number;
  top: number;
  /** How far its top reaches behind its centre and ahead of it, along its heading. */
  behind: number;
  ahead: number;
  /** Its deck's reach and top. */
  deck: number;
  deckTop: number;
  /** Its rain at its core, mm an hour, and how far from its centre it falls at a millimetre an hour or more. */
  rain: number;
  rainReach: number;
}

/** A grid over the disk: side points a side, step metres apart, row by row from the north-west point at west, north; 0 beyond its reach. */
export interface CloudGrid {
  west: number;
  north: number;
  step: number;
  side: number;
  values: number[];
}

/** A fair-weather cumulus: its radius and top at its whole, m, and how much of itself it is now. */
export interface Cumulus {
  east: number;
  north: number;
  radius: number;
  top: number;
  grow: number;
}

/** clouds.json: the clouds and the rain now. */
export interface CloudsPage {
  tick: number;
  lip: number;
  /** The sheets' heights: cirrus, middle and low, m. */
  layers: [number, number, number];
  /** Rain is light under the first, moderate under the second, heavy under the third and violent above, mm an hour. */
  words: [number, number, number];
  clouds: HeapedCloud[];
  /** Three values a point: the cirrus's, the middle sheet's and the low cloud's cover, 0 to 1; beyond the lip too. */
  sheets: CloudGrid;
  /** mm an hour. */
  rain: CloudGrid;
  cumulus: Cumulus[];
}

/** A flash of the last minute: where it struck, to the sea or in the cloud. */
export interface Flash {
  /** Its system's slot. */
  slot: number;
  /** Its first stroke's tick. */
  tick: number;
  east: number;
  north: number;
  /** It struck the sea; otherwise it stayed in the cloud. */
  sea: boolean;
  strokes: number;
}

/** A light as it shows now. */
export interface LightNow {
  number: number;
  east: number;
  north: number;
  /** Its fog signal as charts write it; "" for none. */
  signal: string;
  /** Its fog signal is blasting, the visibility at it under the threshold as the blast began. */
  sounding: boolean;
  /** Lit: by night, or with the visibility at it poor or worse; byDay, lit while the sun is up. */
  lit: boolean;
  byDay: boolean;
}

/** visibility.json: the fog, the lightning and the lights now. */
export interface VisibilityPage {
  tick: number;
  lip: number;
  /** Very poor under the first, poor under the second, moderate under the third and good above, m. */
  words: [number, number, number];
  /** A fog signal sounds while the visibility at its light is under this, m. */
  sounds: number;
  /** The visibility at the sea, m; 0 beyond the lip. */
  grid: CloudGrid;
  flashes: Flash[];
  lights: LightNow[];
}

/**
 * A system as the forecast gives it: at each step where it will be, east
 * and north, its cone's radius, m, and its strength, 0 to 1; all 0 at a
 * step it is not alive at.
 */
export interface ForecastSystem {
  slot: number;
  /** Its kind, by index into the week's kinds, and its kind's id. */
  kind: number;
  id: string;
  /** A low not yet born at the issue, forecast by its plan: its cone a constant circle. */
  forming: boolean;
  /** The tick it is forecast to cross the lip onto the disk; 0 for one on it. */
  crosses: number;
  steps: [number, number, number, number][];
}

/**
 * A front as the forecast moves it: at each step its line's distance from
 * the centre along the way it moves, and its band's half-width, m; null at
 * a step it is not crossing.
 */
export interface ForecastFront {
  /** Degrees: the way it moves. */
  toward: number;
  begin: number;
  cross: number;
  lines: ([number, number] | null)[];
}

/** A spell as the forecast names it, with its regime's risk: what it brings that no forecast places. */
export interface ForecastSpell {
  begin: number;
  regime: number;
  id: string;
  /** Degrees its wind comes from, its knots at mid-disk, and how far its shifts turn it either way together. */
  from: number;
  knots: number;
  front: boolean;
  shifts: number;
  /** The sky its regime's risk names, whether it makes fog patches, and the chart's marks of it. */
  risk: string;
  fog: boolean;
  marks: string[];
}

/** The gale warning in force. */
export interface ForecastGale {
  /** The issue it came into force at. */
  key: number;
  force: number;
  words: string;
  /** The charted island or place it is told from; "" for none. */
  place: string;
  /** Its first step. */
  first: number;
  /** Where it blows strongest, its mean wind and gust there, knots, and the degrees it first blows from. */
  east: number;
  north: number;
  mean: number;
  gust: number;
  from: number;
  /** Each step's points of the grid in a gale, a bit a point (point n the bit n mod 8 of byte n / 8), in base64; "" for none. */
  areas: string[];
}

/**
 * forecast.json: the issue in force at the tick shown, the issue's own step
 * first; the gale grid galeSide points a side, galeGrid m apart about the
 * centre, row j north and column i east of its south-west point.
 */
export interface ForecastPage {
  at: number;
  issue: number;
  /** As the players were sent it; otherwise made on the page's asking from the week. */
  issued: boolean;
  /** Ticks between steps, and how many. */
  step: number;
  steps: number;
  lip: number;
  systems: ForecastSystem[];
  fronts: ForecastFront[];
  spells: ForecastSpell[];
  gale: ForecastGale | null;
  galeGrid: number;
  galeSide: number;
}

/**
 * calibration.json: of every issue from the world's beginning whose horizon
 * has passed, at each lead (minutes), the cases inside their cones and the
 * cases, of the systems alive at the issue, the lows forming and the fronts.
 */
export interface CalibrationPage {
  now: number;
  from: number;
  next: number;
  issues: number;
  leads: number[];
  alive: [number, number][];
  forming: [number, number][];
  fronts: [number, number][];
}

/** A gale warning of the world: the issues it was in force at, its most force, and its words as first told. */
export interface GaleWarning {
  key: number;
  last: number;
  inForce: boolean;
  force: number;
  words: string;
  /** Degrees it first blew from, and its strongest point. */
  from: number;
  east: number;
  north: number;
}

/** gales.json: every gale warning of the world to the issue in force now, the oldest first. */
export interface GalesPage {
  now: number;
  issue: number;
  /** Ticks between issues. */
  every: number;
  warnings: GaleWarning[];
}

/** A place's box: its lines of wind, gusts, sky, visibility and barometer. */
export interface Box {
  wind: string;
  gusts: string;
  sky: string;
  visibility: string;
  barometer: string;
}

/** place.json: a place's box at a tick, its outlook from the issue in force, and its position. */
export interface PlaceWeather {
  at: number;
  issue: number;
  east: number;
  north: number;
  position: string;
  /** The island's or place's name; "" for a point. */
  name: string;
  box: Box;
  outlook: string;
}

/** What a place's weather is asked of: a point, an island or a place, by number. */
export type PlaceOf = { island: number } | { place: number } | null;

/** How the accounts found are ordered: by last active, oldest or newest first; the newest made first; or by the machine sailors' latest call. */
export type Sort = 'active-old' | 'active-new' | 'made' | 'machines';

/** What a row of the accounts found shares with its machine sailors'. Times are ms, 0 for never. */
interface Found {
  id: string;
  name: string;
  made: number;
  /** In words: "today", "41 days ago", "never", "at sea now". */
  lastActive: string;
  lastActiveAt: number;
  atSea: boolean;
  queued: boolean;
  priority: boolean;
  stopped: boolean;
  /** One the search itself hit. */
  matched: boolean;
}

/** A machine sailor under its human, stopped when it or its human is. */
export type MachineRow = Found;

/** A human's account found, with its machine sailors. */
export interface AccountRow extends Found {
  tools: boolean;
  machines: MachineRow[];
}

/** accounts/search: a page of the humans' accounts found, and words about what the text was taken for. */
export interface SearchAnswer {
  found: 'all' | 'name' | 'id' | 'token' | 'session';
  note: string;
  total: number;
  page: number;
  pages: number;
  sort: Sort;
  accounts: AccountRow[];
}

/** A passkey of a human's account. */
export interface CardPasskey {
  madeOn: string;
  made: number;
  lastUsed: number;
  synced: boolean;
  cloneWarning: boolean;
}

/** An AI app approved for a machine sailor, and how its grant ended if it has. */
export interface CardApp {
  id: string;
  name: string;
  returnHost: string;
  loopback: boolean;
  approved: number;
  lastUsed: number;
  ends: number;
  ended: boolean;
  endedHow?: string;
}

/** A machine sailor's connection token. */
export interface CardToken {
  id: string;
  made: number;
  lastUsed: number;
  ends: number;
  ended: boolean;
}

/** What was done to an account, by the page or by keel's admin command, and from where. */
export interface AccountAction {
  at: number;
  action: string;
  account: string;
  kind: string;
  name: string;
  detail: string;
  source: string;
  from: string;
}

/**
 * account.json: an account's card. Times are ms, 0 for never. A human's has
 * its passkeys, sessions, fleet, cap and machine sailors' cards; a machine
 * sailor's its human, its look in words, its apps and its connection
 * token; the card asked for has the record of what was done to it.
 */
export interface AccountCard {
  id: string;
  kind: 'human' | 'ai';
  name: string;
  look: string;
  made: number;
  lastActive: string;
  lastActiveAt: number;
  tools: boolean;
  priority: boolean;
  /** byOwner: a machine sailor stopped only because its human is. */
  stopped: { at: number; reason: string; byOwner: boolean } | null;
  sea: { boat: number; east: number; north: number; connected: boolean; grace: number } | null;
  queue: { position: number } | null;
  passkeys?: CardPasskey[];
  recoveryMade?: number;
  sessions?: { count: number; latest: number };
  fleet?: Record<string, number>;
  cap?: number;
  machines?: AccountCard[];
  owner?: { id: string; name: string };
  lookWords?: string;
  apps?: CardApp[];
  token?: CardToken | null;
  /** One of the owner's own: flagged, or a flagged human's machine sailor. */
  own: boolean;
  actions?: AccountAction[];
}

/** What an action on an account would do, with check, or did: the words the confirmation shows. */
export interface ActionAnswer {
  account: string;
  action: string;
  done: boolean;
  words: string;
  own: boolean;
  effects: { machines: number; sessions: number; grants: number; boats: number };
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

/** The sea of the current world now, and at a point if one is given. */
export function getSea(at: [number, number] | null): Promise<SeaPage> {
  const point = at === null ? '' : `?east=${at[0].toFixed(2)}&north=${at[1].toFixed(2)}`;
  return getJSON<SeaPage>(`sea.json${point}`);
}

/** The clouds and the rain of the current world now. */
export function getClouds(): Promise<CloudsPage> {
  return getJSON<CloudsPage>('clouds.json');
}

/** The fog, the lightning and the lights of the current world now. */
export function getVisibility(): Promise<VisibilityPage> {
  return getJSON<VisibilityPage>('visibility.json');
}

/** The tick asked about, as a query's part: none for now. */
function atQuery(at: number | null, first: boolean): string {
  return at === null ? '' : `${first ? '?' : '&'}at=${Math.round(at)}`;
}

/** The forecast in force at a tick, or now. */
export function getForecast(at: number | null): Promise<ForecastPage> {
  return getJSON<ForecastPage>(`forecast.json${atQuery(at, true)}`);
}

/** How well the forecast has held the truth so far this world. */
export function getCalibration(): Promise<CalibrationPage> {
  return getJSON<CalibrationPage>('calibration.json');
}

/** Every gale warning of the world so far. */
export function getGales(): Promise<GalesPage> {
  return getJSON<GalesPage>('gales.json');
}

/** A place's box and outlook at a tick, or now: of an island or a place if one is given, else of the point. */
export function getPlaceWeather(
  east: number,
  north: number,
  of: PlaceOf,
  at: number | null,
): Promise<PlaceWeather> {
  const what =
    of === null
      ? `east=${east.toFixed(2)}&north=${north.toFixed(2)}`
      : 'island' in of
        ? `island=${of.island}`
        : `place=${of.place}`;
  return getJSON<PlaceWeather>(`place.json?${what}${atQuery(at, false)}`);
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
export type Control =
  | 'flag'
  | 'place'
  | 'unseen'
  | 'world'
  | 'next'
  | 'chart'
  | 'lifetime'
  | 'machines'
  | 'priority'
  | 'accounts/stop'
  | 'accounts/start'
  | 'accounts/revoke'
  | 'accounts/delete';

/** Works a control: a POST of JSON, done on any 2xx (202 for one under way). */
export async function control(path: Control | 'accounts/search', body: unknown): Promise<Answer> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: (await res.text()).trim() };
}

/**
 * Searches the accounts: the text, which may be a token, goes in the body
 * alone, never in an address.
 */
export async function searchAccounts(
  text: string,
  sort: Sort,
  page: number,
): Promise<SearchAnswer> {
  const a = await control('accounts/search', { text, sort, page });
  if (!a.ok) {
    throw new Error(`${a.status}: ${a.text}`);
  }
  return JSON.parse(a.text) as SearchAnswer;
}

/** An account's card, by its id. */
export function getAccount(id: string): Promise<AccountCard> {
  return getJSON<AccountCard>(`account.json?id=${encodeURIComponent(id)}`);
}

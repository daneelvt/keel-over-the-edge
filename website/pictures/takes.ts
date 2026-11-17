// SPDX-License-Identifier: AGPL-3.0-only

// Every take of the website's pictures: its page, its size, and its
// staging, a function the page runs with the game's test hooks as the
// browser tests write them. Several takes are tried for each picture the
// page shows, their ids its name and a letter or a word; pictures.ts
// picks one of them, and any can be taken again by its id.
//
// The staging functions run in the page, not here: Playwright hands the
// page their source, so they use nothing from this file but their
// argument.

import { existsSync, readFileSync } from 'node:fs';
import type { CameraView } from './keel.ts';

/** A screenshot's size: the page's CSS pixels, and device pixels to each. */
export interface Size {
  width: number;
  height: number;
  scale: number;
}

/** Wide, 16:10, 2400 px across. */
export const WIDE: Size = { width: 1600, height: 1000, scale: 1.5 };
/** Upright, 4:5, 1200 px across: a phone's own frame. */
export const UPRIGHT: Size = { width: 480, height: 600, scale: 2.5 };
/** A card's, 16:10, 1600 px across. */
export const CARD: Size = { width: 1200, height: 750, scale: 4 / 3 };

export interface Take {
  /** Its name, and its raw file's: pictures/raw/<id>.png. */
  id: string;
  /** What it tries, in a few words, for the contact sheet. */
  note: string;
  /** The sandbox's query after ?sandbox&test. */
  query: string;
  size: Size;
  /** The world time frozen at, s: the waves' moment. */
  time?: number;
  /** Leaves the screen's controls drawn. */
  hud?: boolean;
  /** Stages the picture in the page. */
  stage: (arg: never) => Promise<unknown>;
  arg?: unknown;
  /** The page's part to keep, in CSS pixels, worked out in the page; the scene's canvas without it. */
  clip?: () => { x: number; y: number; width: number; height: number };
}

/** A take, its staging's argument typed by its staging. */
function take<A>(
  t: Omit<Take, 'stage' | 'arg'> & { stage: (arg: A) => Promise<unknown>; arg: A },
): Take {
  return t as Take;
}

const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;

// ---------------------------------------------------------------- the edge

interface AtTheEdge {
  hour: number;
  moon: number | null;
  /** The boat's heading, radians from north. */
  heading: number;
  /** How far inside the lip, m. */
  inside: number;
  /** At the top of the disk (1) or its foot (−1). */
  rim: number;
  view: CameraView;
  /** People aboard, the sailor among them; 0 for the sailor alone. */
  crew: number;
}

/**
 * The boat skimming the lip of the falls, the sky held at an hour. The
 * sandbox's gale blows from the north: at the top of the disk heading
 * west, from her starboard side over the lip.
 */
async function atTheEdge(a: AtTheEdge): Promise<unknown> {
  const k = globalThis.keel;
  // The lip is 8334 m from the disk's middle, as the browser tests' edge has it.
  const lip = 8334 * a.rim;
  if (a.crew > 0) {
    await k.showCrew(a.crew, 0);
    await k.crewReady();
    // Three seconds' sailing off the lip, to set her crew on the windward rail.
    k.placeBoat(0, lip - a.rim * (a.inside + 30), a.heading);
    for (let i = 0; i < 90; i++) {
      k.setState({ boom: 0.5, sailor: 0, heading: a.heading });
      k.sailFrames(1, 1);
    }
  }
  k.placeBoat(0, lip - a.rim * a.inside, a.heading);
  k.setSky(a.hour, a.moon);
  k.holdSky(true);
  k.render();
  k.camera(a.view);
  k.render();
  return undefined;
}

/** The wide frame: high over her quarter from inside the disk, the falls pouring on the right, the slabs breaking away beyond. */
const EDGE_VIEW = { azimuth: -0.6, elevation: 0.25, distance: 22 };
/** A little further round and up: more of the falls. */
const EDGE_VIEW_WIDER = { azimuth: -0.8, elevation: 0.27, distance: 24 };
/** The phone's frames: along the rim from above, the lip down the right side and the slabs below it. */
const PHONE_ALONG = { azimuth: -0.4, elevation: 0.4, distance: 18 };
const PHONE_HIGH = { azimuth: -0.3, elevation: 0.55, distance: 24 };

const BOATS = [
  // The Jolly boat, the sailor alone.
  { boat: 'jolly', query: '', crew: 0, scale: 1, words: 'the Jolly boat' },
  // The keelboat and her five; her size scales the camera's distance, nearer.
  {
    boat: 'keel',
    query: '&boat=keelboat&crew=5',
    crew: 5,
    scale: 0.8,
    words: 'the keelboat and her five',
  },
] as const;

/**
 * The gale over the lip at the top of the disk (from the north, the
 * sandbox's sea=gale) or at its foot (from the south, the same wind
 * mirrored): on her beam either way, her crew to windward, not laid flat.
 */
const gale = (rim: number) => (rim > 0 ? 'sea=gale' : 'wind=34,180');

/** At dusk the sun sets ahead over the falls; at dawn and by day, the mirror: the foot of the disk heading east. */
const HOURS = {
  dawn: { hour: 6.05, moon: null, rim: -1, heading: EAST },
  day: { hour: 8.6, moon: null, rim: -1, heading: EAST },
  dusk: { hour: 17.92, moon: null, rim: 1, heading: WEST },
  night: { hour: 2, moon: 0.5, rim: 1, heading: WEST },
} as const;

const scaled = (v: CameraView, s: number): CameraView => ({ ...v, distance: v.distance * s });

const edgeTakes: Take[] = [];
for (const [name, light] of Object.entries(HOURS)) {
  for (const b of BOATS) {
    // Three moments of the waves in the wide frame.
    for (const [moment, time] of [
      ['a', 100],
      ['b', 137],
      ['c', 171],
    ] as const) {
      edgeTakes.push(
        take({
          id: `edge-${name}-${b.boat}-${moment}`,
          note: `${name}, ${b.words}, from high over her quarter, the waves at ${time} s`,
          query: `${gale(light.rim)}${b.query}`,
          size: WIDE,
          time,
          stage: atTheEdge,
          arg: { ...light, inside: 8, view: scaled(EDGE_VIEW, b.scale), crew: b.crew },
        }),
      );
    }
    edgeTakes.push(
      take({
        id: `edge-${name}-${b.boat}-wider`,
        note: `${name}, ${b.words}, further round: more of the falls`,
        query: `${gale(light.rim)}${b.query}`,
        size: WIDE,
        time: 137,
        stage: atTheEdge,
        arg: { ...light, inside: 8, view: scaled(EDGE_VIEW_WIDER, b.scale), crew: b.crew },
      }),
    );
    for (const [frame, view, inside] of [
      ['along', PHONE_ALONG, 5],
      ['high', PHONE_HIGH, 3],
    ] as const) {
      edgeTakes.push(
        take({
          id: `edge-${name}-upright-${b.boat}-${frame}`,
          note: `${name}, ${b.words}, upright: ${frame === 'along' ? 'along the rim' : 'high over the rim'}`,
          query: `${gale(light.rim)}${b.query}`,
          size: UPRIGHT,
          time: 137,
          stage: atTheEdge,
          arg: { ...light, inside, view: scaled(view, b.scale), crew: b.crew },
        }),
      );
    }
  }
}
// The night and the day in other lights.
edgeTakes.push(
  take({
    id: 'edge-night-jolly-moonrise',
    note: 'night, the Jolly boat, the foot of the disk at 23 under a full moon',
    query: gale(-1),
    size: WIDE,
    time: 137,
    stage: atTheEdge,
    arg: { hour: 23, moon: 0.5, rim: -1, heading: EAST, inside: 8, view: EDGE_VIEW, crew: 0 },
  }),
  take({
    id: 'edge-night-jolly-low',
    note: 'night, the Jolly boat, lower and nearer, the moonlight on the tiles',
    query: 'sea=gale',
    size: WIDE,
    time: 137,
    stage: atTheEdge,
    arg: {
      hour: 22,
      moon: 0.5,
      rim: 1,
      heading: WEST,
      inside: 8,
      view: { azimuth: -0.4, elevation: 0.15, distance: 16 },
      crew: 0,
    },
  }),
  take({
    id: 'edge-day-jolly-afternoon',
    note: 'day, the Jolly boat, the top of the disk at 14.5, the sun behind',
    query: 'sea=gale',
    size: WIDE,
    time: 137,
    stage: atTheEdge,
    arg: { hour: 14.5, moon: null, rim: 1, heading: WEST, inside: 8, view: EDGE_VIEW, crew: 0 },
  }),
);

// ---------------------------------------------------------------- the race

interface Race {
  /** How far round the course each boat has come, 0 to 1, the leader first. */
  made: number[];
  /** Each boat's boards up the beat. */
  boards: number[];
  /** The chart zoomed by this about the course: under 1 nearer (the race view frames the course again as it draws). */
  zoom: number;
  /** The chart's weather's layers switched off: drawn for the whole disk, they blur at a course's scale. */
  off: string[];
  /** Where the course is laid, m east and north: clear of the paper's rhumb lines, which blur at a course's scale. */
  at: { east: number; north: number };
}

/**
 * A race of six round the sandbox's course, told as the server tells one,
 * each boat's way scripted (tacking up the beat to mark 1, round 2 and 3,
 * home) and pictured every two seconds as the server pictures it; then the
 * chart opened on the race, as the pocket chart opens it.
 */
async function race(a: Race): Promise<unknown> {
  const k = globalThis.keel;
  k.setSky(12);
  k.holdSky(true);
  k.placeBoat(a.at.east, a.at.north, Math.PI / 2);
  k.render();
  const t = k.raceTell({ start: 1 }, [
    { name: 'Mira', boat: 'Gull' },
    { name: 'Tomas', boat: 'Petrel' },
    { name: 'Iron Mary', boat: 'Iron Mary', machine: true },
    { name: 'Ada', boat: 'Kittiwake' },
    { name: 'Juno', boat: 'Shearwater' },
    { name: 'Clockwork Jack', boat: 'Clockwork Jack', machine: true },
  ]);
  type At = { east: number; north: number };
  const line = t.finish as At[];
  const [m1, m2, m3] = t.marks;
  const l0 = line[0];
  const l1 = line[1];
  if (
    m1 === undefined ||
    m2 === undefined ||
    m3 === undefined ||
    l0 === undefined ||
    l1 === undefined
  ) {
    throw new Error('no course');
  }
  const mid = { east: (l0.east + l1.east) / 2, north: (l0.north + l1.north) / 2 };
  const beat = Math.hypot(m1.east - mid.east, m1.north - mid.north);
  // Up the beat (u) and across it (v).
  const u = { east: (m1.east - mid.east) / beat, north: (m1.north - mid.north) / beat };
  const v = { east: u.north, north: -u.east };
  const ways: At[][] = a.made.map((_, i) => {
    const f = (i + 0.5) / a.made.length;
    const from = {
      east: l0.east + (l1.east - l0.east) * f + u.east * 2,
      north: l0.north + (l1.north - l0.north) * f + u.north * 2,
    };
    const pts = [from];
    const n = a.boards[i] ?? 3;
    let at = from;
    let made = 0;
    for (let b = 1; b < n; b++) {
      // Close-hauled boards about 45° each side of the wind, the first on the boat's own side,
      // each of its own length (a fixed scatter: the same race every time).
      const scatter =
        0.65 + ((0.7 * (((Math.sin(i * 12.9898 + b * 78.233) * 43758.5453) % 1) + 1)) % 1);
      const reach = Math.min(((beat - 8) / n) * scatter, beat - 14 - made);
      made += reach;
      const side = (b + i) % 2 === 0 ? 1 : -1;
      const s = side * reach * (b === 1 ? 0.6 : 1);
      let east = at.east + u.east * reach + v.east * s;
      let north = at.north + u.north * reach + v.north * s;
      const across = (east - mid.east) * v.east + (north - mid.north) * v.north;
      if (Math.abs(across) > 90) {
        const back = across - Math.sign(across) * 90;
        east -= v.east * back;
        north -= v.north * back;
      }
      at = { east, north };
      pts.push(at);
    }
    pts.push({
      east: m1.east + u.east * 4 - v.east * 6,
      north: m1.north + u.north * 4 - v.north * 6,
    });
    pts.push({ east: m2.east + u.east * 7, north: m2.north + u.north * 7 });
    pts.push({ east: m3.east - u.east * 6, north: m3.north - u.north * 6 });
    pts.push({ east: mid.east - u.east * 4, north: mid.north - u.north * 4 });
    return pts;
  });
  const length = (w: At[]) =>
    w.slice(1).reduce((d, q, j) => {
      const p = w[j] as At;
      return d + Math.hypot(q.east - p.east, q.north - p.north);
    }, 0);
  /** Where along its way a boat is at a share of it, its heading and leg. */
  const along = (w: At[], share: number) => {
    let left = share * length(w);
    for (let j = 1; j < w.length; j++) {
      const p = w[j - 1] as At;
      const q = w[j] as At;
      const d = Math.hypot(q.east - p.east, q.north - p.north);
      if (left <= d || j === w.length - 1) {
        const r = Math.min(1, left / d);
        return {
          east: p.east + (q.east - p.east) * r,
          north: p.north + (q.north - p.north) * r,
          heading: Math.atan2(q.east - p.east, q.north - p.north),
          // The boards up the beat are leg 1; then a leg a mark.
          leg: Math.max(1, j - (w.length - 4) + 1),
        };
      }
      left -= d;
    }
    return { east: 0, north: 0, heading: 0, leg: 1 };
  };
  const order = a.made.map((m, i) => ({ m, i })).sort((x, y) => y.m - x.m);
  const steps = 90;
  for (let s = 1; s <= steps; s++) {
    k.racePicture(
      a.made.map((m, i) => {
        const place = order.findIndex((o) => o.i === i) + 1;
        return { ...along(ways[i] ?? [], (m * s) / steps), place, gap: (place - 1) * 7.5 };
      }),
    );
    k.advance(60);
  }
  // The open sea far below behind the chart's paper, not the boat's rig.
  k.camera({ azimuth: 0, elevation: 1.4, distance: 80 });
  k.render();
  (document.querySelector('.pocket-chart') as HTMLElement | null)?.click();
  k.chartLayers(Object.fromEntries(a.off.map((l) => [l, false])));
  // The chart eases to the course: drawn until it is still, then nearer.
  for (let i = 0; i < 80; i++) {
    k.render();
    await globalThis.kit.sleep(40);
  }
  k.zoomChart(a.zoom);
  for (let i = 0; i < 80; i++) {
    k.render();
    await globalThis.kit.sleep(40);
  }
  return k.racing().chart;
}

const ALL_WEATHER = ['barbs', 'streaks', 'gusts', 'pressure', 'systems'];
const AHEAD = [0.78, 0.7, 0.62, 0.55, 0.47, 0.4];
const CLOSE = [0.62, 0.58, 0.52, 0.45, 0.4, 0.33];
const raceTakes: Take[] = (
  [
    [
      'a',
      'the leader round mark 2, the last still beating, by the sandbox’s start',
      AHEAD,
      [6, 5, 7, 6, 4, 5],
      ALL_WEATHER,
      { east: 0, north: 0 },
    ],
    [
      'b',
      'the leader just round mark 1, the fleet close, laid 2 km north-east',
      CLOSE,
      [5, 6, 5, 7, 6, 5],
      ALL_WEATHER,
      { east: 1500, north: 1500 },
    ],
    [
      'c',
      'as a, laid 2 km north-east',
      AHEAD,
      [6, 5, 7, 6, 4, 5],
      ALL_WEATHER,
      { east: 1500, north: 1500 },
    ],
    [
      'd',
      'as a, laid 3 km south-west',
      AHEAD,
      [6, 5, 7, 6, 4, 5],
      ALL_WEATHER,
      { east: -2100, north: -2100 },
    ],
    [
      'e',
      'as a, laid 4 km east',
      AHEAD,
      [6, 5, 7, 6, 4, 5],
      ALL_WEATHER,
      { east: 4000, north: 300 },
    ],
    [
      'f',
      'as a, laid 3 km north-west, the wind streaks left on',
      AHEAD,
      [6, 5, 7, 6, 4, 5],
      ['barbs', 'gusts', 'pressure', 'systems'],
      { east: -2500, north: 1800 },
    ],
  ] as const
).map(([id, note, made, boards, off, at]) =>
  take({
    id: `race-${id}`,
    note: `six boats, an easterly; ${note}`,
    // An easterly lays the course across the frame.
    query: 'wind=12,90',
    size: { width: 1600, height: 1000, scale: 2.5 },
    hud: true,
    stage: race,
    arg: { made: [...made], boards: [...boards], zoom: 0.45, off: [...off], at },
    // The course as the chart frames it at this size, 16:10, 1800 px across.
    clip: () => ({ x: 534, y: 255, width: 720, height: 450 }),
  }),
);

// ---------------------------------------------------------------- aboard

interface Aboard {
  hour: number;
  /** People aboard, the sailor among them. */
  crew: number;
  /** The heading off the wind, radians: negative, the wind over her starboard side. */
  off: number;
  /** Seconds sailed before the picture, for her people to settle. */
  seconds: number;
  view: CameraView;
  /** A ship: her helm and sheet held while she sails on her own; her company is the page's ?crew. */
  ship: boolean;
}

/** A boat under sail with her people aboard, from close by. */
async function aboard(a: Aboard): Promise<unknown> {
  const k = globalThis.keel;
  k.setSky(a.hour);
  k.holdSky(true);
  if (!a.ship) {
    await k.showCrew(a.crew, 0);
  }
  await k.crewReady();
  const heading = k.world.wind.meanFrom + a.off;
  if (a.ship) {
    k.setState({ heading });
    k.setControls(0, 0.2);
    k.sailFrames(a.seconds, 30);
  } else {
    for (let i = 0; i < a.seconds * 10; i++) {
      k.setState({ boom: 0.3, sailor: 0, heading });
      k.sailFrames(1, 3);
    }
  }
  k.camera(a.view);
  k.render();
  return undefined;
}

const A = (id: string, note: string, query: string, a: Partial<Aboard>) =>
  take({
    id,
    note,
    query,
    size: CARD,
    stage: aboard,
    arg: {
      hour: 17.85,
      crew: 1,
      off: -0.75,
      seconds: 8,
      view: { azimuth: 0.9, elevation: 0.22, distance: 5 },
      ship: false,
      ...a,
    },
  });
const KEELBOAT = 'boat=keelboat&crew=5&wind=18,0';
const YACHT = 'boat=yacht&crew=8&wind=16,0';
const SHIP = 'boat=tall-ship&crew=40&wind=16,0';
const aboardTakes: Take[] = [
  A('together-keelboat-a', 'five on the rail from her windward quarter, golden hour', KEELBOAT, {
    crew: 5,
  }),
  A('together-keelboat-b', 'higher and further aft', KEELBOAT, {
    crew: 5,
    view: { azimuth: 0.7, elevation: 0.32, distance: 5.5 },
  }),
  A('together-keelboat-c', 'lower, abeam, the sun lower', KEELBOAT, {
    crew: 5,
    hour: 17.92,
    view: { azimuth: 1.15, elevation: 0.16, distance: 4.6 },
  }),
  A('together-keelboat-d', 'from her lee bow, the five beyond the sail', KEELBOAT, {
    crew: 5,
    view: { azimuth: -2.3, elevation: 0.3, distance: 5.5 },
  }),
  A('together-yacht-a', 'eight aboard from her windward quarter, golden hour', YACHT, {
    crew: 8,
    view: { azimuth: 0.9, elevation: 0.28, distance: 4.5 },
  }),
  A('together-yacht-b', 'higher, looking down into her cockpit', YACHT, {
    crew: 8,
    view: { azimuth: 0.6, elevation: 0.45, distance: 4.5 },
  }),
  A('together-yacht-c', 'abeam, lower', YACHT, {
    crew: 8,
    hour: 17.92,
    view: { azimuth: 1.3, elevation: 0.2, distance: 4.2 },
  }),
  A('together-tall-ship-a', 'forty aboard, broadside, golden hour', SHIP, {
    crew: 40,
    ship: true,
    view: { azimuth: -1.5, elevation: 0.22, distance: 3.5 },
  }),
  A('together-tall-ship-b', 'from her quarter, higher: her deck and company', SHIP, {
    crew: 40,
    ship: true,
    view: { azimuth: -0.8, elevation: 0.42, distance: 3 },
  }),
  A('together-tall-ship-c', 'from her windward bow', SHIP, {
    crew: 40,
    ship: true,
    view: { azimuth: 2.2, elevation: 0.25, distance: 3.5 },
  }),
  A('together-tall-ship-d', 'from her starboard quarter, the sun lower', SHIP, {
    crew: 40,
    ship: true,
    hour: 17.92,
    view: { azimuth: 0.9, elevation: 0.3, distance: 3.2 },
  }),
];

// ---------------------------------------------------------------- the weather

interface Weather {
  /** Steps sailed for the weather to come, 30 a second. */
  wait: number;
  hour: number;
  moon: number | null;
  /** Turned toward the storm's cloud. */
  toStorm: boolean;
  /** Lightning: a flash asked for in so many seconds, the steps to just before it, and on to its stroke. */
  flash: number[] | null;
  /** The boat turned off the flash's bearing so far, radians, so that it strikes beside her. */
  flashSide: number;
  view: CameraView | string;
}

/** The sandbox's weather come to the boat, as the weather's browser tests stage it. */
async function weather(a: Weather): Promise<unknown> {
  const k = globalThis.keel;
  k.setSky(a.hour, a.moon);
  k.advance(a.wait);
  k.render();
  if (a.toStorm) {
    const storm = k.clouds()?.clouds.find((x) => x.form === 4);
    if (storm === undefined) {
      throw new Error('no storm');
    }
    const b = k.boat().state;
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    k.placeBoat(x, y, Math.atan2(storm.east - x, storm.north - y));
    k.render();
  }
  k.setSky(a.hour, a.moon);
  k.holdSky(true);
  k.camera(a.view);
  k.render();
  if (a.flash !== null) {
    const [seconds = 2, before = 45, stroke = 17] = a.flash;
    k.flashIn(seconds);
    // Turned toward the flash, which strikes at the nearest heaped cloud.
    const f = k.flashes().flashes.at(-1);
    const b = k.boat().state;
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    if (f !== undefined) {
      k.placeBoat(x, y, Math.atan2(f.east - x, f.north - y) + a.flashSide);
      k.render();
      k.camera(a.view);
    }
    k.advance(before);
    k.render();
    k.advance(stroke);
    k.render();
  }
  return undefined;
}

const W = (id: string, note: string, query: string, w: Partial<Weather>) =>
  take({
    id,
    note,
    query,
    size: CARD,
    stage: weather,
    arg: {
      wait: 0,
      hour: 12,
      moon: null,
      toStorm: false,
      flash: null,
      flashSide: 0,
      view: 'chase',
      ...w,
    },
  });
const LOW = { azimuth: 0.4, elevation: 0.08, distance: 9 };
const STORM = 'weather=storm';
const SQUALL = 'weather=squall';
const weatherTakes: Take[] = [
  W('storm-a', 'toward a storm twenty minutes on, the sun low behind', STORM, {
    wait: 36000,
    hour: 17.9,
    toStorm: true,
    view: LOW,
  }),
  W('storm-b', 'as a, in the afternoon', STORM, {
    wait: 36000,
    hour: 15,
    toStorm: true,
    view: LOW,
  }),
  W('storm-c', 'as a, at dusk', STORM, { wait: 36000, hour: 18.15, toStorm: true, view: LOW }),
  W('storm-d', 'as a, by moonlight', STORM, {
    wait: 36000,
    hour: 20,
    moon: 0.5,
    toStorm: true,
    view: LOW,
  }),
  W('lightning-a', 'a squall at night, the flash 300 m off the bow', SQUALL, {
    wait: 2600,
    hour: 22,
    moon: 0.3,
    flash: [2, 45, 19],
    flashSide: 0.25,
  }),
  W('lightning-b', 'the squall further off, the flash beside her, a low camera', SQUALL, {
    wait: 1800,
    hour: 22,
    flash: [2, 45, 18],
    flashSide: 0.35,
    view: { azimuth: 0, elevation: 0.12, distance: 9 },
  }),
  W('lightning-c', 'as b, under a full moon, a frame later', SQUALL, {
    wait: 1800,
    hour: 22,
    moon: 0.5,
    flash: [2, 45, 20],
    flashSide: 0.3,
    view: { azimuth: 0, elevation: 0.08, distance: 9 },
  }),
  W('lightning-d', 'nearer the squall, the bolt over the bow', SQUALL, {
    wait: 2300,
    hour: 21.5,
    flash: [2, 45, 19],
    flashSide: 0.15,
    view: { azimuth: 0, elevation: 0.06, distance: 8 },
  }),
  W('squall-a', 'a squall over the boat, its cloud and rain', SQUALL, {
    wait: 2000,
    hour: 14,
    view: { azimuth: 0.6, elevation: 0.12, distance: 10 },
  }),
  W('squall-b', 'as a, sooner, its edge coming', SQUALL, {
    wait: 1800,
    hour: 15,
    view: { azimuth: 0.8, elevation: 0.1, distance: 10 },
  }),
  W('squall-c', 'as a, the sun low', SQUALL, {
    wait: 2000,
    hour: 17,
    view: { azimuth: 0.6, elevation: 0.12, distance: 10 },
  }),
  W('fog-a', 'fog at sunrise, the sun’s glitter through it', 'fog=100', {
    hour: 6.6,
    view: { azimuth: 0.5, elevation: 0.12, distance: 9 },
  }),
  W('fog-b', 'fog in the morning, from her other side', 'fog=100', {
    hour: 7.2,
    view: { azimuth: -0.5, elevation: 0.12, distance: 9 },
  }),
  W('fog-c', 'fog in the evening', 'fog=100', {
    hour: 17.5,
    view: { azimuth: 0.5, elevation: 0.12, distance: 9 },
  }),
];

// ---------------------------------------------------------------- out there

interface Ashore {
  /** Where the boat is, m east and north, and her heading. */
  east: number;
  north: number;
  heading: number;
  hour: number;
  moon: number | null;
  /** The sea's state, or null for the page's wind. */
  sea: string | null;
  view: CameraView | string;
  /** What is waited for: the land in reach, a feature's parts too, or nothing in open water. */
  land: 'none' | 'land' | 'parts';
}

/** The boat somewhere in seed 1's world, its land drawn first. */
async function ashore(a: Ashore): Promise<unknown> {
  const k = globalThis.keel;
  k.placeBoat(a.east, a.north, a.heading);
  k.freezeTick(3000);
  if (a.sea !== null) {
    k.setSea(a.sea);
  }
  k.setSky(a.hour, a.moon);
  k.holdSky(true);
  k.render();
  if (a.land !== 'none') {
    await globalThis.kit.landed(a.land === 'parts');
  }
  k.render();
  k.camera(a.view);
  k.render();
  return undefined;
}

interface Feature {
  kind: string;
  island: number;
  x: number;
  y: number;
  seen: boolean;
  sightX: number;
  sightY: number;
}

/** Seed 1's world's records, as the page reads them from its file; none without the file. */
function seed1(): { features: Feature[]; islands: { biome: string }[] } {
  const file = new URL('../../.dev/worlds/1.world', import.meta.url);
  if (!existsSync(file)) {
    return { features: [], islands: [] };
  }
  const b = readFileSync(file);
  const n = b.readUInt32LE(8);
  return JSON.parse(b.subarray(12, 12 + n).toString('utf8'));
}

const catalog = JSON.parse(
  readFileSync(new URL('../../client/src/catalog/catalog.gen.json', import.meta.url), 'utf8'),
) as {
  world: {
    features: { kinds: { id: string; site: string }[] };
    biomes: { id: string; mangroves: boolean }[];
  };
};
const site = new Map(catalog.world.features.kinds.map((k) => [k.id, k.site]));
const tropical = new Set(catalog.world.biomes.filter((b) => b.mangroves).map((b) => b.id));
const world = seed1();

/** Back from where a feature is first seen, on the line from it, facing it, as the features' browser tests stand. */
function facing(
  ok: (f: Feature) => boolean,
  back: number,
): { east: number; north: number; heading: number } {
  const f = world.features.find((x) => x.seen && ok(x));
  if (f === undefined) {
    return { east: 0, north: 0, heading: 0 };
  }
  const dx = f.x - f.sightX;
  const dy = f.y - f.sightY;
  const l = Math.hypot(dx, dy) || 1;
  return {
    east: f.sightX - (dx / l) * back,
    north: f.sightY - (dy / l) * back,
    heading: Math.atan2(dx, dy),
  };
}

const O = (
  id: string,
  note: string,
  query: string,
  at: { east: number; north: number; heading: number },
  s: Partial<Ashore>,
) =>
  take({
    id,
    note,
    query,
    size: CARD,
    stage: ashore,
    arg: { ...at, hour: 12, moon: null, sea: null, view: 'chase', land: 'land', ...s },
  });
const crater = facing((f) => site.get(f.kind) === 'fumarole', 160);
const lagoon = facing(
  (f) => site.get(f.kind) === 'waterfall' && tropical.has(world.islands[f.island]?.biome ?? ''),
  10,
);
// Port Royal's eastern cliffs, and Wild Orange Cay's reef, as the land's browser tests have them.
const cliffs = { east: 300, north: 150, heading: WEST };
const reef = { east: 1830, north: -1191, heading: WEST };
// Open water, far from land.
const open = { east: 3000, north: 2000, heading: 0.6 };
const GALE = 'world=1&sea=gale';
const CALM = 'world=1&wind=0,0';
const FEATURES = 'world=1&wind=6,90';
const NIGHT = 'world=1&wind=8,0';
const outTakes: Take[] = [
  O('out-gale-a', 'a gale in open water, the sun ahead', GALE, open, {
    land: 'none',
    hour: 9,
    view: { azimuth: 0.7, elevation: 0.14, distance: 8 },
  }),
  O('out-gale-b', 'as a, in the afternoon from her other side', GALE, open, {
    land: 'none',
    hour: 15.5,
    view: { azimuth: -0.7, elevation: 0.16, distance: 8 },
  }),
  O('out-gale-c', 'as a, from astern and above, the whitecaps', GALE, open, {
    land: 'none',
    hour: 10,
    view: { azimuth: 0.25, elevation: 0.3, distance: 12 },
  }),
  O('out-reefs-a', 'Port Royal’s cliffs in a gale from above, surf on the shore', CALM, cliffs, {
    sea: 'gale',
    hour: 15,
    view: 'high',
  }),
  O('out-reefs-b', 'a reef in a fresh wind from above, the lagoon behind', CALM, reef, {
    sea: 'fresh',
    hour: 15,
    view: 'high',
  }),
  O('out-reefs-c', 'the cliffs lower and nearer, the boat off the surf', CALM, cliffs, {
    sea: 'gale',
    hour: 16,
    view: { azimuth: 1.6, elevation: 0.55, distance: 70 },
  }),
  O('out-land-a', 'a smoking crater from the sea, the sail full', FEATURES, crater, {
    land: 'parts',
    hour: 9,
    view: { azimuth: 0.3, elevation: 0.1, distance: 12 },
  }),
  O('out-land-b', 'as a, later, warmer', FEATURES, crater, {
    land: 'parts',
    hour: 17.6,
    view: { azimuth: 0.3, elevation: 0.1, distance: 12 },
  }),
  O('out-land-c', 'as a, from further off and lower', FEATURES, crater, {
    land: 'parts',
    hour: 11,
    view: { azimuth: -0.35, elevation: 0.07, distance: 16 },
  }),
  O('out-lagoon-a', 'in a lagoon before a waterfall, a village and palms', FEATURES, lagoon, {
    land: 'parts',
    hour: 10,
    view: { azimuth: 0, elevation: 0.12, distance: 14 },
  }),
  O('out-lagoon-b', 'as a, higher over the lagoon', FEATURES, lagoon, {
    land: 'parts',
    hour: 11,
    view: { azimuth: 0.2, elevation: 0.3, distance: 18 },
  }),
  O('out-lagoon-c', 'as a, the afternoon light', FEATURES, lagoon, {
    land: 'parts',
    hour: 13,
    view: { azimuth: -0.25, elevation: 0.15, distance: 14 },
  }),
  O('out-stars-a', 'night under a full moon, the masthead light lit', NIGHT, open, {
    land: 'none',
    hour: 21,
    moon: 0.5,
    view: { azimuth: 0.3, elevation: 0.08, distance: 10 },
  }),
  O('out-stars-b', 'a moonless night, the stars', NIGHT, open, {
    land: 'none',
    hour: 0,
    moon: 0,
    view: { azimuth: 0.3, elevation: 0.05, distance: 10 },
  }),
  O('out-stars-c', 'the stars and a quarter moon', NIGHT, open, {
    land: 'none',
    hour: 2,
    moon: 0.25,
    view: { azimuth: -0.4, elevation: 0.06, distance: 9 },
  }),
];
// Skimming the edge, in the sandbox's gale.
const E = (id: string, note: string, a: Omit<AtTheEdge, 'moon' | 'crew'>) =>
  take({
    id,
    note,
    query: gale(a.rim),
    size: CARD,
    time: 137,
    stage: atTheEdge,
    arg: { ...a, moon: null, crew: 0 },
  });
outTakes.push(
  E('out-edge-a', 'out over the falls, looking back along them at the boat, the afternoon', {
    hour: 15.5,
    rim: 1,
    heading: EAST,
    inside: 8,
    view: { azimuth: 2.6, elevation: 0.08, distance: 30 },
  }),
  E('out-edge-b', 'from beside her, the lip and the falls below, the morning', {
    hour: 9,
    rim: -1,
    heading: EAST,
    inside: 6,
    view: { azimuth: -1.2, elevation: 0.3, distance: 18 },
  }),
  E('out-edge-c', 'the sailor’s own camera skimming the lip, the afternoon', {
    hour: 15.5,
    rim: 1,
    heading: WEST,
    inside: 6,
    view: { azimuth: -0.2, elevation: 0.2, distance: 12 },
  }),
);

export const takes: Take[] = [
  ...edgeTakes,
  ...raceTakes,
  ...aboardTakes,
  ...weatherTakes,
  ...outTakes,
];

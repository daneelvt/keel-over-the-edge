// SPDX-License-Identifier: AGPL-3.0-only

// The words of the weather a place's box, its outlook, a harbourmaster's
// board and a gale warning give, in the Met Office's grammar: the shipping
// forecast's order of wind, weather and visibility; its wind on an
// eight-point compass, a change within ±45° or a force being within the
// forecast's own precision (Galvin, Met Office, 2018); its times at the
// sky's pace, imminent within half an hour of the issue, soon within an
// hour, later beyond; the glossary's words for the barometer's tendency
// and a system's motion. They are made from fields sampled at points and
// times. The server's twin is internal/weather/words.go; both are held to
// internal/weather/testdata/words.json.

/** What is near a point, within its size: bits of PlaceSample.near. */
export const NEAR = { shower: 1, squall: 2, storm: 4, fog: 8 } as const;

/** The skies a box gives, mildest first. */
export const SKIES = [
  'fair',
  'showers',
  'fog patches',
  'rain',
  'squally showers',
  'squalls with heavy rain',
] as const;
const SKY = { fair: 0, showers: 1, fog: 2, rain: 3, squally: 4, squalls: 5 } as const;

const KNOT = 1852 / 3600;

/** The wind, in knots, each Beaufort force begins at (Met Office, Beaufort wind force scale). */
const FORCE_FROM = [0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64] as const;

/** What the words are made with: the catalog's thresholds. */
export interface Words {
  /** Very poor, poor and moderate under these, m. */
  visibility: [number, number, number];
  /** Rain heavier than this is violent, mm an hour. */
  violent: number;
  /** A change in the outlook: a turn of this many degrees or more, or this many forces or more. */
  turn: number;
  forces: number;
  /** The times' words, minutes after the issue. */
  imminent: number;
  soon: number;
}

/** The catalog's words. */
export function wordsOf(weather: {
  clouds: { rainWords: number[] };
  visibility: { words: number[] };
  forecast: { outlook: { turn: number; forces: number; imminent: number; soon: number } };
}): Words {
  const v = weather.visibility.words;
  const o = weather.forecast.outlook;
  return {
    visibility: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0],
    violent: weather.clouds.rainWords[2] ?? 50,
    turn: o.turn,
    forces: o.forces,
    imminent: o.imminent,
    soon: o.soon,
  };
}

/**
 * The weather at a point about a place, at a time: the mean wind, m/s, and
 * the direction it comes from, rad; its typical strongest gust, m/s; the
 * rain, mm an hour; the visibility, m; and what is near, a sum of NEAR's
 * bits.
 */
export interface PlaceSample {
  mean: number;
  from: number;
  gust: number;
  rain: number;
  visibility: number;
  near: number;
}

/**
 * A place's weather at a time: its points', the first its centre; the
 * pressure at its centre then, 5 and 15 minutes before, hPa; and whether a
 * storm's centre is within its size of the place.
 */
export interface PlaceWeather {
  points: PlaceSample[];
  pressure: number;
  before: number;
  quarter: number;
  cyclonic: boolean;
}

/** A place's box: its lines of wind, gusts, sky, visibility and barometer. */
export interface Box {
  wind: string;
  gusts: string;
  sky: string;
  visibility: string;
  barometer: string;
}

/** a's q-quantile, nearest rank from below. */
function quantile(a: readonly number[], q: number): number {
  if (a.length === 0) {
    return 0;
  }
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(q * (s.length - 1) + 0.5);
  return s[Math.min(Math.max(i, 0), s.length - 1)] ?? 0;
}

/** A speed in m/s in whole knots, rounded half up. */
function wholeKnots(speed: number): number {
  return Math.floor(Math.max(speed, 0) / KNOT + 0.5);
}

/** The Beaufort force of a mean wind in m/s, by its whole knots. */
export function forceOf(speed: number): number {
  const k = wholeKnots(speed);
  let f = 0;
  FORCE_FROM.forEach((from, i) => {
    if (k >= from) {
      f = i;
    }
  });
  return f;
}

function capital(s: string): string {
  return s === '' ? s : (s[0] ?? '').toUpperCase() + s.slice(1);
}

/** The mean wind's 25th and 80th percentiles over the points, in whole knots. */
function speeds(w: PlaceWeather): [number, number] {
  const s = w.points.map((p) => p.mean);
  return [wholeKnots(quantile(s, 0.25)), wholeKnots(quantile(s, 0.8))];
}

/** The direction the mean wind comes from over the points, as the mean of their winds as vectors, rad. */
function meanFrom(w: PlaceWeather): number {
  let e = 0;
  let n = 0;
  for (const p of w.points) {
    e += p.mean * Math.sin(p.from);
    n += p.mean * Math.cos(p.from);
  }
  if (e === 0 && n === 0) {
    return w.points[0]?.from ?? 0;
  }
  return Math.atan2(e, n);
}

/** A point's sky, as an index into SKIES. */
function skyAt(p: PlaceSample, words: Words): number {
  let s: number = SKY.fair;
  if ((p.near & NEAR.shower) !== 0) {
    s = SKY.showers;
  }
  if ((p.near & NEAR.fog) !== 0 && p.visibility < words.visibility[0]) {
    s = Math.max(s, SKY.fog);
  }
  if (p.rain >= 0.1 && (p.near & (NEAR.shower | NEAR.squall)) === 0) {
    s = Math.max(s, SKY.rain);
  }
  if ((p.near & NEAR.squall) !== 0) {
    s = Math.max(s, SKY.squally);
    if (p.rain > words.violent) {
      s = SKY.squalls;
    }
  }
  return s;
}

/** The worst of the points' skies, an index into SKIES. */
function skyOf(w: PlaceWeather, words: Words): number {
  let worst: number = SKY.fair;
  for (const p of w.points) {
    worst = Math.max(worst, skyAt(p, words));
  }
  return worst;
}

const VISIBILITY_WORDS = ['good', 'moderate', 'poor', 'very poor'] as const;

/** The visibility's word for a range of m: 0 good, 1 moderate, 2 poor, 3 very poor. */
export function visibilityWord(v: number, words: Words): number {
  for (let i = 0; i < 3; i++) {
    if (v < (words.visibility[i] ?? 0)) {
      return 3 - i;
    }
  }
  return 0;
}

function visibilityOf(w: PlaceWeather, words: Words): string {
  let worst = 0;
  for (const p of w.points) {
    worst = Math.max(worst, visibilityWord(p.visibility, words));
  }
  const m = visibilityWord(
    quantile(
      w.points.map((p) => p.visibility),
      0.5,
    ),
    words,
  );
  if (worst > m) {
    return `${VISIBILITY_WORDS[m]}, ${VISIBILITY_WORDS[worst]} in places`;
  }
  return VISIBILITY_WORDS[m] ?? 'good';
}

const ADVERBS = ['', 'slowly', '', 'quickly', 'very rapidly'] as const;

/** The barometer's words for a tendency: "steady", "rising slowly", "falling very rapidly", "now rising" after a fall. */
export function tendencyWords(words: number, turned: boolean): string {
  if (words === 0) {
    return 'steady';
  }
  let way = 'rising';
  let w = words;
  if (w < 0) {
    way = 'falling';
    w = -w;
  }
  if (turned) {
    return way === 'rising' ? 'now falling' : 'now rising';
  }
  const a = ADVERBS[Math.min(w, 4)] ?? '';
  return a === '' ? way : `${way} ${a}`;
}

/**
 * The barometer's tendency, from the readings now, 5 and 15 minutes
 * before, as the physics module's Tendency gives it: its words, −4 to 4,
 * and whether the last minutes turned against it.
 */
export function tendencyOf(
  now: number,
  before: number,
  quarter: number,
): { words: number; turned: boolean } {
  const d = now - quarter;
  const a = Math.abs(d);
  let words = 4;
  if (!(a >= 0.1)) {
    words = 0;
  } else if (a <= 1.5) {
    words = 1;
  } else if (a <= 3.5) {
    words = 2;
  } else if (a <= 6) {
    words = 3;
  }
  if (d < 0) {
    words = -words;
  }
  const last = now - before;
  const turned = words !== 0 && ((d < 0 && last > 0.05) || (d > 0 && last < -0.05));
  return { words, turned };
}

/** The barometer's reading and tendency: "1009 hPa, falling quickly". */
export function barometerWords(now: number, before: number, quarter: number): string {
  const t = tendencyOf(now, before, quarter);
  return `${Math.floor(now + 0.5)} hPa, ${tendencyWords(t.words, t.turned)}`;
}

const POINTS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;
const POINTS8 = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;
const WHERE8 = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;
const WINDS8 = [
  'northerly',
  'northeasterly',
  'easterly',
  'southeasterly',
  'southerly',
  'southwesterly',
  'westerly',
  'northwesterly',
] as const;

/** A direction in rad as degrees from 0 to 360. */
function degreesOf(rad: number): number {
  let d = ((rad * 180) / Math.PI) % 360;
  if (d < 0) {
    d += 360;
  }
  return d;
}

/** The nearest of the sixteen points to a direction in rad, as the instruments write it: "WSW". */
export function point16(rad: number): string {
  const d = Math.floor(degreesOf(rad) + 0.5);
  return POINTS16[Math.floor(((d % 360) + 11.25) / 22.5) % 16] ?? 'N';
}

/** The nearest of the eight points to a direction in rad. */
function point8(rad: number): number {
  return Math.floor((degreesOf(rad) + 22.5) / 45) % 8;
}

/** The eight points' words, "southwest", for a direction in rad. */
export function eightPoint(rad: number): string {
  return POINTS8[point8(rad)] ?? 'north';
}

/** Where something lies from a place, "south-west", for a bearing in rad. */
export function whereWord(rad: number): string {
  return WHERE8[point8(rad)] ?? 'north';
}

/** A place's box from its weather. */
export function boxOf(w: PlaceWeather, words: Words): Box {
  if (w.points.length === 0) {
    return { wind: '', gusts: '', sky: '', visibility: '', barometer: '' };
  }
  const [lo, hi] = speeds(w);
  const from = point16(meanFrom(w));
  let wind = hi !== lo ? `${from} ${lo}–${hi} kn` : `${from} ${lo} kn`;
  const flo = forceOf(lo * KNOT);
  const fhi = forceOf(hi * KNOT);
  wind += flo === fhi ? ` · F${flo}` : ` · F${flo}–${fhi}`;
  return {
    wind,
    gusts: `${wholeKnots(
      quantile(
        w.points.map((p) => p.gust),
        0.8,
      ),
    )} kn`,
    sky: capital(SKIES[skyOf(w, words)] ?? 'fair'),
    visibility: capital(visibilityOf(w, words)),
    barometer: barometerWords(w.pressure, w.before, w.quarter),
  };
}

/** A force as the shipping forecast says it: "5", "gale 8", "severe gale 9". */
export function forceWord(f: number): string {
  if (f >= 12) {
    return 'hurricane force 12';
  }
  switch (f) {
    case 11:
      return 'violent storm 11';
    case 10:
      return 'storm 10';
    case 9:
      return 'severe gale 9';
    case 8:
      return 'gale 8';
  }
  return String(f);
}

/** A range of forces: "4", "4 or 5", "4 to 6", "6 to gale 8". */
function forcesWords(lo: number, hi: number): string {
  if (lo === hi) {
    return forceWord(lo);
  }
  if (hi === lo + 1) {
    return `${forceWord(lo)} or ${forceWord(hi)}`;
  }
  return `${forceWord(lo)} to ${forceWord(hi)}`;
}

/** A time, minutes after the issue, in the scaled words. */
export function whenWords(at: number, words: Words): string {
  if (at <= words.imminent) {
    return 'imminent';
  }
  if (at <= words.soon) {
    return 'soon';
  }
  return 'later';
}

/** A time as a gale warning words it: "imminent", "expected soon", "expected later". */
export function expected(at: number, words: Words): string {
  const t = whenWords(at, words);
  return t === 'imminent' ? t : `expected ${t}`;
}

/** A place's weather at a time, minutes after the issue. */
export interface OutlookSample extends PlaceWeather {
  at: number;
}

/**
 * A place's outlook from its samples: its wind, then up to two changes,
 * each with its time, its weather and its visibility; and, if the falls
 * take the world within the horizon, "then the falls".
 */
export function outlook(samples: readonly OutlookSample[], falls: boolean, words: Words): string {
  const s0 = samples[0];
  if (s0 === undefined) {
    return '';
  }
  const stateOf = (s: OutlookSample) => {
    const [lo, hi] = speeds(s);
    const from = meanFrom(s);
    return { dir: point8(from), from, lo: forceOf(lo * KNOT), hi: forceOf(hi * KNOT) };
  };
  const first = stateOf(s0);
  let wind = `${capital(POINTS8[first.dir] ?? 'north')} ${forcesWords(first.lo, first.hi)}`;
  let last = first;
  let changes = 0;
  let cyclonic = s0.cyclonic;
  for (let i = 1; i < samples.length && changes < 2; i++) {
    const s = samples[i] as OutlookSample;
    const st = stateOf(s);
    const turn = (remainder(st.from - last.from, 2 * Math.PI) * 180) / Math.PI;
    let change: string;
    if (s.cyclonic && !cyclonic) {
      change = `becoming cyclonic ${forcesWords(st.lo, st.hi)}`;
    } else if (Math.abs(turn) >= words.turn) {
      change = `${turn < 0 ? 'backing' : 'veering'} ${POINTS8[st.dir]} ${forcesWords(st.lo, st.hi)}`;
    } else if (st.hi - last.hi >= words.forces) {
      change = `increasing ${forcesWords(st.lo, st.hi)}`;
    } else if (last.hi - st.hi >= words.forces) {
      change = `decreasing ${forcesWords(st.lo, st.hi)}`;
    } else {
      continue;
    }
    cyclonic = cyclonic || s.cyclonic;
    wind += `, ${change} ${whenWords(s.at, words)}`;
    last = st;
    changes++;
  }
  const seen: string[] = [];
  for (const s of samples) {
    const sk = SKIES[skyOf(s, words)] ?? 'fair';
    if (seen[seen.length - 1] !== sk) {
      seen.push(sk);
    }
  }
  let weather = capital(seen.join(', then '));
  if (falls) {
    weather += ', then the falls';
  }
  const count = [0, 0, 0, 0];
  for (const s of samples) {
    const w = visibilityWord(
      quantile(
        s.points.map((p) => p.visibility),
        0.5,
      ),
      words,
    );
    count[w] = (count[w] ?? 0) + 1;
  }
  let usual = 0;
  for (let i = 0; i < 4; i++) {
    if ((count[i] ?? 0) > (count[usual] ?? 0)) {
      usual = i;
    }
  }
  let vis = capital(VISIBILITY_WORDS[usual] ?? 'good');
  for (let i = 3; i > usual; i--) {
    if ((count[i] ?? 0) > 0) {
      vis += `, occasionally ${VISIBILITY_WORDS[i]}`;
      break;
    }
  }
  return `${wind}. ${weather}. ${vis}.`;
}

/** IEEE 754's remainder, x − n y for the n nearest x / y, ties to even, as Go's math.Remainder. */
function remainder(x: number, y: number): number {
  const q = x / y;
  let n = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5 && n % 2 !== 0) {
    n -= 1;
  }
  return x - n * y;
}

/**
 * A gale warning: the direction it first blows from, rad; its force; when
 * its first step is, minutes after the issue; its strongest point, m; and
 * the nearest charted place's name and where it is, or "" for none.
 */
export interface Warning {
  from: number;
  force: number;
  first: number;
  east: number;
  north: number;
  place: string;
  placeEast: number;
  placeNorth: number;
}

/** A warning's wind ("southwesterly gale 8"), its time ("expected soon") and where ("south-west of Gannet Holm"). */
export function warningParts(
  w: Warning,
  words: Words,
): { wind: string; when: string; where: string } {
  const wind = `${WINDS8[point8(w.from)]} ${forceWord(Math.max(w.force, 8))}`;
  const when = expected(w.first, words);
  const where =
    w.place === ''
      ? `in the ${WHERE8[point8(Math.atan2(w.east, w.north))]} outer waters`
      : `${WHERE8[point8(Math.atan2(w.east - w.placeEast, w.north - w.placeNorth))]} of ${w.place}`;
  return { wind, when, where };
}

/** A warning in a sentence: "Southwesterly gale 8 expected soon, south-west of Gannet Holm". */
export function warningText(w: Warning, words: Words): string {
  const p = warningParts(w, words);
  return `${capital(p.wind)} ${p.when}, ${p.where}`;
}

/** A low in the general situation, at the issue or forming, born at minutes after it. */
export interface SituationSystem {
  forming: boolean;
  at: number;
  pressure: number;
  east: number;
  north: number;
  heading: number;
  speed: number;
}

/** A front: the direction it comes from, rad, and when it reaches the port, minutes after the issue; −1 if not within the horizon. */
export interface SituationFront {
  from: number;
  at: number;
}

/** What the general situation tells. */
export interface Situation {
  port: string;
  centre: number;
  middle: number;
  lows: SituationSystem[] | null;
  fronts: SituationFront[] | null;
  squalls: boolean;
  from: number;
}

/** Where a point lies: "near Port Royal", "in the south-west middle waters". */
function area(s: Situation, east: number, north: number): string {
  const r = Math.hypot(east, north);
  if (r <= s.centre) {
    return `near ${s.port}`;
  }
  const zone = r <= s.middle ? 'middle' : 'outer';
  return `in the ${WHERE8[point8(Math.atan2(east, north))]} ${zone} waters`;
}

/** How a system moves (Met Office, Marine forecasts glossary). */
function movingWords(heading: number, speed: number): string {
  const k = speed / KNOT;
  if (k < 1) {
    return 'almost stationary';
  }
  const how =
    k < 15
      ? 'slowly'
      : k < 25
        ? 'steadily'
        : k < 35
          ? 'rather quickly'
          : k < 45
            ? 'quickly'
            : 'very quickly';
  return `moving ${POINTS8[point8(heading)]} ${how}`;
}

/** The general situation's lines, as the inshore waters forecast gives them. */
export function generalSituation(s: Situation, words: Words): string[] {
  const out: string[] = [];
  for (const l of s.lows ?? []) {
    if (l.forming) {
      out.push(`New low ${expected(l.at, words)} ${area(s, l.east, l.north)}`);
      continue;
    }
    out.push(
      `Low ${Math.floor(l.pressure + 0.5)} ${area(s, l.east, l.north)}, ${movingWords(l.heading, l.speed)}`,
    );
  }
  for (const f of s.fronts ?? []) {
    let line = `Front coming from the ${POINTS8[point8(f.from)]}`;
    if (f.at >= 0) {
      line += `, ${expected(f.at, words)} at ${s.port}`;
    }
    out.push(line);
  }
  if (s.squalls) {
    out.push(`Squalls from the ${POINTS8[point8(s.from)]}`);
  }
  if (out.length === 0) {
    out.push('No systems expected');
  }
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-only

// A race replayed on the chart: the server's replay read into tracks, and
// the race at the slider's moment. The slider runs in seconds from the
// gun, from the warning signal to the last boat's end (a time trial's
// runs each from its own start, so that they sail together); play runs it
// at 10× or 30×. At any moment the chart draws each boat's track to then,
// its dot where it was, the boat followed brightest with its next mark
// ringed; the standings are worked out from the boats' progress round the
// course (marks made, then the way left to the next) and their finishes.

import { signal } from '@preact/signals';
import type { RaceDrawing } from '../chart/racelayer';
import type { RacePoint, RaceToldIn } from '../net/messages';
import type { LaidCourse, ReplayBoat, ReplayRun, ReplayTold, ReplayTrack } from './raceapi';

/** A track read: its first sample's tick, the ticks between, and every sample's east and north, m. */
export interface Track {
  first: number;
  every: number;
  east: Float64Array;
  north: Float64Array;
}

/** A track as the server sends it, read. */
export function readTrack(t: ReplayTrack): Track {
  const n = Math.floor(t.p.length / 2);
  const east = new Float64Array(n);
  const north = new Float64Array(n);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += t.p[2 * i] ?? 0;
    y += t.p[2 * i + 1] ?? 0;
    east[i] = x;
    north[i] = y;
  }
  return { first: t.first, every: Math.max(1, t.every), east, north };
}

/** The tick of a track's last sample. */
export function lastTick(t: Track): number {
  return t.first + Math.max(0, t.east.length - 1) * t.every;
}

/** Where a track's boat was at a tick, between its samples: null before its first; at its last after it. i is the samples' index, fractional. */
export function trackAt(t: Track, tick: number): (RacePoint & { i: number }) | null {
  const n = t.east.length;
  if (n === 0 || tick < t.first) {
    return null;
  }
  const f = Math.min((tick - t.first) / t.every, n - 1);
  const i = Math.floor(f);
  const j = Math.min(i + 1, n - 1);
  const k = f - i;
  return {
    east: (t.east[i] ?? 0) + ((t.east[j] ?? 0) - (t.east[i] ?? 0)) * k,
    north: (t.north[i] ?? 0) + ((t.north[j] ?? 0) - (t.north[i] ?? 0)) * k,
    i: f,
  };
}

/** A track drawn from a tick to another: east, north, … m, ending where the boat was at the latter. */
export function trackBetween(t: Track, from: number, to: number): number[] {
  const out: number[] = [];
  const a = trackAt(t, Math.max(from, t.first));
  const b = trackAt(t, to);
  if (a === null || b === null || to <= from) {
    return out;
  }
  out.push(a.east, a.north);
  for (let i = Math.floor(a.i) + 1; i < b.i; i++) {
    out.push(t.east[i] ?? 0, t.north[i] ?? 0);
  }
  out.push(b.east, b.north);
  return out;
}

/** How near a mark a boat comes to have made it, m; and how far past its nearest it must sail, having come within REACHED_NEAR. */
const REACHED = 40;
const REACHED_NEAR = 150;
const REACHED_PAST = 20;

/**
 * A boat's progress round a course at each of its samples, m along the
 * legs, and the leg it makes for: nothing before the gun (−1); from it,
 * the legs before the one it makes for and that leg less the way to its
 * point, never going back. A leg is made by coming near its mark, or by
 * passing its nearest having come close.
 */
export function progressOf(
  t: Track,
  legs: readonly [number, number, number][],
  gun: number,
): { progress: Float64Array; leg: Int16Array; total: number } {
  const n = t.east.length;
  const progress = new Float64Array(n).fill(-1);
  const leg = new Int16Array(n).fill(0);
  const cum: number[] = [0];
  for (let k = 1; k < legs.length; k++) {
    const a = legs[k - 1] ?? [0, 0, 0];
    const b = legs[k] ?? [0, 0, 0];
    cum.push((cum[k - 1] ?? 0) + Math.hypot(b[1] - a[1], b[2] - a[2]));
  }
  const total = cum.at(-1) ?? 0;
  let k = Math.min(1, legs.length - 1);
  let nearest = Number.POSITIVE_INFINITY;
  let best = 0;
  for (let i = 0; i < n; i++) {
    if (t.first + i * t.every < gun) {
      continue;
    }
    const x = t.east[i] ?? 0;
    const y = t.north[i] ?? 0;
    // Marks made, perhaps more than one in a sample.
    for (;;) {
      const p = legs[k];
      if (p === undefined || k >= legs.length - 1) {
        break;
      }
      const d = Math.hypot(x - p[1], y - p[2]);
      nearest = Math.min(nearest, d);
      if (d <= REACHED || (nearest <= REACHED_NEAR && d > nearest + REACHED_PAST)) {
        k++;
        nearest = Number.POSITIVE_INFINITY;
        continue;
      }
      break;
    }
    const p = legs[k] ?? [0, x, y];
    const at =
      (cum[k] ?? 0) - Math.min(Math.hypot(x - p[1], y - p[2]), (cum[k] ?? 0) - (cum[k - 1] ?? 0));
    best = Math.max(best, at);
    progress[i] = best;
    leg[i] = k;
  }
  return { progress, leg, total };
}

/** A line drawn in a replay: a race's boat, or a trial's run. key is its number on the chart. */
export interface ReplayLine {
  key: number;
  run: number;
  boat: ReplayBoat;
  name: string;
  /** Its track, read; null for none kept. */
  track: Track | null;
  /** Its gun's tick and its run's course. */
  start: number;
  course: LaidCourse | null;
  progress: Float64Array | null;
  leg: Int16Array | null;
  total: number;
}

/** How a boat stands at the slider's moment. */
export type StandingState = 'line' | 'racing' | 'home' | 'placed' | 'retired' | 'dns';

/** A line's standing at a moment: its place then (0 none), its state, the way it has left, m, and its time home, s. */
export interface Standing {
  key: number;
  place: number;
  state: StandingState;
  toGo: number;
  line: ReplayLine;
}

/** A boat of a replay in words: its skipper's name (a machine sailor's marked), its boat and number, or its number. */
export function boatName(b: ReplayBoat): string {
  if (b.name !== null && b.name !== '') {
    return b.machine ? `${b.name} ⚙` : b.name;
  }
  if (b.boat !== null && b.boat !== '') {
    return `the ${b.boat}, ${b.number}`;
  }
  return `No. ${b.number}`;
}

/** A trial's runs as a replay lists them: home ones by time, then the rest. */
function trialOrder(a: ReplayRun, b: ReplayRun): number {
  const ta = runTime(a);
  const tb = runTime(b);
  return ta === tb ? a.run - b.run : ta - tb;
}

/** A trial's run's time with its seconds added, s; unfinished last. */
export function runTime(r: ReplayRun): number {
  const b = r.boats[0];
  return b === undefined || b.elapsed < 0 ? Number.POSITIVE_INFINITY : b.elapsed + b.added;
}

/** The most lines a replay draws: one colour each. */
export const MOST_DRAWN = 8;

/** The speeds play runs at. */
export const SPEEDS = [1, 10, 30] as const;
export type Speed = (typeof SPEEDS)[number];

/** How often the chart is drawn again while playing, ms of the page's clock. */
export const PLAY_EVERY = 100;

/** The drawings' versions, every replay's apart from every other's and from a race's under way. */
let versions = 1_000_000_000;

/**
 * A race replayed: what the server sent, the lines it draws, and the
 * slider's moment, s from the gun (each run's own, a trial's). boatIndex
 * is the race's boats' kind, the catalog's index.
 */
export class ReplayModel {
  readonly told: ReplayTold;
  readonly lines: ReplayLine[];
  /** The slider's reach, s from the gun. */
  readonly lo: number;
  readonly hi: number;
  /** The slider's moment, s from the gun. */
  readonly t = signal(0);
  readonly playing = signal(false);
  readonly speed = signal<Speed>(10);
  /** The line followed, by its key; 0 none. */
  readonly followed = signal(0);
  /** Counts up with every change the chart draws, never the same as another drawing's. */
  readonly version = signal(++versions);
  readonly #boatIndex: number;
  #drawing: RaceDrawing | null = null;

  constructor(told: ReplayTold, boatIndex = 0) {
    this.told = told;
    this.#boatIndex = boatIndex;
    this.lines = linesOf(told);
    const second = Math.max(1, told.second);
    let lo = 0;
    let hi = 0;
    for (const l of this.lines) {
      if (l.track === null) {
        continue;
      }
      lo = Math.min(lo, (l.track.first - l.start) / second);
      hi = Math.max(hi, (lastTick(l.track) - l.start) / second);
      // A boat home between two samples: the slider reaches its finish.
      if (l.boat.how === 'finished' && l.boat.elapsed >= 0) {
        hi = Math.max(hi, l.boat.elapsed);
      }
    }
    const run = told.runs[0];
    if (told.kind === 'race' && run?.warning !== undefined && run.start !== undefined) {
      lo = Math.min(lo, (run.warning - run.start) / second);
    }
    // A trial's runs from a little before their starts: their placing
    // can be long before.
    this.lo = Math.floor(told.kind === 'trial' ? Math.max(lo, -30) : lo);
    this.hi = Math.ceil(hi);
    this.t.value = this.lo;
    const mine = this.lines.find((l) => l.boat.me === true && l.track !== null);
    this.followed.value = mine?.key ?? this.lines.find((l) => l.track !== null)?.key ?? 0;
  }

  /** Moves the slider to s from the gun. */
  setTime(s: number): void {
    const t = Math.min(Math.max(s, this.lo), this.hi);
    if (t !== this.t.peek()) {
      this.t.value = t;
      this.#changed();
    }
  }

  /** Follows a line by its key: its track brightest, its tag on. */
  follow(key: number): boolean {
    if (!this.lines.some((l) => l.key === key && l.track !== null)) {
      return false;
    }
    this.followed.value = key;
    this.#changed();
    return true;
  }

  /** Plays on by dt ms of the page's clock at the speed chosen; stops at the end. */
  play(dt: number): void {
    if (!this.playing.peek()) {
      return;
    }
    const t = this.t.peek() + (dt / 1000) * this.speed.peek();
    this.setTime(t);
    if (t >= this.hi) {
      this.playing.value = false;
    }
  }

  /** Starts or stops play: from the start again once at the end. */
  toggle(): void {
    if (!this.playing.peek() && this.t.peek() >= this.hi) {
      this.setTime(this.lo);
    }
    this.playing.value = !this.playing.peek();
  }

  #changed(): void {
    this.#drawing = null;
    this.version.value = ++versions;
  }

  /** The tick a line is at, the slider at s. */
  tickOf(l: ReplayLine, s = this.t.peek()): number {
    return l.start + s * this.told.second;
  }

  /** Every line's standing at the slider's moment, the leader first. */
  standings(s = this.t.peek()): Standing[] {
    return standingsAt(this.lines, s, this.told.second);
  }

  /** The course drawn: the followed line's run's, or the first's. */
  course(): ReplayLine | null {
    const f = this.followed.peek();
    return (
      this.lines.find((l) => l.key === f && l.course !== null) ??
      this.lines.find((l) => l.course !== null) ??
      null
    );
  }

  /** The race at the slider's moment as the chart draws it; null with no course kept. */
  drawing(): RaceDrawing | null {
    if (this.#drawing !== null) {
      return this.#drawing;
    }
    const base = this.course();
    if (base === null || base.course === null) {
      return null;
    }
    const s = this.t.peek();
    const told = toldOf(this.told, base, this.lines, this.#boatIndex);
    const tracks = new Map<number, number[]>();
    const boats: RaceDrawing['boats'][number][] = [];
    const places = new Map(this.standings(s).map((x) => [x.key, x]));
    let leader = 0;
    for (const l of this.lines) {
      if (l.track === null) {
        continue;
      }
      const tick = this.tickOf(l, s);
      const st = places.get(l.key);
      tracks.set(l.key, trackBetween(l.track, l.start, tick));
      const at = trackAt(l.track, tick);
      if (at !== null && st?.state !== 'retired') {
        boats.push({ number: l.key, east: at.east, north: at.north, place: st?.place ?? 0 });
      }
      if (st?.place === 1) {
        leader = l.key;
      }
    }
    const followed = this.lines.find((l) => l.key === this.followed.peek()) ?? null;
    let next = -1;
    if (followed?.track != null && followed.leg !== null && s >= 0) {
      const at = trackAt(followed.track, this.tickOf(followed, s));
      if (at !== null) {
        next = followed.leg[Math.floor(at.i)] ?? -1;
      }
    }
    const names = new Map(this.lines.map((l) => [l.key, l.name]));
    this.#drawing = {
      told,
      tracks,
      boats,
      watched: this.followed.peek(),
      leader,
      next,
      name: (n) => names.get(n) ?? `No. ${n}`,
      version: this.version.peek(),
    };
    return this.#drawing;
  }
}

/** The lines of a replay: a race's boats, by their numbers; a trial's runs, numbered as listed. */
export function linesOf(told: ReplayTold): ReplayLine[] {
  const out: ReplayLine[] = [];
  if (told.kind === 'trial') {
    const runs = [...told.runs].sort(trialOrder);
    const named = new Map<string, number>();
    for (const r of runs) {
      const b = r.boats[0];
      if (b !== undefined && b.track !== undefined) {
        named.set(boatName(b), (named.get(boatName(b)) ?? 0) + 1);
      }
    }
    for (const r of runs) {
      const b = r.boats[0];
      if (b === undefined) {
        continue;
      }
      const name = boatName(b);
      const key = out.length + 1;
      out.push(
        lineOf(told, r, b, key, (named.get(name) ?? 0) > 1 ? `${name}, run ${r.run}` : name),
      );
    }
    return out;
  }
  for (const r of told.runs) {
    for (const b of r.boats) {
      out.push(lineOf(told, r, b, b.number, boatName(b)));
    }
  }
  return out;
}

function lineOf(
  told: ReplayTold,
  r: ReplayRun,
  b: ReplayBoat,
  key: number,
  name: string,
): ReplayLine {
  const track = told.kept && b.track !== undefined ? readTrack(b.track) : null;
  const course = told.kept ? (r.course ?? null) : null;
  const start = r.start ?? 0;
  const p = track !== null && course !== null ? progressOf(track, course.legs, start) : null;
  return {
    key,
    run: r.run,
    boat: b,
    name,
    track,
    start,
    course,
    progress: p?.progress ?? null,
    leg: p?.leg ?? null,
    total: p?.total ?? 0,
  };
}

/** The standings of lines at s from their guns: home boats by their places, then those racing by their progress, then the rest. */
export function standingsAt(lines: readonly ReplayLine[], s: number, second: number): Standing[] {
  const rows: (Standing & { order: number; rank: number })[] = [];
  for (const l of lines) {
    const b = l.boat;
    const row = { key: l.key, place: 0, state: 'racing' as StandingState, toGo: 0, line: l };
    if (b.how === 'dns' || l.track === null) {
      rows.push({
        ...row,
        state: b.how === 'dns' ? 'dns' : 'placed',
        order: 4,
        rank: b.place || 999,
      });
      continue;
    }
    const tick = l.start + s * second;
    const at = trackAt(l.track, tick);
    const ended = tick > lastTick(l.track);
    if (s < 0) {
      rows.push({ ...row, state: 'line', order: 0, rank: l.key });
    } else if (b.how === 'finished' && b.elapsed >= 0 && s >= b.elapsed) {
      rows.push({ ...row, state: 'home', order: 1, rank: b.place || l.key });
    } else if (ended && b.how === 'placed') {
      rows.push({ ...row, state: 'placed', order: 1, rank: b.place || 999 });
    } else if (ended && b.how !== 'finished') {
      rows.push({ ...row, state: 'retired', order: 3, rank: l.key });
    } else {
      const i = at === null ? 0 : at.i;
      const p = l.progress;
      let made = 0;
      if (p !== null && p.length > 0) {
        const a = p[Math.floor(i)] ?? 0;
        const c = p[Math.min(Math.floor(i) + 1, p.length - 1)] ?? a;
        made = a + (c - a) * (i - Math.floor(i));
      }
      rows.push({ ...row, toGo: Math.max(0, l.total - made), order: 2, rank: -made });
    }
  }
  rows.sort((a, b) => a.order - b.order || a.rank - b.rank || a.key - b.key);
  let place = 0;
  return rows.map(({ order, rank: _, ...x }) => {
    if (order === 1 || order === 2) {
      place++;
      return { ...x, place };
    }
    return x;
  });
}

/** A replay's run as the race line's and the chart's RaceToldIn: its course, its boats as entrants. */
export function toldOf(
  told: ReplayTold,
  base: ReplayLine,
  lines: readonly ReplayLine[],
  boatIndex: number,
): RaceToldIn {
  const c = base.course as LaidCourse;
  const pt = (e: number, n: number): RacePoint => ({ east: e, north: n });
  const way: RacePoint[] = [];
  for (let i = 0; i + 1 < c.way.length; i += 2) {
    way.push(pt(c.way[i] ?? 0, c.way[i + 1] ?? 0));
  }
  const finishes = c.finish.some((v, i) => v !== c.line[i]);
  return {
    race: 0,
    code: told.code,
    name: told.name,
    boat: boatIndex,
    trial: told.kind === 'trial',
    run: base.run,
    warning: 0,
    start: base.start,
    pin: pt(c.line[0], c.line[1]),
    committee: pt(c.line[2], c.line[3]),
    finish: finishes ? [pt(c.finish[0], c.finish[1]), pt(c.finish[2], c.finish[3])] : null,
    marks: c.marks.map((m) => ({ east: m[0], north: m[1], number: m[2], side: m[3] })),
    way,
    legs: c.legs.map((l) => ({ mark: l[0], east: l[1], north: l[2] })),
    east: c.east,
    north: c.north,
    reach: c.reach,
    laps: c.laps,
    expected: c.expected,
    entrants: lines.map((l) => ({
      number: l.key,
      name: l.boat.name ?? '',
      boat: l.boat.boat ?? '',
      machine: l.boat.machine,
      me: l.boat.me === true,
    })),
    gone: false,
  };
}

/** The slider's moment in words: "−1:20" before the gun, "6:40" after. */
export function clockAt(s: number): string {
  const neg = s < 0;
  const a = Math.floor(Math.abs(s));
  const m = Math.floor(a / 60);
  const ss = a % 60;
  const h = Math.floor(m / 60);
  const body =
    h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${m}:${String(ss).padStart(2, '0')}`;
  return neg ? `−${body}` : body;
}

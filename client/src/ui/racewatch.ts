// SPDX-License-Identifier: AGPL-3.0-only

// Watching a race: the spectator's side of it, as the race bar and the
// sea see it. One boat at a time, as any watch is, switched in a tap: ‹
// and › for the boat ahead and the boat behind in the standings, a row of
// the standings, a boat tapped on the chart or in the sea. The server
// honours one watch a second, so a switch asked within it waits it out.
//
// Follow the action moves the watch by itself, scoring the race's picture
// every two seconds: boats within five lengths of one another, nearer the
// front counting more; a boat about to round a mark with another close; a
// change of place, the lead's most of all; a boat closing on the finish
// with a rival near; a call between two boats. It stays at least twenty
// seconds on a boat and moves only where another scores clearly higher,
// never in the middle of the watched boat's own rounding or finish; any
// switch by hand turns it off. A boat watched that finishes or retires is
// left for the boat it was racing nearest, whether following or not.
//
// The crier says what happens in a line for a few seconds, one at a time,
// to spectators and racers alike: roundings, the lead changing hands,
// calls, finishes. And a spectator cheers the boat watched, once every ten
// seconds; the crowd's cheers come back gathered.

import { signal } from '@preact/signals';
import type {
  RaceCallIn,
  RaceCheeredIn,
  RaceFinishIn,
  RacePictureIn,
  RacerAtIn,
  RaceSignalIn,
  RaceToldIn,
  RaceWatchAsk,
} from '../net/messages';
import { entrantName, type Racing } from './racestate';
import {
  cheeredLine,
  crierCall,
  crierFinish,
  crierPlaces,
  followLine,
  standingOrder,
} from './racewatchwords';

/** The server honours one watch a second: a switch waits this long after the last, ms. */
export const SWITCH_EVERY = 1100;
/** Follow the action stays on a boat at least this long, ms. */
export const FOLLOW_HOLD = 20_000;
/** Another boat must score this many times the watched one's, and this much more, to move the watch. */
export const FOLLOW_CLEARLY = 1.5;
export const FOLLOW_MORE = 1;
/** One cheer counts every ten seconds, ms. */
export const CHEER_EVERY = 10_000;
/** A crier's line stays this long, ms; the next waits at least this long after the last began. */
export const CRIER_SHOWN = 4000;
export const CRIER_GAP = 3000;
/** The lines after a cheer stay this long, ms. */
export const CHEERED_SHOWN = 3500;
/** A boat watched that finished is left after this long, ms: its gun and its cheers first. */
export const HOME_HOLD = 8000;
/** Two boats home within this of each other, s: a photo finish. */
export const PHOTO_SECONDS = 2;
/** A call between two boats counts in the scores this long, ms. */
const CALL_COUNTS = 6000;

/** A line shown for a while: its words and until when, ms. */
export interface Shown {
  text: string;
  until: number;
}

/** What watching a race needs of the game. */
export interface RaceWatchDeps {
  racing: Racing;
  /** Asks the server to watch a race's boat. */
  ask: (a: RaceWatchAsk) => void;
  /** Sends a cheer for the boat watched. */
  cheer: () => void;
  /** The page's clock, ms. */
  now: () => number;
  /** The race's boats' length, m: the scores' "within five lengths". */
  length: (told: RaceToldIn) => number;
  /** Whether the page watches a boat rather than sails its own. */
  spectating: () => boolean;
  /** The bunting of a cheer bursts from the boat watched or sailed: count cheers' worth, own for the page's own. */
  bunting?: (count: number, own: boolean) => void;
  /** The crowd is heard: count cheers' worth; own for the page's own "Huzzah!"; racer for one of those cheered. */
  crowd?: (count: number, own: boolean, racer: boolean) => void;
}

/**
 * How lively each boat of a race is now, by number, from its picture and
 * the one before it: pairs close together, nearer the front counting
 * more; a rounding or a finish with a rival near; a change of place; a
 * call between two. Length is the boats' length, m; calls the pairs
 * called lately.
 */
export function scoreBoats(
  told: RaceToldIn,
  now: readonly RacerAtIn[],
  was: readonly RacerAtIn[],
  length: number,
  calls: readonly [number, number][] = [],
): Map<number, number> {
  const score = new Map<number, number>();
  const add = (n: number, v: number) => score.set(n, (score.get(n) ?? 0) + v);
  const racing = now.filter((r) => r.state === 'racing');
  const near = 5 * Math.max(length, 1);
  const front = (place: number) => 1 + 2 / Math.max(place, 1);
  for (const r of racing) {
    add(r.number, 0);
  }
  for (let i = 0; i < racing.length; i++) {
    const a = racing[i] as RacerAtIn;
    for (let j = i + 1; j < racing.length; j++) {
      const b = racing[j] as RacerAtIn;
      const d = Math.hypot(a.east - b.east, a.north - b.north);
      if (d > near) {
        continue;
      }
      const close = 1 - d / near;
      const w = 2 * close * front(Math.min(a.place || 99, b.place || 99));
      add(a.number, w);
      add(b.number, w);
      // A rounding or a finish with the other close.
      for (const r of [a, b]) {
        const leg = told.legs[r.leg];
        if (leg === undefined) {
          continue;
        }
        const to = Math.hypot(leg.east - r.east, leg.north - r.north);
        if (to < 4 * Math.max(length, 1)) {
          add(r.number, r.leg >= told.legs.length - 1 ? 4 : 2);
        }
      }
    }
  }
  // A change of place, the lead's most of all.
  for (const r of racing) {
    const before = was.find((x) => x.number === r.number);
    if (before !== undefined && before.place > 0 && r.place > 0 && before.place !== r.place) {
      add(r.number, r.place === 1 || before.place === 1 ? 6 : 3);
    }
  }
  for (const [a, b] of calls) {
    if (score.has(a)) {
      add(a, 3);
    }
    if (score.has(b)) {
      add(b, 3);
    }
  }
  return score;
}

/** Whether boat r is in the middle of its own rounding or finish: near the point it makes for. */
function busy(told: RaceToldIn, r: RacerAtIn, length: number): boolean {
  const leg = told.legs[r.leg];
  return (
    leg !== undefined &&
    r.leg > 0 &&
    Math.hypot(leg.east - r.east, leg.north - r.north) < 2.5 * Math.max(length, 1)
  );
}

export class RaceWatch {
  /** Follow the action: on, the watch moves by itself. */
  readonly follow = signal(false);
  /** Whether the standings are open; the bar's ⋯. */
  readonly standings = signal(false);
  readonly more = signal(false);
  /** The crier's line, while shown. */
  readonly crier = signal<Shown | null>(null);
  /** The line after the page's own cheer, "You and 11 others cheered". */
  readonly cheeredText = signal<Shown | null>(null);
  /** The crowd cheering the page's own boat, for the watchers' line: how many, until when. */
  readonly cheering = signal<{ crowd: number; until: number } | null>(null);
  /** When the page last cheered, ms. */
  readonly lastCheer = signal(Number.NEGATIVE_INFINITY);
  /** The boat asked for and not yet watched; null for none. */
  readonly asking = signal<number | null>(null);
  readonly #d: RaceWatchDeps;
  #asked = Number.NEGATIVE_INFINITY;
  #pending: number | null = null;
  #eye = 0;
  #since = 0;
  #was: RacerAtIn[] = [];
  #lines: string[] = [];
  #crierAt = Number.NEGATIVE_INFINITY;
  #calls: { a: number; b: number; until: number }[] = [];
  #home = new Map<number, number>();
  #homes: RaceFinishIn[] = [];
  #race = 0;

  constructor(deps: RaceWatchDeps) {
    this.#d = deps;
  }

  /** Switches the watch to the race's boat of number n, as soon as the server will hear it; by hand, follow the action stops. */
  switchTo(n: number, byHand = true): void {
    if (byHand) {
      this.follow.value = false;
    }
    if (n === this.#eye && this.#d.spectating()) {
      this.asking.value = null;
      this.#pending = null;
      return;
    }
    this.#pending = n;
    this.asking.value = n;
    this.#send();
  }

  /** The boat ahead (−1) or behind (1) the one watched in the standings, round the fleet's ends; by hand. */
  step(dir: -1 | 1): void {
    const order = this.#order();
    if (order.length === 0) {
      return;
    }
    const cur = this.asking.peek() ?? this.#eye;
    const i = order.indexOf(cur);
    const next = order[(i < 0 ? 0 : i + dir + order.length) % order.length] as number;
    this.switchTo(next);
  }

  /** The boats that may be watched, in the standings' order. */
  #order(): number[] {
    const racers = this.#d.racing.picture.peek()?.racers ?? [];
    return standingOrder(racers)
      .filter((r) => r.state !== 'retired' && r.state !== 'dns')
      .map((r) => r.number);
  }

  /** Sends the switch waiting, if the second since the last has passed. */
  #send(): void {
    const n = this.#pending;
    const told = this.#d.racing.told.peek();
    const now = this.#d.now();
    if (n === null || told === null || now - this.#asked < SWITCH_EVERY) {
      return;
    }
    this.#pending = null;
    this.#asked = now;
    this.#d.ask({ race: told.race, code: told.code, number: n });
  }

  /** A watch asked for was refused or ended: one refused as too soon is asked again; a boat out of the race left for its nearest. */
  ended(why: string): void {
    const n = this.asking.peek();
    if (why === 'quick' && n !== null) {
      this.#pending = n;
      return;
    }
    this.asking.value = null;
    const told = this.#d.racing.told.peek();
    if (told === null || this.#d.racing.number() > 0) {
      return;
    }
    if (why === 'off' || why === 'left' || why === 'cannot' || why === 'no-race') {
      const next = this.#nearest(this.#eye);
      if (next !== null && next !== this.#eye) {
        this.switchTo(next, false);
      }
    }
  }

  /** The boat racing nearest boat n, by the latest picture; null for none. */
  #nearest(n: number): number | null {
    const racers = this.#d.racing.picture.peek()?.racers ?? [];
    const me = racers.find((r) => r.number === n);
    let best: number | null = null;
    let d = Number.POSITIVE_INFINITY;
    for (const r of racers) {
      if (r.number === n || r.state !== 'racing') {
        continue;
      }
      const x = me === undefined ? r.place || 99 : Math.hypot(r.east - me.east, r.north - me.north);
      if (x < d) {
        d = x;
        best = r.number;
      }
    }
    return best;
  }

  /** The page's clock beats: a switch waiting sent; the crier's next line; lines expired. */
  tick(): void {
    const now = this.#d.now();
    this.#send();
    const c = this.crier.peek();
    if (c !== null && now >= c.until) {
      this.crier.value = null;
    }
    if (this.#lines.length > 0 && now - this.#crierAt >= CRIER_GAP) {
      const text = this.#lines.shift() as string;
      this.#crierAt = now;
      this.crier.value = { text, until: now + CRIER_SHOWN };
    }
    const k = this.cheeredText.peek();
    if (k !== null && now >= k.until) {
      this.cheeredText.value = null;
    }
    const w = this.cheering.peek();
    if (w !== null && now >= w.until) {
      this.cheering.value = null;
    }
    this.#calls = this.#calls.filter((x) => x.until > now);
  }

  /** A line for the crier: the newest kept, at most two waiting. */
  say(text: string): void {
    this.#lines.push(text);
    if (this.#lines.length > 2) {
      this.#lines.splice(0, this.#lines.length - 2);
    }
    this.tick();
  }

  /** The names as the race tells them. */
  #name = (n: number): string => {
    const t = this.#d.racing.told.peek();
    return t === null ? `No. ${n}` : entrantName(t, n);
  };

  /** A race's picture, taken by the race's store first: the crier's changes of place, the watch kept on a live boat. */
  picture(p: RacePictureIn): void {
    const r = this.#d.racing;
    const told = r.told.peek();
    if (told === null || told.race !== p.race) {
      return;
    }
    if (told.race !== this.#race) {
      this.#race = told.race;
      this.#was = [];
      this.#home.clear();
      this.#homes = [];
    }
    const now = this.#d.now();
    if (p.eye !== this.#eye) {
      this.#eye = p.eye;
      this.#since = now;
      if (this.asking.peek() === p.eye) {
        this.asking.value = null;
      }
    }
    const watched = r.watched();
    const line = crierPlaces(this.#was, p.racers, watched, this.#name);
    if (line !== null) {
      this.say(line);
    }
    const spectator = r.spectator() && this.#d.spectating();
    const me = p.racers.find((x) => x.number === this.#eye);
    if (spectator && me !== undefined && this.asking.peek() === null) {
      // A boat home or out of the race is left for the one it raced nearest.
      const home = this.#home.get(me.number);
      if (
        me.state === 'retired' ||
        (me.state === 'finished' && home !== undefined && now - home >= HOME_HOLD)
      ) {
        const next = this.#nearest(me.number);
        if (next !== null) {
          this.switchTo(next, false);
        }
      } else if (this.follow.peek() && now - this.#since >= FOLLOW_HOLD) {
        this.#followTo(told, p.racers, me);
      }
    }
    this.#was = p.racers.map((x) => ({ ...x }));
  }

  /** Follow the action: the watch moved to a boat scoring clearly higher, if there is one. */
  #followTo(told: RaceToldIn, racers: readonly RacerAtIn[], me: RacerAtIn): void {
    const length = this.#d.length(told);
    if (me.state === 'racing' && busy(told, me, length)) {
      return;
    }
    const calls = this.#calls.map((c) => [c.a, c.b] as [number, number]);
    const scores = scoreBoats(told, racers, this.#was, length, calls);
    const mine = scores.get(me.number) ?? 0;
    let best = me.number;
    let top = mine;
    for (const [n, s] of scores) {
      if (s > top) {
        best = n;
        top = s;
      }
    }
    if (best === me.number || top < mine * FOLLOW_CLEARLY + FOLLOW_MORE) {
      return;
    }
    const place = racers.find((x) => x.number === best)?.place ?? 0;
    // The fight is for the better place of the pair.
    let fight = place;
    for (const x of racers) {
      if (x.number !== best && x.state === 'racing' && x.place > 0 && x.place === place - 1) {
        const b = racers.find((y) => y.number === best);
        if (b !== undefined && Math.hypot(x.east - b.east, x.north - b.north) < 5 * length) {
          fight = x.place;
        }
      }
    }
    this.switchTo(best, false);
    this.say(followLine(fight));
  }

  /** Turns follow the action on or off; on, it may move at once. */
  setFollow(on: boolean): void {
    this.follow.value = on;
    if (on) {
      this.#since = this.#d.now() - FOLLOW_HOLD;
    }
  }

  /** A call of the committee's: the crier's line, and a bump counted in the scores. */
  call(c: RaceCallIn): void {
    const told = this.#d.racing.told.peek();
    if (told === null || told.race !== c.race) {
      return;
    }
    if (c.kind === 'bump') {
      this.#calls.push({ a: c.number, b: c.other, until: this.#d.now() + CALL_COUNTS });
    }
    // A racer's own calls are on its race line.
    const own = this.#d.racing.number();
    if (own > 0 && (c.number === own || (c.kind === 'bump' && c.other === own))) {
      return;
    }
    const line = crierCall(c, this.#name);
    if (line !== null) {
      this.say(line);
    }
  }

  /** A boat home: the crier's line, a photo finish if within a breath of the boat before. */
  finish(f: RaceFinishIn): void {
    const told = this.#d.racing.told.peek();
    if (told === null || told.race !== f.race) {
      return;
    }
    this.#home.set(f.number, this.#d.now());
    const before = this.#homes.find((h) => h.place === f.place - 1);
    const photo =
      before !== undefined &&
      Math.abs(f.elapsedMs + f.added * 1000 - (before.elapsedMs + before.added * 1000)) <=
        PHOTO_SECONDS * 1000;
    this.#homes.push(f);
    this.say(crierFinish(f, photo, this.#name));
  }

  /** A signal: the start's gun has the crier's word. */
  signal(s: RaceSignalIn): void {
    const told = this.#d.racing.told.peek();
    if (told !== null && told.race === s.race && s.signal === 'start' && !told.trial) {
      this.say('And they’re off!');
    }
  }

  /** The time left before the next cheer counts, ms; 0 now. */
  cheerLeft(): number {
    return Math.max(0, CHEER_EVERY - (this.#d.now() - this.lastCheer.peek()));
  }

  /** Cheers the boat watched: false within ten seconds of the last. */
  cheerNow(): boolean {
    if (this.cheerLeft() > 0) {
      return false;
    }
    this.lastCheer.value = this.#d.now();
    this.#d.cheer();
    this.#d.bunting?.(1, true);
    this.#d.crowd?.(1, true, false);
    return true;
  }

  /** The crowd's cheers gathered for a boat: for the boat watched or sailed, its bunting and its crowd, and the lines. */
  cheered(c: RaceCheeredIn): void {
    const r = this.#d.racing;
    const told = r.told.peek();
    if (told === null || told.race !== c.race || c.number !== r.watched() || c.count <= 0) {
      return;
    }
    const now = this.#d.now();
    const racer = r.number() > 0;
    if (racer) {
      this.cheering.value = { crowd: c.crowd, until: now + CHEERED_SHOWN };
      this.#d.bunting?.(c.count, false);
      this.#d.crowd?.(c.count, false, true);
      return;
    }
    if (c.mine) {
      this.cheeredText.value = { text: cheeredLine(c.count), until: now + CHEERED_SHOWN };
    }
    // The page's own cheer burst as it was tapped: the others' now.
    const others = c.mine ? c.count - 1 : c.count;
    if (others > 0) {
      this.#d.bunting?.(others, false);
      this.#d.crowd?.(others, false, false);
    }
  }

  /** Another race, or none: everything of the last forgotten. */
  clear(): void {
    this.#pending = null;
    this.asking.value = null;
    this.standings.value = false;
    this.more.value = false;
    this.crier.value = null;
    this.#lines = [];
    this.#was = [];
    this.#home.clear();
    this.#homes = [];
    this.#race = 0;
    this.#eye = 0;
  }
}

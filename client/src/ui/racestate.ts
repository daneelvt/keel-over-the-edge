// SPDX-License-Identifier: AGPL-3.0-only

// The race the player's boat sails in, as the server tells it: its
// course and boats (RaceTold), where every boat stands every two seconds
// (RacePicture), the committee's calls, the boats home and the results.
// The race line, the pocket chart, the chart and the finish's windows read
// it; each boat's track is gathered here from the pictures, from the start.
// A race the boat is not in is told too while its course is in sight (for
// its marks in the sea); this keeps the one the boat races in, or, for a
// page watching a boat, the race whose pictures come.
//
// A newcomer (the green ribbon) has three hints on the race line, each
// once a race, as a call is shown: as the boats are placed, at the start
// (the gun, or a trial's crossing of the line) and nearing the first mark.
// When the committee asks whether the boat still races, the line offers
// Still racing for the minute it has to answer.

import { signal } from '@preact/signals';
import type { RaceDrawing } from '../chart/racelayer';
import type {
  RaceCallIn,
  RaceFinishIn,
  RacePictureIn,
  RaceResultsIn,
  RacerAtIn,
  RaceToldIn,
} from '../net/messages';
import { callLine, HINT_GO, HINT_LINE, HINT_LINE_ALONE, HINT_MARK, timed } from './racelinewords';

/** A call shown on the race line: its words, until when (ms, the page's clock), and whether it warns. */
export interface CallShown {
  text: string;
  /** Its words short, for a narrow line. */
  short: string;
  until: number;
  warn: boolean;
}

/** How long a call stays on the race line, ms; a mark missed longer, until the boat goes back. */
export const CALL_SHOWN = 6000;
export const MISSED_SHOWN = 15000;

/** How long a newcomer's hint stays on the race line, ms. */
export const HINT_SHOWN = 8000;

/** How long Still racing is offered after the committee asks, ms: the minute it has to answer. */
export const ASKED_SHOWN = 60_000;

/** How near the first mark a newcomer's hint to round it comes, m. */
export const HINT_NEAR = 60;

/** A race's results as the finish's windows show them, with the race as told. */
export interface RaceEnded {
  told: RaceToldIn;
  results: RaceResultsIn;
}

export class Racing {
  /** The race the boat sails in (or the boat watched): its course and boats; null for none. */
  readonly told = signal<RaceToldIn | null>(null);
  /** Its latest picture, and when it came (ms, the page's clock). */
  readonly picture = signal<RacePictureIn | null>(null);
  pictured = 0;
  /** The call on the race line, while shown. */
  readonly call = signal<CallShown | null>(null);
  /** The boat's own finish, for the finish's card; null before. */
  readonly finish = signal<RaceFinishIn | null>(null);
  /** The race's results as it ended, kept after its course is taken up until another race; null before. */
  readonly ended = signal<RaceEnded | null>(null);
  /** What the boat's run counted toward its sailor's next certificate, for the finish's card and its results; null for nothing. */
  readonly certified = signal<string | null>(null);
  /** Whether the results' window is open; the finish card's. */
  readonly resultsOpen = signal(false);
  readonly finishOpen = signal(false);
  /** Whether the race line's ⋯ is open. */
  readonly more = signal(false);
  /** Until when (ms, the page's clock) Still racing is offered, the committee having asked; 0 for not. */
  readonly asked = signal(0);
  /** Whether the player wears the green ribbon: the race line's hints are theirs. */
  newcomer: () => boolean = () => false;
  /** The hints given in this race, and the boat's state and leg at the last picture. */
  #hinted = new Set<string>();
  #was: RacerAtIn | null = null;
  /** Answers the committee's question: the boat still races. */
  stillRacing: (() => void) | null = null;
  /** Counts up with each picture and each race told: the charts draw again. */
  readonly version = signal(0);
  /** The boat the page sails or watches in the race, by number, as the latest picture says; 0 none. */
  readonly eye = signal(0);
  /** The boats home in the race, by their numbers. */
  readonly homes = new Map<number, RaceFinishIn>();
  /** Every race told and not gone, by its number: their courses in sight. */
  readonly known = new Map<number, RaceToldIn>();
  /** Each boat's track in the race, by its number: east, north, east, north… m. */
  readonly #tracks = new Map<number, number[]>();
  /** The boats whose tracks have ended at their finish. */
  readonly #homed = new Set<number>();
  /** The page's clock, ms. */
  now: () => number = () => performance.now();

  /** A race told, or taken up. */
  tell(t: RaceToldIn): void {
    const cur = this.told.peek();
    if (t.gone) {
      this.known.delete(t.race);
      if (cur !== null && cur.race === t.race) {
        this.told.value = null;
        this.picture.value = null;
        this.eye.value = 0;
        this.call.value = null;
        this.more.value = false;
        this.#tracks.clear();
        this.#homed.clear();
      }
      this.version.value++;
      return;
    }
    const was = this.known.get(t.race);
    // The names come in a second telling; keep a code and name had.
    const kept: RaceToldIn = {
      ...t,
      code: t.code !== '' ? t.code : (was?.code ?? ''),
      name: t.name !== '' ? t.name : (was?.name ?? ''),
    };
    this.known.set(t.race, kept);
    if (t.entrants.some((e) => e.me) || cur?.race === t.race) {
      if (cur?.race !== t.race) {
        this.#begin();
      }
      this.told.value = kept;
    }
    this.version.value++;
  }

  /** A new race for the line: what was kept of the last goes. */
  #begin(): void {
    this.homes.clear();
    this.#tracks.clear();
    this.#homed.clear();
    this.picture.value = null;
    this.eye.value = 0;
    this.call.value = null;
    this.finish.value = null;
    this.finishOpen.value = false;
    this.certified.value = null;
    this.more.value = false;
    this.asked.value = 0;
    this.#hinted.clear();
    this.#was = null;
  }

  /** A newcomer's hint, once a race, as a call on the race line; none for a sailor past the green ribbon. */
  #hint(key: string, text: string): void {
    if (this.#hinted.has(key) || !this.newcomer()) {
      return;
    }
    this.#hinted.add(key);
    this.call.value = { text, short: text, warn: false, until: this.now() + HINT_SHOWN };
  }

  /** The boat's own state in a picture: the hints of the start and of the first mark. */
  #hints(t: RaceToldIn, me: RacerAtIn): void {
    const was = this.#was;
    this.#was = me;
    if (me.state === 'placed' && was === null) {
      // Placed on the line: what to do in the two minutes.
      this.#hint('line', timed(t) ? HINT_LINE_ALONE : HINT_LINE);
    }
    if (me.state === 'racing' && was !== null && was.state === 'placed') {
      this.#hint('go', HINT_GO);
    }
    const leg = t.legs[me.leg];
    if (me.state === 'racing' && leg !== undefined && leg.mark > 0) {
      const m = t.marks.find((k) => k.number === leg.mark) ?? leg;
      if (Math.hypot(m.east - me.east, m.north - me.north) < HINT_NEAR) {
        this.#hint('mark', HINT_MARK);
      }
    }
  }

  /** Answers the committee's question, offered: the boat still races. */
  answer(): void {
    this.asked.value = 0;
    this.stillRacing?.();
    const c = this.call.peek();
    if (c !== null && c.warn) {
      this.call.value = null;
    }
  }

  /** A race's picture: the boats where they stand; each racing one's track grows. */
  take(p: RacePictureIn): void {
    let cur = this.told.peek();
    if (cur === null) {
      // A boat watched in a race: the race whose pictures come.
      const k = this.known.get(p.race);
      if (k === undefined) {
        return;
      }
      this.#begin();
      this.told.value = k;
      cur = k;
    }
    if (cur.race !== p.race) {
      return;
    }
    for (const r of p.racers) {
      if ((r.state !== 'racing' && r.state !== 'finished') || this.#homed.has(r.number)) {
        continue;
      }
      let t = this.#tracks.get(r.number);
      if (t === undefined) {
        t = [];
        this.#tracks.set(r.number, t);
      }
      const n = t.length;
      if (n < 2 || t[n - 2] !== r.east || t[n - 1] !== r.north) {
        t.push(r.east, r.north);
      }
      // A finished boat's track ends at its finish.
      if (r.state === 'finished') {
        this.#homed.add(r.number);
      }
    }
    this.picture.value = p;
    this.eye.value = p.eye;
    this.pictured = this.now();
    const n = this.number();
    const me = n > 0 ? p.racers.find((r) => r.number === n) : undefined;
    if (me !== undefined) {
      this.#hints(cur, me);
      if (me.state !== 'racing' && me.state !== 'placed') {
        this.asked.value = 0;
      }
    }
    this.version.value++;
  }

  /** A call: on the race line for a few seconds, in the log's words, if it is the boat's own. */
  called(c: RaceCallIn): void {
    const t = this.told.peek();
    if (t === null || t.race !== c.race) {
      return;
    }
    const me = this.number();
    const line = callLine(c, me, (n) => entrantName(t, n));
    if (line === null) {
      return;
    }
    if (me > 0 && c.number === me) {
      if (c.kind === 'drifting') {
        this.asked.value = this.now() + ASKED_SHOWN;
      } else if (c.kind === 'retired') {
        this.asked.value = 0;
      }
    }
    this.call.value = {
      text: line.text,
      short: line.short,
      warn: line.warn,
      until: this.now() + (c.kind === 'missedMark' ? MISSED_SHOWN : CALL_SHOWN),
    };
  }

  /** A boat home: the boat's own opens the finish's card. */
  finished(f: RaceFinishIn): void {
    const t = this.told.peek();
    if (t === null || t.race !== f.race) {
      return;
    }
    this.homes.set(f.number, f);
    if (f.number !== this.number()) {
      return;
    }
    this.finish.value = f;
    this.certified.value = null;
    this.finishOpen.value = true;
  }

  /** The race's results: the results' window opens over the card. */
  results(r: RaceResultsIn): void {
    const t = this.told.peek() ?? this.known.get(r.race) ?? null;
    if (t === null || (this.told.peek() !== null && this.told.peek()?.race !== r.race)) {
      return;
    }
    this.ended.value = { told: t, results: r };
    this.finishOpen.value = false;
    this.resultsOpen.value = true;
  }

  /** The boat's own race number, 0 for none. */
  number(): number {
    return this.told.peek()?.entrants.find((e) => e.me)?.number ?? 0;
  }

  /** The boat watched, by number: the page's own boat in the race, or the one it watches; 0 for none. */
  watched(): number {
    return this.number() || this.eye.peek();
  }

  /** Whether the page watches a boat of the race, rather than racing in it. */
  spectator(): boolean {
    return this.told.peek() !== null && this.number() === 0 && this.eye.peek() > 0;
  }

  /** The boat's own place in the latest picture; null without. */
  mine(): RacerAtIn | null {
    const n = this.number();
    return this.picture.peek()?.racers.find((r) => r.number === n) ?? null;
  }

  /** Each boat's track so far, by its number. */
  tracks(): ReadonlyMap<number, readonly number[]> {
    return this.#tracks;
  }

  /** Whether the call shown, and Still racing, have had their time; clears them. */
  expire(): void {
    const c = this.call.peek();
    if (c !== null && this.now() >= c.until) {
      this.call.value = null;
    }
    const a = this.asked.peek();
    if (a > 0 && this.now() >= a) {
      this.asked.value = 0;
    }
  }

  /** Every race forgotten: a new world, or the page leaving the water. */
  clear(): void {
    this.known.clear();
    this.told.value = null;
    this.#begin();
    this.ended.value = null;
    this.resultsOpen.value = false;
    this.version.value++;
  }
}

/** A boat of a race in words: its skipper's name, a machine sailor marked; or its boat and number, "the Gull, 7"; or "No. 7". */
export function entrantName(t: RaceToldIn, n: number): string {
  const e = t.entrants.find((x) => x.number === n);
  if (e === undefined) {
    return `No. ${n}`;
  }
  if (e.name !== '') {
    return e.machine ? `${e.name} ⚙` : e.name;
  }
  return e.boat !== '' ? `the ${e.boat}, ${n}` : `No. ${n}`;
}

/** The race the boat sails in as the chart draws it; null for none. */
export function raceDrawingOf(r: Racing): RaceDrawing | null {
  const told = r.told.peek();
  if (told === null) {
    return null;
  }
  const racers = r.picture.peek()?.racers ?? [];
  const boats = racers
    .filter((x) => x.state !== 'dns' && (x.east !== 0 || x.north !== 0))
    .map((x) => ({ number: x.number, east: x.east, north: x.north, place: x.place }));
  const watched = r.watched();
  return {
    told,
    tracks: r.tracks(),
    boats,
    watched,
    leader: racers.find((x) => x.place === 1)?.number ?? 0,
    next: racers.find((x) => x.number === watched)?.leg ?? -1,
    name: (n) => entrantName(told, n),
    version: r.version.peek(),
  };
}

/** The next mark the boat makes for, for its tag in the sea; null before the start, at a line, or out of the race. */
export function nextMarkOf(r: Racing): { east: number; north: number; number: number } | null {
  const t = r.told.peek();
  const me = r.mine();
  if (t === null || me === null || me.state !== 'racing') {
    return null;
  }
  const leg = t.legs[me.leg];
  if (leg === undefined || leg.mark === 0) {
    return null;
  }
  const m = t.marks.find((k) => k.number === leg.mark) ?? leg;
  return { east: m.east, north: m.north, number: leg.mark };
}

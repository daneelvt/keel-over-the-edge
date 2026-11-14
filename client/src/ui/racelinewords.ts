// SPDX-License-Identifier: AGPL-3.0-only

// The race line's words: one line over the case while the boat races.
// Before the start, the flag up, the countdown and how far the boat is
// from the line and on which side, "Over" in amber when it is on the
// course's side; racing, the place of how many, the gap to the boat ahead,
// and the next mark's number, bearing and distance; a time trial's clock
// in the place's stead; home, the place and the time. A call shows in
// its stead for a few seconds, in the log's teaching words for a bump,
// with the seconds it cost. Everything here is words and numbers; the
// line itself draws them (raceline.tsx).

import { STEPS_PER_SECOND } from '../game/clock';
import type { RaceCallIn, RaceFinishIn, RacePoint, RacerAtIn, RaceToldIn } from '../net/messages';
import { ARTICLES } from './verdict';

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Seconds as a clock: "4:07", "1:02:07"; whole seconds, rounded down. */
export function clockOf(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The time to the start: "−1:42", the minus a true minus sign. */
export function countdownOf(s: number): string {
  return `−${clockOf(Math.ceil(Math.max(0, s)))}`;
}

/** A distance on the course: metres under a kilometre, "310 m"; nautical miles beyond, "0.62 NM". */
export function distanceOf(m: number): string {
  if (m < 1000) {
    return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  }
  return `${(m / 1852).toFixed(2)} NM`;
}

/** A bearing true, three digits: "045°". */
export function bearingOf(deg: number): string {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(d).padStart(3, '0')}°`;
}

/** What the race line shows. */
export type LineView =
  /** Before the start: the flag up (the class's, then P), the countdown, the line's distance and side. */
  | { kind: 'before'; flag: 'class' | 'P'; clock: string; line: string; over: boolean }
  /** A time trial not yet begun: the line's distance and side. */
  | { kind: 'trial'; line: string; over: boolean }
  /** Racing: the place of how many or a trial's clock, the gap ahead, the next mark. */
  | {
      kind: 'racing';
      place: string;
      gap: string;
      next: { label: string; bearing: string; distance: string; turn: number };
    }
  /** Home, retired, or out of it: a line of words. */
  | { kind: 'done'; text: string };

/** What the race line is made from. */
export interface LineInput {
  told: RaceToldIn;
  /** The boat's own place in the latest picture; null before one. */
  me: RacerAtIn | null;
  /** Every boat in the latest picture. */
  racers: readonly RacerAtIn[];
  /** The world's tick now. */
  tick: number;
  /** Where the boat is now and its heading, rad clockwise from north. */
  boat: { east: number; north: number; heading: number };
  /** The boat's own finish, if home. */
  finish: RaceFinishIn | null;
}

/** The boats in a picture that started: how many the places are of. */
export function fleetOf(racers: readonly RacerAtIn[]): number {
  return racers.filter((r) => r.state !== 'dns').length;
}

/** The middle of two points. */
function middle(a: RacePoint, b: RacePoint): RacePoint {
  return { east: (a.east + b.east) / 2, north: (a.north + b.north) / 2 };
}

/** How far beyond the line's ends a boat on the course's side is still over, a share of its length: as the committee judges it. */
const OVER_BEYOND = 0.2;

/**
 * Where the boat is from the start line: how far, and whether over it, on
 * the course's side and within a fifth of its length of its ends, as the
 * committee judges a boat over early. The course's side is the side its
 * first mark lies, or its way's next point; a boat beyond the line's ends
 * is as far as the nearer end.
 */
export function lineSide(
  told: RaceToldIn,
  at: { east: number; north: number },
): { metres: number; over: boolean } | null {
  const a = told.pin;
  const b = told.committee;
  if (a === null || b === null) {
    return null;
  }
  const mid = middle(a, b);
  const ahead =
    told.legs.find((l) => l.mark > 0) ?? told.way[1] ?? told.legs[told.legs.length - 1] ?? null;
  const lx = b.east - a.east;
  const ly = b.north - a.north;
  const len = Math.hypot(lx, ly);
  if (len < 1e-6) {
    return null;
  }
  // The line's normal, toward the course's side.
  let nx = -ly / len;
  let ny = lx / len;
  if (ahead !== null && (ahead.east - mid.east) * nx + (ahead.north - mid.north) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const dx = at.east - a.east;
  const dy = at.north - a.north;
  const along = (dx * lx + dy * ly) / len;
  const across = dx * nx + dy * ny;
  const off = along < 0 ? -along : along > len ? along - len : 0;
  return {
    metres: Math.hypot(across, off),
    over: across > 0 && off <= OVER_BEYOND * len,
  };
}

/** The line's distance and side in words: "40 m to the line"; "Over · 12 m". */
export function lineWords(side: { metres: number; over: boolean } | null): string {
  if (side === null) {
    return '';
  }
  return side.over ? `Over · ${distanceOf(side.metres)}` : `${distanceOf(side.metres)} to the line`;
}

/** The next leg's name: a mark's, "Mk 2"; the finish; the start line. */
export function legLabel(told: RaceToldIn, leg: number): string {
  const l = told.legs[leg];
  if (l === undefined || l.mark === 0) {
    return leg >= told.legs.length - 1 ? 'Finish' : 'Line';
  }
  return `Mk ${l.mark}`;
}

/** The gap to the boat ahead, "+0:18"; first, the lead over the second, "lead 0:12"; "" alone. */
export function gapWords(me: RacerAtIn, racers: readonly RacerAtIn[]): string {
  if (me.place <= 0) {
    return '';
  }
  if (me.place === 1) {
    const second = racers.find((r) => r.place === 2);
    return second === undefined ? '' : `lead ${clockOf(Math.max(0, second.gap - me.gap))}`;
  }
  const ahead = racers.find((r) => r.place === me.place - 1);
  return ahead === undefined ? '' : `+${clockOf(Math.max(0, me.gap - ahead.gap))}`;
}

/** The race line, as it stands. */
export function lineView(i: LineInput): LineView {
  const { told, me, tick } = i;
  const fleet = fleetOf(i.racers);
  if (i.finish !== null || me?.state === 'finished') {
    const place = i.finish?.place ?? me?.place ?? 0;
    const added = i.finish?.added ?? me?.added ?? 0;
    const time =
      i.finish !== null
        ? ` · ${clockOf(i.finish.elapsedMs / 1000)}`
        : told.start > 0
          ? ` · ${clockOf((tick - told.start) / STEPS_PER_SECOND)}`
          : '';
    if (told.trial) {
      return { kind: 'done', text: `Home${time}${added > 0 ? ` · ${added} s added` : ''}` };
    }
    return {
      kind: 'done',
      text: `Home ${ordinal(place)}${fleet > 1 ? ` of ${fleet}` : ''}${time}${added > 0 ? ` · ${added} s added` : ''}`,
    };
  }
  switch (me?.state) {
    case 'retired':
      return { kind: 'done', text: 'Retired · the results when the race ends' };
    case 'dns':
      return { kind: 'done', text: 'Missed the start · you can watch the race' };
    case 'placedAtEnd':
      return {
        kind: 'done',
        text: `${ordinal(me.place)}${fleet > 1 ? ` of ${fleet}` : ''} · placed as the race ended`,
      };
  }
  const side = lineSide(told, i.boat);
  const started = told.start > 0 && tick >= told.start && me?.state !== 'placed';
  if (told.trial && !started) {
    return { kind: 'trial', line: lineWords(side), over: false };
  }
  if (!started) {
    const left = (told.start - tick) / STEPS_PER_SECOND;
    return {
      kind: 'before',
      flag: left <= 60 ? 'P' : 'class',
      clock: countdownOf(left),
      line: lineWords(side),
      over: side?.over === true,
    };
  }
  const leg = me?.leg ?? 0;
  const to = told.legs[leg] ?? told.legs[told.legs.length - 1] ?? null;
  const dx = (to?.east ?? i.boat.east) - i.boat.east;
  const dy = (to?.north ?? i.boat.north) - i.boat.north;
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  const heading = (i.boat.heading * 180) / Math.PI;
  const turn = ((((bearing - heading) % 360) + 540) % 360) - 180;
  const place = told.trial
    ? clockOf((tick - told.start) / STEPS_PER_SECOND)
    : me !== null && me.place > 0
      ? `${me.place}/${fleet}`
      : `–/${fleet}`;
  return {
    kind: 'racing',
    place,
    gap: told.trial || me === null ? '' : gapWords(me, i.racers),
    next: {
      label: legLabel(told, leg),
      bearing: bearingOf(bearing),
      distance: distanceOf(Math.hypot(dx, dy)),
      turn,
    },
  };
}

/** Each Article in a few words, for a narrow race line. */
const SHORT_RULES: Record<string, string> = {
  '10': 'Port keeps clear of starboard',
  '11': 'Windward keeps clear of leeward',
  '12': 'Astern keeps clear of ahead',
  '13': 'A boat tacking keeps clear',
  '15': 'Gaining right of way, give room',
  '16.1': 'Changing course, give room',
  '22': 'Keep clear of a capsized boat',
};

/** A rule of the Articles in a few words. */
function shortRule(article: string): string {
  return SHORT_RULES[article] ?? 'A bump';
}

/** A rule of the Articles as a line begins it: "Port tack keeps clear of starboard". */
function ruleOf(article: string): string {
  const r = ARTICLES[article];
  return r === undefined ? 'A bump' : r.charAt(0).toUpperCase() + r.slice(1);
}

/** A call's words: in full, and short for a narrow line; whether it warns. */
export interface CallWords {
  text: string;
  short: string;
  warn: boolean;
}

/**
 * A call in a line for the race line of boat me: the boat's own calls,
 * and the bumps it was in; null for another boat's call. A bump is told in
 * the log's teaching words for the Article that judged it, the same line
 * for both boats, and what it cost whom.
 */
export function callLine(c: RaceCallIn, me: number, name: (n: number) => string): CallWords | null {
  const mine = me > 0 && c.number === me;
  const words = (text: string, warn: boolean, short = text): CallWords => ({ text, short, warn });
  switch (c.kind) {
    case 'bump':
      if (mine) {
        return words(
          `${ruleOf(c.article)} · ${c.added} seconds added`,
          true,
          `${shortRule(c.article)} · +${c.added} s`,
        );
      }
      if (me > 0 && c.other === me) {
        return words(
          `${ruleOf(c.article)} · ${c.added} seconds to ${name(c.number)}`,
          false,
          `${shortRule(c.article)} · +${c.added} s to ${name(c.number)}`,
        );
      }
      return null;
    case 'overEarly':
      return mine ? words(`Over early · ${c.added} seconds added`, true) : null;
    case 'missedMark':
      return mine ? words(`Mark ${c.mark} missed: go back`, true) : null;
    case 'drifting':
      return mine
        ? words(
            'Still racing? Make for the next mark, or you retire in a minute',
            true,
            'Still racing? Make for the next mark',
          )
        : null;
    case 'retired':
      return mine ? words('Retired', false) : null;
    case 'rounded':
      return mine && c.mark > 0
        ? words(`Mark ${c.mark} rounded${c.place > 0 ? ` · ${ordinal(c.place)}` : ''}`, false)
        : null;
    default:
      return null;
  }
}

/** An award in a word or two, as the results and the log name it. */
export function awardName(award: string): string {
  switch (award) {
    case 'best-start':
      return 'Best start';
    case 'comeback':
      return 'Biggest comeback';
    case 'photo-finish':
      return 'Photo finish';
    case 'crowd':
      return 'Crowd’s favourite';
    case 'spoon':
      return 'The wooden spoon';
    default:
      return '';
  }
}

/** A time trial's medal in words. */
export function medalName(medal: string): string {
  switch (medal) {
    case 'harbourmaster':
      return 'The harbourmaster’s time';
    case 'gold':
      return 'Gold';
    case 'silver':
      return 'Silver';
    case 'bronze':
      return 'Bronze';
    default:
      return '';
  }
}

/**
 * The awards read out warmly, a line each, the boats named: the best
 * start, the comeback, the photo finish (its two boats in one line), the
 * crowd's favourite, and the wooden spoon to the one who never gave up.
 */
export function awardLines(
  results: readonly { number: number; awards: readonly string[] }[],
  name: (n: number) => string,
): string[] {
  const by = (a: string) => results.filter((r) => r.awards.includes(a)).map((r) => name(r.number));
  const out: string[] = [];
  const start = by('best-start');
  if (start.length > 0) {
    out.push(`Best start to ${start.join(' and ')}, away clean with the gun`);
  }
  const back = by('comeback');
  if (back.length > 0) {
    out.push(`The biggest comeback: ${back.join(' and ')}, through the fleet after the first mark`);
  }
  const photo = by('photo-finish');
  if (photo.length > 0) {
    out.push(`A photo finish! ${photo.join(' and ')}, within two seconds`);
  }
  const crowd = by('crowd');
  if (crowd.length > 0) {
    out.push(`The crowd’s favourite: ${crowd.join(' and ')}`);
  }
  const spoon = by('spoon');
  if (spoon.length > 0) {
    out.push(`The wooden spoon to ${spoon.join(' and ')}, who never gave up`);
  }
  return out;
}

/** What a boat came to, after its place: its time, how far it had to go, or why it has no place. */
export function resultWords(r: {
  how: string;
  elapsedMs: number;
  toGo: number;
  added: number;
}): string {
  const added = r.added > 0 ? ` · +${r.added} s` : '';
  switch (r.how) {
    case 'finished':
      return `${clockOf(r.elapsedMs / 1000)}${added}`;
    case 'placed':
      return `${distanceOf(r.toGo)} to go${added}`;
    case 'ret':
      return 'Retired';
    case 'dns':
      return 'Did not start';
    case 'removed':
      return 'Removed';
    default:
      return '';
  }
}

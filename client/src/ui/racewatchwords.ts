// SPDX-License-Identifier: AGPL-3.0-only

// Watching a race, in words: the race bar's two lines (the race, the leg
// and the gap to the first in small type over the place and the name of
// the boat watched), the standings' rows, the crier's lines in the news
// sheet's voice (what happens, never a forecast), and the cheers'.
// Everything here is words; racebar.tsx draws them.

import { STEPS_PER_SECOND } from '../game/clock';
import type { RaceCallIn, RaceFinishIn, RacerAtIn, RaceToldIn } from '../net/messages';
import { clockOf, ordinal } from './racelinewords';

/** The race bar's words: the line over (the race, the leg, the gap) and the place and name of the boat watched. */
export interface BarWords {
  over: string;
  place: string;
  name: string;
}

/** How many legs a race has to sail: every one after the start line. */
export function legsOf(told: RaceToldIn): number {
  return Math.max(1, told.legs.length - 1);
}

/** The race bar's words for the boat of number n, as the latest picture has it, at the world's tick. */
export function barWords(
  told: RaceToldIn,
  racers: readonly RacerAtIn[],
  n: number,
  tick: number,
  name: (n: number) => string,
): BarWords {
  const race = told.name !== '' ? told.name : 'The race';
  const r = racers.find((x) => x.number === n);
  const before = told.start <= 0 || tick < told.start;
  if (before && !told.trial) {
    const left =
      told.start > 0 ? `The start in ${clockOf((told.start - tick) / STEPS_PER_SECOND)} · ` : '';
    return { over: `${left}${race}`, place: `No. ${n}`, name: name(n) };
  }
  if (r === undefined) {
    return { over: race, place: `No. ${n}`, name: name(n) };
  }
  switch (r.state) {
    case 'finished':
      return {
        over: `Home · ${race}`,
        place: r.place > 0 ? ordinal(r.place) : 'Home',
        name: name(n),
      };
    case 'retired':
      return { over: `Retired · ${race}`, place: 'Ret', name: name(n) };
    case 'dns':
      return { over: race, place: `No. ${n}`, name: name(n) };
    default: {
      const leg = `Leg ${Math.min(Math.max(1, r.leg), legsOf(told))}/${legsOf(told)}`;
      const gap = r.place === 1 ? 'first' : r.place > 1 ? `+${clockOf(r.gap)}` : '';
      // The leg and the gap first: the race's name ends in an ellipsis where the bar is narrow.
      return {
        over: `${leg}${gap !== '' ? ` · ${gap}` : ''} · ${race}`,
        place: r.place > 0 ? ordinal(r.place) : `No. ${n}`,
        name: name(n),
      };
    }
  }
}

/** A row of the standings: the boat's number, its place, the last mark it rounded, its gap to the first or how it ended. */
export interface StandingRow {
  number: number;
  place: string;
  mark: string;
  gap: string;
  out: boolean;
}

/** The order the standings and ‹ › go in: by place, then those with none by number; boats out of the race last. */
export function standingOrder(racers: readonly RacerAtIn[]): RacerAtIn[] {
  const rank = (r: RacerAtIn) =>
    r.state === 'retired' || r.state === 'dns' ? 2 : r.place > 0 ? 0 : 1;
  return [...racers].sort(
    (a, b) => rank(a) - rank(b) || (a.place || 0) - (b.place || 0) || a.number - b.number,
  );
}

/** The standings' rows, in their order. */
export function standingRows(told: RaceToldIn, racers: readonly RacerAtIn[]): StandingRow[] {
  return standingOrder(racers).map((r) => {
    const out = r.state === 'retired' || r.state === 'dns';
    const last = told.legs[Math.max(0, r.leg - 1)];
    const mark =
      r.state === 'finished'
        ? 'Home'
        : last !== undefined && last.mark > 0 && r.state === 'racing'
          ? `Mk ${last.mark}`
          : '';
    const gap =
      r.state === 'retired'
        ? 'RET'
        : r.state === 'dns'
          ? 'DNS'
          : r.place === 1
            ? '—'
            : r.place > 1
              ? `+${clockOf(r.gap)}`
              : '';
    return {
      number: r.number,
      place: r.place > 0 && !out ? String(r.place) : '',
      mark,
      gap: r.added > 0 && !out ? `${gap} · +${r.added} s` : gap,
      out,
    };
  });
}

/** "the fight for the lead", "the fight for 3rd". */
export function fightFor(place: number): string {
  return place <= 1 ? 'the fight for the lead' : `the fight for ${ordinal(place)}`;
}

/** The crier's line as follow the action moves the watch. */
export function followLine(place: number): string {
  return `Watching ${fightFor(place)}`;
}

/** The crier's line for a call of the committee's: any boat's; null for one it leaves out. */
export function crierCall(c: RaceCallIn, name: (n: number) => string): string | null {
  switch (c.kind) {
    case 'rounded':
      if (c.mark <= 0 || c.place <= 0 || c.place > 3) {
        return null;
      }
      return c.place === 1
        ? `${name(c.number)} rounds Mark ${c.mark} first`
        : `${name(c.number)} rounds Mark ${c.mark} ${ordinal(c.place)}`;
    case 'bump':
      return c.other > 0
        ? `${name(c.number)} fouls ${name(c.other)}: ${c.added} seconds added`
        : `${name(c.number)} fouls: ${c.added} seconds added`;
    case 'overEarly':
      return `${name(c.number)} is over early: ${c.added} seconds added`;
    case 'retired':
      return `${name(c.number)} retires`;
    default:
      return null;
  }
}

/** The crier's line for a boat home; photo, home within a breath of the boat before. */
export function crierFinish(f: RaceFinishIn, photo: boolean, name: (n: number) => string): string {
  if (photo) {
    return 'A photo finish!';
  }
  return f.place === 1
    ? `${name(f.number)} takes the gun!`
    : `${name(f.number)} is home, ${ordinal(f.place)}`;
}

/** The crier's line for a change of place between two pictures: the lead, or a boat watched taking a place; null for none worth a line. */
export function crierPlaces(
  was: readonly RacerAtIn[],
  now: readonly RacerAtIn[],
  watched: number,
  name: (n: number) => string,
): string | null {
  const placeOf = (rs: readonly RacerAtIn[], n: number) =>
    rs.find((r) => r.number === n)?.place ?? 0;
  const lead = now.find((r) => r.place === 1 && r.state === 'racing');
  if (lead !== undefined && was.length > 0) {
    const before = placeOf(was, lead.number);
    if (before > 1) {
      return `${name(lead.number)} takes the lead!`;
    }
  }
  const me = now.find((r) => r.number === watched);
  if (me !== undefined && me.state === 'racing' && me.place > 1) {
    const before = placeOf(was, me.number);
    if (before > me.place) {
      return `${name(me.number)} takes ${ordinal(me.place)}`;
    }
  }
  return null;
}

/** The line under the race bar after one's own cheer: "You and 11 others cheered". */
export function cheeredLine(count: number): string {
  const others = Math.max(0, count - 1);
  return others === 0
    ? 'You cheered'
    : `You and ${others} ${others === 1 ? 'other' : 'others'} cheered`;
}

/** The watchers' line with the crowd cheering, for a few seconds: "14 watching · 12 cheering". */
export function cheeringText(watching: string, crowd: number): string {
  const c = `${crowd} cheering`;
  return watching === '' ? c : `${watching} · ${c}`;
}

/** The cheer key's words. */
export const CHEER = 'Cheer';
export const CHEER_WAIT = 'Cheered: the crowd draws breath';

/** The race bar's keys' words. */
export const AHEAD = 'The boat ahead';
export const BEHIND = 'The boat behind';
export const STANDINGS = 'Standings';
export const FOLLOW = 'Follow the action';
export const FOLLOW_DETAIL = 'The watch moves by itself to where the race is liveliest.';
export const RACE_MORE = 'The race: follow the action, the standings, watch another or sail';

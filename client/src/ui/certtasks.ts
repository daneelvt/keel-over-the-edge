// SPDX-License-Identifier: AGPL-3.0-only

// The certificates' tasks as the log's Certificates says them, loaded with
// the log: what a certificate opens, as its row says it; each task in a
// plain line, how it is done, by its measure or its courses and with its
// own numbers; and how far a task not yet done has come. The machine
// sailors' handbook says the same lines (internal/agentapi/certs.go): one
// file holds both to the same words. They come from the catalog's names
// and numbers, handed in, so this module reads no catalog of its own, and
// they live here, not in the catalog, so that changing a word does not
// begin a new world.

import { type CertBook, type CertTask, opensWords } from './certwords';

/** The boats a certificate opens, as its row says them: "Opens the skiff and the keelboat"; "" for none. */
export function opensLine(book: CertBook, place: number): string {
  const words = opensWords(book, place);
  return words === ''
    ? ''
    : `Opens ${words.charAt(0).toLowerCase()}${words.slice(1).replace(/ (is|are)$/, '')}`;
}

/** Small counts in words. */
const COUNTS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
function count(n: number): string {
  return COUNTS[n] ?? String(n);
}

/** How often, in words: "twice", "three times". */
function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${count(n)} times`;
}

/** The kinds of course, as a line names them. */
const COURSES: Record<string, string> = {
  reach: 'the Reach',
  short: 'the Short Course',
  long: 'the Long Course',
  triangle: 'the Triangle',
  'long-triangle': 'the Long Triangle',
  island: 'an island course',
};
/** The buoy courses with a beat in them: every one but the reach. */
const BUOYS = ['short', 'long', 'triangle', 'long-triangle'];

/**
 * A task's courses in words: "the Triangle", "the Triangle and the Long
 * Course", "any buoy course but the Reach (the Short Course, the Long
 * Course, the Triangle or the Long Triangle)". Any buoy course names its
 * courses, so nobody has to guess which they are.
 */
function coursesWords(courses: readonly string[], each: boolean): string {
  const names = courses.map((c) => COURSES[c] ?? `a ${c} course`);
  if (names.length < 2) {
    return names[0] ?? 'a course';
  }
  const list = `${names.slice(0, -1).join(', ')} ${each ? 'and' : 'or'} ${names[names.length - 1]}`;
  const beats = BUOYS.every((b) => courses.includes(b));
  if (beats && courses.includes('reach') && courses.length === BUOYS.length + 1) {
    return `any buoy course (${list})`;
  }
  if (beats && courses.length === BUOYS.length) {
    return `any buoy course but the Reach (${list})`;
  }
  return list;
}

/** How the reach is sailed, for a task that is sailed on it alone. */
const REACH_HOW =
  'Sail across the wind to the mark, go round it, and sail back. No tacking up the wind.';

/** What a run must come to: "finish", "bronze or better". */
function medalWords(medal: string): string {
  return medal === 'finish' ? 'finish' : `${medal} or better`;
}

/** A course's task in a line: where, alone, and its two ways. */
function courseHowTo(t: CertTask): string {
  const courses = t.courses ?? [];
  const each = t.hand?.each === true && courses.length > 1;
  const out = [`A time trial on ${coursesWords(courses, each)}, sailed alone.`];
  if (courses.length === 1 && courses[0] === 'reach') {
    out.push(REACH_HOW);
  }
  if (t.hand !== undefined) {
    const on = each ? (courses.length === 2 ? ' on both' : ' on each') : '';
    out.push(
      t.hand.medal === 'finish'
        ? `By hand: just finish${on}.`
        : `By hand: ${medalWords(t.hand.medal)}${on}.`,
    );
  }
  if (t.venture !== undefined) {
    const n = Math.max(t.venture.runs ?? 1, 1);
    const what = medalWords(t.venture.medal);
    out.push(
      t.venture.apart === true && n > 1
        ? `With the autopilot: ${what} on ${count(n)} different courses.`
        : `With the autopilot: ${what}${t.venture.medal === 'finish' ? ' ' : ', '}${times(n)}${each ? ' in all' : ''}.`,
    );
  }
  return out.join(' ');
}

/**
 * How a task is done, in a plain line, by its measure or its courses and
 * with its own numbers; "" for a measure it has no words for. Each says
 * what the judge counts, no more: a night is half an hour under way after
 * dark, a gale counts once it is ridden out, a place seen is one charted
 * or the charted place nearest where a voyage ended or life was met.
 */
export function howTo(t: CertTask): string {
  if (t.courses !== undefined && t.courses.length > 0) {
    return courseHowTo(t);
  }
  const n = t.at ?? 1;
  switch (t.measure) {
    case 'distance':
      return 'Your miles sailed alone are added each time a voyage ends.';
    case 'places-seen':
      return 'Chart a place, or end a voyage or meet a creature near one. Each place counts once.';
    case 'places-charted':
      return n === 1
        ? 'Be the first to sight a place nobody has charted yet.'
        : `Be the first to sight ${count(n)} places nobody has charted yet.`;
    case 'life-kinds':
      return n === 1
        ? 'Seabirds, dolphins, turtles, whales: any creature you meet while sailing alone counts.'
        : `Seabirds, dolphins, turtles, whales: meet ${count(n)} different kinds while sailing alone.`;
    case 'nights':
      return n === 1
        ? 'Sail for half an hour after dark, in one voyage.'
        : `Sail for half an hour after dark, on ${count(n)} voyages.`;
    case 'gales':
      return 'Find a gale on the weather chart and sail in it for ten minutes. It counts once the wind eases, or you make port. A capsize doesn’t undo it.';
    case 'storms-or-fogs':
      return 'Sail in a storm until the wind eases or you make port, or sail into a port in fog.';
    case 'lip':
      return `Sail to within ${n.toLocaleString('en')} m of the world’s edge and come back without going over.`;
    case 'falls':
      return 'Sail right off the edge of the world. Yes, really.';
    case 'worlds':
      return `Sail in ${count(n)} different worlds. A new world begins every week.`;
    case 'every-weather':
      return 'Sail in a gale and in a storm, sail into a port in fog, and sail half an hour after dark.';
    default:
      return '';
  }
}

/** Whether a task is a course's. */
export function isCourse(t: CertTask): boolean {
  return t.courses !== undefined && t.courses.length > 0;
}

/** Whether a way of a certificate's course tasks asks a medal: its footnote on par is then owed. */
export function asksMedal(tasks: readonly CertTask[]): boolean {
  return tasks.some(
    (t) => isCourse(t) && [t.hand, t.venture].some((w) => w !== undefined && w.medal !== 'finish'),
  );
}

/** Under a certificate's tasks, once: what by hand means, where it has a course's task. */
export const BY_HAND_MEANS = 'By hand means the autopilot stays off for the whole run.';
/** And what the medals are, where one is asked. */
export const MEDALS_MEAN =
  'Bronze is one and a half times your boat’s par time, silver a fifth over par, gold par.';

/** How far a task not yet done has come, as the log's answer has it. */
export interface CertProgress {
  done?: boolean;
  runs?: number;
  of?: number;
  have?: number;
  at?: number;
  closest?: number;
  met?: readonly string[];
}

/** The four kinds of weather every weather asks, as the log's answer names them, each in a word. */
const WEATHERS: [string, string][] = [
  ['gale', 'gale'],
  ['storm', 'storm'],
  ['landfall-in-fog', 'fog'],
  ['night-at-sea', 'night'],
];

/**
 * How far a task not yet done has come: "1.4 of 3 NM", "2 of 3", "closest
 * so far 640 m", "gale ✓ · storm · fog · night ✓", a venture's "the
 * autopilot way, 1 of 2"; "" for one done, one not begun that asks one
 * thing, or nothing told.
 */
export function howFar(t: CertTask, p: CertProgress): string {
  if (p.done === true) {
    return '';
  }
  if (isCourse(t)) {
    return (p.runs ?? 0) > 0 && (p.of ?? 0) > 1 ? `the autopilot way, ${p.runs} of ${p.of}` : '';
  }
  switch (t.measure) {
    case 'distance': {
      if (p.at === undefined) {
        return '';
      }
      // Rounded down: never the mark itself while the task is not done.
      const have = Math.floor((p.have ?? 0) * 10 + 1e-6) / 10;
      return `${have.toLocaleString('en')} of ${p.at.toLocaleString('en')} NM`;
    }
    case 'lip':
      return p.closest === undefined
        ? ''
        : `closest so far ${Math.round(p.closest).toLocaleString('en')} m`;
    case 'every-weather': {
      const met = p.met ?? [];
      return WEATHERS.map(([k, w]) => (met.includes(k) ? `${w} ✓` : w)).join(' · ');
    }
    default:
      return p.at !== undefined && p.at > 1 ? `${p.have ?? 0} of ${p.at}` : '';
  }
}

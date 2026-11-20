// SPDX-License-Identifier: AGPL-3.0-only

// Certificates as the phone says them: what a run counted, on the
// finish's card (or its results, a trial's); a task of the log done, a
// passing notice; a certificate earned, a notice that stays with See,
// which opens the log's Certificates, and the harbour's bell rung twice;
// on going to sea, once, how far the next one has come. And each task in
// a plain line: how it is done, by its measure or its courses, with its
// own numbers, and how far it has come. The words come from the catalog's
// names and numbers, handed in, so this module reads no catalog of its
// own.

import type { CertifiedIn } from '../net/messages';

/** What raises the notices of certificates. */
export const TASK_DONE = 'task-done';
export const CERTIFICATE_EARNED = 'certificate-earned';

/** The key on a certificate earned's notice: the log's Certificates. */
export const SEE = 'See';

/** How many strokes the bell rings for a certificate earned. */
export const BELL_STROKES = 2;

/** A way a course's task is done, as the catalog has it: the medal a run needs, how many runs, on each of its courses, or each on a different one. */
export interface CertWay {
  medal: string;
  runs?: number;
  each?: boolean;
  apart?: boolean;
}

/** A task as the catalog has it: a task of the log, a measure and its mark; or a course's, its courses and its two ways. */
export interface CertTask {
  name: string;
  measure?: string;
  at?: number;
  courses?: readonly string[];
  hand?: CertWay;
  venture?: CertWay;
}

/** The catalog's certificates and boats, as far as their words need them. */
export interface CertBook {
  certificates: readonly {
    name: string;
    opens: readonly string[];
    tasks: readonly CertTask[];
  }[];
  boats: readonly { id: string; name: string }[];
}

/** The way a task counted, as words after its tick: "" by hand or for the log's. */
function wayAfter(c: CertifiedIn): string {
  return c.way === 'pilot' ? ' the autopilot way' : '';
}

/**
 * The boats a certificate opens, as a sentence opens them: "The skiff and
 * the keelboat are", "The beach cat is"; "" for none.
 */
export function opensWords(book: CertBook, place: number): string {
  const names = (book.certificates[place]?.opens ?? []).map(
    (id) => `the ${(book.boats.find((b) => b.id === id)?.name ?? id).toLowerCase()}`,
  );
  if (names.length === 0) {
    return '';
  }
  const list =
    names.length === 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length === 1 ? 'is' : 'are'}`;
}

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
  short: 'the Short Course',
  long: 'the Long Course',
  triangle: 'the Triangle',
  'long-triangle': 'the Long Triangle',
  island: 'an island course',
};
const BUOYS = ['short', 'long', 'triangle', 'long-triangle'];

/** A task's courses in words: "the Triangle", "the Triangle and the Long Course", "any buoy course". */
function coursesWords(courses: readonly string[], each: boolean): string {
  if (BUOYS.every((b) => courses.includes(b)) && courses.length === BUOYS.length) {
    return 'any buoy course';
  }
  const names = courses.map((c) => COURSES[c] ?? `a ${c} course`);
  if (names.length < 2) {
    return names[0] ?? 'a course';
  }
  return `${names.slice(0, -1).join(', ')} ${each ? 'and' : 'or'} ${names[names.length - 1]}`;
}

/** What a run must come to: "finish", "bronze or better". */
function medalWords(medal: string): string {
  return medal === 'finish' ? 'finish' : `${medal} or better`;
}

/** A course's task in a line: where, alone, and its two ways. */
function courseHowTo(t: CertTask): string {
  const courses = t.courses ?? [];
  const each = t.hand?.each === true && courses.length > 1;
  const out = [`A time trial on ${coursesWords(courses, each)}, sailed alone.`];
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
      return 'Find a gale on the weather chart and sail in it for ten minutes. It counts once the wind eases, or you make port.';
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

/** Whether what was told is of a course's task: by hand or on the autopilot. */
export function ofCourse(c: CertifiedIn): boolean {
  return c.task >= 0 && (c.way === 'hand' || c.way === 'pilot');
}

/**
 * A course's task as the finish's card says it: "Toward Helm: The
 * Triangle, bronze ✓ · 3 of 4"; "… ✓ the autopilot way · 3 of 4"; a run
 * nearer its venture, "Toward Helm: The Triangle, bronze · the autopilot
 * way, 1 of 2". "" for no task.
 */
export function finishLine(book: CertBook, c: CertifiedIn): string {
  const cert = book.certificates[c.certificate];
  const task = cert?.tasks[c.task];
  if (cert === undefined || task === undefined) {
    return '';
  }
  if (c.runsOf > 0) {
    return `Toward ${cert.name}: ${task.name} · the autopilot way, ${c.runs} of ${c.runsOf}`;
  }
  return `Toward ${cert.name}: ${task.name} ✓${wayAfter(c)} · ${c.done} of ${c.of}`;
}

/** A task done's notice's words filled in: null for none told, or a run nearer a venture (the card says those). */
export function taskFill(book: CertBook, c: CertifiedIn): Record<string, string> | null {
  const cert = book.certificates[c.certificate];
  const task = cert?.tasks[c.task];
  if (cert === undefined || task === undefined || c.runsOf > 0) {
    return null;
  }
  return {
    cert: cert.name,
    task: `${task.name}${wayAfter(c)}`,
    done: String(c.done),
    of: String(c.of),
  };
}

/** A certificate earned's notice's words filled in: null for none earned. */
export function earnedFill(book: CertBook, c: CertifiedIn): Record<string, string> | null {
  const cert = book.certificates[c.certificate];
  if (cert === undefined || !c.earned) {
    return null;
  }
  return { cert: cert.name, boats: opensWords(book, c.certificate) };
}

/** Where a sailor stands toward the next certificate, as far as a line says it. */
export interface TowardCount {
  name: string;
  done: number;
  needs: number;
}

/** The line on going to sea: "Toward Helm · 2 of 4". */
export function towardLine(t: TowardCount): string {
  return `Toward ${t.name} · ${Math.min(t.done, t.needs)} of ${t.needs}`;
}

/** Where the player stands toward the next certificate, read from their own log's certificates; null after the last, or if not had. */
export async function readToward(): Promise<TowardCount | null> {
  try {
    const res = await fetch('/api/me/log?part=certificates', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      return null;
    }
    const t = ((await res.json()) as { toward?: Partial<TowardCount> } | null)?.toward;
    return typeof t?.name === 'string' && typeof t.done === 'number' && typeof t.needs === 'number'
      ? { name: t.name, done: t.done, needs: t.needs }
      : null;
  } catch {
    return null;
  }
}

/**
 * On going to sea, once a visit: how far the next certificate has come,
 * said as a passing notice under the tasks' own switch, so a sailor knows
 * one is coming. Nothing after the last, or if the log is not had.
 */
export async function towardAtSea(
  read: () => Promise<TowardCount | null>,
  say: (on: string, text: string) => void,
): Promise<void> {
  const t = await read();
  if (t !== null) {
    say(TASK_DONE, towardLine(t));
  }
}

/** What a page does with what it is told of certificates. */
export interface CertParts {
  book: CertBook;
  /** The finish's card's line, and whether the card or a trial's results are open to show it. */
  line: { value: string | null };
  shown: () => boolean;
  /** Raises a notice, with a key if given. */
  raise: (
    on: string,
    fill: Record<string, string>,
    action?: { label: string; act: () => void },
  ) => void;
  /** Opens the log's Certificates. */
  see: () => void;
  /** Rings the bell. */
  bell: (strokes: number) => void;
}

/**
 * What the sailor's certificates came to, told: a course's task on the
 * finish's card (a notice too while no card is open, but never for a run
 * nearer its venture); a task of the log as a passing notice; a
 * certificate earned as a notice with See, and the bell.
 */
export function certifiedTold(p: CertParts, c: CertifiedIn): void {
  if (ofCourse(c)) {
    const line = finishLine(p.book, c);
    if (line !== '') {
      p.line.value = line;
    }
  }
  const fill = taskFill(p.book, c);
  if (fill !== null && (!ofCourse(c) || !p.shown())) {
    p.raise(TASK_DONE, fill);
  }
  const earned = earnedFill(p.book, c);
  if (earned !== null) {
    p.raise(CERTIFICATE_EARNED, earned, { label: SEE, act: p.see });
    p.bell(BELL_STROKES);
  }
}

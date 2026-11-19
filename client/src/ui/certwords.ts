// SPDX-License-Identifier: AGPL-3.0-only

// Certificates as the phone says them: what a run counted, on the
// finish's card (or its results, a trial's); a task of the log done, a
// passing notice; a certificate earned, a notice that stays with See,
// which opens the log's Ribbons, and the harbour's bell rung twice. The
// words come from the catalog's names, handed in, so this module reads
// no catalog of its own.

import type { CertifiedIn } from '../net/messages';

/** What raises the notices of certificates. */
export const TASK_DONE = 'task-done';
export const CERTIFICATE_EARNED = 'certificate-earned';

/** The key on a certificate earned's notice: the log's Ribbons. */
export const SEE = 'See';

/** How many strokes the bell rings for a certificate earned. */
export const BELL_STROKES = 2;

/** The catalog's certificates and boats, as far as their words need them. */
export interface CertBook {
  certificates: readonly {
    name: string;
    opens: readonly string[];
    tasks: readonly { name: string }[];
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
  /** Opens the log's Ribbons. */
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

// SPDX-License-Identifier: AGPL-3.0-only

// Certificates as the phone says them: a course's task on the finish's
// card, a notice only while no card shows it and never for a run nearer a
// venture; a task of the log a passing notice; a certificate earned a
// notice with See and the bell rung twice; the catalog's notices' words
// filled in whole; and the boats it opens as a sentence opens them; and
// the line on going to sea.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { CertifiedIn } from '../net/messages';
import {
  BELL_STROKES,
  CERTIFICATE_EARNED,
  type CertBook,
  type CertParts,
  certifiedTold,
  finishLine,
  opensWords,
  SEE,
  TASK_DONE,
  taskFill,
  towardAtSea,
  towardLine,
} from './certwords';
import { fillText } from './notices';

const book: CertBook = {
  certificates: [
    {
      name: 'Deckhand',
      opens: ['skiff', 'keelboat'],
      tasks: [{ name: 'The Short Course' }, { name: 'Sail 1 NM alone' }],
    },
    { name: 'Helm', opens: ['beach-cat'], tasks: [{ name: 'The Triangle, bronze' }] },
  ],
  boats: [
    { id: 'skiff', name: 'Skiff' },
    { id: 'keelboat', name: 'Keelboat' },
    { id: 'beach-cat', name: 'Beach cat' },
  ],
};

function told(o: Partial<CertifiedIn> = {}): CertifiedIn {
  return {
    certificate: 0,
    task: 0,
    done: 1,
    of: 3,
    way: 'hand',
    runs: 0,
    runsOf: 0,
    earned: false,
    byHand: false,
    ...o,
  };
}

/** A page's parts that keep what they were asked. */
function page(shown = false) {
  const raised: {
    on: string;
    fill: Record<string, string>;
    label: string | undefined;
    act: (() => void) | undefined;
  }[] = [];
  const rung: number[] = [];
  let seen = 0;
  const p: CertParts = {
    book,
    line: { value: null },
    shown: () => shown,
    raise: (on, fill, action) => raised.push({ on, fill, label: action?.label, act: action?.act }),
    see: () => {
      seen++;
    },
    bell: (n) => rung.push(n),
  };
  return { p, raised, rung, seen: () => seen };
}

describe('the words of certificates', () => {
  test('a course’s task, by hand, the autopilot way and a run nearer its venture', () => {
    expect(finishLine(book, told())).toBe('Toward Deckhand: The Short Course ✓ · 1 of 3');
    expect(finishLine(book, told({ way: 'pilot', done: 2 }))).toBe(
      'Toward Deckhand: The Short Course ✓ the autopilot way · 2 of 3',
    );
    expect(finishLine(book, told({ way: 'pilot', done: 0, runs: 1, runsOf: 2 }))).toBe(
      'Toward Deckhand: The Short Course · the autopilot way, 1 of 2',
    );
    expect(finishLine(book, told({ task: -1 }))).toBe('');
    expect(finishLine(book, told({ certificate: 9 }))).toBe('');
  });

  test('the boats a certificate opens, as a sentence opens them', () => {
    expect(opensWords(book, 0)).toBe('The skiff and the keelboat are');
    expect(opensWords(book, 1)).toBe('The beach cat is');
    expect(opensWords(book, 5)).toBe('');
  });

  test('no notice of a run nearer a venture', () => {
    expect(taskFill(book, told({ runs: 1, runsOf: 2, way: 'pilot' }))).toBeNull();
  });

  test('the catalog’s notices fill in whole, for every certificate and task', () => {
    const kinds = catalog.notices.kinds;
    const task = kinds.find((k) => k.on === TASK_DONE);
    const earned = kinds.find((k) => k.on === CERTIFICATE_EARNED);
    expect(task?.level).toBe('passive');
    expect(earned?.level).toBe('active');
    const real: CertBook = { certificates: catalog.certificates ?? [], boats: catalog.boats };
    expect(real.certificates.length).toBeGreaterThan(0);
    real.certificates.forEach((c, i) => {
      expect(opensWords(real, i)).toMatch(/^The .+ (is|are)$/);
      c.tasks.forEach((_, j) => {
        const fill = taskFill(real, told({ certificate: i, task: j, way: 'log' })) ?? {};
        for (const text of [task?.text ?? '', task?.folded ?? '']) {
          expect(fillText(text, { ...fill, count: '2' })).not.toMatch(/[{}]/);
        }
      });
      const e = fillText(earned?.text ?? '', { cert: c.name, boats: opensWords(real, i) });
      expect(e).toMatch(new RegExp(`^You're a ${c.name}! The .+ yours to take$`));
    });
  });
});

describe('what a page does with what it is told', () => {
  test('a task of the log: a passing notice', () => {
    const { p, raised, rung } = page();
    certifiedTold(p, told({ task: 1, way: 'log', done: 2 }));
    expect(raised).toEqual([
      {
        on: TASK_DONE,
        fill: { cert: 'Deckhand', task: 'Sail 1 NM alone', done: '2', of: '3' },
        label: undefined,
        act: undefined,
      },
    ]);
    expect(p.line.value).toBeNull();
    expect(rung).toEqual([]);
  });

  test('a course’s task on the finish’s card, a notice too while no card shows it', () => {
    const open = page(true);
    certifiedTold(open.p, told());
    expect(open.p.line.value).toBe('Toward Deckhand: The Short Course ✓ · 1 of 3');
    expect(open.raised).toEqual([]);
    const closed = page(false);
    certifiedTold(closed.p, told());
    expect(closed.raised.map((r) => r.on)).toEqual([TASK_DONE]);
    // A run nearer its venture: the card alone.
    const venture = page(false);
    certifiedTold(venture.p, told({ way: 'pilot', done: 0, runs: 1, runsOf: 2 }));
    expect(venture.p.line.value).toBe(
      'Toward Deckhand: The Short Course · the autopilot way, 1 of 2',
    );
    expect(venture.raised).toEqual([]);
  });

  test('a certificate earned: a notice with See, which opens the log, and the bell twice', () => {
    const { p, raised, rung, seen } = page(true);
    certifiedTold(p, told({ task: 1, way: 'log', done: 3, earned: true, byHand: true }));
    expect(raised.map((r) => r.on)).toEqual([TASK_DONE, CERTIFICATE_EARNED]);
    const e = raised[1];
    expect(e?.fill).toEqual({ cert: 'Deckhand', boats: 'The skiff and the keelboat are' });
    expect(e?.label).toBe(SEE);
    e?.act?.();
    expect(seen()).toBe(1);
    expect(rung).toEqual([BELL_STROKES]);
    expect(BELL_STROKES).toBe(2);
    // Earned with no task newly done: the earning alone.
    const alone = page();
    certifiedTold(alone.p, told({ task: -1, done: 3, earned: true }));
    expect(alone.raised.map((r) => r.on)).toEqual([CERTIFICATE_EARNED]);
  });
});

describe('on going to sea', () => {
  test('how far the next certificate has come, said once under the tasks’ switch', async () => {
    expect(towardLine({ name: 'Helm', done: 2, needs: 4 })).toBe('Toward Helm · 2 of 4');
    expect(towardLine({ name: 'Helm', done: 5, needs: 4 })).toBe('Toward Helm · 4 of 4');
    const said: [string, string][] = [];
    await towardAtSea(
      async () => ({ name: 'Deckhand', done: 0, needs: 3 }),
      (on, text) => said.push([on, text]),
    );
    expect(said).toEqual([[TASK_DONE, 'Toward Deckhand · 0 of 3']]);
    // After the last, or the log not had: nothing.
    await towardAtSea(
      async () => null,
      (on, text) => said.push([on, text]),
    );
    expect(said).toHaveLength(1);
  });
});

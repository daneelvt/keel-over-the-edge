// SPDX-License-Identifier: AGPL-3.0-only

// Certificates as the phone says them: a course's task on the finish's
// card, a notice only while no card shows it and never for a run nearer a
// venture; a task of the log a passing notice; a certificate earned a
// notice with See and the bell rung twice; the catalog's notices' words
// filled in whole; and the boats it opens as a sentence opens them. Each
// task in a plain line, how it is done and how far it has come, with no
// task of the catalog's left without one; and the line on going to sea.

import { readFileSync } from 'node:fs';
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
  howFar,
  howTo,
  opensLine,
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

describe('how a task is done, in a plain line', () => {
  const certs = catalog.certificates ?? [];
  const tasks = certs.flatMap((c) => c.tasks.map((t) => ({ cert: c.name, t })));

  test('no task of the catalog’s is left without one, and none has a hole in it', () => {
    expect(tasks.length).toBeGreaterThan(20);
    for (const { cert, t } of tasks) {
      const line = howTo(t);
      expect(line, `${cert}: ${t.name}`).not.toBe('');
      expect(line, `${cert}: ${t.name}`).not.toMatch(/undefined|NaN|\{|\}| {2}/);
      expect(line, `${cert}: ${t.name}`).toMatch(/\.$/);
    }
  });

  test('a person and a machine sailor read the same lines: the file the machine sailors’ handbook is held to', () => {
    const lines = tasks.map(({ cert, t }) => `${cert}\t${t.name}\t${howTo(t)}\n`).join('');
    const held = readFileSync(
      new URL('../../../internal/agentapi/testdata/certificates_howto.golden.txt', import.meta.url),
      'utf8',
    );
    expect(lines).toBe(held);
  });

  test('every measure and every kind of course the catalog’s tasks use has words of its own', () => {
    const measures = new Set(tasks.flatMap(({ t }) => ('measure' in t ? [t.measure] : [])));
    // Every measure the catalog knows is used by a task, so each is walked above.
    expect([...measures].sort()).toEqual([
      'distance',
      'every-weather',
      'falls',
      'gales',
      'life-kinds',
      'lip',
      'nights',
      'places-charted',
      'places-seen',
      'storms-or-fogs',
      'worlds',
    ]);
    const byMeasure = new Map<string, string>();
    for (const m of measures) {
      byMeasure.set(m ?? '', howTo({ name: 'A task', measure: m, at: 2 }));
    }
    expect(new Set(byMeasure.values()).size).toBe(measures.size);
    for (const kind of new Set(tasks.flatMap(({ t }) => ('courses' in t ? [...t.courses] : [])))) {
      const line = howTo({ name: 'A course', courses: [kind], hand: { medal: 'finish' } });
      expect(line, kind).not.toContain(`a ${kind} course`);
    }
    // A measure with no words: the name alone.
    expect(howTo({ name: 'A task', measure: 'a-measure-to-come', at: 1 })).toBe('');
  });

  test('a task of the log, with its own numbers', () => {
    expect(howTo({ name: 'x', measure: 'lip', at: 500 })).toBe(
      'Sail to within 500 m of the world’s edge and come back without going over.',
    );
    expect(howTo({ name: 'x', measure: 'life-kinds', at: 2 })).toContain('two different kinds');
    expect(howTo({ name: 'x', measure: 'life-kinds', at: 1 })).toContain('any creature');
    expect(howTo({ name: 'x', measure: 'worlds', at: 2 })).toBe(
      'Sail in two different worlds. A new world begins every week.',
    );
    expect(howTo({ name: 'x', measure: 'nights', at: 1 })).toBe(
      'Sail for half an hour after dark, in one voyage.',
    );
  });

  test('a course’s task: where, alone, and its two ways', () => {
    expect(
      howTo({
        name: 'The Short Course',
        courses: ['short'],
        hand: { medal: 'finish' },
        venture: { medal: 'finish', runs: 2 },
      }),
    ).toBe(
      'A time trial on the Short Course, sailed alone. By hand: just finish. With the autopilot: finish twice.',
    );
    expect(
      howTo({
        name: 'Any buoy course, silver',
        courses: ['short', 'long', 'triangle', 'long-triangle'],
        hand: { medal: 'silver' },
        venture: { medal: 'bronze', runs: 3 },
      }),
    ).toBe(
      'A time trial on any buoy course, sailed alone. By hand: silver or better. With the autopilot: bronze or better, three times.',
    );
    // One on each of its courses by hand; runs each on a different course.
    expect(
      howTo({
        name: 'The Triangle and the Long Course, silver',
        courses: ['triangle', 'long'],
        hand: { medal: 'silver', each: true },
        venture: { medal: 'silver', runs: 4 },
      }),
    ).toBe(
      'A time trial on the Triangle and the Long Course, sailed alone. By hand: silver or better on both. With the autopilot: silver or better, four times in all.',
    );
    expect(
      howTo({
        name: 'An island course',
        courses: ['island'],
        hand: { medal: 'finish' },
        venture: { medal: 'finish', runs: 2, apart: true },
      }),
    ).toBe(
      'A time trial on an island course, sailed alone. By hand: just finish. With the autopilot: finish on two different courses.',
    );
  });

  test('how far a task has come', () => {
    const miles = { name: 'Sail 3 NM alone', measure: 'distance', at: 3 };
    expect(howFar(miles, { have: 1.45, at: 3 })).toBe('1.4 of 3 NM');
    expect(howFar(miles, { at: 3 })).toBe('0 of 3 NM');
    // Never the mark itself while not done.
    expect(howFar(miles, { have: 2.99, at: 3 })).toBe('2.9 of 3 NM');
    expect(howFar(miles, { done: true, have: 3, at: 3 })).toBe('');
    expect(howFar({ name: 'x', measure: 'places-seen', at: 3 }, { have: 2, at: 3 })).toBe('2 of 3');
    // One thing asked, not yet done: nothing to count.
    expect(howFar({ name: 'x', measure: 'nights', at: 1 }, { at: 1 })).toBe('');
    const lip = { name: 'x', measure: 'lip', at: 500 };
    expect(howFar(lip, { at: 500, closest: 640 })).toBe('closest so far 640 m');
    expect(howFar(lip, { at: 500 })).toBe('');
    expect(
      howFar({ name: 'x', measure: 'every-weather', at: 1 }, { met: ['gale', 'night-at-sea'] }),
    ).toBe('gale ✓ · storm · fog · night ✓');
    const course = { name: 'x', courses: ['short'], venture: { medal: 'finish', runs: 2 } };
    expect(howFar(course, { runs: 1, of: 2 })).toBe('the autopilot way, 1 of 2');
    expect(howFar(course, { of: 2 })).toBe('');
  });

  test('what a certificate opens, as its row says it', () => {
    expect(opensLine(book, 0)).toBe('Opens the skiff and the keelboat');
    expect(opensLine(book, 1)).toBe('Opens the beach cat');
    expect(opensLine(book, 7)).toBe('');
    const real = { certificates: certs, boats: catalog.boats };
    for (const [i, c] of certs.entries()) {
      expect(opensLine(real, i), c.name).toMatch(/^Opens the /);
    }
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

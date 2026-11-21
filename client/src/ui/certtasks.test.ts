// SPDX-License-Identifier: AGPL-3.0-only

// The certificates' tasks in plain lines: how each is done, by its
// measure or its courses and with its own numbers, no task of the
// catalog's left without one, and the same lines the machine sailors'
// handbook says; how far a task has come; and what a certificate opens,
// as its row says it.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { howFar, howTo, opensLine } from './certtasks';
import type { CertBook } from './certwords';

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
    // The reach, sailed alone on it: how it is sailed, in a breath.
    expect(
      howTo({
        name: 'The Reach',
        courses: ['reach'],
        hand: { medal: 'finish' },
        venture: { medal: 'finish', runs: 2 },
      }),
    ).toBe(
      'A time trial on the Reach, sailed alone. Sail across the wind to the mark, go round it, and sail back. No tacking up the wind. By hand: just finish. With the autopilot: finish twice.',
    );
    // Any buoy course names its courses, with the reach or without it.
    expect(
      howTo({
        name: 'Any buoy course but the Reach, silver',
        courses: ['short', 'long', 'triangle', 'long-triangle'],
        hand: { medal: 'silver' },
        venture: { medal: 'bronze', runs: 3 },
      }),
    ).toBe(
      'A time trial on any buoy course but the Reach (the Short Course, the Long Course, the Triangle or the Long Triangle), sailed alone. By hand: silver or better. With the autopilot: bronze or better, three times.',
    );
    expect(
      howTo({
        name: 'Any buoy course',
        courses: ['reach', 'short', 'long', 'triangle', 'long-triangle'],
        hand: { medal: 'finish' },
      }),
    ).toBe(
      'A time trial on any buoy course (the Reach, the Short Course, the Long Course, the Triangle or the Long Triangle), sailed alone. By hand: just finish.',
    );
    // A gale counts however it went: a capsize does not undo it.
    expect(howTo({ name: 'x', measure: 'gales', at: 1 })).toContain('A capsize doesn’t undo it.');
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

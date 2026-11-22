// SPDX-License-Identifier: AGPL-3.0-only

// The notices of races: the next harbour race at its minutes before the
// start, only to a sailor who may enter it and has not, and only within
// the minute after each, never late; each race entered at its own; each
// once.

import { describe, expect, test } from 'vitest';
import type { RacesBoard, Summary } from './raceapi';
import { dueNotices, HARBOUR_RACE, RACE_CALLED_OFF, RACE_SOON } from './racenotices';

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 14, 4, 0);

const kinds = [
  { on: HARBOUR_RACE, before: [10] },
  { on: RACE_SOON, before: [5, 1] },
  { on: 'falls-soon', before: [60] },
];

function race(o: Partial<Summary> = {}): Summary {
  return {
    code: 'harbouraaa',
    name: 'the Midnight Run',
    kind: 'race',
    phase: 'open',
    harbour: true,
    who: 'everyone',
    boat: { id: 'b', name: 'Jolly boat' },
    startsAt: START,
    entered: 3,
    most: 12,
    mine: { owner: false, entered: false },
    enter: { ok: true },
    ...o,
  };
}

function board(o: Partial<RacesBoard> = {}): RacesBoard {
  return {
    harbour: [race(), race({ code: 'harbourbbb', startsAt: START + 3 * 60 * MINUTE })],
    greenhorn: [],
    mine: [],
    make: {
      can: { ok: true },
      earliest: 0,
      latest: 0,
      who: ['everyone'],
      boat: 'b',
      boats: [],
      courses: [],
    },
    ...o,
  };
}

describe('the harbour race', () => {
  test('ten minutes before, within the minute after, with Enter: the next only', () => {
    const shown = new Set<string>();
    expect(dueNotices(board(), kinds, START - 10 * MINUTE - 1000, shown, 'en')).toEqual([]);
    const due = dueNotices(board(), kinds, START - 10 * MINUTE + 20_000, shown, 'en');
    expect(due).toHaveLength(1);
    expect(due[0]?.on).toBe(HARBOUR_RACE);
    expect(due[0]?.enter).toBe(true);
    expect(due[0]?.race.code).toBe('harbouraaa');
    expect(due[0]?.fill.name).toBe('the Midnight Run');
    expect(due[0]?.fill.boat).toBe('Jolly boats');
    expect(due[0]?.fill.left).toMatch(/10/);
    // Once.
    expect(dueNotices(board(), kinds, START - 10 * MINUTE + 40_000, shown, 'en')).toEqual([]);
  });

  test('never late: a page that comes after the minute says nothing', () => {
    expect(dueNotices(board(), kinds, START - 8 * MINUTE, new Set(), 'en')).toEqual([]);
  });

  test('nothing to a sailor entered already, or one who may not enter', () => {
    const at = START - 10 * MINUTE + 1000;
    const entered = board({ harbour: [race({ mine: { owner: false, entered: true } })] });
    expect(dueNotices(entered, kinds, at, new Set())).toEqual([]);
    const greenhorn = board({
      harbour: [race({ who: 'newcomers', enter: { ok: false, reason: 'newcomers' } })],
    });
    expect(dueNotices(greenhorn, kinds, at, new Set())).toEqual([]);
  });
});

describe('the races entered', () => {
  test('five minutes before and one, each once; none for a race only owned, or cancelled', () => {
    const mine = race({ code: 'mineaaaaaa', harbour: false, mine: { owner: true, entered: true } });
    const owned = race({
      code: 'ownedaaaaa',
      harbour: false,
      mine: { owner: true, entered: false },
    });
    const off = race({
      code: 'offaaaaaaa',
      harbour: false,
      phase: 'cancelled',
      mine: { owner: false, entered: true },
    });
    const b = board({ harbour: [], mine: [mine, owned, off] });
    const shown = new Set<string>();
    const five = dueNotices(b, kinds, START - 5 * MINUTE + 1000, shown, 'en');
    expect(five.map((d) => [d.on, d.race.code, d.enter])).toEqual([
      [RACE_SOON, 'mineaaaaaa', false],
    ]);
    expect(dueNotices(b, kinds, START - 5 * MINUTE + 2000, shown, 'en')).toEqual([]);
    const one = dueNotices(b, kinds, START - MINUTE + 1000, shown, 'en');
    expect(one).toHaveLength(1);
    expect(one[0]?.fill.left).toMatch(/1/);
  });
});

describe('a race called off for a storm', () => {
  const withOff = [...kinds, { on: RACE_CALLED_OFF }];
  const off = race({
    code: 'stormedaaa',
    phase: 'cancelled',
    calledOff: 'storm',
    mine: { owner: false, entered: true },
  });
  const next = race({ code: 'harbourbbb', startsAt: START + 3 * 60 * MINUTE });

  test('told once to its entrant, with the next harbour race', () => {
    const shown = new Set<string>();
    const b = board({ harbour: [next], mine: [off] });
    const due = dueNotices(b, withOff, START - 2 * MINUTE, shown, 'en-US');
    expect(due).toHaveLength(1);
    expect(due[0]?.on).toBe(RACE_CALLED_OFF);
    expect(due[0]?.fill.name).toBe('Midnight Run');
    expect(due[0]?.fill.next).toMatch(/^The next harbour race is at /);
    expect(dueNotices(b, withOff, START, shown, 'en-US')).toEqual([]);
  });

  test('not to one not entered, nor long after, nor a race cancelled by its owner', () => {
    const b = (s: Summary) => board({ harbour: [next], mine: [s] });
    expect(
      dueNotices(b({ ...off, mine: { owner: true, entered: false } }), withOff, START, new Set()),
    ).toEqual([]);
    expect(dueNotices(b(off), withOff, START + 31 * MINUTE, new Set())).toEqual([]);
    const { calledOff: _, ...cancelled } = off;
    expect(dueNotices(b(cancelled), withOff, START, new Set())).toEqual([]);
    // Without its kind in the catalog, nothing.
    expect(dueNotices(b(off), kinds, START, new Set())).toEqual([]);
  });
});

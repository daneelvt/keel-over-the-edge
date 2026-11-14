// SPDX-License-Identifier: AGPL-3.0-only

// The race the boat sails in: told without names and then with them (the
// code and name kept), a race in sight but not the boat's left off the
// line, each boat's track gathered from the pictures from the start and
// ended at its finish, the boat's own calls shown for a while, its finish
// opening the card and the results opening their window, and the race let
// go when its course is taken up.

import { describe, expect, test } from 'vitest';
import { course, racer } from './racesamples';
import { CALL_SHOWN, entrantName, Racing } from './racestate';

describe('the race the boat sails in', () => {
  test('told twice, its names kept; another race in sight is only known', () => {
    const r = new Racing();
    r.tell(course({ race: 9, entrants: [] }));
    expect(r.told.value).toBeNull();
    expect(r.known.has(9)).toBe(true);
    r.tell(course({ code: '', name: '' }));
    r.tell(course({ code: '', name: '' }));
    expect(r.told.value?.race).toBe(3);
    r.tell(course());
    r.tell(course({ code: '', name: '' }));
    expect(r.told.value?.code).toBe('abcdefghij');
    expect(r.told.value?.name).toBe('The Noon Gun');
    expect(r.number()).toBe(1);
    expect(entrantName(course(), 2)).toBe('the Petrel, 2');
    expect(entrantName(course(), 3)).toBe('Iron Mary ⚙');
    expect(entrantName(course(), 7)).toBe('No. 7');
    r.tell(course({ gone: true }));
    expect(r.told.value).toBeNull();
    expect(r.known.has(3)).toBe(false);
  });

  test('tracks from the start, ended at the finish', () => {
    const r = new Racing();
    r.tell(course());
    const pic = (n: number, state: 'placed' | 'racing' | 'finished') => ({
      race: 3,
      tick: n,
      eye: 1,
      racers: [
        racer({ number: 1, north: n, state }),
        racer({ number: 2, north: -n, state: 'racing' }),
      ],
    });
    r.take(pic(1, 'placed'));
    r.take(pic(2, 'racing'));
    r.take(pic(3, 'racing'));
    r.take(pic(4, 'finished'));
    r.take(pic(5, 'finished'));
    r.take({ ...pic(6, 'racing'), race: 9 });
    expect(r.tracks().get(1)).toEqual([0, 2, 0, 3, 0, 4]);
    expect(r.tracks().get(2)).toEqual([0, -1, 0, -2, 0, -3, 0, -4, 0, -5]);
    expect(r.mine()?.north).toBe(5);
  });

  test('the boat’s own call shown a while; its finish and the results', () => {
    let now = 1000;
    const r = new Racing();
    r.now = () => now;
    r.tell(course());
    r.called({
      race: 3,
      kind: 'overEarly',
      number: 2,
      other: 0,
      article: '',
      mark: 0,
      added: 10,
      place: 0,
    });
    expect(r.call.value).toBeNull();
    r.called({
      race: 3,
      kind: 'overEarly',
      number: 1,
      other: 0,
      article: '',
      mark: 0,
      added: 10,
      place: 0,
    });
    expect(r.call.value?.text).toBe('Over early · 10 seconds added');
    now += CALL_SHOWN - 1;
    r.expire();
    expect(r.call.value).not.toBeNull();
    now += 2;
    r.expire();
    expect(r.call.value).toBeNull();
    r.finished({ race: 3, number: 2, place: 1, elapsedMs: 600_000, added: 0 });
    expect(r.finishOpen.value).toBe(false);
    r.finished({ race: 3, number: 1, place: 2, elapsedMs: 604_000, added: 0 });
    expect(r.finishOpen.value).toBe(true);
    r.results({ race: 3, code: '', prizes: true, results: [] });
    expect(r.resultsOpen.value).toBe(true);
    expect(r.finishOpen.value).toBe(false);
    // The course taken up, the results stay to be read.
    r.tell(course({ gone: true }));
    expect(r.ended.value?.told.name).toBe('The Noon Gun');
  });

  test('a boat watched: the race whose pictures come', () => {
    const r = new Racing();
    r.tell(course({ entrants: [] }));
    r.take({ race: 3, tick: 1, eye: 2, racers: [racer({ state: 'racing' })] });
    expect(r.told.value?.race).toBe(3);
    expect(r.number()).toBe(0);
    expect(r.watched()).toBe(2);
    expect(r.spectator()).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// The chart's Log tab while a sailor is watched: the log of the sailor
// watched, a machine sailor's too, with My log at its head; the reader's
// own with the way back to theirs; and, watching no one, the reader's own
// as ever, another's with the way back to it.

import { describe, expect, test } from 'vitest';
import type { LogWho } from '../chart/chart';
import { backKey } from './log';

describe('the Log tab’s key at a log’s head', () => {
  const went: LogWho[] = [];
  const set = (w: LogWho) => went.push(w);

  test('watching a player: their log has My log, and the reader’s own goes back to theirs', () => {
    went.length = 0;
    const theirs = backKey({ kind: 'sailor', name: 'Ann Bonny' }, 'Ann Bonny', set);
    expect(theirs?.words).toBe('My log');
    theirs?.go();
    const own = backKey({ kind: 'own' }, 'Ann Bonny', set);
    expect(own?.words).toBe('‹ Ann Bonny’s log');
    own?.go();
    expect(went).toEqual([{ kind: 'own' }, { kind: 'sailor', name: 'Ann Bonny' }]);
  });

  test('watching a machine sailor: the same, by its name', () => {
    expect(backKey({ kind: 'sailor', name: 'Lady Pollux' }, 'Lady Pollux', set)?.words).toBe(
      'My log',
    );
    expect(backKey({ kind: 'own' }, 'Lady Pollux', set)?.words).toBe('‹ Lady Pollux’s log');
  });

  test('another’s log, opened from a name in it, goes back to the reader’s own', () => {
    expect(backKey({ kind: 'sailor', name: 'Bosun Bly' }, 'Ann Bonny', set)?.words).toBe(
      '‹ Your log',
    );
  });

  test('watching no one: the reader’s own has no key, another’s goes back to it', () => {
    expect(backKey({ kind: 'own' }, null, set)).toBeNull();
    expect(backKey({ kind: 'sailor', name: 'Ann Bonny' }, null, set)?.words).toBe('‹ Your log');
    expect(backKey({ kind: 'machine', id: 'm1', name: 'Gull' }, null, set)?.words).toBe(
      '‹ Your log',
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// The menu's line under Races, and the Races page's rows: whose a race
// is, when, and how many are in.

import { describe, expect, test } from 'vitest';
import { racesLine } from './menu';
import type { RacesBoard, Summary } from './raceapi';
import { rowLine } from './racespage';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 23, 20, 0);

function race(o: Partial<Summary> = {}): Summary {
  return {
    code: 'harbouraaa',
    name: 'the Teatime Trophy',
    kind: 'race',
    phase: 'open',
    harbour: true,
    who: 'everyone',
    boat: { id: 'b', name: 'Jolly boat' },
    startsAt: NOW + 40 * MINUTE,
    entered: 3,
    most: 12,
    mine: { owner: false, entered: false },
    enter: { ok: true },
    ...o,
  };
}

function board(mine: Summary[]): RacesBoard {
  return {
    harbour: [race()],
    greenhorn: [],
    mine,
    make: { can: { ok: true }, earliest: 0, latest: 0, who: [], boat: 'b', boats: [], courses: [] },
  };
}

describe('the menu’s line under Races', () => {
  test('the player’s next race and its time, else the next harbour race, else none', () => {
    const mine = race({
      code: 'mineaaaaaa',
      name: 'Monday Dash',
      harbour: false,
      startsAt: NOW + 10 * MINUTE,
      mine: { owner: true, entered: true },
    });
    expect(racesLine(board([mine]), NOW, 'en-US', 'UTC')).toBe('Monday Dash · 8:10 PM');
    expect(racesLine(board([]), NOW, 'en-US', 'UTC')).toBe(
      'Next harbour race: the Teatime Trophy · 8:40 PM · Jolly boats',
    );
    expect(racesLine(null, NOW)).toBe('');
  });
});

describe('the Races page’s rows', () => {
  test('each says whose it is, when, and how many are in', () => {
    const made = race({ harbour: false, entered: 1, mine: { owner: true, entered: true } });
    expect(rowLine(made, NOW)).toMatch(/^You made it · .+ · 1 in$/);
    const entered = race({ mine: { owner: false, entered: true } });
    expect(rowLine(entered, NOW)).toMatch(/^Entered · .+ · 3 in$/);
    const trial = race({ kind: 'trial', mine: { owner: true, entered: true } });
    expect(rowLine(trial, NOW)).toBe('You made it · Time trial · Jolly boat · 3 in');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// No race with others starts up the wind: Make a race offers a race with
// others only on courses not sailed alone only, keeping the server's
// order, the easy first; every course on your own. The upwind sign goes on a certificate's
// task only where every course it accepts is sailed partly up the wind,
// and the catalog's ladder never needs one. The menu's next harbour race
// is the first the player may enter, or the next with why not.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { upwindTask } from './certtasks';
import { nextHarbourLine, nextHarbourRace } from './menu';
import type { MakeChoices, Summary } from './raceapi';
import { coursesFor } from './races';

const make: MakeChoices = {
  can: { ok: true },
  earliest: 0,
  latest: 0,
  who: ['everyone'],
  boat: 'b',
  boats: [{ id: 'b', name: 'Jolly boat', most: 12, buoys: true }],
  courses: [
    { id: 'buoy:dash:short', kind: 'buoy', shape: 'dash', name: 'Dash', boats: { b: 6 } },
    { id: 'island:1', kind: 'island', name: 'Round Port Royal', boats: { b: 30 } },
    {
      id: 'buoy:triangle:short',
      kind: 'buoy',
      shape: 'triangle',
      name: 'Triangle, short',
      boats: { b: 10 },
      upwind: true,
      aloneOnly: true,
    },
  ],
};

describe('Make a race', () => {
  test('with others on the Dash or an island course; on your own on any', () => {
    expect(coursesFor(make, 'b', 'others').map((c) => c.id)).toEqual([
      'buoy:dash:short',
      'island:1',
    ]);
    expect(coursesFor(make, 'b', 'alone').map((c) => c.id)).toEqual([
      'buoy:dash:short',
      'island:1',
      'buoy:triangle:short',
    ]);
  });
});

describe('the upwind sign on a certificate’s task', () => {
  test('only where every course it accepts is sailed up the wind', () => {
    expect(upwindTask({ name: 'The Short Course', courses: ['short'] })).toBe(true);
    expect(upwindTask({ name: 'Both', courses: ['triangle', 'long'] })).toBe(true);
    expect(upwindTask({ name: 'The Reach', courses: ['reach'] })).toBe(false);
    expect(upwindTask({ name: 'An island', courses: ['island'] })).toBe(false);
    expect(upwindTask({ name: 'Sail 1 NM alone' })).toBe(false);
  });

  test('no certificate needs an upwind task: each is earned without one', () => {
    for (const c of catalog.certificates ?? []) {
      const tasks = c.tasks;
      const plain = tasks.filter((t) => !upwindTask(t as never)).length;
      const needs = c.needs;
      expect(plain, c.name).toBeGreaterThanOrEqual(needs);
    }
  });
});

function race(o: Partial<Summary>): Summary {
  return {
    code: 'harbouraaa',
    name: 'the Noon Gun',
    kind: 'race',
    phase: 'open',
    harbour: true,
    who: 'everyone',
    boat: { id: 'b', name: 'Jolly boat' },
    startsAt: Date.UTC(2026, 10, 14, 4, 0),
    entered: 0,
    most: 12,
    mine: { owner: false, entered: false },
    enter: { ok: true },
    ...o,
  };
}

describe('the menu’s next harbour race', () => {
  test('the first the player may enter; else the next, with why not', () => {
    const skiffs = race({ code: 'skiffsaaaa', enter: { ok: false, reason: 'certificate' } });
    const jolly = race({ code: 'jollyaaaaa' });
    expect(nextHarbourRace([skiffs, jolly])?.code).toBe('jollyaaaaa');
    expect(nextHarbourRace([skiffs])?.code).toBe('skiffsaaaa');
    expect(nextHarbourRace([race({ phase: 'racing' })])).toBeNull();
    expect(nextHarbourLine(jolly, jolly.startsAt - 3_600_000, 'en-US', 'UTC')).toBe(
      'Next harbour race: the Noon Gun · 4:00 AM · Jolly boats',
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// A race in the sea: a dash's finish line, on the line of its start up
// the wind, laid as two buoys with no boat of its own, its guns fired from
// the start's committee boat; an island course's finish apart, with a
// committee boat of its own.

import { describe, expect, test } from 'vitest';
import type { CourseLaid } from '../render/committee';
import { course, dash } from '../ui/racesamples';
import { dashFinish, FINISH_END, FINISH_LAID, raceSea } from './racesea';

function sea() {
  const laid = new Map<number, CourseLaid>();
  const fired: number[] = [];
  const s = raceSea({
    lay: (id, c) => laid.set(id, c),
    drop: (id) => laid.delete(id),
    signals: () => {},
    fire: (id) => fired.push(id),
    tick: () => 0,
  });
  return { s, laid, fired };
}

describe('a dash in the sea', () => {
  test('its finish is two buoys, its guns the start boat’s', () => {
    expect(dashFinish(dash())).toBe(true);
    expect(dashFinish(course())).toBe(false);
    const { s, laid, fired } = sea();
    s.told(dash());
    expect(laid.get(3)?.committee).not.toBeNull();
    expect(laid.get(3 + FINISH_LAID)).toMatchObject({
      committee: null,
      pin: { east: 0, north: 70 },
    });
    expect(laid.get(3 + FINISH_END)).toMatchObject({
      committee: null,
      pin: { east: 0, north: 100 },
    });
    s.signal({ race: 3, signal: 'finish', gun: true, number: 1, place: 1 });
    expect(fired).toEqual([3]);
    s.told(dash({ gone: true }));
    expect(laid.size).toBe(0);
  });

  test('an island course’s finish apart keeps a boat of its own', () => {
    const island = course({
      finish: [
        { east: 800, north: 900 },
        { east: 860, north: 900 },
      ],
    });
    expect(dashFinish(island)).toBe(false);
    const { s, laid, fired } = sea();
    s.told(island);
    expect(laid.get(3 + FINISH_LAID)?.committee).not.toBeNull();
    expect(laid.has(3 + FINISH_END)).toBe(false);
    s.signal({ race: 3, signal: 'finish', gun: true, number: 1, place: 1 });
    expect(fired).toEqual([3 + FINISH_LAID]);
  });
});

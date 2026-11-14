// SPDX-License-Identifier: AGPL-3.0-only

// A race as the server tells it, for the race line's and the race store's
// tests: a short course and its boats.

import type { RacerAtIn, RaceToldIn } from '../net/messages';

/** A course: the line from (−30, 0) to (30, 0), the windward mark 400 m north, the finish the line again. */
export function course(over: Partial<RaceToldIn> = {}): RaceToldIn {
  return {
    race: 3,
    code: 'abcdefghij',
    name: 'The Noon Gun',
    boat: 0,
    trial: false,
    run: 0,
    warning: 1000,
    start: 1000 + 120 * 30,
    pin: { east: -30, north: 0 },
    committee: { east: 30, north: 0 },
    finish: [
      { east: -30, north: 0 },
      { east: 30, north: 0 },
    ],
    marks: [{ east: 0, north: 400, number: 1, side: -1 }],
    way: [
      { east: 0, north: 0 },
      { east: 0, north: 400 },
      { east: 0, north: 0 },
    ],
    legs: [
      { mark: 0, east: 0, north: 0 },
      { mark: 1, east: 0, north: 400 },
      { mark: 0, east: 0, north: 0 },
    ],
    east: 0,
    north: 200,
    reach: 450,
    laps: 1,
    expected: 600,
    entrants: [
      { number: 1, name: 'Mira', boat: 'Gull', machine: false, me: true },
      { number: 2, name: '', boat: 'Petrel', machine: false, me: false },
      { number: 3, name: 'Iron Mary', boat: 'Iron Mary', machine: true, me: false },
    ],
    gone: false,
    ...over,
  };
}

export function racer(over: Partial<RacerAtIn>): RacerAtIn {
  return {
    number: 1,
    east: 0,
    north: -20,
    heading: 0,
    place: 0,
    gap: 0,
    added: 0,
    state: 'placed',
    leg: 0,
    toGo: 800,
    cheers: 0,
    ...over,
  };
}

// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's laid course, for looking at the race committee's things
// and testing them: a line square to the wind ahead of the boat, the
// committee boat at its starboard end (on the right, looking up the wind)
// and the pin buoy at its port end; mark 1 to windward, mark 2 out to port
// on the wing, mark 3 to leeward just above the line; the committee boat
// flying a class's pennant.

import type { RaceToldIn } from '../net/messages';
import type { CourseLaid } from '../render/committee';

/** How far ahead of the boat the line's middle lies, and its length, m. */
export const LINE_AHEAD = 70;
export const LINE_LENGTH = 70;

/**
 * The course laid about a boat at east and north on heading (radians
 * clockwise from north), the wind from from: its committee boat lying head
 * to wind, flying flags (the catalog's indices).
 */
export function courseNear(
  east: number,
  north: number,
  heading: number,
  from: number,
  flags: readonly number[],
): CourseLaid {
  // Up the wind, and across it to the right looking up it.
  const ue = Math.sin(from);
  const un = Math.cos(from);
  const ce = Math.cos(from);
  const cn = -Math.sin(from);
  const mx = east + Math.sin(heading) * LINE_AHEAD;
  const my = north + Math.cos(heading) * LINE_AHEAD;
  const at = (up: number, across: number): { east: number; north: number } => ({
    east: mx + ue * up + ce * across,
    north: my + un * up + cn * across,
  });
  const half = LINE_LENGTH / 2;
  return {
    committee: { ...at(0, half), heading: from },
    pin: at(0, -half),
    marks: [
      { ...at(320, 0), number: 1, side: -1 },
      { ...at(180, -170), number: 2, side: -1 },
      { ...at(55, 15), number: 3, side: -1 },
    ],
    flags: [...flags],
  };
}

/** The sandbox's race told: the course laid near, a triangle once round, the boats entered, the player's first. */
export function raceNear(
  course: CourseLaid,
  race: number,
  boat: number,
  tick: number,
  entrants: readonly { name: string; boat: string; machine?: boolean }[],
): RaceToldIn {
  const pin = course.pin ?? { east: 0, north: 0 };
  const committee = course.committee ?? pin;
  const mid = { east: (pin.east + committee.east) / 2, north: (pin.north + committee.north) / 2 };
  const marks = course.marks.map((m) => ({
    east: m.east,
    north: m.north,
    number: m.number,
    side: m.side,
  }));
  const way = [mid, ...marks.map((m) => ({ east: m.east, north: m.north })), mid];
  const all = [pin, committee, ...marks];
  const east = all.reduce((s, p) => s + p.east, 0) / all.length;
  const north = all.reduce((s, p) => s + p.north, 0) / all.length;
  const reach = Math.max(...all.map((p) => Math.hypot(p.east - east, p.north - north))) * 1.1;
  return {
    race,
    code: 'abcdefghij',
    name: 'The Noon Gun',
    boat,
    trial: false,
    run: 0,
    warning: tick,
    start: tick + 120 * 30,
    pin: { east: pin.east, north: pin.north },
    committee: { east: committee.east, north: committee.north },
    finish: [
      { east: pin.east, north: pin.north },
      { east: committee.east, north: committee.north },
    ],
    marks,
    way,
    legs: [
      { mark: 0, east: mid.east, north: mid.north },
      ...marks.map((m) => ({ mark: m.number, east: m.east, north: m.north })),
      { mark: 0, east: mid.east, north: mid.north },
    ],
    east,
    north,
    reach,
    laps: 1,
    expected: 600,
    entrants: entrants.map((e, i) => ({
      number: i + 1,
      name: e.name,
      boat: e.boat,
      machine: e.machine === true,
      me: i === 0,
    })),
    gone: false,
  };
}

// SPDX-License-Identifier: AGPL-3.0-only

// Races' replays as the server answers them, stood in for in the browser
// tests: a race of boats sailed round a triangle about a point (the names
// at their longest, a machine sailor, a boat not named to the reader, one
// retired, those aboard, every award), a time trial's runs, and a race
// whose world has gone, its results alone; and the route that answers
// them.

import type { Page } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { LONG_NAME } from './logs';

/** The codes of the replays stood in for. */
export const RACED = 'racedaaaaa';
export const TRIAL = 'trialaaaaa';
export const GONE = 'goneaaaaaa';

const SECOND = 30;
const EVERY = 2 * SECOND;
const first = data.boats[0] ?? { id: '', name: '' };

/** A triangle about (east, north): the line 150 m south, the windward mark 250 m north, the wing mark 200 m east. */
function triangle(east: number, north: number) {
  const r = Math.round;
  const start: [number, number] = [r(east), r(north - 150)];
  const up: [number, number] = [r(east), r(north + 250)];
  const wing: [number, number] = [r(east + 200), r(north + 50)];
  return {
    line: [start[0] - 40, start[1], start[0] + 40, start[1]],
    finish: [start[0] - 40, start[1], start[0] + 40, start[1]],
    marks: [
      [up[0], up[1], 1, -1],
      [wing[0], wing[1], 2, -1],
    ],
    way: [...start, ...up, ...wing, ...start],
    legs: [
      [0, ...start],
      [1, ...up],
      [2, ...wing],
      [0, ...start],
    ],
    east: r(east),
    north: r(north),
    reach: 450,
    laps: 1,
    expected: 600,
  };
}

type Course = ReturnType<typeof triangle>;

/**
 * A boat's track round course c from the warning at tick warning, the gun
 * pre s on (two minutes): on the line until the gun, then round at speed m/s,
 * tacking 20 m either side of the way, stopping after stop s if given.
 * Its time home, s, too.
 */
function sailed(
  c: Course,
  warning: number,
  speed: number,
  offset: number,
  stop = Infinity,
  pre = 120,
) {
  const pts: [number, number][] = [];
  const legs = c.legs.map((l) => [l[1] ?? 0, l[2] ?? 0] as [number, number]);
  const startAt = legs[0] ?? [0, 0];
  for (let t = 0; t < pre; t += 2) {
    pts.push([startAt[0] + offset, startAt[1] - 30 + (t * 30) / pre]);
  }
  let elapsed = 0;
  for (let k = 1; k < legs.length; k++) {
    const a = legs[k - 1] ?? [0, 0];
    const b = legs[k] ?? [0, 0];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(len / (speed * 2)));
    for (let i = 1; i <= steps; i++) {
      if (elapsed >= stop) {
        break;
      }
      const f = i / steps;
      const zig = Math.sin(i / 3) * 20 * (k === 1 ? 1 : 0.3);
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      pts.push([a[0] + (b[0] - a[0]) * f + nx * zig, a[1] + (b[1] - a[1]) * f + ny * zig]);
      elapsed += 2;
    }
  }
  const p: number[] = [];
  let x = 0;
  let y = 0;
  for (const [e, n] of pts) {
    const re = Math.round(e);
    const rn = Math.round(n);
    p.push(re - x, rn - y);
    x = re;
    y = rn;
  }
  return { track: { first: warning, every: EVERY, p }, elapsed };
}

/** A race of n boats (at most twelve) round a triangle about (east, north), its gun at tick start. */
export function raceReplay(east: number, north: number, n = 6, start = 100_000) {
  const c = triangle(east, north);
  const warning = start - 120 * SECOND;
  const boats = Array.from({ length: n }, (_, i) => {
    const retired = i === n - 1 && n > 3;
    const s = sailed(c, warning, 5.2 - i * 0.25, (i - n / 2) * 6, retired ? 200 : Infinity);
    const number = i + 1;
    return {
      number,
      name: i % 4 === 1 ? null : i === 0 ? 'Mira' : i % 4 === 2 ? `Iron Mary ${number}` : LONG_NAME,
      boat: i % 4 === 1 ? 'Petrel Of The Morning' : null,
      machine: i % 4 === 2,
      ...(i === 1 ? { me: true } : {}),
      place: retired ? 0 : number,
      how: retired ? 'ret' : 'finished',
      elapsed: retired ? -1 : s.elapsed,
      added: i === 2 ? 10 : 0,
      marks: retired ? 1 : 2,
      toGo: -1,
      awards:
        i === 0 ? ['best-start'] : i === 2 ? ['comeback', 'crowd'] : i === n - 2 ? ['spoon'] : [],
      ...(i === 0
        ? {
            crew: [
              { name: 'Anne Bonny', machine: false },
              { name: null, machine: false },
            ],
          }
        : {}),
      track: s.track,
    };
  });
  const ended =
    warning + Math.max(...boats.map((b) => (b.track.p.length / 2) * EVERY)) + 60 * SECOND;
  return {
    code: RACED,
    link: `https://keel.example/?r=${RACED}`,
    name: 'The Graveyard Watch Gallop of the Far Reefs',
    kind: 'race',
    boat: { id: first.id, name: first.name },
    course: 'Short triangle off Port Royal',
    world: 14,
    harbour: false,
    newcomers: false,
    at: Date.now() - 3_600_000,
    kept: true,
    second: SECOND,
    runs: [{ run: 0, warning, start, ended, course: c, prizes: n >= 3, boats }],
  };
}

/** A time trial's runs round the triangle, each from its own start; with drawn, only those runs' tracks. */
export function trialReplay(east: number, north: number, drawn: number[] | null = null) {
  const c = triangle(east, north);
  const runs = [1, 2, 3, 4].map((run, i) => {
    const start = 50_000 + run * 40_000;
    const s = sailed(c, start - 30 * SECOND, 5 - i * 0.4, 0, Infinity, 30);
    const shown = drawn === null ? run !== 4 : drawn.includes(run);
    return {
      run,
      start,
      course: c,
      prizes: false,
      boats: [
        {
          number: 1,
          name: run === 2 ? 'Iron Mary' : 'Mira',
          boat: null,
          machine: run === 2,
          place: 1,
          how: 'finished',
          elapsed: s.elapsed,
          added: 0,
          marks: 2,
          toGo: -1,
          medal: ['harbourmaster', 'gold', 'silver', 'bronze'][i] ?? '',
          awards: [],
          ...(shown ? { track: s.track } : {}),
        },
      ],
    };
  });
  return {
    ...raceReplay(east, north),
    code: TRIAL,
    name: 'the Gannet Holm Challenge',
    kind: 'trial',
    runs,
  };
}

/** A race whose world has gone: its results alone. */
export function goneReplay() {
  const r = raceReplay(0, 0, 8);
  return {
    ...r,
    code: GONE,
    world: 13,
    kept: false,
    runs: r.runs.map(({ course: _c, warning: _w, start: _s, ended: _e, ...run }) => ({
      ...run,
      boats: run.boats.map(({ track: _t, ...b }) => b),
    })),
  };
}

/** Stands in for the replays' route, about (east, north): RACED with n boats, TRIAL, GONE; a race not over for any other code. */
export async function standInReplays(
  page: Page,
  east: number,
  north: number,
  n = 6,
): Promise<string[]> {
  const asked: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/race/') && url.pathname.endsWith('/replay'),
    (r) => {
      const url = new URL(r.request().url());
      asked.push(`${url.pathname}${url.search}`);
      const code = url.pathname.split('/')[3] ?? '';
      const runs = url.searchParams.get('runs');
      const drawn = runs === null ? null : runs.split(',').map(Number);
      switch (code) {
        case RACED:
          return r.fulfill({ json: raceReplay(east, north, n) });
        case TRIAL:
          return r.fulfill({ json: trialReplay(east, north, drawn) });
        case GONE:
          return r.fulfill({ json: goneReplay() });
        default:
          return r.fulfill({ status: 409, json: { error: 'not-finished' } });
      }
    },
  );
  return asked;
}

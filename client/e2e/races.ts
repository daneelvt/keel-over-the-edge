// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore's routes stood in for, for the sandbox's screen (?races):
// the board, with the next harbour races (the first ten minutes off, so
// its notice comes at once), the Greenhorn Cup and what a race may be made
// with; a suggested name; a race made, or refused as one too many today;
// and three cards: the race made (its owner entered), another's on an
// island course with a machine sailor, a newcomer and entrants not named
// to the reader, and one the reader may not enter today.

import type { Page } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };

const MINUTE = 60_000;

/** The catalog's boats, by their place: the race's boat the first, its fleet's after. */
const boats = data.boats.map((b) => ({ id: b.id, name: b.name, most: b.racers }));
const first = boats[0] ?? { id: '', name: '', most: 12 };

/** The codes of the cards stood in for. */
export const MADE = 'madeaaaaaa';
export const OTHERS = 'othersaaaa';
export const REFUSED = 'refusedaaa';

/** A harbour race on the board. */
function harbour(code: string, name: string, at: number, o: object = {}) {
  return {
    code,
    name,
    kind: 'race',
    phase: 'open',
    harbour: true,
    who: 'everyone',
    boat: { id: first.id, name: first.name },
    startsAt: at,
    entered: 5,
    most: first.most,
    mine: { owner: false, entered: false },
    enter: { ok: true },
    ...o,
  };
}

/** The island course's way: round an island, m. */
const WAY = [-300, -900, 900, -1400, 2100, -600, 2300, 400, 1300, 1100, 200, 600, -300, -900];

/** GET /api/races, at now. */
export function raceBoard(now: number) {
  const offered = Object.fromEntries(boats.map((b) => [b.id, 10]));
  return {
    harbour: [
      harbour('harbourone', 'the Teatime Trophy', now + 10 * MINUTE - 10_000),
      harbour('harbourtwo', 'the Greenhorn Cup', now + 190 * MINUTE, {
        who: 'newcomers',
        enter: { ok: false, reason: 'newcomers' },
      }),
      harbour('harbourthr', 'the Lantern Race, a long name for a race', now + 370 * MINUTE),
    ],
    greenhorn: [now + 190 * MINUTE, now + 26 * 60 * MINUTE, now + 50 * 60 * MINUTE],
    mine: [
      { ...harbour(OTHERS, 'the Gannet Holm Gallop', now + 40 * MINUTE), harbour: false },
      { ...harbour(REFUSED, 'Sunday Sprint', now + 90 * MINUTE), harbour: false },
    ],
    make: {
      can: { ok: true },
      earliest: now + 5 * MINUTE,
      latest: now + 4 * 24 * 60 * MINUTE,
      who: ['everyone', 'humans', 'machines', 'newcomers'],
      boat: first.id,
      boats: boats.map((b) => ({ ...b, buoys: true })),
      courses: [
        ...['triangle', 'windward-leeward'].flatMap((shape) =>
          [false, true].map((long) => ({
            id: `buoy:${shape}:${long ? 'long' : 'short'}`,
            kind: 'buoy',
            shape,
            long,
            name: `${long ? 'Long' : 'Short'} ${shape === 'triangle' ? 'triangle' : 'windward–leeward'}`,
            boats: offered,
          })),
        ),
        {
          id: 'island:3',
          kind: 'island',
          number: 3,
          name: 'Round Gannet Holm and the Long Name Rocks',
          length: 4400,
          way: WAY,
          boats: offered,
        },
      ],
    },
  };
}

/** A card, at now. */
export function raceCard(now: number, o: object = {}) {
  return {
    code: MADE,
    link: `https://keel.example/?r=${MADE}`,
    name: 'Saturday Triangle',
    kind: 'race',
    phase: 'open',
    harbour: false,
    who: 'everyone',
    course: {
      id: 'buoy:triangle:short',
      kind: 'buoy',
      shape: 'triangle',
      long: false,
      name: 'Short triangle off Port Royal',
    },
    boat: { id: first.id, name: first.name },
    startsAt: now + 10 * MINUTE,
    minutes: 10,
    owner: { name: 'Mira', machine: false },
    most: first.most,
    entrants: [
      { number: 1, name: 'Mira', boat: 'Kittiwake', machine: false, newcomer: false, me: true },
      { number: 2, name: 'Grey Gull', boat: 'Grey Gull', machine: true, newcomer: false },
      { number: 3, name: 'Pip', boat: 'Puffin', machine: false, newcomer: true },
      { number: 4, name: null, boat: 'Gull', machine: false, newcomer: false },
      { number: 5, name: null, boat: null, machine: false, newcomer: true },
    ],
    mine: { owner: true, entered: true, withCrew: false, number: 1, moved: false },
    enter: { ok: false, reason: 'entered' },
    ...o,
  };
}

/** How a race made is answered: made, or refused as one too many today. */
export interface RaceStandIns {
  make: 'ok' | 'made';
}

/** Stands in for races ashore's routes on page; the state says how a race made is answered. */
export async function standInRaces(page: Page, now: number): Promise<RaceStandIns> {
  const state: RaceStandIns = { make: 'ok' };
  const reader = { owner: false, entered: false, withCrew: false, number: 0, moved: false };
  const cards: Record<string, object> = {
    [MADE]: raceCard(now),
    [OTHERS]: raceCard(now, {
      code: OTHERS,
      name: 'the Gannet Holm Gallop',
      startsAt: now + 40 * MINUTE,
      minutes: 34,
      course: { id: 'island:3', kind: 'island', name: 'Round Gannet Holm', length: 4400, way: WAY },
      owner: { name: 'Grey Gull', machine: true },
      mine: reader,
      enter: { ok: true },
      entrants: raceCard(now)
        .entrants.slice(1)
        .map((e) => ({ ...e, me: false })),
    }),
    [REFUSED]: raceCard(now, {
      code: REFUSED,
      name: 'Sunday Sprint',
      startsAt: now + 90 * MINUTE,
      mine: reader,
      enter: { ok: false, reason: 'daily', until: now + 160 * MINUTE },
    }),
  };
  await page.route(
    (url) => url.pathname === '/api/races',
    (r) => r.fulfill({ json: raceBoard(now) }),
  );
  await page.route(
    (url) => url.pathname === '/api/race' || url.pathname.startsWith('/api/race/'),
    (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path === '/api/race/name') {
        return r.fulfill({ json: { name: 'Saturday Triangle' } });
      }
      if (path === '/api/race') {
        return state.make === 'ok'
          ? r.fulfill({ status: 201, json: cards[MADE] })
          : r.fulfill({ status: 409, json: { error: 'made', until: now + 190 * MINUTE } });
      }
      const code = path.split('/')[3] ?? '';
      const card = cards[code];
      return card === undefined
        ? r.fulfill({ status: 404, json: { error: 'not-found' } })
        : r.fulfill({ json: card });
    },
  );
  return state;
}

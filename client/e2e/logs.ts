// SPDX-License-Identifier: AGPL-3.0-only

// Sailors' logs as the server answers them, stood in for in the browser
// tests: a long one at its fullest (names at their longest, every kind of
// day, a week of days and five worlds), an empty one, a machine sailor's
// and another sailor's, and the routes that answer them.

import type { Page } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { RIBBONS_PAGE } from '../src/ui/logapi';

const NM = 1852;
const DAY = 86_400_000;

/** The longest name a sailor can have: twenty letters. */
export const LONG_NAME = 'Bartholomew Roberts!';

/** The looks the logs are drawn in: the catalog's first person's, and its machine's. */
const colour = data.sailorOptions.colours[0]?.id ?? '';
const personLook = {
  look: data.sailors[0]?.id ?? '',
  version: data.sailors[0]?.versions[0]?.id ?? '',
  colour,
};
const machineLook = {
  look: 'machine',
  version: data.machine.versions[0]?.id ?? '',
  finish: data.machine.finishes[0]?.id ?? '',
  colour,
};

/** The collection, every group the catalog's, every other kind found, some many times. */
function collection(found: boolean) {
  const groups: [string, string[]][] = [
    ['islands', data.world.biomes.map((b) => b.id)],
    ['sizes', data.world.sizes.map((s) => s.class)],
    ['features', data.world.features.kinds.map((k) => k.id)],
    ['places', data.world.places.kinds.map((k) => k.id)],
    ['life', data.life.kinds.map((k) => k.id)],
    ['weather', ['gale-ridden-out', 'storm-ridden-out', 'landfall-in-fog', 'night-at-sea']],
    ['edge', [500, 200, 100, 50, 20, 10].map((m) => `within-${m}m`)],
    ['boats', data.boats.map((b) => b.id)],
  ];
  const now = Date.now();
  return groups.map(([id, ids]) => {
    const kinds = ids.map((k, i) => {
      const count = found && i % 2 === 0 ? (i % 3) * 11 + 1 : 0;
      return count === 0
        ? { id: k, count: 0 }
        : {
            id: k,
            count,
            ...(i % 4 === 0 ? { thisWorld: true } : {}),
            first: { world: 12, at: now - 20 * DAY, place: 'Isle of the Drowned Bells' },
          };
    });
    return { id, found: kinds.filter((k) => k.count > 0).length, kinds };
  });
}

const record = {
  distanceM: 1212.4 * NM,
  voyages: 131,
  aboard: 12,
  crewed: 40,
  worlds: 6,
  falls: 37,
  closestM: 12,
  bumpsAtFault: 4,
  bumps: 12,
  gales: 3,
  storms: 1,
  fogs: 2,
  nights: 19,
  charted: 14,
  sighted: 8,
  met: 120,
  kinds: 34,
  of: 72,
};

/** A week of days as full as they get. */
function days(now: number) {
  const date = (t: number) => new Date(t).toISOString().slice(0, 10);
  const boat = data.boats[1]?.id ?? data.boats[0]?.id ?? '';
  const life = data.life.kinds[13]?.id ?? data.life.kinds[0]?.id ?? '';
  return Array.from({ length: 7 }, (_, i) => {
    const t = now - i * DAY;
    return {
      date: date(t),
      runM: (18.4 + i * 3.3) * NM,
      voyages: [
        {
          boat,
          boatName: 'Isle of the Drowned Bells',
          began: t - 3 * 3_600_000,
          ended: t - 3_600_000,
          how: i % 2 === 0 ? 'over' : 'returned',
          place: 'Isle of the Drowned Bells',
          runM: 12.2 * NM,
          closestM: 12,
          bumpsAtFault: 1,
          bumpsNotAtFault: 2,
          met: ['gale', 'gale-ridden-out', 'landfall-in-fog', 'night-at-sea'],
          galePlace: 'Isle of the Drowned Bells',
          fogPlace: 'Port Royal',
          crew: [
            { name: LONG_NAME, logged: true },
            { name: 'Bolt', machine: true },
            { hidden: true },
          ],
          counted: 2,
        },
        {
          boat,
          boatName: 'Iron Mary',
          began: t - 6 * 3_600_000,
          ended: t - 4 * 3_600_000,
          how: 'aboard',
          runM: 8.4 * NM,
          aboard: true,
          skipper: { name: LONG_NAME, logged: true },
          crew: [{ name: 'Mira' }],
        },
      ],
      entries: [
        { at: t - 2 * 3_600_000, kind: 'charted', title: 'Isle of the Drowned Bells', worth: 12 },
        {
          at: t - 2 * 3_600_000,
          kind: 'sighted',
          title: 'Keyhole Rock',
          other: { name: LONG_NAME },
        },
        { at: t - 2 * 3_600_000, kind: 'met', find: life, place: 'Gull Reach', times: 3 },
        ...[1, 2, 3, 4].map((k) => ({
          at: t - k * 60_000,
          kind: 'bump',
          other: { name: LONG_NAME, logged: true },
          otherBoat: 'Isle of the Drowned Bells',
          article: '10',
          fault: k % 2 === 0 ? 'mine' : 'theirs',
          place: 'Keyhole Rock',
        })),
      ],
    };
  });
}

/** Five worlds, the newest sailed now. */
function worlds(now: number) {
  return [14, 13, 12, 11, 10].map((n, i) => ({
    number: n,
    first: now - (i + 1) * 7 * DAY,
    last: now - i * 7 * DAY,
    ...(i === 0 ? { current: true } : {}),
  }));
}

/** How many races the long log has sailed: more than a page of ribbons. */
const SAILED = 45;

/** A log's races counted, as the log itself carries them. */
function raceCounts() {
  return {
    sailed: SAILED,
    top3: 3,
    wins: 1,
    awards: { 'best-start': 1, comeback: 1, 'photo-finish': 1, crowd: 1, spoon: 1 },
    medals: { harbourmaster: 1 },
    ran: 1234,
  };
}

/**
 * A page of a log's races at their longest, from the newest after the
 * first from: every award, a crew's long-named skipper, a trial's medal,
 * a retirement, a newcomers' race, the spoon of this world.
 */
export function ribbonsPage(now: number, from = 0) {
  const boat = (i: number) => data.boats[i % data.boats.length]?.id ?? '';
  const n = Math.max(0, Math.min(RIBBONS_PAGE, SAILED - from));
  const races = Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return {
      world: i < 6 ? 14 : i < 30 ? 13 : 12,
      at: now - i * DAY,
      code: `race${String(i).padStart(6, 'a')}`.slice(0, 10),
      name: i % 3 !== 1 ? 'The Graveyard Watch Gallop of the Far Reefs' : 'The Noon Gun',
      kind: i === 4 ? 'trial' : 'race',
      course: i % 2 === 0 ? 'Round Gannet Holm and the Three Sisters' : 'Short triangle',
      boat: boat(i),
      boatName: 'The Unsinkable Molly B',
      fleet: 12,
      harbour: i % 2 === 1,
      newcomers: i === SAILED - 1,
      role: i % 3 === 1 ? 'crew' : 'skipper',
      place: i === 5 ? 0 : (i % 12) + 1,
      how: i === 5 ? 'ret' : i === 3 ? 'placed' : 'finished',
      medal: i === 4 ? 'harbourmaster' : '',
      awards:
        i === 0
          ? ['spoon']
          : i % 6 === 2
            ? ['best-start', 'photo-finish', 'crowd']
            : i === 7
              ? ['comeback']
              : [],
      ...(i % 3 === 1 ? { skipper: { name: LONG_NAME, logged: true } } : {}),
      ...(i === 0 ? { hung: true } : {}),
    };
  });
  return { counts: raceCounts(), races, ...(from + n < SAILED ? { more: true } : {}) };
}

/** The player's own log at its fullest. */
export function longLog() {
  const now = Date.now();
  const w = worlds(now);
  return {
    name: LONG_NAME,
    machine: false,
    look: personLook,
    since: now - 60 * DAY,
    own: true,
    shown: 'sailors',
    loggedFrom: now - 3 * DAY,
    abstract: [
      { kind: 'distance', value: record.distanceM },
      { kind: 'voyages', value: record.voyages },
      { kind: 'charted', value: record.charted },
      { kind: 'closest', value: 12 },
    ],
    record,
    worlds: w,
    world: { ...w[0], days: days(now) },
    collection: collection(true),
    zone: 'America/New_York',
    worldNow: 14,
    ribbons: { counts: raceCounts() },
  };
}

/** A log with nothing in it yet. */
export function emptyLog() {
  return {
    name: 'Ann Bonny',
    machine: false,
    look: personLook,
    since: Date.now(),
    own: true,
    shown: 'me',
    abstract: [
      { kind: 'distance', value: 0 },
      { kind: 'voyages', value: 0 },
    ],
    record: Object.fromEntries(
      Object.entries(record).map(([k]) => [k, k === 'closestM' ? null : k === 'of' ? 72 : 0]),
    ),
    worlds: [],
    world: null,
    collection: collection(false),
    zone: 'America/New_York',
  };
}

/** A machine sailor's log, read by its player. */
export function machineLog() {
  return {
    ...longLog(),
    name: 'Clockwork Kestrel',
    machine: true,
    look: machineLook,
    shown: undefined,
  };
}

/** Another sailor's log. */
export function otherLog() {
  return { ...longLog(), own: false, shown: undefined };
}

/**
 * Stands in for the log's routes: the player's own (empty when asked),
 * a sailor's by name (unknown for "Nobody"), a machine sailor's, and the
 * card that says whether a sailor can be watched.
 */
export async function standInLogs(page: Page, own: () => object = longLog): Promise<void> {
  // A log's races, a page at a time, on any log's route.
  const part = (url: URL) =>
    url.searchParams.get('part') === 'ribbons'
      ? ribbonsPage(Date.now(), Number(url.searchParams.get('from') ?? '0'))
      : null;
  await page.route(
    (url) => url.pathname === '/api/me/log',
    (r) => {
      const url = new URL(r.request().url());
      return r.request().method() === 'PUT'
        ? r.fulfill({ json: JSON.parse(r.request().postData() ?? '{}') })
        : r.fulfill({ json: part(url) ?? own() });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/log',
    (r) => {
      const url = new URL(r.request().url());
      return url.searchParams.get('name') === 'Nobody'
        ? r.fulfill({ status: 404, json: { error: 'not-found' } })
        : r.fulfill({ json: part(url) ?? otherLog() });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/machines/log',
    (r) => r.fulfill({ json: part(new URL(r.request().url())) ?? machineLog() }),
  );
  await page.route(
    (url) => url.pathname === '/api/watch/sailor',
    (r) => r.fulfill({ json: { name: LONG_NAME } }),
  );
}

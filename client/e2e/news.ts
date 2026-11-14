// SPDX-License-Identifier: AGPL-3.0-only

// The day's news as the server answers it, stood in for in the browser
// tests: a full day (its figures, six stories at their longest, the
// reader's own box, the world's notice and four editions), a new world's
// first edition (its arrival and the last world in review), a quiet day
// and an earlier edition; a sailor's stories; and the route that answers
// them.

import type { Page } from '@playwright/test';
import { LONG_NAME } from './logs';

const DAY = 86_400_000;

/** The place the first story tells of: a test charts it, so a tap opens its box. */
export const KEYHOLE = { subject: 'place', number: 9001, name: 'Keyhole Rock' } as const;

/** The world's editions, the newest first: today's not yet set. */
const DAYS = [
  { day: '2026-11-12', number: 4, set: false },
  { day: '2026-11-11', number: 3, set: true },
  { day: '2026-11-10', number: 2, set: true },
  { day: '2026-11-09', number: 1, set: true },
];

const edition = (day: (typeof DAYS)[number], rest: object) => ({
  world: 14,
  day: day.day,
  number: day.number,
  zone: 'America/New_York',
  set: day.set,
  figures: { boats: 212, machines: 31, run: 1804 * 1852, charted: 14, crews: 5, over: 37 },
  figuresText:
    'Sailed this day, 212 boats (31 machine ⚙) · 1,804 NM · 14 places charted · 5 crews in company · 37 over the falls, all hands home.',
  lead: [],
  stories: [],
  shipmates: [],
  notices: [],
  days: DAYS,
  ...rest,
});

/** The six stories of a full day, each at its longest: about two lines of words on a phone, its names twenty letters. */
function sixStories(at: number) {
  return [
    {
      id: '0193a1f0c0de4b7e9a01000000000001',
      kind: 'great',
      at,
      head: 'KEYHOLE ROCK',
      text: 'A sea arch on an island of the rim, the largest yet found: first sighted by {0}.',
      names: [{ kind: 'human', name: LONG_NAME, logged: true }],
      subject: KEYHOLE.subject,
      number: KEYHOLE.number,
      x: 3200,
      y: -14_800,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000002',
      kind: 'record',
      at: at - 3_600_000,
      head: 'OFF THE SKERRIES',
      text: '{0} passed 8 m from the lip, nearer than any boat this world.',
      names: [{ kind: 'human', name: 'Mira', boat: 'Queen Anne’s Revenge', logged: true }],
      number: 0,
      x: -9000,
      y: 15_400,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000003',
      kind: 'life',
      at: at - 7_200_000,
      head: 'OFF GULL REACH',
      text: '{0} met a pod of pilot whales, with {1}, {2} and three more aboard.',
      names: [
        { kind: 'machine', name: 'Clockwork Kestrel', logged: true },
        { kind: 'human', name: 'Tom Tew', logged: false },
        { kind: 'boat', type: 'Jolly boat' },
      ],
      number: 0,
      x: 6100,
      y: 2400,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000004',
      kind: 'crew',
      at: at - 10_800_000,
      head: 'IN COMPANY',
      text: 'A crew of six under {0}: {1}, {2} and three more, together all the forenoon.',
      names: [
        { kind: 'human', name: 'Anne Bonny', logged: true },
        { kind: 'former' },
        { kind: 'sailor' },
      ],
      number: 0,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000005',
      kind: 'first',
      at: at - 14_400_000,
      head: 'PELICAN COVE',
      text: 'A cove on Long Reach Island. A new hand’s first find: {0} raised it.',
      names: [{ kind: 'boat', name: 'Gull' }],
      subject: 'place',
      number: 9002,
      x: -4100,
      y: -6300,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000006',
      kind: 'run',
      at: at - 18_000_000,
      head: 'THE DAY’S RUN',
      text: 'The day’s longest run: 41.7 NM, sailed by {0} before coming home.',
      names: [{ kind: 'human', name: 'Calico Jack Rackham', logged: true }],
      number: 0,
      x: 800,
      y: -1200,
    },
  ];
}

/** The reader's own box: three about their shipmates. */
function shipmates(at: number) {
  return [
    {
      id: '0193a1f0c0de4b7e9a01000000000011',
      kind: 'milestone',
      at,
      head: 'FROM THE LOGS',
      text: '{0} passed 1,000 NM sailed: a milestone.',
      names: [{ kind: 'human', name: 'Mary Read', logged: true }],
      number: 0,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000012',
      kind: 'charting',
      at: at - 3_600_000,
      head: 'BROAD ISLAND',
      text: 'A wooded island of the middle waters, now on the chart: sighted by {0}.',
      names: [{ kind: 'human', name: 'Jack Sparrowhawk', logged: true }],
      subject: 'island',
      number: 1,
      x: 0,
      y: 0,
    },
    {
      id: '0193a1f0c0de4b7e9a01000000000013',
      kind: 'run',
      at: at - 7_200_000,
      head: 'THE DAY’S RUN',
      text: '{0} ran 12.4 NM before coming home.',
      names: [{ kind: 'boat', name: 'Saltpeter' }],
      number: 0,
      x: 1200,
      y: 900,
    },
  ];
}

/** A full day: the figures, six stories, the reader's own box, the world's notice. */
export function fullDay() {
  const now = Date.now();
  return edition(DAYS[0] as (typeof DAYS)[number], {
    stories: sixStories(now - 600_000),
    shipmates: shipmates(now - 900_000),
    notices: [
      {
        id: '0193a1f0c0de4b7e9a010000000000ff',
        head: 'PORT ROYAL',
        endsAt: now + 3 * DAY,
        x: 0,
        y: 0,
      },
    ],
  });
}

/** A new world's first edition: its arrival and the last world in review above two stories. */
export function firstEdition() {
  const now = Date.now();
  const first = { day: '2026-11-08', number: 1, set: false };
  return {
    ...edition(first, {
      figures: { boats: 41, machines: 0, run: 88 * 1852, charted: 9, crews: 0, over: 2 },
      figuresText:
        'Sailed this day, 41 boats · 88 NM · 9 places charted · 2 over the falls, all hands home.',
      lead: [
        {
          id: '0193a1f0c0de4b7e9a01000000000021',
          kind: 'arrival',
          at: now - DAY,
          head: 'A NEW WORLD',
          text: 'The falls have turned the world over: 64 islands wait to be found.',
          names: [],
          number: 0,
        },
        {
          id: '0193a1f0c0de4b7e9a01000000000022',
          kind: 'review',
          at: now - DAY,
          head: 'THE LAST WORLD',
          text: 'World 13 in review: 1,212 sailors, 9,804 NM sailed, 61 of 64 islands charted. Its greatest finds: Keyhole Rock, by {0}; the Drowned Bells, by {1}; Skull Arch, by {2}. Nearest the falls: {3}, 2.4 m from the lip.',
          names: [
            { kind: 'human', name: LONG_NAME, logged: true },
            { kind: 'machine', name: 'Clockwork Kestrel', logged: true },
            { kind: 'boat', name: 'Queen Anne’s Revenge' },
            { kind: 'human', name: 'Mira', logged: false },
          ],
          number: 0,
        },
      ],
      stories: sixStories(now - 600_000).slice(0, 2),
    }),
    days: [first],
  };
}

/** A quiet day: no boat out, nothing charted. */
export function quietDay() {
  return edition(DAYS[0] as (typeof DAYS)[number], {
    figures: { boats: 0, machines: 0, run: 0, charted: 0, crews: 0, over: 0 },
    figuresText: 'A quiet day on the water.',
  });
}

/** An earlier edition, set. */
export function earlierEdition() {
  const now = Date.now();
  return edition(DAYS[1] as (typeof DAYS)[number], {
    figuresText:
      'Sailed this day, 188 boats (24 machine ⚙) · 1,512 NM · 11 places charted · 4 crews in company · 29 over the falls, all hands home.',
    stories: sixStories(now - DAY)
      .slice(1, 5)
      .map((s) => ({ ...s, id: s.id.replace(/0000(\d\d)$/, '1000$1') })),
  });
}

/** The stories this world naming a sailor, the newest first. */
export function storiesAbout(name: string) {
  return name === 'Nobody'
    ? []
    : sixStories(Date.now()).map((s) => ({ ...s, day: (DAYS[0] as (typeof DAYS)[number]).day }));
}

/**
 * Stands in for GET /api/news: today's edition (by default a full day),
 * the earlier editions by their day (an earlier one for the day before,
 * none for the others), and a sailor's stories by name.
 */
export async function standInNews(page: Page, today: () => object = fullDay): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/news',
    (r) => {
      const q = new URL(r.request().url()).searchParams;
      const name = q.get('name');
      if (name !== null) {
        return r.fulfill({ json: { stories: storiesAbout(name) } });
      }
      const day = q.get('day');
      if (day === null || day === (DAYS[0] as (typeof DAYS)[number]).day) {
        return r.fulfill({ json: today() });
      }
      if (day === (DAYS[1] as (typeof DAYS)[number]).day) {
        return r.fulfill({ json: earlierEdition() });
      }
      return r.fulfill({ status: 404, json: { error: 'not-found' } });
    },
  );
}

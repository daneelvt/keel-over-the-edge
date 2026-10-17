// SPDX-License-Identifier: AGPL-3.0-only

// Going over the lip online, against keel (tools/e2e): a boat put just
// inside the lip by /debug/place is carried over it by the drain, on the
// page as on the server; a sailor near it sees it fall and vanish; it is
// back at the start five seconds later; and the server counts the fall and
// writes its events. One back end is enough: the drawing is not under test.

import { expect, type Page, test } from '@playwright/test';
import { guest, sail } from './helpers';

const internal = 'http://127.0.0.1:19090';

/** The lip, metres from the centre. */
const LIP = 8334;

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

/** A metric's value from keel's internal listener, or 0 if it has none yet. */
async function metric(
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<number> {
  const text = await (await request.get(`${internal}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

async function place(
  request: import('@playwright/test').APIRequestContext,
  page: Page,
  east: number,
  north: number,
  heading: number,
): Promise<void> {
  const boat = await page.evaluate(() => globalThis.keel.net().boat);
  const res = await request.post(
    `${internal}/debug/place?east=${east}&north=${north}&heading=${heading}&boat=${boat}`,
  );
  expect(res.status(), await res.text()).toBe(200);
}

/** What a page has seen since watch() began, recorded on the page between its frames. */
interface Seen {
  over: number;
  notices: string[];
  restarts: number;
  falling: boolean;
  fallen: boolean;
}

/**
 * Records, every 50 ms on the page itself, its boat's fall, the notices it
 * shows, its restarts and any other boat falling: a slow page polled from
 * here could miss the five seconds of a fall.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const k = globalThis.keel;
    const seen = { over: 0, notices: [] as string[], restarts: 0, falling: false, fallen: false };
    (globalThis as unknown as { seen: typeof seen }).seen = seen;
    setInterval(() => {
      const edge = k.edge();
      seen.over = Math.max(seen.over, edge.over);
      if (edge.notice !== '' && seen.notices.at(-1) !== edge.notice) {
        seen.notices.push(edge.notice);
      }
      seen.restarts = edge.restarts;
      const falls = k.fleet().boats.filter((b) => b.fall >= 0);
      seen.falling ||= falls.length > 0;
      seen.fallen ||= seen.falling && !falls.some((b) => b.opacity > 0.5);
    }, 50);
  });
}

async function seen(page: Page): Promise<Seen> {
  return page.evaluate(() => (globalThis as unknown as { seen: Seen }).seen);
}

test('carried over the lip, seen falling, and back at the start', async ({ browser, request }) => {
  const falls = await metric(request, 'keel_falls_total');
  const events = await metric(request, 'keel_persist_events_total');
  // Small pages, so CI's software renderer draws two of them often enough.
  const small = { viewport: { width: 320, height: 200 } };
  const contexts = [await browser.newContext(small), await browser.newContext(small)];
  const [ann, bob] = await Promise.all(contexts.map((c) => c.newPage()));
  if (ann === undefined || bob === undefined) {
    throw new Error('no pages');
  }
  await guest(contexts[0] as import('@playwright/test').BrowserContext, 'Ann');
  await guest(contexts[1] as import('@playwright/test').BrowserContext, 'Bob');
  await sail(ann);
  await sail(bob);
  await watch(ann);
  await watch(bob);
  // Bob lies 100 m off, along the lip; Ann half a metre inside it.
  await place(request, bob, 100, LIP - 60, 270);
  await place(request, ann, 0, LIP - 0.5, 90);
  const annBoat = await ann.evaluate(() => globalThis.keel.net().boat);

  // Over within a few seconds, and five seconds later back at the start.
  await expect.poll(async () => (await seen(ann)).restarts, { timeout: 30_000 }).toBeGreaterThan(0);
  const annSaw = await seen(ann);
  expect(annSaw.over).toBeGreaterThan(0);
  expect(annSaw.notices).toEqual(['Over the falls', 'Back at Port Royal']);
  const back = await ann.evaluate(() => ({
    edge: globalThis.keel.edge(),
    boat: globalThis.keel.boat(),
  }));
  expect(back.edge.over).toBe(0);
  expect(Math.hypot(back.boat.state.x, back.boat.state.y)).toBeLessThan(2000);
  expect(await ann.evaluate(() => globalThis.keel.net().boat)).toBe(annBoat);
  // Bob saw a boat falling near him, and then no longer.
  await expect.poll(async () => (await seen(bob)).fallen, { timeout: 15_000 }).toBe(true);

  expect(await metric(request, 'keel_falls_total')).toBeGreaterThan(falls);
  // Ann's fall, and the approach Bob's voyage keeps, are lasting events:
  // the fall written at once.
  await expect
    .poll(() => metric(request, 'keel_persist_events_total'), { timeout: 10_000 })
    .toBeGreaterThan(events);
  // Bob sails back out of the band, clear of the lip.
  await place(request, bob, 0, 0, 90);
  await Promise.all(contexts.map((c) => c.close()));
});

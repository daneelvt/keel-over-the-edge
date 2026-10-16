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

test('carried over the lip, seen falling, and back at the start', async ({ browser, request }) => {
  const falls = await metric(request, 'keel_falls_total');
  const events = await metric(request, 'keel_persist_events_total');
  const contexts = [await browser.newContext(), await browser.newContext()];
  const [ann, bob] = await Promise.all(contexts.map((c) => c.newPage()));
  if (ann === undefined || bob === undefined) {
    throw new Error('no pages');
  }
  await guest(contexts[0] as import('@playwright/test').BrowserContext, 'Ann');
  await guest(contexts[1] as import('@playwright/test').BrowserContext, 'Bob');
  await sail(ann);
  await sail(bob);
  // Bob lies 100 m off, along the lip; Ann half a metre inside it.
  await place(request, bob, 100, LIP - 60, 270);
  await place(request, ann, 0, LIP - 0.5, 90);
  const annBoat = await ann.evaluate(() => globalThis.keel.net().boat);

  // Over within a few seconds: the page holds its boat where it went over.
  await ann.waitForFunction(() => globalThis.keel.edge().over > 0, null, { timeout: 15_000 });
  const over = await ann.evaluate(() => globalThis.keel.edge());
  expect(over.notice).toBe('Over the falls');
  // Bob sees a boat falling near him.
  await bob.waitForFunction(() => globalThis.keel.fleet().boats.some((b) => b.fall >= 0), null, {
    timeout: 10_000,
  });
  // Five seconds after going over, Ann is back at the start.
  await ann.waitForFunction(() => globalThis.keel.edge().restarts > 0, null, { timeout: 20_000 });
  const back = await ann.evaluate(() => ({
    edge: globalThis.keel.edge(),
    boat: globalThis.keel.boat(),
  }));
  expect(back.edge.over).toBe(0);
  expect(back.edge.notice).toBe('Back at Port Royal');
  expect(Math.hypot(back.boat.state.x, back.boat.state.y)).toBeLessThan(2000);
  expect(await ann.evaluate(() => globalThis.keel.net().boat)).toBe(annBoat);
  // And no longer falls near Bob.
  await bob.waitForFunction(
    () => !globalThis.keel.fleet().boats.some((b) => b.fall >= 0 && b.opacity > 0.5),
    null,
    { timeout: 10_000 },
  );

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

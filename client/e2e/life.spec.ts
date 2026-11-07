// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life shared, against keel (tools/e2e): a group of birds raised
// by the developer's command between two players sailing near each other
// reaches both pages, and a third watching one of them, as the same
// record; and each page finds every bird of it in the same place at the
// same tick, within half a metre. The pages draw nothing (?draw=off): the
// birds are found as the frame finds them.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import type { LifeSeen } from '../src/net/messages';
import { GAME, sail, sailor, setSail } from './helpers';

/** keel's internal listener, as tools/e2e serves it: its developer commands. */
const internal = 'http://127.0.0.1:19090';

/** The kind raised: one that works a patch of water, staying minutes; by its index. */
const kind = data.life.kinds.findIndex((k) => k.path === 'work');

/** Waits until the page holds the record of id, and gives it. */
async function record(page: Page, id: string): Promise<LifeSeen> {
  await page.waitForFunction((id) => globalThis.keel.life().records.some((r) => r.id === id), id, {
    timeout: 30_000,
  });
  const r = await page.evaluate(
    (id) => globalThis.keel.life().records.find((r) => r.id === id),
    id,
  );
  if (r === undefined) {
    throw new Error(`no record ${id}`);
  }
  return r;
}

test('two players and a spectator see the same birds in the same places', async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  try {
    // Ann sails, and lets others watch; Bob sails; Cat watches Ann.
    const ann = await browser.newContext();
    contexts.push(ann);
    const made = await sailor(ann, 'Ann');
    const a = await ann.newPage();
    await a.goto(GAME);
    await a.getByRole('checkbox', { name: 'Let others watch me sail' }).check({ timeout: 90_000 });
    await setSail(a);
    await a.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
      timeout: 60_000,
    });
    const bob = await browser.newContext();
    contexts.push(bob);
    await sailor(bob, 'Bob');
    const b = await bob.newPage();
    await sail(b);
    const cat = await browser.newContext();
    contexts.push(cat);
    await sailor(cat, 'Cat');
    const c = await cat.newPage();
    await c.goto(`${GAME}&watch=${encodeURIComponent(made.name)}`);
    await c.waitForFunction((n) => globalThis.keel?.watch().watching?.sailor === n, made.name, {
      timeout: 90_000,
    });

    // A group of terns between the two boats.
    const at = async (p: Page) => p.evaluate(() => globalThis.keel.boat().state);
    const [sa, sb] = [await at(a), await at(b)];
    const east = (sa.x + sb.x) / 2;
    const north = (sa.y + sb.y) / 2;
    expect(Math.hypot(sa.x - sb.x, sa.y - sb.y)).toBeLessThan(1500);
    const before = new Set(
      (await a.evaluate(() => globalThis.keel.life().records)).map((r) => r.id),
    );
    const res = await a.request.post(
      `${internal}/debug/life?kind=${kind}&east=${east}&north=${north}`,
    );
    expect(res.status(), await res.text()).toBe(200);
    await a.waitForFunction(
      (before) => globalThis.keel.life().records.some((r) => !before.includes(r.id)),
      [...before],
      { timeout: 30_000 },
    );
    const raised = (await a.evaluate(() => globalThis.keel.life().records)).find(
      (r) => !before.has(r.id),
    ) as LifeSeen;
    expect(raised.kind).toBe(kind);
    expect(Math.hypot(raised.east - east, raised.north - north)).toBeLessThan(0.02);

    // The same record on every page.
    for (const p of [b, c]) {
      expect(await record(p, raised.id)).toEqual(raised);
    }

    // The same birds at the same tick, a minute into its life.
    const tick = raised.start + 60 * 30;
    const birds = async (p: Page) =>
      (await p.evaluate((t) => globalThis.keel.lifeBirds(t), tick)).filter(
        (x) => x.id === raised.id,
      );
    const [ba, bb, bc] = [await birds(a), await birds(b), await birds(c)];
    expect(ba.length).toBeGreaterThan(0);
    for (const other of [bb, bc]) {
      let compared = 0;
      for (const x of ba) {
        const y = other.find((o) => o.k === x.k);
        if (y === undefined) {
          continue;
        }
        compared++;
        expect(Math.hypot(x.east - y.east, x.north - y.north, x.up - y.up)).toBeLessThan(0.5);
      }
      expect(compared).toBeGreaterThan(0);
    }
  } finally {
    for (const c of contexts) {
      await c.close();
    }
  }
});

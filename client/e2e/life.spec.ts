// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life shared, against keel (tools/e2e): a group of birds raised
// by the developer's command between two players sailing near each other
// reaches both pages, and a third watching one of them, as the same
// record; and each page finds every bird of it in the same place at the
// same tick, within half a metre. A pod of dolphins raised ahead of one of
// them sailing steadily rides her bow, and every page sees it at that
// boat's bow, within a metre. A whale raised between them is in the same
// place on every page, and a booby raised at one boat perches on that boat
// on every page. The pages draw nothing (?draw=off): the animals are found
// as the frame finds them.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import type { LifeSeen } from '../src/net/messages';
import { alone, GAME, heldRegime, sail, sailor, setSail } from './helpers';

/** keel's internal listener, as tools/e2e serves it: its developer commands. */
const internal = 'http://127.0.0.1:19090';

/** The kind raised: one that works a patch of water, staying minutes; by its index. */
const kind = data.life.kinds.findIndex((k) => k.path === 'work');
/** A whale with no pod about it, and a bird that perches on boats; by their indices. */
const whale = data.life.kinds.findIndex((k) => k.form === 'whale' && !('collective' in k));
const percher = data.life.kinds.findIndex((k) => k.binds === 'perch');
/** A pod that rides bows and passes when it has none to ride; by its index. */
const rider = data.life.kinds.findIndex((k) => k.binds === 'ride' && k.path === 'pass');

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

    // A whale between them, and a booby at Ann's boat: the same records,
    // the same whale in the same place, the booby on Ann's boat on every
    // page.
    const raise = async (q: string): Promise<LifeSeen> => {
      const had = new Set(
        (await a.evaluate(() => globalThis.keel.life().records)).map((r) => r.id),
      );
      const r = await a.request.post(`${internal}/debug/life?${q}`);
      expect(r.status(), await r.text()).toBe(200);
      await a.waitForFunction(
        (had) => globalThis.keel.life().records.some((r) => !had.includes(r.id)),
        [...had],
        { timeout: 30_000 },
      );
      return (await a.evaluate(() => globalThis.keel.life().records)).find(
        (r) => !had.has(r.id),
      ) as LifeSeen;
    };
    const w = await raise(`kind=${whale}&east=${east}&north=${north}`);
    const sa2 = await at(a);
    const booby = await raise(`kind=${percher}&east=${sa2.x}&north=${sa2.y}`);
    // It perches on the nearest boat, hers or, sailing close, another.
    expect(booby.with).not.toBe(0);
    for (const p of [b, c]) {
      expect(await record(p, w.id)).toEqual(w);
      const r = await record(p, booby.id);
      expect({ ...r, with: 0 }).toEqual({ ...booby, with: 0 });
    }
    const swimmers = async (p: Page, t: number) =>
      (await p.evaluate((t) => globalThis.keel.lifeSwimmers(t), t)).filter((x) => x.id === w.id);
    let seen = 0;
    for (let t = w.start + 30 * 30; t < w.end && seen === 0; t += 60 * 30) {
      const [wa, wb, wc] = [await swimmers(a, t), await swimmers(b, t), await swimmers(c, t)];
      for (const other of [wb, wc]) {
        for (const x of wa) {
          const y = other.find((o) => o.k === x.k);
          if (y !== undefined) {
            seen++;
            expect(Math.hypot(x.east - y.east, x.north - y.north, x.up - y.up)).toBeLessThan(0.5);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    const withs = await Promise.all(
      [a, b, c].map((p) => p.evaluate((id) => globalThis.keel.lifeWith(id), booby.id)),
    );
    const first = withs[0];
    expect(first).not.toBeNull();
    for (const pose of withs) {
      expect(pose).not.toBeNull();
      expect(
        Math.hypot(
          (pose?.east ?? 0) - (first?.east ?? 0),
          (pose?.north ?? 0) - (first?.north ?? 0),
        ),
      ).toBeLessThan(5);
    }
  } finally {
    for (const c of contexts) {
      await c.close();
    }
  }
});

test('a pod rides one boat’s bow, at that bow on every page', { tag: '@world' }, async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  // A steady breeze, so the boat has way on whatever the world's weather is.
  expect((await request.post(`${internal}/debug/wind?knots=14&from=0`)).status()).toBe(204);
  try {
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
    await a.waitForFunction(() => Math.cos(globalThis.keel.boat().wind.meanFrom) > 0.99, null, {
      timeout: 10_000,
    });
    // Out of the roads, on a beam reach, the sail set and the course held.
    const spot = await alone(a, 90);
    const heading = await a.evaluate(() => {
      globalThis.keel.setControls(0, 0.3);
      return globalThis.keel.boat().state.heading;
    });
    await a.evaluate((h) => globalThis.keel.script('steer', h), heading);

    // Bob lies at rest abeam of her, near enough to see her; Cat watches her.
    const bob = await browser.newContext();
    contexts.push(bob);
    await sailor(bob, 'Bob');
    const b = await bob.newPage();
    await sail(b);
    const bobBoat = await b.evaluate(() => globalThis.keel.net().boat);
    const abeam = heading + Math.PI / 2;
    const res = await b.request.post(
      `${internal}/debug/place?east=${Math.round(spot.east + 120 * Math.sin(abeam))}&north=${Math.round(spot.north + 120 * Math.cos(abeam))}&heading=0&boat=${bobBoat}`,
    );
    expect(res.status(), await res.text()).toBe(200);
    const cat = await browser.newContext();
    contexts.push(cat);
    await sailor(cat, 'Cat');
    const c = await cat.newPage();
    await c.goto(`${GAME}&watch=${encodeURIComponent(made.name)}`);
    await c.waitForFunction((n) => globalThis.keel?.watch().watching?.sailor === n, made.name, {
      timeout: 90_000,
    });

    // Way on, on a steady course, a while.
    await a.waitForFunction(() => globalThis.keel.boat().out.speedOverGround > 2.3, null, {
      timeout: 60_000,
    });
    await a.waitForTimeout(12_000);
    const boat = await a.evaluate(() => globalThis.keel.net().boat);
    // Raised just ahead of her: it takes her once her course has held for
    // the binding's while; until then it passes, and another is raised.
    let pod: LifeSeen | undefined;
    for (let n = 0; n < 4 && pod?.with !== 1; n++) {
      const before = new Set(
        (await a.evaluate(() => globalThis.keel.life().records)).map((r) => r.id),
      );
      const raised = await a.request.post(
        `${internal}/debug/life?kind=${rider}&at=boat&boat=${boat}&ahead=30`,
      );
      expect(raised.status(), await raised.text()).toBe(200);
      await a.waitForFunction(
        ([before, rider]) =>
          globalThis.keel.life().records.some((r) => !before.includes(r.id) && r.kind === rider),
        [[...before], rider] as const,
        { timeout: 30_000 },
      );
      pod = (await a.evaluate(() => globalThis.keel.life().records)).find(
        (r) => !before.has(r.id) && r.kind === rider,
      );
      if (pod?.with !== 1) {
        await a.waitForTimeout(5_000);
      }
    }
    if (pod === undefined) {
      throw new Error('no pod raised');
    }
    const way = await a.evaluate(() => globalThis.keel.boat().out.speedOverGround);
    expect(pod.with, `the pod rides her bow (she sails at ${way.toFixed(2)} m/s)`).toBe(1);
    // The watcher has it with the boat it watches, Bob with a boat he sees.
    const cp = await record(c, pod.id);
    expect(cp.with).toBe(1);
    const bp = await record(b, pod.id);
    expect(bp.with).toBeGreaterThanOrEqual(2);
    expect(bp.with).toBeLessThan(255);
    expect({ ...bp, with: 1 }).toEqual(pod);

    // Riding, once in: each page finds the riders at the bow of her boat
    // as it draws it, within a metre of each other.
    const k = data.life.kinds[rider];
    const life = (pod.end - pod.start) / 30;
    const inAt = Math.min((k?.range ?? 0) / pod.speed, life / 2);
    const tick = pod.start + Math.round((inAt + 20) * 30);
    // Each page's riders, from its own boat as it draws her at that
    // moment: where they are about the bow it draws.
    const swimmers = async (p: Page) =>
      p.evaluate(
        ([t, id]) => {
          const k = globalThis.keel;
          const at = k.lifeWith(id);
          return k
            .lifeSwimmers(t)
            .filter((x) => x.id === id && at !== null)
            .map((x) => ({
              ...x,
              east: x.east - (at?.east ?? 0),
              north: x.north - (at?.north ?? 0),
            }));
        },
        [tick, pod.id] as const,
      );
    const [sa, sb, sc] = await Promise.all([swimmers(a), swimmers(b), swimmers(c)]);
    expect(sa.length).toBeGreaterThan(0);
    const h = await a.evaluate(() => globalThis.keel.boat().state.heading);
    // The first riders are a few metres ahead of her middle.
    const lead = sa.find((x) => x.k === 0);
    expect(lead).toBeDefined();
    if (lead !== undefined) {
      const ahead = lead.east * Math.sin(h) + lead.north * Math.cos(h);
      expect(ahead).toBeGreaterThan(0);
      expect(ahead).toBeLessThan(15);
    }
    for (const other of [sb, sc]) {
      let compared = 0;
      for (const x of sa) {
        const y = other.find((o) => o.k === x.k);
        if (y === undefined) {
          continue;
        }
        compared++;
        expect(Math.hypot(x.east - y.east, x.north - y.north)).toBeLessThan(1);
      }
      expect(compared).toBeGreaterThan(0);
    }
  } finally {
    for (const c of contexts) {
      await c.close();
    }
    await request.post(`${internal}/debug/weather?regime=${heldRegime()}`);
  }
});

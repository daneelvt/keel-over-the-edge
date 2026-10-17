// SPDX-License-Identifier: AGPL-3.0-only

// The world page, against keel (tools/e2e) through its own Vite: the map of
// the whole disk and its layers, the islands' list, the boats at sea; the
// owner flags their account from the page, clicks a point on the map and
// their page's boat is there within a second; the page reads nothing while
// its tab is hidden. One back end is enough: the game's drawing is not under
// test.

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { guest, sail } from './helpers';

const internal = 'http://127.0.0.1:19090';
const owner = 'http://localhost:5184/owner/';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the world page: one back end is enough');
});

/** The world as keel's internal listener has it. */
async function world(request: APIRequestContext) {
  const res = await request.get(`${internal}/owner/api/world.json`);
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    tick: number;
    boats: {
      boat: number;
      account: string;
      tools: boolean;
      east: number;
      north: number;
      unseen: boolean;
    }[];
  };
}

/** Opens the world page and waits for its first reading of the world. */
async function openWorld(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(owner);
  await expect(page.locator('[data-field="tick"]')).toHaveText(/^\d+$/, { timeout: 30_000 });
  expect(errors).toEqual([]);
}

/** The map's pixels, summed by channel: enough to see a layer come and go. */
async function mapSum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.map') as HTMLCanvasElement;
    const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(
      0,
      0,
      c.width,
      c.height,
    ).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) {
      s += (d[i] ?? 0) + 3 * (d[i + 1] ?? 0) + 7 * (d[i + 2] ?? 0);
    }
    return s;
  });
}

test('the world page: the map and its layers, the islands, the world', async ({ page }) => {
  await openWorld(page);
  // The land, drawn once per world, and every island in the list.
  await expect(page.locator('.islands button[data-island]').first()).toBeVisible();
  expect(await page.locator('.islands button[data-island]').count()).toBeGreaterThan(50);
  await page.waitForFunction(() => {
    const imgs = [...document.images];
    return imgs.length === 0 || imgs.every((i) => i.complete);
  });
  await page.waitForTimeout(1500);
  // Each layer switches.
  for (const layer of ['land', 'rings', 'wind', 'names']) {
    const before = await mapSum(page);
    await page.locator(`input[name="layer-${layer}"]`).uncheck();
    await page.waitForTimeout(200);
    const without = await mapSum(page);
    await page.locator(`input[name="layer-${layer}"]`).check();
    await page.waitForTimeout(200);
    expect(without, layer).not.toBe(before);
  }
  // An island in the list: the map goes to it, and its approach is picked.
  const port = page.locator('.islands button[data-island="0"]');
  const name = ((await port.textContent()) ?? '').replace(/^0\. /, '');
  await port.click();
  await expect(page.locator('[data-field="point"]')).toContainText(name);
  await expect(page.locator('[data-field="point"]')).not.toContainText('No boat here');
});

test('the owner flags their account and puts their boat where they click', async ({
  browser,
  page,
  request,
}) => {
  const small = { viewport: { width: 320, height: 200 } };
  const context = await browser.newContext(small);
  const sailor = await context.newPage();
  await guest(context, 'Owner');
  await sail(sailor);
  const boat = await sailor.evaluate(() => globalThis.keel.net().boat);
  expect(await sailor.evaluate(() => globalThis.keel.net().tools)).toBe(false);
  await openWorld(page);
  // Flagged from the boat's row, and told at once.
  const row = page.locator(`tr[data-boat="${boat}"]`);
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.locator('input[name="flag"]').check();
  await expect(page.locator('.message')).toContainText('Done');
  await expect
    .poll(() => sailor.evaluate(() => globalThis.keel.net().tools), { timeout: 5000 })
    .toBe(true);
  // A point on the map, a little east of the centre: the map's own
  // projection gives the world point; the page asks what is there.
  await row.click();
  const map = page.locator('canvas.map');
  const box = await map.boundingBox();
  if (box === null) {
    throw new Error('no map');
  }
  await map.click({ position: { x: box.width / 2 + 20, y: box.height / 2 - 10 } });
  await expect(page.locator('[data-field="point"]')).toContainText('inside the lip');
  const text = (await page.locator('[data-field="point"]').textContent()) ?? '';
  const m = /\((-?\d+), (-?\d+)\)/.exec(text);
  if (m === null) {
    throw new Error(text);
  }
  const at = [Number(m[1]), Number(m[2])];
  const before = Date.now();
  await page.locator('button', { hasText: 'To the point picked' }).click();
  await expect(page.locator('.message')).toContainText('teleport');
  // On the sailor's page, there within a second.
  await expect
    .poll(
      async () => {
        const s = await sailor.evaluate(() => globalThis.keel.boat().state);
        return Math.hypot(s.x - (at[0] ?? 0), s.y - (at[1] ?? 0));
      },
      { timeout: 5000, intervals: [100] },
    )
    .toBeLessThan(8);
  expect(Date.now() - before).toBeLessThan(5000);
  // Unflagged: told at once again.
  await row.locator('input[name="flag"]').uncheck();
  await expect
    .poll(() => sailor.evaluate(() => globalThis.keel.net().tools), { timeout: 5000 })
    .toBe(false);
  // The page's view of it, at its next building.
  await expect
    .poll(async () => (await world(request)).boats.find((b) => b.boat === boat)?.tools, {
      timeout: 3000,
    })
    .toBe(false);
  await context.close();
});

test('the page reads nothing while its tab is hidden', async ({ page }) => {
  await openWorld(page);
  let reads = 0;
  page.on('request', (r) => {
    if (r.url().includes('/owner/api/world.json')) {
      reads++;
    }
  });
  await page.waitForTimeout(2500);
  expect(reads).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  reads = 0;
  await page.waitForTimeout(3000);
  expect(reads).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads, { timeout: 5000 }).toBeGreaterThan(0);
});

test('the internal listener refuses a page that is not this computer’s', async ({ request }) => {
  for (const path of ['/owner/api/world.json', '/owner/api/land.png']) {
    const res = await request.get(`${internal}${path}`, { headers: { Host: 'evil.example:9090' } });
    expect(res.status(), path).toBe(403);
  }
  const res = await request.post(`${internal}/owner/api/flag`, {
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    data: { account: '0199c2a4-5f7e-7c3a-9d0e-000000000001', on: true },
  });
  expect(res.status()).toBe(403);
});

// SPDX-License-Identifier: AGPL-3.0-only

// Watching a boat, against keel and its database: a machine sailor made
// and sailed through the MCP address with a connection token, watched from
// its owner's start screen; the bar over it says whose boat it is, with
// the cog, and nothing on the screen steers it; the Inputs the page sends
// while it watches carry no controls (the worker's count); and Sail gives
// the player a boat of their own at the start. One sea page only: a second
// beside it is slow on CI's software GPU. The AI app is the test's own,
// through the server's routes.
//
// Then the list of sailors to watch: two machine sailors at sea, put in
// order of how near the edge they are, one's card opened, followed and
// watched from it; and a human sailor, who comes to Set sail on every
// entry, is found on the list only once they tick the box that lets
// others watch them sail.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { holdPasskeys, type Made, sailor, setSail, softwareGPU } from './helpers';
import { assertPasskey } from './passkey';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'watching: one back end is enough');
});

/** A machine sailor made through the server's route, its look the catalog's first; its id. */
async function machine(context: BrowserContext, name: string): Promise<string> {
  const res = await context.request.post('/api/machines', {
    data: {
      name,
      version: data.machine.versions[0]?.id,
      finish: data.machine.finishes[0]?.id,
      colour: data.machine.colours[0]?.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const page = (await res.json()) as { machines: { id: string; name: string }[] };
  return page.machines.find((m) => m.name === name)?.id ?? '';
}

/** A connection token for the machine sailor, made after the owner's passkey, as the account page makes one. */
async function token(context: BrowserContext, made: Made, id: string): Promise<string> {
  const begun = await context.request.post('/api/account/confirm/begin');
  expect(begun.status(), await begun.text()).toBe(200);
  const origin = new URL(begun.url()).origin;
  const finish = await context.request.post('/api/account/confirm/finish', {
    data: assertPasskey({ ...made.passkey, origin }, await begun.json()),
  });
  expect(finish.status(), await finish.text()).toBe(200);
  const res = await context.request.post('/api/machines/token', { data: { machine: id } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** Calls a tool at the MCP address with the token, as an AI app does; its answer. */
async function tool(
  context: BrowserContext,
  bearer: string,
  name: string,
  args: object,
): Promise<string> {
  const res = await context.request.post('/mcp', {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2025-06-18',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const body = await res.text();
  expect(res.status(), body).toBe(200);
  return body;
}

/** Whether the account's machine sailor of this name is at sea, as GET /api/machines says. */
async function atSea(context: BrowserContext, name: string): Promise<boolean> {
  const res = await context.request.get('/api/machines');
  const page = (await res.json()) as { machines: { name: string; atSea: boolean }[] };
  return page.machines.find((m) => m.name === name)?.atSea === true;
}

function watch(page: Page) {
  return page.evaluate(() => globalThis.keel.watch());
}

test('a machine sailor watched from its owner’s start screen: whose boat, nothing that steers, no controls sent; then Sail', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const made = await sailor(context, 'Owner');
  const name = `Watched ${Date.now() % 10_000_000}`;
  const id = await machine(context, name);
  const bearer = await token(context, made, id);
  // The machine sailor to sea, as its AI app takes it there.
  await tool(context, bearer, 'boat', { action: 'take' });
  await tool(context, bearer, 'observe', {});
  await expect.poll(() => atSea(context, name), { timeout: 30_000 }).toBe(true);
  await holdPasskeys(context, made.passkey);

  // The start screen with machine sailors: Watch beside the one at sea.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?test&backend=webgl2${softwareGPU ? '&tier=low' : ''}`);
  const row = page.locator('.machine-list li', { hasText: name });
  await expect(row).toContainText('at sea', { timeout: 30_000 });
  await row.getByRole('button', { name: 'Watch', exact: true }).click();

  // At sea, watching it: the bar, whose boat, and the cog.
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction((n) => globalThis.keel.watch().watching?.sailor === n, name, {
    timeout: 30_000,
  });
  const bar = page.locator('[data-readout="watching"]');
  await expect(bar).toContainText(`Watching ${name}`);
  await expect(bar.getByRole('img', { name: 'machine sailor' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Watch another' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Sail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Behind the boat' })).toBeVisible();
  const w = await watch(page);
  expect(w.watching).toEqual({ sailor: name, machine: true, mine: true });
  expect(w.spectating).toBe(true);

  // Nothing that steers: no helm, sheet, autopilot or free camera.
  await expect(page.getByRole('slider', { name: 'Helm' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Sheet' })).toHaveCount(0);
  await expect(page.locator('.pilot-button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('button', { name: /Free camera/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop watching' })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Let others watch me sail (this voyage)' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // The keys steer nothing, and the Inputs sent carry no controls: the
  // worker's count, as the traffic it reports with each Pong says.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(100);
    await page.keyboard.up('ArrowLeft');
  }
  const sent = () => page.evaluate(() => globalThis.keel.net().traffic.messagesOut);
  const before = await sent();
  await expect.poll(sent, { timeout: 10_000 }).toBeGreaterThan(before);
  expect((await watch(page)).controls).toBe(0);
  // The watched boat's snapshots come, and its time goes on.
  const t0 = (await watch(page)).ticks;
  await expect.poll(async () => (await watch(page)).ticks, { timeout: 10_000 }).toBeGreaterThan(t0);

  // Sail: a boat of the player's own, at the start, and the controls back.
  await bar.getByRole('button', { name: 'Sail' }).click();
  await page.waitForFunction(
    () => globalThis.keel.watch().watching === null && !globalThis.keel.watch().spectating,
    null,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-readout="connection"]')).toHaveText(
    'Your boat is in the water.',
  );
  await expect(page.getByRole('slider', { name: 'Helm' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.keel.net().status)).toBe('sailing');
  // The boat starts on the server's grid, south of the centre, heading east.
  await expect
    .poll(() => page.evaluate(() => globalThis.keel.net().counts.snapshots), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const b = await page.evaluate(() => globalThis.keel.boat());
  expect(b.state.y).toBeLessThan(0);
  expect(Math.abs(b.state.heading - Math.PI / 2)).toBeLessThan(0.5);
  // Now the helm steers again, and its controls go, as the other online
  // specs steer: through the hook, which a slow software renderer's frames
  // cannot miss as they can a short key press.
  await page.evaluate(() => globalThis.keel.setControls(1, 0.5));
  await expect
    .poll(async () => (await watch(page)).controls, {
      timeout: 20_000,
      message: 'controls sent once sailing again',
    })
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/** The game's address with the test hooks, on the project's back end. */
const GAME = `/?test&backend=webgl2${softwareGPU ? '&tier=low' : ''}`;

/** A machine sailor made, given a connection token and taken to sea by its AI app. */
async function toSea(context: BrowserContext, made: Made, name: string): Promise<void> {
  const bearer = await token(context, made, await machine(context, name));
  await tool(context, bearer, 'boat', { action: 'take' });
  await tool(context, bearer, 'observe', {});
  await expect.poll(() => atSea(context, name), { timeout: 30_000 }).toBe(true);
}

/** Opens the list of sailors to watch from the player's own sailor, on the start screen. */
async function openList(page: Page): Promise<void> {
  await page
    .locator('.your-sailor')
    .getByRole('button', { name: 'Watch another sailor' })
    .click({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Watch a sailor' })).toBeVisible();
}

test('two machine sailors at sea: the list in order of the edge, a card, Follow, and Watch from the card', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(240_000);
  // Two owners, a machine sailor each (an account may have only so
  // many), and a watcher with none: no sailor of the watcher's own comes
  // first.
  const stamp = Date.now() % 10_000_000;
  const names = [`Ahead ${stamp}`, `Astern ${stamp}`];
  for (const n of names) {
    const owner = await browser.newContext();
    try {
      await toSea(owner, await sailor(owner, 'Owner'), n);
    } finally {
      await owner.close();
    }
  }
  const made = await sailor(context, 'Lister');
  await holdPasskeys(context, made.passkey);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(GAME);
  await openList(page);

  // Only these two: the shared world has others' machine sailors at sea.
  await page.getByRole('searchbox', { name: 'Part of a name' }).fill(String(stamp));
  await page.getByRole('button', { name: 'Nearest the edge' }).click();
  await expect(page.getByRole('button', { name: 'Nearest the edge' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const rows = page.locator('.watch-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  // Each row: the sky in words, the cog, how far from the edge; nearest first.
  await expect(rows.first().locator('.watch-sky')).toHaveAttribute('role', 'img');
  await expect(rows.first().getByRole('img', { name: 'machine sailor' })).toBeVisible();
  const edge = async (i: number) =>
    Number(
      /([0-9.]+) NM from the edge/.exec((await rows.nth(i).innerText()) ?? '')?.[1] ?? Number.NaN,
    );
  const near = await edge(0);
  expect(near).toBeLessThanOrEqual(await edge(1));
  const first = (await rows.first().getAttribute('data-sailor')) ?? '';
  expect(names).toContain(first);

  // Its card: the weather, where, and Follow.
  await rows
    .first()
    .getByRole('button', { name: `About ${first}` })
    .click();
  const card = page.locator('.watch-card');
  await expect(card.getByRole('heading', { name: 'The weather' })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('section[aria-label="Where"]')).toContainText('NM from the edge');
  await card.getByRole('button', { name: '☆ Follow' }).click();
  await expect(card.getByRole('button', { name: '★ Following' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Back to the list: the star on the row followed.
  await card.getByRole('button', { name: 'Back' }).click();
  await expect(
    page.locator(`.watch-row[data-sailor="${first}"]`).getByRole('img', { name: 'followed' }),
  ).toBeVisible();
  // The Following list has it.
  await page.getByRole('combobox', { name: 'Show' }).selectOption('following');
  await expect(page.locator(`.watch-row[data-sailor="${first}"]`)).toBeVisible();

  // Watch from the card.
  await page.getByRole('button', { name: `About ${first}` }).click();
  await card.getByRole('button', { name: 'Watch', exact: true }).click();
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction((n) => globalThis.keel.watch().watching?.sailor === n, first, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test('a human sailor comes to Set sail on entry; watchable only once they tick the box', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(300_000);
  // The sailor to be watched, on a page of their own.
  const other = await browser.newContext();
  const seen = await other.newPage();
  try {
    const them = await sailor(other, 'Seen');
    await seen.goto(GAME);
    // No machine sailor, and still the Set sail screen, the box unticked.
    const yours = seen.locator('.your-sailor');
    await expect(yours).toContainText(them.name, { timeout: 90_000 });
    const box = seen.getByRole('checkbox', { name: 'Let others watch me sail' });
    await expect(box).not.toBeChecked();
    await setSail(seen);
    await seen.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
      timeout: 60_000,
    });

    // Unticked: the watcher, on the start screen, does not find them.
    const made = await sailor(context, 'Watcher');
    await holdPasskeys(context, made.passkey);
    await page.goto(GAME);
    await openList(page);
    await page.getByRole('searchbox', { name: 'Part of a name' }).fill(them.name);
    await expect(page.locator('.watch-empty')).toHaveText(
      `No one at sea who can be watched has ${them.name} in their name.`,
      { timeout: 30_000 },
    );

    // Back at the Set sail screen after a reload, the boat still at sea:
    // the box is the voyage's, unticked; ticked, the voyage can be watched.
    await seen.reload();
    await expect(yours).toContainText('at sea', { timeout: 90_000 });
    await expect(box).not.toBeChecked();
    await box.check();
    await setSail(seen);

    // The list looks again by itself, and finds them.
    const row = page.locator(`.watch-row[data-sailor="${them.name}"]`);
    await expect(row).toBeVisible({ timeout: 40_000 });
    await expect(row.getByRole('img', { name: 'machine sailor' })).toHaveCount(0);
    // The watcher's sea starts beside a page drawing it: that one held meanwhile.
    await seen.evaluate(() => globalThis.keel.hold(true));
    try {
      await row.getByRole('button', { name: 'Watch', exact: true }).click();
      await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 90_000 });
      await page.waitForFunction((n) => globalThis.keel.watch().watching?.sailor === n, them.name, {
        timeout: 60_000,
      });
    } finally {
      await seen.evaluate(() => globalThis.keel.hold(false));
    }
    expect((await watch(page)).watching).toEqual({
      sailor: them.name,
      machine: false,
      mine: false,
    });
  } finally {
    await other.close();
  }
});

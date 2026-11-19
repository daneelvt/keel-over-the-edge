// SPDX-License-Identifier: AGPL-3.0-only

// The menu's pages at sea, against keel: every page it opens (the account,
// the machine sailors and how to connect one, Invite friends, the
// shipmates, the sailors to watch) stands where the menu stood, never
// over the middle of the screen where the boat is, with its name and its
// close at the top and a margin round what it holds, and nothing in it
// wider than it. Invite friends is the one place a link is shared: to
// watch the player, and to sail with them. Change boat, beside Back to
// Port Royal, asks first, takes the boat out of the water and opens the
// start screen on the boats to choose from; the boat chosen sails afresh
// from the start.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { everyBoat, GAME, sail, sailor, setSail, stamp } from './helpers';

/** The account's kind of boat, by what it is rather than its id. */
const keelboat = data.boats.find((b) => b.fleet === 'account');

const SCREENS = [
  { name: 'a phone upright', width: 360, height: 640 },
  { name: 'a phone sideways', width: 640, height: 360 },
  { name: 'a desktop', width: 960, height: 600 },
];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the menu stands on this screen: opened, measured and closed. */
async function menuBox(page: Page): Promise<Box> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.locator('.menu');
  await expect(menu).toBeVisible();
  const b = await menu.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  await page.getByRole('button', { name: 'Close the menu' }).click();
  await expect(menu).toHaveCount(0);
  return b;
}

/** What is wrong with the page open at sel, against where the menu stands. */
async function pageFaults(page: Page, sel: string, title: string, menu: Box): Promise<string[]> {
  const win = page.locator(sel);
  await expect(win).toBeVisible();
  await expect(win.locator('.menu-head h2')).toHaveText(title);
  return win.evaluate(
    (e, { menu }) => {
      const out: string[] = [];
      const r = e.getBoundingClientRect();
      const upright = innerHeight > innerWidth;
      // In the menu's place: its top edge held upright, where it reaches
      // across the screen; its right edge, and its width, held sideways.
      if (Math.abs(r.right - menu.right) > 1 || Math.abs(r.left - menu.left) > 1) {
        out.push(
          `it stands from ${Math.round(r.left)} to ${Math.round(r.right)}, the menu from ${Math.round(menu.left)} to ${Math.round(menu.right)}`,
        );
      }
      if (upright && Math.abs(r.top - menu.top) > 1) {
        out.push(`its top is at ${Math.round(r.top)}, the menu's at ${Math.round(menu.top)}`);
      }
      if (
        r.left < -0.5 ||
        r.top < -0.5 ||
        r.right > innerWidth + 0.5 ||
        r.bottom > innerHeight + 0.5
      ) {
        out.push(`it is off the screen (${[r.left, r.top, r.right, r.bottom].map(Math.round)})`);
      }
      // Held upright the sea under it, where the boat's hull is, stays in sight.
      if (upright && r.bottom > innerHeight * 0.66) {
        out.push(`it reaches down to ${Math.round(r.bottom)} of ${innerHeight}`);
      }
      // Its close at the top right, a touch's size, within it.
      const x = e.querySelector('.menu-head .menu-x')?.getBoundingClientRect();
      if (x === undefined) {
        out.push('no close at its top');
      } else {
        if (x.width < 43.5 || x.height < 43.5) {
          out.push(`its close is ${Math.round(x.width)} × ${Math.round(x.height)}`);
        }
        if (x.top < r.top - 0.5 || x.top - r.top > 12 || r.right - x.right > 12) {
          out.push('its close is not at its top right');
        }
      }
      // Nothing in it wider than it, and a margin round its words and keys.
      if (e.scrollWidth > e.clientWidth + 1) {
        out.push(`its contents are ${e.scrollWidth} px wide in ${e.clientWidth}`);
      }
      const head = e.querySelector('.menu-head');
      for (const c of e.querySelectorAll<HTMLElement>(
        'p, button, input, select, h3, li, img, canvas',
      )) {
        if (head?.contains(c) || c.offsetParent === null) {
          continue;
        }
        // A row that scrolls sideways by design (the list's orders) is its own.
        let scrolls = false;
        for (let at = c.parentElement; at !== null && at !== e; at = at.parentElement) {
          const o = getComputedStyle(at).overflowX;
          scrolls ||= o === 'auto' || o === 'scroll';
        }
        if (scrolls) {
          continue;
        }
        const b = c.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) {
          continue;
        }
        if (b.left < r.left + 11.5 || b.right > r.right - 11.5) {
          out.push(
            `“${(c.textContent ?? '').trim().slice(0, 24) || c.tagName}” is ${Math.round(b.left - r.left)} px from its left and ${Math.round(r.right - b.right)} px from its right`,
          );
        }
      }
      return out;
    },
    { menu },
  );
}

/** Opens a page from the menu by its key. */
async function open(page: Page, key: string): Promise<void> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.menu').getByRole('button', { name: key, exact: true }).click();
}

/** Closes the page open by the close at its top, and waits until it is gone. */
async function shut(page: Page, sel: string): Promise<void> {
  await page.locator(sel).getByRole('button', { name: 'Close this window' }).click();
  await expect(page.locator(sel)).toHaveCount(0);
}

test('every page of the menu stands in the menu’s place, its name and close at the top, a margin round what it holds', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  // A name of the most letters a sailor may have, which wraps on a phone.
  await sailor(context, 'Wavecrestmak');
  const machine = await context.request.post('/api/machines', {
    data: {
      name: `Cog ${stamp()}`,
      version: data.machine.versions[0]?.id,
      finish: data.machine.finishes[0]?.id,
      colour: data.sailorOptions.colours[0]?.id,
    },
  });
  expect(machine.status(), await machine.text()).toBe(201);
  await sail(page);
  const PAGES = [
    { key: 'Account', sel: '.menu-page.account', title: 'Account', ready: '.account-passkeys li' },
    {
      key: 'Machine sailors',
      sel: '.menu-page.machines',
      title: 'Machine sailors',
      ready: '.machine-list li',
    },
    {
      key: 'Invite friends',
      sel: '.menu-page.invite',
      title: 'Invite friends',
      ready: '.deck-link',
    },
    { key: 'Shipmates', sel: '.shipmates-panel', title: 'Shipmates', ready: '.deck-switch, p' },
    { key: 'Watch a sailor', sel: '.watch-list', title: 'Watch a sailor', ready: '.watch-search' },
  ];
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    const menu = await menuBox(page);
    for (const p of PAGES) {
      await open(page, p.key);
      await expect(page.locator(p.sel).locator(p.ready).first()).toBeAttached({ timeout: 15_000 });
      for (const f of await pageFaults(page, p.sel, p.title, menu)) {
        found.push(`${s.name}, ${p.key}: ${f}`);
      }
      if (p.key === 'Machine sailors') {
        // How to connect, opened under its machine sailor: the same margin.
        await page.locator(p.sel).getByRole('button', { name: 'How to connect' }).click();
        await expect(page.locator(p.sel).locator('[data-mcp]')).toBeVisible();
        for (const f of await pageFaults(page, p.sel, p.title, menu)) {
          found.push(`${s.name}, How to connect: ${f}`);
        }
      }
      await shut(page, p.sel);
      if (p.sel.startsWith('.menu-page')) {
        // A page of the menu's own gives the focus back to its button.
        await expect(page.locator('.menu-button')).toBeFocused();
      }
    }
  }
  expect(found).toEqual([]);
  // Escape closes a page too, and a tap beside it.
  await open(page, 'Account');
  await expect(page.locator('.menu-page.account')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu-page')).toHaveCount(0);
  await open(page, 'Machine sailors');
  await expect(page.locator('.menu-page.machines')).toBeVisible();
  await page.mouse.click(40, 300);
  await expect(page.locator('.menu-page')).toHaveCount(0);
});

test('Invite friends is the one place a link is shared: to watch me, and to sail with me', async ({
  context,
  page,
}) => {
  await sailor(context, 'Invite');
  await sail(page);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.locator('.menu');
  // One key for every link, with the other keys at the top: above the
  // device's switches, and no share or link key of its own in the menu.
  const invite = menu.getByRole('button', { name: 'Invite friends', exact: true });
  await expect(invite).toBeVisible();
  const order = await menu.evaluate((e) => {
    const top = (sel: string) =>
      [...e.querySelectorAll<HTMLElement>(sel)].map((x) => x.getBoundingClientRect().top);
    const key = [...e.querySelectorAll('button')].find((b) => b.textContent === 'Invite friends');
    return {
      invite: key?.getBoundingClientRect().top ?? Number.NaN,
      device: Math.min(...top('h3')),
      keys: [...e.querySelectorAll('button')].map((b) => b.textContent ?? ''),
    };
  });
  expect(order.invite).toBeLessThan(order.device);
  for (const k of order.keys) {
    expect(k).not.toMatch(/link|Sail with me|picture/i);
  }
  await expect(menu.getByRole('checkbox', { name: /Let others watch/ })).toHaveCount(0);
  await invite.click();
  const sheet = page.locator('.menu-page.invite');
  // Watch me sail: who may, the link, and the link with a picture's place.
  const watch = sheet.locator('[data-part=watch]');
  await expect(watch.getByRole('heading', { name: 'Watch me sail' })).toBeVisible();
  await expect(
    watch.getByRole('checkbox', { name: 'Let others watch me sail (this voyage)' }),
  ).toBeVisible();
  await expect(watch.getByRole('button', { name: 'Share a link to watch me' })).toBeVisible();
  // Sail with me: no link out, and one key that gets it.
  const with_ = sheet.locator('[data-part=sail]');
  await expect(with_.getByRole('heading', { name: 'Sail with me' })).toBeVisible();
  await expect(with_).toContainText('You have no link out.');
  await expect(with_.getByRole('button', { name: 'Get a link', exact: true })).toBeVisible();
  await expect(with_.getByRole('checkbox', { name: /Closed to knocks/ })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close this window' }).click();
  await expect(sheet).toHaveCount(0);
});

test('Change boat: asked first, the boat out of the water, the boats to choose from, and the one chosen sailed afresh from the start', async ({
  context,
  page,
}) => {
  test.skip(keelboat === undefined, 'the catalog has no boat the account shares');
  test.setTimeout(150_000);
  const made = await sailor(context, 'Changer');
  await everyBoat(context.request, made.name);
  await page.goto(GAME);
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  const first = (await page.evaluate(() => globalThis.keel.net())).boat;
  const fleet = async () =>
    (await (await page.request.get('/api/fleet')).json()) as {
      boats: { kind: string; atSea: boolean; yours: boolean }[];
    };
  await expect.poll(async () => (await fleet()).boats.find((b) => b.yours)?.atSea).toBe(true);

  // Under Back to Port Royal in the menu; Stay keeps the boat where it is.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const keys = await page
    .locator('.menu button')
    .evaluateAll((all) => all.map((b) => b.textContent ?? ''));
  expect(keys.indexOf('Change boat')).toBe(keys.indexOf('Back to Port Royal') + 1);
  await page.locator('.menu').getByRole('button', { name: 'Change boat', exact: true }).click();
  const q = page.getByRole('alertdialog', { name: 'Change boat?' });
  await expect(q).toContainText('Your boat comes out of the water and this voyage ends.');
  await expect(q.getByRole('button', { name: 'Stay', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(q).toHaveCount(0);
  expect((await fleet()).boats.find((b) => b.yours)?.atSea).toBe(true);

  // Change boat: out of the game, to the boats to choose from.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.menu').getByRole('button', { name: 'Change boat', exact: true }).click();
  await q.getByRole('button', { name: 'Change boat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Change boat', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect((await fleet()).boats.some((b) => b.atSea)).toBe(false);
  await page
    .locator('.change-boat-choice', { hasText: keelboat?.name ?? '' })
    .first()
    .click();
  // The boat is out of the water already: nothing more is asked.
  const yours = page.locator('.your-sailor');
  await expect(yours.locator('[data-readout=boat]')).toContainText(keelboat?.name ?? '');
  await expect(yours).not.toContainText('still in the water');
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  // Another boat, afresh at the start, south of the centre.
  expect((await page.evaluate(() => globalThis.keel.net())).boat).not.toBe(first);
  expect((await fleet()).boats.find((b) => b.yours)?.kind).toBe(keelboat?.id);
  const s = (await page.evaluate(() => globalThis.keel.boat())).state;
  expect(Math.abs(s.x)).toBeLessThan(700);
  expect(s.y).toBeLessThan(0);
  expect(s.y).toBeGreaterThan(-400);

  // A reload afterwards opens the start screen as ever, not the boats.
  await page.reload();
  await expect(page.locator('.your-sailor')).toContainText(made.name, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Change boat', exact: true })).toHaveCount(0);
});

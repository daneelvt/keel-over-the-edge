// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea laid out on phones held either way and on the browser
// tests' screen, in the offline sandbox: with the barometer and the world
// clock out of the case, the autopilot's control head open and the boat in
// Port Royal's harbour, no part of the screen covers another, or the boat
// as drawn with a margin about it, and every part is on the screen. One
// page, its viewport changed screen by screen, with less motion asked
// for, so that nothing is measured mid-slide.
//
// Held upright, the chase camera puts the boat's masthead within a sixth
// of the screen's height of its top, where no case of instruments fits
// above it: there the case's face alone may stand over the masthead. Its
// complications, hanging under the compass, may not.
//
// Then the list of sailors to watch and the card about one, on the start
// screen, at the same screens: full rows and a full card, the server's
// answers stood in for, with a twenty-letter name. Watch is in view, no
// part covers another, and every button is 44 pixels or more.

import { expect, type Page, test } from '@playwright/test';
import { openScene, sailor } from './helpers';

/** The screens: phones in CSS pixels, upright and sideways, and the tests' own. */
const SCREENS = [
  { name: 'iPhone SE upright', width: 375, height: 667, upright: true },
  { name: 'iPhone 16 upright', width: 393, height: 852, upright: true },
  { name: 'iPhone 16 sideways', width: 852, height: 393, upright: false },
  { name: 'small Android phone sideways', width: 640, height: 360, upright: false },
  { name: 'the tests’ screen', width: 960, height: 600, upright: false },
] as const;

/** The room kept about the boat, px. */
const ABOUT_BOAT = 16;

interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The parts of the screen at sea, each the union of its own box and its pushers'. */
async function parts(
  page: Page,
): Promise<{ parts: Box[]; boat: Box | null; out: string[]; spilt: string[] }> {
  return page.evaluate((about) => {
    const hud = document.querySelector('.hud');
    if (hud === null) {
      throw new Error('no screen at sea');
    }
    const box = (name: string, els: Element[]) => {
      const rs = els
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (rs.length === 0) {
        return null;
      }
      return {
        name,
        left: Math.min(...rs.map((r) => r.left)),
        top: Math.min(...rs.map((r) => r.top)),
        right: Math.max(...rs.map((r) => r.right)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
      };
    };
    const one = (name: string, sel: string) => {
      const e = hud.querySelector(sel);
      return e === null ? null : box(name, [e]);
    };
    const all = [
      one('the case', '.case-top'),
      one('the barometer', '[data-complication=barometer]'),
      one('the world clock', '[data-complication=clock]'),
      one('the pocket chart', '.pocket-chart'),
      one('the weather pusher', '.pocket-weather'),
      one('the menu button', '.menu-button'),
      one('the helm', '[data-control=helm]'),
      one('the sheet', '[data-control=sheet]'),
      one('the autopilot', '.pilot-head, .pilot-button'),
      ...[...hud.querySelectorAll('.hud-top > .panel:not(.case)')].map((e) =>
        box(`the line “${(e as HTMLElement).innerText}”`, [e]),
      ),
    ].filter((b) => b !== null);
    const b = globalThis.keel.boatBox();
    const boat =
      b.length === 0
        ? null
        : {
            name: 'the boat',
            left: Math.min(...b.map((r) => r.left)) - about,
            top: Math.min(...b.map((r) => r.top)) - about,
            right: Math.max(...b.map((r) => r.right)) + about,
            bottom: Math.max(...b.map((r) => r.bottom)) + about,
          };
    // A part's own keys stay within it.
    const spilt = [...hud.querySelectorAll('.pilot-head button, .case button')]
      .filter((k) => {
        const r = k.getBoundingClientRect();
        const p = (k.closest('.pilot-head') ?? k.closest('.case-top') ?? k).getBoundingClientRect();
        // A pusher's stem stands out of the case.
        const stem = k.classList.contains('pusher') ? 6.5 : 0.5;
        return (
          r.left < p.left - 0.5 ||
          r.right > p.right + stem ||
          r.top < p.top - 0.5 ||
          r.bottom > p.bottom + 0.5
        );
      })
      .map((k) => k.getAttribute('aria-label') ?? k.textContent ?? '');
    const out = [...hud.querySelectorAll('.complication:not([hidden])')].map(
      (e) => e.getAttribute('data-complication') ?? '',
    );
    return { parts: all, boat, out, spilt };
  }, ABOUT_BOAT);
}

/** A box's edges, left, top, right and bottom, in whole pixels. */
function edges(b: Box): string {
  return [b.left, b.top, b.right, b.bottom].map(Math.round).join(', ');
}

function overlap(a: Box, b: Box): boolean {
  // Half a pixel of rounding either way is not covering.
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  );
}

test('no part of the screen at sea covers the boat or another part, with everything open', async ({
  page,
}) => {
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  // Laid out as it rests: nothing caught sliding out.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const now = Date.now();
  await page.evaluate(
    ({ now }) => {
      const k = globalThis.keel;
      k.setWorldEnd({
        epoch: now - 2 * 86_400_000,
        ends: now + 5 * 86_400_000,
        closing: now + 2 * 86_400_000,
      });
      k.toHarbour();
      // At rest, the sail sheeted in: the boat drawn the same every time.
      k.setState({ sheetLimit: 0.05, boom: 0, surge: 0 });
      k.setControls(0, 0);
      k.advance(30);
      k.render();
      // The chase camera behind it again: time is held.
      k.camera('chase');
      k.render();
    },
    { now },
  );
  // The autopilot on, its head open.
  await page.keyboard.press('p');
  await expect(page.locator('.board-pusher, [data-pusher=board]')).toBeVisible({ timeout: 15_000 });
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    // The camera at the new size before anything is measured: a browser
    // may tell the page of its resize a frame or more late.
    await page.waitForFunction(
      ({ width, height }) =>
        innerWidth === width &&
        innerHeight === height &&
        Math.abs(globalThis.keel.world.stage.camera.aspect - width / height) < 1e-6,
      { width: s.width, height: s.height },
    );
    // Every complication out, the head open.
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.settings({ barometer: true, worldClock: true, pilotHead: true });
      k.render();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => globalThis.keel.render());
    const seen = await parts(page);
    await test.info().attach(`${s.name}.png`, {
      path: await page
        .screenshot({ path: test.info().outputPath(`${s.name}.png`) })
        .then(() => test.info().outputPath(`${s.name}.png`)),
      contentType: 'image/png',
    });
    for (const k of seen.spilt) {
      found.push(`${s.name}: “${k}” spills out of its part`);
    }
    const all = seen.boat === null ? seen.parts : [...seen.parts, seen.boat];
    for (const p of all) {
      if (p.left < -0.5 || p.top < -0.5 || p.right > s.width + 0.5 || p.bottom > s.height + 0.5) {
        found.push(`${s.name}: ${p.name} is off the screen`);
      }
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        const masthead =
          s.upright &&
          [a?.name, b?.name].includes('the case') &&
          [a?.name, b?.name].includes('the boat');
        if (a !== undefined && b !== undefined && !masthead && overlap(a, b)) {
          found.push(`${s.name}: ${a.name} covers ${b.name} (${edges(a)} and ${edges(b)})`);
        }
      }
    }
    // What is out, and the least room between the boat and any part.
    const room = (a: Box, b: Box) =>
      Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom);
    const clear =
      seen.boat === null
        ? null
        : Math.min(
            ...seen.parts
              .filter((p) => !(s.upright && p.name === 'the case'))
              .map((p) => room(p, seen.boat as Box)),
          );
    test.info().annotations.push({
      type: s.name,
      description: `out of the case: ${seen.out.join(', ') || 'nothing'}; room about the boat’s margin: ${clear === null ? '–' : Math.round(clear)} px`,
    });
  }
  expect(found).toEqual([]);
});

/** A row of the list as full as it gets. */
function row(name: string, i: number) {
  return {
    name,
    machine: i % 2 === 0,
    mine: false,
    // Not a catalog id: an unknown kind is shown as given, here the widest.
    kind: 'Long-keeled sailing cutter',
    watchers: 12 + i,
    sky: ['squalls', 'storm', 'fair', 'fog'][i % 4],
    night: i % 3 === 0,
    force: 7,
    knots: 6.4,
    state: 'sailing',
    followed: i === 0,
    edgeNM: 0.8 + i,
    lively: [
      { why: 'squalls' },
      { why: 'approach' },
      { why: 'charted', subject: 'Isle of the Drowned Bells', minutes: 4 },
    ],
  };
}

/** The longest name a sailor can have: twenty letters. */
const LONG = 'Bartholomew Roberts!';

/** The answers of the list's and the card's routes. */
async function standIn(page: Page): Promise<void> {
  const sailors = [LONG, ...Array.from({ length: 11 }, (_, i) => `Sailor ${i + 1}`)].map(row);
  await page.route(
    (url) => url.pathname === '/api/watch',
    (r) => r.fulfill({ json: { sailors, more: true, atSea: 40, withheld: false } }),
  );
  await page.route(
    (url) => url.pathname === '/api/watch/sailor',
    (r) =>
      r.fulfill({
        json: {
          ...row(LONG, 0),
          mine: true,
          agent: true,
          weather: {
            windFrom: 225,
            waves: 2.4,
            barometer: '998 hPa, falling quickly',
            visibility: 'visibility poor',
            rain: 'heavy rain',
            clouds: 'a thunderstorm, a squall about',
          },
          where: {
            edgeNM: 0.8,
            island: { name: 'Isle of the Drowned Bells', bearing: 300, nm: 3.1 },
            inSight: [
              'Isle of the Drowned Bells · 300° 3.1 NM · charted by «Bartholomew Roberts!» (human), Tuesday',
              'land (uncharted) · wooded island 1 NM across · 300° about 4 NM',
              'land (uncharted) · rocky islet · 020° about 6 NM',
            ],
          },
          voyage: { skimmedM: 140, charted: { subject: 'Isle of the Drowned Bells', minutes: 4 } },
        },
      }),
  );
}

/** Each visible part's box, with what is wrong: off the screen or the panel, covering another, too small to tap. */
async function panelParts(page: Page, sels: string[]): Promise<string[]> {
  return page.evaluate((sels) => {
    const found: string[] = [];
    const panel = document.querySelector('.watch-panel');
    if (panel === null) {
      return ['no panel'];
    }
    const p = panel.getBoundingClientRect();
    const inside = (r: DOMRect, o: { left: number; top: number; right: number; bottom: number }) =>
      r.left >= o.left - 0.5 &&
      r.top >= o.top - 0.5 &&
      r.right <= o.right + 0.5 &&
      r.bottom <= o.bottom + 0.5;
    if (!inside(p, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })) {
      found.push('the panel is off the screen');
    }
    const boxes: { name: string; r: DOMRect }[] = [];
    for (const sel of sels) {
      for (const e of panel.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) {
          continue;
        }
        const name = `${sel} “${(e as HTMLElement).innerText.slice(0, 24)}”`;
        if (!inside(r, p)) {
          found.push(`${name} is outside the panel`);
        }
        boxes.push({ name, r });
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]?.r as DOMRect;
        const b = boxes[j]?.r as DOMRect;
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
        ) {
          found.push(`${boxes[i]?.name} covers ${boxes[j]?.name}`);
        }
      }
    }
    // Every button that can be seen: 44 pixels each way at least.
    for (const b of panel.querySelectorAll('button, select')) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && (r.height < 43.5 || r.width < 43.5)) {
        found.push(
          `“${(b as HTMLElement).innerText}” is ${Math.round(r.width)} × ${Math.round(r.height)}`,
        );
      }
    }
    return found;
  }, sels);
}

/** Whether an element is wholly in view: on the screen, and not scrolled out of its scroller. */
async function inView(page: Page, sel: string): Promise<boolean> {
  return page
    .locator(sel)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      let ok =
        r.top >= -0.5 &&
        r.left >= -0.5 &&
        r.bottom <= innerHeight + 0.5 &&
        r.right <= innerWidth + 0.5;
      for (let p = e.parentElement; p !== null; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowY !== 'visible' || s.overflowX !== 'visible') {
          const q = p.getBoundingClientRect();
          ok &&=
            r.top >= q.top - 0.5 &&
            r.bottom <= q.bottom + 0.5 &&
            r.left >= q.left - 0.5 &&
            r.right <= q.right + 0.5;
        }
      }
      return ok;
    });
}

test('the list of sailors to watch and the card fit every screen, Watch in view', async ({
  context,
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(180_000);
  await sailor(context, 'Layout');
  await standIn(page);
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?test&backend=webgl2&tier=low');
  await page
    .locator('.your-sailor')
    .getByRole('button', { name: 'Watch another sailor' })
    .click({ timeout: 90_000 });
  await expect(page.locator('.watch-row').first()).toBeVisible({ timeout: 30_000 });
  const found: string[] = [];
  const shot = async (name: string) =>
    test.info().attach(`${name}.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  const LIST = [
    '.watch-head h2',
    '.watch-search',
    '.watch-sorts',
    '.watch-who-pick',
    '.watch-again button',
    '.watch-scroll',
    '.watch-close',
  ];
  const CARD = [
    '.watch-back',
    '.watch-follow',
    '.watch-card-name',
    '.watch-card-body',
    '.watch-card-foot button',
  ];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    await page.waitForTimeout(100);
    // The list: its top, rows and Close apart; the first row's Watch in view.
    await expect(page.locator('.watch-row').first()).toBeVisible();
    for (const f of await panelParts(page, LIST)) {
      found.push(`${s.name}, the list: ${f}`);
    }
    if (!(await inView(page, '.watch-row .watch-go'))) {
      found.push(`${s.name}, the list: the first row’s Watch is out of view`);
    }
    if (!(await inView(page, '.watch-close'))) {
      found.push(`${s.name}, the list: Close is out of view`);
    }
    await shot(`${s.name}, the list`);
    // The card about the first: its top, sections and foot apart; Watch in view.
    await page.getByRole('button', { name: `About ${LONG}` }).click();
    await expect(page.locator('.watch-card section[aria-label="Where"]')).toBeVisible();
    for (const f of await panelParts(page, CARD)) {
      found.push(`${s.name}, the card: ${f}`);
    }
    if (!(await inView(page, '.watch-card-foot .watch-go'))) {
      found.push(`${s.name}, the card: Watch is out of view`);
    }
    await shot(`${s.name}, the card`);
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(found).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea laid out on phones held either way and on the browser
// tests' screen, in the offline sandbox: with the barometer and the world
// clock out of the case, the autopilot's control head open and the boat in
// Port Royal's harbour, no part of the screen covers another, or the boat
// as drawn with a margin about it, and every part is on the screen. One
// page, its viewport changed screen by screen.
//
// Held upright, the chase camera puts the boat's masthead within a sixth
// of the screen's height of its top, where no case of instruments fits
// above it: there the case's face alone may stand over the masthead. Its
// complications, hanging under the compass, may not.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

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
    // Every complication out, the head open, after the screen's new size.
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.settings({ barometer: true, worldClock: true, pilotHead: true });
      k.render();
    });
    await page.waitForTimeout(400);
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

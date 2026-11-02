// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea laid out on phones held either way and on the browser
// tests' screen, in the offline sandbox: with the barometer out of the
// case, the autopilot's control head open, the right-of-way overlay on (so
// the case's last line has its place), the readouts at their longest and
// the boat in Port Royal's harbour, no part of the screen covers
// another, or the boat as drawn with a margin about it, and every part is
// on the screen. One page, its viewport changed screen by screen, with
// less motion asked for, so that nothing is measured mid-slide.
//
// The case is one size whatever its readouts say. Held sideways it is no
// taller than its compass card, its pushers standing on two edges; held
// upright both stand out of its bottom edge beneath the readouts, and an
// open barometer stays open. The pocket chart's caption
// is two lines within its frame, the weather's pusher set in the frame.
// The menu, open, stands over everything and within the screen.
//
// Held upright, the chase camera puts the boat's masthead within a sixth
// of the screen's height of its top, where no case of instruments fits
// above it: there the case's face and its pushers alone may stand over the
// masthead. Its complications, hanging under the compass, may not.
//
// The chart's strip and its weather's case are one row each on every
// screen, the countdown beside or under the strip, and the layers' sheet
// and the key, open, stand on the case within the screen, covering
// neither it nor the strip.
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
  { name: 'small Android phone upright', width: 360, height: 640, upright: true },
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
async function parts(page: Page): Promise<{
  parts: Box[];
  boat: Box | null;
  out: string[];
  spilt: string[];
  words: string[];
  helm: Box | null;
  head: Box | null;
}> {
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
    // The pushers apart from what they are set in: a box about both would
    // take in the corner beside them.
    const pushers = [...hud.querySelectorAll('.case [data-pusher], .pocket [data-pusher]')].map(
      (p) => box(`the ${p.getAttribute('data-pusher')} pusher`, [p]),
    );
    const all = [
      one('the case', '.case-top'),
      one('the barometer', '[data-complication=barometer]'),
      one('the pocket chart', '.pocket-frame'),
      ...pushers,
      one('the menu button', '.menu-button'),
      one('the helm', '[data-control=helm]'),
      one('the sheet', '[data-control=sheet]'),
      one('the autopilot', '.pilot-head'),
      one('the autopilot button', '.pilot-button'),
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
    // A part's own keys stay within it; a pusher's stem stands out of the
    // edge it is set in, and no other.
    const spilt = [...hud.querySelectorAll('.pilot-head button, .case button, .pocket button')]
      .filter((k) => {
        const r = k.getBoundingClientRect();
        const p = (
          k.closest('.pilot-head') ??
          k.closest('.case-top') ??
          k.closest('.pocket-frame') ??
          k
        ).getBoundingClientRect();
        const edge = k.getAttribute('data-edge');
        const out = (e: string) => (edge === e ? 6.5 : 0.5);
        return (
          r.left < p.left - out('left') ||
          r.right > p.right + out('right') ||
          r.top < p.top - 0.5 ||
          r.bottom > p.bottom + out('bottom')
        );
      })
      .map((k) => k.getAttribute('aria-label') ?? k.textContent ?? '');
    const out = [...hud.querySelectorAll('.complication:not([hidden])')].map(
      (e) => e.getAttribute('data-complication') ?? '',
    );
    // No words show outside their part: each run of text as it is drawn,
    // clipped by whatever clips it, within the part it is in.
    const PARTS = '.case-top, .complications, .pocket-frame, .pilot-head, .pilot-button, .control';
    const words: string[] = [];
    const walker = document.createTreeWalker(hud, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      const el = t.parentElement;
      const part = el?.closest(PARTS);
      if (el === null || part == null || (t.textContent ?? '').trim() === '') {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        continue;
      }
      let [left, right, top, bottom] = [r.left, r.right, r.top, r.bottom];
      for (let a: Element | null = el; a !== null && a !== part; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
          const c = a.getBoundingClientRect();
          [left, right, top, bottom] = [
            Math.max(left, c.left),
            Math.min(right, c.right),
            Math.max(top, c.top),
            Math.min(bottom, c.bottom),
          ];
        }
      }
      const p = part.getBoundingClientRect();
      if (
        right > left &&
        bottom > top &&
        (left < p.left - 0.5 ||
          right > p.right + 0.5 ||
          top < p.top - 0.5 ||
          bottom > p.bottom + 0.5)
      ) {
        words.push(`“${(t.textContent ?? '').trim()}” runs out of ${part.className}`);
      }
    }
    const helm = one('the helm', '[data-control=helm]');
    const head = one('the control head', '.pilot-head');
    return { parts: all, boat, out, spilt, words, helm, head };
  }, ABOUT_BOAT);
}

/**
 * Whether the pocket chart's caption fits at its longest: the farthest the
 * edge can be said and the longest time to a new world, each a line in the
 * caption's own type, within the chart. Laid out by the page, out of the
 * caption's flow: a canvas may measure in another face than the page's.
 */
async function longestCaption(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const caption = document.querySelector('.pocket-caption');
    const line = document.querySelector('.pocket-line.pocket-left');
    if (caption === null || line === null) {
      return ['no pocket chart'];
    }
    const room = caption.clientWidth;
    const width = (t: string) => {
      const probe = line.cloneNode() as HTMLElement;
      probe.textContent = t;
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.maxWidth = 'none';
      caption.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    return ['edge 99.9 NM', 'new world 6d 23h']
      .map((t) => ({ t, w: width(t) }))
      .filter(({ w }) => w > room + 0.5)
      .map(({ t, w }) => `“${t}” is ${w.toFixed(1)} px in a caption ${room} px wide`);
  });
}

/** What is wrong with the case: its size as its readouts change, its height, its pushers. */
async function caseFaults(page: Page, upright: boolean): Promise<string[]> {
  const size = (at: 'shortest' | 'longest') =>
    page.evaluate(async (at) => {
      globalThis.keel.readouts(at);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.querySelector('.case-top')?.getBoundingClientRect();
      return r === undefined ? null : [r.left, r.top, r.width, r.height];
    }, at);
  const found: string[] = [];
  const short = await size('shortest');
  const long = await size('longest');
  if (
    short === null ||
    long === null ||
    short.some((v, i) => Math.abs(v - (long[i] ?? 0)) > 0.01)
  ) {
    found.push(
      `the case is ${short?.join(' ')} at its shortest, ${long?.join(' ')} at its longest`,
    );
  }
  found.push(
    ...(await page.evaluate((upright) => {
      const out: string[] = [];
      const face = document.querySelector('.case-face');
      const card = document.querySelector('.case .compass');
      if (face === null || card === null) {
        return ['no case'];
      }
      const st = getComputedStyle(face);
      const tall =
        card.getBoundingClientRect().height +
        parseFloat(st.paddingTop) +
        parseFloat(st.paddingBottom);
      const h = face.getBoundingClientRect().height;
      // Held upright the pushers beneath the readouts make it taller.
      if (upright ? h < tall - 0.5 : Math.abs(h - tall) > 0.5) {
        out.push(`the case's face is ${h} px tall, its compass card and padding ${tall}`);
      }
      const edges = [...document.querySelectorAll('.case [data-pusher]')].map(
        (p) => `${p.getAttribute('data-pusher')} ${p.getAttribute('data-edge')}`,
      );
      if (edges.join(', ') !== `barometer ${upright ? 'bottom' : 'right'}, board bottom`) {
        out.push(`the case's pushers: ${edges.join(', ')}`);
      }
      if (document.querySelector('[data-complication=barometer]:not([hidden])') === null) {
        out.push('the barometer folded back into the case');
      }
      if (upright) {
        const words = Math.max(
          ...[...document.querySelectorAll('.case .readouts .slot')].map(
            (w) => w.getBoundingClientRect().bottom,
          ),
        );
        const faces = [...document.querySelectorAll('.case .pusher-face')].map((f) =>
          f.getBoundingClientRect(),
        );
        if (faces.length === 0 || faces.some((f) => f.top < words - 0.5)) {
          out.push('the case’s pushers are not beneath its readouts');
        }
      }
      if (
        document.querySelector('[data-complication=clock], [data-pusher=clock], .world-clock') !==
        null
      ) {
        out.push('a world clock in the case');
      }
      const lines = [...document.querySelectorAll('.pocket-line')].map((l) => l.textContent ?? '');
      if (
        lines.length !== 2 ||
        !/^edge /.test(lines[0] ?? '') ||
        !/^new world /.test(lines[1] ?? '')
      ) {
        out.push(`the pocket chart's caption: ${lines.join(' / ')}`);
      }
      if ((document.querySelector('.pocket-frame')?.textContent ?? '').includes('Chart')) {
        out.push('the pocket chart says “Chart”');
      }
      const frame = document.querySelector('.pocket-frame')?.getBoundingClientRect();
      const f = document.querySelector('.pocket-weather .pusher-face')?.getBoundingClientRect();
      if (
        frame === undefined ||
        f === undefined ||
        f.left < frame.left - 0.5 ||
        f.right > frame.right + 0.5 ||
        f.top < frame.top - 0.5 ||
        f.bottom > frame.bottom + 0.5
      ) {
        out.push('the weather pusher’s face is not in the pocket chart’s frame');
      }
      const caption = document.querySelector('.pocket-caption')?.getBoundingClientRect();
      if (
        caption !== undefined &&
        f !== undefined &&
        Math.min(caption.right, f.right) - Math.max(caption.left, f.left) > 0.5 &&
        Math.min(caption.bottom, f.bottom) - Math.max(caption.top, f.top) > 0.5
      ) {
        out.push('the weather pusher’s face covers the pocket chart’s caption');
      }
      return out;
    }, upright)),
  );
  return found;
}

/** What is wrong with the harbour board, open: any of its frame off the screen. */
async function boardFaults(page: Page): Promise<string[]> {
  await page.locator('[data-pusher=board]').click();
  await expect(page.locator('.board')).toBeVisible();
  const r = await page.evaluate(() => {
    const b = document.querySelector('.board')?.getBoundingClientRect();
    return b === undefined ? null : { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  });
  await page.locator('.board').getByRole('button', { name: 'Close', exact: true }).click();
  const v = page.viewportSize();
  if (r === null || v === null) {
    return ['no harbour board'];
  }
  return r.left < -0.5 || r.top < -0.5 || r.right > v.width + 0.5 || r.bottom > v.height + 0.5
    ? [`the harbour board is off the screen (${edges({ name: '', ...r })})`]
    : [];
}

/** What is wrong with the menu, open: off the screen, under anything, its close out of reach. */
async function menuFaults(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.menu')).toBeVisible();
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const menu = document.querySelector('.menu');
    const x = document.querySelector('.menu-x');
    if (menu === null || x === null) {
      return ['no menu'];
    }
    const inView = (r: DOMRect) =>
      r.left >= -0.5 &&
      r.top >= -0.5 &&
      r.right <= innerWidth + 0.5 &&
      r.bottom <= innerHeight + 0.5;
    const m = menu.getBoundingClientRect();
    if (!inView(m)) {
      out.push(
        `the menu is off the screen (${[m.left, m.top, m.right, m.bottom].map(Math.round)})`,
      );
    }
    if (!inView(x.getBoundingClientRect())) {
      out.push('the menu’s close is off the screen');
    }
    if (document.activeElement !== menu) {
      out.push(
        `the menu does not have the focus: ${document.activeElement?.tagName}.${document.activeElement?.className}`,
      );
    }
    // Nothing over it: at its corners, its middle and its head's close.
    const xr = x.getBoundingClientRect();
    // Inside its rounded corners.
    for (const [px, py] of [
      [m.left + 8, m.top + 8],
      [m.right - 8, m.top + 8],
      [m.left + 8, m.bottom - 8],
      [m.right - 8, m.bottom - 8],
      [(m.left + m.right) / 2, (m.top + m.bottom) / 2],
      [(xr.left + xr.right) / 2, (xr.top + xr.bottom) / 2],
    ] as const) {
      const e = document.elementFromPoint(px, py);
      if (e === null || !menu.contains(e)) {
        out.push(
          `at ${Math.round(px)}, ${Math.round(py)} the menu is under ${e?.className ?? 'nothing'}`,
        );
      }
    }
    return out;
  });
  // Its close at the top shuts it, and the focus goes back to its button.
  await page.locator('.menu-x').click();
  await expect(page.locator('.menu')).toHaveCount(0);
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('menu-button')))) {
    found.push('the focus is not back on the menu’s button');
  }
  return found;
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
      // In the world's last days.
      k.setWorldEnd({
        epoch: now - 5 * 86_400_000,
        ends: now + 2 * 86_400_000,
        closing: now - 86_400_000,
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
      k.settings({ barometer: true, pilotHead: true, rightOfWay: true });
      k.render();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => globalThis.keel.render());
    for (const f of await caseFaults(page, s.upright)) {
      found.push(`${s.name}: ${f}`);
    }
    // Measured at the longest the readouts say.
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
    for (const w of [...seen.words, ...(await longestCaption(page))]) {
      found.push(`${s.name}: ${w}`);
    }
    // The helm the head's height: held sideways their tops level, held
    // upright the head standing on the helm, 8 pixels above it.
    if (seen.helm === null || seen.head === null) {
      found.push(`${s.name}: no helm or no control head`);
    } else if (
      s.upright
        ? Math.abs(seen.head.bottom + 8 - seen.helm.top) > 0.5
        : Math.abs(seen.head.top - seen.helm.top) > 0.5
    ) {
      found.push(
        `${s.name}: the helm’s top at ${seen.helm.top}, the head’s ${s.upright ? 'foot' : 'top'} at ${s.upright ? seen.head.bottom : seen.head.top}`,
      );
    } else if (
      Math.abs(seen.helm.bottom - seen.helm.top - (seen.head.bottom - seen.head.top)) > 0.5
    ) {
      found.push(`${s.name}: the helm is not the head’s height`);
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
        const names = [a?.name, b?.name];
        const inCase = (n?: string) =>
          n === 'the case' || n === 'the barometer pusher' || n === 'the board pusher';
        const masthead = s.upright && names.some(inCase) && names.includes('the boat');
        // A pusher is set in its own part.
        const own =
          (names.includes('the case') && names.filter(inCase).length === 2) ||
          (names.includes('the pocket chart') && names.includes('the weather pusher'));
        if (a !== undefined && b !== undefined && !masthead && !own && overlap(a, b)) {
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
              .filter(
                (p) =>
                  !(
                    s.upright &&
                    ['the case', 'the barometer pusher', 'the board pusher'].includes(p.name)
                  ),
              )
              .map((p) => room(p, seen.boat as Box)),
          );
    test.info().annotations.push({
      type: s.name,
      description: `out of the case: ${seen.out.join(', ') || 'nothing'}; room about the boat’s margin: ${clear === null ? '–' : Math.round(clear)} px; the helm’s top ${seen.helm?.top ?? '–'}, the head’s ${seen.head?.top ?? '–'} to ${seen.head?.bottom ?? '–'}`,
    });
    // Folded, the head leaves the helm as it was.
    const folded = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.settings({ pilotHead: false });
      k.render();
      await new Promise((r) => setTimeout(r, 100));
      const r = document.querySelector('[data-control=helm]')?.getBoundingClientRect();
      k.settings({ pilotHead: true });
      k.render();
      return r === undefined ? null : { top: r.top, bottom: r.bottom };
    });
    if (
      seen.helm !== null &&
      (folded === null ||
        Math.abs(folded.top - seen.helm.top) > 0.5 ||
        Math.abs(folded.bottom - seen.helm.bottom) > 0.5)
    ) {
      found.push(`${s.name}: the helm moves as the head folds`);
    }
    for (const f of await menuFaults(page)) {
      found.push(`${s.name}: ${f}`);
    }
    for (const f of await boardFaults(page)) {
      found.push(`${s.name}: ${f}`);
    }
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

/** The chart's controls' boxes: its strip, its countdown, the weather's case and what is open on it. */
async function chartParts(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const parts: [string, string][] = [
      ['the strip', '.chart-strip'],
      ['the countdown', '.chart-falls'],
      ['the weather’s case', '.chart-time'],
      ['the layers', '.chart-layers'],
      ['the key', '.chart-key'],
    ];
    return parts.flatMap(([name, sel]) => {
      const e = document.querySelector(sel);
      if (e === null) {
        return [];
      }
      const r = e.getBoundingClientRect();
      return [{ name, left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
    });
  });
}

/** The tallest the chart's strip and its weather's case may be, px: a row of keys in a frame. */
const STRIP = 48;
const TIME_CASE = 56;

test('the chart’s strip and its weather’s case are one row each on every screen, and what opens on them stays on it', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the controls are the same on either back end');
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const now = Date.now();
  await page.evaluate(
    ({ now }) => {
      const k = globalThis.keel;
      // In the world's last days, its countdown at the chart's rim.
      k.setWorldEnd({
        epoch: now - 5 * 86_400_000,
        ends: now + 2 * 86_400_000,
        closing: now - 86_400_000,
      });
      k.issueForecast();
      k.openChart('chart');
      k.fitChart();
      k.render();
    },
    { now },
  );
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    for (const open of ['', 'Layers', 'Key']) {
      const button = page.getByRole('button', { name: open, exact: true });
      if (open !== '') {
        await button.click();
      }
      const parts = await chartParts(page);
      for (const p of parts) {
        if (p.left < -0.5 || p.top < -0.5 || p.right > s.width + 0.5 || p.bottom > s.height + 0.5) {
          found.push(
            `${s.name}, ${open || 'nothing'} open: ${p.name} is off the screen at ${edges(p)}`,
          );
        }
      }
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const [a, b] = [parts[i] as Box, parts[j] as Box];
          if (overlap(a, b)) {
            found.push(`${s.name}, ${open || 'nothing'} open: ${a.name} covers ${b.name}`);
          }
        }
      }
      const tall = (name: string, most: number) => {
        const p = parts.find((x) => x.name === name);
        if (p === undefined) {
          found.push(`${s.name}: no ${name}`);
        } else if (p.bottom - p.top > most) {
          found.push(`${s.name}: ${name} is ${Math.round(p.bottom - p.top)} px tall`);
        }
      };
      tall('the strip', STRIP);
      tall('the weather’s case', TIME_CASE);
      if (open !== '') {
        await button.click();
      }
    }
  }
  expect(found).toEqual([]);
});

test('the list of sailors to watch and the card fit every screen, Watch in view', async ({
  context,
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(150_000);
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
    // The card about the first: its top, sections and foot apart; Watch in view.
    await page.getByRole('button', { name: `About ${LONG}` }).click();
    await expect(page.locator('.watch-card section[aria-label="Where"]')).toBeVisible();
    for (const f of await panelParts(page, CARD)) {
      found.push(`${s.name}, the card: ${f}`);
    }
    if (!(await inView(page, '.watch-card-foot .watch-go'))) {
      found.push(`${s.name}, the card: Watch is out of view`);
    }
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(found).toEqual([]);
});

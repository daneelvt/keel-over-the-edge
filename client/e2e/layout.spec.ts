// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea laid out on phones held either way and on the browser
// tests' screen, in the offline sandbox: with the barometer and the ship's
// clock out of the case, the autopilot's control head open, the key that brings the full
// screen back shown, the right-of-way overlay on (so
// the case's last line has its place), the readouts at their longest and
// the boat in Port Royal's harbour, no part of the screen covers
// another, or the boat as drawn with a margin about it, and every part is
// on the screen. One page, its viewport changed screen by screen, with
// less motion asked for, so that nothing is measured mid-slide.
//
// The case is one size whatever its readouts say. Held sideways it is no
// taller than its compass card, its pushers standing on three edges; held
// upright the barometer's and the board's stand out of its bottom edge
// beneath the readouts and the clock's out of its top edge over the
// speed's empty end, and the open barometer and clock stay open, their
// column clear of the boat. No pusher stands over the compass card, the
// readouts' words or another pusher, nor off the screen. The pocket chart's caption
// is two lines within its frame, the weather's pusher set in the frame.
// The menu, open, stands over everything and within the screen. The
// sheet's legend at its longest, the sail luffing or stalled, stands
// within the sheet's frame, clear of its ends, the end lit with its arrow
// within it too. The Reef key and, a reef asked for, the key that shakes
// it out stand on the sheet's top, 44 pixels or more, covering nothing.
// The keelboat, larger, is framed as the Jolly boat is: on every screen
// the parts stand clear of it too.
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
// The chart screen's Log tab, the strip still one row with its four tabs,
// where the boat is and the way back to sea, holds a sailor's log on its
// paper within the screen under the strip: a long log's days and
// collection (three kinds a row upright, five sideways), who may read it,
// another sailor's, a machine sailor's, an empty one and one not there;
// its keys the head keys' size, its day rows and kinds a 44 px touch, no
// words under 13 px, nothing wider than the sheet.
//
// The chart screen's News tab, its dot over the tab's corner with the
// strip no wider, holds the day's edition on its paper under the strip: a
// full day's (the figures, six stories at their longest, the reader's own
// box and the world's notice), a new world's first (its arrival and the
// last world in review), a quiet day's and an earlier one's; its masthead
// on one line, every story a 44 px touch, its keys the head keys' size, no
// words under 13 px, nothing wider than the sheet; and a full day's front
// page, to the sixth story, within about one and a half screens upright.
//
// The menu's button heads a column of keys under the pocket chart, Back
// to the boat, the clear view's and the full screen's, 8 pixels apart; on
// a screen 420 pixels tall or less they run left from it in a row. The
// barometer and the clock, tapped, grow within the screen, one at a time,
// and shrink on a second tap.
// The clear view leaves its own key and Back to the boat where they stood,
// and nothing else. Watching a boat (the sandbox's screen as it is then),
// the plate is one row at the foot of the screen, covering nothing, and
// the case stays where it is when sailing.
//
// Then the list of sailors to watch and the card about one, on the start
// screen, at the same screens: full rows and a full card, the server's
// answers stood in for, with a twenty-letter name. Watch is in view, no
// part covers another, and every button is 44 pixels or more.
//
// In port the board opens the player's boat's look and the fleet's boats
// in its place, on the screen, Save, Cancel and a boat in view. On the
// start screen the player's own panel, with their boat at its longest
// name, keeps Set sail in view on every screen, and the boat's look and
// the fleet's boats keep Save, Cancel, every swatch and the first boat in
// view, the server's answers stood in for.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { GAME, openScene, sailor } from './helpers';
import { emptyLog, LONG_NAME, longLog, standInLogs } from './logs';
import { firstEdition, fullDay, quietDay, standInNews } from './news';

/** The screens: phones in CSS pixels, upright and sideways, and the tests' own. */
const SCREENS = [
  { name: 'iPhone SE upright', width: 375, height: 667, upright: true },
  { name: 'small Android phone upright', width: 360, height: 640, upright: true },
  // The same phone with the whole screen: no address bar, status bar or navigation bar.
  { name: 'small Android phone full screen upright', width: 360, height: 780, upright: true },
  { name: 'iPhone 16 upright', width: 393, height: 852, upright: true },
  { name: 'iPhone 16 sideways', width: 852, height: 393, upright: false },
  { name: 'small Android phone sideways', width: 640, height: 360, upright: false },
  { name: 'small Android phone full screen sideways', width: 780, height: 360, upright: false },
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
  /** Each of the boat's drawn parts' boxes, with the room kept about the boat. */
  drawn: Box[];
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
      one('the clock', '[data-complication=clock]'),
      one('the pocket chart', '.pocket-frame'),
      ...pushers,
      one('the menu button', '.menu-button'),
      one('Back to the boat', '.back-key'),
      one('the clear view’s key', '.clear-key'),
      one('the full screen key', '.fullscreen-key'),
      one('the helm', '[data-control=helm]'),
      one('the sheet', '[data-control=sheet]'),
      one('the Reef key', '.reef-key:not(.shake)'),
      one('the shake out key', '.reef-key.shake'),
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
    const drawn = b.map((r) => ({
      name: 'the boat',
      left: r.left - about,
      top: r.top - about,
      right: r.right + about,
      bottom: r.bottom + about,
    }));
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
          r.top < p.top - out('top') ||
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
    return { parts: all, boat, drawn, out, spilt, words, helm, head };
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
      const want = upright
        ? 'clock top, barometer bottom, board bottom'
        : 'clock top, barometer right, board bottom';
      if (edges.join(', ') !== want) {
        out.push(`the case's pushers: ${edges.join(', ')}`);
      }
      for (const c of ['barometer', 'clock']) {
        if (document.querySelector(`[data-complication=${c}]:not([hidden])`) === null) {
          out.push(`the ${c} folded back into the case`);
        }
      }
      if (upright) {
        const words = Math.max(
          ...[...document.querySelectorAll('.case .readouts .slot')].map(
            (w) => w.getBoundingClientRect().bottom,
          ),
        );
        const faces = [...document.querySelectorAll('.case .case-pushers .pusher-face')].map((f) =>
          f.getBoundingClientRect(),
        );
        if (faces.length === 0 || faces.some((f) => f.top < words - 0.5)) {
          out.push('the case’s pushers are not beneath its readouts');
        }
      }
      // The world's countdown is the pocket chart's, not the case's.
      if (document.querySelector('.case .world-clock') !== null) {
        out.push('the world’s countdown in the case');
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

/**
 * What is wrong with the sheet's legend as the sail luffs, stalls or is
 * aback (its legend then aback): its words out of the frame, or over the
 * ends.
 */
async function sheetFaults(page: Page, aback = 'Aback', kite = ''): Promise<string[]> {
  const found: string[] = [];
  for (const [state, legend, lit] of [
    ['luffing', `${kite}Luffing`, 'trim'],
    ['stalled', `${kite}Stalled`, 'ease'],
    ['aback', aback, null],
  ] as const) {
    found.push(
      ...(await page.evaluate(
        async ({ state, legend, lit, kite }) => {
          globalThis.keel.sail(state, kite !== '');
          globalThis.keel.render();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const out: string[] = [];
          const sheet = document.querySelector('[data-control=sheet]');
          const label = sheet?.querySelector('.control-label');
          if (sheet === null || sheet === undefined || label === null || label === undefined) {
            return [`${state}: no sheet`];
          }
          if (label.textContent !== legend) {
            out.push(`${state}: the sheet’s legend says “${label.textContent}”`);
          }
          // Within the frame's border, by the words as they are drawn.
          const s = sheet.getBoundingClientRect();
          const st = getComputedStyle(sheet);
          const inner = {
            left: s.left + parseFloat(st.borderLeftWidth),
            right: s.right - parseFloat(st.borderRightWidth),
            top: s.top + parseFloat(st.borderTopWidth),
            bottom: s.bottom - parseFloat(st.borderBottomWidth),
          };
          const drawn = (e: Element) => {
            const range = document.createRange();
            range.selectNodeContents(e);
            return range.getBoundingClientRect();
          };
          const within = (r: DOMRect) =>
            r.left >= inner.left - 0.5 &&
            r.right <= inner.right + 0.5 &&
            r.top >= inner.top - 0.5 &&
            r.bottom <= inner.bottom + 0.5;
          const words = drawn(label);
          if (!within(words)) {
            out.push(
              `${state}: “${legend}” runs out of the sheet (${[words.left, words.right].map(Math.round)} in ${[inner.left, inner.right].map(Math.round)})`,
            );
          }
          for (const end of sheet.querySelectorAll('.sheet-end')) {
            const e = drawn(end);
            const name = end.getAttribute('data-end');
            if (
              Math.min(e.right, words.right) - Math.max(e.left, words.left) > 0.5 &&
              Math.min(e.bottom, words.bottom) - Math.max(e.top, words.top) > 0.5
            ) {
              out.push(`${state}: “${legend}” covers ${name}`);
            }
            if (!within(e)) {
              out.push(`${state}: ${name} runs out of the sheet`);
            }
            const on = end.classList.contains('lit');
            if (on !== (name === lit)) {
              out.push(`${state}: ${name} is ${on ? '' : 'not '}lit`);
            }
            if (on && end.querySelector('.sheet-arrow') === null) {
              out.push(`${state}: ${name} is lit without its arrow`);
            }
          }
          const valuetext = sheet.getAttribute('aria-valuetext') ?? '';
          if (!valuetext.includes(state)) {
            out.push(`${state}: the sheet’s value says “${valuetext}”`);
          }
          return out;
        },
        { state, legend, lit, kite },
      )),
    );
  }
  // What the sail says no more; the readouts as they were held.
  await page.evaluate(async () => {
    globalThis.keel.sail('');
    globalThis.keel.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  return found;
}

/**
 * What is wrong with the harbour board, open, and with what it opens of
 * the player's boat in port, each in the board's place: any of its frame
 * off the screen; for the boat's look and the fleet's boats, Save, Cancel
 * or the first boat out of view.
 */
async function boardFaults(page: Page): Promise<string[]> {
  await page.locator('[data-pusher=board]').click();
  await expect(page.locator('.board')).toBeVisible();
  const board = page.locator('.board');
  const found: string[] = [];
  const faults = async (what: string, keys: string[]) => {
    const r = await page.evaluate((keys) => {
      const el = document.querySelector('.board');
      const b = el?.getBoundingClientRect();
      if (el === null || el === undefined || b === undefined) {
        return null;
      }
      const out: string[] = [];
      for (const k of keys) {
        const key = [...el.querySelectorAll<HTMLElement>(`button, .change-boat-choice`)].find(
          (e) =>
            e.textContent?.trim() === k || (k === 'a boat' && e.matches('.change-boat-choice')),
        );
        const r = key?.getBoundingClientRect();
        if (
          r === undefined ||
          r.top < Math.max(b.top, 0) - 0.5 ||
          r.bottom > Math.min(b.bottom, innerHeight) + 0.5
        ) {
          out.push(`${k} is out of view`);
        }
      }
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, out };
    }, keys);
    const v = page.viewportSize();
    if (r === null || v === null) {
      found.push(`no ${what}`);
      return;
    }
    if (r.left < -0.5 || r.top < -0.5 || r.right > v.width + 0.5 || r.bottom > v.height + 0.5) {
      found.push(`${what} is off the screen (${edges({ name: '', ...r })})`);
    }
    for (const o of r.out) {
      found.push(`${what}: ${o}`);
    }
  };
  await faults('the harbour board', []);
  await board.getByRole('button', { name: 'Your boat', exact: true }).click();
  await expect(page.locator('.board.boat-look')).toBeVisible();
  await faults('the boat’s look', ['Save', 'Cancel']);
  await board.getByRole('button', { name: 'Cancel', exact: true }).click();
  await board.getByRole('button', { name: 'Change boat', exact: true }).click();
  await expect(page.locator('.board.change-boat')).toBeVisible();
  await faults('the fleet’s boats', ['a boat', 'Cancel']);
  await board.getByRole('button', { name: 'Cancel', exact: true }).click();
  await board.getByRole('button', { name: 'Close', exact: true }).click();
  return found;
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

/** The keys under the pocket chart: a column headed by the menu's button, or a row run left from it on a short screen. */
async function keyFaults(page: Page, short: boolean): Promise<string[]> {
  return page.evaluate((short) => {
    const out: string[] = [];
    const keys = ['.menu-button', '.back-key', '.clear-key', '.fullscreen-key'].map((sel) =>
      document.querySelector(sel)?.getBoundingClientRect(),
    );
    const pocket = document.querySelector('.pocket-frame')?.getBoundingClientRect();
    if (keys.some((k) => k === undefined) || pocket === undefined) {
      return ['a key or the pocket chart is missing'];
    }
    const [menu] = keys as DOMRect[];
    for (const k of keys as DOMRect[]) {
      if (Math.abs(k.width - 44) > 0.5 || Math.abs(k.height - 44) > 0.5) {
        out.push(`a key is ${k.width} × ${k.height}`);
      }
    }
    // The pocket's pusher may hang below its frame, held upright.
    const foot = Math.max(
      pocket.bottom,
      document.querySelector('.pocket')?.getBoundingClientRect().bottom ?? 0,
    );
    if (menu === undefined || Math.abs(menu.top - foot - 12) > 0.5) {
      out.push(`the menu’s button’s top at ${menu?.top}, the pocket chart’s foot at ${foot}`);
    }
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1] as DOMRect;
      const b = keys[i] as DOMRect;
      const ok = short
        ? Math.abs(a.left - b.right - 8) < 0.5 && Math.abs(a.top - b.top) < 0.5
        : Math.abs(b.top - a.bottom - 8) < 0.5 && Math.abs(a.right - b.right) < 0.5;
      if (!ok) {
        out.push(`key ${i + 1} is not ${short ? 'left of' : 'under'} key ${i}, 8 pixels apart`);
      }
    }
    return out;
  }, short);
}

/** The barometer tapped: within the screen, its dial its size; a second tap shrinks it, and so does Escape. */
async function bigBarometerFaults(page: Page): Promise<string[]> {
  const found: string[] = [];
  const baro = page.getByRole('button', { name: 'Barometer, larger' });
  await baro.click();
  await expect(baro).toHaveAttribute('aria-expanded', 'true');
  found.push(
    ...(await page.evaluate(() => {
      const out: string[] = [];
      const big = document.querySelector('.barometer.big')?.getBoundingClientRect();
      const dial = document.querySelector('.barometer.big svg')?.getBoundingClientRect();
      if (big === undefined || dial === undefined) {
        return ['the barometer did not grow'];
      }
      if (
        big.left < 11.5 ||
        big.top < 11.5 ||
        big.right > innerWidth - 11.5 ||
        big.bottom > innerHeight - 11.5
      ) {
        out.push(
          `the enlarged barometer is off the screen (${[big.left, big.top, big.right, big.bottom].map(Math.round)})`,
        );
      }
      const want = Math.min(240, Math.min(innerWidth, innerHeight) - 120);
      if (Math.abs(dial.width - want) > 0.5) {
        out.push(`the enlarged dial is ${dial.width} px across, not ${want}`);
      }
      const set = document.querySelector('[data-readout=barometer-set]')?.textContent ?? '';
      if (!/^\d{3,4} hPa a quarter of an hour ago$/.test(set)) {
        out.push(`the set hand’s words: “${set}”`);
      }
      // Under the menu: its scrim is above it.
      return out;
    })),
  );
  await baro.click();
  await expect(baro).toHaveAttribute('aria-expanded', 'false');
  await baro.click();
  await page.keyboard.press('Escape');
  await expect(baro).toHaveAttribute('aria-expanded', 'false');
  return found;
}

/**
 * The clock tapped: within the screen, its dial the barometer's size, its
 * words within it; the barometer tapped then shrinks it, one enlarged at
 * a time; a tap on the barometer again shrinks that.
 */
async function bigClockFaults(page: Page): Promise<string[]> {
  const found: string[] = [];
  const clock = page.getByRole('button', { name: 'World time, larger' });
  const baro = page.getByRole('button', { name: 'Barometer, larger' });
  await clock.click();
  await expect(clock).toHaveAttribute('aria-expanded', 'true');
  found.push(
    ...(await page.evaluate(() => {
      const out: string[] = [];
      const big = document.querySelector('.clock.big')?.getBoundingClientRect();
      const dial = document.querySelector('.clock.big svg')?.getBoundingClientRect();
      if (big === undefined || dial === undefined) {
        return ['the clock did not grow'];
      }
      if (
        big.left < 11.5 ||
        big.top < 11.5 ||
        big.right > innerWidth - 11.5 ||
        big.bottom > innerHeight - 11.5
      ) {
        out.push(
          `the enlarged clock is off the screen (${[big.left, big.top, big.right, big.bottom].map(Math.round)})`,
        );
      }
      const want = Math.min(240, Math.min(innerWidth, innerHeight) - 120);
      if (Math.abs(dial.width - want) > 0.5) {
        out.push(`the enlarged clock is ${dial.width} px across, not ${want}`);
      }
      const words = document.querySelector('[data-readout=clock]')?.textContent ?? '';
      const sun = document.querySelector('[data-readout=clock-sun]')?.textContent ?? '';
      if (!/^World time \d{1,2}:\d\d( [AP]M)?$/.test(words)) {
        out.push(`the clock’s words: “${words}”`);
      }
      if (!/^Sun(set|rise) in \d+ min$/.test(sun)) {
        out.push(`the clock’s sun: “${sun}”`);
      }
      for (const sel of ['[data-readout=clock]', '[data-readout=clock-sun]']) {
        const e = document.querySelector(sel);
        if (e === null) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(e);
        const r = range.getBoundingClientRect();
        if (
          r.left < big.left - 0.5 ||
          r.right > big.right + 0.5 ||
          r.top < big.top - 0.5 ||
          r.bottom > big.bottom + 0.5
        ) {
          out.push(`“${e.textContent}” runs out of the enlarged clock`);
        }
      }
      return out;
    })),
  );
  // One at a time: the barometer enlarged shrinks the clock.
  await baro.click();
  await expect(baro).toHaveAttribute('aria-expanded', 'true');
  await expect(clock).toHaveAttribute('aria-expanded', 'false');
  if ((await page.locator('.dial.big').count()) !== 1) {
    found.push('more than one dial enlarged');
  }
  await baro.click();
  await expect(baro).toHaveAttribute('aria-expanded', 'false');
  await clock.click();
  await page.keyboard.press('Escape');
  await expect(clock).toHaveAttribute('aria-expanded', 'false');
  return found;
}

/** The clear view: its key and Back to the boat where they stood, nothing else seen; and everything back. */
async function clearFaults(page: Page): Promise<string[]> {
  const keys = () =>
    page.evaluate(() =>
      ['.back-key', '.clear-key'].map((sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r === undefined ? null : [r.left, r.top];
      }),
    );
  const before = await keys();
  await page.getByRole('button', { name: 'Clear view' }).click();
  await expect(page.getByRole('button', { name: 'Show the instruments' })).toBeVisible();
  const found = await page.evaluate(() => {
    const hud = document.querySelector('.hud');
    if (hud === null) {
      return ['no screen at sea'];
    }
    // Every element seen, with a size, outside the two keys.
    return [...hud.querySelectorAll('*')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
          e.closest('.back-key, .clear-key') === null &&
          !e.matches('.hud-right, .sea-keys')
        );
      })
      .map((e) => `${e.tagName.toLowerCase()}.${e.className} is seen in the clear view`);
  });
  if (JSON.stringify(await keys()) !== JSON.stringify(before)) {
    found.push(
      `the keys moved as the screen cleared: ${JSON.stringify(before)} to ${JSON.stringify(await keys())}`,
    );
  }
  await page.getByRole('button', { name: 'Show the instruments' }).click();
  await expect(page.locator('.case-top')).toBeVisible();
  return found;
}

/**
 * Watching: the plate one row at the foot of the screen, over nothing, the
 * case where it is when sailing; another's boat, and the player's own
 * machine sailor's with its Come aboard.
 */
async function plateFaults(page: Page, boat: Box | null): Promise<string[]> {
  const found: string[] = [];
  for (const mine of [false, true]) {
    for (const f of await onePlateFaults(page, boat, mine)) {
      found.push(mine ? `the own machine sailor’s plate: ${f}` : f);
    }
  }
  return found;
}

async function onePlateFaults(page: Page, boat: Box | null, mine: boolean): Promise<string[]> {
  const caseTop = () =>
    page.evaluate(() => document.querySelector('.case-top')?.getBoundingClientRect().top ?? null);
  const sailing = await caseTop();
  await page.evaluate(({ name, mine }) => globalThis.keel.watchPlate(name, true, false, mine), {
    name: LONG,
    mine,
  });
  const plate = page.locator('.watch-plate');
  if (mine) {
    await expect(plate.getByRole('button', { name: /^Come aboard/ })).toBeVisible();
  }
  await expect(plate).toBeVisible();
  await expect(plate).toHaveAttribute('aria-label', `Watching ${LONG}`);
  await page.evaluate(() => globalThis.keel.render());
  const found = await page.evaluate(
    ({ boat, sailing }) => {
      const out: string[] = [];
      const p = document.querySelector('.watch-plate')?.getBoundingClientRect();
      if (p === undefined) {
        return ['no plate'];
      }
      if (p.height > 56) {
        out.push(`the plate is ${p.height} px tall: more than a row`);
      }
      if (
        Math.abs(innerHeight - 12 - p.bottom) > 0.5 ||
        p.left < 11.5 ||
        p.right > innerWidth - 11.5
      ) {
        out.push(
          `the plate is not at the foot of the screen (${[p.left, p.top, p.right, p.bottom].map(Math.round)})`,
        );
      }
      // Centred, to a pixel.
      if (Math.abs((p.left + p.right) / 2 - innerWidth / 2) > 1) {
        out.push(`the plate is not centred (${Math.round(p.left)} to ${Math.round(p.right)})`);
      }
      const covers = (r: DOMRect | { left: number; top: number; right: number; bottom: number }) =>
        Math.min(p.right, r.right) - Math.max(p.left, r.left) > 0.5 &&
        Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top) > 0.5;
      for (const [name, sel] of [
        ['the pocket chart', '.pocket-frame'],
        ['the case', '.case-top'],
        ['the barometer', '[data-complication=barometer]'],
        ['the clock', '[data-complication=clock]'],
        ['the keys', '.sea-keys'],
      ]) {
        const r = document.querySelector(sel as string)?.getBoundingClientRect();
        if (r !== undefined && covers(r)) {
          out.push(`the plate covers ${name}`);
        }
      }
      if (boat !== null && covers(boat)) {
        out.push('the plate covers the boat');
      }
      const top = document.querySelector('.case-top')?.getBoundingClientRect().top ?? null;
      if (top !== sailing) {
        out.push(`the case’s top at ${top} watching, ${sailing} sailing`);
      }
      for (const b of document.querySelectorAll('.watch-plate button')) {
        const r = b.getBoundingClientRect();
        if (r.width < 43.5 || r.height < 43.5) {
          out.push(
            `“${(b as HTMLElement).innerText}” is ${Math.round(r.width)} × ${Math.round(r.height)}`,
          );
        }
        if (r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5 || r.right > p.right + 0.5) {
          out.push(`“${(b as HTMLElement).innerText}” spills out of the plate`);
        }
      }
      if (
        document.querySelector(
          '[data-control=helm], [data-control=sheet], .pilot-head, .pilot-button',
        ) !== null
      ) {
        out.push('a control that steers shows while watching');
      }
      return out;
    },
    { boat, sailing },
  );
  await page.evaluate(() => globalThis.keel.watchPlate(null));
  await expect(plate).toHaveCount(0);
  return found;
}

/** The Reef key and the key that shakes a reef out: 44 pixels or more, their words within them, on the sheet's top or beside it. */
async function reefFaults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sheet = document.querySelector('[data-control=sheet]')?.getBoundingClientRect();
    const keys = [...document.querySelectorAll('.reef-key')].map((k) => {
      const range = document.createRange();
      range.selectNodeContents(k);
      return {
        name: k.getAttribute('aria-label') ?? '',
        r: k.getBoundingClientRect(),
        words: range.getBoundingClientRect(),
      };
    });
    if (sheet === undefined || keys.length !== 2) {
      return [`${keys.length} reef keys, a reef asked for`];
    }
    for (const { name, r, words } of keys) {
      // Its words within its face, however long the boat's are.
      if (
        words.left < r.left - 0.5 ||
        words.right > r.right + 0.5 ||
        words.top < r.top - 0.5 ||
        words.bottom > r.bottom + 0.5
      ) {
        out.push(`“${name}”: its words run out of the key`);
      }
      if (r.width < 43.5 || r.height < 43.5) {
        out.push(`“${name}” is ${Math.round(r.width)} × ${Math.round(r.height)}`);
      }
      // Over the sheet's top, or beside it level with its top.
      if (r.bottom > sheet.top + 0.5 && r.right > sheet.left + 0.5) {
        out.push(`“${name}” stands over the sheet`);
      }
      if (r.top < sheet.top - 120 && r.bottom > sheet.top - 120 && r.right < sheet.left) {
        out.push(`“${name}” is not at the sheet's top`);
      }
    }
    return out;
  });
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

// The screens in two halves, upright and sideways, each its own test: all
// eight in one ran near the limit on a slow runner.
for (const upright of [true, false]) {
  const screens = SCREENS.filter((s) => s.upright === upright);
  const first = screens[0] ?? SCREENS[0];
  test(`no part of the screen at sea covers the boat or another part, with everything open, ${upright ? 'upright' : 'sideways'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: first.width, height: first.height });
    // Laid out as it rests: nothing caught sliding out.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScene(page, 'world=1', true);
    // In Port Royal's harbour, once the land about it is held.
    await expect
      .poll(() => page.evaluate(() => globalThis.keel.toHarbour()), { timeout: 30_000 })
      .toBe(true);
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
        // At rest, the sail sheeted in: the boat drawn the same every time.
        // A reef asked for, so the key that shakes it out shows too.
        k.setState({ sheetLimit: 0.05, boom: 0, surge: 0 });
        k.setControls(0, 0);
        k.setReef(1);
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
    await expect(page.locator('.board-pusher, [data-pusher=board]')).toBeVisible({
      timeout: 15_000,
    });
    const found: string[] = [];
    for (const s of screens) {
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
      // Every complication out, the head open, the full screen's key shown
      // (the menu, opened on the screen before, put it away).
      await page.evaluate(() => {
        const k = globalThis.keel;
        k.settings({ barometer: true, clock: true, pilotHead: true, rightOfWay: true });
        k.fullScreenKey(true);
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
            n === 'the case' ||
            n === 'the barometer pusher' ||
            n === 'the clock pusher' ||
            n === 'the board pusher';
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
                      [
                        'the case',
                        'the barometer pusher',
                        'the clock pusher',
                        'the board pusher',
                      ].includes(p.name)
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
      for (const f of await sheetFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await reefFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await menuFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await boardFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      // The menu, opened, put the full screen's key away.
      await page.evaluate(() => globalThis.keel.fullScreenKey(true));
      for (const f of await keyFaults(page, s.height <= 420)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await bigClockFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await bigBarometerFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await clearFaults(page)) {
        found.push(`${s.name}: ${f}`);
      }
      for (const f of await plateFaults(page, seen.boat)) {
        found.push(`${s.name}: ${f}`);
      }
      if (s.upright) {
        await test.info().attach(`${s.name} watching.png`, {
          body: await (async () => {
            await page.evaluate((name) => globalThis.keel.watchPlate(name), LONG);
            await expect(page.locator('.watch-plate')).toBeVisible();
            const shot = await page.screenshot();
            await page.evaluate(() => globalThis.keel.watchPlate(null));
            return shot;
          })(),
          contentType: 'image/png',
        });
      }
    }
    expect(found).toEqual([]);
  });
}

// The keelboat and the tall ship stand taller than the Jolly boat: the
// camera stands back and looks higher in proportion, so on every screen,
// and a desktop's, no part covers either, held upright save the case's
// face and pushers over its masthead, as the Jolly boat's. The tall ship's
// sheet is her braces, from Brace up to Square, its legend aback the
// longest: "Braces · Aback", within the sheet's frame. The skiff's
// gennaker set, the legend names it ("Gennaker · Stalled"), and the case's
// last line says what it does at its longest ("Gennaker coming in")
// within the case.
// Every boat but the first, whose screens the other tests hold, each a
// test of its own (a boat's five screens are about a minute on a slow
// runner): aback, the braces of square sails name themselves.
for (const { kind, braces, aback, kite } of data.boats.slice(1).map((kind) => {
  const { square, downwind } = kind.physics;
  const braces = square.squareForeArea + square.squareAfterArea > 0;
  const kite = downwind.downwindArea > 0 ? 'Gennaker · ' : '';
  return {
    kind,
    braces,
    kite,
    aback: braces ? `${kind.controls.sheet.name} · Aback` : `${kite}Aback`,
  };
})) {
  test(`the ${kind.name} is framed as the Jolly boat is, clear of every part, on every screen`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScene(page, `boat=${kind.id}`, true);
    const found: string[] = [];
    const id = kind.name;
    await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
    await page.evaluate(async (index) => {
      const k = globalThis.keel;
      await k.useBoat(index);
      k.setState({ sheetLimit: 0.05, boom: 0, jib: 0, surge: 0 });
      k.setControls(0, 0);
      k.setReef(1);
      k.advance(30);
      // Every boat at the heel the first two reach a second after setting
      // off, 7°: the skiff, slower to get her sailor out on the wire,
      // heels 11° by then, and her taller mast leans further.
      k.setState({ heel: 0.12, rollRate: 0 });
      k.render();
      k.camera('chase');
      k.render();
    }, data.boats.indexOf(kind));
    const screens = braces
      ? [...SCREENS, { name: 'a desktop', width: 1440, height: 900, upright: false }]
      : SCREENS;
    for (const s of screens) {
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.waitForFunction(
        ({ width, height }) =>
          innerWidth === width &&
          innerHeight === height &&
          Math.abs(globalThis.keel.world.stage.camera.aspect - width / height) < 1e-6,
        { width: s.width, height: s.height },
      );
      await page.evaluate(() => {
        const k = globalThis.keel;
        k.fullScreenKey(true);
        k.camera('chase');
        k.render();
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => globalThis.keel.render());
      const seen = await parts(page);
      if (seen.boat === null) {
        found.push(`${id}, ${s.name}: no boat drawn`);
        continue;
      }
      const boat = seen.boat;
      const inCase = (n: string) =>
        n === 'the case' ||
        n === 'the barometer pusher' ||
        n === 'the clock pusher' ||
        n === 'the board pusher';
      // Against each part drawn, not the box about them all: a wide boat's
      // box takes in empty corners beside a tall mast.
      for (const p of seen.parts) {
        const under = seen.drawn.find((d) => overlap(p, d));
        if (!(s.upright && inCase(p.name)) && under !== undefined) {
          found.push(
            `${id}, ${s.name}: ${p.name} covers the boat (${edges(p)} and ${edges(under)})`,
          );
        }
      }
      if (
        boat.left < -0.5 ||
        boat.top < -0.5 ||
        boat.right > s.width + 0.5 ||
        boat.bottom > s.height + 0.5
      ) {
        found.push(`${id}, ${s.name}: the boat is off the screen (${edges(boat)})`);
      }
      for (const f of await reefFaults(page)) {
        found.push(`${id}, ${s.name}: ${f}`);
      }
      // The sheet's name and ends in the boat's words, and its legends within it.
      const words = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-control=sheet] .sheet-end, [data-control=sheet] .control-label',
          ),
        ].map((e) => e.textContent),
      );
      const sheet = kind.controls.sheet;
      if (JSON.stringify(words) !== JSON.stringify([sheet.trim, sheet.ease, sheet.name])) {
        found.push(`${id}, ${s.name}: the sheet reads ${JSON.stringify(words)}`);
      }
      for (const f of await sheetFaults(page, braces ? aback : 'Aback')) {
        found.push(`${id}, ${s.name}: ${f}`);
      }
      if (kite !== '') {
        for (const f of await sheetFaults(page, aback, kite)) {
          found.push(`${id}, ${s.name}, the gennaker set: ${f}`);
        }
        const line = await page.evaluate(async () => {
          globalThis.keel.readouts('longest');
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const b = document.querySelector('[data-readout=reef]');
          const c = document.querySelector('.case-top');
          if (b === null || c === null) {
            return 'no line';
          }
          const r = b.getBoundingClientRect();
          const k = c.getBoundingClientRect();
          return r.left >= k.left - 0.5 && r.right <= k.right + 0.5
            ? ''
            : `“${b.textContent}” runs out of the case (${[r.left, r.right].map(Math.round)} in ${[k.left, k.right].map(Math.round)})`;
        });
        if (line !== '') {
          found.push(`${id}, ${s.name}, the gennaker's line: ${line}`);
        }
        await page.evaluate(() => globalThis.keel.readouts(null));
      }
    }
    expect(found).toEqual([]);
  });
}

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

/**
 * What is wrong with the pushers: one over the compass card, over the
 * readouts' words or over another, stem and face; or one off the screen.
 */
async function pusherFaults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const over = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    // Each pusher's target, and what is drawn of it: its stem and its face.
    const pushers = [...document.querySelectorAll('.case [data-pusher], .pocket [data-pusher]')]
      .map((p) => {
        const drawn = [...p.querySelectorAll('.pusher-stem, .pusher-face')].map((e) =>
          e.getBoundingClientRect(),
        );
        return { name: p.getAttribute('data-pusher') ?? '', r: p.getBoundingClientRect(), drawn };
      })
      .filter((p) => p.r.width > 0);
    const compass = document.querySelector('.case .compass')?.getBoundingClientRect();
    const words = [...document.querySelectorAll('.case .readouts .slot-text')].map((t) => {
      const range = document.createRange();
      range.selectNodeContents(t);
      return range.getBoundingClientRect();
    });
    for (const p of pushers) {
      if (compass !== undefined && p.drawn.some((d) => over(d, compass))) {
        out.push(`the ${p.name} pusher stands over the compass card`);
      }
      if (words.some((w) => w.width > 0 && p.drawn.some((d) => over(d, w)))) {
        out.push(`the ${p.name} pusher stands over the readouts’ words`);
      }
      if (
        p.r.left < -0.5 ||
        p.r.top < -0.5 ||
        p.r.right > innerWidth + 0.5 ||
        p.r.bottom > innerHeight + 0.5
      ) {
        out.push(`the ${p.name} pusher is off the screen`);
      }
    }
    // Their targets apart.
    for (let i = 0; i < pushers.length; i++) {
      for (let j = i + 1; j < pushers.length; j++) {
        const [a, b] = [pushers[i], pushers[j]];
        if (a !== undefined && b !== undefined && over(a.r, b.r)) {
          out.push(`the ${a.name} pusher covers the ${b.name} pusher`);
        }
      }
    }
    return out;
  });
}

test('no pusher stands over the compass card, the readouts or another pusher, out at sea and in port, on every screen', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the case is the same on either back end');
  const screens = [...SCREENS, { name: 'a desktop', width: 1440, height: 900, upright: false }];
  await page.setViewportSize({
    width: screens[0]?.width ?? 375,
    height: screens[0]?.height ?? 667,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const found: string[] = [];
  for (const where of ['at sea', 'in port']) {
    if (where === 'in port') {
      await expect
        .poll(() => page.evaluate(() => globalThis.keel.toHarbour()), { timeout: 30_000 })
        .toBe(true);
      await page.evaluate(() => {
        globalThis.keel.advance(30);
        globalThis.keel.render();
      });
      await expect(page.locator('[data-pusher=board]')).toBeVisible({ timeout: 15_000 });
    }
    for (const s of screens) {
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width: s.width, height: s.height },
      );
      await page.evaluate(() => {
        const k = globalThis.keel;
        k.settings({ barometer: true, clock: true, rightOfWay: true });
        k.readouts('longest');
      });
      await page.waitForTimeout(150);
      for (const f of await pusherFaults(page)) {
        found.push(`${s.name}, ${where}: ${f}`);
      }
    }
  }
  await page.evaluate(() => globalThis.keel.readouts(null));
  expect(found).toEqual([]);
});

/** The screens the instruments are held still on: the owner's phone either way, a wide phone, the tests' and a desktop. */
const STILL = [
  { name: 'small Android phone upright', width: 360, height: 640 },
  { name: 'small Android phone sideways', width: 640, height: 360 },
  { name: 'iPhone 16 sideways', width: 852, height: 393 },
  { name: 'the tests’ screen', width: 960, height: 600 },
  { name: 'a desktop', width: 1440, height: 900 },
] as const;

/** The complications' boxes, and the animations running on either. */
async function stillness(page: Page): Promise<{ boxes: string; running: string[] }> {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const parts = [...document.querySelectorAll<HTMLElement>('[data-complication]')];
    return {
      boxes: parts
        .map((e) => {
          const r = e.getBoundingClientRect();
          return `${e.dataset.complication} ${[r.left, r.top, r.width, r.height].map(Math.round).join(',')}`;
        })
        .join('; '),
      running: parts.flatMap((e) =>
        e
          .getAnimations({ subtree: true })
          .map((a) => `${e.dataset.complication}: ${(a as CSSAnimation).animationName ?? a.id}`),
      ),
    };
  });
}

test('the barometer and the clock keep still whatever else is pressed, toggled or resized', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the case is the same on either back end');
  await page.setViewportSize({ width: STILL[0].width, height: STILL[0].height });
  // Motion as a player has it: a slide replayed would be seen.
  await openScene(page, 'world=1', true);
  const found: string[] = [];
  for (const s of STILL) {
    const size = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width, height },
      );
    };
    await size(s.width, s.height);
    // Both out, opened afresh: they slide as they open, and are then still.
    await page.evaluate(() => globalThis.keel.settings({ barometer: false, clock: false }));
    await page.evaluate(() => globalThis.keel.settings({ barometer: true, clock: true }));
    await page.waitForTimeout(400);
    const rest = await stillness(page);
    if (!rest.boxes.includes('barometer') || !rest.boxes.includes('clock')) {
      found.push(`${s.name}: the complications out are ${rest.boxes}`);
    }
    const check = async (what: string) => {
      const now = await stillness(page);
      if (now.running.length > 0) {
        found.push(`${s.name}, ${what}: ${now.running.join(', ')} running`);
      }
      if (now.boxes !== rest.boxes) {
        found.push(`${s.name}, ${what}: ${now.boxes}, at rest ${rest.boxes}`);
      }
    };
    const weather = page.locator('[data-pusher=weather]');
    await weather.click();
    await check('the pocket chart’s weather off');
    await weather.click();
    await check('the pocket chart’s weather on');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.locator('.menu')).toBeVisible();
    await check('the menu open');
    await page.locator('.menu-x').click();
    await expect(page.locator('.menu')).toHaveCount(0);
    await check('the menu shut');
    for (const [dw, dh] of [
      [24, 0],
      [24, 16],
      [0, 0],
    ] as const) {
      await size(s.width + dw, s.height + dh);
      await check(`resized to ${s.width + dw} × ${s.height + dh}`);
    }
  }
  expect(found).toEqual([]);
});

test('the pocket chart’s weather stays within its disk, a storm on the rim cut by it', async ({
  page,
}) => {
  test.skip(
    test.info().project.name === 'webgpu',
    'a canvas of its own, the same on either back end',
  );
  await page.setViewportSize({ width: 960, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.stormAtRim();
    k.weatherNow();
    k.render();
  });
  // Painted pixels outside the disk's ellipse and its rim's line, and the colour of all.
  const painted = () =>
    page.evaluate(async () => {
      // The pocket chart is drawn twice a second.
      await new Promise((r) => setTimeout(r, 700));
      const c = document.querySelector<HTMLCanvasElement>('.pocket-chart canvas');
      const ctx = c?.getContext('2d', { willReadFrequently: true });
      if (c === null || c === undefined || ctx === null || ctx === undefined) {
        return null;
      }
      const { width: w, height: h } = c;
      const d = ctx.getImageData(0, 0, w, h).data;
      // The disk as it is drawn: 0.48 of the width across, seen at a tilt
      // of 0.62; its rim's line two pixels wide, softened a pixel more.
      const rx = 0.48 * w + 2;
      const ry = 0.48 * w * 0.62 + 2;
      let outside = 0;
      let ink = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if ((d[i + 3] ?? 0) === 0) {
            continue;
          }
          ink += (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
          const u = (x + 0.5 - w / 2) / rx;
          const v = (y + 0.5 - h / 2) / ry;
          if (u * u + v * v > 1) {
            outside++;
          }
        }
      }
      return { outside, ink };
    });
  await page.evaluate(() => globalThis.keel.settings({ pocketWeather: false }));
  const without = await painted();
  expect(without).not.toBeNull();
  await page.evaluate(() => globalThis.keel.settings({ pocketWeather: true }));
  // The storm drawn, once the forecast's module is made.
  await expect
    .poll(async () => (await painted())?.ink ?? 0, { timeout: 30_000 })
    .not.toBe(without?.ink ?? 0);
  const withWeather = await painted();
  // Nothing of it beyond the rim.
  expect(withWeather?.outside).toBe(without?.outside);
  expect(withWeather?.outside).toBe(0);
});

test('on the chart the arrow shrinks as it zooms out, the notices stand clear of its parts, and the strip’s clock follows the slider', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the controls are the same on either back end');
  const screens = [
    SCREENS[1],
    SCREENS[5],
    { name: 'a desktop', width: 1440, height: 900 },
  ] as const;
  await page.setViewportSize({ width: screens[0].width, height: screens[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const now = Date.now();
  await page.evaluate(
    ({ now }) => {
      const k = globalThis.keel;
      k.setWorldEnd({
        epoch: now - 5 * 86_400_000,
        ends: now + 2 * 86_400_000,
        closing: now - 86_400_000,
      });
      k.issueForecast();
      k.openChart('chart');
      k.render();
    },
    { now },
  );
  const found: string[] = [];
  // The arrow as drawn: the chart redraws at its own pace.
  const arrow = async (distance: number | null) => {
    await page.evaluate((d) => {
      if (d === null) {
        globalThis.keel.fitChart();
      } else {
        globalThis.keel.chartFromBoat(d);
      }
    }, distance);
    let last = Number.NaN;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(80);
      const l = await page.evaluate(() => {
        globalThis.keel.render();
        const e = globalThis.keel.chartArrow();
        return Math.hypot(e.nose.x - e.tail.x, e.nose.y - e.tail.y);
      });
      if (Math.abs(l - last) < 0.01) {
        return l;
      }
      last = l;
    }
    return last;
  };
  for (const s of screens) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    // The arrow from near to far, then the whole disk.
    const lengths: number[] = [];
    for (const d of [900, 3000, 6000, 9000, 15000, 22000, 30000]) {
      lengths.push(await arrow(d));
    }
    lengths.push(await arrow(null));
    for (const l of lengths) {
      if (!(l >= 11.5 && l <= 32.5)) {
        found.push(`${s.name}: the arrow is ${l.toFixed(1)} px long`);
      }
    }
    for (let i = 1; i < lengths.length - 1; i++) {
      if ((lengths[i] ?? 0) > (lengths[i - 1] ?? 0) + 0.5) {
        found.push(
          `${s.name}: the arrow grows as the chart zooms out: ${lengths.map((l) => l.toFixed(1)).join(', ')}`,
        );
        break;
      }
    }
    // A notice, with a place's box open and the key open on the Play bar.
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.chartFromBoat(9000);
      k.chartAt('island', 0);
      k.raiseNotice('gale-warned', {
        wind: 'NE force 8',
        when: 'in 40 min',
        where: '6 NM north-east of Port Royal',
      });
      k.render();
    });
    await expect(page.locator('.chart-notices .notice')).toBeVisible();
    for (const open of ['', 'Layers', 'Key']) {
      const button = page.getByRole('button', { name: open, exact: true });
      if (open !== '') {
        await button.click();
      }
      const covered = await page.evaluate(async () => {
        // The top's foot is told to the box as the notice lays out.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const n = document.querySelector('.chart-notices .notice')?.getBoundingClientRect();
        if (n === undefined) {
          return ['no notice'];
        }
        const out: string[] = [];
        for (const [name, sel] of [
          ['the strip', '.chart-strip'],
          ['the countdown', '.chart-falls'],
          ['the Play bar', '.chart-time'],
          ['the layers', '.chart-layers'],
          ['the key', '.chart-key'],
          ['the box', '.chart-box'],
        ]) {
          const r = document.querySelector(sel as string)?.getBoundingClientRect();
          if (
            r !== undefined &&
            Math.min(n.right, r.right) - Math.max(n.left, r.left) > 0.5 &&
            Math.min(n.bottom, r.bottom) - Math.max(n.top, r.top) > 0.5
          ) {
            out.push(`the notice covers ${name}`);
          }
        }
        if (n.left < -0.5 || n.right > innerWidth + 0.5 || n.top < -0.5) {
          out.push('the notice is off the screen');
        }
        return out;
      });
      for (const c of covered) {
        found.push(`${s.name}, ${open || 'nothing'} open: ${c}`);
      }
      if (open !== '') {
        await button.click();
      }
    }
    await page.locator('.notice-dismiss').click();
    // The chart's clock: in the strip, or under it held upright, and swept
    // on by the slider.
    const clock = page.locator('.chart-top .chart-clock');
    await expect(clock).toBeVisible();
    const hands = () =>
      page.evaluate(() => ({
        minute: document
          .querySelector('.chart-clock [data-hand=minute]')
          ?.getAttribute('transform'),
        name: document.querySelector('.chart-clock')?.getAttribute('aria-label') ?? '',
        ahead: document.querySelector('.chart-clock')?.classList.contains('ahead') ?? false,
      }));
    const atNow = await hands();
    await page.evaluate(() => globalThis.keel.chartTime(30));
    await expect.poll(async () => (await hands()).ahead).toBe(true);
    const ahead = await hands();
    if (ahead.minute === atNow.minute) {
      found.push(`${s.name}: the strip’s clock did not move with the slider (${atNow.minute})`);
    }
    if (!/^World time .+, in 30 minutes$/.test(ahead.name)) {
      found.push(`${s.name}: the strip’s clock is named “${ahead.name}”`);
    }
    await page.evaluate(() => globalThis.keel.chartTime(0));
    await expect.poll(async () => (await hands()).ahead).toBe(false);
  }
  expect(found).toEqual([]);
});

/**
 * What is not in the plate's brass and lacquer: each visible part named,
 * its frame's colour, its face and any blur behind it; and any button in
 * it smaller than 44 pixels either way.
 */
async function lookFaults(page: Page, sel: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const parts = [...document.querySelectorAll<HTMLElement>(sel)].filter(
      (e) => e.getBoundingClientRect().width > 0 && e.checkVisibility(),
    );
    if (parts.length === 0) {
      return [`nothing shown for ${sel}`];
    }
    for (const e of parts) {
      const st = getComputedStyle(e);
      const name = `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
      // By its sides: a complication's top is the seam that joins it to the case.
      if (st.borderLeftColor !== 'rgb(138, 101, 36)' || st.borderLeftWidth !== '1px') {
        out.push(`${name}: framed ${st.borderLeftWidth} ${st.borderLeftColor}`);
      }
      if (!st.backgroundImage.includes('linear-gradient')) {
        out.push(`${name}: its face is ${st.backgroundColor} ${st.backgroundImage}`);
      }
      if (st.backdropFilter !== 'none' && st.backdropFilter !== '') {
        out.push(`${name}: blurs what is behind it (${st.backdropFilter})`);
      }
      for (const b of e.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && (r.width < 43.5 || r.height < 43.5)) {
          out.push(
            `${name}: “${b.getAttribute('aria-label') ?? b.textContent}” is ${Math.round(r.width)} × ${Math.round(r.height)}`,
          );
        }
      }
    }
    return out;
  }, sel);
}

test('every panel and window on the screen at sea is in the plate’s brass and lacquer, its keys the head’s, the watch plate centred', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  const screens = [
    SCREENS[1],
    SCREENS[5],
    { name: 'a desktop', width: 1440, height: 900 },
  ] as const;
  await page.setViewportSize({ width: screens[0].width, height: screens[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  await expect
    .poll(() => page.evaluate(() => globalThis.keel.toHarbour()), { timeout: 30_000 })
    .toBe(true);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.settings({ barometer: true, clock: true, forcesOverlay: true });
    k.render();
  });
  await expect(page.locator('[data-pusher=board]')).toBeVisible({ timeout: 15_000 });
  const found: string[] = [];
  const check = async (where: string, sel: string) => {
    for (const f of await lookFaults(page, sel)) {
      found.push(`${where}: ${f}`);
    }
  };
  for (const s of screens) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    await page.waitForTimeout(200);
    await check(s.name, '.case-top, .complications, .hud-top > .panel:not(.case)');
    // A notice.
    await page.evaluate(() => globalThis.keel.raiseNotice('charted-own', { name: 'Keyhole Rock' }));
    await check(`${s.name}, a notice`, '.notice');
    await page.locator('.notice-dismiss').click();
    // The menu.
    await page.getByRole('button', { name: 'Menu' }).click();
    await check(`${s.name}, the menu`, '.menu');
    await page.locator('.menu-x').click();
    // The harbour board, and the fleet's boats it opens in its place.
    await page.locator('[data-pusher=board]').click();
    await check(`${s.name}, the harbour board`, '.board');
    await page.locator('.board').getByRole('button', { name: 'Change boat', exact: true }).click();
    await check(`${s.name}, the fleet’s boats`, '.board');
    await page.locator('.board').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.board').getByRole('button', { name: 'Close', exact: true }).click();
    // The question before the boat leaves the water: a window of its own,
    // no wider than 360 pixels, centred; Escape is Stay.
    await page.evaluate(() => globalThis.keel.leaveQuestion(true));
    await expect(page.locator('.watch-asking')).toBeVisible();
    await check(`${s.name}, the question`, '.watch-asking');
    const q = await page.evaluate(() => {
      const r = document.querySelector('.watch-asking')?.getBoundingClientRect();
      return r === undefined ? null : { left: r.left, right: r.right, width: r.width };
    });
    if (q === null || q.width > 360.5 || Math.abs((q.left + q.right) / 2 - s.width / 2) > 1) {
      found.push(`${s.name}: the question’s window is ${JSON.stringify(q)}`);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.watch-asking')).toHaveCount(0);
    // The plate.
    await page.evaluate((name) => globalThis.keel.watchPlate(name), LONG);
    await expect(page.locator('.watch-plate')).toBeVisible();
    await check(`${s.name}, the plate`, '.watch-plate');
    const p = await page.evaluate(() => {
      const r = document.querySelector('.watch-plate')?.getBoundingClientRect();
      return r === undefined ? null : { left: r.left, right: r.right };
    });
    if (p === null || Math.abs((p.left + p.right) / 2 - s.width / 2) > 1) {
      found.push(`${s.name}: the plate is at ${JSON.stringify(p)}, not centred`);
    }
    await page.evaluate(() => globalThis.keel.watchPlate(null));
    await page.evaluate(() =>
      globalThis.keel.settings({ barometer: true, clock: true, forcesOverlay: true }),
    );
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
  // The sailor's last story, on the card.
  await standInNews(page);
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(GAME);
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
    // Its last story in the news, one line within the card.
    const line = await page.locator('.watch-card .watch-last-news').evaluate((e) => ({
      tall: e.getBoundingClientRect().height,
      over: e.scrollHeight - e.clientHeight,
    }));
    if (line.tall < 39.5 || line.over > 1) {
      found.push(
        `${s.name}, the card: its last story is ${Math.round(line.tall)} px tall, ${line.over} px over`,
      );
    }
    await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(found).toEqual([]);
});

/** A fleet at its longest: a twenty-letter name on the largest kind, its sail number four figures. */
function longFleet() {
  const kinds = data.boats;
  const big = [...kinds].sort((a, b) => b.lengthOverall - a.lengthOverall)[0];
  const small = kinds[0];
  const paints = data.boatLooks.paints;
  const cloths = data.boatLooks.cloths;
  const boat = (id: string, kind: string, number: number, name: string, i: number) => ({
    id,
    kind,
    number,
    name,
    paint: paints[i % paints.length]?.id ?? '',
    cloth: cloths[i % cloths.length]?.id ?? '',
    sailor: i === 0 ? LONG : '',
    machine: false,
    atSea: false,
    yours: i === 0,
  });
  return {
    boat: 'b1',
    boats: [
      boat('b1', big?.id ?? '', 9999, 'Queen Anne’s Revenge', 0),
      {
        ...boat('b2', small?.id ?? '', 12, 'Gull', 1),
        sailor: 'Iron Mary',
        machine: true,
        atSea: true,
      },
      boat('b3', small?.id ?? '', 4321, '', 2),
    ],
  };
}

test('the player’s own panel keeps Set sail in view with their boat, and the boat’s look and the fleet’s boats fit every screen', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(150_000);
  const o = data.sailorOptions;
  await page.route(
    (url) => url.pathname === '/api/me',
    (r) =>
      r.fulfill({
        json: {
          name: LONG,
          look: data.sailors[0]?.id,
          version: data.sailors[0]?.versions[0]?.id,
          skin: o.skins[0]?.id,
          hair: o.hairs[0]?.id,
          colour: o.colours[0]?.id,
          lookChosen: true,
          kind: data.boats[0]?.id,
          spectators: 'no',
          atSea: false,
        },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/fleet',
    (r) => r.fulfill({ json: longFleet() }),
  );
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(GAME);
  await expect(page.locator('.your-sailor [data-readout=boat]')).toBeVisible({ timeout: 90_000 });
  const found: string[] = [];
  /** Each of the named keys within the screen, and within the panel shown. */
  const inSight = async (where: string, panel: string, keys: string[]) => {
    const out = await page.evaluate(
      ({ panel, keys }) => {
        const p = document.querySelector(panel)?.getBoundingClientRect();
        if (p === undefined) {
          return [`no ${panel}`];
        }
        const out: string[] = [];
        for (const k of keys) {
          const els = [...document.querySelectorAll<HTMLElement>(k)];
          if (els.length === 0) {
            out.push(`no ${k}`);
          }
          for (const e of els) {
            const r = e.getBoundingClientRect();
            if (
              r.top < Math.max(p.top, 0) - 0.5 ||
              r.bottom > Math.min(p.bottom, innerHeight) + 0.5 ||
              r.left < -0.5 ||
              r.right > innerWidth + 0.5
            ) {
              out.push(`${k} “${e.getAttribute('aria-label') ?? e.textContent}” is out of view`);
            }
          }
        }
        return out;
      },
      { panel, keys },
    );
    for (const f of out) {
      found.push(`${where}: ${f}`);
    }
  };
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    await page.waitForTimeout(100);
    await inSight(`${s.name}, the panel`, '.your-sailor', [
      '.your-sailor-go',
      '[data-readout=boat]',
    ]);
    await page.getByRole('button', { name: 'Your boat', exact: true }).click();
    await expect(page.locator('.boat-look')).toBeVisible();
    await inSight(`${s.name}, the boat’s look`, '.boat-look', [
      '.boat-look-actions .start-go',
      '.boat-look-actions .start-sign-in',
    ]);
    // Every swatch on the screen's width, and in view as the panel scrolls to it.
    for (const radio of await page.locator('.boat-look [role=radio]').all()) {
      await radio.scrollIntoViewIfNeeded();
      const b = await radio.boundingBox();
      if (
        b === null ||
        b.x + b.width > s.width + 0.5 ||
        b.y < -0.5 ||
        b.y + b.height > s.height + 0.5
      ) {
        found.push(`${s.name}, the boat’s look: a swatch is off the screen (${JSON.stringify(b)})`);
      }
    }
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Change boat', exact: true }).click();
    await expect(page.locator('.change-boat')).toBeVisible();
    await inSight(`${s.name}, the fleet’s boats`, '.change-boat', [
      '.change-boat-list li:first-child .change-boat-choice',
      '.change-boat .boat-look-actions .start-sign-in',
    ]);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  expect(found).toEqual([]);
});

test('a link’s parts on the player’s own panel fit every screen: a refused link’s words and ☆ Follow at its head, Set sail in view, the share within reach', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(120_000);
  const o = data.sailorOptions;
  await page.route(
    (url) => url.pathname === '/api/me',
    (r) =>
      r.fulfill({
        json: {
          name: LONG,
          look: data.sailors[0]?.id,
          version: data.sailors[0]?.versions[0]?.id,
          skin: o.skins[0]?.id,
          hair: o.hairs[0]?.id,
          colour: o.colours[0]?.id,
          lookChosen: true,
          kind: data.boats[0]?.id,
          spectators: 'no',
          atSea: false,
          watchCode: 'k3x7q2mbwa',
          fleetCode: 'abcdefgh23',
        },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/fleet',
    (r) => r.fulfill({ json: longFleet() }),
  );
  await page.route(
    (url) => url.pathname === '/api/watch/link',
    (r) => r.fulfill({ status: 404, json: { error: 'cannot', name: LONG, machine: false } }),
  );
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${GAME}&w=zzzzzzzzzz`);
  const head = page.locator('.your-sailor [data-readout=link-refused]');
  await expect(head).toContainText(`${LONG} cannot be watched now.`, { timeout: 90_000 });
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    await page.waitForTimeout(100);
    await page.locator('.your-sailor').evaluate((e) => e.scrollTo(0, 0));
    // Set sail and the refusal's words and Follow in view as the panel opens.
    for (const k of ['.your-sailor-go', '.link-refused-line', '.link-follow']) {
      const b = await page.locator(k).first().boundingBox();
      if (
        b === null ||
        b.y < -0.5 ||
        b.y + b.height > s.height + 0.5 ||
        b.x < -0.5 ||
        b.x + b.width > s.width + 0.5
      ) {
        found.push(`${s.name}: ${k} is out of view (${JSON.stringify(b)})`);
      }
    }
    // The share and Make a new link within the screen's width, in view as the panel scrolls to them.
    for (const name of ['Share a link to watch me', 'Make a new link']) {
      const key = page.getByRole('button', { name, exact: true });
      await key.scrollIntoViewIfNeeded();
      const b = await key.boundingBox();
      if (
        b === null ||
        b.y < -0.5 ||
        b.y + b.height > s.height + 0.5 ||
        b.x + b.width > s.width + 0.5
      ) {
        found.push(`${s.name}: ${name} is out of reach (${JSON.stringify(b)})`);
      } else if (b.height < 39.5) {
        found.push(`${s.name}: ${name} is ${b.height} px tall`);
      }
    }
  }
  expect(found).toEqual([]);
});

// Sailing together, on every screen: the controls offered, the knocks on
// the skipper's boat, the player's own knock and the line while they hold
// the controls with others aboard stand under the case, clear of every
// part, upright over no more of the boat than its masthead; the plate at
// the foot, in the controls' place, one row, clear of every part and the
// boat, centred; the windows (who is aboard, going ashore's
// question, the skipper's link) within the screen. Every key 44 pixels
// a touch, its face the instruments' height; nothing that steers while the player does not hold the
// controls.
test('sailing together’s parts stand clear of the instruments and the boat on every screen, their keys a 44 px touch', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The skipper's link as the server would answer it.
  const expires = new Date(Date.now() + 24 * 3_600_000).toISOString();
  await page.route('**/api/sail/link', (r) =>
    r.fulfill({
      json: { live: true, expires },
    }),
  );
  await openScene(page, '', true);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ sheetLimit: 0.05, boom: 0, surge: 0 });
    k.setControls(0, 0);
    k.render();
  });
  const SCENES = [
    { name: 'knocks', steers: true },
    { name: 'knocking', steers: true },
    { name: 'skipper', steers: true },
    { name: 'skipper-away', steers: false },
    { name: 'aboard', steers: false },
    { name: 'aboard-holding', steers: true },
    { name: 'handed', steers: false },
    { name: 'list', steers: false },
    { name: 'list-skipper', steers: false },
    { name: 'list-more', steers: true },
    { name: 'ashore', steers: false },
    { name: 'link', steers: true },
  ] as const;
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    for (const scene of SCENES) {
      await page.evaluate(({ name, sailor }) => globalThis.keel.deckScene(name, sailor), {
        name: scene.name,
        sailor: LONG,
      });
      const sel =
        '.deck-knock, .deck-knocking, .deck-line, .deck-plate, .deck-handed, .deck-window';
      await expect(page.locator(sel).first()).toBeVisible();
      // Two frames for the screen to settle at its new size (a slow
      // runner lays out a resized screen a frame late), then drawn.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.evaluate(() => globalThis.keel.render());
      const seen = await parts(page);
      const where = `${s.name}, ${scene.name}`;
      const faults = await page.evaluate(
        ({ sel, boat, others, upright, steers }) => {
          const out: string[] = [];
          const covers = (
            a: { left: number; top: number; right: number; bottom: number },
            b: { left: number; top: number; right: number; bottom: number },
          ) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          for (const e of document.querySelectorAll<HTMLElement>(sel)) {
            const r = e.getBoundingClientRect();
            const name = `.${[...e.classList].join('.')}`;
            if (
              r.left < -0.5 ||
              r.top < -0.5 ||
              r.right > innerWidth + 0.5 ||
              r.bottom > innerHeight + 0.5
            ) {
              out.push(
                `${name} is off the screen (${[r.left, r.top, r.right, r.bottom].map(Math.round)})`,
              );
            }
            // Each key the instruments' height (38 px or more), its
            // reach 3 px beyond its face above and below: 44 px a touch.
            for (const b of e.querySelectorAll('button')) {
              const k = b.getBoundingClientRect();
              const reach = Number.parseFloat(getComputedStyle(b, '::after').top) || 0;
              if (k.width < 43.5 || k.height < 37.5 || k.height - 2 * reach < 43.5) {
                out.push(
                  `${name}: “${b.textContent}” is ${Math.round(k.width)} × ${Math.round(k.height)}`,
                );
              }
            }
            // A window stands over the rest while it is open.
            if (e.classList.contains('deck-window')) {
              continue;
            }
            for (const o of others) {
              if (covers(r, o) && !o.name.startsWith('the line')) {
                out.push(`${name} covers ${o.name}`);
              }
            }
            if (boat !== null) {
              // Under the case, held upright, as the case may: the masthead,
              // never the hull.
              const top = e.closest('.hud-top') !== null;
              const hull = top && upright ? { ...boat, top: (boat.top + boat.bottom) / 2 } : boat;
              if (covers(r, hull)) {
                out.push(`${name} covers the boat`);
              }
            }
          }
          const plate = document.querySelector('.deck-plate')?.getBoundingClientRect();
          if (plate !== undefined) {
            if (Math.abs((plate.left + plate.right) / 2 - innerWidth / 2) > 1) {
              out.push('the plate is not centred');
            }
            if (plate.height > 56) {
              out.push(`the plate is ${Math.round(plate.height)} px tall: more than a row`);
            }
          }
          const steering =
            document.querySelector('[data-control=helm], [data-control=sheet], .pilot-head') !==
            null;
          if (steering !== steers) {
            out.push(steers ? 'the controls are gone' : 'a control that steers shows');
          }
          return out;
        },
        {
          sel,
          boat: seen.boat,
          others: seen.parts,
          upright: s.upright,
          steers: scene.steers,
        },
      );
      for (const f of faults) {
        found.push(`${where}: ${f}`);
      }
      if (s.name === 'small Android phone upright') {
        await test.info().attach(`${where}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
    }
  }
  await page.evaluate(() => globalThis.keel.deckScene(null));
  expect(found).toEqual([]);
});

// Chat aboard, on every screen: the strip under the case with sailing
// together's other parts. Folded, one row the keys' height, clear of every
// part and, upright, over no more of the boat than its masthead; open, its
// lines as many as there is room for above the controls, the plate at the
// foot or the watch's bar, never over the case, the pocket chart or the
// keys; with the keyboard up, its field above the keyboard. The sheet of
// mute, block and report, the report's form, the teens' card, the Rules
// before a first line and a statement of reasons within the screen. Every
// key 44 pixels a touch, its face the instruments' height.
test('chat aboard’s strip and windows stand clear of the instruments, above the keyboard, their keys a 44 px touch', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(240_000);
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, '', true);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ sheetLimit: 0.05, boom: 0, surge: 0 });
    k.setControls(0, 0);
    k.render();
  });
  const SCENES = [
    { name: 'chat', steers: true, open: false },
    { name: 'chat-open', steers: true, open: true },
    { name: 'chat-crew', steers: false, open: true },
    { name: 'chat-keyboard', steers: true, open: true },
    { name: 'chat-refused', steers: true, open: true },
    { name: 'chat-word', steers: true, open: true },
    { name: 'chat-resting', steers: true, open: true },
    { name: 'chat-off', steers: true, open: true },
    { name: 'chat-own-off', steers: true, open: true },
    { name: 'chat-owner', steers: false, open: true },
    { name: 'chat-spectator', steers: false, open: true },
    { name: 'chat-list', steers: true, open: false },
    { name: 'chat-sheet', steers: true, open: true },
    { name: 'chat-block', steers: true, open: true },
    { name: 'chat-report', steers: true, open: true },
    { name: 'chat-teen', steers: true, open: true },
    { name: 'chat-rules', steers: true, open: true },
    { name: 'chat-statement', steers: true, open: false },
    { name: 'chat-list-shipmate', steers: true, open: false },
  ] as const;
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    for (const scene of SCENES) {
      await page.evaluate(({ name, sailor }) => globalThis.keel.deckScene(name, sailor), {
        name: scene.name,
        sailor: LONG,
      });
      await expect(page.locator('.chat-strip').first()).toBeVisible();
      if (
        scene.name !== 'chat' &&
        scene.name.match(/list|sheet|block|report|teen|rules|statement/)
      ) {
        await expect(page.locator('.deck-window').first()).toBeVisible();
      }
      // The open strip fits itself after it is drawn: a frame or two.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.evaluate(() => globalThis.keel.render());
      const seen = await parts(page);
      const where = `${s.name}, ${scene.name}`;
      const keyboard =
        scene.name === 'chat-keyboard'
          ? Math.round(s.height * (s.height >= s.width ? 0.42 : 0.55))
          : 0;
      const faults = await page.evaluate(
        ({ boat, others, upright, steers, open, keyboard }) => {
          const out: string[] = [];
          const covers = (
            a: { left: number; top: number; right: number; bottom: number },
            b: { left: number; top: number; right: number; bottom: number },
          ) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          const shown = innerHeight - keyboard;
          for (const e of document.querySelectorAll<HTMLElement>(
            '.chat-strip, .deck-window, .statement-line',
          )) {
            const r = e.getBoundingClientRect();
            const name = `.${[...e.classList].join('.')}`;
            if (
              r.left < -0.5 ||
              r.top < -0.5 ||
              r.right > innerWidth + 0.5 ||
              r.bottom > innerHeight + 0.5
            ) {
              out.push(
                `${name} is off the screen (${[r.left, r.top, r.right, r.bottom].map(Math.round)})`,
              );
            }
            for (const b of e.querySelectorAll('button')) {
              const k = b.getBoundingClientRect();
              if (k.width === 0) {
                continue;
              }
              const reach = Number.parseFloat(getComputedStyle(b, '::after').top) || 0;
              if (k.width < 43.5 || k.height < 37.5 || k.height - 2 * reach < 43.5) {
                out.push(
                  `${name}: “${b.textContent}” is ${Math.round(k.width)} × ${Math.round(k.height)}`,
                );
              }
            }
            if (e.classList.contains('deck-window')) {
              continue;
            }
            const strip = e.classList.contains('chat-strip');
            if (strip && open !== e.classList.contains('open')) {
              out.push(open ? 'the strip is folded' : 'the strip is open');
            }
            if (strip && !e.classList.contains('open') && r.height > 48) {
              out.push(`the folded strip is ${Math.round(r.height)} px tall: more than a row`);
            }
            // Under the case, beside the other lines there, it may stand
            // over them, never over a part.
            for (const o of others) {
              if (covers(r, o) && !o.name.startsWith('the line') && keyboard === 0) {
                out.push(`${name} covers ${o.name}`);
              }
            }
            for (const sel of ['.deck-plate', '.watch-bar']) {
              const p = document.querySelector(sel)?.getBoundingClientRect();
              if (p !== undefined && p.width > 0 && covers(r, p)) {
                out.push(`${name} covers ${sel}`);
              }
            }
            // Folded, as every line under the case: upright over no more
            // of the boat than its masthead. Open, the player's to read.
            if (boat !== null && !(strip && e.classList.contains('open'))) {
              const hull = upright ? { ...boat, top: (boat.top + boat.bottom) / 2 } : boat;
              if (covers(r, hull)) {
                out.push(`${name} covers the boat`);
              }
            }
          }
          const field = document.querySelector('.chat-foot input')?.getBoundingClientRect();
          if (field !== undefined && field.bottom > shown + 0.5) {
            out.push(`the field is under the keyboard (${Math.round(field.bottom)} > ${shown})`);
          }
          const steering =
            document.querySelector('[data-control=helm], [data-control=sheet], .pilot-head') !==
            null;
          if (steering !== steers) {
            out.push(steers ? 'the controls are gone' : 'a control that steers shows');
          }
          return out;
        },
        {
          boat: seen.boat,
          others: seen.parts,
          upright: s.upright,
          steers: scene.steers,
          open: scene.open,
          keyboard,
        },
      );
      for (const f of faults) {
        found.push(`${where}: ${f}`);
      }
      if (scene.name === 'chat-owner' || scene.name === 'chat-spectator') {
        // A spectator's strip only reads: no field, no Send.
        const field = await page.locator('.chat-strip input, .chat-strip [type=submit]').count();
        if (field > 0) {
          found.push(`${where}: a spectator's strip has a field`);
        }
      }
      if (s.name === 'small Android phone upright' || s.name === 'small Android phone sideways') {
        await test.info().attach(`${where}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
    }
  }
  // Watching a machine sailor's boat with a person aboard: no chat at all.
  await page.evaluate(({ sailor }) => globalThis.keel.deckScene('chat-spectator-person', sailor), {
    sailor: LONG,
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  if ((await page.locator('.chat-strip').count()) > 0) {
    found.push('watching a boat with a person aboard, the chat strip shows');
  }
  await page.evaluate(() => globalThis.keel.deckScene(null));
  expect(found).toEqual([]);
});

// Shipmates, on every screen: the panel over the sea (offers, shipmates,
// the recent crew, a row's ⋯, an offer's words, ending's question, Appear
// offline, the panel empty) and a thread within the screen; a thread with
// the keyboard up, its field above the keyboard; the notices under the
// case clear of every part and, upright, over no more of the boat than
// its masthead. Every key 44 pixels a touch, its face the instruments'
// height; the controls still there, the player sailing alone.
test('shipmates’ panel, threads and notices stand clear of the instruments, above the keyboard, their keys a 44 px touch', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the panels are the same on either back end');
  test.setTimeout(240_000);
  await page.setViewportSize({ width: SCREENS[0].width, height: SCREENS[0].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, '', true);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ sheetLimit: 0.05, boom: 0, surge: 0 });
    k.setControls(0, 0);
    k.render();
  });
  const SCENES = [
    { name: 'shipmates', sel: '.shipmates-panel' },
    { name: 'shipmates-more', sel: '.shipmates-panel .deck-row-more' },
    { name: 'shipmates-offered', sel: '.shipmates-panel .deck-row-note' },
    { name: 'shipmates-made', sel: '.shipmates-panel .deck-row-note' },
    { name: 'shipmates-end', sel: '.shipmates-panel [data-asking=end]' },
    { name: 'shipmates-offline', sel: '.shipmates-panel' },
    { name: 'shipmates-empty', sel: '.shipmates-panel' },
    { name: 'shipmates-thread', sel: '.shipmate-thread' },
    { name: 'shipmates-away', sel: '.shipmate-thread .chat-note' },
    { name: 'shipmates-keyboard', sel: '.shipmate-thread' },
    { name: 'shipmates-notice', sel: '.shipmate-notice' },
    { name: 'shipmates-offer-notice', sel: '.shipmate-notice' },
  ] as const;
  const found: string[] = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width: s.width, height: s.height },
    );
    for (const scene of SCENES) {
      await page.evaluate(({ name, sailor }) => globalThis.keel.deckScene(name, sailor), {
        name: scene.name,
        sailor: LONG,
      });
      await expect(page.locator(scene.sel).first()).toBeVisible();
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.evaluate(() => globalThis.keel.render());
      const seen = await parts(page);
      const where = `${s.name}, ${scene.name}`;
      const keyboard =
        scene.name === 'shipmates-keyboard'
          ? Math.round(s.height * (s.height >= s.width ? 0.42 : 0.55))
          : 0;
      const faults = await page.evaluate(
        ({ boat, others, upright, keyboard }) => {
          const out: string[] = [];
          const covers = (
            a: { left: number; top: number; right: number; bottom: number },
            b: { left: number; top: number; right: number; bottom: number },
          ) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          const shown = innerHeight - keyboard;
          for (const e of document.querySelectorAll<HTMLElement>(
            '.shipmates-panel, .shipmate-thread, .shipmate-notice',
          )) {
            const r = e.getBoundingClientRect();
            const name = `.${[...e.classList].join('.')}`;
            if (
              r.left < -0.5 ||
              r.top < -0.5 ||
              r.right > innerWidth + 0.5 ||
              r.bottom > shown + 0.5
            ) {
              out.push(
                `${name} is off the screen or under the keyboard (${[r.left, r.top, r.right, r.bottom].map(Math.round)})`,
              );
            }
            for (const b of e.querySelectorAll('button')) {
              const k = b.getBoundingClientRect();
              if (k.width === 0) {
                continue;
              }
              // The instruments' head keys: 38 to 40 px tall, a touch 3 px beyond.
              const reach = Number.parseFloat(getComputedStyle(b, '::after').top) || 0;
              if (
                k.width < 43.5 ||
                k.height < 37.5 ||
                k.height > 40.5 ||
                k.height - 2 * reach < 43.5
              ) {
                out.push(
                  `${name}: “${b.textContent}” is ${Math.round(k.width)} × ${Math.round(k.height)}`,
                );
              }
              const font = getComputedStyle(b);
              if (font.fontSize !== '14px' && b.textContent !== '✕') {
                out.push(`${name}: “${b.textContent}” is in ${font.fontSize} words`);
              }
            }
            // A window stands over the rest while it is open; a thread's
            // lines keep two rows at the least.
            if (e.classList.contains('deck-window')) {
              const lines = e.querySelector('.chat-lines');
              if (e.classList.contains('shipmate-thread') && lines !== null) {
                const l = lines.getBoundingClientRect();
                if (l.height < 39.5) {
                  out.push(`the thread’s lines are ${Math.round(l.height)} px tall`);
                }
              }
              continue;
            }
            for (const o of others) {
              if (covers(r, o) && !o.name.startsWith('the line')) {
                out.push(`${name} covers ${o.name}`);
              }
            }
            if (boat !== null) {
              const hull = upright ? { ...boat, top: (boat.top + boat.bottom) / 2 } : boat;
              if (covers(r, hull)) {
                out.push(`${name} covers the boat`);
              }
            }
          }
          const field = document
            .querySelector('.shipmate-thread .chat-foot input')
            ?.getBoundingClientRect();
          if (field !== undefined && field.bottom > shown + 0.5) {
            out.push(`the field is under the keyboard (${Math.round(field.bottom)} > ${shown})`);
          }
          if (
            document.querySelector('[data-control=helm], [data-control=sheet], .pilot-head') ===
            null
          ) {
            out.push('the controls are gone');
          }
          return out;
        },
        { boat: seen.boat, others: seen.parts, upright: s.upright, keyboard },
      );
      for (const f of faults) {
        found.push(`${where}: ${f}`);
      }
      if (s.name === 'small Android phone upright' || s.name === 'small Android phone sideways') {
        await test.info().attach(`${where}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
    }
  }
  await page.evaluate(() => globalThis.keel.deckScene(null));
  expect(found).toEqual([]);
});

/** What is wrong with the chart screen's strip and the log on it, on paper: off the screen, overlapping, too small, a key not the head's size. */
async function logFaults(page: Page, collection: boolean): Promise<string[]> {
  return page.evaluate((collection) => {
    const out: string[] = [];
    const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const strip = box('.chart-strip');
    const sheet = document.querySelector<HTMLElement>('.log-sheet');
    if (strip === null || sheet === null) {
      return ['no strip or no log'];
    }
    const s = sheet.getBoundingClientRect();
    const w = innerWidth;
    const h = innerHeight;
    if (strip.height > 48 || strip.left < -0.5 || strip.right > w + 0.5) {
      out.push(
        `the strip is ${Math.round(strip.width)} × ${Math.round(strip.height)} at ${Math.round(strip.left)}`,
      );
    }
    const tabs = [...document.querySelectorAll('.chart-tab')].map((t) => t.textContent);
    if (tabs.join(' ') !== 'Chart List News Log') {
      out.push(`the tabs are ${tabs.join(', ')}`);
    }
    const inStrip = ['.chart-tabs', '.chart-position', '.chart-back'].map((sel) => ({
      sel,
      r: box(sel),
    }));
    for (const [i, a] of inStrip.entries()) {
      if (
        a.r === null ||
        a.r.width < 1 ||
        a.r.left < strip.left - 0.5 ||
        a.r.right > strip.right + 0.5
      ) {
        out.push(`${a.sel} is not within the strip`);
        continue;
      }
      for (const b of inStrip.slice(i + 1)) {
        if (b.r !== null && Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 0.5) {
          out.push(`${a.sel} covers ${b.sel}`);
        }
      }
    }
    if (s.left < -0.5 || s.right > w + 0.5 || s.bottom > h + 0.5 || s.top < strip.bottom - 0.5) {
      out.push(
        `the sheet is off the screen or over the strip: ${Math.round(s.left)}, ${Math.round(s.top)}, ${Math.round(s.right)}, ${Math.round(s.bottom)}`,
      );
    }
    const falls = box('.chart-falls');
    if (
      falls !== null &&
      Math.min(falls.right, s.right) - Math.max(falls.left, s.left) > 0.5 &&
      Math.min(falls.bottom, s.bottom) - Math.max(falls.top, s.top) > 0.5
    ) {
      out.push('the sheet covers the countdown');
    }
    // Paper: the chart's paper, opaque, in ink.
    const st = getComputedStyle(sheet);
    if (st.backgroundColor !== 'rgb(239, 228, 200)' || st.color !== 'rgb(59, 46, 34)') {
      out.push(`the sheet is ${st.backgroundColor}, its ink ${st.color}`);
    }
    for (const el of [sheet, ...sheet.querySelectorAll<HTMLElement>('.log-side, .log-main')]) {
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push(`${el.className} is ${el.scrollWidth - el.clientWidth} px wider than it shows`);
      }
    }
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (e as HTMLElement).checkVisibility();
    };
    for (const k of sheet.querySelectorAll('button.log-key')) {
      const r = k.getBoundingClientRect();
      const short = innerHeight <= 420 || (innerHeight <= 700 && innerHeight > innerWidth);
      const tall = short ? 38 : 40;
      if (
        shown(k) &&
        (Math.abs(r.height - tall) > 0.5 ||
          r.width < 43.5 ||
          (k.textContent !== '⋯' && getComputedStyle(k).fontSize !== '14px'))
      ) {
        out.push(
          `the key “${k.textContent}” is ${Math.round(r.width)} × ${Math.round(r.height)}, not the head’s ${tall}`,
        );
      }
    }
    for (const k of sheet.querySelectorAll('.log-day:not(.log-day-heads), .log-cell')) {
      const r = k.getBoundingClientRect();
      if (shown(k) && r.height < 43.5) {
        out.push(`“${k.textContent?.slice(0, 20)}” is ${Math.round(r.height)} px tall`);
      }
    }
    // The keys chosen, inked in.
    for (const k of sheet.querySelectorAll(
      'button.log-key[aria-selected=true], button.log-key[aria-pressed=true]',
    )) {
      if (getComputedStyle(k).backgroundColor !== 'rgb(59, 46, 34)') {
        out.push(`the chosen key “${k.textContent}” is not inked in`);
      }
    }
    // No words under 13 px.
    const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const e = n.parentElement;
      if (
        e !== null &&
        (n.textContent ?? '').trim() !== '' &&
        shown(e) &&
        Number.parseFloat(getComputedStyle(e).fontSize) < 13
      ) {
        out.push(`“${n.textContent?.trim().slice(0, 20)}” is ${getComputedStyle(e).fontSize}`);
      }
    }
    if (collection) {
      const cells =
        [...sheet.querySelectorAll('.log-group')][0]?.querySelectorAll('.log-cell') ?? [];
      const top = cells[0]?.getBoundingClientRect().top ?? 0;
      const row = [...cells].filter(
        (c) => Math.abs(c.getBoundingClientRect().top - top) < 1,
      ).length;
      const want = innerHeight > innerWidth ? 3 : innerWidth < 900 ? 5 : row;
      if (row !== want && cells.length >= want) {
        out.push(`${row} kinds a row, not ${want}`);
      }
    }
    return out;
  }, collection);
}

test('the chart screen’s Log tab holds a long log, its collection, who may read it, another’s, a machine’s, an empty one and one not there, on paper, on every screen', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the log is the same on either back end');
  test.setTimeout(150_000);
  let own: () => object = longLog;
  await standInLogs(page, () => own());
  await page.setViewportSize({ width: SCREENS[1].width, height: SCREENS[1].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const now = Date.now();
  await page.evaluate((now) => {
    // In the world's last days, its countdown under the strip held upright.
    globalThis.keel.setWorldEnd({
      epoch: now - 5 * 86_400_000,
      ends: now + 2 * 86_400_000,
      closing: now - 86_400_000,
    });
  }, now);
  const found: string[] = [];
  const check = async (where: string, collection = false) => {
    for (const f of await logFaults(page, collection)) {
      found.push(`${where}: ${f}`);
    }
  };
  // The upright and the sideways phone first.
  const screens = [
    SCREENS[1],
    SCREENS[5],
    ...SCREENS.filter((s) => s !== SCREENS[1] && s !== SCREENS[5]),
  ];
  for (const s of screens) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      s,
    );
    own = longLog;
    await page.evaluate(() => globalThis.keel.openLog({ kind: 'sailor', name: 'Nobody' }));
    await expect(page.locator('.log-sheet .log-status')).toContainText('no such sailor');
    await check(`${s.name}, a log not there`);
    await page.evaluate(() => globalThis.keel.openLog({ kind: 'own' }));
    await expect(page.locator('.log-day').nth(1)).toBeVisible();
    await check(`${s.name}, a long log`);
    await page.locator('.log-day:not(.log-day-heads)').first().click();
    await check(`${s.name}, a day opened`);
    await page.locator('.log-more').click();
    await expect(page.locator('.log-who')).toBeVisible();
    await check(`${s.name}, who may read it`);
    await page.locator('.log-more').click();
    await page.getByRole('tab', { name: 'Collection' }).click();
    await page.locator('.log-cell').nth(2).click();
    await check(`${s.name}, the collection`, true);
    await page.evaluate((name) => globalThis.keel.openLog({ kind: 'sailor', name }), LONG_NAME);
    await expect(page.locator('.log-back')).toBeVisible();
    await check(`${s.name}, another’s log`);
    await page.evaluate(() =>
      globalThis.keel.openLog({ kind: 'machine', id: '0', name: 'Clockwork Kestrel' }),
    );
    await expect(page.locator('.log-name')).toContainText('Machine sailor');
    await check(`${s.name}, a machine sailor’s log`);
    own = emptyLog;
    await page.evaluate(() => globalThis.keel.openLog({ kind: 'own' }));
    await expect(page.locator('.log-sheet .log-empty')).toBeVisible();
    await check(`${s.name}, an empty log`);
  }
  await page.evaluate(() => globalThis.keel.openChart(null));
  expect(found).toEqual([]);
});

/** What is wrong with the chart screen's strip and the news on it, on paper: off the screen, overlapping, too small, a key not the head's size; and how far down its sixth story ends, px. */
async function newsFaults(page: Page): Promise<{ out: string[]; front: number }> {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const strip = box('.chart-strip');
    const sheet = document.querySelector<HTMLElement>('.news-sheet');
    if (strip === null || sheet === null) {
      return { out: ['no strip or no news'], front: 0 };
    }
    const s = sheet.getBoundingClientRect();
    const w = innerWidth;
    const h = innerHeight;
    if (strip.height > 48 || strip.left < -0.5 || strip.right > w + 0.5) {
      out.push(`the strip is ${Math.round(strip.width)} × ${Math.round(strip.height)}`);
    }
    const tab = [...document.querySelectorAll('.chart-tab')].find((t) => t.textContent === 'News');
    const dot = box('.chart-tab-dot');
    const t = tab?.getBoundingClientRect() ?? null;
    if (
      t === null ||
      (dot !== null &&
        (dot.left < t.left || dot.right > t.right || dot.top < t.top || dot.bottom > t.bottom))
    ) {
      out.push('the News tab’s dot is outside the tab');
    }
    if (s.left < -0.5 || s.right > w + 0.5 || s.bottom > h + 0.5 || s.top < strip.bottom - 0.5) {
      out.push(
        `the sheet is off the screen or over the strip: ${Math.round(s.left)}, ${Math.round(s.top)}, ${Math.round(s.right)}, ${Math.round(s.bottom)}`,
      );
    }
    const falls = box('.chart-falls');
    if (
      falls !== null &&
      Math.min(falls.right, s.right) - Math.max(falls.left, s.left) > 0.5 &&
      Math.min(falls.bottom, s.bottom) - Math.max(falls.top, s.top) > 0.5
    ) {
      out.push('the sheet covers the countdown');
    }
    // Paper: the chart's paper, opaque, with its grain, in ink.
    const st = getComputedStyle(sheet);
    if (
      st.backgroundColor !== 'rgb(239, 228, 200)' ||
      st.color !== 'rgb(59, 46, 34)' ||
      !st.backgroundImage.startsWith('url(')
    ) {
      out.push(`the sheet is ${st.backgroundColor}, its ink ${st.color}`);
    }
    for (const el of [
      sheet,
      ...sheet.querySelectorAll<HTMLElement>('.news-masthead h2, .news-box'),
    ]) {
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push(
          `${el.className || el.tagName} is ${el.scrollWidth - el.clientWidth} px wider than it shows`,
        );
      }
    }
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (e as HTMLElement).checkVisibility();
    };
    const short = innerHeight <= 420 || (innerHeight <= 700 && innerHeight > innerWidth);
    const tall = short ? 38 : 40;
    for (const k of sheet.querySelectorAll('button.news-key')) {
      const r = k.getBoundingClientRect();
      if (
        shown(k) &&
        (Math.abs(r.height - tall) > 0.5 ||
          r.width < 43.5 ||
          getComputedStyle(k).fontSize !== '14px')
      ) {
        out.push(
          `the key “${k.textContent}” is ${Math.round(r.width)} × ${Math.round(r.height)}, not the head’s ${tall}`,
        );
      }
    }
    for (const k of sheet.querySelectorAll('.news-story')) {
      const r = k.getBoundingClientRect();
      if (r.height < 43.5) {
        out.push(`“${k.textContent?.slice(0, 20)}” is ${Math.round(r.height)} px tall`);
      }
      // A story with a place is a tap anywhere on it.
      const go = k.querySelector('.news-go');
      if (go !== null) {
        const reach = getComputedStyle(go, '::after');
        if (reach.position !== 'absolute' || reach.inset !== '0px') {
          out.push(`“${k.textContent?.slice(0, 20)}” is not a tap all over`);
        }
      }
    }
    // The words: body 16 px, none under 13.
    const words = sheet.querySelector('.news-words');
    if (words !== null && getComputedStyle(words).fontSize !== '16px') {
      out.push(`a story’s words are ${getComputedStyle(words).fontSize}`);
    }
    const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const e = n.parentElement;
      if (
        e !== null &&
        (n.textContent ?? '').trim() !== '' &&
        shown(e) &&
        Number.parseFloat(getComputedStyle(e).fontSize) < 13
      ) {
        out.push(`“${n.textContent?.trim().slice(0, 20)}” is ${getComputedStyle(e).fontSize}`);
      }
    }
    const front = [
      ...sheet.querySelectorAll(':scope > .news-stories:not(.news-lead) > .news-story'),
    ];
    const last = front[front.length - 1];
    return {
      out,
      front:
        last === undefined
          ? 0
          : last.getBoundingClientRect().bottom - s.top + sheet.scrollTop + (s.top - strip.bottom),
    };
  });
}

test('the chart screen’s News tab holds a full day’s edition, a new world’s first, a quiet day’s and an earlier one, on paper, on every screen, its front page within about one and a half screens', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the news is the same on either back end');
  test.setTimeout(150_000);
  let today: () => object = fullDay;
  await standInNews(page, () => today());
  await page.setViewportSize({ width: SCREENS[1].width, height: SCREENS[1].height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  const now = Date.now();
  await page.evaluate((now) => {
    globalThis.keel.newsFromServer();
    // In the world's last days, its countdown under the strip held upright.
    globalThis.keel.setWorldEnd({
      epoch: now - 5 * 86_400_000,
      ends: now + 2 * 86_400_000,
      closing: now - 86_400_000,
    });
    globalThis.keel.openChart('chart');
  }, now);
  // Today's edition not yet read: the News tab's dot.
  await expect(page.locator('.chart-tab-dot')).toBeVisible();
  const found: string[] = [];
  const fronts: string[] = [];
  const check = async (where: string) => {
    const { out, front } = await newsFaults(page);
    for (const f of out) {
      found.push(`${where}: ${f}`);
    }
    return front;
  };
  const open = async (edition: () => object) => {
    today = edition;
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.openNews(null);
    });
    await expect(page.locator('.news-edition')).toBeVisible();
  };
  const screens = [
    SCREENS[1],
    SCREENS[5],
    ...SCREENS.filter((s) => s !== SCREENS[1] && s !== SCREENS[5]),
  ];
  for (const s of screens) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      s,
    );
    await open(fullDay);
    await expect(page.locator('.news-story')).toHaveCount(9);
    const front = await check(`${s.name}, a full day`);
    fronts.push(`${s.name}: ${(front / s.height).toFixed(2)}`);
    if (s === SCREENS[1] && front > 1.5 * s.height) {
      found.push(`${s.name}: the front page is ${(front / s.height).toFixed(2)} screens`);
    }
    await page.locator('.news-older').click();
    await expect(page.locator('.news-edition')).toContainText('No. 3');
    await check(`${s.name}, an earlier edition`);
    await open(firstEdition);
    await expect(page.locator('.news-lead .news-story')).toHaveCount(2);
    await check(`${s.name}, a new world’s first edition`);
    await open(quietDay);
    await expect(page.locator('.news-figures')).toHaveText('A quiet day on the water.');
    await check(`${s.name}, a quiet day`);
  }
  test
    .info()
    .annotations.push({ type: 'the front page, in screens', description: fronts.join('; ') });
  await page.evaluate(() => globalThis.keel.openChart(null));
  expect(found).toEqual([]);
});

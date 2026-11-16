// SPDX-License-Identifier: AGPL-3.0-only

// The page's checks, at the owner's phone (360 × 640), a larger phone
// (390 × 844), a laptop (1366 × 768) and a desktop (1920 × 1080), at each
// of the four hours at sea:
//
// - Set sail wholly in the first screen, and nothing wider than the screen;
// - the opening's words readable over its picture at every hour, its veil
//   measured: every word's box at 4.5:1 or better against the brightest
//   tenth of the picture behind it;
// - each hour's colours on the page as the sky's steps make them, the
//   titles' and the keys' words readable on them;
// - every picture with its words, and every one loaded once in view;
// - whole without script but for the countdown, the numbers, Copy and the
//   Google Calendar link, which the script then shows;
// - the page's weight within its budgets.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { contrast, openingAt, PALETTES, type Palette, paletteAt, skyStep } from '../site/src/sky';
import { claudeLink, cursorLink, vscodeLink } from '../site/src/words';

const SCREENS = [
  { name: 'phone 360 × 640', width: 360, height: 640, scale: 3, mobile: true },
  { name: 'phone 390 × 844', width: 390, height: 844, scale: 3, mobile: true },
  { name: 'laptop 1366 × 768', width: 1366, height: 768, scale: 1, mobile: false },
  { name: 'desktop 1920 × 1080', width: 1920, height: 1080, scale: 1, mobile: false },
] as const;

/** An hour of each palette's own: night, dawn, day, dusk. */
const HOURS = [
  { hour: 2, name: 'night' },
  { hour: 6, name: 'dawn' },
  { hour: 12, name: 'day' },
  { hour: 18, name: 'dusk' },
] as const;

const out = new URL('../out/', import.meta.url);

/** The opening picture loaded, the fonts in. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('.opening-picture img');
    return img?.complete && img.naturalWidth > 0 && document.fonts.status === 'loaded';
  });
}

function rgbOf(css: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (m === null) {
    return css.trim();
  }
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG's relative luminance of an sRGB pixel. */
function lum(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

for (const screen of SCREENS) {
  test.describe(screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      deviceScaleFactor: screen.scale,
      isMobile: screen.mobile,
      hasTouch: screen.mobile,
    });

    for (const { hour, name } of HOURS) {
      test(`${name}: Set sail in the first screen, nothing wider than the screen, the opening’s words readable`, async ({
        page,
      }) => {
        await page.goto(`/?hour=${hour}`);
        await settled(page);
        // The Worker served the hour: its step and its picture.
        await expect(page.locator('html')).toHaveAttribute('data-sky', String(skyStep(hour)));
        await expect(page.locator('html')).toHaveAttribute('data-opening', name);
        expect(
          await page
            .locator('.opening-picture img')
            .evaluate((i: HTMLImageElement) => i.currentSrc),
        ).toContain(`/assets/edge-${name}-`);

        const go = await page.locator('.opening .go').boundingBox();
        expect(go).not.toBeNull();
        expect(go?.y ?? -1).toBeGreaterThanOrEqual(0);
        expect((go?.y ?? 0) + (go?.height ?? 0)).toBeLessThanOrEqual(screen.height);
        expect(go?.height ?? 0).toBeGreaterThanOrEqual(44);
        const widths = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          screen: window.innerWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.screen);

        // The veil: the picture behind each of the opening's words, the words
        // hidden, its brightest tenth against the words' own colour.
        const words = ['.eyebrow', '.opening h1', '.line', '.go-note'];
        const boxes = await page.evaluate((sels) => {
          return sels.map((s) => {
            const el = document.querySelector(s);
            if (el === null) {
              return null;
            }
            // Each line of words as laid out, not the box round them.
            const range = document.createRange();
            range.selectNodeContents(el);
            const rects = [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
            return {
              sel: s,
              colour: getComputedStyle(el).color,
              rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
            };
          });
        }, words);
        // The page's CSP takes no style sheet of the test's: the words hidden one by one.
        await page.evaluate(() => {
          for (const el of document.querySelectorAll<HTMLElement>('.opening-words *')) {
            el.style.visibility = 'hidden';
          }
        });
        const shot = await sharp(await page.screenshot({ scale: 'css' }))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const { width: w, height: h } = shot.info;
        for (const b of boxes) {
          expect(b, 'the opening’s words').not.toBeNull();
          const lums: number[] = [];
          for (const r of b?.rects ?? []) {
            for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(h, r.y + r.height); y++) {
              for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(w, r.x + r.width); x++) {
                const i = (y * w + x) * 3;
                lums.push(lum(shot.data[i] ?? 0, shot.data[i + 1] ?? 0, shot.data[i + 2] ?? 0));
              }
            }
          }
          expect(lums.length, b?.sel).toBeGreaterThan(100);
          lums.sort((p, q) => p - q);
          const brightest = lums[Math.floor(lums.length * 0.9)] ?? 1;
          const ink = rgbOf(b?.colour ?? '');
          const inkLum = lum(
            Number.parseInt(ink.slice(1, 3), 16),
            Number.parseInt(ink.slice(3, 5), 16),
            Number.parseInt(ink.slice(5, 7), 16),
          );
          const ratio = (Math.max(inkLum, brightest) + 0.05) / (Math.min(inkLum, brightest) + 0.05);
          test
            .info()
            .annotations.push({ type: 'contrast', description: `${b?.sel} ${ratio.toFixed(2)}` });
          expect(ratio, `${b?.sel} over the ${name} picture`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }

    test('every picture with its words, each loaded once in view', async ({ page }) => {
      await page.goto('/?hour=18');
      await settled(page);
      const imgs = page.locator('img');
      const n = await imgs.count();
      expect(n).toBeGreaterThan(20);
      for (let i = 0; i < n; i++) {
        const img = imgs.nth(i);
        const alt = await img.getAttribute('alt');
        expect(alt, await img.evaluate((e: HTMLImageElement) => e.outerHTML)).not.toBeNull();
        // Only the glyphs beside their own names, and the medals, are without words.
        if (alt === '') {
          expect(await img.getAttribute('src')).toMatch(/\.webp$/);
          continue;
        }
        expect((alt ?? '').length).toBeGreaterThan(10);
      }
      // Scrolled through, every picture is drawn, the world's chart among them.
      for (
        let y = 0;
        y < (await page.evaluate(() => document.body.scrollHeight));
        y += screen.height
      ) {
        await page.evaluate((to) => window.scrollTo(0, to), y);
        await page.waitForTimeout(40);
      }
      await page.waitForFunction(
        () =>
          [...document.images].every((i) => i.complete && i.naturalWidth > 0) &&
          document.images.length > 20,
        null,
        { timeout: 20_000 },
      );
    });
  });
}

test.describe('the hour’s colours', () => {
  for (const { hour, name } of HOURS) {
    test(`${name}: the step’s colours on the page, the titles and the keys readable`, async ({
      page,
    }) => {
      await page.goto(`/?hour=${hour}`);
      const colours = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        const names = [
          'ground',
          'ground-deep',
          'glow',
          'case',
          'case-deep',
          'ink',
          'faint',
          'title',
          'key',
          'key-deep',
          'key-ink',
        ];
        const key = document.querySelector('.ends .key');
        const h2 = document.querySelector('#race-title');
        return {
          vars: Object.fromEntries(names.map((n) => [n, s.getPropertyValue(`--${n}`).trim()])),
          h2: h2 === null ? '' : getComputedStyle(h2).color,
          key: key === null ? '' : getComputedStyle(key).color,
        };
      });
      const p: Palette = paletteAt(hour);
      expect(p).toEqual(PALETTES[name]);
      expect(colours.vars.ground).toBe(p.ground);
      expect(colours.vars.title).toBe(p.title);
      expect(colours.vars.ink).toBe(p.ink);
      expect(rgbOf(colours.h2)).toBe(p.title);
      expect(rgbOf(colours.key)).toBe(p.keyInk);
      for (const g of ['ground', 'ground-deep', 'glow', 'case', 'case-deep']) {
        for (const ink of ['ink', 'faint', 'title']) {
          expect(
            contrast(colours.vars[ink] ?? '', colours.vars[g] ?? ''),
            `${ink} on ${g}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(colours.vars['key-ink'] ?? '', colours.vars.key ?? ''),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(colours.vars['key-ink'] ?? '', colours.vars['key-deep'] ?? ''),
      ).toBeGreaterThanOrEqual(4.5);
      // Set sail's words on its gold, at the foot of its gradient, the darkest.
      expect(contrast('#1c140a', '#b8862f')).toBeGreaterThanOrEqual(4.5);
      expect(openingAt(hour)).toBe(name);
    });
  }

  test('the script keeps the hour asked for, once a minute', async ({ page }) => {
    await page.clock.install();
    await page.goto('/?hour=17.2');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-sky', String(skyStep(17.2)));
    await page.evaluate(() => {
      document.documentElement.dataset.sky = 'x';
    });
    await page.clock.fastForward(61_000);
    await expect(html).toHaveAttribute('data-sky', String(skyStep(17.2)));
  });
});

test.describe('without script', () => {
  test.use({ javaScriptEnabled: false });

  test('whole but for the countdown, the numbers, Copy and Google Calendar', async ({ page }) => {
    await page.goto('/?hour=12');
    for (const name of [
      'Race',
      'Sail together',
      'Pick your boat',
      'Storms, squalls and fog',
      'The world now',
      'What waits out there',
      'Watch sailors live',
      'Put your AI at the helm',
    ]) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Set sail' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apple or Outlook' })).toHaveAttribute(
      'href',
      '/next.ics',
    );
    await expect(page.getByRole('link', { name: 'Add to Claude' })).toHaveAttribute(
      'href',
      claudeLink(),
    );
    await expect(page.locator('#mcp')).toHaveText('https://agents.keelovertheedge.com/mcp');
    await expect(page.locator('html')).toHaveAttribute('data-sky', String(skyStep(12)));
    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll('[hidden]')].map((e) => e.id).sort(),
    );
    expect(hidden).toEqual(['as-of', 'clock', 'copy', 'google', 'numbers', 'resting']);
  });
});

test.describe('with script', () => {
  test('the countdown, the numbers, Copy and Google Calendar shown, from /live', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?hour=12');
    const timer = page.getByRole('timer', { name: 'This world ends in' });
    await expect(timer).toBeVisible();
    await expect(timer).toContainText(/\d+\s+days?\s+\d{2}\s+hours?\s+\d{2}\s+minutes?/);
    await expect(page.locator('#when')).toContainText('Sunday 6 pm New York time: for you,');
    await expect(page.locator('#numbers')).toBeVisible();
    await expect(page.locator('#at-sea')).toHaveText('23');
    await expect(page.locator('#machines')).toHaveText('6');
    await expect(page.locator('#as-of')).toContainText(/^World \d+ · as of /);
    await expect(page.locator('#resting')).toBeHidden();
    const google = new URL(
      (await page.getByRole('link', { name: 'Google Calendar' }).getAttribute('href')) ?? '',
    );
    expect(google.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU');
    expect(google.searchParams.get('ctz')).toBe('America/New_York');
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://agents.keelovertheedge.com/mcp',
    );
  });

  test('the sea resting: the chart as it was, the numbers away, said kindly', async ({ page }) => {
    await page.route('/live', (r) => r.fulfill({ json: { resting: true } }));
    await page.goto('/?hour=12');
    await expect(page.locator('#resting')).toBeVisible();
    await expect(page.locator('#numbers')).toBeHidden();
    await expect(page.getByRole('timer')).toBeHidden();
  });

  test('the keys into the game and the AI apps', async ({ page }) => {
    await page.goto('/');
    for (const go of await page.getByRole('link', { name: 'Set sail' }).all()) {
      await expect(go).toHaveAttribute('href', 'https://play.keelovertheedge.com/');
    }
    await expect(page.getByRole('link', { name: 'Watch sailors live' })).toHaveAttribute(
      'href',
      'https://play.keelovertheedge.com/?watch',
    );
    await expect(page.getByRole('link', { name: 'Pick one for me' })).toHaveAttribute(
      'href',
      'https://play.keelovertheedge.com/?watch=pick',
    );
    await expect(page.getByRole('link', { name: 'Add to Claude' })).toHaveAttribute(
      'href',
      claudeLink(),
    );
    await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute(
      'href',
      cursorLink(),
    );
    await expect(page.getByRole('link', { name: 'Add to VS Code' })).toHaveAttribute(
      'href',
      vscodeLink(),
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      'https://keelovertheedge.com/share.png',
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );
  });
});

test.describe('the page’s weight', () => {
  test('the page, its style, script and fonts under 150 KB; the opening under 120 KB on a phone and 250 KB on a desktop', () => {
    const files = readdirSync(new URL('assets/', out)).map((f) => ({
      f,
      bytes: statSync(new URL(`assets/${f}`, out)).size,
    }));
    const of = (re: RegExp) => files.filter((x) => re.test(x.f)).reduce((s, x) => s + x.bytes, 0);
    const page = statSync(new URL('index.html', out)).size + of(/\.(css|js|woff2)$/);
    expect(page).toBeLessThan(150_000);
    const manifest = JSON.parse(
      readFileSync(new URL('../../art/website/manifest.json', import.meta.url), 'utf8'),
    ) as { pictures: Record<string, { files: { avif: { width: number; bytes: number }[] } }> };
    for (const hour of ['night', 'dawn', 'day', 'dusk']) {
      const upright = manifest.pictures[`edge-${hour}-upright`]?.files.avif ?? [];
      const wide = manifest.pictures[`edge-${hour}`]?.files.avif ?? [];
      expect(Math.max(...upright.map((f) => f.bytes))).toBeLessThan(120_000);
      expect(Math.max(...wide.map((f) => f.bytes))).toBeLessThan(250_000);
    }
  });

  test.describe('on the owner’s phone', () => {
    test.use({
      viewport: { width: 360, height: 640 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    test('the first screen under 300 KB, at the brightest hour', async ({ page }) => {
      const sizes = new Map<string, number>();
      page.on('response', async (r) => {
        try {
          sizes.set(r.url(), (await r.body()).length);
        } catch {
          // A redirect has no body.
        }
      });
      await page.goto('/?hour=12');
      await settled(page);
      await page.waitForLoadState('networkidle');
      // What the first screen draws: all but the pictures that wait to be
      // near, which the browser may fetch early when the screen is idle,
      // below it.
      const below = await page.evaluate(() =>
        [...document.images]
          .filter(
            (i) => i.loading === 'lazy' && i.getBoundingClientRect().top >= window.innerHeight,
          )
          .map((i) => i.currentSrc),
      );
      const first = [...sizes.entries()].filter(([u]) => !below.includes(u));
      const total = first.reduce((s, [, n]) => s + n, 0);
      expect([...sizes.keys()].some((u) => u.includes('edge-day-upright-'))).toBe(true);
      expect(total, first.map(([u, n]) => `${n} ${u}`).join('\n')).toBeLessThan(300_000);
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// The page served in the hour's light: the Worker names the hour's step of
// the colours and its opening picture on the page, from the sky's clock or
// the hour the address asks for, and never waits for keel.

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as bindings } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import catalog from '../../../client/src/catalog/catalog.gen.json';
import { hourAt, openingAt, skyStep } from '../../site/src/sky';
import { CSP } from '../src/headers';
import { answer, type Env, type Outside } from '../src/index';

/** The built page's shape, small: the hours' pictures as data, and the opening's elements. */
const PAGE = `<!doctype html>
<html lang="en-GB"><head>
<script type="application/json" id="openings">${JSON.stringify(
  Object.fromEntries(
    ['night', 'dawn', 'day', 'dusk'].map((h) => [
      h,
      {
        'upright avif': `/assets/${h}-u.avif 800w`,
        'upright jpeg': `/assets/${h}-u.jpg 800w`,
        'wide avif': `/assets/${h}-w.avif 800w`,
        'wide jpeg': `/assets/${h}-w.jpg 800w`,
        src: `/assets/${h}-w.jpg`,
        alt: `The boat at the edge, ${h}.`,
      },
    ]),
  ),
)}</script>
</head><body>
<picture class="opening-picture">
<source data-o="upright avif" media="(orientation: portrait)" type="image/avif" srcset="/assets/dusk-u.avif 800w" sizes="100vw">
<source data-o="upright jpeg" media="(orientation: portrait)" type="image/jpeg" srcset="/assets/dusk-u.jpg 800w" sizes="100vw">
<source data-o="wide avif" type="image/avif" srcset="/assets/dusk-w.avif 800w" sizes="100vw">
<img data-o="wide jpeg" src="/assets/dusk-w.jpg" srcset="/assets/dusk-w.jpg 800w" sizes="100vw" alt="The boat at the edge, dusk." fetchpriority="high">
</picture>
<picture><source srcset="/assets/race.avif 800w"><img src="/assets/race.jpg" alt="The race."></picture>
</body></html>`;

const SKY = { day: catalog.sky.day, epoch: catalog.sky.epoch, sunAtEpoch: catalog.sky.sunAtEpoch };

function env(): Env {
  return {
    ASSETS: {
      fetch: async () =>
        new Response(PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"built"' },
        }),
    },
    WEBSITE: bindings.WEBSITE,
    STATUS_URL: 'https://play.keelovertheedge.com/api/status',
    ACCESS_CLIENT_ID: 'id',
    ACCESS_CLIENT_SECRET: 'secret',
  };
}

/** keel never asked: the page does not wait for it. */
function outside(now: number): Outside & { asked: number } {
  const o = {
    asked: 0,
    fetch: (async () => {
      o.asked++;
      return new Response('', { status: 503 });
    }) as typeof fetch,
    now: () => now,
    cache: () => (caches as unknown as { default: Cache }).default,
  };
  return o;
}

async function page(path: string, now: number) {
  const out = outside(now);
  const ctx = createExecutionContext();
  const r = await answer(new Request(`https://keelovertheedge.com${path}`), env(), ctx, out);
  const html = await r.text();
  await waitOnExecutionContext(ctx);
  return { r, html, asked: out.asked };
}

function root(html: string): { sky: string; opening: string } {
  const tag = /<html[^>]*>/.exec(html)?.[0] ?? '';
  return {
    sky: /data-sky="([^"]*)"/.exec(tag)?.[1] ?? '',
    opening: /data-opening="([^"]*)"/.exec(tag)?.[1] ?? '',
  };
}

describe('the page in the hour’s light', () => {
  test('the sky’s hour now: its step and its picture, keel never asked', async () => {
    // A moment of the sky's day at each hour: from the sky's first moment, noon.
    const day = SKY.day * 60_000;
    for (const [h, name] of [
      [2, 'night'],
      [6, 'dawn'],
      [12, 'day'],
      [18, 'dusk'],
    ] as const) {
      const now = SKY.epoch * 1000 + (((h - 12 + 24) % 24) / 24) * day + 1000 * day;
      expect(hourAt(now, SKY)).toBeCloseTo(h, 6);
      const { html, asked } = await page('/', now);
      expect(root(html)).toEqual({ sky: String(skyStep(h)), opening: name });
      expect(asked).toBe(0);
      // The opening picture, every source, is the hour's.
      expect(html).toContain(`srcset="/assets/${name}-u.avif 800w"`);
      expect(html).toContain(`srcset="/assets/${name}-u.jpg 800w"`);
      expect(html).toContain(`srcset="/assets/${name}-w.avif 800w"`);
      expect(html).toContain(`src="/assets/${name}-w.jpg"`);
      expect(html).toContain(`alt="The boat at the edge, ${name}."`);
      if (name !== 'dusk') {
        expect(html.slice(html.indexOf('</head>'))).not.toContain('dusk-');
      }
      // Other pictures as they were.
      expect(html).toContain('<source srcset="/assets/race.avif 800w">');
    }
  });

  test('the hour the address asks for', async () => {
    const now = Date.parse('2026-11-17T21:30:00Z');
    for (const h of [0.5, 5.3, 6.9, 8.6, 16.9, 17.92, 19]) {
      const { html } = await page(`/?hour=${h}`, now);
      expect(root(html)).toEqual({ sky: String(skyStep(h)), opening: openingAt(h) });
    }
    // Nonsense is the sky's own hour.
    const { html } = await page('/?hour=noon', now);
    expect(root(html).sky).toBe(String(skyStep(hourAt(now, SKY))));
  });

  test('never kept as the file is, with the security headers', async () => {
    const { r } = await page('/', Date.parse('2026-11-17T21:30:00Z'));
    expect(r.status).toBe(200);
    expect(r.headers.get('ETag')).toBeNull();
    expect(r.headers.get('Cache-Control')).toBe('no-cache');
    expect(r.headers.get('Content-Security-Policy')).toBe(CSP);
  });
});

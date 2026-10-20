// SPDX-License-Identifier: AGPL-3.0-only

// Not tracked: the world page's frames, long tasks and layout shifts beside a sailor's page.

import { test } from '@playwright/test';
import { guest, sail } from './helpers';

test('owner page probe', async ({ browser, page }) => {
  test.skip(test.info().project.name !== 'webgl2');
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 320, height: 200 } });
  const sailor = await context.newPage();
  await guest(context, 'Owner');
  await sail(sailor);
  await page.goto('http://localhost:5184/owner/');
  await page.waitForSelector('section[aria-label="Boats at sea"]');
  await page.waitForTimeout(5000);
  const r = await page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const longs: number[] = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) longs.push(Math.round(e.duration));
        }).observe({ type: 'longtask', buffered: false });
        const el = document.querySelector('section[aria-label="Boats at sea"]') as HTMLElement;
        let frames = 0;
        let moves = 0;
        let last = el.getBoundingClientRect().top;
        const tops = new Set<number>();
        const t0 = performance.now();
        const step = () => {
          frames++;
          const top = el.getBoundingClientRect().top;
          tops.add(Math.round(top));
          if (top !== last) moves++;
          last = top;
          if (performance.now() - t0 < 20000) requestAnimationFrame(step);
          else
            resolve({
              frames,
              moves,
              tops: [...tops],
              longs,
              longSum: longs.reduce((a, b) => a + b, 0),
            });
        };
        requestAnimationFrame(step);
      }),
  );
  console.log('PROBE', JSON.stringify(r));
  await context.close();
});

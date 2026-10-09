// SPDX-License-Identifier: AGPL-3.0-only

// The game through tools/lag at 200 ms round trip and 2% of packets lost
// each way (tools/e2e runs the proxy; a Vite of its own on port 5182 sends
// the game's traffic through it), or through netem (KEEL_LAG_BASE): a sail with the tiller dragged to and fro
// draws no correction over the snap thresholds, and the boat still answers
// the helm on the frame it is moved.

import { expect, test } from '@playwright/test';
import { guest, sail } from './helpers';

// CI's netem job sends the page's traffic through the kernel's own delay
// and loss instead, by the direct Vite.
const lagged = process.env.KEEL_LAG_BASE ?? 'http://localhost:5182';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

test('at 200 ms and 2% loss: no correction over the snap thresholds', async ({ page, context }) => {
  test.setTimeout(120_000);
  await guest(context, 'Lagged');
  await sail(page, lagged);
  await page.evaluate(() => globalThis.keel.script('wiggle'));
  await page.waitForTimeout(40_000);
  const n = await page.evaluate(() => globalThis.keel.net());
  const measured = `${n.counts.snapshots} snapshots, ${n.counts.corrections} corrections (largest ${n.counts.largest.toFixed(3)} m, 95th percentile ${n.p95.toFixed(3)} m), ${n.counts.resets} resets, ${n.counts.stale} stale, m ${n.m}, round trip ${n.rtt.toFixed(0)} ms, ${n.traffic.bytesIn} B in, ${n.traffic.bytesOut} B out`;
  test.info().annotations.push({ type: 'measured', description: measured });
  process.stdout.write(`lag.spec: ${measured}\n`);
  expect(n.rtt).toBeGreaterThan(150);
  expect(n.counts.snapshots).toBeGreaterThan(400);
  expect(n.counts.largest).toBeLessThan(3);
});

test('the boat answers the helm on the frame it is moved', async ({ page, context }) => {
  await guest(context, 'Helmsman');
  await sail(page, lagged);
  await page.evaluate(() => globalThis.keel.setControls(0, 0.5));
  await page.waitForTimeout(1_000);
  const before = await page.evaluate(() => globalThis.keel.boat().state.rudder);
  await page.evaluate(async () => {
    globalThis.keel.setControls(1, 0.5);
    // A step is taken every thirtieth of a second: at 60 frames a second,
    // one of the next two frames takes it.
    await globalThis.keel.frames(2);
  });
  // The step taken within a tick turned the rudder: no round trip.
  const after = await page.evaluate(() => globalThis.keel.boat().state.rudder);
  expect(after).not.toBe(before);
});

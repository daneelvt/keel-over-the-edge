// SPDX-License-Identifier: AGPL-3.0-only

// Two players sailing together, each in a browser context of its own,
// against keel (tools/e2e): each sees the other's boat fade in where the
// server has it at the tick it is drawn at; one steers and the other sees
// it turn; one closes its page and the other still sees its boat, sailing
// on through its grace. Through tools/lag at 200 ms and 2% loss (or netem,
// KEEL_LAG_BASE): for a minute no near boat is held in more than 1% of
// frames, and no correction of another boat is drawn at once.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { guest, sail } from './helpers';

const direct = 'http://localhost:5181';
const lagged = process.env.KEEL_LAG_BASE ?? 'http://localhost:5182';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

/** Two players, each sailing in a context of its own. */
async function two(browser: import('@playwright/test').Browser, base = direct) {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (const name of ['Ann', 'Bob']) {
    const c = await browser.newContext({ baseURL: base, viewport: { width: 640, height: 400 } });
    await guest(c, name);
    const p = await c.newPage();
    await sail(p, base);
    contexts.push(c);
    pages.push(p);
  }
  return { contexts, a: pages[0] as Page, b: pages[1] as Page };
}

/**
 * The other player's boat as a draws it, and where b's own prediction has
 * it at the same tick: the boat a draws nearest to b's.
 */
async function seen(a: Page, b: Page) {
  const fleet = await a.evaluate(() => globalThis.keel.fleet());
  const own = await b.evaluate(() => globalThis.keel.boat().state);
  let best = null as (typeof fleet.boats)[number] | null;
  for (const boat of fleet.boats) {
    if (boat.slot < 0) {
      continue;
    }
    const d = Math.hypot(boat.east - own.x, boat.north - own.y);
    if (best === null || d < Math.hypot(best.east - own.x, best.north - own.y)) {
      best = boat;
    }
  }
  if (best === null) {
    return null;
  }
  const tick = best.tick;
  const truth = await b.evaluate(
    (t) => [globalThis.keel.ownAt(t.lo), globalThis.keel.ownAt(t.hi)],
    { lo: Math.floor(tick), hi: Math.ceil(tick) },
  );
  const [t0, t1] = truth;
  if (t0 === null || t1 === null || t0 === undefined || t1 === undefined) {
    return { boat: best, truth: null };
  }
  const f = tick - Math.floor(tick);
  const turn = Math.atan2(Math.sin(t1.heading - t0.heading), Math.cos(t1.heading - t0.heading));
  return {
    boat: best,
    truth: {
      east: t0.east + (t1.east - t0.east) * f,
      north: t0.north + (t1.north - t0.north) * f,
      heading: t0.heading + turn * f,
    },
  };
}

function headingOff(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

test('two players see each other, steer, and one leaves', async ({ browser }) => {
  test.setTimeout(120_000);
  const { contexts, a, b } = await two(browser);
  await b.evaluate(() => globalThis.keel.setControls(0.2, 0.4));
  // Each sees the other, faded in, where the server has it at the tick it
  // is drawn at.
  for (const [viewer, sailor] of [
    [a, b],
    [b, a],
  ] as const) {
    let s = await seen(viewer, sailor);
    for (let i = 0; i < 40 && (s === null || s.truth === null || s.boat.opacity < 1); i++) {
      await viewer.waitForTimeout(250);
      s = await seen(viewer, sailor);
    }
    expect(s?.truth, 'the other boat at its tick').not.toBeNull();
    if (s === null || s.truth === null) {
      return;
    }
    expect(s.boat.opacity).toBe(1);
    expect(Math.hypot(s.boat.east - s.truth.east, s.boat.north - s.truth.north)).toBeLessThan(1);
    expect(headingOff(s.boat.heading, s.truth.heading)).toBeLessThan((5 * Math.PI) / 180);
  }
  // Bob puts the helm over: Ann sees the boat turn as Bob's own does.
  const before = (await seen(a, b))?.boat.heading ?? 0;
  await b.evaluate(() => globalThis.keel.setControls(1, 0.5));
  await a.waitForTimeout(6_000);
  const turned = await seen(a, b);
  expect(turned?.truth).not.toBeNull();
  if (turned === null || turned.truth === null) {
    return;
  }
  expect(headingOff(turned.boat.heading, before)).toBeGreaterThan((10 * Math.PI) / 180);
  expect(headingOff(turned.boat.heading, turned.truth.heading)).toBeLessThan((5 * Math.PI) / 180);
  // Bob closes his page: his boat sails on through its grace, and Ann
  // still sees it.
  const last = await b.evaluate(() => globalThis.keel.boat().state);
  await contexts[1]?.close();
  await a.waitForTimeout(5_000);
  const fleet = await a.evaluate(() => globalThis.keel.fleet());
  const near = fleet.boats.filter(
    (boat) => boat.slot >= 0 && Math.hypot(boat.east - last.x, boat.north - last.y) < 60,
  );
  expect(near.length).toBeGreaterThan(0);
  await contexts[0]?.close();
});

// Tagged @long: a minute watched, and more to start; pr.render runs it in a
// job of its own.
test('at 200 ms and 2% loss: no near boat held in more than 1% of frames', {
  tag: '@long',
}, async ({ browser }) => {
  test.setTimeout(180_000);
  const { contexts, a, b } = await two(browser, lagged);
  await b.evaluate(() => globalThis.keel.script('wiggle'));
  // Let the delays find the lateness, then watch a minute.
  await a.waitForTimeout(10_000);
  const w = await a.evaluate(async () => {
    const started = performance.now();
    const r = await globalThis.keel.fleetWatch(3600);
    return { ...r, seconds: (performance.now() - started) / 1000 };
  });
  const n = await a.evaluate(() => globalThis.keel.net());
  const f = await a.evaluate(() => globalThis.keel.fleet());
  const measured = `${w.frames} frames in ${w.seconds.toFixed(0)} s, ${w.nearFrames} with a near boat: held in ${w.held} (${w.timeoutHeld} of them in retransmission timeouts; spells of ${w.spells.join(', ')}), carried on in ${w.extrapolated}; largest step ${w.largestStep.toFixed(2)} m, ${w.jumps} over 0.5 m; delays up to ${w.nearDelay.toFixed(0)} ms near, ${w.farDelay.toFixed(0)} ms far; round trip ${n.rtt.toFixed(0)} ms, ${n.traffic.bytesIn} B in, ${n.traffic.bytesOut} B out, ${n.traffic.resyncs} resyncs; entries ${f.stats.entries.toFixed(1)} a second`;
  test.info().annotations.push({ type: 'measured', description: measured });
  process.stdout.write(`together.spec: ${measured}\n`);
  expect(n.rtt).toBeGreaterThan(150);
  expect(w.nearFrames).toBeGreaterThan(w.frames * 0.9);
  // Stalls behind a lost segment are covered, all but 1% of frames; a
  // retransmission timeout's, over a second, is not, and is reported.
  expect(w.held - w.timeoutHeld).toBeLessThanOrEqual(w.frames * 0.01);
  expect(w.jumps).toBe(0);
  for (const c of contexts) {
    await c.close();
  }
});

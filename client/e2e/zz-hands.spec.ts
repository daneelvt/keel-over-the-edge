// SPDX-License-Identifier: AGPL-3.0-only
import { type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const OUT = '/private/tmp/claude-501/-Users-daneel-dev-keel-over-the-edge-design/b4b95c91-8657-4f1b-8e5f-d371c4673fd9/scratchpad/pics82c';
test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });

async function fly(page: Page, eye: number[], at: number[]) {
  await page.evaluate(async ({ eye, at }) => {
    const k = globalThis.keel;
    const s = k.boat().state;
    const h = s.heading;
    const w = (p: number[]) => ({ east: s.x + p[0] * Math.cos(h) - p[2] * Math.sin(h), north: s.y - p[0] * Math.sin(h) - p[2] * Math.cos(h), up: p[1] });
    const e = w(eye); const t = w(at);
    const bearing = (Math.atan2(t.east - e.east, t.north - e.north) * 180) / Math.PI;
    const pitch = (Math.atan2(t.up - e.up, Math.hypot(t.east - e.east, t.north - e.north)) * 180) / Math.PI;
    if (k.freeCam().on) k.landCamera();
    k.fly({ east: e.east, north: e.north, height: e.up, bearing, pitch });
    await k.show();
  }, { eye, at });
}
/** Seconds of sailing, so many ticks a frame; the crew then. */
const sail = (page: Page, seconds: number, steps = 3) =>
  page.evaluate(({ seconds, steps }) => {
    const k = globalThis.keel;
    for (let i = 0; i < (seconds * 30) / steps; i++) {
      k.sailFrames(1, steps);
    }
    const c = k.crew();
    const st = k.boat().state;
    return { aground: k.boat().out.aground, depth: k.boat().out.depth.toFixed(1), steps: k.boat().steps, x: st.x.toFixed(1), hd: (st.heading * 57.3).toFixed(0), v: st.surge?.toFixed(2), pilot: k.hud?.().pilot ?? null, yards: (st.yards * 57.3).toFixed(1), fore: (st.foreYards * 57.3).toFixed(1), reef: st.reef?.toFixed(2), gang: c.gang, aloftBand: c.aloftBand, braces: c.braces, work: c.members.filter((m) => m.work != null).map((m) => `${m.seat}:${m.work?.kind[0]}${m.work?.phase[0]}${(m.work?.pull ?? 0).toFixed(1)}`).join(' '), clips: [...new Set(c.heads.map((h) => h.clip))].join(',') };
  }, { seconds, steps });

async function start(page: Page) {
  await openScene(page, 'boat=tall-ship');
  page.on('console', (m) => console.log('PAGE', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('PAGEERR', e.message, e.stack?.slice(0, 600)));
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setWind(16, 0);
    await k.showCrew(40, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
    k.setControls(0, 0.2);
  });
  console.log(JSON.stringify(await sail(page, 30, 3)).slice(0, 140));
  await page.evaluate(() => globalThis.keel.autopilot('wind'));
  console.log(JSON.stringify(await sail(page, 20, 3)).slice(0, 140));
}

test('a tack', async ({ page }) => {
  test.setTimeout(400_000);
  await start(page);
  await page.evaluate(() => globalThis.keel.autopilot('tack'));
  const views: Record<number, [string, number[], number[]][]> = {
    50: [['qd', [-9, 10, 16], [-3, 5, 9]], ['qd2', [-1, 8, 4], [-3, 5.5, 11]], ['top', [0, 40, 8], [0, 3, 2]], ['waist', [-9, 8, -1], [-3, 3, 2]]],
    75: [['waist', [-10, 9, -1], [-3, 3, -4]], ['waist2', [-1, 7, 4], [-3.4, 3.8, -4]], ['top', [0, 40, 8], [0, 3, 2]]],
    86: [['waist', [-10, 9, -1], [-3, 3, -4]]],
  };
  let t = 0;
  for (let i = 0; i < 90; i++) {
    await sail(page, 1, 3);
    t += 1;
    for (const [name, eye, at] of views[t] ?? []) {
      await fly(page, eye, at);
      await page.screenshot({ path: `${OUT}/tack-${t}-${name}.png` });
      await page.evaluate(() => globalThis.keel.landCamera());
    }
  }
});

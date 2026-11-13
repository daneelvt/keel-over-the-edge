// SPDX-License-Identifier: AGPL-3.0-only
import { test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { openScene } from './helpers';

test.use({ viewport: { width: 360, height: 640 } });

test('measure all hands', async ({ page }) => {
  test.setTimeout(900_000);
  const ship = data.boats.findIndex((b) => b.capacity >= 40);
  await openScene(page, 'boat=tall-ship');
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setSky(12);
    k.setWind(16, 0);
    k.setControls(0, 0.2);
  });
  const cdp = await page.context().newCDPSession(page);
  const results: string[] = [];
  const window = async (label: string, rate: number) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      const w = k.world;
      const out: number[] = [];
      const crew: { ms: number; posed: number; frames: number }[] = [];
      for (let i = 0; i < 4; i++) {
        w.crew.stats = { frames: 0, posed: 0, ms: 0 };
        w.crews.stats = { frames: 0, posed: 0, ms: 0 };
        await new Promise((res) => setTimeout(res, 2000));
        out.push(w.stats.last.workMedian);
        crew.push({
          ms: (w.crew.stats.ms + w.crews.stats.ms) / Math.max(1, w.crew.stats.frames),
          posed: (w.crew.stats.posed + w.crews.stats.posed) / Math.max(1, w.crew.stats.frames),
          frames: w.crew.stats.frames,
        });
      }
      const { drawCalls, triangles } = k.info();
      const c = k.crew();
      const walking = c.members.filter((m) => m.moving !== null).length;
      const hauling = c.members.filter((m) => m.work?.kind === 'haul' && m.work.phase === 'at').length;
      const aloft = c.members.filter((m) => m.work?.kind === 'aloft').length;
      return { work: out, crew, drawCalls, triangles, near: c.near, far: c.far, walking, hauling, aloft, gang: c.gang?.group ?? '-' };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const line = `${label} x${rate} ${JSON.stringify({ work: med(r.work)?.toFixed(2), works: r.work.map((x) => x.toFixed(2)), poseMs: med(r.crew.map((c) => c.ms))?.toFixed(3), posed: med(r.crew.map((c) => c.posed))?.toFixed(1), draws: r.drawCalls, tris: r.triangles, near: r.near, far: r.far, walking: r.walking, hauling: r.hauling, aloft: r.aloft, gang: r.gang })}`;
    console.log(line);
    results.push(line);
  };
  const both = async (label: string) => {
    await window(label, 1);
    await window(label, 4);
  };
  const waitFor = (what: string, ms = 120000) =>
    page.waitForFunction((what) => {
      const c = globalThis.keel.crew();
      if (what === 'after') return c.gang?.group === 'after';
      if (what === 'fore') return c.gang?.group === 'fore';
      if (what === 'idle') return c.gang === null && c.members.every((m) => m.moving === null && m.work == null);
      if (what === 'aloft') return c.members.filter((m) => m.work?.kind === 'aloft' && m.work.phase === 'at').length >= 6;
      return false;
    }, what, { timeout: ms, polling: 500 });
  const show = (n: number) => page.evaluate(async (n) => { const k = globalThis.keel; await k.showCrew(n, 0); await k.crewReady(); k.thaw(); }, n);
  const chase = () => page.evaluate(() => globalThis.keel.camera('chase'));
  await show(1); await chase();
  await page.waitForTimeout(30000);
  await page.evaluate(() => globalThis.keel.autopilot('wind'));
  await page.waitForTimeout(10000);
  await both('her helmsman alone, chase');
  await show(40); await chase(); await page.waitForTimeout(3000);
  await both('forty idling, chase');
  await page.evaluate(() => globalThis.keel.autopilot('tack'));
  await waitFor('after');
  await page.waitForTimeout(4000);
  await both('forty in a tack at the after braces, chase');
  await waitFor('fore');
  await page.waitForTimeout(2000);
  await both('forty at the head braces, chase');
  await waitFor('idle', 200000);
  await page.evaluate(() => globalThis.keel.setReef(1));
  await waitFor('aloft', 120000);
  await both('forty, the topmen aloft, chase');
  await page.evaluate(() => globalThis.keel.setReef(0));
  await waitFor('idle', 300000);
  // A port: two more crewed ships near.
  await page.evaluate(async (ship) => {
    const k = globalThis.keel;
    const from = k.world.wind.meanFrom;
    const me = k.boat().state;
    const at = (ahead: number, beam: number) => ({
      east: me.x + Math.sin(me.heading) * ahead + Math.cos(me.heading) * beam,
      north: me.y + Math.cos(me.heading) * ahead - Math.sin(me.heading) * beam,
    });
    const boat = (seed: number, ahead: number, beam: number) => {
      const { crew, look } = k.fleetCrew(40, 0, seed);
      return { kind: ship, crew, look, ...at(ahead, beam), heading: from - 1.2, yardsTurn: 0.4 };
    };
    k.setFleet([boat(3, 40, 30), boat(4, -30, -35)]);
    await k.fleetLoaded();
    await k.fleetCrewsReady();
    k.thaw();
  }, ship);
  await page.waitForTimeout(3000);
  await both('port of three, chase');
  await page.evaluate(() => globalThis.keel.autopilot('tack'));
  await waitFor('after');
  await page.waitForTimeout(4000);
  await both('port of three, her hands at the after braces, chase');
  console.log('RESULTS\n' + results.join('\n'));
});

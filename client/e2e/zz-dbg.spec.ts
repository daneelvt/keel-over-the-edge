// SPDX-License-Identifier: AGPL-3.0-only
import { test } from '@playwright/test';
import { openScene } from './helpers';
test('dbg', async ({ page }) => {
  await openScene(page, 'boat=tall-ship');
  page.on('console', (m) => console.log('PAGE', m.text().slice(0, 200)));
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setWind(16, 0);
    await k.showCrew(40, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
    k.setControls(0, 0.2);
    const out = [];
    const p = () => { const b = k.boat(); out.push([b.steps, b.state.x.toFixed(2), (b.state.heading * 57.3).toFixed(1), b.state.surge.toFixed(2), (b.state.yards * 57.3).toFixed(1), b.pilot.mode, b.pilot.order, b.pilot.way].join(' ')); };
    for (let i = 0; i < 30; i++) k.sailFrames(10, 3);
    p();
    k.autopilot('wind');
    for (let i = 0; i < 10; i++) k.sailFrames(10, 3);
    p();
    k.autopilot('tack');
    for (let i = 0; i < 10; i++) { k.sailFrames(10, 3); p(); }
    return out;
  });
  console.log(r.join('\n'));
});

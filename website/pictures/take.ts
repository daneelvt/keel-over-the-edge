// SPDX-License-Identifier: AGPL-3.0-only

// Takes the website's pictures from the game itself, and encodes the ones
// the page shows. Run by hand on a Mac with Chrome installed, never on CI
// (CI draws on a software GPU, at the lowest rung):
//
//   cd website && npm run pictures                  every take, then encode
//   npm run pictures -- --only edge-dusk,race       takes whose id starts so
//   npm run pictures -- --encode                    encode the raw takes only
//   npm run pictures -- --takes                     list the takes and stop
//
// It starts the client's Vite on a free port (5290 to 5299) and stops it
// after, opens each take's page in the offline sandbox (?sandbox&test) on
// WebGPU at the best rung, stages it with the test hooks (takes.ts) and
// screenshots the scene into pictures/raw/<id>.png, which git ignores.
// Then each picture the page shows (pictures.ts) is encoded from its pick
// among the takes to art/website/, AVIF and JPEG at its widths, with the
// manifest the page reads (encode.ts). The world pictures need seed 1's
// world file: go run ./tools/dev -world 1 at the repository's root.

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from '@playwright/test';
import { encodeAll } from './encode.ts';
import { installKit } from './keel.ts';
import { type Take, takes } from './takes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
export const raw = join(here, 'raw');

/** A port of 5290 to 5299 nothing listens on. */
async function freePort(): Promise<number> {
  for (let port = 5290; port <= 5299; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) {
      return port;
    }
  }
  throw new Error('no free port from 5290 to 5299');
}

/** The client's Vite on port, over plain HTTP, once it answers. */
async function startVite(port: number): Promise<ChildProcess> {
  const env = { ...process.env };
  // A certificate tools/dev left in the environment would put Vite on https.
  delete env.KEEL_DEV_CERT;
  delete env.KEEL_DEV_KEY;
  const vite = spawn(
    'npx',
    ['--no-install', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: join(root, 'client'), env, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) {
        return vite;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  vite.kill();
  throw new Error('Vite did not answer in a minute');
}

/** Takes one picture: the page opened as the browser tests open the scene, staged, screenshot. */
async function shoot(browser: Browser, base: string, t: Take): Promise<string> {
  const context = await browser.newContext({
    viewport: { width: t.size.width, height: t.size.height },
    deviceScaleFactor: t.size.scale,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?sandbox&test${t.query === '' ? '' : `&${t.query}`}`);
    await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => globalThis.keel.ready());
    const backend = await page.evaluate(() => globalThis.keel.info().backend);
    if (backend !== 'webgpu') {
      throw new Error(`drawn on ${backend}, not WebGPU`);
    }
    await page.evaluate(installKit);
    if (t.hud !== true) {
      await page.addStyleTag({ content: '.hud { visibility: hidden; }' });
    }
    await page.evaluate((time) => {
      const k = globalThis.keel;
      // The best rung, whatever the page's first seconds did.
      k.setRung(0);
      k.freeze(time);
      k.reset();
      k.render();
      k.camera('chase');
      k.render();
    }, t.time ?? 100);
    // Playwright hands the function's source to the page.
    const said = await page.evaluate(t.stage as (arg: unknown) => Promise<unknown>, t.arg ?? null);
    if (said !== undefined && said !== null) {
      console.warn(`${t.id} says ${JSON.stringify(said)}`);
    }
    await page.evaluate(() => globalThis.keel.show());
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    const file = join(raw, `${t.id}.png`);
    if (t.clip === undefined) {
      await page.locator('canvas.scene').screenshot({ path: file });
    } else {
      const clip = await page.evaluate(t.clip);
      await page.screenshot({ path: file, clip });
    }
    return file;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const only = value('--only')?.split(',') ?? [];
  const chosen = takes.filter((t) => only.length === 0 || only.some((o) => t.id.startsWith(o)));
  if (flag('--takes')) {
    for (const t of chosen) {
      console.warn(`${t.id}  ${t.size.width}×${t.size.height}@${t.size.scale}  ?${t.query}`);
    }
    return;
  }
  if (!flag('--encode')) {
    if (!existsSync(join(root, '.dev', 'worlds', '1.world'))) {
      throw new Error('no world file for seed 1: run go run ./tools/dev -world 1');
    }
    mkdirSync(raw, { recursive: true });
    const port = await freePort();
    const vite = await startVite(port);
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'],
    });
    const failed: string[] = [];
    try {
      for (const t of chosen) {
        const started = Date.now();
        try {
          await shoot(browser, `http://127.0.0.1:${port}`, t);
          console.warn(`${t.id}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
        } catch (e) {
          failed.push(t.id);
          console.error(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      await browser.close();
      vite.kill();
    }
    if (failed.length > 0) {
      throw new Error(`${failed.length} takes failed: ${failed.join(', ')}`);
    }
    if (only.length > 0 && !flag('--then-encode')) {
      return;
    }
  }
  await encodeAll(raw, join(root, 'art', 'website'));
}

await main();

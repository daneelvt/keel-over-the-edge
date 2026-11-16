// SPDX-License-Identifier: AGPL-3.0-only

// The browser tests of the built page, as players load it: keel serves
// client/dist itself (tools/e2e -client), as the image does, with the
// world's land on, behind tools/e2e's stand-in for Cloudflare's edge,
// which compresses what Cloudflare would; and the page is opened at / with
// no test hooks. Build it first:
//
//   npx vite build && npx playwright test -c playwright.built.config.ts
//
// One project, built, on Chromium, one test at a time against the one keel.
// A test that needs another build served restarts keel on it through
// tools/e2e's POST http://127.0.0.1:19099/restart?client=<dir>, the
// directory from the repository's root. The page draws as on a phone, on
// the GPU the webgl2 project draws on (on Linux, Mesa's lavapipe); WebGPU
// is not offered, which on Linux would be SwiftShader's, five times slower.

import { defineConfig, devices } from '@playwright/test';
import { chromiumArgs, chromiumEnv } from './e2e/gpu';

/** The built page's spec files: the main config's projects leave them out. */
export const builtFiles = ['critical'].map((n) => `${n}.spec.ts`);

const linux = process.platform === 'linux';

export default defineConfig({
  testDir: 'e2e',
  testMatch: builtFiles,
  timeout: 180_000,
  expect: { timeout: linux ? 30_000 : 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['./e2e/summary.ts']] : 'list',
  use: {
    // The stand-in for Cloudflare's edge, the built page's origin (tools/e2e -client).
    baseURL: 'http://localhost:18088',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'built',
      use: {
        ...devices['Desktop Chrome'],
        // A phone's screen, upright.
        viewport: { width: 360, height: 640 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
        launchOptions: {
          args: chromiumArgs(linux, 'lavapipe').filter((a) => a !== '--enable-unsafe-webgpu'),
          env: { ...process.env, ...chromiumEnv(linux, 'lavapipe') } as Record<string, string>,
        },
      },
    },
  ],
  webServer: [
    {
      command: 'go run ../tools/e2e -client client/dist -land',
      url: 'http://127.0.0.1:19090/readyz',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
    },
  ],
});

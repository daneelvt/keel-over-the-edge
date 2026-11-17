// SPDX-License-Identifier: AGPL-3.0-only

// The page's checks, in Chromium, served as production serves it: the
// built page (npm run site first) through the Worker under wrangler dev,
// keel's status from seed 1's recording (page/keel.ts) in place of the
// game's behind Access. Locally, PW_CHANNEL=chrome uses the installed
// Chrome instead of downloading Chromium.

import { defineConfig } from '@playwright/test';

const site = Number(process.env.WEBSITE_PORT ?? 5295);
const keel = Number(process.env.WEBSITE_KEEL_PORT ?? 5296);

export default defineConfig({
  testDir: 'page',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${site}`,
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: [
    {
      command: `node page/keel.ts ${keel}`,
      port: keel,
      reuseExistingServer: false,
    },
    {
      command: [
        'npx --no-install wrangler dev --local --ip 127.0.0.1',
        `--port ${site}`,
        `--var STATUS_URL:http://127.0.0.1:${keel}/api/status`,
        '--var ACCESS_CLIENT_ID:checks --var ACCESS_CLIENT_SECRET:checks',
      ].join(' '),
      url: `http://127.0.0.1:${site}/`,
      env: { WRANGLER_SEND_METRICS: 'false' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

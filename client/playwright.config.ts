// SPDX-License-Identifier: AGPL-3.0-only

// The browser tests: the scene in Chromium, on the WebGL 2 back end and, where
// the browser offers an adapter, on WebGPU. On Linux runners WebGPU goes
// through SwiftShader, the CPU's Vulkan. Locally, PW_CHANNEL=chrome uses the
// installed Chrome instead of downloading Chromium.
//
// Four servers: keel, built from this tree and serving a database of its
// own on the test database's server (tools/e2e), and Vite in front of it, as
// in development; a second Vite whose traffic to keel goes through the
// lag proxy tools/e2e runs, for the tests of a slow network; and the world
// page's Vite, in front of keel's internal listener. The WebKit
// project runs the test of the net worker's upgrade and the account's
// passkeys, up to the session, and the screen at sea's layout on phones,
// as Safari lays it out. The compat project
// runs the sea's tests on WebGPU with a device held to compatibility mode's
// limits (?compat), as the phones that offer only that have. The page's
// origin is http://localhost, where browsers allow the session's Secure
// cookie without a certificate.

import { defineConfig, devices } from '@playwright/test';

const port = 5181;
// A second Vite, whose game traffic goes through tools/e2e's lag proxy.
const laggedPort = 5182;
const keelLagged = '127.0.0.1:18090';
// A third, on https with a throwaway certificate: WebKit sends the session's
// Secure cookie to https only, even on localhost.
const securePort = 5183;
const tls = '../.dev/e2e/tls';
// tools/e2e's addresses for keel.
const keelPlay = '127.0.0.1:18080';
// Its listener for AI apps, the MCP address's.
const keelAgents = '127.0.0.1:18081';
const keelReady = 'http://127.0.0.1:19090/readyz';
// The world page, on its own Vite, its data from keel's internal listener.
const ownerPort = 5184;
const linux = process.platform === 'linux';
// pr.render splits a back end's short tests over two runners by spec file:
// SPECS names some files (sea,sail), and SPECS_HALF says which half this
// run is: 1, those files alone; 2, every file but those. Unset, all of them.
const halfSpecs = (process.env.SPECS ?? '')
  .split(',')
  .filter((n) => n !== '')
  .map((n) => `${n}.spec.ts`);
const half =
  halfSpecs.length === 0
    ? {}
    : process.env.SPECS_HALF === '1'
      ? { testMatch: halfSpecs }
      : process.env.SPECS_HALF === '2'
        ? { testIgnore: halfSpecs }
        : {};
const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
if (linux) {
  args.push(
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader',
    '--use-angle=swiftshader',
  );
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: {
    // On Linux the browser draws on SwiftShader, the CPU's: a stable
    // screenshot of the scene can take longer than 10 s there.
    timeout: linux ? 30_000 : 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.25 },
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Reference pictures, kept per back end and platform, changed only by hand.
  snapshotPathTemplate: '{testDir}/pictures/{projectName}-{platform}/{arg}{ext}',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  projects: [
    ...['webgl2', 'webgpu'].map((name) => ({
      name,
      ...half,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 960, height: 600 },
        deviceScaleFactor: 1,
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
        launchOptions: { args },
      },
    })),
    {
      name: 'compat',
      testMatch: ['sea.spec.ts', 'look.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 960, height: 600 },
        deviceScaleFactor: 1,
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
        launchOptions: { args },
      },
    },
    // The upgrade from a worker on WebKit, Safari's engine, the account's
    // passkeys there, and the screen at sea laid out on phones.
    {
      name: 'webkit',
      testMatch: ['worker.spec.ts', 'passkeys.spec.ts', 'layout.spec.ts'],
      use: {
        ...devices['Desktop Safari'],
        baseURL: `https://localhost:${securePort}`,
        ignoreHTTPSErrors: true,
      },
    },
  ],
  webServer: [
    {
      command: 'go run ../tools/e2e',
      url: keelReady,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
    },
    {
      command: `npx --no-install vite --port ${port} --strictPort`,
      url: `http://localhost:${port}/`,
      env: { KEEL_PLAY_ADDR: keelPlay, KEEL_AGENTS_ADDR: keelAgents },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `go run ../tools/e2e -tls ${tls} && npx --no-install vite --port ${securePort} --strictPort`,
      url: `https://localhost:${securePort}/`,
      ignoreHTTPSErrors: true,
      env: {
        KEEL_PLAY_ADDR: keelPlay,
        KEEL_AGENTS_ADDR: keelAgents,
        KEEL_DEV_CERT: `${tls}/cert.pem`,
        KEEL_DEV_KEY: `${tls}/key.pem`,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npx --no-install vite -c vite.owner.config.ts --port ${ownerPort} --strictPort`,
      url: `http://localhost:${ownerPort}/owner/`,
      env: { KEEL_INTERNAL_ADDR: '127.0.0.1:19090' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npx --no-install vite --port ${laggedPort} --strictPort`,
      url: `http://localhost:${laggedPort}/`,
      env: { KEEL_PLAY_ADDR: keelLagged, KEEL_AGENTS_ADDR: keelAgents },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

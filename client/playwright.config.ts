// SPDX-License-Identifier: AGPL-3.0-only

// The browser tests: the scene in Chromium, on the WebGL 2 back end and, where
// the browser offers an adapter, on WebGPU. On Linux runners WebGPU goes
// through SwiftShader, the CPU's Vulkan. Locally, PW_CHANNEL=chrome uses the
// installed Chrome instead of downloading Chromium.

import { defineConfig, devices } from '@playwright/test';

const port = 5181;
const linux = process.platform === 'linux';
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
    timeout: 10_000,
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
  projects: ['webgl2', 'webgpu'].map((name) => ({
    name,
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 960, height: 600 },
      deviceScaleFactor: 1,
      ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
      launchOptions: { args },
    },
  })),
  webServer: {
    command: `npx --no-install vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

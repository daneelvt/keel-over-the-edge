// SPDX-License-Identifier: AGPL-3.0-only

// The Worker's tests run in workerd, the Workers runtime, with the
// bindings wrangler.jsonc names: KV and the cache are miniflare's own.

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { kvNamespaces: ['WEBSITE'] },
    }),
  ],
  test: {
    include: ['worker/test/**/*.test.ts'],
  },
});

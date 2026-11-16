// SPDX-License-Identifier: AGPL-3.0-only

// The tests that run in Node: the pictures', which read the files the
// pictures were encoded to, and the page's, its colours, words and build,
// which read the page and the manifest, as the Worker's runtime cannot.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['pictures/**/*.test.ts', 'site/**/*.test.ts'],
    environment: 'node',
  },
});

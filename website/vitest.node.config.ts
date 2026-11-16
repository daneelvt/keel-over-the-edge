// SPDX-License-Identifier: AGPL-3.0-only

// The pictures' tests run in Node: they read the files the pictures were
// encoded to, which the Worker's runtime cannot.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['pictures/**/*.test.ts'],
    environment: 'node',
  },
});

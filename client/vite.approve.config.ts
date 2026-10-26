// SPDX-License-Identifier: AGPL-3.0-only

// The approval page's build: approve.html and its own assets, built apart
// from the game so that it shares no chunk with it (the game's first
// download stays as it was, and the page loads nothing of the game's),
// into dist/'s top level and dist/assets/, which keel serves. The game's
// build runs it once its own is written (vite.config.ts), so vite build
// alone builds both. It writes no licences notice of its own: it bundles
// nothing the game's notice does not list.
//
// In development the game's Vite serves approve.html itself.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { licences } from './build/licences.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The page is served at /oauth/authorize: its assets are named from the
  // origin's root.
  base: '/',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // The game's build is there already.
    emptyOutDir: false,
    rolldownOptions: {
      input: { approve: fileURLToPath(new URL('./approve.html', import.meta.url)) },
    },
  },
  plugins: [
    licences({ allowedFile: '../tools/licences/allowed.txt', shared: new Set(), emit: false }),
  ],
});

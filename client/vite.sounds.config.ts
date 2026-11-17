// SPDX-License-Identifier: AGPL-3.0-only

// The sound room's build: sounds.html and its own assets (the game's
// recordings among them), built apart from the game so that it shares no
// chunk with it, and the game's first download stays as it was, into
// dist/'s top level and dist/assets/, which keel serves. The game's build
// runs it once its own is written (vite.config.ts). It bundles nothing the
// game's notice does not list.
//
// In development the game's Vite serves sounds.html itself, and lists the
// recordings in art/sound/candidates (not committed) and the masters at
// /sound-candidates/ for it.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { licences } from './build/licences.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  publicDir: false,
  // The build's ID, as the game's: the page's reports name it.
  define: { __KEEL_BUILD__: JSON.stringify(process.env.KEEL_BUILD ?? 'dev') },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // The game's build is there already.
    emptyOutDir: false,
    rolldownOptions: {
      input: { sounds: fileURLToPath(new URL('./sounds.html', import.meta.url)) },
    },
  },
  plugins: [
    licences({ allowedFile: '../tools/licences/allowed.txt', shared: new Set(), emit: false }),
  ],
});

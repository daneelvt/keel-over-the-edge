// SPDX-License-Identifier: AGPL-3.0-only

// The dressing room's build: sailors.html and its own assets (the sailors'
// files, the texture transcoder), built apart from the game so that it
// shares no chunk with it, and the game's first download stays as it was,
// into dist/'s top level and dist/assets/, which keel serves. The game's
// build runs it once its own is written (vite.config.ts). Its notices are
// in the game's notice, which lists the transcoder's.
//
// In development the game's Vite serves sailors.html itself.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { licences } from './build/licences.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // The game's build is there already.
    emptyOutDir: false,
    // three.js with its WebGPU renderer, as in the game's.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: { sailors: fileURLToPath(new URL('./sailors.html', import.meta.url)) },
    },
  },
  plugins: [
    licences({ allowedFile: '../tools/licences/allowed.txt', shared: new Set(), emit: false }),
  ],
});

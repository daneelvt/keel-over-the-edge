// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { type ServerOptions, searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';
import { licences } from './build/licences.ts';

// tools/dev sets these: the local certificate, and where keel serve listens.
const cert = process.env.KEEL_DEV_CERT;
const key = process.env.KEEL_DEV_KEY;
const playAddr = process.env.KEEL_PLAY_ADDR ?? '127.0.0.1:8080';

const server: ServerOptions = {
  host: true,
  port: 5173,
  strictPort: true,
  proxy: {
    // The browser's Host header is kept, so the server sees the origin
    // players use.
    '/api': { target: `http://${playAddr}`, changeOrigin: false },
    '/guest': { target: `http://${playAddr}`, changeOrigin: false },
    // The game connection. Vite does not check a WebSocket's Origin before
    // proxying it; keel does.
    '/ws': { target: `ws://${playAddr}`, ws: true, changeOrigin: false },
  },
  // The developer page reads the physics golden files, which live beside
  // the Go tests, and the game loads its models from art/; nothing else
  // outside client/ is served.
  fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../internal/physics/testdata', '../art'] },
};
if (cert && key) {
  server.https = { cert: readFileSync(cert), key: readFileSync(key) };
}

export default defineConfig({
  server,
  build: {
    // three.js with its WebGPU renderer is most of the game's first chunk;
    // its size is reported by build/size.ts against the 4 MB critical set.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // The game, and the developer page with its physics check.
      input: { main: 'index.html', dev: 'dev.html' },
    },
  },
  plugins: [
    licences({
      allowedFile: '../tools/licences/allowed.txt',
      extra: [
        { name: 'IM Fell English SC (font)', licence: 'OFL-1.1', file: 'src/fonts/OFL.txt' },
        {
          name: 'Alegreya Sans (font)',
          licence: 'OFL-1.1',
          file: 'src/fonts/AlegreyaSans-OFL.txt',
        },
        // physics.wasm holds TinyGo's runtime, which includes parts of Go's
        // standard library.
        {
          name: 'TinyGo (in physics.wasm)',
          licence: 'BSD-3-Clause',
          file: 'build/notices/tinygo.txt',
        },
        { name: 'Go (in physics.wasm)', licence: 'BSD-3-Clause', file: 'build/notices/go.txt' },
        // three.js ships meshoptimizer's decoder, which loads the boats' models.
        {
          name: 'meshoptimizer (decoder, in three.js)',
          licence: 'MIT',
          file: 'build/notices/meshoptimizer.txt',
        },
      ],
    }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
  },
});

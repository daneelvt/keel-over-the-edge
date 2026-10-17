// SPDX-License-Identifier: AGPL-3.0-only

// The world page's build: the owner's page on keel's internal listener at
// /owner/, built apart from the game into dist/owner/ with its own assets,
// which the game's listener never serves (it serves dist/'s top level and
// dist/assets/ alone). It writes no licences notice of its own: it bundles
// nothing the game's notice does not list, and its packages' licences are
// checked as the game's are.
//
//   npx vite build -c vite.owner.config.ts   after the game's build, which empties dist/
//   npx vite -c vite.owner.config.ts         in development, at http://localhost:5184/owner/
//
// In development its data and controls, /owner/api/, are proxied to keel's
// internal listener (KEEL_INTERNAL_ADDR, as go run ./tools/dev runs it)
// with the browser's Host kept: keel answers only a Host of this computer's.

import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { licences } from './build/licences.ts';

const internalAddr = process.env.KEEL_INTERNAL_ADDR ?? '127.0.0.1:9090';

export default defineConfig({
  root: fileURLToPath(new URL('./src/owner', import.meta.url)),
  base: '/owner/',
  build: {
    outDir: fileURLToPath(new URL('./dist/owner', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5184,
    strictPort: true,
    proxy: {
      // A pattern, not a prefix: /owner/api.ts is the page's own module.
      '^/owner/api/': { target: `http://${internalAddr}`, changeOrigin: false },
    },
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
  },
  plugins: [
    licences({ allowedFile: '../tools/licences/allowed.txt', shared: new Set(), emit: false }),
  ],
});

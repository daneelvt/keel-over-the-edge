// SPDX-License-Identifier: AGPL-3.0-only

// The page, built by Vite from site/ into out/, which the Worker serves as
// its static files: the page, its style sheet and script with their
// content's hash in their names, its fonts cut to its letters, and its
// pictures (site/build/site.ts).

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import catalog from '../client/src/catalog/catalog.gen.json' with { type: 'json' };
import { sitePlugin } from './site/build/site.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./site'),
  publicDir: here('./site/public'),
  base: '/',
  plugins: [sitePlugin()],
  // The sky's clock, from the catalog, for the page's colours.
  define: {
    __SKY__: JSON.stringify({
      day: catalog.sky.day,
      epoch: catalog.sky.epoch,
      sunAtEpoch: catalog.sky.sunAtEpoch,
    }),
  },
  build: {
    outDir: here('./out'),
    emptyOutDir: true,
    // Every file its own: the page's CSP allows no data: address.
    assetsInlineLimit: 0,
    modulePreload: false,
    target: 'es2022',
    reportCompressedSize: false,
  },
  server: {
    fs: { allow: [here('..')] },
  },
});

// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { eagerAssets, eagerModels } from './size';

test('the first download is the page’s scripts, preloaded modules and styles', () => {
  const html = `<script type="module" crossorigin src="/assets/main-1.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/a-2.js">
    <link rel="stylesheet" crossorigin href="/assets/main-3.css">
    <link rel="icon" href="/favicon.png">`;
  expect(eagerAssets(html)).toEqual(['assets/main-1.js', 'assets/a-2.js', 'assets/main-3.css']);
});

test('the models counted are those the first download names', () => {
  const scripts = ['const MODELS={"../../../art/boats/jolly.glb":"/assets/jolly-1a.glb"}'];
  expect(eagerModels(['jolly-1a.glb', 'female-2b.glb'], scripts)).toEqual(['jolly-1a.glb']);
});

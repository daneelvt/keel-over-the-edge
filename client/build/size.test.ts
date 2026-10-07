// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { eagerAssets } from './size';

test('the first download is the page’s scripts, preloaded modules and styles', () => {
  const html = `<script type="module" crossorigin src="/assets/main-1.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/a-2.js">
    <link rel="stylesheet" crossorigin href="/assets/main-3.css">
    <link rel="icon" href="/favicon.png">`;
  expect(eagerAssets(html)).toEqual(['assets/main-1.js', 'assets/a-2.js', 'assets/main-3.css']);
});

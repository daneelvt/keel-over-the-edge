// SPDX-License-Identifier: AGPL-3.0-only

// The browser tests' files, as playwright.config.ts places them: each spec
// in one place, the page's or one shard of the scene's (the last shard runs
// every scene file the others do not name), so that every test runs and
// none twice.

import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { pageFiles, shardFiles } from '../playwright.config';

const specs = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.spec.ts'));

describe('the spec files', () => {
  test('the page’s are all there', () => {
    expect(pageFiles.filter((f) => !specs.includes(f))).toEqual([]);
  });

  for (const [project, groups] of Object.entries(shardFiles)) {
    test(`${project}’s shards name scene files that are there, each once`, () => {
      const named = groups.flat().map((n) => `${n}.spec.ts`);
      expect(named.filter((f) => !specs.includes(f))).toEqual([]);
      expect(named.filter((f) => pageFiles.includes(f))).toEqual([]);
      expect(named.filter((f, i) => named.indexOf(f) !== i)).toEqual([]);
    });
  }
});

// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { catalog } from '../src/catalog';
import { eagerAssets, eagerModels, SAILOR_BUDGETS } from './size';

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

const ART = new URL('../../art/', import.meta.url);
const gzipped = (path: string): number =>
  gzipSync(readFileSync(new URL(path, ART)), { level: 9 }).length;

/** Every look's folder under art/sailors with built versions, but the build's test sailor. */
const looks = readdirSync(new URL('sailors/', ART), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !['test', 'vendor', 'stand-in'].includes(d.name))
  .filter((d) => readdirSync(new URL(`sailors/${d.name}/`, ART)).some((f) => f.endsWith('.glb')))
  .map((d) => d.name);

describe.each(looks)('the %s look', (look) => {
  const versions = readdirSync(new URL(`sailors/${look}/`, ART))
    .map((f) => /^([a-z]+)\.glb$/.exec(f)?.[1])
    .filter((v) => v !== undefined);

  test.each(versions)('%s keeps to its budgets, gzipped', (version) => {
    const at = (level: string) => gzipped(`sailors/${look}/${version}${level}.glb`);
    // The deck and far levels load together, when a boat with the look is first in view.
    expect(at('.deck') + at('.far')).toBeLessThanOrEqual(SAILOR_BUDGETS.deckFar);
    expect(at('')).toBeLessThanOrEqual(SAILOR_BUDGETS.close);
    expect(at('.clips')).toBeLessThanOrEqual(SAILOR_BUDGETS.clips);
  });
});

test('the first download carries one look, every boat’s, and no other', () => {
  const art = catalog.sailors[0]?.art;
  if (art === undefined) {
    throw new Error('no sailor');
  }
  // What the boat module loads as it starts: its eager globs.
  const boat = readFileSync(new URL('../src/render/boat.ts', import.meta.url), 'utf8');
  const eager = [
    ...boat.matchAll(/'\.\.\/\.\.\/\.\.\/art\/(sailors\/[^']+)'\],\s*\{[^}]*eager: true/g),
  ].map((m) => m[1]);
  expect(eager).toEqual(['sailors/rover/female.{deck,far,clips}.glb']);
  for (const path of [art.model, art.far, art.clips]) {
    expect(path.startsWith('sailors/rover/female.')).toBe(true);
  }
  const size = gzipped(art.model) + gzipped(art.far) + gzipped(art.clips);
  expect(size).toBeLessThanOrEqual(SAILOR_BUDGETS.critical);
});

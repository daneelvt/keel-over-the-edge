// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { catalog } from '../src/catalog';
import { eagerAssets, eagerModels, SAILOR_BUDGETS, transcoderAsset } from './size';

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
const bytes = (path: string): number => statSync(new URL(path, ART)).size;

/** Every look's folder under art/sailors with built versions, but the build's test sailor. */
const looks = readdirSync(new URL('sailors/', ART), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !['test', 'vendor'].includes(d.name))
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
    // Its clips at a wheel, which a boat steered by one loads with them.
    expect(at('.clips') + at('.wheel')).toBeLessThanOrEqual(
      SAILOR_BUDGETS.clips + SAILOR_BUDGETS.wheel,
    );
  });

  test.each(versions)('%s’s portraits keep to their budgets', (version) => {
    expect(portrait(look, version)).toBeLessThanOrEqual(SAILOR_BUDGETS.portrait);
    expect(bytes(`sailors/${look}/${version}.ink.webp`)).toBeLessThanOrEqual(SAILOR_BUDGETS.ink);
  });
});

/** A colour portrait's pair: its base, as most browsers load it, and its mask. */
const portrait = (look: string, version: string): number =>
  bytes(`sailors/${look}/${version}.portrait.avif`) +
  bytes(`sailors/${look}/${version}.portrait-mask.webp`);

test('every look and version’s colour portrait together keep to their budget', () => {
  let all = 0;
  for (const look of looks) {
    for (const f of readdirSync(new URL(`sailors/${look}/`, ART))) {
      const version = /^([a-z]+)\.glb$/.exec(f)?.[1];
      if (version !== undefined) {
        all += portrait(look, version);
      }
    }
  }
  expect(all).toBeLessThanOrEqual(SAILOR_BUDGETS.portraits);
});

test('the first download carries no sailor: the player’s own look loads once it is known', () => {
  // What the boat module loads as it starts: its eager globs.
  const boat = readFileSync(new URL('../src/render/boat.ts', import.meta.url), 'utf8');
  const eager = [...boat.matchAll(/glob<string>\((\[[^\]]*\]),\s*\{[^}]*eager: true/g)].map(
    (m) => m[1],
  );
  expect(eager).toEqual([`['../../../art/**/*.glb', '!../../../art/sailors/**']`]);
});

test('any person’s look, the player’s own, keeps to the first download’s share', () => {
  for (const look of catalog.sailors) {
    for (const v of look.versions) {
      const size = gzipped(v.art.model) + gzipped(v.art.far) + gzipped(v.art.clips);
      expect(size, `${look.name} ${v.name}`).toBeLessThanOrEqual(SAILOR_BUDGETS.critical);
    }
  }
});

test('the texture transcoder keeps to its budget, and the build names it', () => {
  const lib = new URL('../node_modules/three/examples/jsm/libs/basis/', import.meta.url);
  const size = ['basis_transcoder.js', 'basis_transcoder.wasm']
    .map((f) => gzipSync(readFileSync(new URL(f, lib)), { level: 9 }).length)
    .reduce((a, b) => a + b, 0);
  expect(size).toBeLessThanOrEqual(SAILOR_BUDGETS.transcoder);
  expect(transcoderAsset('basis_transcoder-Ab12Cd.wasm')).toBe(true);
  expect(transcoderAsset('basis_transcoder.js')).toBe(true);
  expect(transcoderAsset('main-1.js')).toBe(false);
});

// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { lists, type ManifestChunk, PAGE, workerBuild, workerOn } from './sw';

// A manifest as Vite writes it: the game's page, a shared chunk, lazy
// screens, a worker, WebAssembly, a font and models; and another page.
const manifest: Record<string, ManifestChunk> = {
  'index.html': {
    file: 'assets/main-A.js',
    css: ['assets/main-A.css'],
    assets: ['assets/IMFellEnglishSC-B.woff2', 'assets/physics-C.wasm', 'assets/jolly-D.glb'],
    imports: ['_shared-E.js'],
    dynamicImports: ['src/ui/log.tsx', '../art/sailors/bosun/female.glb?url'],
  },
  '_shared-E.js': { file: 'assets/shared-E.js', assets: ['assets/worker-F.js'] },
  'src/ui/log.tsx': {
    file: 'assets/log-G.js',
    css: ['assets/log-H.css'],
    imports: ['_shared-E.js'],
    assets: ['assets/badge-I.webp'],
  },
  '../art/sailors/bosun/female.glb?url': {
    file: 'assets/female.glb-J.js',
    assets: ['assets/female-K.glb'],
  },
  'dev.html': { file: 'assets/dev-L.js', imports: ['_shared-E.js'] },
};

describe('the files the worker keeps', () => {
  test('the code reachable from the page, lazy too, and the page with its icons', () => {
    const l = lists(manifest);
    expect(l.code).toEqual([
      ...PAGE,
      '/assets/IMFellEnglishSC-B.woff2',
      '/assets/female.glb-J.js',
      '/assets/log-G.js',
      '/assets/log-H.css',
      '/assets/main-A.css',
      '/assets/main-A.js',
      '/assets/physics-C.wasm',
      '/assets/shared-E.js',
      '/assets/worker-F.js',
    ]);
    expect(PAGE).toContain('/');
    expect(PAGE).toContain('/manifest.webmanifest');
    expect(l.entry).toBe('/assets/main-A.js');
  });

  test('the art apart, and nothing of another page', () => {
    const l = lists(manifest);
    expect(l.art).toEqual(['/assets/badge-I.webp', '/assets/female-K.glb', '/assets/jolly-D.glb']);
    expect([...l.code, ...l.art]).not.toContain('/assets/dev-L.js');
  });

  test('a manifest without the page, or with a chunk missing, fails the build', () => {
    expect(() => lists({})).toThrow(/index\.html/);
    expect(() =>
      lists({ 'index.html': { file: 'assets/main-A.js', imports: ['_gone.js'] } }),
    ).toThrow(/_gone/);
  });
});

describe('the worker’s build', () => {
  test('the image’s id; a build without one named by its code', () => {
    expect(workerBuild('0123456789ab', ['/a.js'])).toBe('0123456789ab');
    const a = workerBuild('dev', ['/assets/main-A.js']);
    expect(a).toMatch(/^dev-[0-9a-f]{12}$/);
    expect(workerBuild('dev', ['/assets/main-A.js'])).toBe(a);
    expect(workerBuild('dev', ['/assets/main-B.js'])).not.toBe(a);
  });

  test('on unless KEEL_SW=off', () => {
    expect(workerOn({})).toBe(true);
    expect(workerOn({ KEEL_SW: 'on' })).toBe(true);
    expect(workerOn({ KEEL_SW: 'off' })).toBe(false);
  });
});

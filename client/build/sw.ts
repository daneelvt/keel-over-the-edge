// SPDX-License-Identifier: AGPL-3.0-only

// A Vite plugin that builds the service worker (src/sw/sw.ts) to the top
// of dist/ as sw.js, once the game's build is written: from the build's
// manifest (dist/.vite/, which keel never serves) it writes in the files
// the game's page can reach from index.html, lazy ones too. The code
// (scripts, workers, WebAssembly, style sheets, fonts) is kept by the
// worker when it installs; the art (models, portraits, images, sounds) as
// it is used. With KEEL_SW=off it builds the worker that switches itself
// off (src/sw/off.ts) instead.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';

/** One entry of Vite's build manifest: a chunk and what it brings. */
export interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
}

/** The lists the worker is built with. */
export interface Lists {
  /** The page, its icons and manifest, and the game's code: kept at install. */
  code: string[];
  /** The game's art: kept once used. */
  art: string[];
  /** The page's entry script. */
  entry: string;
}

/** The page and what the home screen shows of it, kept with the code. */
export const PAGE = ['/', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

/** The code's kinds of file, by extension. */
const CODE = /\.(?:m?js|css|wasm|woff2?)$/;

/**
 * The files reachable from the manifest's entry (index.html), through its
 * imports, lazy imports, style sheets and assets, as root-relative paths:
 * the page and the code apart from the art.
 */
export function lists(manifest: Record<string, ManifestChunk>, entry = 'index.html'): Lists {
  const first = manifest[entry];
  if (first === undefined) {
    throw new Error(`the build's manifest has no ${entry}`);
  }
  const seen = new Set<string>();
  const files = new Set<string>();
  const walk = (key: string): void => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const c = manifest[key];
    if (c === undefined) {
      throw new Error(`the build's manifest has no ${key}`);
    }
    for (const f of [c.file, ...(c.css ?? []), ...(c.assets ?? [])]) {
      files.add(`/${f}`);
    }
    for (const k of [...(c.imports ?? []), ...(c.dynamicImports ?? [])]) {
      walk(k);
    }
  };
  walk(entry);
  const all = [...files].sort();
  return {
    code: [...PAGE, ...all.filter((f) => CODE.test(f))],
    art: all.filter((f) => !CODE.test(f)),
    entry: `/${first.file}`,
  };
}

/**
 * The worker's build id: the image's BUILD; or, for a build without one
 * ("dev"), dev and a hash of its code, so that two such builds never
 * share a cache.
 */
export function workerBuild(build: string, code: readonly string[]): string {
  if (build !== 'dev') {
    return build;
  }
  return `dev-${createHash('sha256').update(code.join('\n')).digest('hex').slice(0, 12)}`;
}

/** Whether the build has the worker: true unless KEEL_SW=off. */
export function workerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KEEL_SW !== 'off';
}

/** The plugin: sw.js written once the game's build is. */
export function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = join(config.root, config.build.outDir);
      const on = workerOn();
      const l = lists(
        JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Record<
          string,
          ManifestChunk
        >,
      );
      await build({
        configFile: false,
        root: config.root,
        publicDir: false,
        logLevel: 'warn',
        define: {
          __SW_BUILD__: JSON.stringify(workerBuild(process.env.KEEL_BUILD ?? 'dev', l.code)),
          __SW_CODE__: JSON.stringify(l.code),
          __SW_ART__: JSON.stringify(l.art),
          __SW_ENTRY__: JSON.stringify(l.entry),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          rolldownOptions: {
            input: join(config.root, on ? 'src/sw/sw.ts' : 'src/sw/off.ts'),
            // A classic script: every browser runs one as a service worker.
            output: { format: 'iife', entryFileNames: 'sw.js' },
          },
        },
      });
    },
  };
}

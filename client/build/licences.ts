// SPDX-License-Identifier: AGPL-3.0-only

// A Vite plugin that checks the licence of every package bundled into the
// client and writes the third-party notices file. Only code that ships is
// checked: build and test tools never reach the bundle.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface PackageInfo {
  name: string;
  version: string;
  licence: string;
  notice: string;
}

export interface ExtraNotice {
  /** What the notice covers, for example a font. */
  name: string;
  licence: string;
  /** Path of the licence text, relative to Vite's root. */
  file: string;
}

export interface LicencesOptions {
  /** Path of the allowlist: one SPDX identifier per line, # comments. */
  allowedFile: string;
  /** Notices for files that are not npm packages, such as fonts. */
  extra?: ExtraNotice[];
}

export function readAllowed(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l !== ''),
  );
}

/**
 * Whether an SPDX expression is allowed. "A OR B" needs one of them allowed,
 * "A AND B" needs both; anything else must be allowed as written.
 */
export function licenceAllowed(expression: string, allowed: Set<string>): boolean {
  const e = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (e === '') {
    return false;
  }
  if (/\sOR\s/.test(e)) {
    return e.split(/\s+OR\s+/).some((part) => licenceAllowed(part, allowed));
  }
  if (/\sAND\s/.test(e)) {
    return e.split(/\s+AND\s+/).every((part) => licenceAllowed(part, allowed));
  }
  return allowed.has(e);
}

/** The problems with a set of bundled packages, one line each. */
export function checkLicences(packages: PackageInfo[], allowed: Set<string>): string[] {
  return packages
    .filter((p) => !licenceAllowed(p.licence, allowed))
    .map((p) => `${p.name}@${p.version}: licence ${p.licence || 'unknown'} is not allowed`);
}

/** The root folder of the npm package a bundled module belongs to, if any. */
export function packageRoot(moduleId: string): string | null {
  const id = moduleId.replace(/^\0/, '').split('?')[0] ?? '';
  const marker = `${sep}node_modules${sep}`;
  const at = id.lastIndexOf(marker);
  if (at < 0) {
    return null;
  }
  const rest = id.slice(at + marker.length).split(sep);
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= depth) {
    return null;
  }
  return join(id.slice(0, at + marker.length), ...rest.slice(0, depth));
}

function readPackage(root: string): PackageInfo {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    license?: string | { type?: string };
  };
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? '');
  const noticeFile = readdirSync(root).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
  return {
    name: pkg.name ?? root,
    version: pkg.version ?? '',
    licence,
    notice: noticeFile ? readFileSync(join(root, noticeFile), 'utf8').trim() : '',
  };
}

export function noticesText(packages: PackageInfo[], extra: PackageInfo[]): string {
  const all = [...packages, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  if (all.length === 0) {
    return 'This build bundles no third-party code.\n';
  }
  return `${all
    .map((p) => `${p.name}${p.version ? `@${p.version}` : ''} (${p.licence})\n\n${p.notice}`)
    .join('\n\n----------------------------------------\n\n')}\n`;
}

export function licences(options: LicencesOptions): Plugin {
  let root = '.';
  return {
    name: 'keel-licences',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_, bundle) {
      const allowed = readAllowed(readFileSync(options.allowedFile, 'utf8'));
      const roots = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') {
          continue;
        }
        for (const id of item.moduleIds) {
          const root = packageRoot(id);
          if (root && existsSync(join(root, 'package.json'))) {
            roots.add(root);
          }
        }
      }
      const packages = [...roots].map(readPackage);
      const problems = checkLicences(packages, allowed);
      if (problems.length > 0) {
        this.error(
          `bundled packages with licences outside ${options.allowedFile}:\n${problems.join('\n')}`,
        );
      }
      const extra = (options.extra ?? []).map((x) => ({
        name: x.name,
        version: '',
        licence: x.licence,
        notice: readFileSync(join(root, x.file), 'utf8').trim(),
      }));
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licences.txt',
        source: noticesText(packages, extra),
      });
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-only

// The next build, for the test of a deploy: a copy of a built page in
// which every file under assets/ has a new name, every reference to it
// renamed with it, and the build's id replaced, as a new build's would be.
// So the copy has none of the first build's files: a page still running
// the first build after the server switched to the copy finds its late
// files only where the service worker kept them. A second vite build of
// the same tree would name most files as the first did, since names come
// from their content.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Files whose text may name other files, or the build. */
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.txt', '.svg']);

/** A file's new name: its name with "-next" before its extension. */
export function nextName(name: string): string {
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}-next${ext}`;
}

/**
 * Renames, in text, every name of names that follows a slash (as each
 * reference to a file under assets/ does: "/assets/x", "./x", "assets/x"),
 * and every build id from to to.
 */
export function renameIn(text: string, names: readonly string[], from: string, to: string): string {
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The longest first, so that a name another begins with is not taken
  // for it.
  const alts = [...names].sort((a, b) => b.length - a.length).map(literal);
  let out =
    alts.length === 0
      ? text
      : text.replace(new RegExp(`(?<=/)(?:${alts.join('|')})`, 'g'), nextName);
  if (from !== '') {
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Writes the next build of the page in src to dst (emptied first): every
 * asset renamed, the build's id from replaced by to in every text file.
 */
export function writeNextBuild(src: string, dst: string, from: string, to: string): void {
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(join(dst, 'assets'), { recursive: true });
  const names = readdirSync(join(src, 'assets'));
  const copy = (from_: string, to_: string): void => {
    if (TEXT.has(extname(from_))) {
      writeFileSync(to_, renameIn(readFileSync(from_, 'utf8'), names, from, to));
    } else {
      copyFileSync(from_, to_);
    }
  };
  for (const n of names) {
    copy(join(src, 'assets', n), join(dst, 'assets', nextName(n)));
  }
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isFile()) {
      copy(join(src, e.name), join(dst, e.name));
    }
  }
}

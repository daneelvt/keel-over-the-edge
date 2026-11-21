// SPDX-License-Identifier: AGPL-3.0-only
//
// Installs the npm that package.json pins in packageManager, checked against
// the hash beside it, in place of the npm that came with Node:
//
//   node client/build/npm.mjs
//
// The file is fetched from npm's registry, and installed only when its
// SHA-512 is the pinned one. With the pinned npm already in place it does
// nothing. It runs before any package is installed, so it uses Node alone.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = new URL('../package.json', import.meta.url);
const pinned = JSON.parse(readFileSync(manifest, 'utf8')).packageManager ?? '';
const match = /^npm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(pinned);
if (!match) {
  throw new Error(`packageManager is "${pinned}", not npm@<version>+sha512.<hash>`);
}
const [, version, hash] = match;

// npm is a script on Windows, which only a shell runs.
const npm = (...args) =>
  execFileSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

if (npm('--version') === version) {
  process.stdout.write(`npm ${version}, as pinned\n`);
} else {
  const url = `https://registry.npmjs.org/npm/-/npm-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  const file = Buffer.from(await response.arrayBuffer());
  const got = createHash('sha512').update(file).digest('hex');
  if (got !== hash) {
    throw new Error(`${url}: SHA-512 is ${got}, not the pinned ${hash}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'npm-'));
  try {
    const tarball = join(dir, `npm-${version}.tgz`);
    writeFileSync(tarball, file);
    // From the temporary directory, where no project's settings apply.
    execFileSync('npm', ['install', '--global', '--no-audit', '--no-fund', tarball], {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const now = npm('--version');
  if (now !== version) {
    throw new Error(
      `npm is ${now} after installing ${version}: another npm comes first on the PATH`,
    );
  }
  process.stdout.write(`npm ${version} installed, as pinned\n`);
}

// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLicences,
  licenceAllowed,
  noticesText,
  type PackageInfo,
  packageRoot,
  readAllowed,
} from './licences';

const allowed = readAllowed('# comment\nMIT\nApache-2.0 # trailing\n\nISC\n');

function pkg(name: string, licence: string): PackageInfo {
  return { name, version: '1.0.0', licence, notice: `${name} notice` };
}

describe('readAllowed', () => {
  it('reads one identifier per line and drops comments', () => {
    expect([...allowed].sort()).toEqual(['Apache-2.0', 'ISC', 'MIT']);
  });
});

describe('licenceAllowed', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0-only', false],
    ['', false],
    ['(MIT OR GPL-3.0-only)', true],
    ['GPL-2.0-only OR LGPL-2.1-only', false],
    ['MIT AND ISC', true],
    ['MIT AND GPL-3.0-only', false],
  ])('%s → %s', (expression, ok) => {
    expect(licenceAllowed(expression, allowed)).toBe(ok);
  });
});

describe('checkLicences', () => {
  it('passes permissive packages', () => {
    expect(checkLicences([pkg('a', 'MIT'), pkg('b', 'Apache-2.0')], allowed)).toEqual([]);
  });
  it('fails a GPL package and one without a licence', () => {
    expect(checkLicences([pkg('gpl', 'GPL-3.0-only'), pkg('none', '')], allowed)).toEqual([
      'gpl@1.0.0: licence GPL-3.0-only is not allowed',
      'none@1.0.0: licence unknown is not allowed',
    ]);
  });
});

describe('packageRoot', () => {
  const nm = join('/app', 'node_modules');
  it.each([
    [join(nm, 'three', 'build', 'three.module.js'), join(nm, 'three')],
    [join(nm, '@scope', 'pkg', 'dist', 'index.js'), join(nm, '@scope', 'pkg')],
    [join(nm, 'a', 'node_modules', 'b', 'index.js'), join(nm, 'a', 'node_modules', 'b')],
    [`\0${join(nm, 'three', 'x.js')}?commonjs`, join(nm, 'three')],
    [join('/app', 'src', 'main.ts'), null],
  ])('%s', (id, root) => {
    expect(packageRoot(id)).toBe(root);
  });
});

describe('noticesText', () => {
  it('says when nothing is bundled', () => {
    expect(noticesText([], [])).toBe('This build bundles no third-party code.\n');
  });
  it('lists each package with its licence and notice, sorted', () => {
    const text = noticesText([pkg('zeta', 'MIT')], [{ ...pkg('font', 'OFL-1.1'), version: '' }]);
    expect(text.indexOf('font (OFL-1.1)')).toBeLessThan(text.indexOf('zeta@1.0.0 (MIT)'));
    expect(text).toContain('zeta notice');
  });
});

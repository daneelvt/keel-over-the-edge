// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { nextName, renameIn, writeNextBuild } from './nextbuild';

describe('the next build', () => {
  test('a file’s new name keeps its extension', () => {
    expect(nextName('main-BmL3Vph-.js')).toBe('main-BmL3Vph--next.js');
    expect(nextName('female.glb-J.js')).toBe('female.glb-J-next.js');
  });

  test('every reference renamed, the longest name first, and the build’s id', () => {
    const names = ['log-A.js', 'a-B.js', 'log-A.js.map'];
    const text =
      'import("./log-A.js");"/assets/a-B.js";["assets/log-A.js.map"];url(/assets/a-B.js) ba-B.js "b1-1"';
    expect(renameIn(text, names, 'b1-1', 'b1-2')).toBe(
      'import("./log-A-next.js");"/assets/a-B-next.js";["assets/log-A.js-next.map"];url(/assets/a-B-next.js) ba-B.js "b1-2"',
    );
  });

  test('a copy with none of the first build’s files', () => {
    const src = mkdtempSync(join(tmpdir(), 'keel-build-'));
    const dst = join(src, 'next');
    mkdirSync(join(src, 'assets'));
    writeFileSync(join(src, 'index.html'), '<script src="/assets/main-A.js"></script>');
    writeFileSync(
      join(src, 'sw.js'),
      'var b="keel-code-one",c=["/assets/main-A.js","/assets/x-B.glb"]',
    );
    writeFileSync(join(src, 'assets', 'main-A.js'), 'import("./x-B.glb");const BUILD="one"');
    writeFileSync(join(src, 'assets', 'x-B.glb'), Buffer.from([0, 1, 2]));
    writeNextBuild(src, dst, 'one', 'two');
    expect(readdirSync(join(dst, 'assets')).sort()).toEqual(['main-A-next.js', 'x-B-next.glb']);
    expect(readFileSync(join(dst, 'index.html'), 'utf8')).toBe(
      '<script src="/assets/main-A-next.js"></script>',
    );
    expect(readFileSync(join(dst, 'sw.js'), 'utf8')).toBe(
      'var b="keel-code-two",c=["/assets/main-A-next.js","/assets/x-B-next.glb"]',
    );
    expect(readFileSync(join(dst, 'assets', 'main-A-next.js'), 'utf8')).toBe(
      'import("./x-B-next.glb");const BUILD="two"',
    );
    expect([...readFileSync(join(dst, 'assets', 'x-B-next.glb'))]).toEqual([0, 1, 2]);
  });
});

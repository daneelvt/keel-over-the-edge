// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { transform } from 'lightningcss';
import { expect, test } from 'vitest';

/** Every stylesheet under src, by its path from there. */
function sheets(dir: URL, from = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sheets(new URL(`${e.name}/`, dir), `${from}${e.name}/`)
      : e.name.endsWith('.css')
        ? [`${from}${e.name}`]
        : [],
  );
}

// The build minifies the stylesheets with Lightning CSS, which drops a
// rule's translate when the same rule sets transform too: a window placed
// by both stood half off the screen in the build alone, the development
// server showing it right. Each translate written is still there minified.
test('no translate is lost when the build minifies the stylesheets', () => {
  const src = new URL('../', import.meta.url);
  const lost: string[] = [];
  for (const path of sheets(src)) {
    const code = readFileSync(new URL(path, src), 'utf8');
    const written = code.match(/(?<![-\w])translate\s*:/g)?.length ?? 0;
    const out = transform({
      code: Buffer.from(code),
      filename: path,
      minify: true,
    }).code.toString();
    const kept = out.match(/(?<![-\w])translate:/g)?.length ?? 0;
    if (kept < written) {
      lost.push(`${path}: ${written - kept} of ${written}`);
    }
  }
  expect(lost).toEqual([]);
});

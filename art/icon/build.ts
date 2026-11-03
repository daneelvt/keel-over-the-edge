// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The game's icons, written beside the page's other top-level files, where
// the manifest and the page's head name them.
//
//   node art/icon/build.ts   (from the repository root; npm run art in client/)

import { writeFileSync } from 'node:fs';
import { FRAMES, png, rasterise } from './icon.ts';

for (const f of FRAMES) {
  const file = new URL(`../../client/public/${f.file}`, import.meta.url);
  writeFileSync(file, png(f.size, rasterise(f)));
  process.stdout.write(`wrote client/public/${f.file}\n`);
}

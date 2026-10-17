// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The wooded kit, Port Royal's: houses of a timber frame on a stone plinth,
// rendered between the posts, under clay tiles with eaves and a ridge,
// shutters either side of the windows, stone chimneys.
//
//   node art/town/wooded/build.ts   (from the repository root; npm run art in client/)

import { buildKit } from '../lib/kit.ts';

buildKit('town/wooded.glb', {
  roof: 'gable',
  eaves: 0.45,
  timber: true,
  gallery: false,
  quoins: false,
  plinth: 0.5,
  timberColour: '#3b2a1e',
  stoneColour: '#8e877b',
  woodColour: '#7a5a3c',
  ironColour: '#2c2b2a',
  windowEvery: 2.6,
  window: [0.9, 1.3],
});

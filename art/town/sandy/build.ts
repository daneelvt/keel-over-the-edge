// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The sandy kit: rendered masonry in pale colours under low white roofs of
// stone slabs, laid in steps, as St George's, Bermuda, builds them.
//
//   node art/town/sandy/build.ts   (from the repository root; npm run art in client/)

import { buildKit } from '../lib/kit.ts';

buildKit('town/sandy.glb', {
  roof: 'stepped',
  eaves: 0.2,
  timber: false,
  gallery: false,
  quoins: true,
  plinth: 0.3,
  timberColour: '#f2efe6',
  stoneColour: '#e0d8c6',
  woodColour: '#8a6a48',
  ironColour: '#2c2b2a',
  windowEvery: 2.6,
  window: [0.9, 1.4],
});

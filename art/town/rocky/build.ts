// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The rocky kit: clapboard houses on rubble, under steep plain roofs, small
// windows against the weather, as Newfoundland's outports built them.
//
//   node art/town/rocky/build.ts   (from the repository root; npm run art in client/)

import { buildKit } from '../lib/kit.ts';

buildKit('town/rocky.glb', {
  roof: 'steep',
  eaves: 0.25,
  timber: false,
  gallery: false,
  quoins: false,
  plinth: 0.4,
  timberColour: '#e8e4dc',
  stoneColour: '#6f6a62',
  woodColour: '#6e5a44',
  ironColour: '#2c2b2a',
  windowEvery: 3.2,
  window: [0.7, 1.0],
});

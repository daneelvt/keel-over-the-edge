// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The volcanic kit: walls of basalt limewashed, dressed with dark basalt at
// the corners and the plinth, under clay tiles, as Pico's houses in the
// Azores are built ("irregular basalt masonry, the ceramic tile roof").
//
//   node art/town/volcanic/build.ts   (from the repository root; npm run art in client/)

import { buildKit } from '../lib/kit.ts';

buildKit('town/volcanic.glb', {
  roof: 'gable',
  eaves: 0.3,
  timber: false,
  gallery: false,
  quoins: true,
  plinth: 0.6,
  timberColour: '#2e2c2a',
  stoneColour: '#3a3836',
  woodColour: '#6e5a44',
  ironColour: '#2c2b2a',
  windowEvery: 2.8,
  window: [0.8, 1.2],
});

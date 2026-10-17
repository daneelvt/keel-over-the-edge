// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The tropical kit: timber houses on stone, under hipped shingle roofs that
// "present minimal resistance to the wind", a gallery along the front roofed
// apart from the house, louvred shutters (the Caribbean's houses, as the
// Smithsonian's folklife programme of 1990 describes them).
//
//   node art/town/tropical/build.ts   (from the repository root; npm run art in client/)

import { buildKit } from '../lib/kit.ts';

buildKit('town/tropical.glb', {
  roof: 'hip',
  eaves: 0.6,
  timber: false,
  gallery: true,
  quoins: false,
  plinth: 0.7,
  timberColour: '#5a4632',
  stoneColour: '#a59a86',
  woodColour: '#8a6a48',
  ironColour: '#2c2b2a',
  windowEvery: 2.4,
  window: [1.0, 1.6],
});

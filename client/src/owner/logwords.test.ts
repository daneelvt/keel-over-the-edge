// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { OwnerLog } from './api';
import {
  entryWords,
  figuresWords,
  nmWords,
  personWords,
  recordWords,
  shownWords,
  voyageWords,
} from './logwords';

const log = (over: Partial<OwnerLog> = {}): OwnerLog => ({
  name: 'Mira',
  machine: false,
  abstract: [],
  record: {
    distanceM: 392_600,
    voyages: 31,
    aboard: 4,
    worlds: 6,
    falls: 9,
    closestM: 12,
    bumps: 12,
    bumpsAtFault: 4,
    gales: 2,
    storms: 0,
    charted: 14,
    kinds: 23,
    of: 71,
  },
  worlds: [],
  world: null,
  zone: 'America/New_York',
  ...over,
});

describe('a log, to the owner', () => {
  test('its figures in a row, nothing for nothing logged', () => {
    expect(figuresWords({ runM: 15_556.8, voyages: 3 })).toBe('8.4 NM, 3 voyages');
    expect(figuresWords({ runM: 0, voyages: 0 })).toBe('');
    expect(figuresWords(undefined)).toBe('');
    expect(nmWords(1852)).toBe('1.0 NM');
  });

  test('its record', () => {
    expect(recordWords(log())).toBe(
      '212.0 NM sailed · 31 voyages · 4 aboard others · 6 worlds · 14 charted · 9 over the falls · 12 m the closest to the falls · 12 bumps, 4 at fault · 2 gales ridden out · 23 of 71 kinds found',
    );
    expect(
      recordWords(log({ record: { ...log().record, voyages: 0, aboard: 0, charted: 0 } })),
    ).toBe('nothing logged yet');
  });

  test('who may read it', () => {
    expect(shownWords(log({ shown: 'me', chosen: false }))).toBe(
      'the sailor alone (the default for their age)',
    );
    expect(shownWords(log({ shown: 'sailors', chosen: true }))).toBe(
      'every sailor in the game (chosen)',
    );
    expect(shownWords(log({ machine: true }))).toBe(
      'every sailor in the game (a machine sailor’s, always)',
    );
  });

  test('the sailors in it', () => {
    expect(personWords({ name: 'Tom' })).toBe('Tom');
    expect(personWords({ name: 'Iron Mary', machine: true })).toBe('Iron Mary ⚙');
    expect(personWords({ hidden: true })).toBe('a sailor');
    expect(personWords({ former: true })).toBe('a former sailor');
  });

  test('a voyage and a time aboard', () => {
    expect(
      voyageWords({
        boat: 'keelboat',
        boatName: 'Gull',
        began: 0,
        ended: 0,
        how: 'over',
        place: 'the Skerries',
        runM: 15_556.8,
        closestM: 12,
        bumpsAtFault: 1,
        bumpsNotAtFault: 1,
        met: ['gale', 'gale-ridden-out', 'night-at-sea'],
        galePlace: 'Gull Reach',
        crew: [{ name: 'Tom' }, { name: 'Iron Mary', machine: true }],
        counted: 2,
      }),
    ).toBe(
      'skippered keelboat “Gull”; 8.4 NM; over the falls off the Skerries; with Tom, Iron Mary ⚙, 2 others; 12 m from the falls; 2 bumps, 1 at fault; met a gale; rode out a gale off Gull Reach; a night at sea',
    );
    expect(
      voyageWords({
        boat: '',
        began: 0,
        ended: 0,
        how: 'ashore',
        runM: null,
        aboard: true,
        skipper: { former: true },
        crew: [],
      }),
    ).toBe('aboard a former sailor’s a boat; distance not logged; went ashore');
  });

  test('its entries', () => {
    expect(
      entryWords({ at: 0, kind: 'charted', title: 'Keyhole Rock', what: 'an island of the rim' }),
    ).toBe('charted Keyhole Rock, an island of the rim');
    expect(
      entryWords({ at: 0, kind: 'sighted', title: 'Keyhole Rock', other: { name: 'Mira' } }),
    ).toBe('sighted Keyhole Rock aboard Mira’s boat');
    expect(
      entryWords({
        at: 0,
        kind: 'bump',
        other: { name: 'Tom' },
        otherBoat: 'Gull',
        fault: 'theirs',
        article: '10',
        place: 'Keyhole Rock',
      }),
    ).toBe('a bump with Tom in “Gull” off Keyhole Rock: the other’s fault, Article 10');
    expect(entryWords({ at: 0, kind: 'met', title: 'Humpback whale', place: 'Gull Reach' })).toBe(
      'met Humpback whale off Gull Reach',
    );
  });
});

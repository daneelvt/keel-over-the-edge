// SPDX-License-Identifier: AGPL-3.0-only

// The log's words: a day's remarks in a logbook's order, the weather
// first and how it ended last; bumps told warmly and folded past three;
// companions named as the server names them; the figures; the calendar;
// every kind of the collection named, from the catalog.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LogDay, LogEntry, LogRecord, LogVoyage } from './logapi';
import {
  bumpWords,
  companyWords,
  dayCell,
  empty,
  entryWords,
  figureWords,
  kindName,
  nm,
  recordLines,
  remarks,
  span,
  worldHeading,
} from './logwords';

const record: LogRecord = {
  distanceM: 212 * 1852,
  voyages: 31,
  aboard: 2,
  crewed: 4,
  worlds: 6,
  falls: 3,
  closestM: 12,
  bumpsAtFault: 1,
  bumps: 4,
  gales: 1,
  storms: 0,
  fogs: 1,
  nights: 5,
  charted: 14,
  sighted: 3,
  met: 20,
  kinds: 23,
  of: 64,
};

function voyage(v: Partial<LogVoyage>): LogVoyage {
  return {
    boat: catalog.boats[0]?.id ?? '',
    began: Date.UTC(2026, 10, 12, 14),
    ended: Date.UTC(2026, 10, 12, 16),
    how: 'returned',
    runM: 18.4 * 1852,
    crew: [],
    ...v,
  };
}

function bump(v: Partial<LogEntry>): LogEntry {
  return {
    at: 0,
    kind: 'bump',
    otherBoat: 'Gull',
    fault: 'theirs',
    article: '10',
    place: 'Keyhole Rock',
    ...v,
  };
}

describe('a day', () => {
  test('its remarks in a logbook’s order: the weather, the finds, the company, how it ended', () => {
    const d: LogDay = {
      date: '2026-11-12',
      runM: 18.4 * 1852,
      voyages: [
        voyage({
          how: 'over',
          place: 'the Skerries',
          met: ['gale', 'gale-ridden-out'],
          galePlace: 'Gull Reach',
        }),
      ],
      entries: [{ at: 0, kind: 'charted', title: 'Keyhole Rock' }],
    };
    expect(remarks(d)).toEqual([
      'Rode out a gale off Gull Reach',
      'Charted Keyhole Rock, first',
      'Went over the falls off the Skerries, and home again',
    ]);
  });

  test('a quiet day says so, never nothing', () => {
    expect(remarks({ date: '2026-11-12', runM: 0, voyages: [voyage({})], entries: [] })).toEqual([
      'A voyage, all well',
    ]);
  });

  test('bumps past three fold', () => {
    const entries = [1, 2, 3, 4, 5].map(() => bump({}));
    const r = remarks({ date: '2026-11-12', runM: 0, voyages: [], entries });
    // Alike, the three told are one remark.
    expect(r[r.length - 1]).toBe('and two more brushes');
  });

  test('the day’s column and the world’s heading', () => {
    expect(dayCell('2026-11-12')).toBe('Thu 12');
    expect(
      worldHeading(
        { number: 14, first: Date.UTC(2026, 10, 9, 12), last: Date.UTC(2026, 10, 15, 12) },
        'UTC',
      ),
    ).toBe('World 14 · 9–15 November');
  });
});

describe('a bump', () => {
  test('names the other boat and sailor, the place, the Article and whose the way was', () => {
    expect(bumpWords(bump({ other: { name: 'Tom', logged: true } }))).toBe(
      'A brush with the Gull, Tom, off Keyhole Rock; port tack keeps clear of starboard, the way the Gull’s to give',
    );
    expect(bumpWords(bump({ fault: 'mine', other: { hidden: true } }))).toBe(
      'A brush with the Gull, off Keyhole Rock; port tack keeps clear of starboard, the way ours to give',
    );
    expect(bumpWords({ at: 0, kind: 'bump', otherBoat: 'Gull', fault: 'none' })).toBe(
      'A brush with the Gull, in open water; no one at fault',
    );
  });
});

describe('company', () => {
  test('aboard another’s boat, with whom, how long and how far', () => {
    const v = voyage({
      aboard: true,
      boatName: 'Iron Mary',
      skipper: { name: 'Mira' },
      runM: 8.4 * 1852,
    });
    expect(companyWords(v)).toBe('Sailed aboard Iron Mary with Mira, 2 h, 8.4 NM');
  });

  test('skippered with those named, and those counted', () => {
    expect(
      companyWords(
        voyage({ boatName: 'Gull', crew: [{ name: 'Tom' }, { name: 'Bolt', machine: true }] }),
      ),
    ).toBe('Skippered Gull with Tom and Bolt ⚙');
    expect(companyWords(voyage({ boatName: 'Gull', counted: 3 }))).toBe(
      'Skippered Gull with three aboard',
    );
    expect(companyWords(voyage({}))).toBe('');
  });

  test('a sighting aboard names the skipper or not', () => {
    expect(
      entryWords({ at: 0, kind: 'sighted', title: 'Gull Reach', other: { name: 'Mira' } }),
    ).toBe('Sighted Gull Reach aboard Mira’s boat');
    expect(
      entryWords({ at: 0, kind: 'sighted', title: 'Gull Reach', other: { former: true } }),
    ).toBe('Sighted Gull Reach aboard a former sailor’s boat');
  });
});

describe('the figures', () => {
  test('the abstract’s and the whole record’s', () => {
    expect(figureWords('distance', 212 * 1852, record)).toEqual(['212 NM', 'sailed']);
    expect(figureWords('closest', 12, record)).toEqual(['12 m', 'from the falls, the nearest']);
    expect(figureWords('kinds', 23, record)).toEqual(['23 of 64', 'kinds found']);
    expect(recordLines(record).length).toBeGreaterThan(10);
    expect(nm(18.4 * 1852)).toBe('18.4');
    expect(nm(1804 * 1852)).toBe('1,804');
    expect(span(7200)).toBe('2 h');
    expect(span(80 * 60)).toBe('1 h 20 min');
  });

  test('an empty log is empty, not a verdict', () => {
    expect(empty({ ...record, voyages: 0, aboard: 0, charted: 0, sighted: 0 })).toBe(true);
    expect(empty(record)).toBe(false);
  });
});

describe('the collection', () => {
  test('every kind of every group the catalog has is named', () => {
    const groups: [string, string[]][] = [
      ['islands', catalog.world.biomes.map((b) => b.id)],
      ['sizes', catalog.world.sizes.map((s) => s.class)],
      ['features', catalog.world.features.kinds.map((k) => k.id)],
      ['places', catalog.world.places.kinds.map((k) => k.id)],
      ['life', catalog.life.kinds.map((k) => k.id)],
      ['boats', catalog.boats.map((b) => b.id)],
    ];
    for (const [g, ids] of groups) {
      for (const id of ids) {
        const n = kindName(g, id);
        expect(n, `${g} ${id}`).toMatch(/^[A-Z]/);
        expect(n, `${g} ${id}`).not.toBe(id);
      }
    }
    expect(kindName('edge', 'within-10m')).toBe('Within 10 m');
    expect(kindName('weather', 'night-at-sea')).toBe('A night at sea');
  });
});

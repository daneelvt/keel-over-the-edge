// SPDX-License-Identifier: AGPL-3.0-only

// The picture a race's link is shared with: its words (the race, its
// boats, its start for others anywhere, the course and who may enter),
// and its long name broken into lines that fit, the last cut with an
// ellipsis.

import { describe, expect, test } from 'vitest';
import type { RaceCard } from './raceapi';
import { pictureWords, wrap } from './racepicture';

const card: RaceCard = {
  code: 'abcdefghij',
  link: 'https://play.example/?r=abcdefghij',
  name: 'Tuesday Triangle',
  kind: 'race',
  phase: 'open',
  harbour: false,
  who: 'newcomers',
  course: {
    id: 'buoy:triangle:short',
    kind: 'buoy',
    shape: 'triangle',
    long: false,
    name: 'Short triangle off Port Royal',
  },
  boat: { id: 'b', name: 'Jolly boat' },
  startsAt: Date.UTC(2026, 10, 14, 3, 0),
  minutes: 10,
  owner: { name: 'Mira', machine: false },
  most: 12,
  entrants: [],
  mine: { owner: true, entered: false, withCrew: false, number: 0, moved: false },
  enter: { ok: true },
};

describe('the picture’s words', () => {
  test('the race, its boats, its start with the zone’s name, the course and who may enter', () => {
    const w = pictureWords(card, 'en-US', 'Pacific/Auckland');
    expect(w.name).toBe('Tuesday Triangle');
    expect(w.boats).toBe('Jolly boats');
    expect(w.when).toBe('Starts Saturday, 4:00 PM GMT+13');
    expect(w.at).toBe('Saturday, 4:00 PM GMT+13');
    expect(w.lines).toEqual(['Race', 'Triangle, short', 'Newcomers only']);
  });

  test('a time trial is open now; an island course says its length', () => {
    const w = pictureWords(
      {
        ...card,
        kind: 'trial',
        who: 'everyone',
        course: { id: 'island:3', kind: 'island', name: 'Round Gannet Holm', length: 4400 },
      },
      'en-US',
      'UTC',
    );
    expect(w.when).toBe('Open now');
    expect(w.lines).toEqual(['Time trial', 'Round Gannet Holm, 2.4 NM']);
  });
});

describe('a long name', () => {
  // One unit a character.
  const measure = (s: string) => s.length;

  test('broken at its spaces into lines that fit', () => {
    expect(wrap('the Gannet Holm Gallop', 12, 3, measure)).toEqual(['the Gannet', 'Holm Gallop']);
  });

  test('cut at the last line allowed, with an ellipsis', () => {
    const lines = wrap('one two three four five six seven', 9, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
    expect(measure(lines[1] ?? '')).toBeLessThanOrEqual(9);
  });

  test('a word longer than the line stands alone', () => {
    expect(wrap('Saltcliffsprint x', 5, 3, measure)).toEqual(['Saltcliffsprint', 'x']);
  });
});

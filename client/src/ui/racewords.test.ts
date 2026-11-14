// SPDX-License-Identifier: AGPL-3.0-only

// The words of races ashore: a start in the reader's own time, today,
// tomorrow or by its day; the time to it; the entrants by name, or by their
// boat and number; and every refusal the server gives, told kindly, with
// when it lifts. A refusal that fell through to the catch-all would read
// "That cannot be done just now", so each reason is checked against it.

import { describe, expect, test } from 'vitest';
import type { Entrant } from './raceapi';
import {
  actRefusalText,
  boatsText,
  clockText,
  enterRefusalText,
  entrantLabel,
  entrantText,
  fromLocalInput,
  greenhornText,
  harbourLine,
  laterDefault,
  localInput,
  makeRefusalText,
  ownerText,
  raceShareText,
  startOf,
  startsInText,
  whenLine,
  whenText,
  zonedWhenText,
} from './racewords';

const ZONE = 'Pacific/Auckland';
const LOCALE = 'en-US';
// Saturday 14 November 2026, 9:00 am in Auckland (NZDT, UTC+13).
const NOW = Date.UTC(2026, 10, 13, 20, 0);
const HOUR = 3_600_000;

const t = (until?: number) => ({ until, now: NOW, locale: LOCALE, zone: ZONE });

describe('a start in the reader’s own time', () => {
  test('today as the time alone, tomorrow by the word, later in the week by its day', () => {
    expect(clockText(NOW + 7 * HOUR + 10 * 60_000, LOCALE, ZONE)).toBe('4:10 PM');
    expect(whenText(NOW + 7 * HOUR, NOW, LOCALE, ZONE)).toBe('4:00 PM');
    expect(whenText(NOW + 24 * HOUR, NOW, LOCALE, ZONE)).toBe('tomorrow 9:00 AM');
    expect(whenText(NOW + 72 * HOUR, NOW, LOCALE, ZONE)).toBe('Tuesday 9:00 AM');
    expect(whenLine(NOW + 24 * HOUR, NOW, LOCALE, ZONE)).toBe('Tomorrow 9:00 AM');
  });

  test('a start just past midnight is tomorrow’s, by the reader’s zone, not UTC’s', () => {
    // 00:30 Sunday in Auckland is 11:30 Saturday UTC.
    expect(whenText(NOW + 15.5 * HOUR, NOW, LOCALE, ZONE)).toBe('tomorrow 12:30 AM');
  });

  test('for others anywhere, with the zone’s name', () => {
    expect(zonedWhenText(NOW + 7 * HOUR, LOCALE, ZONE)).toBe('Saturday, 4:00 PM GMT+13');
  });

  test('the time to the start, as the countdown reads, and Starting once it is due', () => {
    expect(startsInText(9 * 60_000 + 12_000, LOCALE)).toMatch(/^Starts in 9/);
    expect(startsInText(0)).toBe('Starting');
  });
});

describe('the entrants', () => {
  const e = (o: Partial<Entrant>): Entrant => ({
    number: 7,
    name: null,
    machine: false,
    newcomer: false,
    ...o,
  });

  test('by name, a machine sailor marked', () => {
    expect(entrantText(e({ name: 'Mira' }))).toBe('Mira');
    expect(entrantText(e({ name: 'Grey Gull', machine: true }))).toBe('Grey Gull ⚙');
    expect(entrantLabel(e({ name: 'Mira', newcomer: true }))).toEqual({
      kind: 'name',
      name: 'Mira',
      machine: false,
    });
  });

  test('one not named to the reader by their boat and number, or the number alone', () => {
    expect(entrantText(e({ boat: 'Gull' }))).toBe('the Gull, 7');
    expect(entrantText(e({}))).toBe('No. 7');
    expect(entrantText(e({ name: '', boat: '' }))).toBe('No. 7');
  });

  test('the owner: the Harbourmaster for the world’s own, a sailor for one not named', () => {
    expect(ownerText({ harbour: true, owner: null })).toBe('the Harbourmaster');
    expect(ownerText({ harbour: false, owner: { name: 'Mira', machine: false } })).toBe('Mira');
    expect(ownerText({ harbour: false, owner: { name: null, machine: false } })).toBe('a sailor');
  });
});

describe('refusals, told kindly', () => {
  const fallback = 'That cannot be done just now. Try again in a moment.';

  test('every reason entering may be refused for has words of its own', () => {
    for (const r of [
      'full',
      'closed',
      'started',
      'cancelled',
      'finished',
      'humans',
      'machines',
      'newcomers',
      'blocked',
      'ahead',
      'daily',
      'entered',
      'clash',
      'late',
      'not-found',
      'not-entered',
      'offline',
    ]) {
      expect(enterRefusalText(r, t()), r).not.toBe(fallback);
    }
    expect(enterRefusalText('something new', t())).toBe(fallback);
  });

  test('every reason making may be refused for has words of its own', () => {
    for (const r of ['made', 'owned', 'soon', 'late', 'course', 'areas', 'who', 'boat', 'name']) {
      expect(makeRefusalText(r, t()), r).not.toBe(fallback);
    }
  });

  test('every reason the owner’s acts may be refused for has words of its own', () => {
    for (const r of ['moved', 'started', 'cancelled', 'not-entered', 'not-finished', 'not-owner']) {
      expect(actRefusalText(r, t()), r).not.toBe(fallback);
    }
  });

  test('a limit says when it lifts', () => {
    const at = NOW + 7 * HOUR + 10 * 60_000;
    expect(enterRefusalText('daily', t(at))).toBe(
      'You’ve raced as often as a day allows. Your next race can start after 4:10 PM.',
    );
    expect(makeRefusalText('made', t(at))).toBe(
      'You’ve made as many races as a day allows. You can make the next after 4:10 PM.',
    );
    expect(enterRefusalText('ahead', t(NOW + 30 * HOUR))).toBe(
      'You’re entered in as many races ahead as you can be. You can enter another after tomorrow 3:00 PM.',
    );
    expect(makeRefusalText('late', t(NOW + 72 * HOUR))).toBe(
      'That’s too near the world’s end. The latest start is Tuesday 9:00 AM.',
    );
  });

  test('without a time, a limit still says what to do', () => {
    expect(enterRefusalText('daily', t())).toBe(
      'You’ve raced as often as a day allows. Rest a while, and race again later.',
    );
    expect(makeRefusalText('made', t())).toMatch(/Make the next one later\.$/);
  });

  test('a name refused says why', () => {
    expect(makeRefusalText('name', t(), 'long')).toBe('That name is too long.');
    expect(makeRefusalText('name', t(), 'words')).toBe('That name is not allowed. Try another.');
  });
});

describe('the board and the share', () => {
  test('a harbour race’s line: its start, its boats and how many are entered', () => {
    expect(
      harbourLine(
        {
          code: 'abcdefghij',
          name: 'the Teatime Trophy',
          kind: 'race',
          phase: 'open',
          harbour: true,
          who: 'everyone',
          boat: { id: 'b', name: 'Jolly boat' },
          startsAt: NOW + 7 * HOUR,
          entered: 5,
          most: 12,
          mine: { owner: false, entered: false },
          enter: { ok: true },
        },
        NOW,
        LOCALE,
        ZONE,
      ),
    ).toBe('4:00 PM · Jolly boats · 5 entered');
  });

  test('boats, many', () => {
    expect(boatsText('Jolly boat')).toBe('Jolly boats');
    expect(boatsText('Catamaran')).toBe('Catamarans');
    expect(boatsText('')).toBe('');
  });

  test('the week’s Greenhorn Cups: those still to come', () => {
    expect(greenhornText([NOW - HOUR, NOW + 6 * HOUR, NOW + 30 * HOUR], NOW, LOCALE, ZONE)).toBe(
      '3:00 PM · tomorrow 3:00 PM',
    );
  });

  test('the text a link is shared with ends in the link', () => {
    const s = raceShareText('Tuesday Triangle', 'Jolly boats', 'Tuesday 4:00 PM', 'https://x/?r=a');
    expect(s.endsWith('https://x/?r=a')).toBe(true);
    expect(s).toContain('Tuesday Triangle');
  });
});

describe('a start chosen', () => {
  test('a datetime field’s value round trips through the device’s own time', () => {
    const ms = new Date(2026, 10, 14, 16, 5).getTime();
    expect(localInput(ms)).toBe('2026-11-14T16:05');
    expect(fromLocalInput('2026-11-14T16:05')).toBe(ms);
    expect(fromLocalInput('')).toBeNaN();
  });

  test('minutes on start at a whole minute; a later one is the field’s', () => {
    const now = Date.UTC(2026, 10, 14, 3, 7, 42);
    expect(startOf(10, '', now)).toBe(Date.UTC(2026, 10, 14, 3, 17));
    expect(startOf(0, localInput(now + HOUR), now)).toBe(
      Math.floor((now + HOUR) / 60_000) * 60_000,
    );
  });

  test('a later start’s first offer: two hours on at the quarter, within the bounds', () => {
    const now = Date.UTC(2026, 10, 14, 3, 7);
    expect(laterDefault(now, now, now + 10 * HOUR)).toBe(Date.UTC(2026, 10, 14, 5, 15));
    expect(laterDefault(now, now, now + HOUR)).toBe(now + HOUR);
  });
});

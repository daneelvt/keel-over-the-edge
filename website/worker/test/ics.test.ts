// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { calendar, nextTurn } from '../src/ics';

const TURN = { weekday: 'Sunday', time: '18:00', zone: 'America/New_York' };

/** A calendar's content lines, unfolded (RFC 5545, 3.1). */
function lines(ics: string): string[] {
  expect(ics.endsWith('\r\n')).toBe(true);
  for (const l of ics.split('\r\n')) {
    expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  }
  return ics
    .replace(/\r\n /g, '')
    .split('\r\n')
    .filter((l) => l !== '');
}

/** The lines between BEGIN:name and its END. */
function component(all: string[], name: string): string[] {
  const from = all.indexOf(`BEGIN:${name}`);
  const to = all.indexOf(`END:${name}`, from);
  expect(from).toBeGreaterThanOrEqual(0);
  return all.slice(from + 1, to);
}

describe('the world’s end as a calendar', () => {
  test('weekly, in its zone, from the next end, with an alarm an hour before', () => {
    const now = Date.parse('2026-11-17T21:30:00Z');
    const all = lines(calendar(TURN, '2026-11-22T23:00:00Z', now));
    expect(all[0]).toBe('BEGIN:VCALENDAR');
    expect(all).toContain('VERSION:2.0');
    const event = component(all, 'VEVENT');
    expect(event).toContain('DTSTART;TZID=America/New_York:20261122T180000');
    expect(event).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU');
    expect(event.some((l) => l.startsWith('UID:'))).toBe(true);
    expect(event).toContain('DTSTAMP:20261117T213000Z');
    const alarm = component(event, 'VALARM');
    expect(alarm).toContain('TRIGGER:-PT1H');
    expect(alarm).toContain('ACTION:DISPLAY');
    expect(alarm.some((l) => l.startsWith('DESCRIPTION:'))).toBe(true);
  });

  test('the zone described: New York’s daylight from March’s second Sunday, standard from November’s first', () => {
    const all = lines(calendar(TURN, '2026-11-22T23:00:00Z', Date.parse('2026-11-17T21:30:00Z')));
    const zone = component(all, 'VTIMEZONE');
    expect(zone).toContain('TZID:America/New_York');
    const daylight = component(zone, 'DAYLIGHT');
    expect(daylight).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU');
    expect(daylight).toContain('TZOFFSETFROM:-0500');
    expect(daylight).toContain('TZOFFSETTO:-0400');
    expect(daylight).toContain('DTSTART:20260308T020000');
    const standard = component(zone, 'STANDARD');
    expect(standard).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU');
    expect(standard).toContain('TZOFFSETTO:-0500');
    expect(standard).toContain('DTSTART:20261101T020000');
  });

  test('without an end from keel, the next turn after now, across a change of the clocks', () => {
    // Saturday 31 October 2026, noon in New York: the clocks go back that night.
    const now = Date.parse('2026-10-31T16:00:00Z');
    expect(new Date(nextTurn(TURN, now)).toISOString()).toBe('2026-11-01T23:00:00.000Z');
    const event = component(lines(calendar(TURN, undefined, now)), 'VEVENT');
    expect(event).toContain('DTSTART;TZID=America/New_York:20261101T180000');
    // A Sunday evening after the turn: the next Sunday's.
    expect(new Date(nextTurn(TURN, Date.parse('2026-11-22T23:30:00Z'))).toISOString()).toBe(
      '2026-11-29T23:00:00.000Z',
    );
  });
});

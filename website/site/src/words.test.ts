// SPDX-License-Identifier: AGPL-3.0-only

// The page's live words and links: the AI apps' links carry the game's
// address exactly, the countdown and the turn in words, and the calendar's
// link every week at the turn in its own zone.

import { describe, expect, test } from 'vitest';
import {
  asOf,
  claudeCodeCommand,
  claudeLink,
  clockWords,
  cursorLink,
  googleLink,
  left,
  MCP,
  turnWords,
  vscodeLink,
  yourTime,
  zoneWords,
} from './words';

describe('the links that add the game to AI apps', () => {
  test('Claude’s add-connector dialog, with the name and the address', () => {
    const u = new URL(claudeLink());
    expect(u.origin + u.pathname).toBe('https://claude.ai/customize/connectors');
    expect(u.searchParams.get('modal')).toBe('add-custom-connector');
    expect(u.searchParams.get('connectorName')).toBe('Keel Over the Edge');
    expect(u.searchParams.get('connectorUrl')).toBe(MCP);
    expect(claudeLink()).toContain('connectorUrl=https%3A%2F%2Fagents.keelovertheedge.com%2Fmcp');
    expect(claudeLink()).toContain('connectorName=Keel%20Over%20the%20Edge');
  });

  test('Cursor’s install link, its config the address as base64 JSON', () => {
    const link = cursorLink();
    expect(
      link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=keel&config='),
    ).toBe(true);
    const config = new URL(link).searchParams.get('config') ?? '';
    expect(JSON.parse(atob(config))).toEqual({ url: MCP });
    // The base64's own + / = are escaped in the link.
    expect(link.slice(link.indexOf('config=') + 7)).not.toMatch(/[+/=]/);
  });

  test('VS Code’s install link, through its web redirect', () => {
    const link = vscodeLink();
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://vscode.dev/redirect');
    const inner = u.searchParams.get('url') ?? '';
    expect(inner.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(inner.slice('vscode:mcp/install?'.length)))).toEqual({
      name: 'keel',
      type: 'http',
      url: MCP,
    });
  });

  test('Claude Code’s one command', () => {
    expect(claudeCodeCommand()).toBe(
      'claude mcp add --transport http keel https://agents.keelovertheedge.com/mcp',
    );
  });
});

describe('the countdown and the turn in words', () => {
  const turn = { weekday: 'Sunday', time: '18:00', zone: 'America/New_York' };
  // Sunday 22 November 2026, 6 pm in New York (EST, UTC−5).
  const ends = Date.parse('2026-11-22T23:00:00Z');

  test('days, hours and minutes left, whole minutes, never below none', () => {
    const now = ends - (2 * 1440 + 4 * 60 + 17) * 60000 - 30000;
    expect(left(ends, now)).toEqual({ days: 2, hours: 4, minutes: 17 });
    expect(left(ends, ends + 5000)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  test('the turn as the schedule says it', () => {
    expect(turnWords(turn)).toBe('Sunday 6 pm New York time');
    expect(clockWords('09:30')).toBe('9:30 am');
    expect(clockWords('12:00')).toBe('noon');
    expect(clockWords('00:00')).toBe('midnight');
    expect(clockWords('00:15')).toBe('12:15 am');
    expect(zoneWords('America/Los_Angeles')).toBe('Los Angeles');
  });

  test('the end in the visitor’s own time and language', () => {
    expect(yourTime(ends, 'en-GB', 'Pacific/Auckland')).toBe('Monday 23 November at 12:00');
    expect(yourTime(ends, 'en-US', 'America/New_York')).toBe('Sunday, November 22 at 6:00 PM');
  });

  test('Google Calendar: every week at the turn, in its own zone, from this end on', () => {
    const u = new URL(googleLink(ends, turn));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('dates')).toBe('20261122T180000/20261122T183000');
    expect(u.searchParams.get('ctz')).toBe('America/New_York');
    expect(u.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU');
    expect(u.searchParams.get('details')).toContain('https://play.keelovertheedge.com/');
  });

  test('when the numbers were read', () => {
    expect(asOf(14, Date.parse('2026-11-17T14:20:00Z'), 'en-GB', 'UTC')).toBe(
      'World 14 · as of 14:20',
    );
  });
});

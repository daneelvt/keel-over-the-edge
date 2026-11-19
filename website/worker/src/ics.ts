// SPDX-License-Identifier: AGPL-3.0-only

// The world's end as a calendar event (RFC 5545): every week at the
// schedule's day and hour in its own zone, from the next end on, with an
// alarm an hour before, for a calendar that takes a file (Apple's,
// Outlook's). The zone is described in the file itself, its daylight and
// standard time found from the platform's own zone data.

import type { Turn } from './status';

const DAYS: Record<string, string> = {
  Sunday: 'SU',
  Monday: 'MO',
  Tuesday: 'TU',
  Wednesday: 'WE',
  Thursday: 'TH',
  Friday: 'FR',
  Saturday: 'SA',
};

/** A moment's wall clock in a zone: year, month, day, hour, minute, second, and the weekday. */
function wall(ms: number, zone: string): { parts: number[]; weekday: string } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    parts: ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) => Number(p[k])),
    weekday: p.weekday ?? '',
  };
}

/** A zone's offset from UTC at a moment, minutes. */
function offsetAt(ms: number, zone: string): number {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = wall(ms, zone).parts;
  return Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / 60000);
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** A wall clock as iCalendar writes a local time: 20261122T180000. */
function local(parts: number[]): string {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = parts;
  return `${y}${two(mo)}${two(d)}T${two(h)}${two(mi)}${two(s)}`;
}

/** An offset as iCalendar writes it: -0500. */
function utcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `${sign}${two(Math.floor(m / 60))}${two(m % 60)}`;
}

/**
 * The zone's year about a moment as VTIMEZONE's parts: each change of its
 * offset found in that year, by the day and then the minute, written as a
 * yearly rule on the same weekday of its month.
 */
function timezone(zone: string, around: number): string[] {
  const year = new Date(around).getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const changes: { at: number; from: number; to: number }[] = [];
  let last = offsetAt(start, zone);
  for (let day = 1; day <= 366; day++) {
    const t = start + day * 86400000;
    const o = offsetAt(t, zone);
    if (o !== last) {
      // To the minute, within the day before.
      let lo = t - 86400000;
      let hi = t;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (offsetAt(mid, zone) === last) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      changes.push({ at: hi, from: last, to: o });
      last = o;
    }
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  if (changes.length === 0) {
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${utcOffset(last)}`,
      `TZOFFSETTO:${utcOffset(last)}`,
      'END:STANDARD',
    );
  }
  for (const c of changes) {
    // The wall clock just before the change, in the offset it leaves.
    const before = new Date(c.at + c.from * 60000);
    const day = before.getUTCDate();
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][before.getUTCDay()];
    const nth =
      day >
      new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth() + 1, 0)).getUTCDate() - 7
        ? -1
        : Math.ceil(day / 7);
    const kind = c.to > c.from ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${local([before.getUTCFullYear(), before.getUTCMonth() + 1, day, before.getUTCHours(), before.getUTCMinutes(), 0])}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${before.getUTCMonth() + 1};BYDAY=${nth}${weekday}`,
      `TZOFFSETFROM:${utcOffset(c.from)}`,
      `TZOFFSETTO:${utcOffset(c.to)}`,
      `END:${kind}`,
    );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/** The next time the turn comes after now, ms: its day and hour in its zone. */
export function nextTurn(turn: Turn, now: number): number {
  const [hh = 0, mm = 0] = turn.time.split(':').map(Number);
  // Each minute's step would do; each day's at the hour, then the zone's offset, is enough.
  for (let d = 0; d <= 7; d++) {
    const probe = now + d * 86400000;
    const { parts, weekday } = wall(probe, turn.zone);
    if (weekday !== turn.weekday) {
      continue;
    }
    const [y = 0, mo = 1, day = 1] = parts;
    const guess = Date.UTC(y, mo - 1, day, hh, mm);
    const at = guess - offsetAt(guess, turn.zone) * 60000;
    // Across a change of the zone's offset, once more from where that lands.
    const exact = guess - offsetAt(at, turn.zone) * 60000;
    if (exact > now) {
      return exact;
    }
  }
  return now + 7 * 86400000;
}

/** A content line folded at 75 octets, as RFC 5545 asks. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) {
    return line;
  }
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const room = first ? 75 : 74;
    let n = Math.min(rest.length, room);
    while (new TextEncoder().encode(rest.slice(0, n)).length > room) {
      n--;
    }
    out.push((first ? '' : ' ') + rest.slice(0, n));
    rest = rest.slice(n);
    first = false;
  }
  return out.join('\r\n');
}

/** Text as an iCalendar TEXT value. */
function text(s: string): string {
  return s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

/**
 * The calendar: the world's end every week at the turn, from the next end
 * (endsAt when keel says it, else the next turn after now), with an alarm
 * an hour before.
 */
export function calendar(turn: Turn, endsAt: string | undefined, now: number): string {
  const byday = DAYS[turn.weekday] ?? 'SU';
  const given = endsAt === undefined ? Number.NaN : Date.parse(endsAt);
  const first = Number.isFinite(given) && given > now ? given : nextTurn(turn, now);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Keel Over the Edge//The world//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...timezone(turn.zone, first),
    'BEGIN:VEVENT',
    'UID:new-world@keelovertheedge.com',
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${turn.zone}:${local(wall(first, turn.zone).parts)}`,
    'DURATION:PT30M',
    `RRULE:FREQ=WEEKLY;BYDAY=${byday}`,
    `SUMMARY:${text('A new world at sea: Keel Over the Edge')}`,
    `DESCRIPTION:${text("This week's world ends and a new one begins. Set sail at https://play.keelovertheedge.com/")}`,
    'URL:https://keelovertheedge.com/',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${text('A new world in an hour')}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

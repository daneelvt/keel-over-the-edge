// SPDX-License-Identifier: AGPL-3.0-only

// The world's life as the page tells it: the time left to its end, counted
// by keel's clock and never the page's own, and a moment in three zones,
// the schedule's, UTC's and the owner's.

/**
 * How far keel's clock is ahead of the page's, ms: keel's time as read,
 * against the page's halfway between the asking and the answer.
 */
export function serverOffset(serverNow: number, sent: number, received: number): number {
  return serverNow - (sent + received) / 2;
}

/** Keel's clock now, ms of UTC, by the page's clock and the offset last measured. */
export function serverNow(offset: number, local = Date.now()): number {
  return local + offset;
}

/** A span as days, hours, minutes and seconds: "4d 06:12:09", none below nought. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d}d ${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** The locales whose short names for zones are tried in turn, for a name better than an offset. */
const NAMING = ['en-US', 'en-GB', 'en-AU', 'en-IN'];

const formats = new Map<string, Intl.DateTimeFormat>();

function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale} ${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, options);
    formats.set(key, f);
  }
  return f;
}

function part(f: Intl.DateTimeFormat, ms: number, type: Intl.DateTimeFormatPartTypes): string {
  return f.formatToParts(ms).find((p) => p.type === type)?.value ?? '';
}

/** A zone's short name at a moment: EST, NZDT, CET; an offset (GMT+9) where no locale names it. */
export function zoneName(ms: number, zone: string): string {
  let first = '';
  for (const locale of NAMING) {
    const name = part(
      format(locale, { timeZone: zone, timeZoneName: 'short' }),
      ms,
      'timeZoneName',
    );
    if (!/^GMT[+\-−]/.test(name)) {
      return name;
    }
    first ||= name;
  }
  return first;
}

/** The day in a zone: "Sunday 1 November". */
function day(ms: number, zone: string): string {
  return format('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }).format(
    ms,
  );
}

/** The time of day in a zone: "6:00 pm" on a twelve-hour clock, "18:00" on the other. */
function time(ms: number, zone: string, twelve: boolean): string {
  return format('en-GB', {
    timeZone: zone,
    hour: twelve ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: twelve,
  }).format(ms);
}

/** The weekday in a zone: "Monday". */
function weekday(ms: number, zone: string): string {
  return format('en-GB', { timeZone: zone, weekday: 'long' }).format(ms);
}

/** A moment in one zone, its day in full: "Sunday 1 November, 6:00 pm EST". */
export function inZone(ms: number, zone: string): string {
  const z = zone === '' ? 'UTC' : zone;
  return `${day(ms, z)}, ${time(ms, z, z !== 'UTC')} ${zoneName(ms, z)}`;
}

/**
 * A moment in the schedule's zone (UTC for a schedule of periods), in UTC
 * and in the owner's own, each once: "Sunday 1 November, 6:00 pm EST ·
 * 23:00 UTC · Monday 12:00 NZDT". The day is named again only where it
 * differs from the first's.
 */
export function threeZones(ms: number, zone: string, own: string): string {
  const first = zone === '' ? 'UTC' : zone;
  const firstDay = day(ms, first);
  const words = [inZone(ms, first)];
  const seen = new Set([first]);
  for (const z of ['UTC', own]) {
    if (z === '' || seen.has(z)) {
      continue;
    }
    seen.add(z);
    const other = day(ms, z) !== firstDay ? `${weekday(ms, z)} ` : '';
    words.push(`${other}${time(ms, z, false)} ${zoneName(ms, z)}`);
  }
  return words.join(' · ');
}

/** The owner's own zone, as the browser has it. */
export function ownZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A moment in a few words, in the owner's zone: "Sun 1 Nov, 18:00". */
export function brief(ms: number, zone?: string): string {
  return ms <= 0
    ? '—'
    : format('en-GB', {
        timeZone: zone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(ms);
}

/** Whether the page's tab is hidden: it reads nothing then. */
export function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

// SPDX-License-Identifier: AGPL-3.0-only

// The page's live words and links, worked out from the game's numbers: how
// long until this world ends, when that is in the visitor's own time and
// in the schedule's, a Google Calendar link for it; and the links that add
// the game's address for AI apps to them. Plain functions, so the build,
// the page's script and the tests share them.

/** The game, and its address for AI apps. */
export const GAME = 'https://play.keelovertheedge.com/';
export const MCP = 'https://agents.keelovertheedge.com/mcp';
/** The name AI apps list it under. */
export const CONNECTOR = 'Keel Over the Edge';
/** The short name a command line gives it. */
export const SERVER = 'keel';

/** Claude's dialog to add a custom connector, filled in for the visitor to confirm. */
export function claudeLink(url: string = MCP): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(CONNECTOR)}&connectorUrl=${encodeURIComponent(url)}`;
}

/** Cursor's link to install an MCP server: its config as base64 JSON. */
export function cursorLink(url: string = MCP): string {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER)}&config=${encodeURIComponent(config)}`;
}

/** VS Code's link to install an MCP server, through its web redirect, as a web page must give it. */
export function vscodeLink(url: string = MCP): string {
  const inner = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER, type: 'http', url }))}`;
  return `https://vscode.dev/redirect?url=${encodeURIComponent(inner)}`;
}

/** The one command that adds it to Claude Code. */
export function claudeCodeCommand(url: string = MCP): string {
  return `claude mcp add --transport http ${SERVER} ${url}`;
}

/** The schedule's turn, as the status gives it: Sunday, 18:00, America/New_York. */
export interface Turn {
  weekday: string;
  time: string;
  zone: string;
}

/** Days, hours and minutes left, whole minutes rounded down; none for a moment past. */
export function left(
  endsAt: number,
  now: number,
): { days: number; hours: number; minutes: number } {
  const mins = Math.max(0, Math.floor((endsAt - now) / 60000));
  return { days: Math.floor(mins / 1440), hours: Math.floor(mins / 60) % 24, minutes: mins % 60 };
}

/** One, or more: "1 day", "2 days". */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The turn's time in words: "18:00" → "6 pm", "09:30" → "9:30 am", "12:00" → "noon", "00:00" → "midnight". */
export function clockWords(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  if (m === 0 && h === 12) {
    return 'noon';
  }
  if (m === 0 && h === 0) {
    return 'midnight';
  }
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`} ${h < 12 ? 'am' : 'pm'}`;
}

/** The zone's place in words: "America/New_York" → "New York". */
export function zoneWords(zone: string): string {
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

/** The turn in words: "Sunday 6 pm New York time". */
export function turnWords(turn: Turn): string {
  return `${turn.weekday} ${clockWords(turn.time)} ${zoneWords(turn.zone)} time`;
}

/** The end in the visitor's own time: "Monday 23 November, 12:00 pm" as their browser writes it. */
export function yourTime(endsAt: number, locale?: string, zone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(endsAt);
}

const DAYS: Record<string, string> = {
  Sunday: 'SU',
  Monday: 'MO',
  Tuesday: 'TU',
  Wednesday: 'WE',
  Thursday: 'TH',
  Friday: 'FR',
  Saturday: 'SA',
};

/** A moment as a wall clock in a zone, for a calendar: 20261122T180000. */
function wallStamp(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${p('year')}${p('month')}${p('day')}T${p('hour')}${p('minute')}${p('second')}`;
}

/**
 * Google Calendar's link to add an event: every week at the turn, in the
 * turn's own zone, from this world's end on, half an hour long.
 */
export function googleLink(endsAt: number, turn: Turn): string {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'A new world in Keel Over the Edge',
    dates: `${wallStamp(endsAt, turn.zone)}/${wallStamp(endsAt + 30 * 60000, turn.zone)}`,
    ctz: turn.zone,
    recur: `RRULE:FREQ=WEEKLY;BYDAY=${DAYS[turn.weekday] ?? 'SU'}`,
    details: `This week’s world ends and a new one, uncharted, begins. Set sail: ${GAME}`,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** "World 14 · as of 2:20 pm", the time in the visitor's own clock. */
export function asOf(world: number, at: number, locale?: string, zone?: string): string {
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(at);
  return `World ${world} · as of ${time}`;
}

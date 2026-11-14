// SPDX-License-Identifier: AGPL-3.0-only

// The day's edition of the news as the server answers GET /api/news: its
// figures, its stories, the reader's own box, the world's notices and its
// other days. A story's words never hold a name: each name is a slot, {0},
// {1}, …, its index in the story's names, set here by its kind, so a
// player's text is always shown as theirs.

/** A name in a story: a sailor named, a machine sailor, a boat when the sailor is not named, "a sailor" (a block), "a former sailor". */
export interface NewsName {
  kind: 'human' | 'machine' | 'boat' | 'sailor' | 'former';
  /** The sailor's name, or the boat's. */
  name?: string;
  /** A named sailor's boat's name, if the story has it. */
  boat?: string;
  /** A boat with no name: its kind's name. */
  type?: string;
  /** Whether the reader may open the named sailor's log. */
  logged?: boolean;
}

/** A story: its headword, its words with slots, its names, and where: a place's box (subject and number) or a point (x east, y north, m). */
export interface NewsStory {
  id: string;
  kind: string;
  at: number;
  head: string;
  text: string;
  names: NewsName[];
  subject?: string;
  number: number;
  x?: number;
  y?: number;
  /** The date of the edition it is in, for a sailor's stories. */
  day?: string;
  /** Struck by the owner: shown to the owner alone. */
  struck?: boolean;
}

/** The day in counts, never names: boats (machine sailors among them), the distance run (m), places charted, crews in company, falls. */
export interface NewsFigures {
  boats: number;
  machines: number;
  run: number;
  charted: number;
  crews: number;
  over: number;
}

/** A notice of the world's own: its end, which each reader reads in their own time. */
export interface NewsNotice {
  id: string;
  head: string;
  endsAt: number;
  x: number;
  y: number;
}

/** One of the world's editions. */
export interface NewsDay {
  day: string;
  number: number;
  set: boolean;
}

/** A day's edition. */
export interface Edition {
  world: number;
  /** Its date by the world's schedule, 2006-01-02, and the zone its days are kept in. */
  day: string;
  number: number;
  zone: string;
  /** Set once the day is over: it never changes again. */
  set: boolean;
  figures: NewsFigures;
  figuresText: string;
  /** Above the front page, on a world's first: its arrival, and the last world in review. */
  lead: NewsStory[];
  stories: NewsStory[];
  /** The reader's own box: their shipmates', those they follow, and their own. */
  shipmates: NewsStory[];
  notices: NewsNotice[];
  /** The world's editions, the newest first. */
  days: NewsDay[];
}

/** A part of a story's words: words, or a name. */
export type StoryPart = { words: string } | { name: NewsName; opens: boolean };

/** A story's words in parts, each slot its name; opens is true for a name that opens a sentence, to take a capital. */
export function storyParts(text: string, names: readonly NewsName[]): StoryPart[] {
  const out: StoryPart[] = [];
  const slot = /\{(\d+)\}/g;
  let at = 0;
  for (let m = slot.exec(text); m !== null; m = slot.exec(text)) {
    const before = text.slice(at, m.index);
    if (before !== '') {
      out.push({ words: before });
    }
    const name = names[Number(m[1])];
    const opens = m.index === 0 || /\.\s$/.test(text.slice(0, m.index));
    out.push(name === undefined ? { words: 'a sailor' } : { name, opens });
    at = m.index + m[0].length;
  }
  if (at < text.length) {
    out.push({ words: text.slice(at) });
  }
  return out;
}

/**
 * A name's words around the player's text: "the ", "a Jolly boat", "a
 * sailor"; the player's own words are the name itself. A named sailor's
 * boat, when the story has it, stands before them: "the Iron Mary, Mira,"
 * (boat), its comma left to the words after it when they open with one
 * (stops: the next character of the story's words).
 */
export function nameWords(
  n: NewsName,
  opens: boolean,
  stops = '',
): { before: string; boat: string; text: string; after: string } {
  const cap = (s: string) => (opens ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const own = (after: string) => {
    if (n.boat === undefined || n.boat === '') {
      return { before: '', boat: '', text: n.name ?? '', after };
    }
    return {
      before: cap('the '),
      boat: n.boat,
      text: n.name ?? '',
      after: /^[,.;:!?]/.test(stops) ? after : `${after},`,
    };
  };
  switch (n.kind) {
    case 'human':
      return own('');
    case 'machine':
      return own(' ⚙');
    case 'boat':
      if (n.name !== undefined && n.name !== '') {
        return { before: cap('the '), boat: n.name, text: '', after: '' };
      }
      return { before: cap(article(n.type ?? 'boat')), boat: '', text: '', after: '' };
    case 'sailor':
      return { before: cap('a sailor'), boat: '', text: '', after: '' };
    default:
      return { before: cap('a former sailor'), boat: '', text: '', after: '' };
  }
}

/** The words after a part of a story: what a name's comma looks to. */
export function nextWords(parts: readonly StoryPart[], i: number): string {
  const p = parts[i + 1];
  return p !== undefined && 'words' in p ? p.words : '';
}

/** A kind's name with "a" or "an". */
function article(kind: string): string {
  return /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/** A story's words as plain text, its names set in: for an accessible name and the tests. */
export function storyText(s: NewsStory): string {
  const parts = storyParts(s.text, s.names);
  return parts
    .map((p, i) => {
      if ('words' in p) {
        return p.words;
      }
      const w = nameWords(p.name, p.opens, nextWords(parts, i));
      return w.before + w.boat + (w.boat !== '' && w.text !== '' ? ', ' : '') + w.text + w.after;
    })
    .join('');
}

/** Every story of an edition: above the front page, on it, and the reader's own box. */
export function storiesOf(e: Edition): NewsStory[] {
  return [...e.lead, ...e.stories, ...e.shipmates];
}

/** The day of a date, 2006-01-02, as an instant: its midday in UTC, so its calendar date reads the same in UTC. */
function middayOf(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m === null ? null : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/** The place a zone is named for: "America/New_York" is "New York". */
export function zonePlace(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/** Whether two zones keep one calendar day: the same name, or the same wall clock at the day's midday. */
function sameDay(a: string, b: string, at: Date): boolean {
  if (a === b) {
    return true;
  }
  const f = (z: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: z, dateStyle: 'short', timeStyle: 'long' }).format(
      at,
    );
  try {
    return f(a) === f(b);
  } catch {
    return false;
  }
}

/**
 * An edition's date as its masthead reads it, a calendar date: "Thursday
 * 12 November"; with the place whose clock keeps the world's days when the
 * reader's own differs, "Thursday 12 November (New York)". own is the
 * reader's zone, the device's by default.
 */
export function editionDate(day: string, zone: string, own?: string): string {
  const at = middayOf(day);
  if (at === null) {
    return day;
  }
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(at);
  const mine = own ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === '' || sameDay(mine, zone, at) ? date : `${date} (${zonePlace(zone)})`;
}

/** An edition's day, short, for its key: "Wednesday 11". */
export function editionDay(day: string): string {
  const at = middayOf(day);
  return at === null
    ? day
    : new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', timeZone: 'UTC' }).format(
        at,
      );
}

/** A headword as it is set in small capitals: its first letter a capital, the rest small. */
export function headWords(head: string): string {
  return head.charAt(0) + head.slice(1).toLowerCase();
}

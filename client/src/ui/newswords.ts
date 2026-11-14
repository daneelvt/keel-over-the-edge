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

/** A name's words around the player's text: "the ", "a Jolly boat", "a sailor"; the player's own words are the name itself. */
export function nameWords(
  n: NewsName,
  opens: boolean,
): { before: string; text: string; after: string } {
  const cap = (s: string) => (opens ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  switch (n.kind) {
    case 'human':
      return { before: '', text: n.name ?? '', after: '' };
    case 'machine':
      return { before: '', text: n.name ?? '', after: ' ⚙' };
    case 'boat':
      if (n.name !== undefined && n.name !== '') {
        return { before: cap('the '), text: n.name, after: '' };
      }
      return { before: cap(article(n.type ?? 'boat')), text: '', after: '' };
    case 'sailor':
      return { before: cap('a sailor'), text: '', after: '' };
    default:
      return { before: cap('a former sailor'), text: '', after: '' };
  }
}

/** A kind's name with "a" or "an". */
function article(kind: string): string {
  return /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/** A story's words as plain text, its names set in: for an accessible name and the tests. */
export function storyText(s: NewsStory): string {
  return storyParts(s.text, s.names)
    .map((p) => {
      if ('words' in p) {
        return p.words;
      }
      const w = nameWords(p.name, p.opens);
      return w.before + w.text + w.after;
    })
    .join('');
}

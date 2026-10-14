// SPDX-License-Identifier: AGPL-3.0-only

// The words of the Articles, the game's right-of-way rules: the Racing
// Rules of Sailing's Part 2, numbered as the rulebook numbers them, each
// said in the game's own words. A bump's line names the Article that
// judged it and whose fault it was; the overlay's marks name the Article
// that says who keeps clear.

/** What each Article asks, by its number. */
export const ARTICLES: Record<string, string> = {
  '10': 'port tack keeps clear of starboard',
  '11': 'windward keeps clear of leeward',
  '12': 'clear astern keeps clear of clear ahead',
  '13': 'a boat tacking keeps clear',
  '15': 'a boat gaining right of way gives room',
  '16.1': 'a boat with right of way changing course gives room',
  '22': 'keep clear of a capsized boat',
};

/** A boat's part in a bump, as the server says it. */
export type BumpPart = 'yours' | 'theirs' | 'none' | 'seen';

/** The line a bump puts under the readout, for the sailor of one of the two boats. */
export function bumpLine(article: string, part: BumpPart): string {
  if (part === 'none') {
    return 'Bump · no fault';
  }
  const rule = ARTICLES[article];
  const why = rule === undefined ? '' : ` · ${rule} (Article ${article})`;
  return `Bump${why} · ${part === 'yours' ? 'yours' : 'theirs'}`;
}

/** A boat's tack as the readout shows it: −1 port, 1 starboard; tacking. */
export function tackText(tack: number, tacking: boolean): string {
  if (tacking) {
    return 'Tacking';
  }
  return tack < 0 ? 'Port tack' : 'Starboard tack';
}

/** The numbers of the Articles as the physics module gives them, as the rulebook writes them. */
export function articleName(code: number): string {
  switch (code) {
    case 10:
    case 11:
    case 12:
    case 13:
    case 15:
    case 22:
      return String(code);
    case 16:
      return '16.1';
    default:
      return '';
  }
}

// SPDX-License-Identifier: AGPL-3.0-only

// The words of the list of sailors to watch and of the card about one:
// the orders and whom the list shows, a row's facts and why it ranks
// high, the empty list, the card's sections, following, and the switch
// that lets others watch the voyage under way. Apart from watchwords.ts,
// which the game's first download holds: these are needed only once the
// watching module is loaded.

import { compassPoint } from './format';
import type { WatchSort, WatchWho } from './settings';

/** The orders, in the row of choices under the search. */
export const SORTS: readonly { value: WatchSort; words: string }[] = [
  { value: 'liveliest', words: 'Liveliest' },
  { value: 'watched', words: 'Most watched' },
  { value: 'edge', words: 'Nearest the edge' },
  { value: 'weather', words: 'Roughest weather' },
  { value: 'fast', words: 'Fastest' },
  { value: 'name', words: 'By name' },
];

/** Whom the list shows. */
export const WHOS: readonly { value: WatchWho; words: string }[] = [
  { value: 'all', words: 'Everyone' },
  { value: 'following', words: 'Following' },
  { value: 'machine', words: 'Machine sailors' },
  { value: 'human', words: 'Human sailors' },
];

export const ORDER = 'Order';
export const SHOW = 'Show';
export const PICK_ONE = 'Pick one for me';
export const LOOK_AGAIN = 'Look again';
export const ABOUT = 'ⓘ';
export const BACK = '‹ Back';
export const FOLLOW = '☆ Follow';
export const FOLLOWING = '★ Following';
export const UNFOLLOW = 'Unfollow';
export const THE_WEATHER = 'The weather';
export const WHERE = 'Where';
export const THIS_VOYAGE = 'This voyage';
export const IN_SIGHT = 'In sight';

/** The empty list: why no one is there, and who can be watched. */
export const NONE_AT_SEA = 'No one at sea can be watched just now.';
export const WHO_CAN_BE_WATCHED =
  'Machine sailors can always be watched while they sail. Other sailors choose whether to allow it.';

/** The Following list with no one on it. */
export const FOLLOWING_NONE = 'You follow no one yet: ☆ Follow is on each sailor’s ⓘ.';

/** Following a 101st sailor. */
export const TOO_MANY = 'You follow 100 sailors: unfollow one first';

/** The switch, in the menu and on the account page, for the voyage under way. */
export const LET_WATCH_VOYAGE = 'Let others watch me sail (this voyage)';

/** ⓘ's name: "About Iron Mary". */
export function aboutName(sailor: string): string {
  return `About ${sailor}`;
}

/** ★'s name on a row: "Unfollow Iron Mary". */
export function unfollowName(sailor: string): string {
  return `${UNFOLLOW} ${sailor}`;
}

/** How many boats are in the water, watchable or not: "" for none. */
export function boatsAtSeaText(n: number): string {
  return n === 1 ? '1 boat is at sea.' : n > 1 ? `${n} boats are at sea.` : '';
}

/** The search that matched no one, around the words typed. */
export function noMatchWords(q: string): [string, string, string] {
  return ['No one at sea who can be watched has ', q, ' in their name.'];
}

/** Look again, with how many more the last look found: "Look again · 3 more at sea". */
export function lookAgainText(more: number): string {
  return more > 0 ? `${LOOK_AGAIN} · ${more} more at sea` : LOOK_AGAIN;
}

/** Why a row ranks high, as the server sends it. */
export interface Lively {
  why: 'storm' | 'squalls' | 'edge' | 'approach' | 'charted' | 'capsized';
  subject?: string;
  minutes?: number;
}

/** A while ago, in minutes: "4 min ago", or "just now". */
function ago(minutes: number): string {
  return minutes >= 1 ? `${Math.round(minutes)} min ago` : 'just now';
}

/** What was charted and when: "charted Gull Island 4 min ago"; the card puts a comma before when. */
export function chartedText(subject: string | undefined, minutes: number, comma = false): string {
  return `charted ${subject ?? 'something'}${comma ? ',' : ''} ${ago(minutes)}`;
}

/** A reason in words. */
export function livelyText(l: Lively): string {
  switch (l.why) {
    case 'storm':
      return 'in a storm';
    case 'squalls':
      return 'in squalls';
    case 'edge':
      return 'close to the edge';
    case 'approach':
      return 'skimming the falls';
    case 'charted':
      return chartedText(l.subject, l.minutes ?? 0);
    case 'capsized':
      return 'capsized';
  }
  return '';
}

/** The reasons, in the order sent: "in squalls · charted Gull Island 4 min ago". */
export function livelyLine(lively: readonly Lively[] | undefined): string {
  return (lively ?? [])
    .map(livelyText)
    .filter((t) => t !== '')
    .join(' · ');
}

/** How far inside the lip: "1.2 NM from the edge". */
export function edgeText(nm: number): string {
  return `${nm.toFixed(1)} NM from the edge`;
}

/** A row's facts: "1.2 NM from the edge · force 6 · 5.8 kn · 3 watching", what is withheld or nought left out. */
export function factsText(r: {
  edgeNM?: number;
  force: number;
  knots: number;
  watchers: number;
}): string {
  const out: string[] = [];
  if (typeof r.edgeNM === 'number') {
    out.push(edgeText(r.edgeNM));
  }
  if (r.force > 0) {
    out.push(`force ${r.force}`);
  }
  if (r.knots >= 0.05) {
    out.push(`${r.knots.toFixed(1)} kn`);
  }
  if (r.watchers > 0) {
    out.push(`${r.watchers} watching`);
  }
  return out.join(' · ');
}

/** The wind at the boat: "force 5 from the SW", or "calm". */
export function windWords(force: number, from: number): string {
  return force > 0 ? `force ${force} from the ${compassPoint(Math.round(from))}` : 'calm';
}

/** The waves: "waves 1.4 m". */
export function wavesText(m: number): string {
  return `waves ${m.toFixed(1)} m`;
}

/** The nearest charted island: "Gull Island, 3.1 NM to the NE". */
export function islandText(i: { name: string; bearing: number; nm: number }): string {
  return `${i.name}, ${i.nm.toFixed(1)} NM to the ${compassPoint(Math.round(i.bearing))}`;
}

/** The closest survived pass inside the lip: "skimmed the falls at 140 m". */
export function skimmedText(m: number): string {
  return `skimmed the falls at ${Math.round(m)} m`;
}

/** Where, withheld from a sailor whose own boat is in the water, around the name. */
export function withheldWords(sailor: string): [string, string, string] {
  return ['Leave the water to see where ', sailor, ' is.'];
}

/** The viewer's own machine sailor's lamp, in words. */
export function agentText(connected: boolean): string {
  return connected
    ? 'Your machine sailor’s AI is at the helm'
    : 'Your machine sailor’s AI has gone quiet';
}

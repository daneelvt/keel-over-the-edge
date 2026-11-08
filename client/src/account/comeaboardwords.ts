// SPDX-License-Identifier: AGPL-3.0-only

// A link to come aboard, as the page is opened at it: /sail/<token>. The
// skipper's boat and how it stands, in a sailor's words, are read from the
// server once the player is signed in; the link itself names nobody.

/** The path a link to come aboard is opened at, its token after it. */
export const SAIL_PATH = '/sail/';

/** A link's token from the page's path, or '' when the page was not opened at one. */
export function sailFromPath(path: string): string {
  if (!path.startsWith(SAIL_PATH)) {
    return '';
  }
  const token = path.slice(SAIL_PATH.length);
  // A token is one segment of URL-safe characters.
  return /^[A-Za-z0-9_-]{1,256}$/.test(token) ? token : '';
}

/** How a skipper's boat stands for a knock, as GET /api/sail/{token} says. */
export type LinkCan = 'ok' | 'not-at-sea' | 'full' | 'closed' | 'own';

/** What GET /api/sail/{token} answers. */
export interface SailLink {
  skipper: string;
  /** The skipper's look, by its code. */
  look: number;
  /** The boat's kind, by its place in the catalog. */
  kind: number;
  /** The boat's name; '' for none. */
  boat: string;
  can: LinkCan;
}

/** A link read: what it is, ended, or not read. */
export type LinkRead = { kind: 'link'; link: SailLink } | { kind: 'ended' } | { kind: 'failed' };

const CANS: readonly string[] = ['ok', 'not-at-sea', 'full', 'closed', 'own'];

/** The server's answer to GET /api/sail/{token} as the page reads it. */
export function linkOf(status: number, body: unknown): LinkRead {
  if (status === 410) {
    return { kind: 'ended' };
  }
  const b = body as Partial<SailLink> | null;
  if (
    status !== 200 ||
    b === null ||
    typeof b !== 'object' ||
    typeof b.skipper !== 'string' ||
    typeof b.can !== 'string' ||
    !CANS.includes(b.can)
  ) {
    return { kind: 'failed' };
  }
  return {
    kind: 'link',
    link: {
      skipper: b.skipper,
      look: typeof b.look === 'number' ? b.look : -1,
      kind: typeof b.kind === 'number' ? b.kind : -1,
      boat: typeof b.boat === 'string' ? b.boat : '',
      can: b.can,
    },
  };
}

/** A kind of boat as a sentence names it: "the keelboat". */
export function theKind(kindName: string): string {
  return `the ${kindName.toLowerCase()}`;
}

export const ASK_ABOARD = 'Ask to come aboard';

/** The knock's button: "Ask to come aboard «Saltpeter» with Iron Mary", or "the keelboat" for a boat with no name. */
export function askAboardText(kindName: string, boat: string, skipper: string): string {
  return `${ASK_ABOARD} ${boat === '' ? theKind(kindName) : `«${boat}»`} with ${skipper}`;
}

/** Under the knock's button, what it does, either side of the skipper's name. */
export const KNOCK_LINE = ['Your own boat sets sail, and', 'is asked to let you aboard.'] as const;

export const LINK_ENDED = 'This link has ended.';
export const OWN_LINK = 'This is your own link.';
export const LINK_UNREAD = 'The harbour can’t read this link just now.';
export const READING_LINK = 'Reading the link…';
export const SAIL_ON_MY_OWN = 'Set sail on my own';

/** Why a knock can't be made now, in a sailor's words; '' when it can. */
export function cantKnockText(can: LinkCan, skipper: string): string {
  switch (can) {
    case 'ok':
      return '';
    case 'not-at-sea':
      return `${skipper}’s boat isn’t in the water now.`;
    case 'full':
      return `${skipper}’s boat has no room aboard.`;
    case 'closed':
      return `${skipper} isn’t taking crew now.`;
    case 'own':
      return OWN_LINK;
  }
}

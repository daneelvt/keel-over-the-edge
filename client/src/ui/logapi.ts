// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's log as the server keeps it (GET /api/me/log, /api/log,
// /api/machines/log, every one behind a session): data only, the words
// are the page's (logwords.ts). And who may read the player's own, set
// by PUT /api/me/log; and whether a sailor can be watched now.

import type { Look } from '../catalog/looks';
import type { LogWho } from '../chart/chart';

/** A sailor named in a log: by name (⚙ for a machine), or "a sailor" for a block (hidden), or a former sailor; s, their time aboard, s. */
export interface LogPerson {
  name?: string;
  machine?: boolean;
  /** The reader may open their log. */
  logged?: boolean;
  hidden?: boolean;
  former?: boolean;
  s?: number;
}

/** How a voyage ended, as the log keeps it. */
export type LogHow = 'returned' | 'expired' | 'over' | 'taken' | 'aboard' | 'ashore' | 'landed';

/** A voyage of a log's day, or a time aboard another's boat (aboard, with its skipper). Times ms, distances m. */
export interface LogVoyage {
  /** The boat's kind, by its catalog id. */
  boat: string;
  boatName?: string;
  began: number;
  ended: number;
  how: LogHow;
  /** The charted place nearest where it ended; none in open water. */
  place?: string;
  runM: number | null;
  closestM?: number;
  bumpsAtFault?: number;
  bumpsNotAtFault?: number;
  /** The weather met: gale, storm, and the log's kinds of weather. */
  met?: string[];
  galePlace?: string;
  fogPlace?: string;
  aboard?: boolean;
  skipper?: LogPerson;
  crew: LogPerson[];
  /** Those aboard not named. */
  counted?: number;
}

/** A notable thing of a log's day. */
export interface LogEntry {
  at: number;
  kind: 'charted' | 'sighted' | 'found' | 'met' | 'bump';
  times?: number;
  title?: string;
  what?: string;
  worth?: number;
  group?: string;
  find?: string;
  place?: string;
  x?: number;
  y?: number;
  other?: LogPerson;
  otherBoat?: string;
  article?: string;
  fault?: 'mine' | 'theirs' | 'none';
}

/** A day of a log in its zone: its date, YYYY-MM-DD, and the distance run that day, m. */
export interface LogDay {
  date: string;
  runM: number;
  voyages: LogVoyage[];
  entries: LogEntry[];
}

/** A world of a log, its first and last times, ms. */
export interface LogWorld {
  number: number;
  first: number;
  last: number;
  current?: boolean;
}

/** A kind of the collection: how often found over every world, whether this world, and where first. */
export interface LogKind {
  id: string;
  count: number;
  thisWorld?: boolean;
  first?: { world: number; at: number; place?: string };
}

/** A group of the collection, its kinds in the catalog's order. */
export interface LogGroup {
  id: string;
  found: number;
  kinds: LogKind[];
}

/** Every count of a log, over every world. Distances m. */
export interface LogRecord {
  distanceM: number;
  voyages: number;
  aboard: number;
  crewed: number;
  worlds: number;
  falls: number;
  closestM: number | null;
  bumpsAtFault: number;
  bumps: number;
  gales: number;
  storms: number;
  fogs: number;
  nights: number;
  charted: number;
  sighted: number;
  met: number;
  kinds: number;
  of: number;
}

/** A sailor's races counted over every world. */
export interface RaceCounts {
  sailed: number;
  top3: number;
  wins: number;
  /** Each award given, by its name: best-start, comeback, photo-finish, crowd, spoon. */
  awards: Record<string, number>;
  /** Each time trial's medal: harbourmaster, gold, silver, bronze. */
  medals: Record<string, number>;
  ran: number;
}

/** A race in a log: the sailor's ribbon of it. Times ms. */
export interface LogRibbon {
  world: number;
  at: number;
  code: string;
  name: string;
  kind: 'race' | 'trial';
  course: string;
  /** The boats' kind, by its catalog id. */
  boat: string;
  boatName?: string;
  fleet: number;
  harbour?: boolean;
  newcomers?: boolean;
  role: 'skipper' | 'crew';
  place?: number;
  how?: 'finished' | 'placed' | 'ret' | 'dns' | 'removed';
  medal?: string;
  awards: string[];
  /** A crew's skipper, where named. */
  skipper?: LogPerson;
  /** In the reader's own log: whether its wooden spoon hangs from their sterns. */
  hung?: boolean;
}

/**
 * A log's races: the counts kept for good; and, read by the page, races
 * from the newest, with more while older ones follow. The log itself
 * carries the counts alone.
 */
export interface LogRibbons {
  counts: RaceCounts;
  races?: LogRibbon[];
  more?: boolean;
}

/** How many races a page of a log's ribbons lists, as the server pages them. */
export const RIBBONS_PAGE = 30;

/** A sailor's log, a world's days at a time. */
export interface Log {
  name: string;
  machine: boolean;
  look: Look;
  since: number;
  /** The reader's own log, or their machine sailor's. */
  own: boolean;
  /** Who may read it, in one's own: sailors in the game, or the sailor alone; and whether chosen. */
  shown?: 'sailors' | 'me';
  chosen?: boolean;
  loggedFrom?: number;
  abstract: { kind: string; value: number }[];
  record: LogRecord;
  worlds: LogWorld[];
  world: (LogWorld & { days: LogDay[] }) | null;
  collection: LogGroup[];
  zone: string;
  worldNow?: number;
  /** The races sailed; none from an older server. */
  ribbons?: LogRibbons | null;
}

/** What asking for a log came to: the log; not there to be read (unknown and refused alike); or not had. */
export type LogAnswer = { log: Log } | { refused: true } | null;

/** Who may read the player's own log. */
export type LogShown = 'sailors' | 'me';

/** Where the log is read from: the server's routes, or a test's stand-in. */
export interface LogSource {
  read(who: LogWho, world: number): Promise<LogAnswer>;
  /** A page of a log's races, the newest first, after the first from; null if not had. */
  ribbons(who: LogWho, from: number): Promise<LogRibbons | null>;
  setShown(shown: LogShown): Promise<boolean>;
  /** Whether a sailor's boat can be watched now. */
  watchable(name: string): Promise<boolean>;
}

/** The route a log is read by; with from, a page of its races. */
export function logPath(who: LogWho, world: number, from: number | null = null): string {
  const q = new URLSearchParams();
  if (who.kind === 'sailor') {
    q.set('name', who.name);
  } else if (who.kind === 'machine') {
    q.set('id', who.id);
  }
  if (world > 0) {
    q.set('world', String(world));
  }
  if (from !== null) {
    q.set('part', 'ribbons');
    if (from > 0) {
      q.set('from', String(from));
    }
  }
  const base =
    who.kind === 'own' ? '/api/me/log' : who.kind === 'sailor' ? '/api/log' : '/api/machines/log';
  const s = q.toString();
  return s === '' ? base : `${base}?${s}`;
}

/** The server's routes. */
export const serverLogs: LogSource = {
  async read(who, world) {
    try {
      const res = await fetch(logPath(who, world), {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (res.status === 404) {
        return { refused: true };
      }
      if (!res.ok) {
        return null;
      }
      const log = (await res.json()) as Log;
      return typeof log?.name === 'string' ? { log } : null;
    } catch {
      return null;
    }
  },
  async ribbons(who, from) {
    try {
      const res = await fetch(logPath(who, 0, from), {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        return null;
      }
      const rb = (await res.json()) as LogRibbons;
      return typeof rb?.counts === 'object' && rb.counts !== null ? rb : null;
    } catch {
      return null;
    }
  },
  async setShown(shown) {
    try {
      const res = await fetch('/api/me/log', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shown }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  async watchable(name) {
    try {
      const res = await fetch(`/api/watch/sailor?${new URLSearchParams({ name })}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      return res.status === 200;
    } catch {
      return false;
    }
  },
};

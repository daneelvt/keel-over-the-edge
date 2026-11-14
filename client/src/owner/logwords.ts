// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's log in the owner's words, as an account's card and the
// search's rows tell it: plain, every name shown, the figures first.

import type { LogEntry, LogFigures, LogPerson, LogVoyage, OwnerLog } from './api';
import { plural } from './machines';

/** Metres in nautical miles, "8.4 NM". */
export function nmWords(m: number): string {
  return `${(m / 1852).toFixed(1)} NM`;
}

/** A log in the search's rows: "212.4 NM, 31 voyages"; "" for nothing logged. */
export function figuresWords(f: LogFigures | undefined): string {
  if (f === undefined || (f.runM === 0 && f.voyages === 0)) {
    return '';
  }
  return `${nmWords(f.runM)}, ${plural(f.voyages, 'voyage')}`;
}

/** A log's record in one line, every count over every world. */
export function recordWords(l: OwnerLog): string {
  const r = l.record;
  if (r.voyages === 0 && r.aboard === 0 && r.charted === 0) {
    return 'nothing logged yet';
  }
  const words = [
    `${nmWords(r.distanceM)} sailed`,
    plural(r.voyages, 'voyage'),
    `${r.aboard} aboard others`,
    plural(r.worlds, 'world'),
    `${r.charted} charted`,
    `${r.falls} over the falls`,
  ];
  if (r.closestM !== null) {
    words.push(`${r.closestM} m the closest to the falls`);
  }
  words.push(`${plural(r.bumps, 'bump')}, ${r.bumpsAtFault} at fault`);
  if (r.gales > 0) {
    words.push(`${plural(r.gales, 'gale')} ridden out`);
  }
  words.push(`${r.kinds} of ${r.of} kinds found`);
  return words.join(' · ');
}

/** Who may read a log, in words. */
export function shownWords(l: OwnerLog): string {
  const who = l.machine || l.shown === 'sailors' ? 'every sailor in the game' : 'the sailor alone';
  if (l.machine) {
    return `${who} (a machine sailor’s, always)`;
  }
  return `${who} (${l.chosen === true ? 'chosen' : 'the default for their age'})`;
}

/** A sailor named in a log, to the owner: their name, ⚙ for a machine sailor. */
export function personWords(p: LogPerson | undefined): string {
  if (p === undefined) {
    return 'someone';
  }
  if (p.former === true) {
    return 'a former sailor';
  }
  if (p.hidden === true || p.name === undefined) {
    return 'a sailor';
  }
  return p.machine === true ? `${p.name} ⚙` : p.name;
}

const HOW: Record<LogVoyage['how'], string> = {
  returned: 'brought out of the water',
  expired: 'left when the connection’s grace ran out',
  over: 'over the falls',
  taken: 'taken by the falls at the world’s end',
  aboard: 'left to go aboard another’s boat',
  ashore: 'went ashore',
  landed: 'ashore as the boat left the water',
};

const MET: Record<string, string> = {
  gale: 'met a gale',
  storm: 'met a storm',
  'gale-ridden-out': 'rode out a gale',
  'storm-ridden-out': 'rode out a storm',
  'landfall-in-fog': 'made port in fog',
  'night-at-sea': 'a night at sea',
};

/** A voyage of a log, to the owner, in one line. */
export function voyageWords(v: LogVoyage): string {
  const boat = `${v.boat === '' ? 'a boat' : v.boat}${v.boatName !== undefined ? ` “${v.boatName}”` : ''}`;
  const words = [
    v.aboard === true ? `aboard ${personWords(v.skipper)}’s ${boat}` : `skippered ${boat}`,
    v.runM === null ? 'distance not logged' : nmWords(v.runM),
    HOW[v.how] + (v.place !== undefined ? ` off ${v.place}` : ''),
  ];
  const with_ = v.crew.map(personWords);
  if ((v.counted ?? 0) > 0) {
    with_.push(plural(v.counted ?? 0, 'other'));
  }
  if (with_.length > 0) {
    words.push(`with ${with_.join(', ')}`);
  }
  if (v.closestM !== undefined) {
    words.push(`${v.closestM} m from the falls`);
  }
  const bumps = (v.bumpsAtFault ?? 0) + (v.bumpsNotAtFault ?? 0);
  if (bumps > 0) {
    words.push(`${plural(bumps, 'bump')}, ${v.bumpsAtFault ?? 0} at fault`);
  }
  for (const m of v.met ?? []) {
    if (m === 'gale-ridden-out' && v.galePlace !== undefined) {
      words.push(`${MET[m]} off ${v.galePlace}`);
    } else if (m === 'landfall-in-fog' && v.fogPlace !== undefined) {
      words.push(`made ${v.fogPlace} in fog`);
    } else if (MET[m] !== undefined) {
      words.push(MET[m]);
    }
  }
  return words.join('; ');
}

/** An entry of a log, to the owner, in one line. */
export function entryWords(e: LogEntry): string {
  const off = e.place !== undefined ? ` off ${e.place}` : '';
  switch (e.kind) {
    case 'charted':
      return `charted ${e.title ?? 'a place'}${e.what !== undefined ? `, ${e.what}` : ''}`;
    case 'sighted':
      return `sighted ${e.title ?? 'a place'} aboard ${personWords(e.other)}’s boat`;
    case 'found':
      return `first ${e.find ?? ''} found (${e.group ?? ''})${off}`;
    case 'met':
      return `met ${e.title ?? e.find ?? 'life'}${off}`;
    case 'bump': {
      const fault =
        e.fault === 'mine'
          ? 'their fault'
          : e.fault === 'theirs'
            ? 'the other’s fault'
            : 'no one’s fault';
      const art = e.article !== undefined ? `, Article ${e.article}` : '';
      return `a bump with ${personWords(e.other)}${e.otherBoat !== undefined ? ` in “${e.otherBoat}”` : ''}${off}: ${fault}${art}`;
    }
  }
  return e.kind;
}

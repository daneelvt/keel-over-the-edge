// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's log in the logbook's words: warm, short, the period's way.
// A day's remarks are folded from its voyages and entries in the order a
// log writes them: the weather first, then what was found, then with
// whom, then how it ended. Going over the falls is a story, never a
// verdict; a log never reads zero as one. The names of kinds come from
// the catalog, never from a list here.

import { catalog } from '../catalog';
import type {
  LogDay,
  LogEntry,
  LogGroup,
  LogPerson,
  LogRecord,
  LogVoyage,
  LogWorld,
} from './logapi';
import { ARTICLES } from './verdict';

/** An empty log's words. */
export const NOT_YET = 'Not yet to sea. The log begins with the first voyage.';
/** A log that is not there, and one the reader may not read: the same words for both. */
export const NO_SUCH_LOG =
  'No log to read by that name: there is no such sailor, or they keep their log to themselves.';
/** A log that could not be had. */
export const NOT_HAD = 'The log cannot be had just now.';
/** The player's own log without a sailor. */
export const NO_SAILOR = 'A log is kept by a sailor: make yours and set sail.';
export const YOUR_LOG = 'Your log';
/** The key that opens another sailor's log from their name. */
export const THEIR_LOG = 'Their log';
/** The key that opens a machine sailor's log from its row. */
export const ITS_LOG = 'Its log';
export const DAYS = 'Days';
export const COLLECTION = 'Collection';
export const WHOLE_RECORD = 'The whole record';
export const WHO_READS = 'Who may read your log';
export const SAILORS = 'Sailors in the game';
export const ONLY_YOU = 'Only you';
export const MACHINE_SAILOR = 'Machine sailor ⚙';
export const READING = 'Reading the log…';
export const TRY_AGAIN = 'Try again';
export const WATCH = 'Watch';
export const CLOSE = 'Close';

/** Who may read the log, in a line under the setting. */
export function shownLine(shown: 'sailors' | 'me' | undefined, machine: boolean): string {
  if (machine) {
    return 'A machine sailor’s log is read by every sailor in the game.';
  }
  return shown === 'me'
    ? 'Only you read it. Sailors see your name in the news, not your log.'
    : 'Any sailor in the game may read it, from your name.';
}

/** n and its noun, "1 voyage", "3 voyages". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

/** Small numbers in words, as a log writes them. */
const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A count in words up to ten, in figures past it. */
export function inWords(n: number): string {
  return SMALL[n] ?? n.toLocaleString('en');
}

/** Metres as nautical miles: one decimal under a hundred, whole above. */
export function nm(m: number): string {
  const n = m / 1852;
  return n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString('en');
}

/** A day's run in its column: "18.4"; blank for none. */
export function runCell(m: number): string {
  return m < 50 ? '' : nm(m);
}

/** A distance to the lip, metres: "12 m". */
export function metres(m: number): string {
  return `${Math.round(m).toLocaleString('en')} m`;
}

/** A time span, s: "2 h", "1 h 20 min", "35 min". */
export function span(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) {
    return `${min} min`;
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 || h >= 5 ? `${h} h` : `${h} h ${m} min`;
}

/** Calendar words in the log's zone, falling back to the reader's own. */
function format(zone: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: zone === '' ? undefined : zone });
  } catch {
    return new Intl.DateTimeFormat('en-GB', o);
  }
}

/** A day's date, YYYY-MM-DD, as the day column has it: "Thu 12". */
export function dayCell(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    return date;
  }
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return `${format('UTC', { weekday: 'short' }).format(at)} ${d}`;
}

/** A day's date in full, "Thursday 12 November". */
export function dayLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    return date;
  }
  return format('UTC', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

/** A world's heading: "World 14 · 9–15 November", its days in the log's zone. */
export function worldHeading(w: LogWorld, zone: string): string {
  const day = format(zone, { day: 'numeric' });
  const month = format(zone, { month: 'long' });
  const a = new Date(w.first);
  const b = new Date(w.last);
  const ma = month.format(a);
  const mb = month.format(b);
  const when =
    day.format(a) === day.format(b) && ma === mb
      ? `${day.format(a)} ${ma}`
      : ma === mb
        ? `${day.format(a)}–${day.format(b)} ${mb}`
        : `${day.format(a)} ${ma} – ${day.format(b)} ${mb}`;
  return `World ${w.number} · ${when}${w.current === true ? ', sailing now' : ''}`;
}

/** "Since October 2026". */
export function sinceLine(since: number, zone: string): string {
  return since > 0
    ? `Since ${format(zone, { month: 'long', year: 'numeric' }).format(new Date(since))}`
    : '';
}

/** A time of day in the log's zone, "14:05". */
export function clock(at: number, zone: string): string {
  return format(zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(at),
  );
}

/** "Distance logged from 13 November": the log's distance began then. */
export function loggedFromLine(at: number, zone: string): string {
  return `Distance logged from ${format(zone, { day: 'numeric', month: 'long' }).format(new Date(at))}`;
}

/** A figure of the abstract: its figure, and what it counts. */
export function figureWords(kind: string, value: number, r: LogRecord): [string, string] {
  switch (kind) {
    case 'distance':
      return [`${nm(value)} NM`, 'sailed'];
    case 'voyages':
      return [value.toLocaleString('en'), value === 1 ? 'voyage' : 'voyages'];
    case 'charted':
      return [
        value.toLocaleString('en'),
        value === 1 ? 'place charted first' : 'places charted first',
      ];
    case 'closest':
      return [metres(value), 'from the falls, the nearest'];
    case 'gales':
      return [value.toLocaleString('en'), value === 1 ? 'gale ridden out' : 'gales ridden out'];
    case 'kinds':
      return [`${value} of ${r.of}`, 'kinds found'];
  }
  return [String(value), kind];
}

/** Whether a log has nothing in it yet. */
export function empty(r: LogRecord): boolean {
  return r.voyages === 0 && r.aboard === 0 && r.charted === 0 && r.sighted === 0;
}

/** Every count of a log, over every world, as the whole record lists them; those at none left out. */
export function recordLines(r: LogRecord): [string, string][] {
  const out: [string, string][] = [
    ['Sailed', `${nm(r.distanceM)} NM`],
    ['Voyages', r.voyages.toLocaleString('en')],
  ];
  const add = (label: string, n: number, text = n.toLocaleString('en')) => {
    if (n > 0) {
      out.push([label, text]);
    }
  };
  add('Aboard another’s boat', r.aboard);
  add('With others aboard', r.crewed);
  add('Worlds sailed', r.worlds);
  add('Places charted first', r.charted);
  add('Places sighted aboard', r.sighted);
  add('Over the falls', r.falls);
  if (r.closestM !== null) {
    out.push(['Nearest the falls, and back', metres(r.closestM)]);
  }
  add(
    'Brushes with other boats',
    r.bumps,
    `${r.bumps.toLocaleString('en')} · ${r.bumpsAtFault.toLocaleString('en')} the way ours to give`,
  );
  add('Gales ridden out', r.gales);
  add('Storms ridden out', r.storms);
  add('Landfalls in fog', r.fogs);
  add('Nights at sea', r.nights);
  add('Life met at sea', r.met);
  out.push(['Kinds found', `${r.kinds} of ${r.of}`]);
  return out;
}

/** A person named in a log as the reader may see them; ⚙ for a machine sailor. */
export function personWords(p: LogPerson | undefined): string {
  if (p === undefined) {
    return 'a sailor';
  }
  if (p.former === true) {
    return 'a former sailor';
  }
  if (p.hidden === true || p.name === undefined) {
    return 'a sailor';
  }
  return p.machine === true ? `${p.name} ⚙` : p.name;
}

/** Names in a run: "Tom", "Tom and Mira", "Tom, Ann and Mira". */
export function joined(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A boat's kind's name by its id: "Jolly boat"; the id as given for one the catalog has not. */
export function boatKind(id: string): string {
  return catalog.boats.find((b) => b.id === id)?.name ?? id;
}

/** A boat as a log names it: "the Gull", or "a Jolly boat" with no name. */
export function boatWords(id: string, name: string | undefined): string {
  if (name !== undefined && name !== '') {
    return `the ${name}`;
  }
  const k = boatKind(id);
  return `${/^[aeiou]/i.test(k) ? 'an' : 'a'} ${k}`;
}

/** "off Gull Reach", or "in open water". */
function off(place: string | undefined): string {
  return place === undefined || place === '' ? 'in open water' : `off ${place}`;
}

/** The weather a voyage met, in the log's words, ridden out before met. */
function weatherOf(v: LogVoyage): string[] {
  const met = new Set(v.met ?? []);
  const out: string[] = [];
  if (met.has('storm-ridden-out')) {
    out.push(`Rode out a storm ${off(v.galePlace)}`);
  } else if (met.has('storm')) {
    out.push(`Met a storm ${off(v.galePlace)}`);
  }
  if (met.has('gale-ridden-out')) {
    out.push(`Rode out a gale ${off(v.galePlace)}`);
  } else if (met.has('gale') && !met.has('storm') && !met.has('storm-ridden-out')) {
    out.push(`Met a gale ${off(v.galePlace)}`);
  }
  if (met.has('landfall-in-fog')) {
    out.push(v.fogPlace !== undefined ? `Made ${v.fogPlace} in fog` : 'Made port in fog');
  }
  if (met.has('night-at-sea')) {
    out.push('A night at sea');
  }
  return out;
}

/** A kind's name in its group of the collection, by its id; the id as given for one not known. */
export function kindName(group: string, id: string): string {
  switch (group) {
    case 'islands':
      return `${capital(id)} island`;
    case 'sizes': {
      // The two smallest classes are nouns of their own, a rock and an
      // islet; the rest say how big an island is.
      const s = catalog.world.sizes.find((z) => z.class === id);
      return s !== undefined && s.below <= 100 ? capital(id) : `${capital(id)} island`;
    }
    case 'features':
      return catalog.world.features.kinds.find((k) => k.id === id)?.name ?? capital(id);
    case 'places':
      return catalog.world.places.kinds.find((k) => k.id === id)?.name ?? capital(id);
    case 'life':
      return catalog.life.kinds.find((k) => k.id === id)?.name ?? capital(id);
    case 'boats':
      return boatKind(id);
    case 'weather':
      return WEATHER_KINDS[id] ?? capital(id);
    case 'edge': {
      const m = /^within-(\d+)m$/.exec(id);
      return m === null ? capital(id) : `Within ${m[1]} m`;
    }
  }
  return capital(id);
}

/** The log's own kinds of weather. */
const WEATHER_KINDS: Record<string, string> = {
  'gale-ridden-out': 'A gale ridden out',
  'storm-ridden-out': 'A storm ridden out',
  'landfall-in-fog': 'A landfall in fog',
  'night-at-sea': 'A night at sea',
};

/** What each group of the collection is called. */
export function groupTitle(id: string): string {
  return GROUPS[id] ?? capital(id);
}

const GROUPS: Record<string, string> = {
  islands: 'Islands',
  sizes: 'Islands by size',
  features: 'Features of islands',
  places: 'Places',
  life: 'Life at sea',
  weather: 'Weather',
  edge: 'The edge',
  boats: 'Boats sailed',
};

function capital(s: string): string {
  const w = s.replace(/-/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** A kind of life met, in a line: "Met a humpback whale off Gull Reach", "Met laughing gulls three times". */
function metWords(e: LogEntry): string {
  const k = catalog.life.kinds.find((x) => x.id === e.find);
  const times = e.times ?? 1;
  const name = k === undefined ? (e.title ?? 'life at sea') : times > 1 ? k.plural : k.name;
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const what =
    times > 1 || k === undefined ? lower : `${/^[aeiou]/i.test(lower) ? 'an' : 'a'} ${lower}`;
  return `Met ${what} ${off(e.place)}${times > 1 ? `, ${inWords(times)} times` : ''}`;
}

/** A bump, warmly: "A brush with the Gull, Tom, off Keyhole Rock; port tack keeps clear of starboard, the way ours to give". */
export function bumpWords(e: LogEntry): string {
  const boat =
    e.otherBoat !== undefined && e.otherBoat !== '' ? `the ${e.otherBoat}` : 'another boat';
  const who =
    e.other !== undefined && e.other.hidden !== true && e.other.name !== undefined
      ? `, ${personWords(e.other)}`
      : '';
  const rule = e.article !== undefined ? ARTICLES[e.article] : undefined;
  const fault =
    e.fault === 'mine'
      ? 'the way ours to give'
      : e.fault === 'theirs'
        ? `the way ${e.otherBoat !== undefined && e.otherBoat !== '' ? `the ${e.otherBoat}’s` : 'theirs'} to give`
        : 'no one at fault';
  return `A brush with ${boat}${who}, ${off(e.place)}; ${rule !== undefined ? `${rule}, ` : ''}${fault}`;
}

/** An entry of a day, in a line. */
export function entryWords(e: LogEntry): string {
  switch (e.kind) {
    case 'charted':
      return `Charted ${e.title ?? 'a place'}, first`;
    case 'sighted':
      return `Sighted ${e.title ?? 'a place'} aboard ${e.other !== undefined ? `${personWords(e.other)}’s boat` : 'another’s boat'}`;
    case 'found': {
      const k = kindName(e.group ?? '', e.find ?? '');
      return `${k}, the first found${e.place !== undefined ? `, ${off(e.place)}` : ''}`;
    }
    case 'met':
      return metWords(e);
    case 'bump':
      return bumpWords(e);
  }
  return '';
}

/** With whom a voyage sailed, or nothing alone. */
export function companyWords(v: LogVoyage): string {
  const named = v.crew.map(personWords);
  const more = v.counted ?? 0;
  if (v.aboard === true) {
    const skipper = personWords(v.skipper);
    const others = named.filter((n) => n !== skipper);
    const boat =
      v.boatName !== undefined && v.boatName !== ''
        ? v.boatName
        : `${skipper}’s ${boatKind(v.boat)}`;
    const lasted = span(Math.max(0, (v.ended - v.began) / 1000));
    const run = v.runM !== null && v.runM >= 50 ? `, ${nm(v.runM)} NM` : '';
    return `Sailed aboard ${boat} with ${withWords([skipper, ...others], more)}, ${lasted}${run}`;
  }
  if (named.length === 0 && more === 0) {
    return '';
  }
  const boat = boatWords(v.boat, v.boatName).replace(/^the /, '');
  if (named.length === 0) {
    return `Skippered ${boat} with ${inWords(more)} aboard`;
  }
  return `Skippered ${boat} with ${withWords(named, more)}`;
}

/** Companions in a line: two named at most, the rest counted. */
function withWords(named: string[], more: number): string {
  const shown = named.slice(0, 2);
  const rest = named.length - shown.length + more;
  return rest === 0
    ? joined(shown)
    : `${shown.join(', ')} and ${inWords(rest)} ${rest === 1 ? 'other' : 'others'}`;
}

/** How a voyage ended, where the log tells it: going over the falls, or taken at the world's end; nothing for an ordinary landfall. */
export function endWords(v: LogVoyage): string {
  switch (v.how) {
    case 'over':
      return `Went over the falls ${off(v.place)}, and home again`;
    case 'taken':
      return 'At sea when the falls took the world';
  }
  return '';
}

/** How a voyage ended, in its own line when the day is opened. */
export function howWords(v: LogVoyage): string {
  switch (v.how) {
    case 'returned':
      return v.place !== undefined ? `back ${off(v.place)}` : 'back to port';
    case 'expired':
      return 'the line to shore lost';
    case 'over':
      return `over the falls ${off(v.place)}`;
    case 'taken':
      return 'taken with the world';
    case 'aboard':
      return 'went aboard another’s boat';
    case 'ashore':
      return 'went ashore';
    case 'landed':
      return 'ashore as the boat came out of the water';
  }
  return '';
}

/** How many of a day's bumps are told before the rest fold. */
const BUMPS_TOLD = 3;

/** A day's remarks as one entry of the log: each after the first begun in small letters, a full stop at the end. */
export function remarksLine(lines: string[]): string {
  return `${lines.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1))).join('; ')}.`;
}

/**
 * A day's remarks: the weather met, then what was found and met, then
 * with whom, then the bumps, then how voyages ended; each once.
 */
export function remarks(d: LogDay): string[] {
  const weather: string[] = [];
  const company: string[] = [];
  const ends: string[] = [];
  for (const v of d.voyages) {
    weather.push(...weatherOf(v));
    const c = companyWords(v);
    if (c !== '') {
      company.push(c);
    }
    const e = endWords(v);
    if (e !== '') {
      ends.push(e);
    }
  }
  const found: string[] = [];
  const bumps: string[] = [];
  for (const e of d.entries) {
    if (e.kind === 'bump') {
      bumps.push(bumpWords(e));
    } else {
      found.push(entryWords(e));
    }
  }
  if (bumps.length > BUMPS_TOLD) {
    const more = bumps.length - BUMPS_TOLD;
    bumps.splice(BUMPS_TOLD, more, `and ${inWords(more)} more ${more === 1 ? 'brush' : 'brushes'}`);
  }
  // Bumps alike are each told: they fold by count, not by likeness.
  const out = [...new Set([...weather, ...found, ...company]), ...bumps, ...new Set(ends)].filter(
    (x) => x !== '',
  );
  if (out.length === 0) {
    const n = d.voyages.length;
    out.push(
      n === 0
        ? 'At sea'
        : n === 1
          ? 'A voyage, all well'
          : `${capital(inWords(n))} voyages, all well`,
    );
  }
  return out;
}

/** A voyage's line when the day is opened: the boat, when, how it ended, the run. */
export function voyageLine(v: LogVoyage, zone: string): string {
  const boat =
    v.aboard === true
      ? `Aboard ${v.boatName !== undefined && v.boatName !== '' ? v.boatName : `${personWords(v.skipper)}’s ${boatKind(v.boat)}`}`
      : capitalFirst(boatWords(v.boat, v.boatName));
  const when = `${clock(v.began, zone)}–${clock(v.ended, zone)}`;
  const run = v.runM === null ? '' : `, ${nm(v.runM)} NM`;
  return `${boat}, ${when}${run}; ${howWords(v)}`;
}

/** A voyage's details when the day is opened: company, nearest the falls, brushes. */
export function voyageMore(v: LogVoyage): string[] {
  const out: string[] = [];
  const c = companyWords(v);
  if (c !== '') {
    out.push(c);
  }
  if (v.closestM !== undefined) {
    out.push(`Within ${metres(v.closestM)} of the falls, and back`);
  }
  const at = v.bumpsAtFault ?? 0;
  const not = v.bumpsNotAtFault ?? 0;
  if (at + not > 0) {
    out.push(
      `${capital(counted(at + not, 'brush', 'brushes'))} with other boats${at > 0 ? `, ${inWords(at)} the way ours to give` : ''}`,
    );
  }
  out.push(...weatherOf(v));
  return out;
}

function capitalFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A kind's card when tapped: where and when it was first found, and how often. */
export function firstWords(
  group: LogGroup['id'],
  k: { count: number; first?: { world: number; at: number; place?: string } },
  zone: string,
): string[] {
  if (k.count === 0) {
    return [group === 'edge' ? 'Not yet: sail this near the lip, and back.' : 'Not yet found.'];
  }
  const out: string[] = [];
  if (k.first !== undefined) {
    const when = format(zone, { weekday: 'long', day: 'numeric', month: 'long' }).format(
      new Date(k.first.at),
    );
    out.push(
      `First found in world ${k.first.world}${k.first.place !== undefined ? `, ${off(k.first.place)}` : ''}, ${when}`,
    );
  }
  out.push(k.count === 1 ? 'Found once' : `Found ${inWords(k.count)} times`);
  return out;
}

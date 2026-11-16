// SPDX-License-Identifier: AGPL-3.0-only

// The page's one small script. The page is whole without it but for these
// four, each hidden until it has something to show:
//
// - the countdown to this world's end, once a minute, with its date in the
//   visitor's own time and the schedule's, and Google Calendar's link;
// - the game's numbers, from /live, which the Worker answers;
// - Copy, for the address AI apps take;
// - and the page's colours and opening picture, which the Worker set for
//   the hour it was served at, moved on with the sky once a minute.
//
// It keeps nothing on the visitor's device and sends nothing but the
// request for /live.

import './page.css';
import { hourAt, hourFromQuery, openingAt, skyStep } from './sky';
import { asOf, googleLink, left, plural, type Turn, turnWords, yourTime } from './words';

const $ = (id: string) => document.getElementById(id);

/** What /live answers. */
interface Live {
  atSea?: number;
  machinesAtSea?: number;
  world?: number;
  endsAt?: string;
  turn?: Turn;
  charted?: number;
  at?: string;
  resting: boolean;
}

// The hour: the address's, for seeing the page in another light, or the sky's now.
const fixed = hourFromQuery(new URLSearchParams(location.search));
const hourNow = () => fixed ?? hourAt(Date.now(), __SKY__);

/** Each hour's opening picture, as the build wrote them into the page. */
const openings = (() => {
  try {
    return JSON.parse($('openings')?.textContent ?? '{}') as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
})();

function sky(): void {
  const hour = hourNow();
  const root = document.documentElement;
  root.dataset.sky = String(skyStep(hour));
  const name = openingAt(hour);
  const o = openings[name];
  if (root.dataset.opening === name || o === undefined) {
    return;
  }
  root.dataset.opening = name;
  for (const el of document.querySelectorAll<HTMLSourceElement | HTMLImageElement>(
    '.opening-picture [data-o]',
  )) {
    const set = o[el.dataset.o ?? ''];
    if (set !== undefined) {
      el.srcset = set;
    }
    if (el instanceof HTMLImageElement) {
      el.src = o.src ?? el.src;
      el.alt = o.alt ?? el.alt;
    }
  }
}

let live: Live | null = null;

function show(el: HTMLElement | null, on: boolean): void {
  if (el !== null) {
    el.hidden = !on;
  }
}

function text(id: string, s: string): void {
  const el = $(id);
  if (el !== null && el.textContent !== s) {
    el.textContent = s;
  }
}

function countdown(): void {
  const ends = live?.endsAt === undefined ? Number.NaN : Date.parse(live.endsAt);
  const turn = live?.turn;
  const clock = $('clock');
  if (Number.isNaN(ends)) {
    show(clock, false);
    show($('google'), false);
    return;
  }
  const l = left(ends, Date.now());
  text('days', String(l.days));
  text('days-word', plural(l.days, 'day', 'days'));
  text('hours', String(l.hours).padStart(2, '0'));
  text('hours-word', plural(l.hours, 'hour', 'hours'));
  text('minutes', String(l.minutes).padStart(2, '0'));
  text('minutes-word', plural(l.minutes, 'minute', 'minutes'));
  show(clock, true);
  const yours = yourTime(ends);
  text(
    'when',
    turn === undefined
      ? `For you, ${yours}. Then a new world, uncharted.`
      : `${turnWords(turn)}: for you, ${yours}. Then a new world, uncharted.`,
  );
  const google = $('google');
  if (turn !== undefined && google instanceof HTMLAnchorElement) {
    google.href = googleLink(ends, turn);
    show(google, true);
  }
}

function numbers(): void {
  const l = live;
  if (l === null) {
    return;
  }
  show($('resting'), l.resting);
  if (l.atSea === undefined) {
    show($('numbers'), false);
    show($('as-of'), false);
    return;
  }
  text('at-sea', String(l.atSea));
  text('machines', String(l.machinesAtSea ?? 0));
  text('charted', String(l.charted ?? 0));
  show($('numbers'), !l.resting);
  if (l.world !== undefined && l.at !== undefined && !Number.isNaN(Date.parse(l.at))) {
    text('as-of', asOf(l.world, Date.parse(l.at)));
    show($('as-of'), true);
  }
}

async function read(): Promise<void> {
  try {
    const r = await fetch('/live', { headers: { Accept: 'application/json' } });
    if (r.ok) {
      live = (await r.json()) as Live;
    }
  } catch {
    // The numbers stay as they were; the next read may find them.
  }
  numbers();
  countdown();
}

function copy(): void {
  const button = $('copy');
  const address = $('mcp');
  if (!(button instanceof HTMLButtonElement) || address === null) {
    return;
  }
  const said = (s: string) => {
    button.textContent = s;
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  };
  button.addEventListener('click', () => {
    const selected = () => {
      const range = document.createRange();
      range.selectNodeContents(address);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      said('Selected');
    };
    if (navigator.clipboard === undefined) {
      selected();
      return;
    }
    navigator.clipboard
      .writeText(address.textContent?.trim() ?? '')
      .then(() => said('Copied'), selected);
  });
  show(button, true);
}

sky();
copy();
void read();
// Once a minute: the sky and the countdown; the numbers every five.
let minutes = 0;
setInterval(() => {
  sky();
  countdown();
  minutes++;
  if (minutes % 5 === 0) {
    void read();
  }
}, 60_000);

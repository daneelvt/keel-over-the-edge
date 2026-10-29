// SPDX-License-Identifier: AGPL-3.0-only

// Watching's words, each as the player reads it; the screen while the
// boat drawn is one watched: no helm, sheet, autopilot, free camera or
// taking over, the bar saying whose boat it is, and the menu's way to
// watch another or stop; and the list of sailors to watch, drawn: its
// rows, its empty states, a refresh that changes rows in place and greys
// one gone, Pick one for me, the order and whom it shows, kept on the
// device; and the switch that lets others watch the voyage.

import { signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { HelmInput } from '../input/helm';
import { PilotInput } from '../input/pilot';
import { SheetInput } from '../input/sheet';
import type { Status, WatchingTold } from '../net/messages';
import type { Place, WatchEnd } from '../net/online';
import { ConnectionLine } from './connection';
import { SeaControls } from './hud';
import { Menu } from './menu';
import { HudModel } from './model';
import { DEFAULTS, loadSettings, type Store, saveWatchChoice, settingsSignal } from './settings';
import {
  BehindTheBoat,
  Choices,
  EmptyList,
  kindName,
  ListRow,
  newcomers,
  pickOne,
  refreshRows,
  SpectatorsSwitch,
  WatchBar,
  type WatchRow,
  watchServer,
} from './watch';
import { type CardFacts, CopyWatchLink, followProblem, SailorCard } from './watchcard';
import type { WatchView } from './watchlazy';
import {
  aboutName,
  boatsAtSeaText,
  chartedText,
  factsText,
  islandText,
  type Lively,
  livelyLine,
  livelyText,
  lookAgainText,
  noMatchWords,
  skimmedText,
  windWords,
} from './watchlistwords';
import {
  BEHIND_THE_BOAT,
  bumpedLine,
  endedText,
  SAIL,
  STOP_WATCHING,
  spectatorQueueLine,
  WATCH_A_SAILOR,
  WATCH_ANOTHER,
  type WatchEndWhy,
  watchersText,
  watchFromQuery,
  watchLink,
} from './watchwords';

describe('watching’s words', () => {
  test('how many watch', () => {
    expect(watchersText(0)).toBe('');
    expect(watchersText(1)).toBe('1 watching');
    expect(watchersText(3)).toBe('3 watching');
  });

  test('why a watch ended or was refused', () => {
    const words: Record<WatchEndWhy, string> = {
      left: 'Iron Mary has left the water.',
      off: 'Iron Mary no longer allows spectators.',
      cannot: 'Iron Mary cannot be watched now.',
      'not-at-sea': 'Iron Mary is not at sea.',
      'no-sailor': 'There is no sailor called Iron Mary.',
      own: 'That is your own boat.',
      quick: 'One at a time: try again in a moment.',
      busy: 'The harbour is busy: try again in a moment.',
      other: 'Iron Mary cannot be watched now.',
    };
    for (const [why, text] of Object.entries(words)) {
      expect(endedText(why as WatchEndWhy, 'Iron Mary')).toBe(text);
    }
  });

  test('the spectators’ queue', () => {
    expect(spectatorQueueLine({ position: 12, waiting: 40 })).toBe(
      'Many are watching. You are 12th in line to watch.',
    );
    expect(spectatorQueueLine({ position: 1, waiting: 2 })).toBe(
      'Many are watching. You are next in line to watch.',
    );
  });

  test('a bump, in the third person', () => {
    expect(bumpedLine('Iron Mary')).toBe('Iron Mary was bumped');
  });

  test('the link to watch, and the page opened by it', () => {
    const link = watchLink('https://play.keelovertheedge.com', 'Iron Mary');
    expect(link).toBe('https://play.keelovertheedge.com/?watch=Iron%20Mary');
    expect(watchFromQuery(new URL(link).searchParams)).toBe('Iron Mary');
    expect(watchFromQuery(new URLSearchParams('test'))).toBe('');
  });

  test('a boat’s kind by the catalog’s name', () => {
    expect(kindName('no such boat')).toBe('no such boat');
  });
});

/**
 * Every element of a tree, each component called through to what it
 * draws, but those kept, which hold state and are left as written.
 */
function expand(node: ComponentChildren, kept: readonly unknown[] = []): ComponentChildren {
  if (Array.isArray(node)) {
    return node.map((n) => expand(n, kept));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return node;
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  if (kept.includes(v.type)) {
    return v;
  }
  if (typeof v.type === 'function') {
    return expand((v.type as (p: unknown) => ComponentChildren)(v.props), kept);
  }
  return { ...v, props: { ...v.props, children: expand(v.props.children, kept) } } as VNode;
}

/** The text of a tree: its strings and numbers, in order. */
function text(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(text).join('');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) {
    return '';
  }
  return text((node as VNode<{ children?: ComponentChildren }>).props.children);
}

/** The buttons of a tree, as written: components not called. */
function buttons(node: ComponentChildren): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(buttons);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  return [...(v.type === 'button' ? [text(v)] : []), ...buttons(v.props.children)];
}

function view(
  watching: WatchingTold | null,
  spectating: boolean,
  status: Status,
  ended: WatchEnd | null = null,
): WatchView {
  return {
    watching: signal(watching),
    spectating: signal(spectating),
    status: signal(status),
    ended: signal(ended),
    place: signal<Place | null>(null),
    boatPlace: signal<Place | null>(null),
    watchers: signal(0),
    list: signal(false),
    watch: () => {},
    sail: () => {},
    unwatch: () => {},
    behind: () => {},
  };
}

describe('the screen on a boat watched', () => {
  const mary: WatchingTold = { sailor: 'Iron Mary', machine: true, mine: false };
  const controls = (steer: boolean) =>
    SeaControls({
      steer,
      helm: new HelmInput(),
      sheet: new SheetInput(),
      pilot: {
        pilot: new PilotInput(),
        togglePilot() {},
        engagePilot() {},
        takeHelm() {},
        pilotTack() {},
        pilotGybe() {},
        pilotAdjust() {},
        pilotMode() {},
      },
      model: new HudModel(),
      settings: settingsSignal(null),
    });

  test('has no helm, sheet or autopilot', () => {
    expect(controls(false)).toBeNull();
    const own = controls(true) as VNode<{ children: VNode[] }>;
    expect(own.props.children).toHaveLength(3);
  });

  test('says whose boat it is, with the cog, Watch another and Sail', () => {
    const v = view(mary, true, 'sailing');
    const bar = expand(WatchBar({ view: v }));
    expect(text(bar)).toContain('Watching Iron Mary⚙');
    expect(buttons(bar)).toEqual([WATCH_ANOTHER, SAIL]);
    expect(text(expand(BehindTheBoat({ view: v })))).toBe(BEHIND_THE_BOAT);
    // The own boat at sea: no bar, nothing behind.
    const own = view(null, false, 'sailing');
    expect(WatchBar({ view: own })).toBeNull();
    expect(BehindTheBoat({ view: own })).toBeNull();
  });

  test('a watch ended: why, and the way to another or to sea', () => {
    const v = view(null, true, 'idle', { why: 'left', sailor: 'Iron Mary' });
    const bar = expand(WatchBar({ view: v }));
    expect(text(bar)).toContain('Iron Mary has left the water.');
    expect(buttons(bar)).toEqual([WATCH_ANOTHER, SAIL]);
  });

  test('the menu: no free camera; a sailor to watch, and a stop to watching', () => {
    const v = view(mary, true, 'sailing');
    const menu = Menu({
      settings: settingsSignal(null),
      sailor: 'Ann Bonny',
      close: () => {},
      fly: null,
      watch: v,
    });
    const b = buttons(menu);
    expect(b).toContain(WATCH_A_SAILOR);
    expect(b).toContain(STOP_WATCHING);
    expect(b.some((t) => t.startsWith('Free camera'))).toBe(false);
    // The own boat: a sailor to watch, nothing to stop.
    const own = buttons(
      Menu({
        settings: settingsSignal(null),
        sailor: 'Ann Bonny',
        close: () => {},
        watch: view(null, false, 'sailing'),
      }),
    );
    expect(own).toContain(WATCH_A_SAILOR);
    expect(own).not.toContain(STOP_WATCHING);
  });

  test('no taking the boat over', () => {
    const v = {
      notice: signal({ text: 'You are playing on another device.', takeover: true }),
      rtt: signal(20),
      takeOver: () => {},
    };
    expect(buttons(ConnectionLine({ view: v, takeover: false }))).toEqual([]);
    expect(buttons(ConnectionLine({ view: v }))).toEqual(['Take over']);
  });
});

/** The elements of a tree that match. */
function find(
  node: ComponentChildren,
  match: (v: VNode<Record<string, unknown>>) => boolean,
): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => find(n, match));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<Record<string, unknown> & { children?: ComponentChildren }>;
  return [...(match(v) ? [v] : []), ...find(v.props.children, match)];
}

/** Iron Mary, a machine sailor in squalls, followed, near the edge, who charted an island. */
const mary: WatchRow = {
  name: 'Iron Mary',
  machine: true,
  mine: false,
  kind: 'jolly-boat',
  watchers: 3,
  sky: 'squalls',
  night: false,
  force: 6,
  knots: 5.8,
  state: 'sailing',
  followed: true,
  edgeNM: 1.2,
  lively: [{ why: 'squalls' }, { why: 'charted', subject: 'Gull Island', minutes: 4 }],
};

/** Ann Bonny, a human sailor in fair weather, sailing quietly. */
const ann: WatchRow = {
  name: 'Ann Bonny',
  machine: false,
  mine: false,
  kind: 'jolly-boat',
  watchers: 0,
  sky: 'fair',
  night: true,
  force: 3,
  knots: 4.1,
  state: 'sailing',
  edgeNM: 6,
};

describe('the list’s words', () => {
  test('why a row ranks high', () => {
    const words: [Lively, string][] = [
      [{ why: 'storm' }, 'in a storm'],
      [{ why: 'squalls' }, 'in squalls'],
      [{ why: 'edge' }, 'close to the edge'],
      [{ why: 'approach' }, 'skimming the falls'],
      [{ why: 'charted', subject: 'Gull Island', minutes: 4 }, 'charted Gull Island 4 min ago'],
      [{ why: 'charted', subject: 'Gull Island', minutes: 0 }, 'charted Gull Island just now'],
      [{ why: 'charted', minutes: 4 }, 'charted something 4 min ago'],
      [{ why: 'capsized' }, 'capsized'],
    ];
    for (const [l, w] of words) {
      expect(livelyText(l)).toBe(w);
    }
    expect(livelyLine(mary.lively)).toBe('in squalls · charted Gull Island 4 min ago');
    expect(livelyLine(undefined)).toBe('');
    expect(chartedText('Gull Island', 4, true)).toBe('charted Gull Island, 4 min ago');
  });

  test('a row’s facts, leaving out what is withheld or nought', () => {
    expect(factsText(mary)).toBe('1.2 NM from the edge · force 6 · 5.8 kn · 3 watching');
    expect(factsText({ force: mary.force, knots: mary.knots, watchers: 0 })).toBe(
      'force 6 · 5.8 kn',
    );
    expect(factsText({ force: 0, knots: 0, watchers: 1 })).toBe('1 watching');
  });

  test('the card’s wind, island and pass, by the compass’s sixteen points', () => {
    expect(windWords(5, 225)).toBe('force 5 from the SW');
    expect(windWords(4, 22.5)).toBe('force 4 from the NNE');
    expect(windWords(0, 90)).toBe('calm');
    expect(islandText({ name: 'Gull Island', bearing: 45, nm: 3.1 })).toBe(
      'Gull Island, 3.1 NM to the NE',
    );
    expect(skimmedText(140)).toBe('skimmed the falls at 140 m');
  });

  test('the boats at sea, a search with no match, and Look again', () => {
    expect(boatsAtSeaText(0)).toBe('');
    expect(boatsAtSeaText(1)).toBe('1 boat is at sea.');
    expect(boatsAtSeaText(4)).toBe('4 boats are at sea.');
    expect(noMatchWords('zz').join('')).toBe(
      'No one at sea who can be watched has zz in their name.',
    );
    expect(lookAgainText(0)).toBe('Look again');
    expect(lookAgainText(3)).toBe('Look again · 3 more at sea');
  });
});

describe('the list of sailors to watch', () => {
  const none = () => {};
  const row = (r: WatchRow) => expand(ListRow({ r, about: none, watch: none, unfollow: none }));

  test('a row: the sky, the sailor, cog, star and boat, its facts and why it ranks high; ⓘ and Watch', () => {
    const drawn = row(mary);
    const sky = find(drawn, (v) => v.props.class === 'watch-sky');
    expect(sky).toHaveLength(1);
    expect(sky[0]?.props['aria-label']).toBe('squalls');
    expect(find(sky, (v) => v.type === 'svg')).toHaveLength(1);
    expect(text(drawn)).toBe(
      'Iron Mary⚙★ Jolly boat1.2 NM from the edge · force 6 · 5.8 kn · 3 watchingin squalls · charted Gull Island 4 min agoⓘWatch',
    );
    expect(buttons(drawn)).toEqual(['ⓘ', 'Watch']);
    const about = find(drawn, (v) => v.props.class === 'watch-about');
    expect(about[0]?.props['aria-label']).toBe(aboutName('Iron Mary'));
    expect(text(find(drawn, (v) => v.props.class === 'watch-lively'))).toBe(
      'in squalls · charted Gull Island 4 min ago',
    );
    // The moon for the sun, said in words; no reasons, no star, no watchers.
    const quiet = row(ann);
    expect(find(quiet, (v) => v.props.class === 'watch-sky')[0]?.props['aria-label']).toBe(
      'fair, by night',
    );
    expect(text(quiet)).toBe('Ann Bonny Jolly boat6.0 NM from the edge · force 3 · 4.1 knⓘWatch');
  });

  test('read again: rows changed in place, never reordered; one gone greyed with a refused watch’s words', () => {
    const shown = [mary, ann];
    const fresh: WatchRow[] = [{ ...ann, knots: 6.2, watchers: 2 }];
    const after = refreshRows(shown, fresh);
    expect(after.map((r) => r.name)).toEqual(['Iron Mary', 'Ann Bonny']);
    expect(after[0]?.gone).toBe('not-at-sea');
    expect(after[1]).toEqual({ ...ann, knots: 6.2, watchers: 2 });
    // Gone: the words by kind, neither ⓘ nor Watch; ★ unfollows one followed.
    const gone = row(after[0] as WatchRow);
    expect(text(gone)).toBe('Iron Mary⚙ Jolly boatIron Mary is not at sea.★');
    expect(buttons(gone)).toEqual(['★']);
    expect(find(gone, (v) => v.type === 'button')[0]?.props['aria-label']).toBe(
      'Unfollow Iron Mary',
    );
    const human = refreshRows([{ ...ann, followed: false }], [])[0] as WatchRow;
    expect(text(row(human))).toContain('Ann Bonny cannot be watched now.');
    expect(buttons(row(human))).toEqual([]);
    // Back at sea: its row again, in the same place.
    expect(refreshRows(after, [mary, ann])).toEqual([mary, ann]);
    // A follow that cannot be watched, as the Following list sends it, stays as it is.
    const follow: WatchRow = { ...ann, gone: 'cannot', followed: true };
    expect(refreshRows([follow], [])).toEqual([follow]);
  });

  test('Look again counts the sailors the first page now has that are not shown', () => {
    const other = { ...ann, name: 'Grace O’Malley' };
    expect(newcomers([mary, ann], [mary, other, ann])).toBe(1);
    expect(newcomers([mary], [{ ...ann, gone: 'cannot' }])).toBe(0);
  });

  test('Pick one for me: one of the three liveliest, none with fewer than two to watch', () => {
    const rows: WatchRow[] = [
      ann,
      { ...ann, name: 'A', lively: [{ why: 'storm' }] },
      { ...ann, name: 'B', watchers: 5 },
      mary,
      { ...ann, name: 'C', lively: [{ why: 'capsized' }] },
    ];
    expect(pickOne(rows, () => 0)).toBe('Iron Mary');
    expect(pickOne(rows, () => 0.5)).toBe('A');
    expect(pickOne(rows, () => 0.99)).toBe('C');
    expect(pickOne([mary], () => 0)).toBeNull();
    expect(pickOne([mary, { ...ann, gone: 'cannot' }], () => 0)).toBeNull();
  });

  test('the empty list says why, who can be watched and how many boats are at sea', () => {
    expect(text(expand(EmptyList({ q: '', who: 'all', atSea: 4 })))).toBe(
      'No one at sea can be watched just now.Machine sailors can always be watched while they sail. Other sailors choose whether to allow it.4 boats are at sea.',
    );
    expect(text(expand(EmptyList({ q: '', who: 'machine', atSea: 1 })))).toContain(
      '1 boat is at sea.',
    );
    expect(text(expand(EmptyList({ q: '', who: 'all', atSea: 0 })))).not.toContain('at sea.');
    const search = expand(EmptyList({ q: 'Mary', who: 'all', atSea: 4 }));
    expect(text(search)).toBe('No one at sea who can be watched has Mary in their name.');
    expect(text(find(search, (v) => v.type === 'em'))).toBe('Mary');
  });

  test('the order and whom: Nearest the edge not offered while where is withheld', () => {
    const drawn = (sort: 'edge' | 'fast', withheld: boolean) =>
      Choices({ sort, who: 'following', withheld, setSort: none, setWho: none });
    const open = drawn('edge', false);
    expect(buttons(open)).toEqual([
      'Liveliest',
      'Most watched',
      'Nearest the edge',
      'Roughest weather',
      'Fastest',
      'By name',
    ]);
    const pressed = (t: ComponentChildren) =>
      find(t, (v) => v.props['aria-pressed'] === true).map(text);
    expect(pressed(open)).toEqual(['Nearest the edge']);
    const kept = drawn('edge', true);
    expect(buttons(kept)).not.toContain('Nearest the edge');
    expect(pressed(kept)).toEqual(['Liveliest']);
    const select = find(open, (v) => v.type === 'select');
    expect(select[0]?.props.value).toBe('following');
    expect(find(select, (v) => v.type === 'option').map(text)).toEqual([
      'Everyone',
      'Following',
      'Machine sailors',
      'Human sailors',
    ]);
  });

  test('the order and whom are kept on the device, and read defensively', () => {
    const data = new Map<string, string>();
    const m: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
    expect(loadSettings(m).watchSort).toBe('liveliest');
    expect(loadSettings(m).watchWho).toBe('all');
    const settings = settingsSignal(m);
    expect(saveWatchChoice({ watchSort: 'edge', watchWho: 'machine' }, m)).toBe(true);
    // The menu's signal, written after, keeps them.
    settings.set({ sound: false });
    expect(loadSettings(m)).toEqual({
      ...DEFAULTS,
      sound: false,
      watchSort: 'edge',
      watchWho: 'machine',
    });
    data.set('keel.settings', '{"watchSort": "nearest", "watchWho": 3}');
    expect(loadSettings(m).watchSort).toBe('liveliest');
    expect(loadSettings(m).watchWho).toBe('all');
  });

  test('asks the server with the order and whom, and for the rows shown by name, a hundred at a time', async () => {
    const asked: string[] = [];
    const page = { sailors: [mary], more: false, atSea: 14, withheld: true };
    const server = watchServer(async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify(page), { status: 200 });
    });
    expect(await server.page({ q: 'Ir', page: 1, sort: 'edge', who: 'machine' })).toEqual(page);
    expect(asked[0]).toBe('/api/watch?q=Ir&page=1&sort=edge&who=machine');
    const names = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const read = await server.names(names);
    expect(asked).toHaveLength(3);
    expect(new URL(asked[1] ?? '', 'http://x').searchParams.get('names')?.split(',')).toEqual(
      names.slice(0, 100),
    );
    expect(read?.sailors).toEqual([mary, mary]);
    expect(read?.atSea).toBe(14);
    expect(read?.withheld).toBe(true);
    // A page it cannot read.
    const broken = watchServer(async () => new Response('{}', { status: 200 }));
    expect(await broken.page({ q: '', page: 0, sort: 'name', who: 'all' })).toBeNull();
  });
});

describe('the switch that lets others watch', () => {
  test('one switch for the voyage under way, on for this voyage, off otherwise', () => {
    const drawn = (allow: 'no' | 'voyage' | null, problem = '') =>
      SpectatorsSwitch({ allow, problem, set: () => {} });
    const on = drawn('voyage');
    expect(text(on)).toBe('Let others watch me sail (this voyage)');
    const box = (t: ComponentChildren) => find(t, (v) => v.type === 'input')[0]?.props;
    expect(box(on)?.checked).toBe(true);
    expect(box(on)?.type).toBe('checkbox');
    expect(box(drawn('no'))?.checked).toBe(false);
    expect(box(drawn(null))?.disabled).toBe(true);
    expect(text(drawn('no', 'You are offline.'))).toContain('You are offline.');
    expect(buttons(on)).toEqual([]);
  });
});

describe('the card about a sailor', () => {
  const card: CardFacts = {
    ...mary,
    followed: false,
    weather: {
      windFrom: 225,
      waves: 1.4,
      barometer: '1004 hPa, falling',
      visibility: 'visibility moderate',
      rain: 'moderate rain',
      clouds: 'a squall about',
    },
    where: {
      edgeNM: 1.2,
      island: { name: 'Gull Island', bearing: 45, nm: 3.1 },
      inSight: [
        'Gull Island · 045° 3.1 NM · charted by «Mira» (human), Tuesday',
        'land (uncharted) · wooded island 1 NM across · 300° about 4 NM',
      ],
    },
    voyage: { skimmedM: 140, charted: { subject: 'Gull Island', minutes: 4 } },
  };
  const drawn = (
    c: CardFacts,
    { gone = null, withheld = false, read = true, problem = '' } = {} as {
      gone?: 'not-at-sea' | 'cannot' | null;
      withheld?: boolean;
      read?: boolean;
      problem?: string;
    },
  ) =>
    expand(
      SailorCard({
        c,
        read,
        gone,
        withheld,
        problem,
        back: () => {},
        follow: () => {},
        watch: () => {},
      }),
      [CopyWatchLink],
    );
  const part = (t: ComponentChildren, name: string) =>
    text(find(t, (v) => v.type === 'section' && v.props['aria-label'] === name));
  const lines = (t: ComponentChildren, name: string) =>
    find(
      find(t, (v) => v.type === 'section' && v.props['aria-label'] === name),
      (v) => ['p', 'li', 'h3'].includes(String(v.type)),
    ).map(text);

  test('the weather, where, and this voyage; Follow, Copy a link and Watch at the bottom', () => {
    const t = drawn(card);
    expect(buttons(t)).toEqual(['‹ Back', '☆ Follow', 'Watch']);
    expect(find(t, (v) => v.type === CopyWatchLink)).toHaveLength(1);
    expect(text(find(t, (v) => v.props.class === 'watch-card-name'))).toBe(
      'Iron Mary⚙ · Jolly boat',
    );
    expect(text(t)).toContain('3 watching');
    expect(lines(t, 'The weather')).toEqual([
      'The weather',
      'squalls · force 6 from the SW',
      'waves 1.4 m · 1004 hPa, falling',
      'visibility moderate · moderate rain · a squall about',
    ]);
    expect(lines(t, 'Where')).toEqual([
      'Where',
      '1.2 NM from the edge',
      'Gull Island, 3.1 NM to the NE',
      'In sight',
      'Gull Island · 045° 3.1 NM · charted by «Mira» (human), Tuesday',
      'land (uncharted) · wooded island 1 NM across · 300° about 4 NM',
    ]);
    expect(lines(t, 'This voyage')).toEqual([
      'This voyage',
      'skimmed the falls at 140 m',
      'charted Gull Island, 4 min ago',
    ]);
    // The Watch button is the foot's, after the sections.
    const foot = find(t, (v) => v.props.class === 'watch-card-foot');
    expect(buttons(foot)).toEqual(['Watch']);
  });

  test('where withheld while the viewer’s own boat is in the water', () => {
    const { where, edgeNM, ...kept } = card;
    expect(where?.edgeNM).toBe(edgeNM);
    const t = drawn(kept, { withheld: true });
    expect(lines(t, 'Where')).toEqual(['Where', 'Leave the water to see where Iron Mary is.']);
    expect(text(find(t, (v) => v.type === 'em'))).toBe('Iron Mary');
    expect(part(t, 'The weather')).toContain('force 6 from the SW');
    // No where and nothing withheld: no section at all; nor this voyage with nothing in it.
    const bare = drawn({ ...kept, voyage: {} });
    expect(part(bare, 'Where')).toBe('');
    expect(part(bare, 'This voyage')).toBe('');
  });

  test('☆ Follow, ★ Following, and why a follow failed', () => {
    expect(buttons(drawn({ ...card, followed: true }))).toContain('★ Following');
    const star = find(drawn({ ...card, followed: true }), (v) => v.props.class === 'watch-follow');
    expect(star[0]?.props['aria-pressed']).toBe(true);
    expect(followProblem('too-many', 'Iron Mary')).toBe(
      'You follow 100 sailors: unfollow one first',
    );
    expect(followProblem('not-at-sea', 'Iron Mary')).toBe('Iron Mary is not at sea.');
    expect(followProblem('cannot', 'Ann Bonny')).toBe('Ann Bonny cannot be watched now.');
    expect(followProblem('ok', 'Iron Mary')).toBe('');
    expect(text(drawn(card, { problem: followProblem('too-many', 'Iron Mary') }))).toContain(
      'You follow 100 sailors: unfollow one first',
    );
  });

  test('gone: greyed with a refused watch’s words, no Watch, and Follow only to undo one', () => {
    const t = drawn(card, { gone: 'not-at-sea' });
    expect(text(t)).toContain('Iron Mary is not at sea.');
    expect(buttons(t)).toEqual(['‹ Back']);
    expect(find(t, (v) => v.type === CopyWatchLink)).toHaveLength(0);
    expect(buttons(drawn({ ...card, followed: true }, { gone: 'cannot' }))).toEqual([
      '‹ Back',
      '★ Following',
    ]);
  });

  test('the row until the card is read; the lamp in words for the viewer’s own machine sailor', () => {
    const t = drawn(mary, { read: false });
    expect(text(t)).toContain('Reading who is at sea…');
    expect(part(t, 'The weather')).toBe('');
    const mine = drawn({ ...card, mine: true, agent: false });
    expect(text(find(mine, (v) => v.props['data-readout'] === 'agent'))).toBe(
      'Your machine sailor’s AI has gone quiet',
    );
    expect(
      text(
        find(
          drawn({ ...card, mine: true, agent: true }),
          (v) => v.props['data-readout'] === 'agent',
        ),
      ),
    ).toBe('Your machine sailor’s AI is at the helm');
    expect(
      find(drawn({ ...card, agent: true }), (v) => v.props['data-readout'] === 'agent'),
    ).toEqual([]);
  });

  test('the card’s answers: gone by kind, follow refused', async () => {
    const answer = (status: number, body: object) => async () =>
      new Response(JSON.stringify(body), { status });
    const card404 = watchServer(answer(404, { error: 'not-at-sea' }));
    expect(await card404.card('Iron Mary')).toEqual({ gone: 'not-at-sea' });
    expect(await watchServer(answer(404, { error: 'cannot' })).card('Ann')).toEqual({
      gone: 'cannot',
    });
    expect(await watchServer(answer(200, card)).card('Iron Mary')).toEqual({ card });
    expect(await watchServer(answer(500, {})).card('Iron Mary')).toBeNull();
    expect(await watchServer(answer(409, { error: 'too-many' })).follow('Iron Mary', true)).toBe(
      'too-many',
    );
    expect(await watchServer(answer(404, { error: 'cannot' })).follow('Ann', true)).toBe('cannot');
    expect(await watchServer(answer(200, { following: 1 })).follow('Ann', true)).toBe('ok');
  });
});

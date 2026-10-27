// SPDX-License-Identifier: AGPL-3.0-only

// Watching's words, each as the player reads it; and the screen while the
// boat drawn is one watched: no helm, sheet, autopilot, free camera or
// taking over, the bar saying whose boat it is, and the menu's way to
// watch another or stop.

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
import { settingsSignal } from './settings';
import { BehindTheBoat, kindName, WatchBar } from './watch';
import type { WatchView } from './watchlazy';
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

/** Every element of a tree, each component called through to what it draws. */
function expand(node: ComponentChildren): ComponentChildren {
  if (Array.isArray(node)) {
    return node.map(expand);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return node;
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  if (typeof v.type === 'function') {
    return expand((v.type as (p: unknown) => ComponentChildren)(v.props));
  }
  return { ...v, props: { ...v.props, children: expand(v.props.children) } } as VNode;
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

// SPDX-License-Identifier: AGPL-3.0-only

import { signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { ChangeWindow, type HomeView, HomeWindow } from './home';
import {
  BACK_TO_PORT_ROYAL,
  CHANGE_BOAT,
  CHANGE_DETAIL,
  CHANGE_FAILED,
  CHANGE_QUESTION,
  CHANGE_SHIPMATES,
  changeLines,
  HOME_DETAIL,
  HOME_QUESTION,
  HOME_RACING,
  HOME_SHIPMATES,
  HOME_STAY,
  homeLines,
  LIFTED_SOON,
} from './homewords';
import type { LogVoyage } from './logapi';
import { endWords, howWords } from './logwords';
import { Menu } from './menu';
import { settingsSignal } from './settings';

type Node = VNode<Record<string, unknown> & { children?: ComponentChildren }>;

function findAll(node: ComponentChildren, test: (n: Node) => boolean): Node[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, test));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as Node;
  return [...(test(v) ? [v] : []), ...findAll(v.props.children, test)];
}

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
  return text((node as Node).props.children);
}

/** The words of each paragraph, in order. */
const lines = (n: ComponentChildren) => findAll(n, (x) => x.type === 'p').map(text);
const named = (n: ComponentChildren, words: string) =>
  findAll(n, (x) => x.type === 'button').find((b) => text(b.props.children) === words);
const tap = (n: ComponentChildren, words: string) =>
  (named(n, words)?.props.onClick as (() => void) | undefined)?.();

function home(over: Partial<HomeView> = {}) {
  let gone = 0;
  let changed = 0;
  const h: HomeView = {
    offered: () => true,
    asking: signal(false),
    racing: () => false,
    shipmates: () => false,
    go: () => gone++,
    changing: signal(false),
    change: () => {
      changed++;
      return Promise.resolve(true);
    },
    ...over,
  };
  return { h, gone: () => gone, changed: () => changed };
}

describe('the way home', () => {
  test('its words', () => {
    expect(BACK_TO_PORT_ROYAL).toBe('Back to Port Royal');
    expect(HOME_QUESTION).toBe('Back to Port Royal?');
    expect(HOME_DETAIL).toBe(
      'Your boat is lifted to the start off Port Royal. This voyage ends here.',
    );
    expect(HOME_RACING).toBe('You retire from the race.');
    expect(HOME_SHIPMATES).toBe('Your shipmates come too.');
    expect(HOME_STAY).toBe('Stay');
    expect(LIFTED_SOON).toBe('You were lifted a moment ago.');
    expect(homeLines(false, false)).toEqual([HOME_DETAIL]);
    expect(homeLines(true, true)).toEqual([HOME_DETAIL, HOME_RACING, HOME_SHIPMATES]);
  });

  test('the question alone says what happens; racing, that the boat retires; with shipmates, that they come too', () => {
    expect(lines(HomeWindow({ home: home().h }))).toEqual([HOME_DETAIL]);
    expect(lines(HomeWindow({ home: home({ racing: () => true }).h }))).toEqual([
      HOME_DETAIL,
      HOME_RACING,
    ]);
    expect(lines(HomeWindow({ home: home({ shipmates: () => true }).h }))).toEqual([
      HOME_DETAIL,
      HOME_SHIPMATES,
    ]);
    const both = HomeWindow({ home: home({ racing: () => true, shipmates: () => true }).h });
    expect(text(findAll(both, (x) => x.type === 'h2'))).toBe(HOME_QUESTION);
    expect(lines(both)).toEqual([HOME_DETAIL, HOME_RACING, HOME_SHIPMATES]);
  });

  test('Back to Port Royal lifts the boat and puts the question away; Stay only puts it away', () => {
    const a = home();
    a.h.asking.value = true;
    tap(HomeWindow({ home: a.h }), BACK_TO_PORT_ROYAL);
    expect(a.gone()).toBe(1);
    expect(a.h.asking.value).toBe(false);
    const b = home();
    b.h.asking.value = true;
    tap(HomeWindow({ home: b.h }), HOME_STAY);
    expect(b.gone()).toBe(0);
    expect(b.h.asking.value).toBe(false);
  });

  test('in the menu while the own boat is sailed, asking first; not aboard another’s, nor watching', () => {
    let closed = 0;
    const menu = (h: HomeView | null) =>
      Menu({ settings: settingsSignal(null), sailor: 'Ann Bonny', close: () => closed++, home: h });
    const a = home();
    const m = menu(a.h);
    expect(named(m, BACK_TO_PORT_ROYAL)).toBeDefined();
    tap(m, BACK_TO_PORT_ROYAL);
    expect(a.h.asking.value).toBe(true);
    expect(a.gone()).toBe(0);
    expect(closed).toBe(1);
    expect(named(menu(home({ offered: () => false }).h), BACK_TO_PORT_ROYAL)).toBeUndefined();
    expect(named(menu(null), BACK_TO_PORT_ROYAL)).toBeUndefined();
  });

  test('Change boat: its words, and what else it says racing or with shipmates aboard', () => {
    expect(CHANGE_BOAT).toBe('Change boat');
    expect(CHANGE_QUESTION).toBe('Change boat?');
    expect(changeLines(false, false)).toEqual([CHANGE_DETAIL]);
    expect(changeLines(true, true)).toEqual([CHANGE_DETAIL, HOME_RACING, CHANGE_SHIPMATES]);
    const both = ChangeWindow({ home: home({ racing: () => true, shipmates: () => true }).h });
    expect(text(findAll(both, (x) => x.type === 'h2'))).toBe(CHANGE_QUESTION);
    expect(lines(both)).toEqual([CHANGE_DETAIL, HOME_RACING, CHANGE_SHIPMATES]);
  });

  test('Change boat is in the menu beside the way home, asking first; its key takes the boat out, Stay does not', async () => {
    let closed = 0;
    const menu = (h: HomeView | null) =>
      Menu({ settings: settingsSignal(null), sailor: 'Ann Bonny', close: () => closed++, home: h });
    const a = home();
    tap(menu(a.h), CHANGE_BOAT);
    expect(a.h.changing.value).toBe(true);
    expect(a.changed()).toBe(0);
    expect(closed).toBe(1);
    expect(named(menu(home({ offered: () => false }).h), CHANGE_BOAT)).toBeUndefined();
    expect(named(menu(null), CHANGE_BOAT)).toBeUndefined();
    tap(ChangeWindow({ home: a.h }), HOME_STAY);
    expect(a.h.changing.value).toBe(false);
    expect(a.changed()).toBe(0);
    tap(ChangeWindow({ home: a.h }), CHANGE_BOAT);
    await new Promise((r) => setTimeout(r));
    expect(a.changed()).toBe(1);
    expect(lines(ChangeWindow({ home: a.h }))).toEqual([CHANGE_DETAIL]);
  });

  test('a boat that could not be taken out is said, the question kept', async () => {
    const a = home({ change: () => Promise.resolve(false) });
    a.h.changing.value = true;
    tap(ChangeWindow({ home: a.h }), CHANGE_BOAT);
    await new Promise((r) => setTimeout(r));
    expect(lines(ChangeWindow({ home: a.h }))).toEqual([CHANGE_DETAIL, CHANGE_FAILED]);
    expect(a.h.changing.value).toBe(true);
    tap(ChangeWindow({ home: a.h }), HOME_STAY);
    expect(lines(ChangeWindow({ home: a.h }))).toEqual([CHANGE_DETAIL]);
  });

  test('the log says a voyage was lifted home', () => {
    const v = { how: 'lifted' } as LogVoyage;
    expect(endWords(v)).toBe('Lifted home to Port Royal');
    expect(howWords(v)).toBe('lifted home to Port Royal');
  });
});

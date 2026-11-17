// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { HomeOffer } from '../account/homeoffer';
import { ADD_KEEL, INSTALL_HOME_SCREEN, NOT_NOW, PLAY_FROM_HOME_SCREEN } from '../ui/installwords';
import type { Store } from '../ui/settings';
import type { ScreenEnv } from './fullscreen';
import { HomeScreen, type InstallPrompt, localDate } from './homescreen';

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

function memory(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

/** A phone's browser: Chrome on Android, or Safari on an iPhone; installed, or in the browser. */
function phone(kind: 'chrome' | 'iphone', isInstalled = false): ScreenEnv {
  return {
    doc: {
      fullscreenEnabled: kind === 'chrome',
      visibilityState: 'visible',
      documentElement: {},
      addEventListener() {},
    },
    matches: (q) => isInstalled && q === '(display-mode: standalone)',
    standalone: kind === 'iphone' ? isInstalled : undefined,
    userAgent: kind === 'chrome' ? CHROME_ANDROID : SAFARI_IPHONE,
  };
}

/** Chrome's offer to install, answered as the test says. */
function chromePrompt(outcome: 'accepted' | 'dismissed') {
  const asked: string[] = [];
  const p: InstallPrompt = {
    prompt: async () => {
      asked.push('prompt');
    },
    userChoice: Promise.resolve({ outcome }),
    preventDefault: () => asked.push('preventDefault'),
  };
  return { p, asked };
}

/** A player's device over days: each day's date, and a HomeScreen as each visit makes it. */
function days(kind: 'chrome' | 'iphone', isInstalled = false) {
  const store = memory();
  let today = '2026-11-01';
  return {
    store,
    on(date: string) {
      today = date;
    },
    visit: () => new HomeScreen({ screen: phone(kind, isInstalled), store, today: () => today }),
  };
}

/** Expands function components, so a test can see the elements they make. */
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

function text(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(text).join(' ');
  }
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node);
  }
  return text((node as VNode<{ children?: ComponentChildren }>).props.children);
}

describe('the days of play', () => {
  test('a Set sail counts its date once, however many times that day', () => {
    const d = days('iphone');
    const h = d.visit();
    expect(h.day()).toBe(1);
    h.sailed();
    h.sailed();
    expect(h.day()).toBe(1);
    d.on('2026-11-02');
    expect(d.visit().day()).toBe(2);
    d.visit().sailed();
    d.visit().sailed();
    d.on('2026-11-09');
    expect(d.visit().day()).toBe(3);
    expect(JSON.parse(d.store.map.get('keel.homeScreen') ?? '')).toMatchObject({
      days: 2,
      last: '2026-11-02',
    });
  });

  test('a date as the player’s own calendar has it', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('the offer', () => {
  test('on the third day only, on an iPhone; Add Keel shows the steps and puts it away', async () => {
    const d = days('iphone');
    d.visit().sailed();
    d.on('2026-11-02');
    const second = d.visit();
    expect(second.offered.value).toBe(false);
    expect(expand(HomeOffer({ home: second }))).toBeNull();
    second.sailed();
    d.on('2026-11-03');
    const third = d.visit();
    expect(third.offered.value).toBe(true);
    const shown = text(expand(HomeOffer({ home: third })));
    expect(shown).toContain(PLAY_FROM_HOME_SCREEN);
    expect(shown).toContain(ADD_KEEL);
    expect(shown).toContain(NOT_NOW);
    await third.add();
    expect(third.offered.value).toBe(false);
    expect(text(expand(HomeOffer({ home: third })))).toBe(INSTALL_HOME_SCREEN);
    third.sailed();
    d.on('2026-11-04');
    expect(d.visit().offered.value).toBe(false);
  });

  test('offered once: shown and left unanswered, still there on a reload that day, gone the next', () => {
    const d = days('iphone');
    for (const date of ['2026-11-01', '2026-11-02']) {
      d.on(date);
      d.visit().sailed();
    }
    d.on('2026-11-03');
    const third = d.visit();
    // Eligible but not yet shown: still offered on a later day.
    expect(third.offered.value).toBe(true);
    d.on('2026-11-04');
    expect(d.visit().offered.value).toBe(true);
    // Shown on the fourth day, ignored, Set sail.
    const shown = d.visit();
    expect(text(expand(HomeOffer({ home: shown })))).toContain(PLAY_FROM_HOME_SCREEN);
    shown.sailed();
    // A reload the same day: still there.
    const reload = d.visit();
    expect(reload.offered.value).toBe(true);
    expect(text(expand(HomeOffer({ home: reload })))).toContain(ADD_KEEL);
    // The next day: gone, though never answered.
    d.on('2026-11-05');
    const next = d.visit();
    expect(next.offered.value).toBe(false);
    expect(expand(HomeOffer({ home: next }))).toBeNull();
    expect(JSON.parse(d.store.map.get('keel.homeScreen') ?? '')).toMatchObject({
      done: false,
      shown: '2026-11-04',
    });
  });

  test('never after Not now', () => {
    const d = days('iphone');
    for (const date of ['2026-11-01', '2026-11-02']) {
      d.on(date);
      d.visit().sailed();
    }
    d.on('2026-11-03');
    const h = d.visit();
    expect(h.offered.value).toBe(true);
    h.notNow();
    expect(h.offered.value).toBe(false);
    d.on('2026-11-20');
    expect(d.visit().offered.value).toBe(false);
  });

  test('never once installed', () => {
    const d = days('iphone', true);
    for (const date of ['2026-11-01', '2026-11-02']) {
      d.on(date);
      d.visit().sailed();
    }
    d.on('2026-11-03');
    expect(d.visit().offered.value).toBe(false);
  });

  test('in Chrome, only once it has offered to install; Add Keel asks it, and the game installed puts it away', async () => {
    const d = days('chrome');
    for (const date of ['2026-11-01', '2026-11-02']) {
      d.on(date);
      d.visit().sailed();
    }
    d.on('2026-11-03');
    const h = d.visit();
    expect(h.offered.value).toBe(false);
    const { p, asked } = chromePrompt('accepted');
    h.saved(p);
    expect(asked).toEqual(['preventDefault']);
    expect(h.offered.value).toBe(true);
    await h.add();
    expect(asked).toEqual(['preventDefault', 'prompt']);
    expect(h.offered.value).toBe(false);
    expect(h.prompt.value).toBeNull();
    expect(h.steps.value).toBe(false);
    d.on('2026-11-04');
    const next = d.visit();
    next.saved(chromePrompt('accepted').p);
    expect(next.offered.value).toBe(false);
  });

  test('the menu’s Install: the browser’s question once; dismissed, the key goes until it offers again', async () => {
    const h = days('chrome').visit();
    const { p, asked } = chromePrompt('dismissed');
    h.saved(p);
    await h.install();
    expect(asked).toEqual(['preventDefault', 'prompt']);
    expect(h.prompt.value).toBeNull();
    await h.install();
    expect(asked).toEqual(['preventDefault', 'prompt']);
  });

  test('the game installed from the browser’s own menu puts the offer away', () => {
    const d = days('chrome');
    for (const date of ['2026-11-01', '2026-11-02']) {
      d.on(date);
      d.visit().sailed();
    }
    d.on('2026-11-03');
    const h = d.visit();
    h.saved(chromePrompt('accepted').p);
    expect(h.offered.value).toBe(true);
    h.installedNow();
    expect(h.offered.value).toBe(false);
    expect(h.prompt.value).toBeNull();
  });
});

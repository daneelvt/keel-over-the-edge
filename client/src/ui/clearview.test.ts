// SPDX-License-Identifier: AGPL-3.0-only

import { signal } from '@preact/signals';
import type { VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { ClearView, type Needed, needed } from './clearview';
import { BACK_TO_THE_BOAT, CLEAR_VIEW, SeaKeys, SHOW_INSTRUMENTS } from './seakeys';
import { DEFAULTS, loadSettings } from './settings';

const CALM: Needed = { overboard: false, takeover: false, returned: 0, ended: null, queued: false };

/** The keys a column of keys holds, by label, with their states. */
function keys(node: VNode) {
  const kids = (node.props as { children: (VNode | null)[] }).children.filter(
    (k): k is VNode => k !== null,
  );
  return kids.map((k) => {
    // Each key is a component: drawn, its button.
    const b = (k.type as (p: unknown) => VNode)(k.props);
    const p = b.props as Record<string, unknown>;
    return {
      label: p['aria-label'],
      pressed: p['aria-pressed'],
      resting: p['data-resting'],
    };
  });
}

describe('the clear view', () => {
  test('a tap clears the screen, and another brings everything back; the scene is told each time', () => {
    const clear = new ClearView();
    const told: boolean[] = [];
    clear.onChange = (on) => told.push(on);
    expect(clear.on.value).toBe(false);
    clear.toggle();
    expect(clear.on.value).toBe(true);
    clear.toggle();
    expect(clear.on.value).toBe(false);
    clear.show();
    expect(told).toEqual([true, false]);
  });

  test('comes back by itself when the player is needed', () => {
    const cases: Partial<Needed>[] = [
      { overboard: true },
      { takeover: true },
      { returned: 1 },
      { ended: { why: 'left', sailor: 'Iron Mary' } },
      { queued: true },
      { knocks: 1 },
      { handed: true },
    ];
    for (const c of cases) {
      expect(needed(CALM, { ...CALM, ...c }), JSON.stringify(c)).toBe(true);
    }
  });

  test('not while that state merely holds, nor for anything else', () => {
    const over = {
      ...CALM,
      overboard: true,
      takeover: true,
      queued: true,
      returned: 2,
      knocks: 2,
      handed: true,
    };
    expect(needed(over, over)).toBe(false);
    // A knock answered or gone needs nothing.
    expect(needed(over, { ...over, knocks: 1 })).toBe(false);
    // Their end needs nothing: the count of returns only grows.
    expect(needed(over, { ...CALM, returned: 2 })).toBe(false);
    expect(needed(CALM, CALM)).toBe(false);
  });

  test('its key, an eye: Clear view while everything shows, Show the instruments while clear', () => {
    const clear = new ClearView();
    const camera = { resting: signal(true), behind: () => {} };
    const shown = keys(SeaKeys({ menu: null, camera, clear, full: null }));
    expect(shown).toEqual([
      { label: BACK_TO_THE_BOAT, pressed: undefined, resting: true },
      { label: CLEAR_VIEW, pressed: false, resting: undefined },
    ]);
    clear.toggle();
    camera.resting.value = false;
    expect(keys(SeaKeys({ menu: null, camera, clear, full: null }))).toEqual([
      { label: BACK_TO_THE_BOAT, pressed: undefined, resting: false },
      { label: SHOW_INSTRUMENTS, pressed: true, resting: undefined },
    ]);
  });

  test('the menu heads the column, the full screen’s key at its foot while it is wanted', () => {
    const clear = new ClearView();
    const camera = { resting: signal(true), behind: () => {} };
    const all = keys(
      SeaKeys({ menu: { open: false, press: () => {} }, camera, clear, full: () => {} }),
    ).map((k) => k.label);
    expect(all).toEqual(['Menu', BACK_TO_THE_BOAT, CLEAR_VIEW, 'Full screen']);
  });
});

describe('the camera’s ease back', () => {
  test('is on unless the player turns it off, kept on the device', () => {
    expect(DEFAULTS.cameraBack).toBe(true);
    const kept = new Map<string, string>();
    const store = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    };
    expect(loadSettings(store).cameraBack).toBe(true);
    kept.set('keel.settings', JSON.stringify({ cameraBack: false }));
    expect(loadSettings(store).cameraBack).toBe(false);
  });
});

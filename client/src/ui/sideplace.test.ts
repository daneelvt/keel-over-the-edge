// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { asideOf, crowded, openNames, type SideWindow } from './sideplace';

/** Windows by name, those in open open, each closing into closed. */
function windows(open: string[], closed: string[]): SideWindow[] {
  return ['menu', 'races', 'race', 'watch'].map((name) => ({
    name,
    open: open.includes(name),
    close: () => closed.push(name),
  }));
}

describe('one window in the menu’s place', () => {
  test('the menu opened over Make a race closes Make a race', () => {
    const closed: string[] = [];
    const now = windows(['menu', 'races'], closed);
    for (const w of crowded(now, new Set(['races']))) {
      w.close();
    }
    expect(closed).toEqual(['races']);
  });

  test('a race window opened over the menu closes the menu', () => {
    const closed: string[] = [];
    for (const w of crowded(windows(['menu', 'races'], closed), new Set(['menu']))) {
      w.close();
    }
    expect(closed).toEqual(['menu']);
  });

  test('two opened at once: the last listed stays', () => {
    const closed: string[] = [];
    for (const w of crowded(windows(['menu', 'race', 'watch'], closed), new Set())) {
      w.close();
    }
    expect(closed).toEqual(['menu', 'race']);
  });

  test('nothing closes while none has just opened', () => {
    expect(crowded(windows(['menu'], []), new Set(['menu']))).toEqual([]);
    expect(crowded(windows([], []), new Set(['menu']))).toEqual([]);
    expect(openNames(windows(['races', 'watch'], []))).toEqual(new Set(['races', 'watch']));
  });
});

describe('the boat framed clear of a window beside her, held sideways', () => {
  test('on a small phone the picture moves left past the window’s edge', () => {
    // 640 × 360: the menu's left edge at 272, the boat 72 px either side of 320.
    expect(asideOf(640, 360, 272)).toBe(132);
    expect(asideOf(780, 360, 412)).toBe(62);
  });

  test('never under a part on the left that reaches past her sail’s head', () => {
    // The chat's strip to 262: no room left of the window for her.
    expect(asideOf(640, 360, 272, 262)).toBe(0);
    expect(asideOf(780, 360, 412, 262)).toBe(44);
  });

  test('a window already clear of her moves nothing', () => {
    expect(asideOf(1440, 900, 1072)).toBe(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

// Where a key goes: to what has the focus. Typing in a field, the game's
// keys are not heard at all. On the helm or the sheet, the slider answers
// its own arrows (keys.ts). On a key, a list or a window that the
// keyboard reached (Tab, or a window that took the focus as it opened),
// the game's keys stand aside so that the arrows, Space and Enter do what
// they do there; Escape still closes what is open. On the scene or the
// page, and on a key a pointer pressed (which keeps the focus but not its
// ring), the game's keys work as everywhere.
//
// How the focus came is kept here rather than read from :focus-visible:
// Chrome turns that on at any key pressed after a click, Shift included,
// so a player who clicked Reef would steer once with Q and then no more.

import type { KeyFocus } from './keys';

/** The element the keyboard last brought the focus to, or null. */
let reached: Element | null = null;
/** Whether the latest press was a key's rather than a pointer's. */
let lastKey = false;

if (typeof document !== 'undefined') {
  const opts = { capture: true, passive: true } as const;
  document.addEventListener(
    'keydown',
    () => {
      lastKey = true;
    },
    opts,
  );
  document.addEventListener(
    'pointerdown',
    () => {
      lastKey = false;
    },
    opts,
  );
  document.addEventListener(
    'focusin',
    (e) => {
      reached = lastKey && e.target instanceof Element ? e.target : null;
    },
    opts,
  );
}

/** Where a key goes: typing in a field, standing aside, or the game's keys with the focus there. */
export type KeysGo = 'typing' | 'aside' | KeyFocus;

/** Where a key pressed on target goes. */
export function keysGo(target: EventTarget | null): KeysGo {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return 'page';
  }
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return 'typing';
  }
  if (target === document.body || target === document.documentElement) {
    return 'page';
  }
  const control = target.closest('[role="slider"][data-control]')?.getAttribute('data-control');
  if (control === 'helm' || control === 'sheet') {
    return control;
  }
  if (target.closest('[aria-modal="true"]') !== null) {
    return 'aside';
  }
  return target === reached ? 'aside' : 'page';
}

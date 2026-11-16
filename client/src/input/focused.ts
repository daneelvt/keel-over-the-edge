// SPDX-License-Identifier: AGPL-3.0-only

// Where a key goes: to what has the focus. Typing in a field, the game's
// keys are not heard at all. On the helm or the sheet, the slider answers
// its own arrows (keys.ts). On a key, a list or a window that the
// keyboard reached (Tab, or a window that took the focus as it opened),
// the game's keys stand aside so that the arrows, Space and Enter do what
// they do there; Escape still closes what is open. On the scene or the
// page, and on a key a pointer pressed (which keeps the focus but not its
// ring), the game's keys work as everywhere.

import type { KeyFocus } from './keys';

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
  let shown = false;
  try {
    shown = target.matches(':focus-visible');
  } catch {
    // A browser that does not know the selector: the focus as it was.
    shown = true;
  }
  return shown ? 'aside' : 'page';
}

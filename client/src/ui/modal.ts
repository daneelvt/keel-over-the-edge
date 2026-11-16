// SPDX-License-Identifier: AGPL-3.0-only

// Questions and windows, one rule for all: drawn, one takes the focus (on
// the key or field it names, or its first), Escape closes it, and closed
// it gives the focus back to what opened it. A question also makes the
// rest of the page inert while it is asked: the scene and the case behind
// it take no pointer, no key and no reader. The question or window itself
// says it is modal (aria-modal) in its own markup. Escape closes only the
// one opened last, so a window over a window closes alone.

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/** What a question or window asks of the rule. */
export interface ModalOptions {
  /** What takes the focus as it opens: a selector within it; its first key or field without, or itself if it has none. */
  focus?: string;
  /** Whether the rest of the page is inert while it is drawn: a question's. */
  inert?: boolean;
  /** Where the focus goes back to, if what opened it is gone by then: a selector in the page. */
  back?: string;
}

/** The keys and fields that can take the focus. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The questions and windows drawn, the latest last: Escape is the latest's. */
const open: { el: HTMLElement; close: () => void }[] = [];

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) {
    return;
  }
  const top = open.at(-1);
  if (top === undefined) {
    return;
  }
  e.preventDefault();
  top.close();
}

/** The elements beside el and beside each of its ancestors, up to the body: the rest of the page. */
function rest(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (
    let at: HTMLElement | null = el;
    at !== null && at !== document.body;
    at = at.parentElement
  ) {
    for (const s of at.parentElement?.children ?? []) {
      if (s !== at && s instanceof HTMLElement && !s.inert) {
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * Makes el a question or window: its focus, Escape (which calls close) and
 * the focus given back; and, for a question, the rest of the page inert.
 * Returns what undoes it, as it is taken away.
 */
export function modal(el: HTMLElement, close: () => void, options: ModalOptions = {}): () => void {
  const { focus, inert = false, back } = options;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const entry = { el, close };
  if (open.length === 0) {
    document.addEventListener('keydown', onEscape);
  }
  open.push(entry);
  const made = inert ? rest(el) : [];
  for (const e of made) {
    e.inert = true;
  }
  const first =
    (focus === undefined ? null : el.querySelector<HTMLElement>(focus)) ??
    el.querySelector<HTMLElement>(FOCUSABLE) ??
    el;
  first.focus({ preventScroll: true });
  return () => {
    const at = open.indexOf(entry);
    if (at < 0) {
      return;
    }
    open.splice(at, 1);
    if (open.length === 0) {
      document.removeEventListener('keydown', onEscape);
    }
    for (const e of made) {
      e.inert = false;
    }
    // Once the page has drawn what replaces it: unless the focus has gone
    // elsewhere (to a window this one opened), back to its opener.
    queueMicrotask(() => {
      const a = document.activeElement;
      if (a !== null && a !== document.body && a.isConnected && !el.contains(a)) {
        return;
      }
      const to =
        opener?.isConnected === true && opener !== document.body
          ? opener
          : back === undefined
            ? null
            : document.querySelector<HTMLElement>(back);
      to?.focus({ preventScroll: true });
    });
  };
}

/**
 * The rule as a hook: a ref to set on the question or window. close need
 * not be stable.
 */
export function useModal<T extends HTMLElement = HTMLElement>(
  close: () => void,
  options: ModalOptions = {},
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const closing = useRef(close);
  closing.current = close;
  useLayoutEffect(() => {
    const el = ref.current;
    return el === null ? undefined : modal(el, () => closing.current(), options);
  }, []);
  return ref;
}

/**
 * The rule as a ref callback, for a question drawn by a function that
 * keeps free of hooks: made once by its owner, and set as the element's
 * ref, it applies the rule as the element is drawn and undoes it as it
 * goes.
 */
export function modalRef(
  close: () => void,
  options: ModalOptions = {},
): (el: HTMLElement | null) => void {
  let undo: (() => void) | null = null;
  let on: HTMLElement | null = null;
  return (el) => {
    if (el === on) {
      return;
    }
    undo?.();
    undo = null;
    on = el;
    if (el !== null) {
      undo = modal(el, close, options);
    }
  };
}

/**
 * The rule as a part drawn beside a window whose own function keeps free
 * of hooks: of is the window's selector.
 */
export function Modal({ of, close, ...options }: ModalOptions & { of: string; close: () => void }) {
  const closing = useRef(close);
  closing.current = close;
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(of);
    return el === null ? undefined : modal(el, () => closing.current(), options);
  }, []);
  return null;
}

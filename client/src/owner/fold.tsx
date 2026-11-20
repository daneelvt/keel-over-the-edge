// SPDX-License-Identifier: AGPL-3.0-only

// The world's cards, folded: each card's head is a key that folds the card
// away to its head and opens it again, so a long column of cards is a
// short list of heads. What the owner folded is kept in this browser. On
// a phone the cards start folded but the few read most; on a wider screen
// they start open.
//
// The cards are many components' own sections, so the key is dressed on
// each card's head as the card appears, not written into every card:
// Preact keeps what it did not set.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/** The cards open at first on a phone. */
const OPEN_AT_FIRST = new Set(['The world', 'Boats at sea', 'The queue']);

/** Where the folds are kept in the browser. */
const KEPT = 'keel-owner-folds';

/** Whether a card starts folded: on a narrow screen, all but the few. */
export function foldedAtFirst(label: string, narrow: boolean): boolean {
  return narrow && !OPEN_AT_FIRST.has(label);
}

/** The folds kept, by card; none if the browser keeps nothing. */
export function keptFolds(text: string | null): Record<string, boolean> {
  try {
    const kept: unknown = JSON.parse(text ?? '{}');
    if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(kept)) {
      if (typeof v === 'boolean') {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function read(): Record<string, boolean> {
  try {
    return keptFolds(localStorage.getItem(KEPT));
  } catch {
    return {};
  }
}

function keep(folds: Record<string, boolean>): void {
  try {
    localStorage.setItem(KEPT, JSON.stringify(folds));
  } catch {
    // A browser that keeps nothing: the folds last while the page does.
  }
}

/** The column of the world's cards, each folding at its head. */
export function Cards({ children }: { children: ComponentChildren }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el === null) {
      return;
    }
    const narrow = window.matchMedia('(width < 700px)').matches;
    const folds = read();
    const fold = (card: HTMLElement, head: Element, folded: boolean): void => {
      card.dataset.folded = folded ? '1' : '0';
      head.setAttribute('aria-expanded', String(!folded));
    };
    const dress = (): void => {
      for (const card of el.querySelectorAll<HTMLElement>(':scope > section.card')) {
        const head = card.querySelector(':scope > h2');
        const label = card.getAttribute('aria-label');
        if (head === null || label === null || head.getAttribute('role') === 'button') {
          continue;
        }
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        fold(card, head, folds[label] ?? foldedAtFirst(label, narrow));
      }
    };
    const turn = (e: Event): void => {
      const target = e.target as Element;
      const head = target.closest('h2[role="button"]');
      const card = head?.parentElement;
      if (head == null || card == null || card.parentElement !== el) {
        return;
      }
      if (e instanceof KeyboardEvent) {
        if (target !== head || (e.key !== 'Enter' && e.key !== ' ')) {
          return;
        }
        e.preventDefault();
      } else if (target.closest('button, a, input, select') !== null) {
        return;
      }
      const label = card.getAttribute('aria-label') ?? '';
      const folded = card.dataset.folded !== '1';
      fold(card, head, folded);
      folds[label] = folded;
      keep(folds);
    };
    el.addEventListener('click', turn);
    el.addEventListener('keydown', turn);
    const seen = new MutationObserver(dress);
    seen.observe(el, { childList: true });
    dress();
    return () => {
      el.removeEventListener('click', turn);
      el.removeEventListener('keydown', turn);
      seen.disconnect();
    };
  }, []);
  return <aside ref={box}>{children}</aside>;
}

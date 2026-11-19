// SPDX-License-Identifier: AGPL-3.0-only

// A page opened from the menu, drawn as the menu is and in its place,
// beside the boat and never over it: its name and its close (✕) at the
// top, which stay put while the rest scrolls, and a margin round what it
// holds. Escape closes it, as does a tap beside it, and the focus goes
// back to the menu's button. SheetHead alone heads a window that keeps
// its own frame.

import type { ComponentChildren } from 'preact';
import { Modal } from './modal';

/** The close key's name, for a screen reader: the same on every page. */
export const CLOSE_WINDOW = 'Close this window';

/** A page's head: its name, and its close at the top right. */
export function SheetHead({
  title,
  id,
  close,
}: {
  title: ComponentChildren;
  /** The heading's id, which the page is labelled by. */
  id: string;
  /** Closes the page; null for a page that must be answered first. */
  close: (() => void) | null;
}) {
  return (
    <header class="menu-head page-head">
      <h2 id={id}>{title}</h2>
      {close === null ? null : (
        <button type="button" class="menu-x" aria-label={CLOSE_WINDOW} onClick={close}>
          ✕
        </button>
      )}
    </header>
  );
}

/** A page from the menu: name is its own, in the page's markup and its heading's id. */
export function Sheet({
  name,
  title,
  cls = '',
  close,
  x = true,
  children,
}: {
  name: string;
  title: ComponentChildren;
  cls?: string;
  close: () => void;
  /** Whether the head has its close: not on a page that must be answered first. */
  x?: boolean;
  children: ComponentChildren;
}) {
  return (
    <>
      <Modal of={`[data-page="${name}"]`} close={close} back=".menu-button" />
      <div class="menu-scrim" aria-hidden="true" onClick={x ? close : undefined} />
      <section
        class={`panel menu menu-page${cls === '' ? '' : ` ${cls}`}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${name}-title`}
        tabIndex={-1}
        data-page={name}
      >
        <SheetHead title={title} id={`${name}-title`} close={x ? close : null} />
        <div class="menu-body">{children}</div>
      </section>
    </>
  );
}

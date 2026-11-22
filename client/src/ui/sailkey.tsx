// SPDX-License-Identifier: AGPL-3.0-only

// The menu's own key for the skipper's link, while the player's boat is in
// the water: one tap copies the link this device keeps, or, with none out,
// gets one and copies it. Whatever needs more than a tap is Invite
// friends' to see to, which the key then opens: a link out that this
// device does not have (a new one would end it), the questions before a
// first link, a link refused, or a clipboard that will not take it.

import { useEffect, useState } from 'preact/hooks';
import { COPY_SAIL_LINK, GET_SAIL_LINK, SAIL_LINK, SAIL_LINK_COPIED } from './deckwords';
import {
  defaultStore,
  keepLink,
  keptLink,
  type LinkServer,
  type LinkShown,
  type LinkStore,
  linkServer,
  type SailLink,
  shownLink,
} from './sailwithme';

/** What a tap on the key does: nothing yet, gets a link and copies it, copies the one kept, or opens the page. */
export type SailKey = 'reading' | 'get' | 'copy' | 'page';

export function sailKey(shown: LinkShown): SailKey {
  switch (shown.kind) {
    case 'reading':
      return 'reading';
    case 'none':
      return 'get';
    case 'here':
      return 'copy';
    default:
      return 'page';
  }
}

/** The key's words. */
export function sailKeyText(key: SailKey, copied: boolean): string {
  if (copied) {
    return SAIL_LINK_COPIED;
  }
  if (key === 'page') {
    return SAIL_LINK;
  }
  return key === 'copy' ? COPY_SAIL_LINK : GET_SAIL_LINK;
}

/** A first link for the sailor, kept on the device; refused while anything is still to be asked, or by the server. */
export async function firstLink(
  from: LinkServer,
  sailor: string,
  store: LinkStore | null,
): Promise<SailLink> {
  const need = await from.asks();
  if (need !== null && need.length > 0) {
    throw new Error(need[0]);
  }
  const m = await from.make();
  if (!('link' in m)) {
    throw new Error(m.error);
  }
  keepLink(sailor, m.link, store);
  return m.link;
}

/**
 * Copies a text still on its way. Safari takes the clipboard only within
 * the tap itself, so it is handed the promise; a browser that will not
 * take one is given the text once it is here.
 */
export async function copyLater(text: Promise<string>): Promise<void> {
  const c = globalThis.navigator?.clipboard;
  if (c === undefined) {
    throw new Error('no clipboard');
  }
  if (typeof ClipboardItem === 'function' && typeof c.write === 'function') {
    try {
      const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
      await c.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch {
      // No promise taken here, or no text came: the plain way says which.
    }
  }
  await c.writeText(await text);
}

const defaultServer = linkServer();

export function SailLinkKey({
  sailor,
  page,
  from = defaultServer,
  store = defaultStore(),
  copy = copyLater,
}: {
  sailor: string;
  /** Opens Invite friends, in the menu's place. */
  page: () => void;
  from?: LinkServer;
  store?: LinkStore | null;
  copy?: (text: Promise<string>) => Promise<void>;
}) {
  // The link kept is offered at once; the server's word follows.
  const [shown, setShown] = useState<LinkShown>(() => {
    const kept = keptLink(sailor, store);
    return kept !== null && kept.expires > Date.now()
      ? { kind: 'here', link: kept }
      : { kind: 'reading' };
  });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void from.status().then((status) => {
      if (!live) {
        return;
      }
      const s = shownLink(status, keptLink(sailor, store), Date.now());
      if (s.forget) {
        keepLink(sailor, null, store);
      }
      setShown(s.shown);
    });
    return () => {
      live = false;
    };
  }, []);

  const key = sailKey(shown);
  const tap = async () => {
    if (key === 'page') {
      page();
      return;
    }
    if (busy || key === 'reading') {
      return;
    }
    setBusy(true);
    const link =
      shown.kind === 'here' ? Promise.resolve(shown.link) : firstLink(from, sailor, store);
    // Shown as out once made, though the copy fail.
    void link.then(
      (l) => setShown({ kind: 'here', link: l }),
      () => {},
    );
    try {
      await copy(link.then((l) => l.url));
      setCopied(true);
      setBusy(false);
    } catch {
      setBusy(false);
      page();
    }
  };

  return (
    <div class="menu-chart">
      <button
        type="button"
        data-key="sail-link"
        disabled={busy || key === 'reading'}
        onClick={() => void tap()}
      >
        <span aria-live="polite">{sailKeyText(key, copied)}</span>
      </button>
    </div>
  );
}

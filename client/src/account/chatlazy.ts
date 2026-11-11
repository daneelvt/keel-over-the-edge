// SPDX-License-Identifier: AGPL-3.0-only

// Chat's part of the account page, loaded the first time the page opens:
// the game's first download holds none of it.

import { useEffect, useState } from 'preact/hooks';

type ChatAccount = typeof import('./chataccount');

let loading: Promise<ChatAccount> | null = null;

/** The module, loaded once; tried again after a failure. */
export function loadChatAccount(): Promise<ChatAccount> {
  if (loading === null) {
    loading = import('./chataccount').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The module once loaded, or null until then. */
export function useChatAccount(): ChatAccount | null {
  const [m, setM] = useState<ChatAccount | null>(null);
  useEffect(() => {
    let live = true;
    loadChatAccount().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Left out: the page can be opened again.
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return m;
}

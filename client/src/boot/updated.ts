// SPDX-License-Identifier: AGPL-3.0-only

// Whether the game was updated under this page. A page open across a
// deploy keeps working from the service worker's copy of its build; one
// with no worker, or two deploys old, asks for a file the server no longer
// has, and the file fails to load. Then the server's build is asked: if it
// is not this page's, the update line shows (ui/updateline.tsx), and the
// player reloads when they choose. A file that failed with the network
// down, or with the server on this page's build, shows nothing: the screen
// asks for it again when next opened.

import { signal } from '@preact/signals';
import { BUILD } from './build';
import { fetchVersion } from './version';

/** Whether the game was updated under this page: the update line shows. */
export const updated = signal(false);

/** What the check needs. */
export interface UpdateCheck {
  /** This page's build. */
  build: string;
  /** The server's build; rejects with the network down. */
  serverBuild: () => Promise<string>;
}

let checking: Promise<void> | null = null;

/**
 * A file of the page's code failed to load: whether the game was updated
 * is checked, once at a time, and the line shown if so. A page from the
 * development server ("dev") is never told: it has no deploys.
 */
export function codeFailed(check: UpdateCheck): Promise<void> {
  if (updated.peek() || check.build === 'dev') {
    return Promise.resolve();
  }
  if (checking === null) {
    checking = check
      .serverBuild()
      .then(
        (build) => {
          if (build !== check.build) {
            updated.value = true;
          }
        },
        () => {
          // The network is down: nothing is said, and nothing is known.
        },
      )
      .finally(() => {
        checking = null;
      });
  }
  return checking;
}

/** The check against the server, for this page's build. */
export function pageCheck(build: string): UpdateCheck {
  return { build, serverBuild: async () => (await fetchVersion()).build };
}

/** A lazy screen's code failed to load: checked against the server, for this page's build. */
export function lazyFailed(): void {
  void codeFailed(pageCheck(BUILD));
}

/**
 * Listens for the files a lazy screen needs first (Vite preloads them)
 * failing to load: checked as a failed screen is. The failure still
 * reaches the screen's loader, which asks again when next opened.
 */
export function watchForUpdates(win: Pick<Window, 'addEventListener'> = window): void {
  win.addEventListener('vite:preloadError', lazyFailed);
}

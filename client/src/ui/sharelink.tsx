// SPDX-License-Identifier: AGPL-3.0-only

// Sharing a link to watch: through the phone's own share sheet where the
// browser has one, straight to the apps a player posts with; otherwise
// copied, and the key says so. Beside each share, Make a new link, which
// asks first, since the old link then stops working: the one way to take
// back a link that has spread where it should not. Small, and in the
// game's first download with "Your sailor".

import './sharelink.css';
import { type Signal, signal } from '@preact/signals';
import type { Fetch } from '../account/me';
import { call } from '../account/passkeys';
import {
  COPIED,
  KEEP_LINK,
  MAKE_NEW_LINK,
  NEW_LINK_FAILED,
  NEW_LINK_MADE,
  NEW_LINK_QUESTION,
  PICTURE_FAILED,
  PICTURE_SAVED,
  SHARE_PICTURE,
} from './watchwords';

/** What a share is made of: the address, and the text it goes with, the address last in it. */
export interface Shared {
  url: string;
  text: string;
}

/** How a share went: the share sheet took it, it was copied, or neither. */
export type ShareResult = 'shared' | 'copied' | 'failed';

/** The browser's share and clipboard, as far as sharing uses them; a test stands in for them. */
export interface Sharer {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  copy: (text: string) => Promise<void>;
}

/** This browser's share sheet and clipboard. */
export function browserSharer(): Sharer {
  const n = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    ...(typeof n?.share === 'function' ? { share: (d: ShareData) => n.share(d) } : {}),
    ...(typeof n?.canShare === 'function' ? { canShare: (d: ShareData) => n.canShare(d) } : {}),
    copy: (t) => n?.clipboard?.writeText(t) ?? Promise.reject(new Error('no clipboard')),
  };
}

/**
 * Shares s through the share sheet, or copies its address where there is
 * none. A share the player closed is not copied: they chose not to.
 */
export async function shareLink(s: Shared, sharer: Sharer = browserSharer()): Promise<ShareResult> {
  if (sharer.share !== undefined) {
    try {
      // The address is in the text: some apps drop the url beside it.
      await sharer.share({ text: s.text });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return 'failed';
      }
      // Refused for another reason: copied instead.
    }
  }
  try {
    await sharer.copy(s.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * What one link's keys show, kept in signals so that the keys themselves
 * hold no state: its code (made anew here, or as the server last told),
 * whether its share was copied, Make a new link's question, and what was
 * said after it, or after a picture.
 */
export interface LinkState {
  code: Signal<string>;
  copied: Signal<boolean>;
  asking: Signal<boolean>;
  busy: Signal<boolean>;
  said: Signal<string>;
  /** The code the server last told, which a newer telling replaces. */
  told: string;
}

const states = new Map<string, LinkState>();

/**
 * The state of the link named key ("me", "fleet", or a machine sailor's
 * account), its code as the server tells it now: kept across the panels
 * that show it, and taking a newer code the server tells.
 */
export function linkState(key: string, told: string): LinkState {
  let st = states.get(key);
  if (st === undefined) {
    st = {
      code: signal(told),
      copied: signal(false),
      asking: signal(false),
      busy: signal(false),
      said: signal(''),
      told,
    };
    states.set(key, st);
  } else if (st.told !== told) {
    st.told = told;
    st.code.value = told;
    st.copied.value = false;
  }
  return st;
}

/** A key that shares a link, saying "Copied" once it has copied it. */
export function ShareLink({
  label,
  name,
  shared,
  cls,
  copied,
  sharer,
}: {
  label: string;
  /** Its name for a screen reader, where the label alone does not say whose. */
  name?: string;
  /** The link to share, read at the tap; null while it is not known. */
  shared: (() => Shared) | null;
  cls: string;
  /** Whether it was copied, shown on the key; kept by the link's state. */
  copied: Signal<boolean>;
  sharer?: Sharer;
}) {
  return (
    <button
      type="button"
      class={cls}
      disabled={shared === null}
      aria-label={name}
      onClick={() => {
        if (shared === null) {
          return;
        }
        void shareLink(shared(), sharer).then((r) => {
          copied.value = r === 'copied';
        });
      }}
    >
      {copied.value ? COPIED : label}
    </button>
  );
}

/** A copy of the next frame drawn, from the scene's canvas; null if none. */
export type Capture = () => Promise<HTMLCanvasElement | null>;

/** Fetches the picture's module ahead of the tap, so that the tap does not wait for it. */
export function preloadPicture(): void {
  void import('./snapshot').catch(() => {});
}

/**
 * Share with a picture: the view at that moment, drawn by the phone with
 * "Watch Name sail" on it, shared with the link; or saved, and the link
 * copied, where the phone cannot share a file.
 */
export function SharePicture({
  name,
  url,
  capture,
  cls,
  state,
  sharer,
}: {
  /** The sailor the picture names, as "Watch Name sail". */
  name: string;
  /** The link shared with it; null while it is not known. */
  url: string | null;
  capture: Capture;
  cls: string;
  state: LinkState;
  sharer?: Sharer;
}) {
  const go = async () => {
    if (url === null || state.busy.value) {
      return;
    }
    state.busy.value = true;
    state.said.value = '';
    try {
      const m = await import('./snapshot');
      const blob = await m.picture(capture, name);
      if (blob === null) {
        state.said.value = PICTURE_FAILED;
      } else {
        const r = await m.sharePicture(blob, name, url, sharer ?? browserSharer());
        state.said.value = r === 'saved' ? PICTURE_SAVED : '';
      }
    } catch {
      state.said.value = PICTURE_FAILED;
    }
    state.busy.value = false;
  };
  return (
    <button
      type="button"
      class={cls}
      disabled={url === null || state.busy.value}
      onClick={() => void go()}
    >
      {SHARE_PICTURE}
    </button>
  );
}

/** Which of the player's links is made anew: their own, their fleet's, or a machine sailor's by its account. */
export type WhichLink =
  | { which: 'me' }
  | { which: 'fleet' }
  | { which: 'machine'; machine: string };

/** POST /api/me/link/new: the new code, or null if none was made. */
export async function newLink(
  which: WhichLink,
  f: Fetch = (input, init) => fetch(input, init),
): Promise<string | null> {
  const a = await call(f, '/api/me/link/new', which);
  const code = a.body?.code;
  return a.status === 200 && typeof code === 'string' ? code : null;
}

/** Makes the link anew, as Make a new link's question was answered. */
export async function makeNew(state: LinkState, which: WhichLink, f?: Fetch): Promise<void> {
  if (state.busy.value) {
    return;
  }
  state.busy.value = true;
  const code = await newLink(which, f);
  state.busy.value = false;
  state.asking.value = false;
  if (code === null) {
    state.said.value = NEW_LINK_FAILED;
    return;
  }
  state.code.value = code;
  state.copied.value = false;
  state.said.value = NEW_LINK_MADE;
}

/**
 * Make a new link: asks first, then makes it, the link's state taking the
 * new code; says so, or that none could be made. What was said after a
 * picture is said here too.
 */
export function NewLink({
  which,
  state,
  cls,
  name,
  f,
}: {
  which: WhichLink;
  state: LinkState;
  /** The class of the question's keys. */
  cls: string;
  name?: string;
  f?: Fetch;
}) {
  const busy = state.busy.value;
  return (
    <div class="new-link">
      {state.asking.value ? (
        <fieldset class="new-link-ask" aria-label={MAKE_NEW_LINK}>
          <p class="new-link-line">{NEW_LINK_QUESTION}</p>
          <div class="new-link-keys">
            <button
              type="button"
              class={cls}
              disabled={busy}
              onClick={() => (state.asking.value = false)}
            >
              {KEEP_LINK}
            </button>
            <button
              type="button"
              class={cls}
              disabled={busy}
              onClick={() => void makeNew(state, which, f)}
            >
              {MAKE_NEW_LINK}
            </button>
          </div>
        </fieldset>
      ) : (
        <button
          type="button"
          class="new-link-key"
          aria-label={name}
          onClick={() => {
            state.said.value = '';
            state.asking.value = true;
          }}
        >
          {MAKE_NEW_LINK}
        </button>
      )}
      {state.said.value !== '' ? (
        <p class="new-link-line" role="status">
          {state.said.value}
        </p>
      ) : null}
    </div>
  );
}

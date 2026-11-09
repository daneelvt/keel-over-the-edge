// SPDX-License-Identifier: AGPL-3.0-only

// On the player's own panel: their link to watch them, to share anywhere,
// whether or not the box is ticked, with a faint line while it is not;
// and Make a new link. And at its head, a link to watch the page was
// opened at that opened no watch: why, and for a sailor's, ☆ Follow, which
// tells the player here, while the game is open, once the sailor may be
// watched. In the game's first download, with the panel.

import { type Signal, signal } from '@preact/signals';
import { followSailing } from '../ui/following';
import { linkState, NewLink, ShareLink, type Sharer } from '../ui/sharelink';
import { FOLLOW, FOLLOWING, TOO_MANY } from '../ui/watchlistwords';
import {
  linkRefusedText,
  nowWatchableText,
  SHARE_ME,
  SHOWN_WHEN_WATCHED,
  shareText,
  WATCH,
  watchLink,
} from '../ui/watchwords';
import type { Fetch, LinkNote, Me } from './me';
import { call, reasonOf } from './passkeys';
import { reasonText } from './reasons';

/** Share a link to watch me, its faint line while the box is unticked, and Make a new link. */
export function YourLink({
  me,
  ticked,
  sharer,
  f,
}: {
  me: Me;
  ticked: boolean;
  sharer?: Sharer;
  f?: Fetch;
}) {
  const told = me.watchCode ?? '';
  if (told === '') {
    return null;
  }
  const st = linkState('me', told);
  const url = watchLink(location.origin, st.code.value);
  return (
    <div class="share-links your-link">
      <ShareLink
        label={SHARE_ME}
        cls="start-sign-in"
        copied={st.copied}
        shared={() => ({ url, text: shareText(me.name, url) })}
        {...(sharer === undefined ? {} : { sharer })}
      />
      {ticked ? null : (
        <p class="start-text start-faint" data-readout="shown-when-watched">
          {SHOWN_WHEN_WATCHED}
        </p>
      )}
      <NewLink
        which={{ which: 'me' }}
        state={st}
        cls="start-sign-in"
        {...(f === undefined ? {} : { f })}
      />
    </div>
  );
}

/** POST /api/watch/follow by a link's code: '' if it was taken, or why not in words. */
export async function followByLink(
  code: string,
  on: boolean,
  f: Fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const a = await call(f, '/api/watch/follow', { code, on });
  if (a.status === 200) {
    return '';
  }
  const why = reasonOf(a);
  return why === 'too-many' ? TOO_MANY : reasonText(why);
}

/**
 * A refused link's follow, kept in signals: followed, why a follow
 * failed, and the sailor sailing watchable since; and while followed, the
 * stop of the asking after the sailors followed.
 */
export interface RefusedState {
  followed: Signal<boolean>;
  problem: Signal<string>;
  sailing: Signal<boolean>;
  stop: (() => void) | null;
}

const refused = new WeakMap<LinkNote, RefusedState>();

/** The follow of note's sailor, made the first time it is shown. */
export function refusedState(note: LinkNote): RefusedState {
  let st = refused.get(note);
  if (st === undefined) {
    st = { followed: signal(false), problem: signal(''), sailing: signal(false), stop: null };
    refused.set(note, st);
  }
  return st;
}

/**
 * Follows note's sailor, or stops; while followed, asks after the sailors
 * followed (follows), and once the sailor may be watched, says so.
 */
export async function toggleFollow(
  note: LinkNote,
  st: RefusedState,
  f?: Fetch,
  follows: (raise: (name: string) => void) => () => void = followSailing,
): Promise<void> {
  const on = !st.followed.value;
  st.problem.value = '';
  const p = await followByLink(note.code, on, f);
  if (p !== '') {
    st.problem.value = p;
    return;
  }
  st.followed.value = on;
  st.stop?.();
  st.stop = null;
  const name = 'name' in note.refusal ? note.refusal.name : '';
  if (on) {
    st.stop = follows((who) => {
      if (who === name) {
        st.sailing.value = true;
      }
    });
  }
}

/**
 * Why the link the page was opened at opened no watch; for a sailor not
 * to be watched now, ☆ Follow, and once followed, word here when the
 * sailor may be watched, with Watch.
 */
export function LinkRefused({
  note,
  watch,
  f,
}: {
  note: LinkNote;
  watch: (name: string) => void;
  f?: Fetch;
}) {
  const r = note.refusal;
  const name = 'name' in r ? r.name : '';
  const follow = note.code !== '' && (r.why === 'cannot' || r.why === 'not-at-sea');
  const st = refusedState(note);
  const sailing = st.sailing.value;
  return (
    <div class="link-refused start-warning" role="status" data-readout="link-refused">
      <p class="link-refused-line">{sailing ? nowWatchableText(name) : linkRefusedText(r)}</p>
      {sailing ? (
        <button
          type="button"
          class="start-sign-in"
          onClick={() => {
            st.stop?.();
            watch(name);
          }}
        >
          {WATCH}
        </button>
      ) : follow ? (
        <button
          type="button"
          class="start-sign-in link-follow"
          aria-pressed={st.followed.value}
          onClick={() => void toggleFollow(note, st, f)}
        >
          {st.followed.value ? FOLLOWING : FOLLOW}
        </button>
      ) : null}
      {st.problem.value !== '' ? <p class="link-refused-line">{st.problem.value}</p> : null}
    </div>
  );
}

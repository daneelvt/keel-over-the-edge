// SPDX-License-Identifier: AGPL-3.0-only

// The page opened at a link to come aboard, once the player is signed in
// or has made their sailor: in place of Set sail, the skipper and their
// boat, and "Ask to come aboard <boat> with <skipper>"; or how the link
// stands, in a sailor's words. Either way the player may set sail on their
// own. The knock sets sail as Set sail does, the player's own boat in the
// water, and is made once the boat has arrived; before it, the questions
// not yet answered (when they were born, the Rules of the sea). Whichever
// is chosen, the page's address goes back to the game's own, so a reload
// just sails.

import './start.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { sailFullScreen } from '../boot/fullscreen';
import { boatNamed } from '../catalog/boatlooks';
import { type Looks, lookOf } from '../catalog/looks';
import {
  ASK_ABOARD,
  askAboardText,
  cantKnockText,
  KNOCK_LINE,
  LINK_ENDED,
  LINK_UNREAD,
  type LinkRead,
  linkOf,
  READING_LINK,
  SAIL_ON_MY_OWN,
  type SailLink,
  theKind,
} from './comeaboardwords';
import { FirstAsks, firstAsks } from './firstasks';
import type { FirstAsk } from './firstwords';
import type { BoatCatalog } from './fleet';
import { voyage } from './letwatch';
import { checkSession, type Fetch, type Me } from './me';
import { Portrait } from './portraits';

/** Reads a link to come aboard; it changes nothing. */
export async function readLink(token: string, f: Fetch = fetch): Promise<LinkRead> {
  try {
    const res = await f(`/api/sail/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not the server's JSON.
    }
    return linkOf(res.status, body);
  } catch {
    return { kind: 'failed' };
  }
}

/** The page's address without the link, its query kept: a reload just sails. */
export function forgetLink(): void {
  history.replaceState(history.state, '', `/${location.search}${location.hash}`);
}

type View =
  | { kind: 'reading' }
  | { kind: 'read'; read: LinkRead }
  | { kind: 'asks'; link: SailLink; asks: FirstAsk[] };

/** The kind's name for a boat of the catalog, by its place. */
function kindName(cat: BoatCatalog | undefined, kind: number): string {
  return cat?.boats[kind]?.name ?? 'boat';
}

export function ComeAboard({
  me: given,
  token,
  done,
  looks,
  boats,
  fetch: f = fetch,
}: {
  me: Me;
  token: string;
  /** Called with me to sail: with the knock to make, or without it on one's own. */
  done: (me: Me) => void;
  looks?: Looks | undefined;
  boats?: BoatCatalog | undefined;
  fetch?: Fetch;
}) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [me, setMe] = useState(given);
  const [going, setGoing] = useState(false);
  const [v] = useState(() => voyage(given, f));

  useEffect(() => {
    let live = true;
    // The account's answers so far, which the screens before may not have
    // had, and the link.
    void Promise.all([checkSession(f), readLink(token, f)]).then(([check, read]) => {
      if (!live) {
        return;
      }
      if (check.kind === 'sailor') {
        const { born, rules } = check.me;
        setMe((m) => ({
          ...m,
          ...(born === undefined ? {} : { born }),
          ...(rules === undefined ? {} : { rules }),
        }));
      }
      setView({ kind: 'read', read });
    });
    return () => {
      live = false;
    };
  }, [token]);

  const go = (knock: boolean) => {
    if (going) {
      return;
    }
    setGoing(true);
    // In the tap itself, where it is one: the browser allows the full screen only there.
    sailFullScreen();
    forgetLink();
    void v.sail(() => {
      done(knock ? { ...me, knock: token } : me);
    });
  };

  const ask = (link: SailLink) => {
    const asks = firstAsks(me);
    if (asks.length === 0) {
      go(true);
    } else {
      setView({ kind: 'asks', link, asks });
    }
  };

  if (view.kind === 'asks') {
    return (
      <div class="start">
        <FirstAsks
          asks={view.asks}
          onDone={() => go(true)}
          onCancel={() => setView({ kind: 'read', read: { kind: 'link', link: view.link } })}
          fetch={f}
        />
      </div>
    );
  }

  const read = view.kind === 'read' ? view.read : null;
  const link = read?.kind === 'link' ? read.link : null;
  const why =
    read === null
      ? READING_LINK
      : read.kind === 'ended'
        ? LINK_ENDED
        : read.kind === 'failed'
          ? LINK_UNREAD
          : cantKnockText(read.link.can, read.link.skipper);
  const look = link === null || looks === undefined ? null : lookOf(looks, link.look);
  return (
    <div class="start">
      <section class="start-panel come-aboard" aria-labelledby="start-title">
        <h1 id="start-title">Keel Over the Edge</h1>
        {link === null ? null : (
          <div class="your-sailor-who">
            {look === null || looks === undefined ? null : (
              <Portrait looks={looks} look={look} size={72} decorative />
            )}
            <div class="your-sailor-words">
              <p class="your-sailor-name">
                <bdi>{link.skipper}</bdi>
              </p>
              <p class="start-text start-faint" data-readout="boat">
                {link.boat === '' ? (
                  kindName(boats, link.kind)
                ) : (
                  <bdi>{boatNamed(kindName(boats, link.kind), link.boat, 0)}</bdi>
                )}
              </p>
            </div>
          </div>
        )}
        {why === '' && link !== null ? (
          <>
            <button
              type="button"
              class="start-go your-sailor-go"
              disabled={going}
              aria-label={askAboardText(kindName(boats, link.kind), link.boat, link.skipper)}
              onClick={() => ask(link)}
            >
              {ASK_ABOARD}{' '}
              {link.boat === '' ? (
                theKind(kindName(boats, link.kind))
              ) : (
                <>
                  «<bdi>{link.boat}</bdi>»
                </>
              )}{' '}
              with <bdi>{link.skipper}</bdi>
            </button>
            <p class="start-text start-faint">
              {KNOCK_LINE[0]} <bdi>{link.skipper}</bdi> {KNOCK_LINE[1]}
            </p>
          </>
        ) : (
          <p class="start-text" role="status" data-readout="link">
            {why}
          </p>
        )}
        <button
          type="button"
          class="start-sign-in"
          disabled={going || read === null}
          onClick={() => go(false)}
        >
          {SAIL_ON_MY_OWN}
        </button>
      </section>
    </div>
  );
}

/**
 * Shows the page opened at a link to come aboard in parent until the
 * player chooses, then removes it: resolves with me to sail, its knock set
 * when the player asked to come aboard.
 */
export function showComeAboard(
  parent: HTMLElement,
  me: Me,
  token: string,
  looks?: Looks,
  boats?: BoatCatalog,
): Promise<Me> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    parent.append(root);
    const done = (m: Me) => {
      render(null, root);
      root.remove();
      resolve(m);
    };
    render(<ComeAboard me={me} token={token} done={done} looks={looks} boats={boats} />, root);
  });
}

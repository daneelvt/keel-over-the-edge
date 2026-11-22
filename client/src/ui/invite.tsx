// SPDX-License-Identifier: AGPL-3.0-only

// Invite friends: the page of the menu where a player shares a link,
// for what is on the screen, each kind under its own name (the menu has
// one key of its own besides, which copies the link to sail with them). At sea in
// their own boat, Watch me sail: whether others may watch this voyage, the
// link to watch, shared alone or with a picture of the view, and a new
// link made; and Sail with me, while the boat is in the water: the link by
// which others ask to come aboard, and Closed to knocks. Watching a
// machine sailor of their own, that sailor's two: its link to watch, and
// its link to sail with it, by which another player sends a machine
// sailor aboard, with Call ashore while it is crew aboard another's boat.
// Watching anyone else, Watch me sail. Each part is drawn once its module
// is loaded.

import type { DeckView } from './decklazy';
import { canShareLink, machineShared, useDeck } from './decklazy';
import {
  INVITE_FRIENDS,
  SAIL_WITH_ME,
  SAIL_WITH_ME_DETAIL,
  WATCH_ME,
  WATCH_ME_DETAIL,
} from './deckwords';
import { sailWithFor } from './machinewords';
import { Sheet } from './sheet';
import { useWatch, type WatchView } from './watchlazy';
import { watchSailText } from './watchwords';

/** Whether the page has anything to offer: a link to watch, or one to sail with. */
export function canInvite(watch: WatchView | null, deck: DeckView | null): boolean {
  return watch !== null || (deck !== null && canShareLink(deck));
}

export function InvitePanel({
  watch,
  deck,
  sailor,
  close,
}: {
  /** Watching, whose link to watch the player is shared; null for none. */
  watch: WatchView | null;
  /** Sailing together, whose link to come aboard is shared; null for none. */
  deck: DeckView | null;
  sailor: string | null;
  close: () => void;
}) {
  const sail = deck !== null && canShareLink(deck);
  // The player's own machine sailor watched: its links, not the player's.
  const machine = deck === null ? null : machineShared(deck);
  const w = useWatch(watch !== null);
  const d = useDeck(sail || machine !== null);
  // A picture of the view while the player's own boat is drawn, not one watched.
  const capture = watch === null || watch.spectating.value ? null : (watch.capture ?? null);
  if (machine !== null && deck !== null) {
    return (
      <Sheet name="invite" title={INVITE_FRIENDS} cls="invite" close={close}>
        <section class="invite-part" aria-labelledby="invite-watch" data-part="watch-machine">
          <h3 id="invite-watch">{watchSailText(machine)}</h3>
          {w === null ? null : <w.WatchSailorLink name={machine} />}
        </section>
        <section class="invite-part" aria-labelledby="invite-sail" data-part="sail-machine">
          <h3 id="invite-sail">{sailWithFor(machine)}</h3>
          {d === null ? null : <d.MachineSailWith machine={machine} deck={deck} close={close} />}
        </section>
        <button type="button" class="menu-close" onClick={close}>
          Close
        </button>
      </Sheet>
    );
  }
  return (
    <Sheet name="invite" title={INVITE_FRIENDS} cls="invite" close={close}>
      {watch !== null ? (
        <section class="invite-part" aria-labelledby="invite-watch" data-part="watch">
          <h3 id="invite-watch">{WATCH_ME}</h3>
          <p class="menu-note">{WATCH_ME_DETAIL}</p>
          {w === null ? null : <w.SpectatorsChoice share={{ capture }} />}
        </section>
      ) : null}
      {sail ? (
        <section class="invite-part" aria-labelledby="invite-sail" data-part="sail">
          <h3 id="invite-sail">{SAIL_WITH_ME}</h3>
          {d === null ? null : (
            <d.SailWithMe
              bare
              deck={deck}
              sailor={sailor}
              close={close}
              detail={SAIL_WITH_ME_DETAIL}
            />
          )}
        </section>
      ) : null}
      <button type="button" class="menu-close" onClick={close}>
        Close
      </button>
    </Sheet>
  );
}

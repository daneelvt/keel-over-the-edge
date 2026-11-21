// SPDX-License-Identifier: AGPL-3.0-only

// What a player watching their own machine sailor sees to: its link, in
// Invite friends, which another player opens to send a machine sailor of
// theirs aboard, the knock answered by the player wherever they are in
// the game, and Call ashore while it is crew aboard another's boat; and
// who is aboard its boat, each to be put ashore. The machine sailor's
// agent has no say in either.

import { useState } from 'preact/hooks';
import type { Fetch } from '../account/me';
import { call } from '../account/passkeys';
import type { DeckView } from './decklazy';
import { actionName, CLOSE, MORE, moreFor, PUT_ASHORE, WHO_IS_ABOARD } from './deckwords';
import {
  CALL_ASHORE,
  COG,
  callAshoreText,
  SAIL_WITH_MACHINE_DETAIL,
  sailWithFor,
} from './machinewords';
import { PlayerText } from './player';
import { linkServer, SailWithMe } from './sailwithme';
import { SheetHead } from './sheet';

/**
 * Invite friends' part for one of the player's machine sailors, watched:
 * its link, which another player opens to send a machine sailor of theirs
 * aboard, the Rules of the sea asked first where they must be; and, while
 * it is crew aboard another's boat, Call ashore.
 */
export function MachineSailWith({
  machine,
  deck,
  close,
  f = (input, init) => fetch(input, init),
}: {
  machine: string;
  /** The boat closed to knocks, and the switch, and who is aboard. */
  deck: DeckView;
  close: () => void;
  f?: Fetch;
}) {
  const [from] = useState(() => linkServer(f, machine));
  const [busy, setBusy] = useState(false);
  const [called, setCalled] = useState(false);
  const crew = deck.crew.value;
  // Aboard another's boat: its skipper is not the machine sailor.
  const aboard = crew !== null && crew.people.length > 0 && crew.people[0]?.name !== machine;
  const ashore = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    const a = await call(f, '/api/sail/ashore', { machine });
    setCalled(a.status === 204);
    setBusy(false);
  };
  return (
    <>
      <SailWithMe
        bare
        deck={deck}
        sailor={`machine:${machine}`}
        close={close}
        from={from}
        title={sailWithFor(machine)}
        detail={SAIL_WITH_MACHINE_DETAIL}
      />
      {aboard && !called ? (
        <div class="deck-keys">
          <button
            type="button"
            class="plate-key"
            disabled={busy}
            aria-label={callAshoreText(machine)}
            onClick={() => void ashore()}
          >
            {CALL_ASHORE}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Who is aboard the player's own machine sailor's boat, watched: each but its skipper to be put ashore. */
export function MachineCrew({ deck, machine }: { deck: DeckView; machine: string }) {
  const crew = deck.crew.value;
  const close = () => (deck.list.value = false);
  const people = crew?.people ?? [];
  // The one row whose ⋯ is open, by seat; -1 for none.
  const [opened, setOpened] = useState(-1);
  // Only while the machine sailor watched is the boat's skipper.
  const skipper = people[0]?.name === machine;
  return (
    <section class="panel deck-window deck-list at-side" aria-labelledby="machine-crew-title">
      <SheetHead title={WHO_IS_ABOARD} id="machine-crew-title" close={close} />
      <ul class="deck-rows">
        {people.map((p) => (
          <li class="deck-row" key={p.seat} data-seat={p.seat}>
            <span class="deck-row-name">
              <PlayerText text={p.name} />
              {p.machine ? COG : ''}
            </span>
            {skipper && p.seat !== 0 ? (
              <span class="deck-row-keys">
                <button
                  type="button"
                  class="plate-key deck-more"
                  aria-label={moreFor(p.name)}
                  aria-expanded={opened === p.seat}
                  onClick={() => setOpened(opened === p.seat ? -1 : p.seat)}
                >
                  {MORE}
                </button>
              </span>
            ) : null}
            {skipper && p.seat !== 0 && opened === p.seat ? (
              <div class="deck-row-more">
                <button
                  type="button"
                  class="plate-key"
                  aria-label={actionName(PUT_ASHORE, p.name)}
                  onClick={() => {
                    setOpened(-1);
                    deck.putAshore(p.seat);
                  }}
                >
                  {PUT_ASHORE}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div class="deck-keys deck-list-foot">
        <button type="button" class="plate-key deck-close" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

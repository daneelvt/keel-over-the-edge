// SPDX-License-Identifier: AGPL-3.0-only

// The windows of a player watching their own machine sailor: its link,
// which another player opens to send a machine sailor of theirs aboard,
// the knock answered by the player wherever they are in the game; and who
// is aboard its boat, each to be put ashore. The machine sailor's agent
// has no say in either.

import { useState } from 'preact/hooks';
import type { DeckView } from './decklazy';
import { CLOSE, PUT_ASHORE, WHO_IS_ABOARD } from './deckwords';
import { COG, SAIL_WITH_MACHINE_DETAIL, sailWithMeFor } from './machinewords';
import { PlayerText } from './player';
import { linkServer, SailWithMe } from './sailwithme';

/** The link of one of the player's machine sailors, named machine. */
export function MachineLink({
  machine,
  deck,
  close,
}: {
  machine: string;
  /** The boat closed to knocks, and the switch; null where there is no game connection. */
  deck: Pick<DeckView, 'closed' | 'closeKnocks'> | null;
  close: () => void;
}) {
  const [from] = useState(() => linkServer(undefined, machine));
  return (
    <SailWithMe
      deck={deck}
      sailor={`machine:${machine}`}
      close={close}
      from={from}
      title={sailWithMeFor(machine)}
      detail={SAIL_WITH_MACHINE_DETAIL}
    />
  );
}

/** Who is aboard the player's own machine sailor's boat, watched: each but its skipper to be put ashore. */
export function MachineCrew({ deck, machine }: { deck: DeckView; machine: string }) {
  const crew = deck.crew.value;
  const close = () => (deck.list.value = false);
  const people = crew?.people ?? [];
  // Only while the machine sailor watched is the boat's skipper.
  const skipper = people[0]?.name === machine;
  return (
    <section class="panel deck-window deck-list" aria-labelledby="machine-crew-title">
      <h2 id="machine-crew-title">{WHO_IS_ABOARD}</h2>
      <ul class="deck-rows">
        {people.map((p) => (
          <li class="deck-row" key={p.seat} data-seat={p.seat}>
            <span class="deck-row-name">
              <PlayerText text={p.name} />
              {p.machine ? COG : ''}
            </span>
            {skipper && p.seat !== 0 ? (
              <span class="deck-row-keys">
                <button type="button" class="plate-key" onClick={() => deck.putAshore(p.seat)}>
                  {PUT_ASHORE}
                </button>
              </span>
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

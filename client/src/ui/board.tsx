// SPDX-License-Identifier: AGPL-3.0-only

// The harbourmaster's board, in a port or Port Royal, which the case's
// pusher opens while the boat is in the harbour: painted as a board, its
// words the page's own, so a screen reader reads it as it reads the box:
// the gale warning in force, the general situation, the next ninety
// minutes, and now. In Port Royal or a port town, not at a fishing
// village, the player's own boat may be changed there: "Your boat" opens
// its look's chooser over the sea, in the board's place, and "Change boat"
// the fleet's available boats, one chosen taking the place of the one in the
// water. The server checks the place again, and says why it refuses.

import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { BoatChooser } from '../account/boatchooser';
import { BoatLookChooser, CHANGE_BOAT, ChangeBoat, YOUR_BOAT } from '../account/boats';
import { type Board, boardOf } from '../chart/board';
import type { Forecasting } from '../chart/forecasting';
import type { ChartStore } from '../chart/store';
import { type HarbourLook, HarbourPicker } from './harbourlook';

/**
 * The port the boat is in, by its name and where its harbour is, and
 * whether boats may be changed there (Port Royal or a port town, not a
 * fishing village); or null.
 */
export type InPort = { name: string; east: number; north: number; boats: boolean } | null;

/** What the board needs to change the player's boat in a port. */
export interface HarbourBoats {
  /** Whether the boat in view is the player's own, not one watched. */
  own: ReadonlySignal<boolean>;
  chooser: BoatChooser;
}

/** What the board needs: the port the boat is in, the forecast and the chart. */
export interface HarbourView {
  port: ReadonlySignal<InPort>;
  src: Forecasting;
  store: ChartStore;
  /** The player's look, changed in Port Royal's harbour; none where it cannot be. */
  look?: HarbourLook;
  /** The player's boat, changed in a port; none where it cannot be. */
  boats?: HarbourBoats;
}

/** Whether the board offers the player's boat to change: in a port that allows it, their own boat. */
export function boatsHere(harbour: HarbourView, port: NonNullable<InPort>): boolean {
  return port.boats && harbour.boats?.own.value === true;
}

/**
 * The board's keys to the player's boat, where it may be changed: Your
 * boat and Change boat, each once the fleet is read; or why it cannot be.
 */
export function BoatKeys({ boats }: { boats: BoatChooser }) {
  const unread = boats.unread.value;
  return (
    <>
      <button
        type="button"
        class="board-close board-you"
        disabled={boats.yours === null}
        onClick={() => boats.openLook()}
      >
        {YOUR_BOAT}
      </button>
      <button
        type="button"
        class="board-close board-you"
        disabled={boats.fleet.value === null}
        onClick={() => boats.openBoats()}
      >
        {CHANGE_BOAT}
      </button>
      {unread !== '' ? <p class="board-office">{unread}</p> : null}
    </>
  );
}

/** The board of the port the boat is in. */
export function BoardPanel({
  id,
  harbour,
  port,
  close,
}: {
  id: string;
  harbour: HarbourView;
  port: NonNullable<InPort>;
  close: () => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [picking, setPicking] = useState(false);
  const version = harbour.src.forecasts.version;
  useEffect(() => {
    let on = true;
    const ask = () => {
      void boardOf(harbour.src, harbour.store, port).then((b) => {
        if (on) {
          setBoard(b);
        }
      });
    };
    ask();
    const t = setInterval(ask, 10_000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [harbour, port.name, port.east, port.north, version]);
  const you = harbour.look;
  const boats = boatsHere(harbour, port) ? harbour.boats?.chooser : undefined;
  // The fleet read afresh each time the board opens where it may be changed.
  useEffect(() => {
    if (boats !== undefined) {
      boats.cancel();
      void boats.load();
    }
  }, [boats]);
  if (picking && you !== undefined) {
    return <HarbourPicker look={you} close={() => setPicking(false)} />;
  }
  const boat = boats?.mode.value ?? 'shown';
  if (boats !== undefined && boat === 'look') {
    return <BoatLookChooser chooser={boats} board className="panel board harbour-look" />;
  }
  if (boats !== undefined && boat === 'boats') {
    return <ChangeBoat chooser={boats} board className="panel board harbour-look" />;
  }
  return (
    <section id={id} class="panel board" aria-label={`${port.name}: the harbourmaster's board`}>
      <h2>{port.name}</h2>
      <p class="board-office">The harbourmaster's board</p>
      {board === null ? (
        <p>No forecast posted yet.</p>
      ) : (
        <>
          {board.warning !== null ? (
            <section class="board-warning" aria-label="Gale warnings in force">
              <h3>Gale warning</h3>
              <p>{board.warning}.</p>
            </section>
          ) : null}
          <section aria-label="General situation">
            <h3>General situation</h3>
            {board.situation.map((line) => (
              <p key={line}>{line}.</p>
            ))}
          </section>
          <section aria-label="Next 90 minutes">
            <h3>Next 90 minutes</h3>
            <p data-readout="board-outlook">{board.outlook}</p>
          </section>
          <section aria-label="Now">
            <h3>Now</h3>
            <dl>
              <dt>Wind</dt>
              <dd>{board.now.wind}</dd>
              <dt>Gusts</dt>
              <dd>{board.now.gusts}</dd>
              <dt>Sky</dt>
              <dd>{board.now.sky}</dd>
              <dt>Visibility</dt>
              <dd>{board.now.visibility}</dd>
              <dt>Barometer</dt>
              <dd>{board.now.barometer}</dd>
            </dl>
          </section>
        </>
      )}
      {you?.royal.value === true ? (
        <button type="button" class="board-close board-you" onClick={() => setPicking(true)}>
          Your sailor
        </button>
      ) : null}
      {boats !== undefined ? <BoatKeys boats={boats} /> : null}
      <button type="button" class="board-close" onClick={close}>
        Close
      </button>
    </section>
  );
}

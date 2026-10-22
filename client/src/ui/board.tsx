// SPDX-License-Identifier: AGPL-3.0-only

// The harbourmaster's board, in a port or Port Royal: a button while the
// boat is in the harbour opens it, painted as a board, its words the page's
// own, so a screen reader reads it as it reads the box: the gale warning in
// force, the general situation, the next ninety minutes, and now.

import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { type Board, boardOf } from '../chart/board';
import type { Forecasting } from '../chart/forecasting';
import type { ChartStore } from '../chart/store';

/** The port the boat is in, by its name and where its harbour is, or null. */
export type InPort = { name: string; east: number; north: number } | null;

/** What the board needs: the port the boat is in, the forecast and the chart. */
export interface HarbourView {
  port: ReadonlySignal<InPort>;
  src: Forecasting;
  store: ChartStore;
}

/** The board's button while in port, and the board when it is open. */
export function HarbourBoard({ harbour }: { harbour: HarbourView }) {
  const [open, setOpen] = useState(false);
  const port = harbour.port.value;
  if (port === null) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        class="panel board-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Harbour board
      </button>
      {open ? <BoardPanel harbour={harbour} port={port} close={() => setOpen(false)} /> : null}
    </>
  );
}

function BoardPanel({
  harbour,
  port,
  close,
}: {
  harbour: HarbourView;
  port: NonNullable<InPort>;
  close: () => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
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
  return (
    <section class="panel board" aria-label={`${port.name}: the harbourmaster's board`}>
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
      <button type="button" class="board-close" onClick={close}>
        Close
      </button>
    </section>
  );
}

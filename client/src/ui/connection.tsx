// SPDX-License-Identifier: AGPL-3.0-only

// The connection, as the player sees it: nothing while it is well; a quiet
// line while it reconnects, with the boat sailing on under prediction; the
// harbourmaster's bell, when the server is about to restart, kept until the
// boat is back; that the boat returned to port, if it had to; and that
// another device has the boat, with a button to take it back.

import type { ReadonlySignal } from '@preact/signals';
import type { Notice } from '../net/online';

/** What the screen shows of the game connection; null in the offline sandbox. */
export interface ConnectionView {
  notice: ReadonlySignal<Notice | null>;
  /** The round trip, ms; −1 until measured. */
  rtt: ReadonlySignal<number>;
  takeOver: () => void;
}

export function ConnectionLine({ view }: { view: ConnectionView }) {
  const n = view.notice.value;
  if (n === null) {
    return null;
  }
  return (
    <p class="panel connection-line" role="status" data-readout="connection">
      {n.text}
      {n.takeover ? (
        <button type="button" class="takeover" onClick={view.takeOver}>
          Take over
        </button>
      ) : null}
    </p>
  );
}

/** The round trip in words: "…" until measured. */
export function roundTrip(ms: number): string {
  if (ms < 0) {
    return '…';
  }
  return ms < 1 ? 'under 1 ms' : `${Math.round(ms)} ms`;
}

/** The round trip, for the menu. */
export function RoundTrip({ view }: { view: ConnectionView }) {
  return <p class="menu-rtt">Round trip {roundTrip(view.rtt.value)}</p>;
}

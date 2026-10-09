// SPDX-License-Identifier: AGPL-3.0-only

// The queue for a boat, as the player sees it while the sea is full: their
// place in line and how many wait, over the "Back soon" screen, until the
// Welcome, when the sea is shown.

import type { ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import type { Place } from '../net/online';

/** n as an English ordinal: 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
  }
  return `${n}th`;
}

/** The queue's words: the place, and how many wait. */
export function queueLines(p: Place): [string, string] {
  const place =
    p.position === 1 ? 'You are next in line.' : `You are ${ordinal(p.position)} in line.`;
  const waiting = p.waiting === 1 ? '1 sailor waiting.' : `${p.waiting} sailors waiting.`;
  return [`The sea is full. ${place}`, waiting];
}

export function QueueNotice({ place }: { place: ReadonlySignal<Place | null> }) {
  const p = place.value;
  if (p === null) {
    return null;
  }
  const [line, waiting] = queueLines(p);
  return (
    <div class="queue" role="status" data-readout="queue">
      <p class="queue-place">{line}</p>
      <p class="queue-waiting">{waiting}</p>
    </div>
  );
}

/** Shows the queue while place holds one; the result takes it away for good. */
export function showQueue(parent: HTMLElement, place: ReadonlySignal<Place | null>): () => void {
  const host = document.createElement('div');
  parent.append(host);
  render(<QueueNotice place={place} />, host);
  return () => {
    render(null, host);
    host.remove();
  };
}

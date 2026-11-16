// SPDX-License-Identifier: AGPL-3.0-only

// The update line: the game was updated under this page (boot/updated.ts),
// so a screen it opened could not load. At sea it stands where the notices
// do, with a key to reload; on the start screen at the top, as "Back soon"
// does. The player reloads when they choose: a reload mid-voyage costs
// them their place for a moment.

import { updated } from '../boot/updated';
import { RELOAD, UPDATED } from './updatewords';

/** The line, at sea or on the start screen; nothing until the game was updated. */
export function UpdateLine({
  start = false,
  reload = () => location.reload(),
}: {
  /** On the start screen, not at sea. */
  start?: boolean;
  reload?: () => void;
}) {
  if (!updated.value) {
    return null;
  }
  return (
    <p
      class={start ? 'update-line back-soon' : 'update-line panel notice notice-active with-act'}
      role="status"
      data-readout="update"
    >
      <span>{UPDATED}</span>
      <button type="button" class={start ? 'start-sign-in' : 'notice-act'} onClick={reload}>
        {RELOAD}
      </button>
    </p>
  );
}

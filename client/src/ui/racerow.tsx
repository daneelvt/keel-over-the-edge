// SPDX-License-Identifier: AGPL-3.0-only

// The small parts a race's row shares wherever it is listed (the
// harbourmaster's board, the menu, Make a race, the card, a certificate's
// task): the upwind sign on a course sailed partly up the wind, and the
// few words that stand where Enter would, saying why a row cannot be
// entered; a reason the player can cure, a certificate not yet held, opens
// the Certificates, where it is earned.

import { openLog } from './loglazy';
import type { EnterTold } from './raceapi';
import { rowReasonText, UPWIND, UPWIND_TODAY } from './racewords';

/** The upwind sign: a small zigzag up the wind and the word; "Starts upwind today" for an island race's start. */
export function UpwindSign({ today = false }: { today?: boolean }) {
  return (
    <span class="upwind-sign" data-readout="upwind">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M6 11.5 L3 9 L9 6 L3 3.5 L6 1" />
        <path d="M3.6 2.6 L6 1 L8.4 2.6" />
      </svg>
      {today ? UPWIND_TODAY : UPWIND}
    </span>
  );
}

/** Opens the player's own Certificates, where a certificate is earned. */
export function openCertificates(): void {
  openLog({ kind: 'own', tab: 'certificates' });
}

/** Why a row cannot be entered, where its key would be; a certificate's opens the Certificates. Nothing where it may be. */
export function RowReason({ enter }: { enter: EnterTold }) {
  const text = rowReasonText(enter);
  if (text === '') {
    return null;
  }
  if (enter.reason === 'certificate') {
    return (
      <button
        type="button"
        class="race-row-reason race-row-cure"
        data-readout="row-reason"
        onClick={openCertificates}
      >
        {text}
      </button>
    );
  }
  return (
    <span class="race-row-reason" data-readout="row-reason">
      {text}
    </span>
  );
}

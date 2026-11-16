// SPDX-License-Identifier: AGPL-3.0-only

// The offer to play from the home screen, on the player's own panel under
// Set sail (boot/homescreen.ts says when): one line and two keys; on an
// iPhone, once Add Keel is tapped, the steps to the Home Screen in its
// place.

import type { HomeScreen } from '../boot/homescreen';
import { ADD_KEEL, INSTALL_HOME_SCREEN, NOT_NOW, PLAY_FROM_HOME_SCREEN } from '../ui/installwords';

export function HomeOffer({ home }: { home: HomeScreen | null }) {
  if (home === null) {
    return null;
  }
  if (home.steps.value) {
    return (
      <p class="start-text start-faint home-offer" role="note">
        {INSTALL_HOME_SCREEN}
      </p>
    );
  }
  if (!home.offered.value) {
    return null;
  }
  return (
    <div class="home-offer">
      <p class="start-text">{PLAY_FROM_HOME_SCREEN}</p>
      <div class="home-offer-keys">
        <button type="button" class="start-sign-in" onClick={() => void home.add()}>
          {ADD_KEEL}
        </button>
        <button type="button" class="start-link" onClick={() => home.notNow()}>
          {NOT_NOW}
        </button>
      </div>
    </div>
  );
}

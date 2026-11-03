// SPDX-License-Identifier: AGPL-3.0-only

// The keys at sea, one set of round keys in the instruments' lacquer and
// brass, in a column under the pocket chart (a row beside it on a short
// screen): the menu's button; Back to the boat, a crosshair with a dot,
// filled while the camera rests behind the boat and hollow while it looks
// elsewhere; the clear view's eye, shut while everything shows and open
// while the screen is clear; and the key that brings the full screen back,
// while it is wanted. While the screen is clear, Back to the boat and the
// eye stay in their places, faint until touched.

import type { ReadonlySignal } from '@preact/signals';
import type { ClearView } from './clearview';

/** The camera as the keys see it. */
export interface CameraKeys {
  /** Whether it rests behind the boat. */
  resting: ReadonlySignal<boolean>;
  /** Eases it back behind the boat, at its resting view and distance. */
  behind(): void;
}

export const BACK_TO_THE_BOAT = 'Back to the boat';
export const CLEAR_VIEW = 'Clear view';
export const SHOW_INSTRUMENTS = 'Show the instruments';

/** The menu's button: three bars. */
export function MenuKey({ open, press }: { open: boolean; press: () => void }) {
  return (
    <button
      type="button"
      class="round sea-key menu-button"
      aria-label="Menu"
      aria-expanded={open}
      onClick={press}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <path d="M3 5h14M3 10h14M3 15h14" />
      </svg>
    </button>
  );
}

/** Back to the boat: a crosshair, its dot filled while the camera rests behind the boat. */
export function BackKey({ camera }: { camera: CameraKeys }) {
  const resting = camera.resting.value;
  return (
    <button
      type="button"
      class={`round sea-key back-key${resting ? ' resting' : ''}`}
      aria-label={BACK_TO_THE_BOAT}
      aria-keyshortcuts="B"
      data-resting={resting}
      onClick={() => camera.behind()}
    >
      <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">
        <circle cx="10" cy="10" r="6" />
        <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" />
        <circle class={`key-dot${resting ? '' : ' hollow'}`} cx="10" cy="10" r="2.4" />
      </svg>
    </button>
  );
}

/** The clear view's key: an eye, shut while everything shows, open while the screen is clear. */
export function ClearKey({ clear }: { clear: ClearView }) {
  const on = clear.on.value;
  return (
    <button
      type="button"
      class="round sea-key clear-key"
      aria-label={on ? SHOW_INSTRUMENTS : CLEAR_VIEW}
      aria-pressed={on}
      aria-keyshortcuts="H"
      onClick={() => clear.toggle()}
    >
      <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">
        {on ? (
          <>
            <path d="M1.5 10C4 5.5 7 3.8 10 3.8s6 1.7 8.5 6.2C16 14.5 13 16.2 10 16.2S4 14.5 1.5 10Z" />
            <circle class="key-dot" cx="10" cy="10" r="2.6" />
          </>
        ) : (
          <path d="M1.5 8.5C4 12 7 13.5 10 13.5s6-1.5 8.5-5M4.5 11.5 3 13.5M10 13.5V16M15.5 11.5l1.5 2" />
        )}
      </svg>
    </button>
  );
}

/** The key that brings the full screen back after the phone was away: four corners. */
export function FullScreenKey({ resume }: { resume: () => void }) {
  return (
    <button
      type="button"
      class="round sea-key fullscreen-key"
      aria-label="Full screen"
      onClick={resume}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <path d="M2 7V2h5M13 2h5v5M18 13v5h-5M7 18H2v-5" />
      </svg>
    </button>
  );
}

/** The column of keys, or the row on a short screen: what of them there is. */
export function SeaKeys({
  menu,
  camera,
  clear,
  full,
}: {
  menu: { open: boolean; press: () => void } | null;
  camera: CameraKeys | null;
  clear: ClearView | null;
  /** The full screen's key, while it is wanted. */
  full: (() => void) | null;
}) {
  return (
    <div class={`sea-keys${clear?.on.value === true ? ' clear' : ''}`}>
      {menu !== null ? <MenuKey open={menu.open} press={menu.press} /> : null}
      {camera !== null ? <BackKey camera={camera} /> : null}
      {clear !== null ? <ClearKey clear={clear} /> : null}
      {full !== null ? <FullScreenKey resume={full} /> : null}
    </div>
  );
}

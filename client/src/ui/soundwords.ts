// SPDX-License-Identifier: AGPL-3.0-only

// The sound's words: the menu's Sound block, and the passing notice the M
// key shows.

/** The switch, the mute. */
export const SOUND = 'Sound';

/** The sliders: all of it, the sea and wind, and every other sound. */
export const VOLUME = 'Volume';
export const SEA_AND_WIND = 'Sea and wind';
export const SOUNDS = 'Sounds';

/** The notice as the M key turns the sound off or on. */
export const SOUND_OFF = 'Sound off';
export const SOUND_ON = 'Sound on';

/** A slider's value, 0 to 1, as the player and a screen reader read it. */
export function percentText(v: number): string {
  return `${Math.round(Math.min(Math.max(v, 0), 1) * 100)}%`;
}

/** The notice for the sound turned on or off. */
export function soundNotice(on: boolean): string {
  return on ? SOUND_ON : SOUND_OFF;
}

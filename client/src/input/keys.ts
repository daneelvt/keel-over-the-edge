// SPDX-License-Identifier: AGPL-3.0-only

// The keyboard. Keys are on or off, so a held key moves a control's target
// at a steady rate, which gives the same fine control a thumb has: the left
// and right arrows (or A and D) move the helm, W hauls the sheet in and S
// eases it. C centres the helm. Keys are read by their place on the
// keyboard (KeyboardEvent.code), whatever its layout.

import type { HelmInput } from './helm';
import { clamp } from './helm';
import type { SheetInput } from './sheet';

/** Seconds for a held key to move the helm over its full travel. */
export const HELM_KEY_TIME = 0.6;
/** Seconds for a held key to move the sheet over its whole range. */
export const SHEET_KEY_TIME = 2;

type Action = 'port' | 'starboard' | 'trim' | 'ease' | 'centre';

const KEYS: Record<string, Action> = {
  ArrowLeft: 'port',
  KeyA: 'port',
  ArrowRight: 'starboard',
  KeyD: 'starboard',
  KeyW: 'trim',
  KeyS: 'ease',
  KeyC: 'centre',
};

export class KeyInput {
  readonly #held = { port: false, starboard: false, trim: false, ease: false };
  readonly #helm: HelmInput;
  readonly #sheet: SheetInput;

  constructor(helm: HelmInput, sheet: SheetInput) {
    this.#helm = helm;
    this.#sheet = sheet;
  }

  /** A key went down; returns whether it is one of the game's. */
  down(code: string): boolean {
    const a = KEYS[code];
    if (a === undefined) {
      return false;
    }
    if (a === 'centre') {
      this.#helm.centre();
    } else {
      this.#held[a] = true;
    }
    return true;
  }

  /** A key came up; returns whether it is one of the game's. */
  up(code: string): boolean {
    const a = KEYS[code];
    if (a === undefined) {
      return false;
    }
    if (a !== 'centre') {
      const steering = this.steering;
      this.#held[a] = false;
      if (steering && !this.steering && this.#helm.centreOnRelease) {
        this.#helm.centre();
      }
    }
    return true;
  }

  /** Lets go of every key (the page lost focus). */
  release(): void {
    for (const code of ['ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS']) {
      this.up(code);
    }
  }

  /** Whether a steering key is held. */
  get steering(): boolean {
    return this.#held.port || this.#held.starboard;
  }

  /** Moves the targets for dt seconds of the keys held. */
  update(dt: number): void {
    const h = this.#held;
    const turn = (h.starboard ? 1 : 0) - (h.port ? 1 : 0);
    if (turn !== 0) {
      this.#helm.target = clamp(this.#helm.target + (turn * 2 * dt) / HELM_KEY_TIME, -1, 1);
    }
    const sheet = (h.ease ? 1 : 0) - (h.trim ? 1 : 0);
    if (sheet !== 0) {
      this.#sheet.target = clamp(this.#sheet.target + (sheet * dt) / SHEET_KEY_TIME, 0, 1);
    }
  }
}

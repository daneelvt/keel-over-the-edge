// SPDX-License-Identifier: AGPL-3.0-only

// The keyboard. Keys are on or off, so a held key moves a control's target
// at a steady rate, which gives the same fine control a thumb has: the left
// and right arrows (or A and D) move the helm, W hauls the sheet in and S
// eases it. C centres the helm. The helm's keys take the helm back from the
// autopilot. P switches the autopilot on or off; Q and E turn what it holds
// a degree to port or starboard, ten with Shift; T tacks, G gybes. Keys are
// read by their place on the keyboard (KeyboardEvent.code), whatever its
// layout.

import type { HelmInput } from './helm';
import { clamp } from './helm';
import type { PilotActions } from './pilot';
import type { SheetInput } from './sheet';

/** Seconds for a held key to move the helm over its full travel. */
export const HELM_KEY_TIME = 0.6;
/** Seconds for a held key to move the sheet over its whole range. */
export const SHEET_KEY_TIME = 2;

/** Degrees Q and E turn the autopilot's target, and with Shift. */
export const PILOT_STEP = 1;
export const PILOT_BIG_STEP = 10;

type Action =
  | 'port'
  | 'starboard'
  | 'trim'
  | 'ease'
  | 'centre'
  | 'pilot'
  | 'pilotPort'
  | 'pilotStarboard'
  | 'tack'
  | 'gybe';

const KEYS: Record<string, Action> = {
  ArrowLeft: 'port',
  KeyA: 'port',
  ArrowRight: 'starboard',
  KeyD: 'starboard',
  KeyW: 'trim',
  KeyS: 'ease',
  KeyC: 'centre',
  KeyP: 'pilot',
  KeyQ: 'pilotPort',
  KeyE: 'pilotStarboard',
  KeyT: 'tack',
  KeyG: 'gybe',
};

export class KeyInput {
  readonly #held = { port: false, starboard: false, trim: false, ease: false };
  readonly #helm: HelmInput;
  readonly #sheet: SheetInput;
  readonly #pilot: PilotActions | null;

  constructor(helm: HelmInput, sheet: SheetInput, pilot: PilotActions | null = null) {
    this.#helm = helm;
    this.#sheet = sheet;
    this.#pilot = pilot;
  }

  /** A key went down, with Shift or not; returns whether it is one of the game's. */
  down(code: string, shift = false): boolean {
    const a = KEYS[code];
    if (a === undefined) {
      return false;
    }
    const p = this.#pilot;
    const step = shift ? PILOT_BIG_STEP : PILOT_STEP;
    switch (a) {
      case 'centre':
        this.#helm.take();
        this.#helm.centre();
        break;
      case 'port':
      case 'starboard':
        if (!this.#held[a]) {
          this.#helm.take();
        }
        this.#held[a] = true;
        break;
      case 'trim':
      case 'ease':
        this.#held[a] = true;
        break;
      case 'pilot':
        p?.togglePilot();
        break;
      case 'pilotPort':
        p?.pilotAdjust(-step);
        break;
      case 'pilotStarboard':
        p?.pilotAdjust(step);
        break;
      case 'tack':
        p?.pilotTack();
        break;
      case 'gybe':
        p?.pilotGybe();
        break;
    }
    return true;
  }

  /** A key came up; returns whether it is one of the game's. */
  up(code: string): boolean {
    const a = KEYS[code];
    if (a === undefined) {
      return false;
    }
    if (a === 'port' || a === 'starboard' || a === 'trim' || a === 'ease') {
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

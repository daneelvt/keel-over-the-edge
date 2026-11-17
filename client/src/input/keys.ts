// SPDX-License-Identifier: AGPL-3.0-only

// The keyboard. Keys are on or off, so a held key moves a control's target
// at a steady rate, which gives the same fine control a thumb has: the left
// and right arrows (or A and D) move the helm, W hauls the sheet in and S
// eases it. C centres the helm. The helm's keys take the helm back from the
// autopilot. P switches the autopilot on or off; Q and E turn what it holds
// a degree to port or starboard, ten with Shift; T tacks, G gybes. R takes
// one more reef, F shakes one out, as Shift and R do where F flies the free
// camera. Keys are read by their place on the keyboard (KeyboardEvent.code),
// whatever its layout.
//
// A slider with the focus answers its own arrows, as a slider should: on
// the helm ← and → steer; on the sheet ← and ↓ ease it, → and ↑ trim it,
// and Page Up and Page Down trim and ease it a tenth at a time. The other
// keys do as they do anywhere.

import type { HelmInput } from './helm';
import { clamp } from './helm';
import type { PilotActions } from './pilot';
import type { ReefInput } from './reef';
import type { SheetInput } from './sheet';

/** Seconds for a held key to move the helm over its full travel. */
export const HELM_KEY_TIME = 0.6;
/** Seconds for a held key to move the sheet over its whole range. */
export const SHEET_KEY_TIME = 2;

/** How far Page Up and Page Down move the sheet, of its whole range. */
export const SHEET_PAGE_STEP = 0.1;

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
  | 'gybe'
  | 'reefIn'
  | 'shakeOut';

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
  KeyR: 'reefIn',
  KeyF: 'shakeOut',
};

/** Where the keys go: the page (or the scene), or the helm or the sheet with the focus. */
export type KeyFocus = 'page' | 'helm' | 'sheet';

/** The arrows on a focused slider: the helm's steer, the sheet's ease and trim. */
const ON_HELM: Record<string, Action> = { ArrowLeft: 'port', ArrowRight: 'starboard' };
const ON_SHEET: Record<string, Action> = {
  ArrowLeft: 'ease',
  ArrowDown: 'ease',
  ArrowRight: 'trim',
  ArrowUp: 'trim',
};

/** The action of a key where the focus is. */
function actionOf(code: string, on: KeyFocus): Action | undefined {
  if (on === 'helm') {
    return ON_HELM[code] ?? KEYS[code];
  }
  if (on === 'sheet') {
    return ON_SHEET[code] ?? KEYS[code];
  }
  return KEYS[code];
}

type Held = 'port' | 'starboard' | 'trim' | 'ease';

export class KeyInput {
  readonly #held = { port: false, starboard: false, trim: false, ease: false };
  /** What each key held down does, as it did where the focus was when it went down. */
  readonly #holding = new Map<string, Held>();
  readonly #helm: HelmInput;
  readonly #sheet: SheetInput;
  readonly #pilot: PilotActions | null;
  readonly #reef: ReefInput | null;

  constructor(
    helm: HelmInput,
    sheet: SheetInput,
    pilot: PilotActions | null = null,
    reef: ReefInput | null = null,
  ) {
    this.#helm = helm;
    this.#sheet = sheet;
    this.#pilot = pilot;
    this.#reef = reef;
  }

  /** A key went down, with Shift or not, the focus on on; returns whether it is one of the game's. */
  down(code: string, shift = false, on: KeyFocus = 'page'): boolean {
    if (on === 'sheet' && (code === 'PageUp' || code === 'PageDown')) {
      const s = this.#sheet;
      s.take();
      const step = code === 'PageUp' ? -SHEET_PAGE_STEP : SHEET_PAGE_STEP;
      s.target = clamp(s.target + step, 0, 1);
      return true;
    }
    const a = actionOf(code, on);
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
        this.#holding.set(code, a);
        break;
      case 'trim':
      case 'ease':
        if (!this.#held[a]) {
          this.#sheet.take();
        }
        this.#held[a] = true;
        this.#holding.set(code, a);
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
      case 'reefIn':
        if (shift) {
          this.#reef?.shakeOut();
        } else {
          this.#reef?.reef();
        }
        break;
      case 'shakeOut':
        this.#reef?.shakeOut();
        break;
    }
    return true;
  }

  /** A key came up; returns whether it is one of the game's. */
  up(code: string): boolean {
    const a = this.#holding.get(code) ?? KEYS[code];
    this.#holding.delete(code);
    if (a === undefined) {
      return false;
    }
    if (a === 'port' || a === 'starboard' || a === 'trim' || a === 'ease') {
      this.#let(a);
    }
    return true;
  }

  /** Lets go of what a key held. */
  #let(a: Held): void {
    const steering = this.steering;
    this.#held[a] = false;
    if (steering && !this.steering && this.#helm.centreOnRelease) {
      this.#helm.centre();
    }
  }

  /** Lets go of every key (the page lost focus). */
  release(): void {
    this.#holding.clear();
    for (const a of ['port', 'starboard', 'trim', 'ease'] as const) {
      this.#let(a);
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

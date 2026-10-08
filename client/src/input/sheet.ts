// SPDX-License-Identifier: AGPL-3.0-only

// The sheet under a thumb: a vertical slider, trimmed (hauled in) at the
// top and eased (let fly) at the bottom. A drag moves it relative to where
// the thumb lands, and the sheet stays where it is left.

import { clamp, Drag } from './helm';

/** A drag of this many CSS pixels moves the sheet from hauled in to let fly. */
export const SHEET_TRAVEL = 160;

export class SheetInput {
  /** The sheet the player asks for, 0 hauled in … 1 let fly. */
  target = 0.5;

  readonly #drag = new Drag();

  get held(): boolean {
    return this.#drag.pointer !== null;
  }

  /** A pointer lands at y, in CSS pixels down the screen. Returns whether the sheet took it. */
  down(pointer: number, y: number, t: number): boolean {
    if (this.#drag.pointer !== null) {
      return false;
    }
    this.#drag.begin(pointer, y, this.target, t);
    return true;
  }

  /** Dragging down eases the sheet. */
  move(pointer: number, y: number): void {
    if (pointer !== this.#drag.pointer) {
      return;
    }
    this.target = clamp(this.#drag.value(y, 1 / SHEET_TRAVEL), 0, 1);
  }

  up(pointer: number, t: number): void {
    if (pointer === this.#drag.pointer) {
      this.#drag.end(t);
    }
  }
}

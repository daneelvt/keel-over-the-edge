// SPDX-License-Identifier: AGPL-3.0-only

// A player's look changed from their own panel, before setting sail: at
// Port Royal, since every voyage starts in its roads. The panel opens the
// picker from the look the player has, the stage drawing it; Save keeps the
// look chosen (POST /api/sailor/look), Cancel goes back to the one they
// had. A sailor made before looks were chosen is shown the picker once, at
// their next entry, from the look the game drew for them: Keep keeps that
// one, Choose the one picked; either is their choice from then on.

import { type Signal, signal } from '@preact/signals';
import { type Look, type Looks, lookFrom } from '../catalog/looks';
import type { LookStage } from './lookstage';
import type { Fetch, Me } from './me';
import { chosen, type PickerState, shuffled, undone } from './picker';

/** What the panel shows: the look kept, or the picker; and the picker for the first choice. */
export type ChooserMode = 'shown' | 'picking' | 'once';

/** Why a look was not kept, in words. */
export const LOOK_AWAY = 'Only at Port Royal: change your look before you sail, or in its harbour.';
export const LOOK_FAILED = 'Your look was not kept: try again.';

export class LookChooser {
  readonly mode: Signal<ChooserMode>;
  /** The look kept. */
  readonly look: Signal<Look>;
  readonly pick: Signal<PickerState>;
  readonly problem = signal('');
  readonly busy = signal(false);
  /** Whether the look kept was chosen: false until a sailor made before looks were chosen chooses. */
  chosen: boolean;

  constructor(
    readonly looks: Looks,
    me: Me,
    readonly stage?: LookStage,
    readonly fetcher: Fetch = fetch,
    readonly random: () => number = Math.random,
  ) {
    const l = lookFrom(me);
    this.look = signal(l);
    this.pick = signal(chosen(l));
    this.chosen = me.lookChosen !== false;
    this.mode = signal(this.chosen ? 'shown' : 'once');
    if (!this.chosen) {
      stage?.show(l);
    }
  }

  /** The player's account with the look kept. */
  applied(me: Me): Me {
    return { ...me, ...this.look.value, lookChosen: this.chosen };
  }

  /** Opens the picker from the look kept. */
  open(): void {
    this.problem.value = '';
    this.pick.value = chosen(this.look.value);
    this.mode.value = 'picking';
    this.stage?.show(this.look.value);
  }

  #set(p: PickerState): void {
    this.pick.value = p;
    this.problem.value = '';
    this.stage?.show(p.look);
  }

  choose(l: Look): void {
    this.#set(chosen(l));
  }

  shuffle(): void {
    this.#set(shuffled(this.looks, this.pick.value, this.random));
  }

  undo(): void {
    this.#set(undone(this.pick.value));
  }

  /** Back to the look kept, the picker closed. */
  cancel(): void {
    this.problem.value = '';
    this.mode.value = 'shown';
    this.stage?.hide();
  }

  /** Keeps the look picked; for a first choice, Keep keeps the look drawn. */
  async save(l: Look = this.pick.value.look): Promise<boolean> {
    if (this.busy.value) {
      return false;
    }
    this.busy.value = true;
    this.problem.value = '';
    try {
      const res = await this.fetcher('/api/sailor/look', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(l),
      });
      if (res.status === 409) {
        this.problem.value = LOOK_AWAY;
        return false;
      }
      if (res.status !== 200) {
        this.problem.value = LOOK_FAILED;
        return false;
      }
      this.look.value = l;
      this.chosen = true;
      this.mode.value = 'shown';
      this.stage?.hide();
      return true;
    } catch {
      this.problem.value = LOOK_FAILED;
      return false;
    } finally {
      this.busy.value = false;
    }
  }
}

// SPDX-License-Identifier: AGPL-3.0-only

// A boat still in the water, on the start screen: in its grace after the
// page closed, or sailing on another screen. Set sail sails it on where it
// lies; every other way off the screen that would take it out (a change of
// boat or of look saved, a watch, Start again at Port Royal) first asks
// whether to, and on Take it out the server takes it out of the water at
// once (POST /api/me/ashore), and then what was asked for goes ahead. Keep
// it goes back to the screen as it was. In the game's first download, with
// the player's own panel.

import { type Signal, signal } from '@preact/signals';
import { modalRef } from '../ui/modal';
import {
  KEEP_IT,
  NOT_TAKEN_OUT,
  TAKE_IT_OUT,
  TAKE_OUT_DETAIL,
  TAKE_OUT_QUESTION,
} from '../ui/watchwords';
import type { Fetch } from './me';
import { call } from './passkeys';

/** The boat in the water, as the start screen holds it, and the question asked before it is taken out. */
export class TakeOut {
  /** Whether the boat is still in the water. */
  readonly atSea: Signal<boolean>;
  /** What waits on the question's answer; null while none is asked. */
  readonly asking = signal<(() => void) | null>(null);
  /** What must run in Take it out's tap itself, before the boat is out: the full screen, which a browser allows only there. */
  #tap: (() => void) | null = null;
  /** The boat is being taken out. */
  readonly busy = signal(false);
  /** Why it could not be, until the next try. */
  readonly problem = signal('');
  /**
   * Told once the boat is out: what else on the screen followed it in the
   * water. What waited on the answer runs once it is done, so a fleet read
   * here never lands after a boat chosen there.
   */
  out: () => void | Promise<void> = () => {};
  /**
   * The question's ref: Keep it takes the focus as it is asked, and the
   * rest of the page is inert until it is answered.
   */
  readonly modal = modalRef(() => this.keep(), { inert: true, focus: '[data-stay]' });
  readonly #fetch: Fetch;

  constructor(atSea: boolean, f: Fetch = (input, init) => fetch(input, init)) {
    this.atSea = signal(atSea);
    this.#fetch = f;
  }

  /**
   * Does act at once with no boat in the water; with one, asks first. tap,
   * if given, runs in the tap that answers, or at once with no question.
   */
  readonly guard = (act: () => void, tap?: () => void): void => {
    if (!this.atSea.value) {
      tap?.();
      act();
      return;
    }
    this.problem.value = '';
    this.#tap = tap ?? null;
    this.asking.value = act;
    this.#listen(true);
  };

  /** Keep it: nothing is done, the screen as it was. */
  keep(): void {
    this.#tap = null;
    this.asking.value = null;
    this.problem.value = '';
    this.#listen(false);
  }

  /** Escape is Keep it while the question is asked. */
  readonly #escape = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      e.preventDefault();
      this.keep();
    }
  };

  #listen(on: boolean): void {
    if (typeof document === 'undefined') {
      return;
    }
    if (on) {
      document.addEventListener('keydown', this.#escape);
    } else {
      document.removeEventListener('keydown', this.#escape);
    }
  }

  /** Take it out: the boat out of the water, then what waited on the answer. */
  async take(): Promise<boolean> {
    const act = this.asking.value;
    if (act === null || this.busy.value) {
      return false;
    }
    this.#tap?.();
    this.#tap = null;
    this.busy.value = true;
    this.problem.value = '';
    try {
      const res = await call(this.#fetch, '/api/me/ashore');
      if (res.status !== 200) {
        this.problem.value = NOT_TAKEN_OUT;
        return false;
      }
      this.atSea.value = false;
      this.asking.value = null;
      this.#listen(false);
      await this.out();
      act();
      return true;
    } finally {
      this.busy.value = false;
    }
  }
}

/** The question before the boat is taken out of the water, in the player's panel's place. */
export function TakeOutQuestion({ out }: { out: TakeOut }) {
  const busy = out.busy.value;
  return (
    <section
      class="start-panel take-out"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="take-out-title"
      aria-describedby="take-out-detail"
      ref={out.modal}
    >
      <h1 id="take-out-title">{TAKE_OUT_QUESTION}</h1>
      <p id="take-out-detail" class="start-text">
        {TAKE_OUT_DETAIL}
      </p>
      <p class="start-problem" aria-live="polite">
        {out.problem.value}
      </p>
      <div class="choose-look-actions">
        <button
          type="button"
          class="start-sign-in"
          data-stay
          disabled={busy}
          onClick={() => out.keep()}
        >
          {KEEP_IT}
        </button>
        <button type="button" class="start-go" disabled={busy} onClick={() => void out.take()}>
          {TAKE_IT_OUT}
        </button>
      </div>
    </section>
  );
}

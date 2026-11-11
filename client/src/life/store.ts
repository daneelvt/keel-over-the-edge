// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life the page has been told of: each encounter by its id, its
// latest revision kept, until the server drops it or its end has passed.

import type { LifeSeen } from '../net/messages';

export class LifeStore {
  readonly #byId = new Map<string, LifeSeen>();
  /** Counts each change, for whoever draws from the records. */
  version = 0;

  /** The encounters told, and those to drop: 'all' lets every one go first. */
  set(life: readonly LifeSeen[], drop: readonly string[] | 'all'): void {
    if (drop === 'all') {
      this.#byId.clear();
    } else {
      for (const id of drop) {
        this.#byId.delete(id);
      }
    }
    for (const e of life) {
      const held = this.#byId.get(e.id);
      if (held === undefined || e.rev >= held.rev) {
        this.#byId.set(e.id, e);
      }
    }
    this.version++;
  }

  /** Lets go of the encounters ended by tick. */
  expire(tick: number): void {
    for (const [id, e] of this.#byId) {
      if (e.end <= tick) {
        this.#byId.delete(id);
        this.version++;
      }
    }
  }

  /** Every encounter held. */
  values(): IterableIterator<LifeSeen> {
    return this.#byId.values();
  }

  /** The encounter of an id, if held. */
  get(id: string): LifeSeen | undefined {
    return this.#byId.get(id);
  }

  get size(): number {
    return this.#byId.size;
  }
}

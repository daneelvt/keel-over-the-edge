// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat chosen from the fleet, and its look changed: on their
// own panel before setting sail, and on a port's harbour board. The fleet
// is read once it is shown; "Your boat" opens the look's chooser from the
// look the boat has, Save keeps what changed (POST /api/boat/look) and
// Cancel puts it back; "Change boat" lists the fleet's boats, and one
// chosen is the player's (POST /api/boat): for the next voyage ashore, or
// at once in a port, where it takes the place of the one in the water.
// Each answer is the fleet as it is then; a refusal is said in words,
// beside the field it is of.

import { type Signal, signal } from '@preact/signals';
import {
  type BoatCatalog,
  type BoatDraft,
  boatNameProblem,
  boatReasonText,
  changeBoatLook,
  changeOf,
  chooseBoat,
  draftOf,
  type Fleet,
  type FleetBoat,
  kindOf,
  numberProblem,
  readFleet,
  taken,
  yoursOf,
} from './fleet';
import type { Fetch } from './me';
import type { Outcome } from './passkeys';

/** What the panel shows: the boat, its look's chooser, or the fleet's boats to choose from. */
export type BoatMode = 'shown' | 'look' | 'boats';

/** The field a refusal is of, so it is marked: none, the sail number or the name. */
export type BoatField = '' | 'number' | 'name';

const NAME_REASONS = new Set(['short', 'long', 'characters', 'scripts', 'words']);

export class BoatChooser {
  /** The fleet as last read; null until it is. */
  readonly fleet: Signal<Fleet | null> = signal(null);
  /** Why the fleet could not be read, in words; "" while it is or has been. */
  readonly unread = signal('');
  readonly mode = signal<BoatMode>('shown');
  /** The look being chosen, of the boat open. */
  readonly draft = signal<BoatDraft>({ paint: '', cloth: '', number: '', name: '' });
  readonly problem = signal('');
  readonly field = signal<BoatField>('');
  readonly busy = signal(false);
  #loading: Promise<void> | null = null;

  constructor(
    readonly cat: BoatCatalog,
    readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  /** The boat the player sails, or will take on Set sail. */
  get yours(): FleetBoat | null {
    return yoursOf(this.fleet.value);
  }

  /** Reads the fleet, once at a time. */
  load(): Promise<void> {
    if (this.#loading === null) {
      this.#loading = readFleet(this.fetcher).then((res) => {
        this.#loading = null;
        if (res.ok) {
          this.fleet.value = res.value;
          this.unread.value = '';
        } else if (this.fleet.value === null) {
          this.unread.value = boatReasonText(this.cat, res.reason);
        }
      });
    }
    return this.#loading;
  }

  #clear(): void {
    this.problem.value = '';
    this.field.value = '';
  }

  /** Opens the look's chooser, from the look the player's boat has. */
  openLook(): void {
    const b = this.yours;
    if (b === null) {
      return;
    }
    this.#clear();
    this.draft.value = draftOf(b);
    this.mode.value = 'look';
  }

  /** Opens the fleet's boats to choose from. */
  openBoats(): void {
    this.#clear();
    this.mode.value = 'boats';
  }

  /** Back to the boat, nothing changed. */
  cancel(): void {
    this.#clear();
    this.mode.value = 'shown';
  }

  /** A part of the look chosen, or a field typed. */
  set(part: keyof BoatDraft, value: string): void {
    this.draft.value = { ...this.draft.value, [part]: value };
    if (this.field.value === '' || this.field.value === part) {
      this.#clear();
    }
  }

  async #send(work: () => Promise<Outcome<Fleet>>, refused: (reason: string) => void) {
    if (this.busy.value) {
      return false;
    }
    this.busy.value = true;
    this.#clear();
    try {
      const res = await work();
      if (!res.ok) {
        refused(res.reason);
        return false;
      }
      this.fleet.value = res.value;
      this.mode.value = 'shown';
      return true;
    } finally {
      this.busy.value = false;
    }
  }

  /** Chooses a boat of the fleet: the player's, for the next voyage or here in a port. */
  choose(id: string): Promise<boolean> {
    const b = this.fleet.value?.boats.find((x) => x.id === id);
    if (b !== undefined && taken(b)) {
      this.problem.value = boatReasonText(this.cat, 'taken');
      return Promise.resolve(false);
    }
    if (id === this.fleet.value?.boat) {
      this.cancel();
      return Promise.resolve(true);
    }
    return this.#send(
      () => chooseBoat(id, this.fetcher),
      (reason) => {
        this.problem.value = boatReasonText(this.cat, reason, kindOf(this.cat, b?.kind ?? ''));
      },
    );
  }

  /** Keeps the look chosen: what changed of it, checked first as the page can. */
  save(): Promise<boolean> {
    const b = this.yours;
    if (b === null) {
      return Promise.resolve(false);
    }
    const d = this.draft.value;
    const kind = kindOf(this.cat, b.kind);
    const wrong = (field: BoatField, code: string) => {
      this.field.value = field;
      this.problem.value = boatReasonText(this.cat, code, kind, d.number);
      return Promise.resolve(false);
    };
    const n = numberProblem(d.number, this.cat.boatLooks.numbers);
    if (n !== null) {
      return wrong('number', n);
    }
    const name = boatNameProblem(d.name);
    if (name !== null) {
      return wrong('name', name);
    }
    const change = changeOf(b, d);
    if (Object.keys(change).length === 1) {
      this.cancel();
      return Promise.resolve(true);
    }
    return this.#send(
      () => changeBoatLook(change, this.fetcher),
      (reason) => {
        this.field.value = reason === 'number' ? 'number' : NAME_REASONS.has(reason) ? 'name' : '';
        this.problem.value = boatReasonText(this.cat, reason, kind, d.number);
      },
    );
  }
}

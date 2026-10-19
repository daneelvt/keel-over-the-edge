// SPDX-License-Identifier: AGPL-3.0-only

// Notices: what the game tells the player of the world as it happens, a
// line that pops up and goes. One is shown at a time, the rest wait behind
// it, a few at most, and several of one kind are folded into one ("3 places
// charted"). Each stays a while unless dismissed, by its kind's level:
// active, for now, or passive, for the player's leisure (Apple's levels);
// it is a status, never an alert, and never takes the focus (WCAG 2.2,
// 4.1.3; the ARIA practices: "avoid designing alerts that disappear
// automatically", which a status that also lands in the news or on the
// chart is not). A kind may be switched off; the switches are the
// account's, so they follow the player from device to device (2.2.4).

import { signal } from '@preact/signals';

/** A kind of notice, as the catalog has it. */
export interface NoticeKind {
  id: string;
  name: string;
  on: string;
  level: string;
  switchable: boolean;
  /** How long it stays, s. */
  stays: number;
  text: string;
  folded: string;
}

/** A notice shown: its kind, its words, and when it goes, ms. */
export interface Shown {
  kind: NoticeKind;
  text: string;
  count: number;
  fill: Record<string, string>;
  until: number;
  /** Raised again since shown: its count changed. */
  serial: number;
}

/** Fills a notice's words: {name} and the rest from fill. */
export function fillText(text: string, fill: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => fill[k] ?? m);
}

export class Notices {
  /** The notice shown, or null. */
  readonly shown = signal<Shown | null>(null);
  /** The kinds switched off, by id. */
  readonly off = signal<ReadonlySet<string>>(new Set());
  /** Saves the switches: the account's, online. */
  save: ((off: string[]) => Promise<boolean>) | null = null;
  readonly kinds: readonly NoticeKind[];
  readonly #queue: Shown[] = [];
  readonly #most: number;
  #serial = 0;

  constructor(kinds: readonly NoticeKind[], queue: number) {
    this.kinds = kinds;
    this.#most = queue;
  }

  /** The kind that a happening raises, if any is on. */
  kindFor(on: string): NoticeKind | undefined {
    return this.kinds.find((k) => k.on === on);
  }

  /** Raises a notice of the kind for on, at now (ms), its words filled in; nothing if that kind is off. */
  raise(on: string, fill: Record<string, string>, now: number): void {
    const kind = this.kindFor(on);
    if (kind === undefined || this.off.value.has(kind.id)) {
      return;
    }
    const cur = this.shown.value;
    // The same kind folds into the one shown, or one waiting.
    const same = cur !== null && cur.kind === kind ? cur : this.#queue.find((q) => q.kind === kind);
    if (same !== undefined) {
      same.count++;
      same.text = fillText(kind.folded, { ...fill, count: String(same.count) });
      same.until = now + kind.stays * 1000;
      same.serial = ++this.#serial;
      if (same === cur) {
        this.shown.value = { ...same };
      }
      return;
    }
    const n: Shown = {
      kind,
      text: fillText(kind.text, fill),
      count: 1,
      fill,
      until: now + kind.stays * 1000,
      serial: ++this.#serial,
    };
    if (cur === null) {
      this.shown.value = n;
      return;
    }
    if (this.#queue.length < this.#most) {
      this.#queue.push(n);
    }
  }

  /** How many wait behind the one shown. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Dismisses the notice shown, at now: the next is shown. */
  dismiss(now: number): void {
    const next = this.#queue.shift() ?? null;
    if (next !== null) {
      next.until = now + next.kind.stays * 1000;
    }
    this.shown.value = next;
  }

  /** Lets the notice shown go once its time is up. */
  tick(now: number): void {
    const cur = this.shown.value;
    if (cur !== null && now >= cur.until) {
      this.dismiss(now);
    }
  }

  /** Switches a kind on or off, and saves the switches. */
  async set(id: string, on: boolean): Promise<boolean> {
    const off = new Set(this.off.value);
    if (on) {
      off.delete(id);
    } else {
      off.add(id);
    }
    this.off.value = off;
    return (await this.save?.([...off].sort())) ?? true;
  }
}

/** Saves the switches on the account: POST /api/me/notices. */
export async function saveNoticesOff(
  off: string[],
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetcher('/api/me/notices', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ off }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

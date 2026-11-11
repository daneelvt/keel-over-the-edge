// SPDX-License-Identifier: AGPL-3.0-only

// Messages between shipmates, as the page keeps them: a thread for each
// shipmate written to or heard from, the newest 50 lines of each, in the
// page's memory only and never in the browser's storage, forgotten on a
// reload. A message reaches a shipmate only while they are in the game,
// and nothing is kept for later, so nothing here is ever sent again. The
// player's own lines show from the moment they are sent, matched to their
// echo by the Say's id (said, or refused and taken back with why); each
// thread keeps the one note of what came of its last line.

import { computed, type ReadonlySignal, signal } from '@preact/signals';
import type { ChatRefusalTold, ChatTold } from '../net/messages';
import { type ChatLine, ECHO_WAIT, KEPT_LINES, lineOf, NOTE_STAYS } from './chatlog';

/**
 * The first id of a message's Say: the page counts its lines aboard from
 * 1, and its messages from here, so an echo names which it answers.
 */
export const FIRST_MESSAGE_ID = 0x8000_0001;

/** What came of the player's last message in a thread. */
export type ThreadNote =
  | { kind: 'refused'; why: Exclude<ChatRefusalTold, ''>; text: string; at: number }
  | { kind: 'lost'; text: string; at: number };

/** A message heard from a shipmate: whose thread, the name it came with, and the page's key for it. */
export interface Heard {
  thread: string;
  name: string;
  key: number;
}

export class ShipmateThreads {
  readonly #threads = signal<ReadonlyMap<string, readonly ChatLine[]>>(new Map());
  readonly #notes = signal<ReadonlyMap<string, ThreadNote>>(new Map());
  /** The newest message heard from a shipmate, or null before any. */
  readonly heard = signal<Heard | null>(null);
  /** Whether an own message waits for its echo. */
  readonly waiting: ReadonlySignal<boolean> = computed(() =>
    [...this.#threads.value.values()].some((t) => t.some((l) => l.pending)),
  );
  #key = 0;
  #say = FIRST_MESSAGE_ID - 1;

  /** A thread's lines, the oldest first; none for a thread never written in. */
  lines(thread: string): readonly ChatLine[] {
    return this.#threads.value.get(thread) ?? [];
  }

  /** A thread's note, or null. */
  note(thread: string): ThreadNote | null {
    return this.#notes.value.get(thread) ?? null;
  }

  /** The threads written in, by shipmate. */
  get threads(): readonly string[] {
    return [...this.#threads.value.keys()];
  }

  /**
   * An own message to a shipmate sent at now (ms of UTC) by self, shown at
   * once and waiting for its echo: the id its Say carries, and the text as
   * sent; null for nothing to send.
   */
  say(to: string, text: string, self: string, now: number): { id: number; text: string } | null {
    const t = lineOf(text);
    if (t === null || to === '') {
      return null;
    }
    this.#say = this.#say >= 0xffff_ffff ? FIRST_MESSAGE_ID : this.#say + 1;
    const id = this.#say;
    this.#setNote(to, null);
    this.#add(to, {
      key: ++this.#key,
      id: 0,
      seat: 0,
      name: self,
      machine: false,
      at: now,
      text: t,
      you: true,
      pending: true,
      echo: id,
    });
    return { id, text: t };
  }

  /** Whether the echo is one of a message's: an own message waits for it, or its id is one a message's Say carries. */
  answers(m: Pick<ChatTold, 'you' | 'echo' | 'thread'>): boolean {
    return m.thread !== '' || (m.you && m.echo >= FIRST_MESSAGE_ID);
  }

  /** A message from the server: a shipmate's, or the player's own back, said or refused. */
  receive(m: ChatTold, now: number): void {
    if (!m.you) {
      if (m.thread === '') {
        return;
      }
      this.#add(m.thread, {
        key: ++this.#key,
        id: m.id,
        seat: 0,
        name: m.name,
        machine: false,
        at: m.at || now,
        text: m.text,
        you: false,
        pending: false,
        echo: 0,
      });
      this.heard.value = { thread: m.thread, name: m.name, key: this.#key };
      return;
    }
    const found = this.#pending(m.echo);
    const thread = found?.thread ?? m.thread;
    if (thread === '') {
      return;
    }
    const lines = this.lines(thread);
    const mine = found?.line;
    if (m.refused !== '') {
      // Not sent: taken back, and why told; its words kept for the field.
      if (mine !== undefined) {
        this.#put(
          thread,
          lines.filter((l) => l !== mine),
        );
      }
      this.#setNote(thread, { kind: 'refused', why: m.refused, text: mine?.text ?? '', at: now });
      return;
    }
    if (mine !== undefined) {
      this.#put(
        thread,
        lines.map((l) =>
          l === mine
            ? {
                ...l,
                id: m.id,
                name: m.name || l.name,
                at: m.at || l.at,
                text: m.text || l.text,
                pending: false,
              }
            : l,
        ),
      );
      return;
    }
    this.#add(thread, {
      key: ++this.#key,
      id: m.id,
      seat: 0,
      name: m.name,
      machine: false,
      at: m.at || now,
      text: m.text,
      you: true,
      pending: false,
      echo: m.echo,
    });
  }

  /** At now: own messages with no echo in time are lost, and old notes go. */
  expire(now: number): void {
    for (const [thread, lines] of this.#threads.value) {
      const lost = lines.filter((l) => l.pending && now - l.at > ECHO_WAIT);
      if (lost.length > 0) {
        this.#put(
          thread,
          lines.filter((l) => !lost.includes(l)),
        );
        this.#setNote(thread, { kind: 'lost', text: lost[lost.length - 1]?.text ?? '', at: now });
      }
    }
    for (const [thread, n] of this.#notes.value) {
      if (now - n.at > NOTE_STAYS) {
        this.#setNote(thread, null);
      }
    }
  }

  /** A thread's note put away. */
  dismiss(thread: string): void {
    this.#setNote(thread, null);
  }

  /** Every thread but those of the shipmates named forgotten: no longer shipmates, nothing of theirs is kept. */
  keep(shipmates: ReadonlySet<string>): void {
    const gone = this.threads.filter((t) => !shipmates.has(t));
    if (gone.length === 0) {
      return;
    }
    const threads = new Map(this.#threads.value);
    const notes = new Map(this.#notes.value);
    for (const t of gone) {
      threads.delete(t);
      notes.delete(t);
    }
    this.#threads.value = threads;
    this.#notes.value = notes;
    if (this.heard.value !== null && gone.includes(this.heard.value.thread)) {
      this.heard.value = null;
    }
  }

  /** The own message waiting for echo, and its thread; null for none. */
  #pending(echo: number): { thread: string; line: ChatLine } | null {
    if (echo === 0) {
      return null;
    }
    for (const [thread, lines] of this.#threads.value) {
      const line = lines.find((l) => l.you && l.pending && l.echo === echo);
      if (line !== undefined) {
        return { thread, line };
      }
    }
    return null;
  }

  #setNote(thread: string, n: ThreadNote | null): void {
    if (n === null && !this.#notes.value.has(thread)) {
      return;
    }
    const notes = new Map(this.#notes.value);
    if (n === null) {
      notes.delete(thread);
    } else {
      notes.set(thread, n);
    }
    this.#notes.value = notes;
  }

  #put(thread: string, lines: readonly ChatLine[]): void {
    const threads = new Map(this.#threads.value);
    threads.set(thread, lines);
    this.#threads.value = threads;
  }

  #add(thread: string, l: ChatLine): void {
    const lines = this.lines(thread);
    this.#put(
      thread,
      lines.length >= KEPT_LINES
        ? [...lines.slice(lines.length - KEPT_LINES + 1), l]
        : [...lines, l],
    );
  }
}

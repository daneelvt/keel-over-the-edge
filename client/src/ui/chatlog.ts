// SPDX-License-Identifier: AGPL-3.0-only

// Chat aboard, as the page keeps it: the last lines said aboard the boat
// in view, in the page's memory for the voyage only and never in the
// browser's storage; the player's own lines from the moment they are sent,
// matched to their echo (said, or refused and taken back); the people the
// account mutes or blocks, whose lines are hidden at once; and the one
// note the strip shows of what came of the player's last act: a line
// refused, a mute or a block, a report.

import { computed, type ReadonlySignal, signal } from '@preact/signals';
import type { ChatRefusalTold, ChatTold, PersonTold, TiedTold } from '../net/messages';

/** How many lines are kept: the newest. */
export const KEPT_LINES = 50;

/** The longest line, in characters, as the server counts them. */
export const MAX_LINE = 200;

/** How long an own line waits for its echo before it is taken as lost, ms. */
export const ECHO_WAIT = 10_000;

/** How long a note stays, ms. */
export const NOTE_STAYS = 12_000;

/** A line in the strip. */
export interface ChatLine {
  /** The page's own key for it, unique for the page's life. */
  key: number;
  /** The server's number for it (Who.line); 0 for none: an own line not yet said, or one only its sender sees. */
  id: number;
  seat: number;
  /** The sender's name as players see it, and whether a machine sailor said it. */
  name: string;
  machine: boolean;
  /** When it was said, ms of UTC. */
  at: number;
  text: string;
  /** The player's own. */
  you: boolean;
  /** Sent, its echo not yet back. */
  pending: boolean;
  /** The id of the own line's Say. */
  echo: number;
}

/** What came of the player's last act, as the strip says it. */
export type ChatNote =
  | { kind: 'refused'; why: Exclude<ChatRefusalTold, ''>; text: string; at: number }
  | { kind: 'lost'; text: string; at: number }
  | { kind: 'tied'; name: string; muted: boolean; blocked: boolean; full: boolean; at: number }
  | { kind: 'reported'; ok: boolean; at: number };

/** The characters of a line as the server counts them: code points. */
export function lineLength(text: string): number {
  return [...text].length;
}

/** A line as it is sent: one line, trimmed; null for nothing to send or too long. */
export function lineOf(text: string): string | null {
  const t = text.replace(/[\r\n]+/g, ' ').trim();
  return t === '' || lineLength(t) > MAX_LINE ? null : t;
}

/** Whether the account mutes, and whether it blocks, a person. */
export interface TieState {
  muted: boolean;
  blocked: boolean;
}

/**
 * How the open strip fits between its top (px) and the lowest it may
 * reach, bottom: its lines' height, between min and max, and how far it
 * lifts when even min does not fit; rest is its height but the lines'.
 */
export function fitStrip(
  top: number,
  rest: number,
  bottom: number,
  min: number,
  max: number,
): { lines: number; lift: number } {
  const lines = Math.max(min, Math.min(max, bottom - top - rest));
  return { lines, lift: Math.max(0, top + rest + lines - bottom) };
}

export class ChatLog {
  readonly #lines = signal<readonly ChatLine[]>([]);
  readonly #ties = signal<ReadonlyMap<string, TieState>>(new Map());
  /** The note the strip shows, or null. */
  readonly note = signal<ChatNote | null>(null);
  /** Every line kept, the oldest first, hidden ones among them. */
  readonly all: ReadonlySignal<readonly ChatLine[]> = this.#lines;
  /** Whom the account mutes or blocks, by name, as last told or asked. */
  readonly ties: ReadonlySignal<ReadonlyMap<string, TieState>> = this.#ties;
  /** The names whose lines are hidden: muted or blocked. */
  readonly hidden: ReadonlySignal<ReadonlySet<string>> = computed(
    () =>
      new Set([...this.#ties.value].filter(([, t]) => t.muted || t.blocked).map(([name]) => name)),
  );
  /** The lines the strip shows, the oldest first: none of a muted or blocked person's. */
  readonly lines: ReadonlySignal<readonly ChatLine[]> = computed(() => {
    const hidden = this.hidden.value;
    return this.#lines.value.filter((l) => l.you || !hidden.has(l.name));
  });
  #key = 0;
  #say = 0;

  /**
   * An own line sent at now (ms of UTC) by self, shown at once and waiting
   * for its echo: the id its Say carries, and the text as sent; null for
   * nothing to send.
   */
  say(text: string, self: string, now: number): { id: number; text: string } | null {
    const t = lineOf(text);
    if (t === null) {
      return null;
    }
    // The Say's id is a uint32 the page counts; 0 is no echo.
    this.#say = (this.#say % 0xffff_ffff) + 1;
    const id = this.#say;
    this.note.value = null;
    this.#add({
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

  /** A line from the server: another's, or the player's own back, said or refused. */
  receive(m: ChatTold, now: number): void {
    if (!m.you) {
      this.#add({
        key: ++this.#key,
        id: m.id,
        seat: m.seat,
        name: m.name,
        machine: m.machine,
        at: m.at || now,
        text: m.text,
        you: false,
        pending: false,
        echo: 0,
      });
      return;
    }
    const lines = this.#lines.value;
    const mine = lines.find((l) => l.you && l.pending && l.echo === m.echo && m.echo !== 0);
    if (m.refused !== '') {
      // Not said: taken back, and why told; its words kept for the field.
      if (mine !== undefined) {
        this.#lines.value = lines.filter((l) => l !== mine);
      }
      this.note.value = { kind: 'refused', why: m.refused, text: mine?.text ?? '', at: now };
      return;
    }
    // Said, or refused for a word, which looks the same to its sender.
    if (mine !== undefined) {
      this.#lines.value = lines.map((l) =>
        l === mine
          ? {
              ...l,
              id: m.id,
              seat: m.seat,
              name: m.name || l.name,
              machine: m.machine,
              at: m.at || l.at,
              text: m.text || l.text,
              pending: false,
            }
          : l,
      );
      return;
    }
    this.#add({
      key: ++this.#key,
      id: m.id,
      seat: m.seat,
      name: m.name,
      machine: m.machine,
      at: m.at || now,
      text: m.text,
      you: true,
      pending: false,
      echo: m.echo,
    });
  }

  /** How the account stands to a person: muted, blocked, neither. */
  tieOf(name: string): TieState {
    return this.#ties.value.get(name) ?? { muted: false, blocked: false };
  }

  /** A mute or a block asked for, or ended: a muted or blocked person's lines hidden at once. */
  tie(name: string, kind: 'mute' | 'block', on: boolean): void {
    const t = this.tieOf(name);
    this.#set(name, kind === 'mute' ? { ...t, muted: on } : { ...t, blocked: on });
  }

  /** A mute or a block as the server has it now. */
  tied(t: TiedTold, now: number): void {
    if (!t.full) {
      this.#set(t.name, { muted: t.muted, blocked: t.blocked });
    }
    this.note.value = { kind: 'tied', ...t, at: now };
  }

  /** Who is aboard, as the server tells it: whom the account mutes or blocks among them. */
  crew(people: readonly PersonTold[]): void {
    for (const p of people) {
      if (!p.you) {
        this.#set(p.name, { muted: p.muted, blocked: p.blocked });
      }
    }
  }

  #set(name: string, t: TieState): void {
    const was = this.tieOf(name);
    if (name === '' || (was.muted === t.muted && was.blocked === t.blocked)) {
      return;
    }
    const next = new Map(this.#ties.value);
    if (t.muted || t.blocked) {
      next.set(name, t);
    } else {
      next.delete(name);
    }
    this.#ties.value = next;
  }

  /** A report received, or not kept. */
  reported(ok: boolean, now: number): void {
    this.note.value = { kind: 'reported', ok, at: now };
  }

  /** At now: own lines with no echo in time are lost, and an old note goes. */
  expire(now: number): void {
    const lines = this.#lines.value;
    const lost = lines.filter((l) => l.pending && now - l.at > ECHO_WAIT);
    if (lost.length > 0) {
      this.#lines.value = lines.filter((l) => !lost.includes(l));
      this.note.value = { kind: 'lost', text: lost[lost.length - 1]?.text ?? '', at: now };
      return;
    }
    const n = this.note.value;
    if (n !== null && now - n.at > NOTE_STAYS) {
      this.note.value = null;
    }
  }

  /** Whether an own line waits for its echo. */
  get waiting(): boolean {
    return this.#lines.value.some((l) => l.pending);
  }

  /** The note put away. */
  dismiss(): void {
    this.note.value = null;
  }

  /** A new voyage: every line forgotten, the note too. Mutes and blocks stand. */
  clear(): void {
    this.#lines.value = [];
    this.note.value = null;
  }

  #add(l: ChatLine): void {
    const lines = this.#lines.value;
    this.#lines.value =
      lines.length >= KEPT_LINES
        ? [...lines.slice(lines.length - KEPT_LINES + 1), l]
        : [...lines, l];
  }
}

// SPDX-License-Identifier: AGPL-3.0-only

// The account's side of chat, as the server answers it: its own switch
// (and whether turning it on shows the card first), its mutes and blocks
// with an end to each, and the statements of reasons the game's owner sent
// it, each read and answered once. Saying, muting, blocking and reporting
// aboard are the game connection's.

import type { Fetch } from './me';
import { call, reasonOf } from './passkeys';

/** GET /api/me/chat: whether chat is on, whether turning it on shows the card first, the Rules still to accept, the age question answered. */
export interface ChatSetting {
  on: boolean;
  card: boolean;
  rules: boolean;
  asked: boolean;
}

/** A mute or a block on the account's list. */
export interface Tie {
  id: string;
  name: string;
  kind: 'mute' | 'block';
}

/** A statement of reasons, as its player reads it; times in ms of UTC, 0 for none. */
export interface Statement {
  id: string;
  made: number;
  action: string;
  rule: string;
  seen: string;
  until: number;
  read: boolean;
  answer: string;
  answered: number;
}

/** The server's side; tests and the sandbox's scenes stand in for it. */
export interface ChatServer {
  /** The server itself, for the questions asked first (the age question, the Rules of the sea). */
  fetch: Fetch;
  /** The account's chat, or null when it could not be read. */
  read(): Promise<ChatSetting | null>;
  /** Turns the account's own chat on or off: 'ok', or the server's reason ('first': the age question first). */
  set(on: boolean): Promise<string>;
  ties(): Promise<Tie[] | null>;
  untie(t: Tie): Promise<boolean>;
  statements(): Promise<Statement[] | null>;
  markRead(id: string): Promise<boolean>;
  /** The one answer to a statement: 'ok', or the server's reason ('answered'). */
  answer(id: string, text: string): Promise<string>;
}

function msOf(t: unknown): number {
  const ms = typeof t === 'string' && t !== '' ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function get(f: Fetch, path: string): Promise<unknown> {
  try {
    const res = await f(path, { cache: 'no-store', credentials: 'same-origin' });
    return res.status === 200 ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The account's chat routes, as the server answers them. */
export function chatServer(f: Fetch = (input, init) => fetch(input, init)): ChatServer {
  return {
    fetch: f,
    async read() {
      const b = (await get(f, '/api/me/chat')) as Record<string, unknown> | null;
      if (b === null || typeof b !== 'object') {
        return null;
      }
      return {
        on: b.on === true,
        card: b.card === true,
        rules: b.rules === true,
        asked: b.asked === true,
      };
    },
    async set(on) {
      const a = await call(f, '/api/me/chat', { on });
      return a.status === 204 ? 'ok' : reasonOf(a);
    },
    async ties() {
      const b = await get(f, '/api/me/ties');
      if (!Array.isArray(b)) {
        return null;
      }
      return b
        .filter((t) => t !== null && typeof t === 'object')
        .map((t: Record<string, unknown>) => ({
          id: text(t.id),
          name: text(t.name),
          kind: t.kind === 'block' ? ('block' as const) : ('mute' as const),
        }))
        .filter((t) => t.id !== '');
    },
    async untie(t) {
      return (await call(f, '/api/me/ties/end', { id: t.id, kind: t.kind })).status === 204;
    },
    async statements() {
      const b = await get(f, '/api/me/statements');
      if (!Array.isArray(b)) {
        return null;
      }
      return b
        .filter((s) => s !== null && typeof s === 'object')
        .map((s: Record<string, unknown>) => ({
          id: text(s.id),
          made: msOf(s.made),
          action: text(s.action),
          rule: text(s.rule),
          seen: text(s.seen),
          until: msOf(s.until),
          read: s.read === true,
          answer: text(s.answer),
          answered: msOf(s.answered),
        }))
        .filter((s) => s.id !== '');
    },
    async markRead(id) {
      return (await call(f, '/api/me/statements/read', { id })).status === 204;
    },
    async answer(id, answer) {
      const a = await call(f, '/api/me/statements/answer', { id, answer });
      return a.status === 204 ? 'ok' : reasonOf(a);
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-only

// Statements of reasons: what the game's owner did about something a
// player said aboard, and why, each read once and answered once. Asked
// for as the player comes to sea; one unread shows a line under the case
// until it is read. The line and the statement's window (statements.tsx)
// are loaded only when one waits: the game's first download holds neither.

import { type Signal, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { type ChatServer, chatServer, type Statement } from '../account/chatapi';

/** The statements as the screen sees them. */
export interface StatementsView {
  /** The unread statements, the oldest first. */
  waiting: Signal<readonly Statement[]>;
  /** The statement open in its window, or null. */
  open: Signal<Statement | null>;
  server: ChatServer;
}

export function statementsOf(server: ChatServer = chatServer()): StatementsView {
  return { waiting: signal([]), open: signal(null), server };
}

/** Asks for the account's statements: the unread ones wait to be read. */
export async function checkStatements(v: StatementsView): Promise<void> {
  const all = await v.server.statements();
  if (all !== null) {
    v.waiting.value = all.filter((s) => !s.read).sort((a, b) => a.made - b.made);
  }
}

/** Whether any part of the statements is on the screen. */
export function statementsShown(v: StatementsView): boolean {
  return v.waiting.value.length > 0 || v.open.value !== null;
}

type Statements = typeof import('./statements');

let loading: Promise<Statements> | null = null;

/** The statements' module, loaded once; tried again after a failure. */
export function loadStatements(): Promise<Statements> {
  if (loading === null) {
    loading = import('./statements').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The statements' module once loaded, or null until then; nothing is loaded until need. */
export function useStatements(need: boolean): Statements | null {
  const [m, setM] = useState<Statements | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadStatements().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Not shown: asked for again when next needed.
      },
    );
    return () => {
      live = false;
    };
  }, [need, m]);
  return m;
}

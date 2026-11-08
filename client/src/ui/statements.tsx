// SPDX-License-Identifier: AGPL-3.0-only

// A statement of reasons from the game's owner: a line under the case
// while one waits unread, and its window: what the owner did, the rule,
// what was seen, and the player's one answer, of 500 characters at most.
// Closed, it is marked read; Later leaves it for the next time at sea.

import './deck.css';
import './chat.css';
import { useLayoutEffect, useState } from 'preact/hooks';
import type { Statement } from '../account/chatapi';
import { reasonText } from '../account/reasons';
import { lineLength } from './chatlog';
import {
  ANSWER_SENT,
  ASK_AGAIN,
  actionText,
  CLOSE,
  LATER,
  leftText,
  MAX_ANSWER,
  READ_IT,
  SEND_ANSWER,
  STATEMENT_TITLE,
  STATEMENT_WAITING,
  THE_RULE,
  WHAT_WAS_SEEN,
  YOUR_ANSWER,
} from './chatwords';
import type { StatementsView } from './statementlazy';

/** The day a statement was made: "9 November 2026". */
export function dayText(ms: number, zone?: string): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: zone,
  });
}

/** The line under the case while a statement waits unread. */
export function StatementLine({ view }: { view: StatementsView }) {
  const s = view.waiting.value[0];
  if (s === undefined || view.open.value !== null) {
    return null;
  }
  return (
    <section class="panel deck-line statement-line" role="status">
      <span class="deck-line-words">{STATEMENT_WAITING}</span>
      <button
        type="button"
        class="plate-key key-main"
        onClick={() => {
          view.open.value = s;
        }}
      >
        {READ_IT}
      </button>
    </section>
  );
}

/** A statement's window: what was done and why, and the one answer. */
export function StatementWindow({
  view,
  now = Date.now(),
}: {
  view: StatementsView;
  now?: number;
}) {
  const s = view.open.value;
  const [answer, setAnswer] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const later = () => {
    view.open.value = null;
  };
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        later();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  if (s === null) {
    return null;
  }
  const settle = (st: Statement) => {
    view.waiting.value = view.waiting.value.filter((w) => w.id !== st.id);
  };
  const close = () => {
    void view.server.markRead(s.id);
    settle(s);
    view.open.value = null;
  };
  const used = lineLength(answer.trim());
  const send = async (e: Event) => {
    e.preventDefault();
    if (busy || used === 0 || used > MAX_ANSWER) {
      return;
    }
    setBusy(true);
    setProblem('');
    const r = await view.server.answer(s.id, answer.trim());
    setBusy(false);
    if (r === 'ok' || r === 'answered') {
      const done: Statement =
        r === 'ok' ? { ...s, answer: answer.trim(), answered: Date.now(), read: true } : s;
      void view.server.markRead(s.id);
      settle(s);
      view.open.value = done;
      if (r === 'answered') {
        setProblem(reasonText('answered'));
      }
    } else {
      setProblem(reasonText(r));
    }
  };
  const answered = s.answered > 0 || s.answer !== '';
  return (
    <section
      class="panel deck-window statement-window"
      role="dialog"
      aria-labelledby="statement-title"
    >
      <h2 id="statement-title">{STATEMENT_TITLE}</h2>
      {s.made > 0 ? <p class="deck-faint">{dayText(s.made)}</p> : null}
      <p>{actionText(s.action, s.until, now)}</p>
      <dl class="statement-facts">
        {s.rule !== '' ? (
          <>
            <dt>{THE_RULE}</dt>
            <dd>{s.rule}</dd>
          </>
        ) : null}
        {s.seen !== '' ? (
          <>
            <dt>{WHAT_WAS_SEEN}</dt>
            <dd>
              <bdi class="player-text">{s.seen}</bdi>
            </dd>
          </>
        ) : null}
        {answered ? (
          <>
            <dt>{YOUR_ANSWER}</dt>
            <dd>
              <bdi class="player-text">{s.answer}</bdi>
            </dd>
          </>
        ) : null}
      </dl>
      {answered ? (
        <p class="deck-faint">{ANSWER_SENT}</p>
      ) : (
        <form class="statement-answer" onSubmit={(e) => void send(e)}>
          <label>
            <span>{ASK_AGAIN}</span>
            <textarea
              name="statement-answer"
              rows={3}
              maxLength={MAX_ANSWER * 2}
              value={answer}
              onInput={(e) => setAnswer(e.currentTarget.value)}
            />
          </label>
          <span class="deck-faint">{leftText(used, MAX_ANSWER)}</span>
          <div class="deck-keys">
            <button
              type="submit"
              class="plate-key key-main"
              disabled={busy || used === 0 || used > MAX_ANSWER}
            >
              {SEND_ANSWER}
            </button>
          </div>
        </form>
      )}
      <p class="deck-problem" aria-live="polite">
        {problem}
      </p>
      <div class="deck-keys deck-list-foot">
        {answered ? null : (
          <button type="button" class="plate-key" onClick={later}>
            {LATER}
          </button>
        )}
        <button type="button" class="plate-key" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

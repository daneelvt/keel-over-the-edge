// SPDX-License-Identifier: AGPL-3.0-only

// Turning chat on: the age question first if it was never answered; for a
// player of 13 to 17, the card that says who can talk to them, how to mute,
// block and report, and that nobody needs their contact details, with a
// key to turn chat on and one to keep it off; for anyone older, chat on at
// once. In the start screen's panel, over the sea or in the account page.
// Nothing here ever shows an age: the server says only whether the card
// is to be shown.

import './start.css';
import './firstasks.css';
import { useEffect, useState } from 'preact/hooks';
import {
  CARD_LINES,
  CARD_TITLE,
  CLOSE,
  KEEP_IT_OFF,
  PRIVACY_PAGE,
  PRIVACY_TITLE,
  TURN_CHAT_ON,
} from '../ui/chatwords';
import type { ChatServer } from './chatapi';
import { AgeQuestion, CantSail, RulesLinks } from './firstasks';
import { reasonText } from './reasons';

/** The card a player of 13 to 17 reads before turning chat on. */
export function ChatCard({
  busy,
  problem,
  turnOn,
  keepOff,
}: {
  busy: boolean;
  problem: string;
  turnOn: () => void;
  keepOff: () => void;
}) {
  return (
    <section class="start-panel first-ask chat-card" aria-labelledby="chat-card-title">
      <h2 id="chat-card-title">{CARD_TITLE}</h2>
      <ul class="rules-lines">
        {CARD_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <RulesLinks />
      <p class="start-text first-ask-links">
        <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
          {PRIVACY_TITLE}
        </a>
      </p>
      <p class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="button" class="start-go" disabled={busy} onClick={turnOn}>
        {TURN_CHAT_ON}
      </button>
      <button type="button" class="start-sign-in" disabled={busy} onClick={keepOff}>
        {KEEP_IT_OFF}
      </button>
    </section>
  );
}

type Step = 'reading' | 'age' | 'card' | 'young' | 'failed';

/**
 * Turns the account's chat on, asking what is still to be asked: done(true)
 * once it is on, done(false) when the player keeps it off or puts the
 * question off.
 */
export function ChatTurnOn({ server, done }: { server: ChatServer; done: (on: boolean) => void }) {
  const [step, setStep] = useState<Step>('reading');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const turnOn = async () => {
    setBusy(true);
    setProblem('');
    const r = await server.set(true);
    setBusy(false);
    if (r === 'ok') {
      done(true);
    } else if (r === 'first') {
      setStep('age');
    } else {
      setProblem(reasonText(r));
      setStep((s) => (s === 'reading' ? 'failed' : s));
    }
  };

  const look = async () => {
    setStep('reading');
    const c = await server.read();
    if (c === null) {
      setProblem(reasonText('unavailable'));
      setStep('failed');
    } else if (!c.asked) {
      setStep('age');
    } else if (c.card) {
      setStep('card');
    } else {
      await turnOn();
    }
  };

  useEffect(() => {
    void look();
  }, []);

  switch (step) {
    case 'age':
      return (
        <AgeQuestion
          onAnswered={() => void look()}
          onYoung={() => setStep('young')}
          onNotNow={() => done(false)}
          fetch={server.fetch}
        />
      );
    case 'young':
      return <CantSail />;
    case 'card':
      return (
        <ChatCard
          busy={busy}
          problem={problem}
          turnOn={() => void turnOn()}
          keepOff={() => done(false)}
        />
      );
    default:
      return (
        <section class="start-panel first-ask" aria-live="polite">
          <p class="start-text">{step === 'failed' ? problem : '…'}</p>
          {step === 'failed' ? (
            <button type="button" class="start-sign-in" onClick={() => done(false)}>
              {CLOSE}
            </button>
          ) : null}
        </section>
      );
  }
}

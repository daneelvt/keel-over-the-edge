// SPDX-License-Identifier: AGPL-3.0-only

// The start screen, over the loading sea: a name for the sailor, a look
// drawn at random from the catalog (drawn again on asking), and Set sail.
// The page checks only the name's length; the server applies the rest and
// says why it refuses, which is shown in words beside the field.

import './start.css';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { GuestResult } from './guest';
import { drawLook, type Look } from './looks';
import type { Me } from './me';
import { lengthProblem, MAX_NAME, reasonText } from './reasons';

export interface StartProps {
  sailors: readonly Look[];
  create: (name: string, look: string) => Promise<GuestResult>;
  done: (me: Me) => void;
  random?: () => number;
}

export function StartScreen({ sailors, create, done, random }: StartProps) {
  const [name, setName] = useState('');
  const [look, setLook] = useState(() => drawLook(sailors, null, random));
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    const tooShortOrLong = lengthProblem(name);
    if (tooShortOrLong !== null) {
      setProblem(reasonText(tooShortOrLong));
      return;
    }
    setBusy(true);
    setProblem('');
    const res = await create(name, look.id);
    setBusy(false);
    if (res.ok) {
      done(res.me);
    } else {
      setProblem(reasonText(res.reason));
    }
  };

  return (
    <div class="start">
      <form class="start-panel" onSubmit={submit} aria-labelledby="start-title" noValidate>
        <h1 id="start-title">Keel Over the Edge</h1>
        <label class="start-label" for="start-name">
          Your sailor’s name
        </label>
        <input
          id="start-name"
          class="start-name"
          name="name"
          type="text"
          autocomplete="off"
          autocapitalize="words"
          spellcheck={false}
          enterkeyhint="go"
          maxLength={MAX_NAME}
          value={name}
          aria-invalid={problem !== ''}
          aria-describedby="start-problem"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <p id="start-problem" class="start-problem" aria-live="polite">
          {problem}
        </p>
        <div class="start-look">
          <span class="start-label">Your sailor</span>
          <span class="start-look-name">{look.name}</span>
          <button
            type="button"
            class="start-shuffle"
            aria-label="Draw another sailor"
            onClick={() => setLook(drawLook(sailors, look, random))}
          >
            ⟳
          </button>
        </div>
        <button type="submit" class="start-go" disabled={busy}>
          Set sail
        </button>
      </form>
    </div>
  );
}

/** Shows the start screen in parent until a sailor is made, then removes it. */
export function showStartScreen(parent: HTMLElement, props: Omit<StartProps, 'done'>): Promise<Me> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    parent.append(root);
    const done = (me: Me) => {
      render(null, root);
      root.remove();
      resolve(me);
    };
    render(<StartScreen {...props} done={done} />, root);
    root.querySelector<HTMLInputElement>('#start-name')?.focus();
  });
}

/** A notice that the server cannot be reached, shown and hidden. */
export function backSoon(parent: HTMLElement): (shown: boolean) => void {
  let notice: HTMLElement | null = null;
  return (shown) => {
    if (shown && notice === null) {
      notice = document.createElement('p');
      notice.className = 'back-soon';
      notice.setAttribute('role', 'status');
      notice.textContent = 'Back soon: the harbour cannot be reached. Trying again…';
      parent.append(notice);
    } else if (!shown && notice !== null) {
      notice.remove();
      notice = null;
    }
  };
}

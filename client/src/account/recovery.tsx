// SPDX-License-Identifier: AGPL-3.0-only

// The recovery code: shown once, as the account is made and whenever a new
// one is, with three ways to keep it, any of which moves on. Used, it signs
// the sailor in once and asks for a new passkey, which brings a new code;
// the next sign-in is told it was used, in case it was not the player.

import { useState } from 'preact/hooks';
import type { Me } from './me';
import { addPasskey, type Reach, signOut } from './passkeys';
import { reasonText } from './reasons';

/** A date as the player reads it: 23 October, or 23 October 2025 in another year. */
export function dayOf(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** The recovery code shown once: copied, saved as a file, or written down. */
export function RecoveryCode({
  code,
  name,
  done,
  title = 'Keep your recovery code',
}: {
  code: string;
  name: string;
  done: () => void;
  title?: string;
}) {
  const [problem, setProblem] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      done();
    } catch {
      setProblem('It could not be copied here: save it as a file, or write it down.');
    }
  };
  const save = () => {
    const text = `Keel Over the Edge\nThe recovery code of ${name}:\n\n${code}\n\nIt signs ${name} in once, without a passkey. Keep it safe.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'keel-over-the-edge-recovery-code.txt';
    a.click();
    URL.revokeObjectURL(url);
    done();
  };
  return (
    <section class="start-panel" aria-labelledby="code-title">
      <h1 id="code-title">{title}</h1>
      <p class="start-text">
        If you lose your passkey, this code signs <bdi>{name}</bdi> in once, and then asks for a new
        passkey. We can’t show it again.
      </p>
      <p class="recovery-code" data-code={code}>
        {code}
      </p>
      <p class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="button" class="start-go" onClick={() => void copy()}>
        Copy
      </button>
      <button type="button" class="start-sign-in" onClick={save}>
        Save as a file
      </button>
      <button type="button" class="start-link" onClick={done}>
        I’ve written it down
      </button>
    </section>
  );
}

/** The first sign-in after the recovery code was used. */
export function RecoveredNotice({ at, done }: { at: number; done: () => void }) {
  return (
    <section class="start-panel" aria-labelledby="recovered-title">
      <h1 id="recovered-title">Your recovery code was used</h1>
      <p class="start-text">
        Your recovery code was used on {dayOf(at)} to add a passkey. If that wasn’t you, open
        Account in the menu: remove the passkeys you don’t know, make a new code, and sign out
        everywhere else.
      </p>
      <button type="button" class="start-go" onClick={done}>
        Sail on
      </button>
    </section>
  );
}

/** A session the recovery code made: a new passkey, then the new code. */
export function AddPasskey({ me, done, reach }: { me: Me; done: (me: Me) => void; reach?: Reach }) {
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  if (code !== '') {
    return (
      <RecoveryCode
        code={code}
        name={me.name}
        title="Your new recovery code"
        done={() => done({ ...me, addPasskey: false })}
      />
    );
  }
  const add = async () => {
    setBusy(true);
    setProblem('');
    const res = await addPasskey(reach);
    setBusy(false);
    if (res.ok) {
      setCode(res.value.recoveryCode);
    } else if (res.reason !== 'cancelled') {
      setProblem(reasonText(res.reason));
    }
  };
  const out = async () => {
    await signOut(reach);
    location.reload();
  };
  return (
    <section class="start-panel" aria-labelledby="add-title">
      <h1 id="add-title">Add a passkey</h1>
      <p class="start-text">
        Your recovery code signed in <bdi>{me.name}</bdi>, and is spent. Add a passkey to sail on: a
        new code comes with it.
      </p>
      <p class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="button" class="start-go" disabled={busy} onClick={() => void add()}>
        Add a passkey
      </button>
      <p class="start-text start-faint" aria-live="polite">
        {busy ? 'Your phone will ask to save a passkey for Keel Over the Edge.' : ''}
      </p>
      <button type="button" class="start-link" onClick={() => void out()}>
        Sign out
      </button>
    </section>
  );
}

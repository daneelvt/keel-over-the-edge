// SPDX-License-Identifier: AGPL-3.0-only

// The start screen, over the loading sea. A new player makes a sailor: a
// name, a look drawn at random from the catalog (drawn again on asking),
// and Set sail, which makes the sailor's passkey with the browser's own
// prompt and the account with it; then the recovery code, shown once. A
// returning player signs in beside it: the browser offers the passkeys it
// holds as the name field is touched (autofill, held open from the start),
// or "Sign in with a passkey" opens the browser's prompt, which reaches a
// passkey on another device by its QR code. "Lost your passkey?" takes the
// recovery code.
//
// The page checks only the name's length; the server applies the rest and
// says why it refuses, which is shown in words beside the field. A prompt
// the player closes says nothing and leaves the form as it was. A browser
// that cannot make a passkey is told so before anything is asked.

import './start.css';
import { type JSX, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type InApp, passkeySupport, type Support } from './inapp';
import { drawLook, type Look } from './looks';
import type { Me } from './me';
import {
  codeForm,
  makeSailor,
  type Outcome,
  publicKeyCredential,
  type Reach,
  type SignedIn,
  signIn,
  useRecoveryCode,
} from './passkeys';
import { lengthProblem, MAX_NAME, reasonText, TAKEN_SIGN_IN } from './reasons';
import { AddPasskey, RecoveredNotice, RecoveryCode } from './recovery';

export interface StartProps {
  sailors: readonly Look[];
  done: (me: Me) => void;
  random?: () => number;
  /** The server and the browser's prompt; the browser's own unless a test stands in. */
  reach?: Reach;
}

/** Whether a failed ceremony is passed over in silence: the prompt closed, or autofill turned down. */
export function quiet(reason: string, autofill: boolean): boolean {
  if (reason === 'cancelled') {
    return true;
  }
  // An autofill request the browser refuses at once (it holds no passkey
  // of ours, or offers none) is no failure of the player's; a passkey
  // chosen and refused is.
  return autofill && reason !== 'unknown-passkey' && reason !== 'refused';
}

type View =
  | { kind: 'form' }
  | { kind: 'recover' }
  | { kind: 'code'; me: Me; code: string }
  | { kind: 'recovered'; me: Me; at: number }
  | { kind: 'add-passkey'; me: Me };

export function StartScreen({ sailors, done, random, reach }: StartProps) {
  const [view, setView] = useState<View>({ kind: 'form' });
  const [support, setSupport] = useState<Support | null>(null);
  const [anyway, setAnyway] = useState(false);
  const [name, setName] = useState('');
  const [look, setLook] = useState(() => drawLook(sailors, null, random));
  const [problem, setProblem] = useState('');
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState<'' | 'create' | 'sign-in' | 'code'>('');
  const [code, setCode] = useState('');
  const autofill = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void passkeySupport({
      userAgent: navigator.userAgent,
      pkc: reach !== undefined ? reach.pkc : publicKeyCredential(),
    }).then((s) => {
      if (live) {
        setSupport(s);
      }
    });
    return () => {
      live = false;
    };
  }, [reach]);

  const signedIn = (s: SignedIn) => {
    if (s.recovered > 0) {
      setView({ kind: 'recovered', me: s.me, at: s.recovered });
    } else {
      done(s.me);
    }
  };

  const stopAutofill = () => {
    autofill.current?.abort();
    autofill.current = null;
  };

  // The browser's offer of the passkeys it holds, as the name field is
  // touched: begun as the form shows, and again after any other ceremony
  // that did not sign in; aborted before another begins, as only one runs.
  const startAutofill = () => {
    stopAutofill();
    const pkc = reach !== undefined ? reach.pkc : publicKeyCredential();
    const available = pkc?.isConditionalMediationAvailable;
    if (available === undefined) {
      return;
    }
    const ctl = new AbortController();
    autofill.current = ctl;
    void available
      .call(pkc)
      .then(async (yes) => {
        if (!yes || ctl.signal.aborted) {
          return;
        }
        const res = await signIn(true, ctl.signal, reach);
        if (ctl.signal.aborted) {
          return;
        }
        if (res.ok) {
          signedIn(res.value);
        } else if (!quiet(res.reason, true)) {
          setProblem(reasonText(res.reason));
        }
      })
      .catch(() => {
        // Autofill is offered, never relied on.
      });
  };

  const blocked = support?.kind === 'none' || (support?.kind === 'in-app' && !anyway);
  const formShown = view.kind === 'form' && support !== null && !blocked;
  useEffect(() => {
    if (formShown) {
      startAutofill();
    }
    return stopAutofill;
  }, [formShown]);

  const failed = (res: Outcome<unknown>) => {
    if (!res.ok && !quiet(res.reason, false)) {
      setProblem(reasonText(res.reason));
      setTaken(res.reason === 'taken');
    }
    startAutofill();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy !== '') {
      return;
    }
    const tooShortOrLong = lengthProblem(name);
    if (tooShortOrLong !== null) {
      setProblem(reasonText(tooShortOrLong));
      setTaken(false);
      return;
    }
    stopAutofill();
    setBusy('create');
    setProblem('');
    setTaken(false);
    const res = await makeSailor(name, look.id, reach);
    setBusy('');
    if (res.ok) {
      setView({ kind: 'code', me: res.value.me, code: res.value.recoveryCode });
    } else {
      failed(res);
    }
  };

  const signInNow = async () => {
    if (busy !== '') {
      return;
    }
    stopAutofill();
    setBusy('sign-in');
    setProblem('');
    setTaken(false);
    const res = await signIn(false, undefined, reach);
    setBusy('');
    if (res.ok) {
      signedIn(res.value);
    } else {
      failed(res);
    }
  };

  const recover = async (e: Event) => {
    e.preventDefault();
    if (busy !== '') {
      return;
    }
    setBusy('code');
    setProblem('');
    const res = await useRecoveryCode(code, reach);
    setBusy('');
    if (res.ok) {
      setView({ kind: 'add-passkey', me: res.value });
    } else {
      setProblem(reasonText(res.reason));
    }
  };

  switch (view.kind) {
    case 'code':
      return (
        <div class="start">
          <RecoveryCode code={view.code} name={view.me.name} done={() => done(view.me)} />
        </div>
      );
    case 'recovered':
      return (
        <div class="start">
          <RecoveredNotice at={view.at} done={() => done(view.me)} />
        </div>
      );
    case 'add-passkey':
      return (
        <div class="start">
          <AddPasskey me={view.me} done={done} {...(reach !== undefined ? { reach } : {})} />
        </div>
      );
    case 'recover':
      return (
        <div class="start">
          <form
            key="recover"
            class="start-panel"
            onSubmit={recover}
            aria-labelledby="start-title"
            noValidate
          >
            <h1 id="start-title">Lost your passkey?</h1>
            <p class="start-text">
              Your recovery code signs your sailor in once. Then you add a new passkey, and get a
              new code.
            </p>
            <label class="start-label" for="start-code">
              Recovery code
            </label>
            <input
              id="start-code"
              class="start-name start-code"
              name="code"
              type="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              maxLength={32}
              spellcheck={false}
              enterkeyhint="go"
              value={code}
              aria-invalid={problem !== ''}
              aria-describedby="start-problem"
              onInput={(e) => setCode(codeForm(e.currentTarget.value))}
            />
            <p id="start-problem" class="start-problem" aria-live="polite">
              {problem}
            </p>
            <button type="submit" class="start-go" disabled={busy !== ''}>
              Use the code
            </button>
            <p class="start-text start-faint">
              Without your passkey or recovery code we can’t tell the sailor is yours, so we can’t
              give it back. You can make a new sailor.
            </p>
            <button
              type="button"
              class="start-link"
              onClick={() => {
                setProblem('');
                setView({ kind: 'form' });
              }}
            >
              Back
            </button>
          </form>
        </div>
      );
  }

  if (blocked) {
    return (
      <div class="start">
        <OpenElsewhere
          app={support?.kind === 'in-app' ? support.app : null}
          tryAnyway={support?.kind === 'in-app' ? () => setAnyway(true) : null}
        />
      </div>
    );
  }

  return (
    <div class="start">
      <form
        key="start"
        class="start-panel"
        onSubmit={submit}
        aria-labelledby="start-title"
        noValidate
      >
        <h1 id="start-title">Keel Over the Edge</h1>
        {support?.kind === 'maybe' ? (
          <p class="start-warning" role="note">
            This browser may not be able to make a passkey. If Set sail fails, try your phone’s own
            browser.
          </p>
        ) : null}
        <label class="start-label" for="start-name">
          Your sailor’s name
        </label>
        <input
          id="start-name"
          class="start-name"
          name="name"
          type="text"
          autocomplete="username webauthn"
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
          {taken ? ` ${TAKEN_SIGN_IN}` : null}
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
        <button type="submit" class="start-go" disabled={busy !== ''}>
          Set sail
        </button>
        <p class="start-text start-faint" aria-live="polite">
          {busy === 'create'
            ? 'Your phone will ask to save a passkey for Keel Over the Edge.'
            : busy === 'sign-in'
              ? 'Choose your passkey.'
              : 'Your sailor is kept with a passkey: your phone’s face, fingerprint or PIN.'}
        </p>
        <div class="start-or">
          <span>Sailed before?</span>
          <button
            type="button"
            class="start-sign-in"
            disabled={busy !== ''}
            onClick={() => void signInNow()}
          >
            Sign in with a passkey
          </button>
        </div>
        <button
          type="button"
          class="start-link"
          onClick={() => {
            stopAutofill();
            setProblem('');
            setView({ kind: 'recover' });
          }}
        >
          Lost your passkey? Use your recovery code
        </button>
      </form>
    </div>
  );
}

/** A browser that cannot make the player's passkey: the game's address, to open elsewhere. */
function OpenElsewhere({ app, tryAnyway }: { app: InApp | null; tryAnyway: (() => void) | null }) {
  const [copied, setCopied] = useState(false);
  const link = location.origin;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section class="start-panel" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      {app !== null ? (
        <>
          <p class="start-text">
            Open Keel Over the Edge in your browser to make your sailor: inside{' '}
            {app.app ?? 'this app'}, passkeys don’t work.
          </p>
          <p class="start-text start-faint">{app.steps}</p>
        </>
      ) : (
        <p class="start-text">
          This browser can’t use passkeys, which keep your sailor. Open the game in your phone’s own
          browser.
        </p>
      )}
      <p class="start-text start-address">{link}</p>
      <button type="button" class="start-go" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy the link'}
      </button>
      {tryAnyway !== null ? (
        <button type="button" class="start-link" onClick={tryAnyway}>
          Try here anyway
        </button>
      ) : null}
    </section>
  );
}

function mount(parent: HTMLElement, draw: (done: (me: Me) => void) => JSX.Element): Promise<Me> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    parent.append(root);
    const done = (me: Me) => {
      render(null, root);
      root.remove();
      resolve(me);
    };
    render(draw(done), root);
  });
}

/** Shows the start screen in parent until a sailor is made or signed in, then removes it. */
export function showStartScreen(parent: HTMLElement, props: Omit<StartProps, 'done'>): Promise<Me> {
  return mount(parent, (done) => <StartScreen {...props} done={done} />);
}

/** Asks a session the recovery code made for a new passkey, then shows the new code. */
export function showAddPasskey(parent: HTMLElement, me: Me): Promise<Me> {
  return mount(parent, (done) => (
    <div class="start">
      <AddPasskey me={me} done={done} />
    </div>
  ));
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

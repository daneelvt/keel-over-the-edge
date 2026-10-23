// SPDX-License-Identifier: AGPL-3.0-only

// The account page, a panel from the menu: the account's passkeys, where
// each was made and when it was last used, with one more added on this
// device or another, or one removed while another stays; the recovery code,
// made anew; signing out, here or everywhere else; and deleting the sailor
// for good. What cannot be undone (removing a passkey, a new code,
// deleting) first asks for one of the account's own passkeys, which allows
// it for five minutes.

import './account.css';
import './start.css';
import { useEffect, useState } from 'preact/hooks';
import {
  type AccountData,
  addPasskey,
  confirmPasskey,
  deleteSailor,
  newRecoveryCode,
  type Outcome,
  type PasskeyItem,
  readAccount,
  removePasskey,
  signOut,
  signOutOthers,
} from './passkeys';
import { reasonText } from './reasons';
import { dayOf, RecoveryCode } from './recovery';

type Shown = { kind: 'page' } | { kind: 'code'; code: string } | { kind: 'delete' };

/** The account page; reload, once the sailor is signed out or deleted, takes the page to the start screen. */
export function AccountPanel({
  close,
  reload = () => location.reload(),
}: {
  close: () => void;
  reload?: () => void;
}) {
  const [data, setData] = useState<AccountData | null>(null);
  const [shown, setShown] = useState<Shown>({ kind: 'page' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  const load = async () => {
    const res = await readAccount();
    if (res.ok) {
      setData(res.value);
    } else {
      setStatus(reasonText(res.reason));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  /** Runs what cannot be undone, a passkey confirmed first unless one was lately. */
  const confirmed = async <T,>(action: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    if (data === null || data.confirmedUntil <= Date.now()) {
      setStatus('Confirm with your passkey.');
      const c = await confirmPasskey();
      if (!c.ok) {
        return c;
      }
      setData((d) => (d === null ? d : { ...d, confirmedUntil: c.value }));
    }
    return action();
  };

  const run = async <T,>(work: () => Promise<Outcome<T>>, then: (v: T) => void) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus('');
    const res = await work();
    setBusy(false);
    if (res.ok) {
      then(res.value);
    } else {
      setStatus(res.reason === 'cancelled' ? '' : reasonText(res.reason));
    }
  };

  const setPasskeys = (passkeys: PasskeyItem[]) =>
    setData((d) => (d === null ? d : { ...d, passkeys }));

  if (shown.kind === 'code') {
    return (
      <section class="panel menu account">
        <RecoveryCode
          code={shown.code}
          name={data?.name ?? ''}
          title="Your new recovery code"
          done={() => setShown({ kind: 'page' })}
        />
      </section>
    );
  }
  if (shown.kind === 'delete' && data !== null) {
    return (
      <section class="panel menu account" aria-labelledby="delete-title">
        <h2 id="delete-title">
          Delete <bdi>{data.name}</bdi> for good?
        </h2>
        <p>
          The sailor, its passkeys and its recovery code go, and its name is free for anyone. What
          it charted stays on the chart, as a former sailor’s. This cannot be undone.
        </p>
        <label class="menu-row account-name">
          <span>Type the sailor’s name</span>
          <input
            name="delete-name"
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={typed}
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </label>
        <p class="account-status" aria-live="polite">
          {status}
        </p>
        <button
          type="button"
          class="account-danger"
          disabled={busy || typed.trim() === ''}
          onClick={() => void run(() => confirmed(() => deleteSailor(typed)), reload)}
        >
          Delete this sailor
        </button>
        <button
          type="button"
          class="menu-close"
          onClick={() => {
            setStatus('');
            setShown({ kind: 'page' });
          }}
        >
          Keep it
        </button>
      </section>
    );
  }

  return (
    <section class="panel menu account" aria-label="Account">
      <h2>Account</h2>
      {data === null ? (
        <p class="account-status" aria-live="polite">
          {status || 'Reading the account…'}
        </p>
      ) : (
        <>
          <p class="menu-sailor">
            <bdi>{data.name}</bdi>, since {dayOf(data.created)}
          </p>
          <h3>Passkeys</h3>
          <ul class="account-passkeys">
            {data.passkeys.map((p) => (
              <li key={p.id}>
                <span class="account-passkey">
                  <strong>{p.madeOn}</strong>
                  {p.synced ? <span class="account-synced"> · synced</span> : null}
                  <br />
                  <span class="account-faint">
                    added {dayOf(p.created)}, last used {dayOf(p.lastUsed)}
                  </span>
                </span>
                {data.passkeys.length > 1 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => confirmed(() => removePasskey(p.id)),
                        (left) => {
                          setPasskeys(left);
                          setStatus('Passkey removed.');
                        },
                      )
                    }
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(addPasskey, (added) => {
                setPasskeys(added.passkeys);
                setStatus('Passkey added.');
              })
            }
          >
            Add a passkey
          </button>
          <p class="account-faint">On this device, on another by its QR code, or a security key.</p>
          <h3>Recovery code</h3>
          <p class="account-faint">
            {data.recoveryMade > 0
              ? `Made on ${dayOf(data.recoveryMade)}. It signs you in once, without a passkey.`
              : 'None: make one, in case you lose your passkeys.'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => confirmed(newRecoveryCode),
                (code) => {
                  setData((d) => (d === null ? d : { ...d, recoveryMade: Date.now() }));
                  setShown({ kind: 'code', code });
                },
              )
            }
          >
            Make a new code
          </button>
          <h3>Signed in</h3>
          <div class="account-row">
            <button type="button" disabled={busy} onClick={() => void run(signOut, reload)}>
              Sign out
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(signOutOthers, (n) =>
                  setStatus(
                    n === 0
                      ? 'No other device was signed in.'
                      : `Signed out on ${n} other ${n === 1 ? 'device' : 'devices'}.`,
                  ),
                )
              }
            >
              Sign out everywhere else
            </button>
          </div>
          <p class="account-status" aria-live="polite">
            {status}
          </p>
          <button
            type="button"
            class="account-danger"
            disabled={busy}
            onClick={() => {
              setStatus('');
              setTyped('');
              setShown({ kind: 'delete' });
            }}
          >
            Delete this sailor
          </button>
        </>
      )}
      <button type="button" class="menu-close" onClick={close}>
        Close
      </button>
    </section>
  );
}

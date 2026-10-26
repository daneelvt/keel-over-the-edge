// SPDX-License-Identifier: AGPL-3.0-only

// Sign-in for AI apps on the world page's Accounts tab: the token
// lifetime, which every app's grant and every connection token ends after,
// set in days, hours or minutes; first counted, then confirmed in the card
// with how many grants it ends at once, so that no stray click cuts every
// app off. How many machine sailors an account may have is set on its
// card.

import { useState } from 'preact/hooks';
import { type AccountsData, control } from './api';
import type { Act } from './lifecycle';

/** The lifetime's bounds, s, as keel holds them. */
export const MIN_LIFETIME = 60;
export const MAX_LIFETIME = 400 * 86_400;

/** The most machine sailors an account may be allowed. */
export const MAX_CAP = 50;

/** The units a lifetime is written in, s. */
const UNITS = { days: 86_400, hours: 3600, minutes: 60 } as const;
type Unit = keyof typeof UNITS;

/** A count and its noun: "1 grant", "3 grants". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A lifetime in words, the largest units first: "90 days", "1 day 6 hours", "45 seconds". */
export function lifetimeWords(seconds: number): string {
  const parts: string[] = [];
  let left = Math.max(0, Math.round(seconds));
  for (const [unit, s] of Object.entries(UNITS)) {
    const n = Math.floor(left / s);
    if (n > 0) {
      parts.push(plural(n, unit.slice(0, -1)));
      left -= n * s;
    }
  }
  if (left > 0 || parts.length === 0) {
    parts.push(plural(left, 'second'));
  }
  return parts.join(' ');
}

/** The Accounts line's part about AI apps: the machine sailors, and the grants live. */
export function machinesWords(m: NonNullable<AccountsData['machines']>): string {
  const apps = m.grants.app ?? 0;
  const tokens = m.grants.connection ?? 0;
  return (
    `${plural(m.total, 'machine sailor')}, ${m.week} made this week; grants live: ` +
    `${plural(apps, 'app')}, ${plural(tokens, 'connection token')}`
  );
}

/** What the lifetime's check answered. */
interface Checked {
  seconds: number;
  ends: number;
}

/**
 * The owner's hand on sign-in for AI apps: the token lifetime. A lifetime
 * is counted first, with check: true, and set only once the confirmation
 * naming what it ends is confirmed; one left open is closed if the figure
 * is changed.
 */
export function AISignIn({ accounts, act }: { accounts: AccountsData; act: Act }) {
  const m = accounts.machines;
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<Unit>('days');
  const [asked, setAsked] = useState<Checked | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [why, setWhy] = useState('');
  if (m === undefined) {
    return null;
  }

  const n = Number(amount);
  const seconds = amount.trim() !== '' && Number.isInteger(n) ? n * UNITS[unit] : 0;
  const outOfBounds = seconds !== 0 && (seconds < MIN_LIFETIME || seconds > MAX_LIFETIME);

  const check = (): void => {
    setChecking(true);
    setWhy('');
    setAsked(null);
    void control('lifetime', { seconds, check: true })
      .then((a) => {
        if (!a.ok) {
          setWhy(`Refused (${a.status}): ${a.text}`);
          return;
        }
        const c = JSON.parse(a.text) as Checked;
        setAsked({ seconds: c.seconds, ends: c.ends });
      })
      .catch((e: unknown) => setWhy(`Failed: ${String(e)}`))
      .finally(() => setChecking(false));
  };

  const confirm = (c: Checked): void => {
    setSending(true);
    void act(
      'lifetime',
      { seconds: c.seconds },
      `the token lifetime set to ${lifetimeWords(c.seconds)}`,
    ).then(() => {
      setSending(false);
      setAsked(null);
      setAmount('');
    });
  };

  return (
    <section class="card ai" aria-label="AI sign-in">
      <h2>AI sign-in</h2>
      <dl>
        <dt>Token lifetime</dt>
        <dd data-field="lifetime">{lifetimeWords(m.lifetime)}</dd>
      </dl>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        <input
          type="number"
          name="lifetime"
          min={1}
          step={1}
          aria-label="The token lifetime"
          value={amount}
          onInput={(e) => {
            setAmount(e.currentTarget.value);
            setAsked(null);
          }}
        />
        <select
          name="lifetime-unit"
          value={unit}
          onChange={(e) => {
            setUnit(e.currentTarget.value as Unit);
            setAsked(null);
          }}
        >
          {Object.keys(UNITS).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <button
          type="submit"
          name="set-lifetime"
          disabled={seconds === 0 || outOfBounds || checking}
        >
          Set the token lifetime
        </button>
      </form>
      {outOfBounds ? (
        <p class="small" data-field="lifetime-why">
          The lifetime is from a minute to 400 days.
        </p>
      ) : null}
      {why !== '' ? <p class="small error">{why}</p> : null}
      {asked !== null ? (
        <div class="confirm" data-field="lifetime-confirmation">
          <p>
            Set the token lifetime to {lifetimeWords(asked.seconds)}, from{' '}
            {lifetimeWords(m.lifetime)}?{' '}
            {asked.ends > 0 ? (
              <strong data-field="lifetime-ends">
                It ends {plural(asked.ends, 'grant')} at once, the apps approved and the connection
                tokens made longer ago than that: their next calls are refused.
              </strong>
            ) : (
              <span data-field="lifetime-ends">It ends no grant now.</span>
            )}
          </p>
          <button type="button" name="confirm" disabled={sending} onClick={() => confirm(asked)}>
            Confirm
          </button>{' '}
          <button type="button" name="cancel" onClick={() => setAsked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}

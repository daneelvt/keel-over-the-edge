// SPDX-License-Identifier: AGPL-3.0-only

// The questions a sailor answers once before sharing the sea: when they
// were born, for a sailor made before it was asked, and the Rules of the
// sea, before the first knock or link. Each is a panel of its own, shown on
// the start screen or over the sea. Both boxes of the age question start
// empty and every answer takes the same steps; an under-age answer is told
// only that the sailor can't sail.

import './start.css';
import './firstasks.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  AGE_ONCE,
  AGE_QUESTION,
  type Born,
  bornOf,
  bornYears,
  CANCEL,
  CANT_SAIL,
  type FirstAsk,
  GO_ON,
  KEEP_TO_THEM,
  MONTH,
  MONTHS,
  NOT_NOW,
  RULES_IN_FULL,
  RULES_LINES,
  RULES_PAGE,
  RULES_TITLE,
  SAFETY_PAGE,
  STAYING_SAFE,
  YEAR,
} from './firstwords';
import type { Fetch } from './me';
import { call, reasonOf } from './passkeys';
import { reasonText } from './reasons';

export { type FirstAsk, firstAsks } from './firstwords';

/** The month and year boxes, both empty to start, under the question as their legend. */
export function BornFields({
  id,
  month,
  year,
  setMonth,
  setYear,
  invalid = false,
  describedBy,
  children,
}: {
  /** Prefixes the boxes' ids. */
  id: string;
  month: string;
  year: string;
  setMonth: (m: string) => void;
  setYear: (y: string) => void;
  invalid?: boolean;
  describedBy?: string;
  /** Said under the legend. */
  children?: ComponentChildren;
}) {
  return (
    <fieldset class="born">
      <legend class="born-legend">{AGE_QUESTION}</legend>
      {children}
      <div class="born-boxes">
        <select
          id={`${id}-month`}
          class="born-box"
          name="born-month"
          aria-label={MONTH}
          required
          value={month}
          aria-invalid={invalid && month === ''}
          aria-describedby={describedBy}
          onChange={(e) => setMonth(e.currentTarget.value)}
        >
          <option value="">{MONTH}</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1)}>
              {m}
            </option>
          ))}
        </select>
        <select
          id={`${id}-year`}
          class="born-box"
          name="born-year"
          aria-label={YEAR}
          required
          value={year}
          aria-invalid={invalid && year === ''}
          aria-describedby={describedBy}
          onChange={(e) => setYear(e.currentTarget.value)}
        >
          <option value="">{YEAR}</option>
          {bornYears().map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

/**
 * Sends when an older sailor's player was born: answered (now, or before,
 * elsewhere), young, or the reason it was not taken.
 */
export async function sendBorn(f: Fetch, born: Born): Promise<string> {
  const a = await call(f, '/api/me/born', born);
  if (a.status === 204 || a.status === 409) {
    return 'answered';
  }
  return a.status === 403 && reasonOf(a) === 'young' ? 'young' : reasonOf(a);
}

/** Accepts the Rules of the sea: answered, or the reason it was not taken. */
export async function acceptRules(f: Fetch): Promise<string> {
  const a = await call(f, '/api/me/rules', {});
  return a.status === 204 ? 'answered' : reasonOf(a);
}

/** The panel's lone answer to an under-age sailor. */
export function CantSail() {
  return (
    <section class="start-panel first-ask" aria-labelledby="first-ask-title">
      <h1 id="first-ask-title" class="first-ask-refusal">
        {CANT_SAIL}
      </h1>
    </section>
  );
}

/**
 * The age question, asked once of a sailor made before it was: answered
 * (or answered before, elsewhere) calls onAnswered; an under-age answer
 * shows only that the sailor can't sail, and calls onYoung. With onNotNow,
 * Not now puts it off.
 */
export function AgeQuestion({
  onAnswered,
  onYoung,
  onNotNow,
  fetch: f = fetch,
}: {
  onAnswered: () => void;
  onYoung: () => void;
  onNotNow?: () => void;
  /** The server; the browser's own unless a test stands in. */
  fetch?: Fetch;
}) {
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [young, setYoung] = useState(false);
  if (young) {
    return <CantSail />;
  }
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    const born = bornOf(month, year);
    if (born === null) {
      setProblem(reasonText('born'));
      return;
    }
    setBusy(true);
    setProblem('');
    const answer = await sendBorn(f, born);
    setBusy(false);
    if (answer === 'answered') {
      onAnswered();
    } else if (answer === 'young') {
      setYoung(true);
      onYoung();
    } else {
      setProblem(reasonText(answer));
    }
  };
  return (
    <form
      class="start-panel first-ask"
      onSubmit={submit}
      aria-labelledby="first-ask-title"
      noValidate
    >
      <h1 id="first-ask-title">{AGE_QUESTION}</h1>
      <BornFields
        id="first-ask"
        month={month}
        year={year}
        setMonth={setMonth}
        setYear={setYear}
        invalid={problem !== ''}
        describedBy="first-ask-problem"
      >
        <p class="start-text start-faint">{AGE_ONCE}</p>
      </BornFields>
      <p id="first-ask-problem" class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="submit" class="start-go" disabled={busy}>
        {GO_ON}
      </button>
      {onNotNow === undefined ? null : (
        <button type="button" class="start-sign-in" disabled={busy} onClick={onNotNow}>
          {NOT_NOW}
        </button>
      )}
    </form>
  );
}

/** Links to the Rules of the sea in full and to staying safe, which open in a page of their own. */
export function RulesLinks() {
  return (
    <p class="start-text first-ask-links">
      <a href={RULES_PAGE} target="_blank" rel="noopener">
        {RULES_IN_FULL}
      </a>
      {' · '}
      <a href={SAFETY_PAGE} target="_blank" rel="noopener">
        {STAYING_SAFE}
      </a>
    </p>
  );
}

/**
 * The Rules of the sea in short, accepted once: I'll keep to them tells
 * the server, then calls onAccepted. With onCancel, Cancel goes back.
 */
export function RulesCard({
  onAccepted,
  onCancel,
  fetch: f = fetch,
}: {
  onAccepted: () => void;
  onCancel?: () => void;
  /** The server; the browser's own unless a test stands in. */
  fetch?: Fetch;
}) {
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem('');
    const answer = await acceptRules(f);
    setBusy(false);
    if (answer === 'answered') {
      onAccepted();
    } else {
      setProblem(reasonText(answer));
    }
  };
  return (
    <section class="start-panel first-ask rules-card" aria-labelledby="first-ask-title">
      <h1 id="first-ask-title">{RULES_TITLE}</h1>
      <ul class="rules-lines">
        {RULES_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <RulesLinks />
      <p class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="button" class="start-go" disabled={busy} onClick={() => void accept()}>
        {KEEP_TO_THEM}
      </button>
      {onCancel === undefined ? null : (
        <button type="button" class="start-sign-in" disabled={busy} onClick={onCancel}>
          {CANCEL}
        </button>
      )}
    </section>
  );
}

/**
 * The questions still to ask, one panel after another (asks, as firstAsks
 * gives them): onDone once each is answered. Not now on the age question,
 * or Cancel on the Rules, calls onCancel; an under-age answer stays on its
 * refusal and calls onYoung.
 */
export function FirstAsks({
  asks,
  onDone,
  onCancel,
  onYoung = () => {},
  fetch: f = fetch,
}: {
  asks: readonly FirstAsk[];
  onDone: () => void;
  onCancel: () => void;
  onYoung?: () => void;
  fetch?: Fetch;
}) {
  const [at, setAt] = useState(0);
  const next = () => {
    if (at + 1 >= asks.length) {
      onDone();
    } else {
      setAt(at + 1);
    }
  };
  const ask = asks[at];
  // Nothing left to ask: done at once.
  useEffect(() => {
    if (asks.length === 0) {
      onDone();
    }
  }, []);
  if (ask === undefined) {
    return null;
  }
  return ask === 'age' ? (
    <AgeQuestion key="age" onAnswered={next} onYoung={onYoung} onNotNow={onCancel} fetch={f} />
  ) : (
    <RulesCard key="rules" onAccepted={next} onCancel={onCancel} fetch={f} />
  );
}

// SPDX-License-Identifier: AGPL-3.0-only

// The approval page: where an AI app sends the player to be let sail one
// of their machine sailors. It reads the request the server kept for this
// browser, and shows first and largest where the sign-in returns (the
// app's host, or an app on this computer, which any page on it could pose
// as), then the app as it names itself, and what approving lets it do. The
// player continues with a passkey, on the browser's own prompt (never
// autofill: the page may be a window the app opened, and the player
// chooses to sign in); then chooses one of their machine sailors, or makes
// one, and approves, or cancels. Either way the page is given the address
// back to the app, and goes there.
//
// No game session is made or read here. A browser that cannot make
// passkeys, as an app's own browser often cannot, or a prompt refused at
// once, is told so, with the page's link to open in the phone's own
// browser.
//
// The page's state is held by ApprovePage; ApproveView draws it, and holds
// none, so a test can draw any state.

import { useEffect, useState } from 'preact/hooks';
import { type InApp, passkeySupport } from '../src/account/inapp';
import {
  type Draft,
  draftBody,
  drawMachine,
  type LookPart,
  MachineFields,
  type MachineItem,
  type MachineLooks,
  MachineSummary,
  withPart,
} from '../src/account/machineform';
import type { Fetch } from '../src/account/me';
import {
  answerJSON,
  call,
  type Outcome,
  type Prompt,
  promptFailure,
  publicKeyCredential,
  reasonOf,
  requestOptions,
} from '../src/account/passkeys';
import { approveReasonText, lengthProblem } from '../src/account/reasons';

/** GET /oauth/request: the request as the page shows it. */
export interface RequestData {
  client: { name: string; registered: boolean; vouchedBy?: string };
  /** Where the sign-in returns; empty for an app on this computer. */
  returnHost: string;
  loopback: boolean;
  expires: number;
  /** The account whose passkey confirmed the request, or null before. */
  signedIn: null | { name: string; machines: MachineItem[]; cap: number; until: number };
  looks: MachineLooks;
}

/** What the page reaches: the server, and the browser's prompt, so tests can stand in. */
export interface ApproveReach {
  fetch: Fetch;
  prompt: Prompt;
  pkc: ReturnType<typeof publicKeyCredential>;
  /** The time, ms, to tell a prompt refused at once from one the player closed. */
  now: () => number;
}

function browserReach(): ApproveReach {
  return {
    fetch: (input, init) => fetch(input, init),
    prompt: navigator.credentials as unknown as Prompt,
    pkc: publicKeyCredential(),
    now: () => performance.now(),
  };
}

/** A prompt refused within this, ms, was refused by the browser, not closed by the player. */
export const AT_ONCE = 1000;

export async function readRequest(f: Fetch): Promise<Outcome<RequestData>> {
  try {
    const res = await f('/oauth/request', { cache: 'no-store', credentials: 'same-origin' });
    const body = (await res.json()) as RequestData & { error?: string };
    if (res.status !== 200) {
      return { ok: false, reason: typeof body.error === 'string' ? body.error : 'unavailable' };
    }
    return { ok: true, value: body };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/**
 * Confirms the request with one of the game's passkeys, on the browser's
 * modal prompt: the request as the server then shows it, signed in. A
 * prompt refused at once fails as window: this window cannot use passkeys.
 */
export async function continueWithPasskey(r: ApproveReach): Promise<Outcome<RequestData>> {
  const begun = await call(r.fetch, '/oauth/approve/begin');
  if (begun.status !== 200 || begun.body === null) {
    return { ok: false, reason: reasonOf(begun) };
  }
  const asked = r.now();
  let cred: unknown;
  try {
    cred = await r.prompt.get({ publicKey: requestOptions(begun.body, r.pkc) });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError' && r.now() - asked < AT_ONCE) {
      return { ok: false, reason: 'window' };
    }
    return { ok: false, reason: promptFailure(err) };
  }
  if (cred === null) {
    return { ok: false, reason: 'cancelled' };
  }
  const done = await call(
    r.fetch,
    '/oauth/approve/finish',
    answerJSON(cred as Parameters<typeof answerJSON>[0]),
  );
  if (done.status !== 200 || done.body === null) {
    return { ok: false, reason: reasonOf(done) };
  }
  return { ok: true, value: done.body as unknown as RequestData };
}

/** Where the page goes next: the address back to the app. */
async function redirectOf(f: Fetch, path: string, body?: unknown): Promise<Outcome<string>> {
  const a = await call(f, path, body);
  return a.status === 200 && typeof a.body?.redirect === 'string'
    ? { ok: true, value: a.body.redirect }
    : { ok: false, reason: reasonOf(a) };
}

/** Approves the request for a machine sailor, by its id, or one made with it. */
export function approve(f: Fetch, choice: string | Draft): Promise<Outcome<string>> {
  return redirectOf(
    f,
    '/oauth/approve',
    typeof choice === 'string' ? { machine: choice } : { make: draftBody(choice) },
  );
}

/** Turns the request down. */
export function deny(f: Fetch): Promise<Outcome<string>> {
  return redirectOf(f, '/oauth/deny');
}

/** The choice of making a machine sailor, beside the machine sailors' ids. */
export const MAKE = '';

/** The choice a page signed in starts with: the first machine sailor, or making one. */
export function firstChoice(data: RequestData): string {
  return data.signedIn?.machines[0]?.id ?? MAKE;
}

/** Whether another machine sailor may be made. */
export function canMake(data: RequestData): boolean {
  const s = data.signedIn;
  return s !== null && s.machines.length < s.cap;
}

export type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; data: RequestData }
  /** No request to go on with, or it cannot be read: words, and nothing to do. */
  | { kind: 'ended'; words: string }
  /** On the way back to the app. */
  | { kind: 'away'; to: string };

/** Why this window cannot use passkeys: an app's own browser, or a prompt refused at once. */
export type Blocked = null | { app: InApp | null };

export interface ViewProps {
  phase: Phase;
  blocked: Blocked;
  problem: string;
  busy: boolean;
  choice: string;
  /** The machine sailor to make, drawn as the request is read. */
  draft: Draft | null;
  copied: boolean;
  onContinue: () => void;
  onChoose: (choice: string) => void;
  onApprove: () => void;
  onCancel: () => void;
  onCopy: () => void;
  setName: (name: string) => void;
  pick: (part: LookPart, id: string) => void;
  draw: () => void;
}

function Who({ data }: { data: RequestData }) {
  const c = data.client;
  return (
    <>
      <p class="approve-label">Signing in to</p>
      <h1 class="approve-host">{data.loopback ? 'an app on this computer' : data.returnHost}</h1>
      {data.loopback ? (
        <p class="start-warning" role="note">
          Any page or program on this computer could pose as it. Approve only if you have just
          connected an AI app on this computer.
        </p>
      ) : null}
      <p class="approve-app">
        {c.registered || c.vouchedBy === undefined ? (
          <>
            An app that calls itself <strong>{c.name}</strong>
          </>
        ) : (
          <>
            <strong>{c.name}</strong>, vouched for by {c.vouchedBy}
          </>
        )}
      </p>
      <p class="approve-what">will sail one of your machine sailors and speak as it</p>
    </>
  );
}

function BlockedHere({
  blocked,
  copied,
  onCopy,
}: {
  blocked: { app: InApp | null };
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section class="approve-blocked" aria-labelledby="blocked-title">
      <h2 id="blocked-title">Passkeys don’t work in this window</h2>
      <p class="start-text">
        {blocked.app !== null
          ? `Inside ${blocked.app.app ?? 'this app'}, passkeys don’t work. `
          : ''}
        Open this page in your phone’s own browser: copy the link, and paste it there.
      </p>
      {blocked.app !== null ? <p class="start-text start-faint">{blocked.app.steps}</p> : null}
      <button type="button" class="start-go" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy the link'}
      </button>
    </section>
  );
}

function Choose(props: ViewProps & { data: RequestData }) {
  const s = props.data.signedIn;
  if (s === null) {
    return null;
  }
  const make = canMake(props.data);
  return (
    <>
      <p class="approve-signed">
        Signed in as{' '}
        <strong>
          <bdi>{s.name}</bdi>
        </strong>
      </p>
      <fieldset class="approve-choices">
        <legend class="start-label">Which machine sailor?</legend>
        {s.machines.map((m) => (
          <label key={m.id} class="approve-choice">
            <input
              type="radio"
              name="machine"
              value={m.id}
              checked={props.choice === m.id}
              onChange={() => props.onChoose(m.id)}
            />
            <MachineSummary m={m} />
          </label>
        ))}
        {make ? (
          <label class="approve-choice">
            <input
              type="radio"
              name="machine"
              value="make"
              checked={props.choice === MAKE}
              onChange={() => props.onChoose(MAKE)}
            />
            <span class="machine-name">Make a machine sailor</span>
          </label>
        ) : (
          <p class="start-text start-faint">You have as many machine sailors as you may.</p>
        )}
      </fieldset>
      {make && props.choice === MAKE && props.draft !== null ? (
        <MachineFields
          looks={props.data.looks}
          draft={props.draft}
          problem={props.problem}
          id="approve"
          setName={props.setName}
          pick={props.pick}
          draw={props.draw}
        />
      ) : null}
      <button
        type="submit"
        class="start-go"
        disabled={props.busy || (props.choice === MAKE && !make)}
      >
        Approve
      </button>
    </>
  );
}

/** The page, drawn from its state alone. */
export function ApproveView(props: ViewProps) {
  const { phase } = props;
  if (phase.kind === 'loading') {
    return (
      <main class="approve">
        <section class="start-panel approve-panel">
          <p class="approve-game">Keel Over the Edge</p>
          <p class="start-text start-faint" aria-live="polite">
            Reading the request…
          </p>
        </section>
      </main>
    );
  }
  if (phase.kind === 'ended' || phase.kind === 'away') {
    return (
      <main class="approve">
        <section class="start-panel approve-panel">
          <p class="approve-game">Keel Over the Edge</p>
          <p class="start-text" aria-live="polite">
            {phase.kind === 'ended' ? phase.words : 'Taking you back to the app…'}
          </p>
        </section>
      </main>
    );
  }
  const { data } = phase;
  const signed = data.signedIn !== null;
  // The make form's refusals are shown beside its name field.
  const problemHere = !(signed && props.choice === MAKE && canMake(data));
  return (
    <main class="approve">
      <form
        class="start-panel approve-panel"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (signed) {
            props.onApprove();
          } else {
            props.onContinue();
          }
        }}
      >
        <p class="approve-game">Keel Over the Edge</p>
        <Who data={data} />
        {props.blocked !== null ? (
          <BlockedHere blocked={props.blocked} copied={props.copied} onCopy={props.onCopy} />
        ) : signed ? (
          <Choose {...props} data={data} />
        ) : (
          <button type="submit" class="start-go" disabled={props.busy}>
            Continue with your passkey
          </button>
        )}
        {problemHere ? (
          <p class="start-problem" aria-live="polite">
            {props.problem}
          </p>
        ) : null}
        <button type="button" class="start-sign-in" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </form>
    </main>
  );
}

/** The page, with its state, reaching the server and the browser's prompt. */
export function ApprovePage({
  reach = browserReach(),
  go = (to: string) => location.assign(to),
  random,
}: {
  reach?: ApproveReach;
  go?: (to: string) => void;
  random?: () => number;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(MAKE);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copied, setCopied] = useState(false);

  const ended = (reason: string) => setPhase({ kind: 'ended', words: approveReasonText(reason) });

  const ready = (data: RequestData) => {
    setPhase({ kind: 'ready', data });
    if (data.signedIn !== null) {
      setChoice((c) =>
        c !== MAKE && data.signedIn?.machines.some((m) => m.id === c) ? c : firstChoice(data),
      );
    }
    setDraft((d) => d ?? drawMachine(data.looks, null, random));
  };

  useEffect(() => {
    void (async () => {
      const [res, support] = await Promise.all([
        readRequest(reach.fetch),
        passkeySupport({ userAgent: navigator.userAgent, pkc: reach.pkc }),
      ]);
      if (support.kind === 'in-app') {
        setBlocked({ app: support.app });
      } else if (support.kind === 'none') {
        setBlocked({ app: null });
      }
      if (res.ok) {
        ready(res.value);
      } else {
        ended(res.reason);
      }
    })();
  }, []);

  const failed = (reason: string) => {
    if (reason === 'again') {
      ended(reason);
    } else if (reason === 'confirm' && phase.kind === 'ready') {
      // The passkey's confirmation lapsed: continue with it again, the
      // choice kept.
      setPhase({ kind: 'ready', data: { ...phase.data, signedIn: null } });
      setProblem(approveReasonText(reason));
    } else if (reason === 'window') {
      setBlocked({ app: null });
    } else if (reason !== 'cancelled') {
      setProblem(approveReasonText(reason));
    }
  };

  const work = async <T,>(job: () => Promise<Outcome<T>>, then: (v: T) => void) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem('');
    const res = await job();
    setBusy(false);
    if (res.ok) {
      then(res.value);
    } else {
      failed(res.reason);
    }
  };

  const away = (to: string) => {
    setPhase({ kind: 'away', to });
    go(to);
  };

  const onApprove = () => {
    if (phase.kind !== 'ready' || draft === null) {
      return;
    }
    if (choice === MAKE) {
      const wrong = lengthProblem(draft.name);
      if (wrong !== null) {
        setProblem(approveReasonText(wrong));
        return;
      }
    }
    void work(() => approve(reach.fetch, choice === MAKE ? draft : choice), away);
  };

  const looks = phase.kind === 'ready' ? phase.data.looks : null;
  const edit = (f: (d: Draft, looks: MachineLooks) => Draft) =>
    setDraft((d) => (d === null || looks === null ? d : f(d, looks)));
  return (
    <ApproveView
      phase={phase}
      blocked={blocked}
      problem={problem}
      busy={busy}
      choice={choice}
      draft={draft}
      copied={copied}
      onContinue={() => void work(() => continueWithPasskey(reach), ready)}
      onChoose={(c) => {
        setChoice(c);
        setProblem('');
      }}
      onApprove={onApprove}
      onCancel={() => void work(() => deny(reach.fetch), away)}
      onCopy={() =>
        void navigator.clipboard.writeText(location.href).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
      setName={(name) => edit((d) => ({ ...d, name }))}
      pick={(part, id) => edit((d, l) => withPart(l, d, part, id))}
      draw={() => edit((d, l) => drawMachine(l, d, random))}
    />
  );
}

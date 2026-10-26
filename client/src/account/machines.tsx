// SPDX-License-Identifier: AGPL-3.0-only

// Machine sailors in the game: sailors of a machine look that the player's
// AI apps sail, each made with a name and a look, then connected to an AI
// app (the app opens the approval page, where the player approves it with
// a passkey). The start screen shows them to a player who has any, before
// the sea: Set sail, each one at sea or not, how to connect it, its
// approved apps, and another made while the account is under its cap. The
// menu shows the same. The account page manages them: each approved app
// revoked, a connection token made (shown once) or revoked, a machine
// sailor deleted. A connection token hands the machine sailor out, and
// deleting cannot be undone, so both first ask for one of the account's
// own passkeys, as the account page's own deletions do. A machine sailor
// the game's operator stopped says so: its apps are revoked, and it may
// only be deleted.
//
// A machine sailor at sea can be watched from the start screen, with how
// many watch it, as can any other sailor from the list; and the account
// page copies a link that opens the game watching it.
//
// Loaded only when shown: none of it is in the game's first download.

import { type JSX, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { catalog } from '../catalog';
import { useWatch } from '../ui/watchlazy';
import {
  COPIED,
  COPY_WATCH_LINK,
  STILL_AT_SEA,
  WATCH,
  WATCH_ANOTHER_SAILOR,
  watchersText,
  watchLink,
} from '../ui/watchwords';
import { Connect } from './connect';
import {
  type Draft,
  draftBody,
  endsWords,
  liveApps,
  MachineFields,
  type MachineItem,
  type MachineLooks,
  MachineSummary,
  useDraft,
} from './machineform';
import type { Fetch, Me } from './me';
import { call, confirmPasskey, type Outcome, reasonOf } from './passkeys';
import { lengthProblem, machineReasonText } from './reasons';
import { dayOf } from './recovery';

/**
 * A machine sailor as the account's page lists it: stopped, ms, when the
 * game's operator stopped it on its own, 0 for not; and how many watch it
 * now, 0 when none or not at sea.
 */
export type Machine = MachineItem & { stopped?: number; watchers?: number };

/** GET /api/machines: the account's machine sailors and what goes with them. */
export interface MachinesPage {
  /** The MCP address AI apps connect to. */
  mcp: string;
  cap: number;
  machines: Machine[];
  /** The account's boats, how many of each kind, by the catalog's ids. */
  fleet: Record<string, number>;
  looks: MachineLooks;
  confirmedUntil: number;
}

const browserFetch: Fetch = (input, init) => fetch(input, init);

export async function readMachines(f: Fetch = browserFetch): Promise<Outcome<MachinesPage>> {
  try {
    const res = await f('/api/machines', { cache: 'no-store', credentials: 'same-origin' });
    const body = (await res.json()) as MachinesPage & { error?: string };
    if (res.status !== 200) {
      return { ok: false, reason: typeof body.error === 'string' ? body.error : 'unavailable' };
    }
    return { ok: true, value: body };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** POSTs to one of the machine sailors' routes, the page given back on the status hoped for. */
async function post<T = MachinesPage>(
  path: string,
  body: unknown,
  status: number,
  f: Fetch = browserFetch,
): Promise<Outcome<T>> {
  const a = await call(f, path, body);
  return a.status === status && a.body !== null
    ? { ok: true, value: a.body as unknown as T }
    : { ok: false, reason: reasonOf(a) };
}

export const makeMachine = (d: Draft, f?: Fetch) => post('/api/machines', draftBody(d), 201, f);
export const deleteMachine = (machine: string, name: string, f?: Fetch) =>
  post('/api/machines/delete', { machine, name }, 200, f);
export const revokeApp = (grant: string, f?: Fetch) =>
  post('/api/machines/revoke', { grant }, 200, f);
export const makeToken = (machine: string, f?: Fetch) =>
  post<{ token: string; ends: number }>('/api/machines/token', { machine }, 201, f);
export const revokeToken = (machine: string, f?: Fetch) =>
  post('/api/machines/token/revoke', { machine }, 200, f);

/** When a machine sailor was stopped, "Stopped on 26 October"; "" for one not stopped. */
export function stoppedOn(m: Machine, now = Date.now()): string {
  return (m.stopped ?? 0) > 0 ? `Stopped on ${dayOf(m.stopped ?? 0, now)}` : '';
}

/** The fleet in one line: 2 Jolly boats, by the catalog's boats' names. */
export function fleetLine(fleet: Record<string, number>): string {
  const parts: string[] = [];
  for (const b of catalog.boats) {
    const n = fleet[b.id] ?? 0;
    if (n > 0) {
      parts.push(`${n} ${b.name}${n === 1 ? '' : 's'}`);
    }
  }
  return parts.join(', ');
}

/** The account's machine sailors, read as the component shows. */
function usePage() {
  const [page, setPage] = useState<MachinesPage | null>(null);
  const [problem, setProblem] = useState('');
  const load = async () => {
    const res = await readMachines();
    if (res.ok) {
      setPage(res.value);
    } else {
      setProblem(machineReasonText(res.reason));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return { page, setPage, problem, load };
}

/** The form that makes a machine sailor; made is given the page with it, last. */
export function MakeMachine({
  looks,
  made,
  cancel,
}: {
  looks: MachineLooks;
  made: (page: MachinesPage) => void;
  cancel: (() => void) | null;
}) {
  const { draft, setName, pick, draw } = useDraft(looks);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    const wrong = lengthProblem(draft.name);
    if (wrong !== null) {
      setProblem(machineReasonText(wrong));
      return;
    }
    setBusy(true);
    setProblem('');
    const res = await makeMachine(draft);
    setBusy(false);
    if (res.ok) {
      made(res.value);
    } else {
      setProblem(machineReasonText(res.reason));
    }
  };
  return (
    <form class="machine-form" onSubmit={submit} aria-labelledby="machine-form-title" noValidate>
      <h2 id="machine-form-title">Make a machine sailor</h2>
      <p class="start-text start-faint">
        A sailor of metal that an AI app of yours sails, and speaks as. Its name is shown to
        everyone, as yours is.
      </p>
      <MachineFields
        looks={looks}
        draft={draft}
        problem={problem}
        id="machine"
        setName={setName}
        pick={pick}
        draw={draw}
      />
      <button type="submit" class="start-go" disabled={busy}>
        Make it
      </button>
      {cancel !== null ? (
        <button type="button" class="start-link" onClick={cancel}>
          Not now
        </button>
      ) : null}
    </form>
  );
}

type View = { kind: 'list' } | { kind: 'form' } | { kind: 'connect'; name: string };

/** Copies the address that opens the game watching a machine sailor. */
function WatchLinkCopy({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(watchLink(location.origin, name)).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? COPIED : COPY_WATCH_LINK}
    </button>
  );
}

/**
 * The machine sailors' list, with how to connect each and another made:
 * the start screen's and the menu's. first opens on the form. On the
 * start screen, watch is given the sailor chosen to watch, and each at
 * sea offers it.
 */
function MachinesBody({
  page,
  setPage,
  first,
  watch = null,
}: {
  page: MachinesPage;
  setPage: (p: MachinesPage) => void;
  first: boolean;
  watch?: ((name: string) => void) | null;
}) {
  const [view, setView] = useState<View>({ kind: first ? 'form' : 'list' });
  const [open, setOpen] = useState('');
  if (view.kind === 'form') {
    return (
      <MakeMachine
        looks={page.looks}
        made={(p) => {
          setPage(p);
          setView({ kind: 'connect', name: p.machines[p.machines.length - 1]?.name ?? '' });
        }}
        cancel={() => setView({ kind: 'list' })}
      />
    );
  }
  if (view.kind === 'connect') {
    return (
      <section class="machine-connect" aria-labelledby="connect-title">
        <h2 id="connect-title">Connect your AI</h2>
        <Connect mcp={page.mcp} name={view.name} />
        <button type="button" class="start-go" onClick={() => setView({ kind: 'list' })}>
          Done
        </button>
      </section>
    );
  }
  return (
    <section aria-labelledby="machines-title">
      <h2 id="machines-title">Machine sailors</h2>
      {page.machines.length === 0 ? (
        <p class="start-text start-faint">None yet.</p>
      ) : (
        <ul class="machine-list">
          {page.machines.map((m) => (
            <li key={m.id} data-machine={m.name}>
              <MachineSummary m={m} />
              {watch !== null && m.atSea && stoppedOn(m) === '' ? (
                <span class="machine-watch">
                  <button type="button" class="start-sign-in" onClick={() => watch(m.name)}>
                    {WATCH}
                  </button>
                  {watchersText(m.watchers ?? 0) !== '' ? (
                    <span class="machine-faint" data-readout="watchers">
                      {watchersText(m.watchers ?? 0)}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {stoppedOn(m) !== '' ? (
                <p class="start-text start-faint">{stoppedOn(m)}.</p>
              ) : (
                <button
                  type="button"
                  class="start-sign-in"
                  aria-expanded={open === m.id}
                  onClick={() => setOpen(open === m.id ? '' : m.id)}
                >
                  How to connect
                </button>
              )}
              {open === m.id ? <Connect mcp={page.mcp} name={m.name} /> : null}
            </li>
          ))}
        </ul>
      )}
      {page.machines.length < page.cap ? (
        <button type="button" class="start-sign-in" onClick={() => setView({ kind: 'form' })}>
          {page.machines.length === 0 ? 'Make a machine sailor' : 'Make another machine sailor'}
        </button>
      ) : null}
    </section>
  );
}

/** The list of every sailor one may watch, once its module is loaded. */
function StartWatchList({ choose, close }: { choose: (name: string) => void; close: () => void }) {
  const m = useWatch();
  return m === null ? null : (
    <m.WatchList
      choose={choose}
      ask={() => false}
      close={close}
      className="start-panel watch-list-start"
    />
  );
}

/**
 * The start screen with the player's machine sailors: Set sail, and the
 * list, each at sea with Watch; and Watch another sailor. first, after a
 * new sailor's recovery code, opens on the form. done is given the sailor
 * chosen to watch, or nothing to sail. atSea: the player's own boat is
 * still in the water, which a watch takes out, and the screen says so.
 */
export function MachineStart({
  first,
  done,
  atSea = false,
}: {
  first: boolean;
  done: (watch?: string) => void;
  atSea?: boolean;
}) {
  const { page, setPage, problem } = usePage();
  const [listing, setListing] = useState(false);
  if (listing) {
    return <StartWatchList choose={(name) => done(name)} close={() => setListing(false)} />;
  }
  return (
    <section class="start-panel machine-panel" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      <button type="button" class="start-go" onClick={() => done()}>
        Set sail
      </button>
      {atSea ? (
        <p class="start-warning" role="note">
          {STILL_AT_SEA}
        </p>
      ) : null}
      {page === null ? (
        <p class="start-text start-faint" aria-live="polite">
          {problem || 'Reading your machine sailors…'}
        </p>
      ) : (
        <MachinesBody page={page} setPage={setPage} first={first} watch={(name) => done(name)} />
      )}
      <button type="button" class="start-sign-in" onClick={() => setListing(true)}>
        {WATCH_ANOTHER_SAILOR}
      </button>
    </section>
  );
}

/** Shows the start screen with machine sailors in parent until Set sail, or a sailor chosen to watch. */
export function showMachineStart(parent: HTMLElement, me: Me): Promise<Me> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    parent.append(root);
    const done = (watch?: string) => {
      render(null, root);
      root.remove();
      resolve(watch === undefined ? me : { ...me, watch });
    };
    render(
      <div class="start">
        <MachineStart first={false} done={done} atSea={me.atSea === true} />
      </div>,
      root,
    );
  });
}

/** The menu's panel of machine sailors. */
export function MachinesPanel({ close }: { close: () => void }) {
  const { page, setPage, problem } = usePage();
  return (
    <section class="panel menu account machines" aria-label="Machine sailors">
      {page === null ? (
        <p class="account-status" aria-live="polite">
          {problem || 'Reading your machine sailors…'}
        </p>
      ) : (
        <MachinesBody page={page} setPage={setPage} first={false} />
      )}
      <button type="button" class="menu-close" onClick={close}>
        Close
      </button>
    </section>
  );
}

/** When an approval or token ends, amber within the week. */
function Ends({ ends, now }: { ends: number; now: number }) {
  const w = endsWords(ends, now);
  return <span class={w.soon ? 'machine-soon' : undefined}>{w.text}</span>;
}

/** Used, or never. */
function lastUsed(ms: number, now: number): string {
  return ms > 0 ? `last used ${dayOf(ms, now)}` : 'not used yet';
}

type Shown =
  | { kind: 'page' }
  | { kind: 'token'; m: MachineItem; token: string; ends: number }
  | { kind: 'delete'; m: MachineItem };

/** The account page's section: each machine sailor's apps, token and deletion. */
export function MachinesAccount({ now = Date.now() }: { now?: number }) {
  const { page, setPage, problem, load } = usePage();
  const [shown, setShown] = useState<Shown>({ kind: 'page' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  /** Runs what hands a machine sailor out or cannot be undone, a passkey confirmed first unless one was lately. */
  const confirmed = async <T,>(action: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    if (page === null || page.confirmedUntil <= Date.now()) {
      setStatus('Confirm with your passkey.');
      const c = await confirmPasskey();
      if (!c.ok) {
        return c;
      }
      setPage({ ...(page as MachinesPage), confirmedUntil: c.value });
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
      setStatus(res.reason === 'cancelled' ? '' : machineReasonText(res.reason));
    }
  };

  if (page === null) {
    return (
      <>
        <h3>Machine sailors</h3>
        <p class="account-faint">{problem || 'Reading your machine sailors…'}</p>
      </>
    );
  }

  if (shown.kind === 'token') {
    return (
      <section aria-labelledby="token-title">
        <h3 id="token-title">
          The connection token of <bdi>{shown.m.name}</bdi>
        </h3>
        <p class="start-warning">
          Whoever holds this token sails <bdi>{shown.m.name}</bdi> and speaks as it. It is shown
          once: keep it as you would a password.
        </p>
        <p class="machine-token" data-token={shown.token}>
          {shown.token}
        </p>
        <p class="account-faint">
          Send it as <code>Authorization: Bearer …</code> to the MCP address, {page.mcp}. It{' '}
          <Ends ends={shown.ends} now={now} />.
        </p>
        <TokenCopy token={shown.token} />
        <button
          type="button"
          onClick={() => {
            setShown({ kind: 'page' });
            void load();
          }}
        >
          Done
        </button>
      </section>
    );
  }

  if (shown.kind === 'delete') {
    const m = shown.m;
    return (
      <section aria-labelledby="machine-delete-title">
        <h3 id="machine-delete-title">
          Delete <bdi>{m.name}</bdi> for good?
        </h3>
        <p>
          The machine sailor goes, with its approved apps and connection token, and its name is free
          for anyone. Its boat stays in your fleet. This cannot be undone.
        </p>
        <label class="menu-row account-name">
          <span>Type its name</span>
          <input
            name="machine-delete-name"
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={typed}
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </label>
        <p class="machines-status" aria-live="polite">
          {status}
        </p>
        <button
          type="button"
          class="account-danger"
          disabled={busy || typed.trim() === ''}
          onClick={() =>
            void run(
              () => confirmed(() => deleteMachine(m.id, typed)),
              (p) => {
                setPage(p);
                setShown({ kind: 'page' });
                setStatus('Machine sailor deleted.');
              },
            )
          }
        >
          Delete this machine sailor
        </button>
        <button
          type="button"
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

  const fleet = fleetLine(page.fleet);
  return (
    <section class="machines-account" aria-labelledby="machines-account-title">
      <h3 id="machines-account-title">Machine sailors</h3>
      {fleet !== '' ? <p class="account-faint">Your fleet: {fleet}</p> : null}
      {page.machines.length === 0 ? (
        <p class="account-faint">None: make one from the menu’s Machine sailors.</p>
      ) : null}
      <ul class="machine-list">
        {page.machines.map((m) =>
          stoppedOn(m, now) !== '' ? (
            <li key={m.id} data-machine={m.name} data-stopped="">
              <MachineSummary m={m} apps={false} />
              <span class="machine-soon">{stoppedOn(m, now)}.</span>
              <RevokedApps m={m} />
              <button
                type="button"
                class="account-danger"
                disabled={busy}
                onClick={() => {
                  setStatus('');
                  setTyped('');
                  setShown({ kind: 'delete', m });
                }}
              >
                Delete this machine sailor
              </button>
            </li>
          ) : (
            <li key={m.id} data-machine={m.name}>
              <MachineSummary m={m} apps={false} />
              <AppsList
                m={m}
                now={now}
                busy={busy}
                revoke={(grant) =>
                  void run(
                    () => revokeApp(grant),
                    (p) => {
                      setPage(p);
                      setStatus('App revoked.');
                    },
                  )
                }
              />
              <span class="account-faint">
                Connection token:{' '}
                {m.token === null || m.token.ended === true ? (
                  'none'
                ) : (
                  <>
                    made on {dayOf(m.token.made, now)}, {lastUsed(m.token.lastUsed, now)},{' '}
                    <Ends ends={m.token.ends} now={now} />
                  </>
                )}
              </span>
              <div class="account-row">
                <WatchLinkCopy name={m.name} />
              </div>
              <div class="account-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => confirmed(() => makeToken(m.id)),
                      (t) => setShown({ kind: 'token', m, token: t.token, ends: t.ends }),
                    )
                  }
                >
                  {m.token === null || m.token.ended === true ? 'Make a token' : 'Make a new token'}
                </button>
                {m.token !== null && m.token.ended !== true ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => revokeToken(m.id),
                        (p) => {
                          setPage(p);
                          setStatus('Token revoked.');
                        },
                      )
                    }
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                class="account-danger"
                disabled={busy}
                onClick={() => {
                  setStatus('');
                  setTyped('');
                  setShown({ kind: 'delete', m });
                }}
              >
                Delete this machine sailor
              </button>
            </li>
          ),
        )}
      </ul>
      <p class="machines-status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}

/** A stopped machine sailor's apps, each revoked with it. */
function RevokedApps({ m }: { m: MachineItem }) {
  if (m.apps.length === 0) {
    return null;
  }
  return (
    <ul class="machine-apps">
      {m.apps.map((a) => (
        <li key={a.id}>
          <span>
            <strong>{a.name}</strong> <span class="account-faint">· revoked</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A machine sailor's approved apps, each with when it was approved, used, and ends. */
export function AppsList({
  m,
  now,
  busy,
  revoke,
}: {
  m: MachineItem;
  now: number;
  busy: boolean;
  revoke: (grant: string) => void;
}): JSX.Element {
  const live = liveApps(m);
  if (live.length === 0) {
    return <span class="account-faint">No AI app approved.</span>;
  }
  return (
    <ul class="machine-apps">
      {live.map((a) => (
        <li key={a.id}>
          <span>
            <strong>{a.name}</strong>{' '}
            <span class="account-faint">
              · {a.loopback === true ? 'an app on this computer' : a.returnHost}
            </span>
            <br />
            <span class="account-faint">
              approved on {dayOf(a.approved, now)}, {lastUsed(a.lastUsed, now)},{' '}
              <Ends ends={a.ends} now={now} />
            </span>
          </span>
          <button type="button" disabled={busy} onClick={() => revoke(a.id)}>
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}

function TokenCopy({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(token).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

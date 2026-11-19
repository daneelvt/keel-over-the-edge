// SPDX-License-Identifier: AGPL-3.0-only

// The world page's Accounts and Settings tabs: the players' accounts counted, searched
// by a name or part of one, an account's id, or a token or session pasted
// in, which goes to keel in a POST's body alone and is never kept; the
// accounts found a page at a time, in the order asked for; and an
// account's card, its sailor's portrait beside its look in words, read
// again every few seconds while it is shown, with the owner's hand on it:
// stopped, started again, its tokens revoked or
// deleted, each that cannot be taken back first counted by keel and
// confirmed in the card with keel's own words; its owner's flag, priority
// and machine sailors allowed. The token lifetime of AI apps is set here
// too, and links to come aboard and chat's switches (settings.tsx). An account's flag and priority are also on the world's tab, beside
// its boat and its place in the queue. A card on which reports are open
// links them, on the Reports tab.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { Portrait } from '../account/portraits';
import { catalog } from '../catalog';
import { formatPosition } from '../chart/position';
import {
  actionBody,
  appWords,
  cardBoatWords,
  checked,
  countsTiles,
  dayWords,
  doneWords,
  type Flow,
  fleetWords,
  kindWords,
  momentWords,
  nextFlow,
  PAGE,
  SORTS,
  startWords,
  stoppedWords,
  type Typed,
  typedProblem,
  VERBS,
  type Verb,
} from './accountwords';
import {
  type AccountCard,
  type AccountsData,
  type ActionAnswer,
  control,
  getAccount,
  getJSON,
  type QueueRow,
  type SearchAnswer,
  type Sort,
  searchAccounts,
} from './api';
import { hidden } from './life';
import type { Act } from './lifecycle';
import { LogPart } from './log';
import { figuresWords } from './logwords';
import { AISignIn, MAX_CAP, plural } from './machines';
import { RacingSettings } from './racing';
import { reportsOn } from './reportwords';
import { SailWithSettings } from './settings';

/** How often the card shown is read again, ms. */
export const CARD_EVERY = 5000;

/**
 * An account's flag, its priority or every boat: what was clicked holds
 * until the world's reading agrees, so a reading still on its way does not
 * set the box back.
 */
function AccountBox({
  name,
  label,
  on,
  disabled,
  flag,
}: {
  name: 'flag' | 'priority' | 'every-boat';
  label: string;
  on: boolean;
  disabled: boolean;
  flag: (on: boolean) => Promise<boolean>;
}) {
  const [asked, setAsked] = useState<boolean | null>(null);
  useEffect(() => {
    if (asked === on) {
      setAsked(null);
    }
  }, [asked, on]);
  return (
    <label>
      <input
        type="checkbox"
        name={name}
        checked={asked ?? on}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const want = e.currentTarget.checked;
          setAsked(want);
          void flag(want).then((ok) => {
            if (!ok) {
              setAsked(null);
            }
          });
        }}
      />{' '}
      {label}
    </label>
  );
}

/**
 * An account's owner's flag, for a human's account alone, its priority,
 * for any, and on its card every boat, for any: every kind of boat opened
 * to its sailor whatever its certificates.
 */
export function AccountBoxes({
  account,
  sailor,
  tools,
  priority,
  everyBoat,
  human,
  act,
}: {
  account: string;
  sailor: string;
  tools: boolean;
  priority: boolean;
  /** Every boat's box, on the card alone: whether it is set, and its control. */
  everyBoat?: { on: boolean; act: (body: unknown, what: string) => Promise<boolean> };
  human: boolean;
  act: (path: 'flag' | 'priority', body: unknown, what: string) => Promise<boolean>;
}) {
  const who = sailor || account;
  return (
    <>
      <AccountBox
        name="flag"
        label="owner"
        on={tools}
        disabled={!human}
        flag={(on) => act('flag', { account, on }, `${who}'s flag`)}
      />{' '}
      <AccountBox
        name="priority"
        label="priority"
        on={priority}
        disabled={false}
        flag={(on) =>
          act(
            'priority',
            { account, on },
            `${who}'s priority ${on ? 'given' : 'taken'}, from its next join`,
          )
        }
      />
      {everyBoat !== undefined ? (
        <>
          {' '}
          <AccountBox
            name="every-boat"
            label="every boat"
            on={everyBoat.on}
            disabled={false}
            flag={(on) =>
              everyBoat.act(
                { account, on },
                on
                  ? `every boat opened to ${who}`
                  : `every boat closed to ${who}, from its next change of boat`,
              )
            }
          />
        </>
      ) : null}
    </>
  );
}

/** A button that opens an account's card, as a link would. */
function Opens({
  id,
  open,
  children,
}: {
  id: string;
  open: (id: string) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      class="link"
      data-account={id}
      onClick={(e) => {
        e.stopPropagation();
        open(id);
      }}
    >
      <bdi>{children}</bdi>
    </button>
  );
}

/**
 * The search: the text, sent in a POST's body alone, the order and the
 * page; the answer's note above the accounts found. Asked again when again
 * changes, after the owner's hand changed an account.
 */
/** What a sailor is doing now, as marks: at sea or waiting, and stopped. */
function Now({ atSea, queued, stopped }: { atSea: boolean; queued: boolean; stopped: boolean }) {
  return (
    <span class="who">
      {atSea ? <span class="chip sea">at sea</span> : null}
      {!atSea && queued ? <span class="chip">waiting</span> : null}
      <span class={stopped ? 'chip danger' : ''} data-field="row-stopped">
        {stopped ? 'stopped' : ''}
      </span>
      {!atSea && !queued && !stopped ? <span class="faint">ashore</span> : null}
    </span>
  );
}

function Search({
  open,
  chosen,
  again,
}: {
  open: (id: string) => void;
  chosen: string | null;
  again: number;
}) {
  const [text, setText] = useState('');
  // What was last searched for: the order and the pages are of it, not of
  // what is being typed.
  const [asked, setAsked] = useState({ text: '', sort: 'active-new' as Sort, page: 0 });
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [why, setWhy] = useState('');
  useEffect(() => {
    let live = true;
    searchAccounts(asked.text, asked.sort, asked.page)
      .then((a) => {
        if (live) {
          setAnswer(a);
          setWhy('');
        }
      })
      .catch((e: unknown) => live && setWhy(String(e)));
    return () => {
      live = false;
    };
  }, [asked, again]);

  return (
    <section class="card finder" aria-label="Search">
      <form
        class="search"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked({ ...asked, text: text.trim(), page: 0 });
        }}
      >
        <input
          type="search"
          name="search"
          autocomplete="off"
          spellcheck={false}
          placeholder="Find a sailor: a name or part of one, an id, a token"
          aria-label="A name or part of one, an account's id, or a token"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button type="submit" name="find" class="primary">
          Find
        </button>
      </form>
      {why !== '' ? <p class="small error">{why}</p> : null}
      {answer !== null && answer.note !== '' ? <p data-field="search-note">{answer.note}</p> : null}
      {answer !== null ? (
        <>
          <div class="found-head">
            <p class="small" data-field="search-total">
              {plural(answer.total, 'human')} found
              {answer.pages > 1 ? `, page ${answer.page + 1} of ${answer.pages}` : ''}.
            </p>
            <label class="small sort">
              Sorted by{' '}
              <select
                name="sort"
                aria-label="The order"
                value={asked.sort}
                onChange={(e) =>
                  setAsked({ ...asked, sort: e.currentTarget.value as Sort, page: 0 })
                }
              >
                {(Object.keys(SORTS) as Sort[]).map((s) => (
                  <option key={s} value={s}>
                    {SORTS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {answer.accounts.length === 0 ? (
            <p class="empty">
              {asked.text === '' ? 'No sailors yet.' : 'No sailor by that. Try less of the name.'}
            </p>
          ) : (
            <table class="accounts">
              <thead>
                <tr>
                  <th>Sailor</th>
                  <th>Now</th>
                  <th>Last active</th>
                  <th class="more">Made</th>
                  <th class="more">Log</th>
                </tr>
              </thead>
              <tbody>
                {answer.accounts.flatMap((r) => [
                  <tr
                    key={r.id}
                    data-account={r.id}
                    class={`${r.matched ? 'matched' : ''} ${chosen === r.id ? 'chosen' : ''}`}
                    onClick={() => open(r.id)}
                  >
                    <td>
                      <span class="who">
                        <bdi>{r.name}</bdi>
                        {r.tools ? <span class="chip gold">owner’s</span> : null}
                        {r.priority ? <span class="chip">priority</span> : null}
                      </span>
                      {r.machines.length > 0 ? (
                        <span class="small theirs">
                          {r.machines.map((m) => (
                            <span key={m.id} class="side">
                              <Opens id={m.id} open={open}>
                                {m.name}
                              </Opens>
                              : {m.lastActive}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <Now atSea={r.atSea} queued={r.queued} stopped={r.stopped} />
                    </td>
                    <td title={momentWords(r.lastActiveAt)}>{r.lastActive}</td>
                    <td class="more">{dayWords(r.made)}</td>
                    <td class="small more" data-field="row-log">
                      {figuresWords(answer.logs?.[r.id])}
                    </td>
                  </tr>,
                  // A machine sailor the search hit shows under its human.
                  ...r.machines
                    .filter((m) => m.matched)
                    .map((m) => (
                      <tr
                        key={m.id}
                        data-account={m.id}
                        class={`machine matched ${chosen === m.id ? 'chosen' : ''}`}
                        onClick={() => open(m.id)}
                      >
                        <td>
                          <span class="who">
                            <bdi>{m.name}</bdi>
                            <span class="chip">machine sailor</span>
                            {m.priority ? <span class="chip">priority</span> : null}
                          </span>
                        </td>
                        <td>
                          <Now atSea={m.atSea} queued={m.queued} stopped={m.stopped} />
                        </td>
                        <td title={momentWords(m.lastActiveAt)}>{m.lastActive}</td>
                        <td class="more">{dayWords(m.made)}</td>
                        <td class="small more">{figuresWords(answer.logs?.[m.id])}</td>
                      </tr>
                    )),
                ])}
              </tbody>
            </table>
          )}
          {answer.pages > 1 ? (
            <p class="pages">
              <button
                type="button"
                name="previous"
                disabled={answer.page <= 0}
                onClick={() => setAsked({ ...asked, page: answer.page - 1 })}
              >
                Previous {PAGE}
              </button>
              <button
                type="button"
                name="next"
                disabled={answer.page >= answer.pages - 1}
                onClick={() => setAsked({ ...asked, page: answer.page + 1 })}
              >
                Next {PAGE}
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * The owner's hand on an account: stopped or started again, its tokens
 * revoked, deleted. Stopping, revoking and deleting are first counted by
 * keel and confirmed with its words; starting again is confirmed with the
 * page's. Changing what is typed closes a confirmation open.
 */
function Hand({ card, act, done }: { card: AccountCard; act: Act; done: (verb: Verb) => void }) {
  const [typed, setTyped] = useState<Typed>({ reason: '', name: '' });
  const [flow, step] = useReducer(nextFlow, { step: 'idle' } as Flow);
  const [why, setWhy] = useState('');

  const edit = (t: Typed): void => {
    setTyped(t);
    setWhy('');
    step({ kind: 'edit' });
  };

  const ask = (verb: Verb): void => {
    const wrong = typedProblem(verb, typed);
    if (wrong !== '') {
      setWhy(wrong);
      return;
    }
    setWhy('');
    const body = actionBody(verb, card.id, typed);
    if (!checked(verb)) {
      step({ kind: 'ask', verb, body, words: startWords(card.name, typed.reason) });
      return;
    }
    step({ kind: 'check', verb });
    void control(`accounts/${verb}`, { ...body, check: true })
      .then((a) => {
        if (!a.ok) {
          setWhy(`Refused (${a.status}): ${a.text}`);
          step({ kind: 'refused' });
          return;
        }
        step({ kind: 'ask', verb, body, words: (JSON.parse(a.text) as ActionAnswer).words });
      })
      .catch((e: unknown) => {
        setWhy(`Failed: ${String(e)}`);
        step({ kind: 'refused' });
      });
  };

  const confirm = (): void => {
    if (flow.step !== 'asked') {
      return;
    }
    const { verb, body } = flow;
    step({ kind: 'confirm' });
    void act(`accounts/${verb}`, body, doneWords(verb, card.name)).then((ok) => {
      step({ kind: 'done' });
      if (ok) {
        setTyped({ reason: '', name: '' });
        done(verb);
      }
    });
  };

  const busy = flow.step === 'checking' || flow.step === 'sending';
  const verbs: Verb[] = [card.stopped === null ? 'stop' : 'start', 'revoke', 'delete'];
  return (
    <div class="hand">
      <h3>The owner's hand</h3>
      <form
        class="reason"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <input
          type="text"
          name="reason"
          autocomplete="off"
          placeholder="the reason, kept with what is done"
          aria-label="The reason"
          value={typed.reason}
          onInput={(e) => edit({ ...typed, reason: e.currentTarget.value })}
        />
        <input
          type="text"
          name="delete-name"
          autocomplete="off"
          spellcheck={false}
          placeholder="its name again, to delete it"
          aria-label="The sailor's name again, to delete it"
          value={typed.name}
          onInput={(e) => edit({ ...typed, name: e.currentTarget.value })}
        />
      </form>
      <p>
        {verbs.map((v) => (
          <button
            key={v}
            type="button"
            name={v}
            class={v === 'delete' || v === 'stop' ? 'danger' : ''}
            disabled={busy}
            onClick={() => ask(v)}
          >
            {VERBS[v]}
          </button>
        ))}
      </p>
      {why !== '' ? (
        <p class="small error" data-field="hand-why">
          {why}
        </p>
      ) : null}
      {flow.step === 'asked' || flow.step === 'sending' ? (
        <div class="confirm" data-field="account-confirmation" data-verb={flow.verb}>
          <p data-field="account-words">{flow.words}</p>
          <button type="button" name="confirm" disabled={flow.step === 'sending'} onClick={confirm}>
            Confirm
          </button>{' '}
          <button type="button" name="cancel" onClick={() => step({ kind: 'cancel' })}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A human's machine sailors allowed: those it has already stay. */
function Cap({ card, act }: { card: AccountCard; act: Act }) {
  const [cap, setCap] = useState('');
  const n = Number(cap);
  const ok = cap.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_CAP;
  return (
    <form
      class="cap"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'machines',
          { account: card.id, cap: n },
          `${plural(n, 'machine sailor')} allowed for ${card.name}`,
        ).then((done) => done && setCap(''));
      }}
    >
      <input
        type="number"
        name="machines-cap"
        min={0}
        max={MAX_CAP}
        step={1}
        aria-label="Machine sailors allowed"
        value={cap}
        onInput={(e) => setCap(e.currentTarget.value)}
      />
      <button type="submit" name="set-machines" disabled={!ok}>
        Allow
      </button>
      <span class="small"> from 0 to {MAX_CAP}; those it has already stay</span>
    </form>
  );
}

/** Where an account's boat is, with the way to it on the map. */
function Sea({
  sea,
  showBoat,
}: {
  sea: NonNullable<AccountCard['sea']>;
  showBoat: (boat: number, east: number, north: number) => void;
}) {
  return (
    <>
      boat {sea.boat} at{' '}
      <span data-field="card-position">{formatPosition(sea.east, sea.north)}</span> (
      {sea.east.toFixed(0)}, {sea.north.toFixed(0)})
      {sea.connected ? '' : `, in its grace, ${sea.grace.toFixed(0)} s`}{' '}
      <button
        type="button"
        class="link"
        name="show-on-map"
        onClick={() => showBoat(sea.boat, sea.east, sea.north)}
      >
        show on the map
      </button>
    </>
  );
}

/**
 * The reports open on an account and its machine sailors, by name, each a
 * link to them on the Reports tab; nothing while there are none, or while
 * reports are not running.
 */
function CardReports({
  names,
  openReports,
}: {
  names: string[];
  openReports: (name: string) => void;
}) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  // Read once as a card is opened (each card is its own): the queue is
  // the Reports tab's to follow.
  useEffect(() => {
    let live = true;
    getJSON<QueueRow[]>('reports.json')
      .then((q) => live && setRows(q))
      .catch(() => live && setRows(null));
    return () => {
      live = false;
    };
  }, []);
  const on = rows === null ? [] : reportsOn(rows, names);
  if (on.length === 0) {
    return null;
  }
  return (
    <>
      <dt>Reports</dt>
      <dd data-field="card-reports">
        {on.map((r) => (
          <span key={r.name} class="side">
            <button type="button" class="link" name="reports" onClick={() => openReports(r.name)}>
              <bdi>{r.name}</bdi>: {plural(r.open, 'report')} open
            </button>{' '}
          </span>
        ))}
      </dd>
    </>
  );
}

/** An account's card: what it is, what it has, what was done to it, and the owner's hand on it. */
function Card({
  id,
  shown,
  open,
  showBoat,
  openReports,
  act,
  changed,
}: {
  id: string;
  shown: boolean;
  open: (id: string | null) => void;
  showBoat: (boat: number, east: number, north: number) => void;
  openReports: (name: string) => void;
  act: Act;
  changed: () => void;
}) {
  const [card, setCard] = useState<AccountCard | null>(null);
  const [why, setWhy] = useState('');
  const [reads, readAgain] = useReducer((n: number) => n + 1, 0);

  // Read at once and every few seconds while the tab is shown, paused
  // while the page is hidden; at once again on its showing.
  useEffect(() => {
    if (!shown) {
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getAccount(id)
        .then((c) => {
          if (live) {
            setCard(c);
            setWhy('');
          }
        })
        .catch((e: unknown) => live && setWhy(String(e)));
    };
    read();
    const t = setInterval(read, CARD_EVERY);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', read);
    };
  }, [id, shown, reads]);

  // The owner's controls read the card again once done, and the search.
  const actHere: Act = (path, body, what) =>
    act(path, body, what).then((ok) => {
      if (ok) {
        readAgain(undefined);
        changed();
      }
      return ok;
    });

  if (card === null) {
    return (
      <section class="card account-card" aria-label="The account">
        <p class={why === '' ? 'small' : 'small error'}>{why || 'Reading the account…'}</p>
      </section>
    );
  }
  const human = card.kind === 'human';
  return (
    <section class="card account-card" aria-label="The account" data-account={card.id}>
      <h2>
        <bdi data-field="card-name">{card.name}</bdi>
      </h2>
      {why !== '' ? <p class="small error">{why}</p> : null}
      <dl>
        <dt>Kind</dt>
        <dd data-field="card-kind">
          {kindWords(card.kind)}
          {card.own ? ', one of your own accounts' : ''}
        </dd>
        <dt>ID</dt>
        <dd class="small">{card.id}</dd>
        <dt>Look</dt>
        <dd class="card-look">
          <Portrait looks={catalog} look={card.look} size={72} decorative />
          <span>{card.lookWords}</span>
        </dd>
        <dt>Made</dt>
        <dd>{momentWords(card.made)}</dd>
        <dt>Last active</dt>
        <dd data-field="card-last-active" title={momentWords(card.lastActiveAt)}>
          {card.lastActive}
        </dd>
        <dt>Stopped</dt>
        <dd data-field="card-stopped">
          {card.stopped === null ? 'no' : stoppedWords(card.stopped)}
        </dd>
        <dt>At sea</dt>
        <dd data-field="card-sea">
          {card.sea === null ? 'no' : <Sea sea={card.sea} showBoat={showBoat} />}
        </dd>
        {card.queue !== null ? (
          <>
            <dt>Waiting</dt>
            <dd>place {card.queue.position} in the queue</dd>
          </>
        ) : null}
        {card.watching !== undefined ? (
          <>
            <dt>Watching</dt>
            <dd data-field="card-watching">
              <bdi>{card.watching}</bdi>’s boat
            </dd>
          </>
        ) : null}
        {card.certificate !== undefined && card.certificate !== '' ? (
          <>
            <dt>Certificate</dt>
            <dd data-field="card-certificate">{card.certificate}</dd>
          </>
        ) : null}
        {card.log !== undefined ? (
          <>
            <dt>Log</dt>
            <dd data-field="card-log">
              <LogPart key={card.id} id={card.id} log={card.log} />
            </dd>
          </>
        ) : null}
        {card.owner !== undefined ? (
          <>
            <dt>Its human</dt>
            <dd>
              <Opens id={card.owner.id} open={open}>
                {card.owner.name}
              </Opens>
            </dd>
          </>
        ) : null}
        {human ? (
          <>
            <dt>Passkeys</dt>
            <dd>
              {(card.passkeys ?? []).length === 0 ? 'none' : null}
              <ul class="plain">
                {(card.passkeys ?? []).map((p) => (
                  <li key={`${p.madeOn}-${p.made}`}>
                    {p.madeOn}, made {dayWords(p.made)}, last used {dayWords(p.lastUsed)}
                    {p.synced ? ', synced' : ''}
                    {p.cloneWarning ? <strong>, maybe copied</strong> : ''}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Recovery code</dt>
            <dd>
              {(card.recoveryMade ?? 0) > 0 ? `made ${dayWords(card.recoveryMade ?? 0)}` : 'none'}
            </dd>
            <dt>Sessions</dt>
            <dd>
              {card.sessions === undefined || card.sessions.count === 0
                ? 'none'
                : `${card.sessions.count}, the latest made ${momentWords(card.sessions.latest)}`}
            </dd>
            <dt>Fleet</dt>
            <dd data-field="card-fleet">
              {(card.boats ?? []).length === 0 ? (
                fleetWords(card.fleet ?? {})
              ) : (
                <ul class="plain">
                  {(card.boats ?? []).map((b) => (
                    <li key={`${b.kind} ${b.number}`}>{cardBoatWords(b)}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Machine sailors allowed</dt>
            <dd data-field="card-cap">{card.cap ?? 0}</dd>
            <dt>Machine sailors</dt>
            <dd>
              {(card.machines ?? []).length === 0 ? 'none' : null}
              <ul class="plain">
                {(card.machines ?? []).map((m) => (
                  <li key={m.id}>
                    <Opens id={m.id} open={open}>
                      {m.name}
                    </Opens>{' '}
                    <span class="small">
                      last active {m.lastActive}
                      {m.sea !== null ? `, at sea, boat ${m.sea.boat}` : ''}
                      {m.stopped !== null ? `, ${stoppedWords(m.stopped)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : (
          <>
            <dt>Apps</dt>
            <dd>
              {(card.apps ?? []).length === 0 ? 'none' : null}
              <ul class="plain">
                {(card.apps ?? []).map((a) => (
                  <li key={a.id}>
                    {a.name} <span class="small">{appWords(a)}</span>
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Connection token</dt>
            <dd>
              {card.token == null
                ? 'none'
                : `made ${dayWords(card.token.made)}, last used ${dayWords(card.token.lastUsed)}, ${
                    card.token.ended ? 'ended' : `ends ${dayWords(card.token.ends)}`
                  }`}
            </dd>
          </>
        )}
        <CardReports
          names={[card.name, ...(card.machines ?? []).map((m) => m.name)]}
          openReports={openReports}
        />
        <dt>Flags</dt>
        <dd>
          <AccountBoxes
            account={card.id}
            sailor={card.name}
            tools={card.tools}
            priority={card.priority}
            everyBoat={{
              on: card.everyBoat ?? false,
              act: (body, what) => actHere('every-boat', body, what),
            }}
            human={human}
            act={actHere}
          />
        </dd>
      </dl>
      {human ? <Cap key={`cap-${card.id}`} card={card} act={actHere} /> : null}
      <Hand
        key={`hand-${card.id}`}
        card={card}
        act={act}
        done={(verb) => {
          changed();
          if (verb === 'delete') {
            open(null);
          } else {
            readAgain(undefined);
          }
        }}
      />
      <h3>The record</h3>
      {(card.actions ?? []).length === 0 ? (
        <p class="small">Nothing done to it yet.</p>
      ) : (
        <table class="record">
          <tbody>
            {(card.actions ?? []).map((a) => (
              <tr key={`${a.at}-${a.action}-${a.account}`}>
                <td>{momentWords(a.at)}</td>
                <td>{a.action}</td>
                <td>
                  {a.account !== card.id ? (
                    <>
                      <bdi>{a.name}</bdi>:{' '}
                    </>
                  ) : null}
                  {a.detail}
                </td>
                <td class="small">
                  {a.source === 'command' ? 'by the command' : 'from the page'}
                  {a.from !== '' ? `, ${a.from}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The Accounts tab: the counts and the search beside the card of the
 * account opened, if one is.
 */
export function AccountsTab({
  accounts,
  shown,
  chosen,
  open,
  showBoat,
  openReports,
  act,
}: {
  accounts: AccountsData | null;
  shown: boolean;
  chosen: string | null;
  open: (id: string | null) => void;
  showBoat: (boat: number, east: number, north: number) => void;
  openReports: (name: string) => void;
  act: Act;
}) {
  const [again, searchAgain] = useReducer((n: number) => n + 1, 0);
  // Nothing is read before the tab is first shown; once it has been, what
  // was searched for and opened is kept while another tab is.
  const seen = useRef(false);
  seen.current ||= shown;
  if (!seen.current) {
    return <main class="accounts-tab" hidden />;
  }
  return (
    <main class="accounts-tab" hidden={!shown}>
      <div class="accounts-list">
        <section class="tiles" aria-label="Accounts" data-field="account-counts">
          {accounts === null ? (
            <p class="small">Counting the accounts.</p>
          ) : (
            countsTiles(accounts).map((t) => (
              <div class="tile" key={t.label}>
                <span class="tile-label">{t.label}</span>
                <strong class="tile-value">{t.value}</strong>
                <span class="tile-note">{t.note}</span>
              </div>
            ))
          )}
        </section>
        <Search open={open} chosen={chosen} again={again} />
      </div>
      <aside>
        {chosen !== null ? (
          <Card
            key={chosen}
            id={chosen}
            shown={shown}
            open={open}
            showBoat={showBoat}
            openReports={openReports}
            act={act}
            changed={() => searchAgain(undefined)}
          />
        ) : (
          <section class="card account-card empty-card" aria-label="The account">
            <h2>No account open</h2>
            <p class="small">Pick a sailor from the list, or from the world's boats and queue.</p>
          </section>
        )}
      </aside>
    </main>
  );
}

/**
 * The Settings tab: the owner's settings for everyone, a card each: sign-in
 * for AI apps, links to come aboard with chat and new sailors, and racing.
 */
export function SettingsTab({
  accounts,
  shown,
  act,
}: {
  accounts: AccountsData | null;
  shown: boolean;
  act: Act;
}) {
  // Nothing is read before the tab is first shown.
  const seen = useRef(false);
  seen.current ||= shown;
  if (!seen.current) {
    return <main class="settings-tab" hidden />;
  }
  return (
    <main class="settings-tab" hidden={!shown}>
      {accounts === null ? (
        <section class="card">
          <p class="small">Reading the settings.</p>
        </section>
      ) : (
        <>
          <SailWithSettings act={act} />
          <div class="settings-column">
            <AISignIn accounts={accounts} act={act} />
            <RacingSettings act={act} />
          </div>
        </>
      )}
    </main>
  );
}

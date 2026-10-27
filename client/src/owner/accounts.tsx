// SPDX-License-Identifier: AGPL-3.0-only

// The world page's Accounts tab: the players' accounts counted, searched
// by a name or part of one, an account's id, or a token or session pasted
// in, which goes to keel in a POST's body alone and is never kept; the
// accounts found a page at a time, in the order asked for; and an
// account's card, read again every few seconds while it is shown, with the
// owner's hand on it: stopped, started again, its tokens revoked or
// deleted, each that cannot be taken back first counted by keel and
// confirmed in the card with keel's own words; its owner's flag, priority
// and machine sailors allowed. The token lifetime of AI apps is set here
// too. An account's flag and priority are also on the world's tab, beside
// its boat and its place in the queue.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { formatPosition } from '../chart/position';
import {
  actionBody,
  appWords,
  checked,
  countsWords,
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
  type SearchAnswer,
  type Sort,
  searchAccounts,
} from './api';
import { hidden } from './life';
import type { Act } from './lifecycle';
import { AISignIn, MAX_CAP, plural } from './machines';

/** How often the card shown is read again, ms. */
export const CARD_EVERY = 5000;

/**
 * An account's flag or its priority: what was clicked holds until the
 * world's reading agrees, so a reading still on its way does not set the
 * box back.
 */
function AccountBox({
  name,
  label,
  on,
  disabled,
  flag,
}: {
  name: 'flag' | 'priority';
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

/** An account's owner's flag, for a human's account alone, and its priority, for any. */
export function AccountBoxes({
  account,
  sailor,
  tools,
  priority,
  human,
  act,
}: {
  account: string;
  sailor: string;
  tools: boolean;
  priority: boolean;
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
    <section class="card" aria-label="Search">
      <h2>Search</h2>
      <form
        class="search"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked({ ...asked, text: text.trim(), page: 0 });
        }}
      >
        <input
          type="text"
          name="search"
          autocomplete="off"
          spellcheck={false}
          placeholder="a name or part of one, an id, a token"
          aria-label="A name or part of one, an account's id, or a token"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button type="submit" name="find">
          Find
        </button>
        <select
          name="sort"
          aria-label="The order"
          value={asked.sort}
          onChange={(e) => setAsked({ ...asked, sort: e.currentTarget.value as Sort, page: 0 })}
        >
          {(Object.keys(SORTS) as Sort[]).map((s) => (
            <option key={s} value={s}>
              {SORTS[s]}
            </option>
          ))}
        </select>
      </form>
      {why !== '' ? <p class="small error">{why}</p> : null}
      {answer !== null && answer.note !== '' ? <p data-field="search-note">{answer.note}</p> : null}
      {answer !== null ? (
        <>
          <p class="small" data-field="search-total">
            {plural(answer.total, 'human')} found
            {answer.pages > 1 ? `, page ${answer.page + 1} of ${answer.pages}` : ''}.
          </p>
          <table class="accounts">
            <thead>
              <tr>
                <th>Sailor</th>
                <th>Human or machine</th>
                <th>Made</th>
                <th>Last active</th>
                <th>Its machine sailors last active</th>
                <th>At sea</th>
                <th>Flags</th>
                <th>Stopped</th>
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
                    <bdi>{r.name}</bdi>
                  </td>
                  <td>human</td>
                  <td>{dayWords(r.made)}</td>
                  <td title={momentWords(r.lastActiveAt)}>{r.lastActive}</td>
                  <td class="small">
                    {r.machines.map((m) => (
                      <span key={m.id} class="side">
                        <Opens id={m.id} open={open}>
                          {m.name}
                        </Opens>
                        : {m.lastActive}
                      </span>
                    ))}
                  </td>
                  <td>{r.atSea ? 'at sea' : r.queued ? 'waiting' : ''}</td>
                  <td>
                    {[r.tools ? 'owner’s' : '', r.priority ? 'priority' : '']
                      .filter((w) => w !== '')
                      .join(', ')}
                  </td>
                  <td data-field="row-stopped">{r.stopped ? 'stopped' : ''}</td>
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
                        <bdi>{m.name}</bdi>
                      </td>
                      <td>machine sailor</td>
                      <td>{dayWords(m.made)}</td>
                      <td title={momentWords(m.lastActiveAt)}>{m.lastActive}</td>
                      <td />
                      <td>{m.atSea ? 'at sea' : m.queued ? 'waiting' : ''}</td>
                      <td>{m.priority ? 'priority' : ''}</td>
                      <td>{m.stopped ? 'stopped' : ''}</td>
                    </tr>
                  )),
              ])}
            </tbody>
          </table>
          {answer.pages > 1 ? (
            <p>
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

/** An account's card: what it is, what it has, what was done to it, and the owner's hand on it. */
function Card({
  id,
  shown,
  open,
  showBoat,
  act,
  changed,
}: {
  id: string;
  shown: boolean;
  open: (id: string | null) => void;
  showBoat: (boat: number, east: number, north: number) => void;
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
        <dd>{card.lookWords ?? card.look}</dd>
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
            <dd>{fleetWords(card.fleet ?? {})}</dd>
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
        <dt>Flags</dt>
        <dd>
          <AccountBoxes
            account={card.id}
            sailor={card.name}
            tools={card.tools}
            priority={card.priority}
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
 * The Accounts tab: the counts, the token lifetime and the search beside
 * the card of the account opened, if one is.
 */
export function AccountsTab({
  accounts,
  shown,
  chosen,
  open,
  showBoat,
  act,
}: {
  accounts: AccountsData | null;
  shown: boolean;
  chosen: string | null;
  open: (id: string | null) => void;
  showBoat: (boat: number, east: number, north: number) => void;
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
        <section class="card" aria-label="Accounts">
          <h2>Accounts</h2>
          <p data-field="account-counts">{accounts === null ? '—' : countsWords(accounts)}</p>
        </section>
        {accounts !== null ? <AISignIn accounts={accounts} act={act} /> : null}
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
            act={act}
            changed={() => searchAgain(undefined)}
          />
        ) : (
          <section class="card account-card" aria-label="The account">
            <p class="small">Open an account found, or one from the world's boats and queue.</p>
          </section>
        )}
      </aside>
    </main>
  );
}

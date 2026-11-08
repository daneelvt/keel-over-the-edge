// SPDX-License-Identifier: AGPL-3.0-only

// The world page's Reports tab: the reports open, a child's safety first
// and marked plainly, read again every 10 s while the tab is shown; and a
// report opened whole beside them, with the lines it holds and the owner's
// hand on it. Each action is first checked by keel and confirmed with its
// words, then done, and the queue read again. What players wrote, lines,
// notes and notices, is shown as text, never as markup.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import {
  control,
  getJSON,
  getReport,
  type QueueRow,
  type ReportAnswer,
  type ReportPage,
} from './api';
import { hidden } from './life';
import type { Act } from './lifecycle';
import {
  ACTIONS,
  actBody,
  actDoneWords,
  actKey,
  actProblem,
  bandWords,
  dangerous,
  filterQueue,
  handActions,
  isoWords,
  type LineAt,
  lineTime,
  NOTHING_TYPED,
  nextReportFlow,
  queueCountsWords,
  queueWords,
  type ReportAction,
  type ReportFlow,
  type ReportTyped,
  reasonWords,
  sourceWords,
  takingWords,
  waitedWords,
} from './reportwords';

/** How often the queue, and the report open, are read again, ms. */
export const QUEUE_EVERY = 10_000;

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
    <button type="button" class="link" data-account={id} onClick={() => open(id)}>
      {children}
    </button>
  );
}

/** A sailor's name, and a machine sailor marked. */
function Sailor({ name, machine }: { name: string | undefined; machine?: boolean | undefined }) {
  if (name === undefined || name === '') {
    return <span class="small">nobody named</span>;
  }
  return (
    <>
      <bdi>{name}</bdi>
      {machine === true ? <span class="small"> (machine sailor)</span> : null}
    </>
  );
}

/** The queue: a row a report open, in keel's order. */
function Queue({
  rows,
  why,
  now,
  filter,
  setFilter,
  chosen,
  choose,
}: {
  rows: QueueRow[] | null;
  why: string;
  now: number;
  filter: string;
  setFilter: (f: string) => void;
  chosen: string | null;
  choose: (id: string) => void;
}) {
  const shown = rows === null ? [] : filterQueue(rows, filter);
  return (
    <section class="card" aria-label="Reports">
      <h2>Reports</h2>
      <p data-field="queue-counts">{rows === null ? '—' : queueWords(rows)}</p>
      {why !== '' ? <p class="small error">{why}</p> : null}
      <form class="search" onSubmit={(e) => e.preventDefault()}>
        <input
          type="text"
          name="reports-filter"
          autocomplete="off"
          spellcheck={false}
          placeholder="a name, or part of one"
          aria-label="Only the reports by or on this name"
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        {filter !== '' ? (
          <button type="button" name="all-reports" onClick={() => setFilter('')}>
            Every report
          </button>
        ) : null}
      </form>
      {rows !== null && rows.length > 0 ? (
        <table class="reports">
          <thead>
            <tr>
              <th>Reason</th>
              <th>Who</th>
              <th>Where</th>
              <th>Open, held</th>
              <th>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                data-report={r.id}
                class={`${r.urgent === true ? 'urgent' : ''} ${chosen === r.id ? 'chosen' : ''}`}
                onClick={() => choose(r.id)}
              >
                <td>
                  {r.urgent === true ? (
                    <strong class="urgent-mark" data-field="row-urgent">
                      A child’s safety
                    </strong>
                  ) : (
                    reasonWords(r.reason)
                  )}
                </td>
                <td>
                  {r.reporter !== undefined && r.reporter !== '' ? (
                    <>
                      <Sailor name={r.reporter} /> reported{' '}
                      <Sailor name={r.reported} machine={r.machine} />
                    </>
                  ) : (
                    <>
                      {sourceWords(r.source)}: <Sailor name={r.reported} machine={r.machine} />
                    </>
                  )}
                </td>
                <td class="small">
                  <bdi>{r.place ?? ''}</bdi>
                </td>
                <td class="small" data-field="row-counts">
                  {queueCountsWords(r)}
                </td>
                <td title={isoWords(r.made)}>{waitedWords(r.made, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {rows !== null && rows.length > 0 && shown.length === 0 ? (
        <p class="small">No report open by or on that name.</p>
      ) : null}
    </section>
  );
}

/**
 * The owner's hand on a report: the fields an action reads, a button an
 * action, each checked by keel first and confirmed with its words.
 * Changing what is typed closes a confirmation open.
 */
function useHand(report: ReportPage, act: Act, done: () => void) {
  const [typed, setTyped] = useState<ReportTyped>(NOTHING_TYPED);
  const [flow, step] = useReducer(nextReportFlow, { step: 'idle' } as ReportFlow);
  const [why, setWhy] = useState('');
  const reported = report.reported ?? '';

  const edit = (t: ReportTyped): void => {
    setTyped(t);
    setWhy('');
    step({ kind: 'edit' });
  };

  const ask = (a: ReportAction, line?: LineAt): void => {
    const wrong = actProblem(a, typed, reported, report.days);
    if (wrong !== '') {
      setWhy(wrong);
      return;
    }
    setWhy('');
    const key = actKey(a, line);
    const body = actBody(a, report.id, typed, line);
    step({ kind: 'check', key });
    void control('reports/act', { ...body, check: true })
      .then((ans) => {
        if (!ans.ok) {
          setWhy(`Refused (${ans.status}): ${ans.text}`);
          step({ kind: 'refused' });
          return;
        }
        const words = (JSON.parse(ans.text) as ReportAnswer).words;
        step({ kind: 'ask', key, body, words, what: actDoneWords(a, reported, typed.days) });
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
    const { body, what } = flow;
    step({ kind: 'confirm' });
    void act('reports/act', body, what).then((ok) => {
      step({ kind: 'done' });
      if (ok) {
        setTyped(NOTHING_TYPED);
      }
      done();
    });
  };

  return { typed, edit, flow, step, why, ask, confirm };
}

type Hand = ReturnType<typeof useHand>;

/** The confirmation of an action checked: keel's words, then Confirm or Cancel. */
function Confirmation({ hand }: { hand: Hand }) {
  const { flow } = hand;
  if (flow.step !== 'asked' && flow.step !== 'sending') {
    return null;
  }
  return (
    <div class="confirm" data-field="report-confirmation" data-action={flow.body.action}>
      <p data-field="report-words">{flow.words}</p>
      <button
        type="button"
        name="confirm"
        disabled={flow.step === 'sending'}
        onClick={hand.confirm}
      >
        Confirm
      </button>{' '}
      <button type="button" name="cancel" onClick={() => hand.step({ kind: 'cancel' })}>
        Cancel
      </button>
    </div>
  );
}

/** The fields and buttons of the owner's hand. */
function HandControls({ report, hand }: { report: ReportPage; hand: Hand }) {
  const { typed, edit } = hand;
  const busy = hand.flow.step === 'checking' || hand.flow.step === 'sending';
  const actions = handActions(report.actions, (report.held ?? '') !== '');
  return (
    <div class="hand">
      <h3>The owner's hand</h3>
      <form class="reason" onSubmit={(e) => e.preventDefault()}>
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
          name="seen"
          autocomplete="off"
          placeholder="what was seen, told to the player"
          aria-label="What was seen, told to the player in the statement of reasons"
          value={typed.note}
          onInput={(e) => edit({ ...typed, note: e.currentTarget.value })}
        />
        <select
          name="days"
          aria-label="How long a mute from chat lasts"
          value={String(typed.days)}
          onChange={(e) => edit({ ...typed, days: Number(e.currentTarget.value) })}
        >
          {report.days.map((d) => (
            <option key={d} value={String(d)}>
              {d === 1 ? '1 day' : `${d} days`}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="referred"
          autocomplete="off"
          placeholder="referred to whom, and its reference"
          aria-label="To whom it was referred, and its reference"
          value={typed.referred}
          onInput={(e) => edit({ ...typed, referred: e.currentTarget.value })}
        />
        <input
          type="text"
          name="delete-name"
          autocomplete="off"
          spellcheck={false}
          placeholder="the reported name again, to delete"
          aria-label="The reported sailor's name again, to delete them"
          value={typed.name}
          onInput={(e) => edit({ ...typed, name: e.currentTarget.value })}
        />
      </form>
      <p>
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            name={a}
            class={dangerous(a) ? 'danger' : ''}
            disabled={busy}
            onClick={() => hand.ask(a)}
          >
            {a === 'mute-chat'
              ? `${ACTIONS[a]}, ${typed.days === 1 ? '1 day' : `${typed.days} days`}`
              : ACTIONS[a]}
          </button>
        ))}
      </p>
      {hand.why !== '' ? (
        <p class="small error" data-field="report-why">
          {hand.why}
        </p>
      ) : null}
    </div>
  );
}

/** A report whole, and the owner's hand on it. */
function Report({
  report,
  now,
  openAccount,
  act,
  done,
}: {
  report: ReportPage;
  now: number;
  openAccount: (id: string) => void;
  act: Act;
  done: () => void;
}) {
  const hand = useHand(report, act, done);
  const busy = hand.flow.step === 'checking' || hand.flow.step === 'sending';
  const taking = takingWords(report.taking, now);
  const n = report.notice;
  return (
    <section class="card report-card" aria-label="The report" data-report={report.id}>
      <h2>
        {report.reason === 'child' ? (
          <strong class="urgent-mark" data-field="report-urgent">
            A child’s safety:{' '}
          </strong>
        ) : null}
        {reasonWords(report.reason)}
      </h2>
      <dl>
        <dt>Made</dt>
        <dd>
          {isoWords(report.made)}, by {sourceWords(report.source)}; waiting{' '}
          {waitedWords(report.made, now)}
        </dd>
        {report.reporter !== undefined && report.reporter !== '' ? (
          <>
            <dt>Reported by</dt>
            <dd data-field="report-reporter">
              <Sailor name={report.reporter} />
            </dd>
          </>
        ) : null}
        <dt>Reported</dt>
        <dd data-field="report-reported">
          <Sailor name={report.reported} machine={report.machine} />
          {report.account !== undefined ? (
            <>
              {' '}
              <Opens id={report.account} open={openAccount}>
                its card
              </Opens>
            </>
          ) : null}
        </dd>
        {report.owner !== undefined ? (
          <>
            <dt>Its human</dt>
            <dd data-field="report-owner">
              <Opens id={report.owner} open={openAccount}>
                the machine sailor’s owner’s card
              </Opens>
            </dd>
          </>
        ) : null}
        {report.place !== undefined && report.place !== '' ? (
          <>
            <dt>Where</dt>
            <dd>
              <bdi>{report.place}</bdi>
            </dd>
          </>
        ) : null}
        {report.people.length > 0 ? (
          <>
            <dt>Aboard</dt>
            <dd data-field="report-people">
              <ul class="plain">
                {report.people.map((p) => (
                  <li key={`${p.name}-${p.band}`}>
                    <Sailor name={p.name} machine={p.machine} />
                    <span class="small">
                      , {bandWords(p.band)}
                      {p.skipper === true ? ', skipper' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {report.note !== undefined && report.note !== '' ? (
          <>
            <dt>The note</dt>
            <dd class="said" data-field="report-note">
              {report.note}
            </dd>
          </>
        ) : null}
        {report.closed !== undefined ? (
          <>
            <dt>Closed</dt>
            <dd data-field="report-outcome">
              {isoWords(report.closed)}: {report.outcome ?? ''}
            </dd>
          </>
        ) : null}
        {report.held !== undefined ? (
          <>
            <dt>Held</dt>
            <dd data-field="report-held">until {isoWords(report.held)}</dd>
          </>
        ) : null}
        {report.referred !== undefined ? (
          <>
            <dt>Referred</dt>
            <dd class="said" data-field="report-referred">
              {report.referred}
            </dd>
          </>
        ) : null}
      </dl>
      {taking !== '' ? (
        <p class="message" data-field="report-taking">
          {taking}
        </p>
      ) : null}
      {n !== undefined ? (
        <>
          <h3>The notice</h3>
          <dl data-field="report-notice">
            <dt>From</dt>
            <dd class="said">{n.Who}</dd>
            <dt>Reached at</dt>
            <dd class="said">{n.Contact}</dd>
            <dt>The sailor named</dt>
            <dd class="said">{n.Sailor === '' ? '—' : n.Sailor}</dd>
            <dt>Where and when</dt>
            <dd class="said">{n.Happened === '' ? '—' : n.Happened}</dd>
            <dt>What</dt>
            <dd class="said">{n.What}</dd>
          </dl>
        </>
      ) : null}
      <h3>The lines it holds</h3>
      {report.lines.length === 0 ? (
        <p class="small">None.</p>
      ) : (
        <table class="lines" data-field="report-lines">
          <tbody>
            {report.lines.map((l) => (
              <tr
                key={`${l.line}-${l.at}`}
                data-line={l.line}
                class={l.reported === true ? 'reported' : ''}
              >
                <td class="small" title={isoWords(l.at)}>
                  {lineTime(l.at)}
                </td>
                <td>
                  <Sailor name={l.name} machine={l.machine} />
                  {l.reported === true ? (
                    <strong class="urgent-mark" data-field="line-reported">
                      {' '}
                      reported
                    </strong>
                  ) : null}
                </td>
                <td class="said">{l.text}</td>
                <td>
                  <button
                    type="button"
                    name="remove-line"
                    disabled={busy}
                    onClick={() => hand.ask('remove-line', { line: l.line, at: l.at })}
                  >
                    {ACTIONS['remove-line']}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.notes.length > 0 ? (
        <>
          <h3>Notes</h3>
          <ul class="plain" data-field="report-notes">
            {report.notes.map((x) => (
              <li key={`${x.at}-${x.by}`}>
                <span class="small">
                  {isoWords(x.at)}, {x.by === 'player' ? 'the player’s answer' : 'the owner'}:
                </span>{' '}
                <span class="said">{x.text}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <HandControls report={report} hand={hand} />
      <Confirmation hand={hand} />
    </section>
  );
}

/**
 * The Reports tab: the queue beside the report opened, if one is. Nothing
 * is read before the tab is first shown, nor while it is hidden.
 */
export function ReportsTab({
  shown,
  filter,
  setFilter,
  openAccount,
  act,
}: {
  shown: boolean;
  filter: string;
  setFilter: (f: string) => void;
  openAccount: (id: string) => void;
  act: Act;
}) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [why, setWhy] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [report, setReport] = useState<ReportPage | null>(null);
  const [reportWhy, setReportWhy] = useState('');
  const [now, setNow] = useState(Date.now());
  const [reads, readAgain] = useReducer((n: number) => n + 1, 0);
  const seen = useRef(false);
  seen.current ||= shown;

  // The queue, and the report open, at once and every 10 s while shown,
  // paused while the page is hidden; at once again on its showing.
  useEffect(() => {
    if (!shown) {
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      setNow(Date.now());
      getJSON<QueueRow[]>('reports.json')
        .then((q) => {
          if (live) {
            setRows(q);
            setWhy('');
          }
        })
        .catch((e: unknown) => live && setWhy(String(e)));
      if (chosen !== null) {
        getReport(chosen)
          .then((r) => {
            if (live) {
              setReport(r);
              setReportWhy('');
            }
          })
          .catch((e: unknown) => {
            if (!live) {
              return;
            }
            // A report deleted with its account is gone.
            setReport(null);
            setReportWhy(
              String(e).includes(': 404 ')
                ? 'The report is gone: deleted with its account.'
                : String(e),
            );
          });
      }
    };
    read();
    const t = setInterval(read, QUEUE_EVERY);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', read);
    };
  }, [shown, chosen, reads]);

  if (!seen.current) {
    return <main class="accounts-tab reports-tab" hidden />;
  }
  const choose = (id: string): void => {
    if (id !== chosen) {
      setReport(null);
      setReportWhy('');
      setChosen(id);
    }
  };
  return (
    <main class="accounts-tab reports-tab" hidden={!shown}>
      <div class="accounts-list">
        <Queue
          rows={rows}
          why={why}
          now={now}
          filter={filter}
          setFilter={setFilter}
          chosen={chosen}
          choose={choose}
        />
      </div>
      <aside>
        {report !== null && report.id === chosen ? (
          <Report
            key={report.id}
            report={report}
            now={now}
            openAccount={openAccount}
            act={act}
            done={() => readAgain(undefined)}
          />
        ) : (
          <section class="card report-card" aria-label="The report">
            <p class={reportWhy === '' ? 'small' : 'small error'}>
              {reportWhy !== ''
                ? reportWhy
                : chosen === null
                  ? 'Open a report from the queue.'
                  : 'Reading the report…'}
            </p>
          </section>
        )}
      </aside>
    </main>
  );
}

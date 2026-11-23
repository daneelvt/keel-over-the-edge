// SPDX-License-Identifier: AGPL-3.0-only

// The Races page, from the menu and in its place: the player's next race
// with its countdown and its main key (Start now, for a race of theirs no
// one else is in yet, or See); every race they made or are in and not yet
// over, each saying which, with Delete or Cancel the race on their own;
// what can be sailed now (the next harbour race with Enter, and a few of
// the Harbourmaster's standing time trials with Sail); and Make a race.
// A tap on a race opens its card.

import './races.css';
import { batch } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { nextHarbourLine, nextHarbourRace } from './menu';
import { PlayerText } from './player';
import { type RaceVerb, raceAct, type Summary } from './raceapi';
import { nextRace } from './racenotices';
import { RowReason, UpwindSign } from './racerow';
import type { RacesView } from './raceslazy';
import {
  CALLED_OFF,
  CANCEL_RACE,
  DELETE,
  ENTER,
  ENTERED,
  enteredLine,
  enterRefusalText,
  inText,
  KEEP_IT,
  MAKE_A_RACE,
  NO_RACES_YET,
  RACES,
  SAIL,
  SAIL_NOW,
  SEE,
  START_NOW,
  START_NOW_LINE,
  startsInText,
  TRIAL_LINE,
  takeAwayAsk,
  trialText,
  whenLine,
  YOU_MADE_IT,
  YOUR_NEXT_RACE,
  YOUR_RACES,
} from './racewords';
import { Sheet } from './sheet';

/** How many of the Harbourmaster's standing trials the page offers. */
const TRIALS_SHOWN = 3;

/** Whether a race on the board is still before its start. */
function before(s: Summary): boolean {
  return s.phase === 'open' || s.phase === 'closed';
}

/** Whether no one but its owner, the player, is in a race of theirs. */
function aloneIn(s: Summary): boolean {
  return s.entered <= (s.mine.entered ? 1 : 0);
}

/** A race's row's line: whose, when, and how many are in. */
export function rowLine(s: Summary, now: number): string {
  const when =
    s.phase === 'cancelled' && s.calledOff === 'storm'
      ? CALLED_OFF
      : s.kind === 'trial'
        ? trialText(s.boat.name)
        : whenLine(s.startsAt, now);
  return [s.mine.owner ? YOU_MADE_IT : ENTERED, when, inText(s.entered)].join(' · ');
}

/**
 * The owner's key to take their race away, asked once: Delete while no one
 * but them is in, Cancel the race once others are (they are told). Either
 * way it goes from every list.
 */
export function TakeAway({
  name,
  others,
  busy,
  take,
}: {
  name: string;
  others: boolean;
  busy: boolean;
  take: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const key = others ? CANCEL_RACE : DELETE;
  return asking ? (
    <fieldset class="race-ask" aria-label={key} data-readout="race-take-away">
      <p class="race-faint">{takeAwayAsk(name, others)}</p>
      <div class="race-keys">
        <button type="button" class="menu-race" onClick={() => setAsking(false)}>
          {KEEP_IT}
        </button>
        <button type="button" class="menu-race race-danger" disabled={busy} onClick={take}>
          {key}
        </button>
      </div>
    </fieldset>
  ) : (
    <button
      type="button"
      class="menu-race race-take"
      disabled={busy}
      onClick={() => setAsking(true)}
    >
      {key}
    </button>
  );
}

/** The Races page: the player's races, what may be sailed now, and Make a race. */
export function RacesPage({ view }: { view: RacesView }) {
  const board = view.board.value;
  const [now, setNow] = useState(() => view.now());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => {
    void view.refresh();
    const t = setInterval(() => setNow(view.now()), 1000);
    return () => clearInterval(t);
  }, [view]);
  const close = () => {
    view.page.value = false;
  };
  const open = (code: string) => {
    batch(() => {
      view.page.value = false;
      view.card.value = code;
    });
  };
  const act = (code: string, verb: RaceVerb, done: (name: string) => string, leave = false) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSaid('');
    void raceAct(code, verb, verb === 'enter' ? { crew: false } : undefined, view.fetch).then(
      (a) => {
        setBusy(false);
        void view.refresh();
        if (a.ok) {
          if (leave) {
            close();
            return;
          }
          setSaid(done(a.value.name));
          return;
        }
        const t = {
          until: a.refusal.until,
          needs: a.refusal.needs,
          most: a.refusal.most,
          race: a.refusal.race,
          now: view.now(),
        };
        setSaid(enterRefusalText(a.refusal.reason, t));
      },
    );
  };
  const next = board === null ? null : nextRace(board);
  const mine = board?.mine ?? [];
  const harbour = nextHarbourRace(board?.harbour ?? []);
  const trials = (board?.trials ?? []).slice(0, TRIALS_SHOWN);
  return (
    <Sheet name="races" title={RACES} cls="races-page" close={close}>
      {board === null ? (
        <p class="race-faint" aria-live="polite">
          Reading the races…
        </p>
      ) : null}
      {next !== null ? (
        <section class="races-part" aria-label={YOUR_NEXT_RACE} data-readout="races-next">
          <h3>{YOUR_NEXT_RACE}</h3>
          <p class="races-next-name">
            <PlayerText text={next.name} />
          </p>
          <p class="race-faint" data-readout="races-next-when">
            {whenLine(next.startsAt, now)}
            {before(next) ? ` · ${startsInText(next.startsAt - now)}` : ''}
          </p>
          {next.mine.owner && before(next) && aloneIn(next) ? (
            <>
              <p class="race-faint">{START_NOW_LINE}</p>
              <div class="races-keys">
                <button
                  type="button"
                  class="menu-race key-main"
                  disabled={busy}
                  onClick={() => act(next.code, 'start', () => '', true)}
                >
                  {START_NOW}
                </button>
                <button type="button" class="menu-race" onClick={() => open(next.code)}>
                  {SEE}
                </button>
              </div>
            </>
          ) : (
            <div class="races-keys">
              <button type="button" class="menu-race" onClick={() => open(next.code)}>
                {SEE}
              </button>
            </div>
          )}
        </section>
      ) : null}
      {board !== null ? (
        <section class="races-part" aria-label={YOUR_RACES} data-readout="races-mine">
          <h3>{YOUR_RACES}</h3>
          {mine.length === 0 ? <p class="race-faint">{NO_RACES_YET}</p> : null}
          {mine.map((s) => (
            <div key={s.code} class="races-row" data-race={s.code}>
              <button
                type="button"
                class="menu-race menu-race-mine menu-race-words"
                onClick={() => open(s.code)}
              >
                <span class="menu-race-name">{s.name}</span>
                <span class="menu-race-when" data-readout="races-row-line">
                  {rowLine(s, now)}
                </span>
              </button>
              {s.mine.owner && before(s) ? (
                <TakeAway
                  name={s.name}
                  others={!aloneIn(s)}
                  busy={busy}
                  take={() => act(s.code, 'cancel', () => '')}
                />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {harbour !== null || trials.length > 0 ? (
        <section class="races-part" aria-label={SAIL_NOW} data-readout="races-now">
          <h3>{SAIL_NOW}</h3>
          {harbour !== null ? (
            <div class="races-row menu-race-next" data-race={harbour.code}>
              <button
                type="button"
                class="menu-race menu-race-mine menu-race-words"
                onClick={() => open(harbour.code)}
              >
                <span class="menu-race-name">{nextHarbourLine(harbour, now)}</span>
              </button>
              {harbour.mine.entered ? (
                <span class="race-row-reason">{ENTERED}</span>
              ) : harbour.enter.ok ? (
                <button
                  type="button"
                  class="menu-race menu-race-enter"
                  disabled={busy}
                  aria-label={`${ENTER} ${harbour.name}`}
                  onClick={() => act(harbour.code, 'enter', enteredLine)}
                >
                  {ENTER}
                </button>
              ) : (
                <RowReason enter={harbour.enter} />
              )}
            </div>
          ) : null}
          {trials.map((s) => (
            <div key={s.code} class="races-row menu-race-next" data-race={s.code}>
              <button
                type="button"
                class="menu-race menu-race-mine menu-race-words"
                onClick={() => open(s.code)}
              >
                <span class="menu-race-name">
                  {s.name}
                  {s.upwind === true ? <UpwindSign /> : null}
                </span>
              </button>
              {s.mine.entered ? (
                <span class="race-row-reason">{ENTERED}</span>
              ) : s.enter.ok ? (
                <button
                  type="button"
                  class="menu-race menu-race-enter"
                  disabled={busy}
                  aria-label={`${SAIL} ${s.name}`}
                  onClick={() => act(s.code, 'enter', () => TRIAL_LINE, true)}
                >
                  {SAIL}
                </button>
              ) : (
                <RowReason enter={s.enter} />
              )}
            </div>
          ))}
        </section>
      ) : null}
      {said !== '' ? (
        <p class="menu-note" role="status" data-readout="races-said">
          {said}
        </p>
      ) : null}
      <div class="races-keys">
        <button
          type="button"
          class="menu-race key-main"
          onClick={() => {
            batch(() => {
              view.page.value = false;
              view.make.value = true;
            });
          }}
        >
          {MAKE_A_RACE}
        </button>
      </div>
    </Sheet>
  );
}

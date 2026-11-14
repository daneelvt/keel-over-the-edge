// SPDX-License-Identifier: AGPL-3.0-only

// The spectator's screen in a race: the race bar in the watch plate's
// place at the foot, one row covering nothing, ‹ the place and the name ›,
// the cheer key and ⋯, the race, the leg and the gap engraved small over
// the name; the standings, a sheet up from the foot over the room where
// the helm would be, a row a boat to watch; the bar's ⋯, follow the
// action, the standings, watch another and sail. And for spectators and
// racers alike, the crier's line under the case, and the line after a
// cheer. Loaded with the racer's screen (raceline.tsx).

import './racebar.css';
import { useEffect, useState } from 'preact/hooks';
import { trackColour } from './racecolours';
import type { RaceSource } from './raceline';
import { entrantName } from './racestate';
import { CHEER_EVERY } from './racewatch';
import {
  AHEAD,
  BEHIND,
  barWords,
  CHEER,
  CHEER_WAIT,
  FOLLOW,
  FOLLOW_DETAIL,
  RACE_MORE,
  STANDINGS,
  standingRows,
} from './racewatchwords';
import { Window } from './racewindow';

/** How often the bar is read again, ms: the countdown, the cheer key's ring. */
const BAR_EVERY = 250;

/** The waved tricorn hat on the cheer key: its crown behind, its brim cocked up on three sides, a gold braid and a cockade. */
function Tricorn({ up }: { up: boolean }) {
  return (
    <svg class={`rb-hat${up ? ' rb-hat-up' : ''}`} viewBox="0 0 28 20" aria-hidden="true">
      <path class="rb-hat-crown" d="M8 8 C8.5 2.5 19.5 2.5 20 8 Z" />
      <path
        class="rb-hat-brim"
        d="M1.5 5.5 C6 7.5 9.5 5.2 14 5.2 C18.5 5.2 22 7.5 26.5 5.5 C25.5 9.5 23 12 20 13.2 C18 14.2 15.8 16 14 18.2 C12.2 16 10 14.2 8 13.2 C5 12 2.5 9.5 1.5 5.5 Z"
      />
      <circle class="rb-hat-cockade" cx="8.6" cy="10.4" r="1.9" />
    </svg>
  );
}

/** The race bar, while a boat of a race is watched. */
export function RaceBar({ src }: { src: RaceSource }) {
  const r = src.racing;
  const w = src.watch ?? null;
  const told = r.told.value;
  const pic = r.picture.value;
  const eye = r.eye.value;
  const asking = w?.asking.value ?? null;
  const last = w?.lastCheer.value ?? Number.NEGATIVE_INFINITY;
  const [, setBeat] = useState(0);
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), BAR_EVERY);
    return () => clearInterval(t);
  }, []);
  if (told === null || w === null) {
    return null;
  }
  const n = asking ?? eye;
  const name = (k: number) => entrantName(told, k);
  const words = barWords(told, pic?.racers ?? [], n, src.tick(), name);
  const machine = told.entrants.find((e) => e.number === n)?.machine === true;
  const left = w.cheerLeft();
  const ready = left <= 0;
  const cheer = () => {
    if (w.cheerNow()) {
      setFlip(true);
      setTimeout(() => setFlip(false), 700);
    }
  };
  const pending = asking !== null && asking !== eye;
  return (
    <section
      class={`race-bar${pending ? ' rb-pending' : ''}`}
      aria-label={`Watching ${name(n)}`}
      data-readout="race-bar"
      data-watched={n}
      style={{ '--race-colour': trackColour(n) }}
    >
      <button type="button" class="head-key rb-step" aria-label={AHEAD} onClick={() => w.step(-1)}>
        ‹
      </button>
      <button
        type="button"
        class="rb-words"
        aria-label={STANDINGS}
        onClick={() => (w.standings.value = !w.standings.peek())}
      >
        <span class="rb-over" data-readout="race-bar-over">
          {words.over}
        </span>
        <span class="rb-whose">
          <span class="rb-dot" aria-hidden="true" />
          <span class="rb-place" data-readout="race-bar-place">
            {words.place}
          </span>
          <span class="rb-sep" aria-hidden="true">
            ·
          </span>
          <strong class="rb-name" data-readout="race-bar-name">
            {words.name.replace(/ ⚙$/, '')}
          </strong>
          {machine ? <span class="rb-cog">⚙</span> : null}
        </span>
      </button>
      <button type="button" class="head-key rb-step" aria-label={BEHIND} onClick={() => w.step(1)}>
        ›
      </button>
      <button
        type="button"
        class={`head-key rb-cheer${ready ? '' : ' rb-waiting'}${flip ? ' rb-cheered' : ''}`}
        aria-label={ready ? CHEER : CHEER_WAIT}
        aria-disabled={!ready}
        data-readout="race-cheer"
        style={{ '--cheer-left': (Math.min(left, CHEER_EVERY) / CHEER_EVERY).toFixed(3) }}
        data-cheered={Number.isFinite(last) ? 'yes' : 'no'}
        onClick={cheer}
      >
        <Tricorn up={flip} />
      </button>
      <button
        type="button"
        class="head-key rb-more"
        aria-label={RACE_MORE}
        onClick={() => (w.more.value = true)}
      >
        ⋯
      </button>
    </section>
  );
}

/** The standings, from the bar's name: a row a boat, the watched one gold; a row tapped is watched. */
export function Standings({ src }: { src: RaceSource }) {
  const r = src.racing;
  const w = src.watch ?? null;
  const told = r.told.value;
  const pic = r.picture.value;
  const eye = r.eye.value;
  if (told === null || w === null || !w.standings.value) {
    return null;
  }
  const close = () => {
    w.standings.value = false;
  };
  const rows = standingRows(told, pic?.racers ?? []);
  const boats = told.entrants.length;
  return (
    <>
      <div class="rb-scrim" aria-hidden="true" onClick={close} />
      <section class="panel rb-standings" data-panel="race-standings" aria-label={STANDINGS}>
        <h2>
          {told.name !== '' ? told.name : 'The race'}
          <span class="rb-faint"> · {boats} boats</span>
        </h2>
        <ol class="rb-rows">
          {rows.map((x) => {
            const watched = x.number === eye;
            const entrant = told.entrants.find((e) => e.number === x.number);
            return (
              <li key={x.number}>
                <button
                  type="button"
                  class={`rb-row${watched ? ' rb-watched' : ''}${x.out ? ' rb-out' : ''}`}
                  disabled={x.out}
                  data-number={x.number}
                  onClick={() => {
                    close();
                    w.switchTo(x.number);
                  }}
                >
                  <span class="rb-row-place">{x.place}</span>
                  <span class="rb-row-dot" style={{ background: trackColour(x.number) }} />
                  <span class="rb-row-name">
                    {entrantName(told, x.number).replace(/ ⚙$/, '')}
                    {entrant?.machine ? <span class="rb-cog"> ⚙</span> : null}
                    {watched ? <span class="rb-here"> ◀</span> : null}
                  </span>
                  <span class="rb-row-mark">{x.mark}</span>
                  <span class="rb-row-gap">{x.gap}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

/** The bar's ⋯: follow the action, the standings, watch another, sail. */
export function BarMore({ src }: { src: RaceSource }) {
  const w = src.watch ?? null;
  const told = src.racing.told.value;
  if (w === null || told === null || !w.more.value) {
    return null;
  }
  const close = () => {
    w.more.value = false;
  };
  const on = w.follow.value;
  return (
    <Window name="race-bar-more" title={told.name !== '' ? told.name : 'The race'} close={close}>
      <label class="rb-switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          checked={on}
          onChange={(e) => w.setFollow((e.target as HTMLInputElement).checked)}
        />
        <span>
          <strong>{FOLLOW}</strong>
          <span class="rl-faint"> {FOLLOW_DETAIL}</span>
        </span>
      </label>
      <div class="rl-keys">
        <button
          type="button"
          onClick={() => {
            close();
            w.standings.value = true;
          }}
        >
          {STANDINGS}
        </button>
        {src.another !== undefined ? (
          <button
            type="button"
            onClick={() => {
              close();
              src.another?.();
            }}
          >
            Watch another
          </button>
        ) : null}
        {src.sail !== undefined ? (
          <button
            type="button"
            onClick={() => {
              close();
              src.sail?.();
            }}
          >
            Sail
          </button>
        ) : null}
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** The crier's line over the race bar, and the line after the page's own cheer. */
export function CrierLine({ src }: { src: RaceSource }) {
  const w = src.watch ?? null;
  if (w === null) {
    return null;
  }
  const crier = w.crier.value;
  const cheered = w.cheeredText.value;
  if (crier === null && cheered === null) {
    return null;
  }
  return (
    <div class="rb-lines">
      {cheered !== null ? (
        <p class="panel crier-line rb-cheered-line" role="status" data-readout="cheered">
          {cheered.text}
        </p>
      ) : null}
      {crier !== null ? (
        <p class="panel crier-line" role="status" data-readout="crier">
          {crier.text}
        </p>
      ) : null}
    </div>
  );
}

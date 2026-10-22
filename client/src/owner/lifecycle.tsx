// SPDX-License-Identifier: AGPL-3.0-only

// The world's life on the world page: its end at the top of the page, the
// time left ticking by keel's clock, and the moment in three zones; a card
// of the closing, the next world and the jobs' last runs; the owner's hand
// on it, making a new next world, beginning the next world now or charting
// the whole world, each confirmed in the card with what it will do, so
// that no stray click does any of them.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ChartedData, Control, Lifecycle } from './api';
import { brief, countdown, hidden, inZone, ownZone, serverNow, threeZones, zoneName } from './life';

/** The world's life last read, and how far keel's clock was then ahead of the page's, ms. */
export interface Life {
  life: Lifecycle;
  offset: number;
}

/** What a control does, said when it is done. */
export type Act = (path: Control, body: unknown, what: string) => Promise<boolean>;

/** How many of the jobs' runs the card lists, the latest first. */
const RUNS = 20;

/** Draws again each second while the page is shown, for what counts down. */
function useSecond(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (!hidden()) {
        tick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);
}

/** A moment in the schedule's zone, the three zones on hovering. */
function Moment({ ms, zone }: { ms: number; zone: string }) {
  return <span title={threeZones(ms, zone, ownZone())}>{inZone(ms, zone)}</span>;
}

/** The world's end, always in view: the time left, the moment in three zones, the closing. */
export function SwitchBar({ life, error }: { life: Life | null; error: string }) {
  useSecond();
  if (life === null) {
    return error !== '' ? <p class="switch small">The world's life: {error}</p> : null;
  }
  const l = life.life;
  const now = serverNow(life.offset);
  return (
    <section class="switch" aria-label="The world's end">
      <p>
        World {l.world}
        {l.switching ? (
          <strong class="marker" data-field="switching">
            switching
          </strong>
        ) : l.closing ? (
          <strong class="marker" data-field="closing-mark">
            closing
          </strong>
        ) : null}{' '}
        {l.ends > 0 ? (
          <>
            ends in{' '}
            <strong class="countdown" data-field="countdown">
              {countdown(l.ends - now)}
            </strong>
          </>
        ) : (
          'has no end set'
        )}
      </p>
      {l.ends > 0 ? (
        <p class="small" data-field="ends">
          {threeZones(l.ends, l.zone, ownZone())}
        </p>
      ) : null}
      <p class="small">
        {l.closingFrom > 0 ? (
          <>
            Closing {now >= l.closingFrom ? 'since' : 'from'}{' '}
            <Moment ms={l.closingFrom} zone={l.zone} />.{' '}
          </>
        ) : null}
        {l.next?.stored ? (
          <>
            World {l.next.number} made <Moment ms={l.next.storedAt} zone={l.zone} />.
          </>
        ) : l.nextMadeAt > 0 ? (
          <>
            World {l.world + 1} made {now >= l.nextMadeAt ? 'since' : 'from'}{' '}
            <Moment ms={l.nextMadeAt} zone={l.zone} />.
          </>
        ) : null}
      </p>
      {error !== '' ? <p class="small error">{error}</p> : null}
    </section>
  );
}

/** A run's outcome in a word or two, its attempts beside it. */
function outcome(r: Lifecycle['runs'][number]): string {
  const o = r.finished === 0 ? 'running' : r.outcome || '—';
  return r.attempts > 1 ? `${o} (×${r.attempts})` : o;
}

/** The world's life: the closing, the next world, the jobs' last runs. */
export function LifecycleCard({ life }: { life: Life }) {
  const l = life.life;
  const n = l.next;
  const runs = [...l.runs]
    .sort((a, b) => (b.started || b.due) - (a.started || a.due))
    .slice(0, RUNS);
  return (
    <section class="card" aria-label="The world's life">
      <h2>The world's life</h2>
      <p class="small">Times in your own zone, {zoneName(life.life.now, ownZone())}.</p>
      <dl>
        <dt>Schedule</dt>
        <dd class="small">{l.schedule || '—'}</dd>
        <dt>Began</dt>
        <dd>{brief(l.began)}</dd>
        <dt>Ends</dt>
        <dd>{l.ends > 0 ? brief(l.ends) : 'no end set'}</dd>
        <dt>Closing</dt>
        <dd data-field="closing">
          {l.closing ? `yes, since ${brief(l.closingFrom)}` : `no, from ${brief(l.closingFrom)}`}
        </dd>
        {l.switching ? (
          <>
            <dt>Switching</dt>
            <dd data-field="switching">to world {l.world + 1}, under way</dd>
          </>
        ) : null}
        <dt>Next world</dt>
        {n === null ? (
          <dd data-field="next">
            {l.making
              ? `world ${l.world + 1}, being made`
              : `not made yet; made from ${brief(l.nextMadeAt)}`}
          </dd>
        ) : (
          <dd data-field="next">
            world {n.number}, seed {n.seed}; made {brief(n.created)};{' '}
            {n.stored ? `its terrain stored ${brief(n.storedAt)}` : 'its terrain not yet stored'}
            {n.attempts > 0 ? `; ${n.attempts} attempt${n.attempts === 1 ? '' : 's'}` : ''}
            {n.generationMs > 0 ? `, ${(n.generationMs / 1000).toFixed(1)} s` : ''}
            <Generator l={l} />
          </dd>
        )}
      </dl>
      {runs.length > 0 ? (
        <table class="runs">
          <thead>
            <tr>
              <th>Job</th>
              <th>Due</th>
              <th>Outcome</th>
              <th>Finished</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={`${r.job}:${r.due}:${r.started}`} data-run={r.job} data-outcome={r.outcome}>
                <td>{r.job}</td>
                <td>{brief(r.due)}</td>
                <td class={r.outcome === 'failed' ? 'error' : ''}>{outcome(r)}</td>
                <td>{r.finished > 0 ? brief(r.finished) : '—'}</td>
                <td class="small">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** What the owner's hand does to the world: makes the next world, begins it, or charts the world whole. */
export type Hand = 'make' | 'begin' | 'chart';

/** A confirmation open: its control, and the world's number it named when it was opened. */
interface Asked {
  hand: Hand;
  number: number;
}

/** Each control's name on the page, for the tests. */
const NAMES: Record<Hand, string> = {
  make: 'make-next',
  begin: 'begin-next',
  chart: 'chart-whole',
};

/** A seed in a few figures, enough to tell one from another at a glance. */
function shortSeed(seed: string): string {
  return seed.length > 6 ? `${seed.slice(0, 4)}…` : seed;
}

/** A count of subjects in words: "1 subject", "412 subjects". */
function subjects(n: number): string {
  return `${n} subject${n === 1 ? '' : 's'}`;
}

/** The generator the next world was made by, marked when keel makes worlds with a newer one. */
function Generator({ l }: { l: Lifecycle }) {
  const n = l.next;
  if (n === null || n.generator <= 0) {
    return null;
  }
  return n.generator < l.generator ? (
    <span class="error" data-field="generator-old">
      ; made by generator {n.generator}; keel makes {l.generator} now. Make a new next world to use
      it
    </span>
  ) : (
    <>; made by generator {n.generator}</>
  );
}

/**
 * The owner's hand on the world: making a new next world, beginning the
 * next world now, charting the whole world for every sailor. Each control
 * opens a confirmation in the card telling what will happen, its figures
 * live; confirmed, it sends the world's number the confirmation named when
 * it was opened, so that one left open across a switch is refused. A
 * control that cannot be used now says why beside it.
 */
export function WorldByHand({
  life,
  charted,
  act,
  hands,
}: {
  life: Life;
  charted: ChartedData | null;
  act: Act;
  hands: Hand[];
}) {
  useSecond();
  const [asked, setAsked] = useState<Asked | null>(null);
  const [sending, setSending] = useState(false);
  const l = life.life;
  const now = serverNow(life.offset);
  const n = l.next;
  const making = l.making || (n !== null && !n.stored);
  const late = l.remakeUntil > 0 && now > l.remakeUntil;
  const done = charted?.charted.length ?? 0;
  const left = charted === null ? 0 : Math.max(0, charted.subjects - done);
  const whole = charted !== null && left === 0;

  const switching = l.switching ? 'A switch is under way.' : null;
  const beingMade = making ? `World ${l.world + 1} is being made.` : null;
  const tooLate = late ? (
    <>
      Too near world {l.world}'s end: the next world could be made or begun by hand until{' '}
      <Moment ms={l.remakeUntil} zone={l.zone} />, and the scheduled switch is at{' '}
      <Moment ms={l.ends} zone={l.zone} />.
    </>
  ) : null;
  const why: Record<Hand, ComponentChildren> = {
    make: switching ?? beingMade ?? tooLate,
    begin: switching ?? beingMade ?? tooLate,
    chart: switching ?? (charted === null ? 'What is charted is not read yet.' : null),
  };

  const told: Record<Hand, ComponentChildren> = {
    make:
      n === null ? (
        l.making ? null : (
          <>
            No next world yet: world {l.world + 1} is made on the schedule{' '}
            {now >= l.nextMadeAt ? 'since' : 'from'} <Moment ms={l.nextMadeAt} zone={l.zone} />.
          </>
        )
      ) : (
        <>
          World {n.number}, seed {shortSeed(n.seed)},{' '}
          {n.stored ? (
            <>
              made <Moment ms={n.storedAt} zone={l.zone} />
            </>
          ) : (
            'being made'
          )}
          <Generator l={l} />. A new one discards it for another from a new seed.
        </>
      ),
    begin: (
      <>
        Ends world {l.world} now and begins world {l.world + 1}, as the scheduled switch would;
        world {l.world + 1} ends when world {l.world} would have.
      </>
    ),
    chart:
      charted === null ? null : (
        <>
          {done} of {subjects(charted.subjects)} of world {l.world} charted.
        </>
      ),
  };
  const label: Record<Hand, string> = {
    make: 'Make a new next world',
    begin: 'Begin the next world now',
    chart: whole ? `World ${l.world} is charted whole` : 'Chart the whole world',
  };

  /** What the confirmation says, its figures live but its number the one named at opening. */
  const ask = (a: Asked): ComponentChildren => {
    const w = a.number;
    if (a.hand === 'make') {
      if (n === null) {
        return l.nextMadeAt <= 0 ? (
          <>Make world {w} now?</>
        ) : now >= l.nextMadeAt ? (
          <>Make world {w} now? It is due to be made now on the schedule.</>
        ) : (
          <>
            Make world {w} now? It would otherwise be made on {inZone(l.nextMadeAt, l.zone)}.
          </>
        );
      }
      return (
        <>
          Discard world {n.number} (seed {shortSeed(n.seed)},{' '}
          {n.stored ? `made ${inZone(n.storedAt, l.zone)}` : 'being made'}), which no one has
          sailed, and make another from a new seed?
        </>
      );
    }
    if (a.hand === 'begin') {
      return (
        <>
          End world {w} now and begin world {w + 1}? Every boat goes with world {w}.{' '}
          {l.ends > 0 ? (
            <>
              World {w + 1} ends with the schedule on{' '}
              <span data-field="confirm-ends">{threeZones(l.ends, l.zone, ownZone())}</span>, in{' '}
              <strong data-field="confirm-countdown">{countdown(l.ends - now)}</strong>
              {l.closingFrom <= 0
                ? ''
                : now >= l.closingFrom
                  ? ', and is closing from its start'
                  : `, and is closing from ${inZone(l.closingFrom, l.zone)}`}
              .
            </>
          ) : (
            <>World {w + 1} has no end set.</>
          )}{' '}
          {n?.stored
            ? `World ${w + 1} is made (seed ${shortSeed(n.seed)}).`
            : `World ${w + 1} is made first, which takes some seconds.`}
        </>
      );
    }
    return charted === null ? (
      <>
        Chart every subject of world {w} not yet charted, for every sailor, credited to no one? It
        cannot be undone: nothing will be left to discover in world {w}.
      </>
    ) : (
      <>
        Chart the {subjects(left)} of world {w} not yet charted ({done} of {charted.subjects} are),
        for every sailor, credited to no one? It cannot be undone: nothing will be left to discover
        in world {w}.
      </>
    );
  };

  const confirm = (a: Asked): void => {
    const [path, what]: [Control, string] =
      a.hand === 'make'
        ? ['next', `world ${a.number} to be made`]
        : a.hand === 'begin'
          ? ['world', `world ${a.number} ended; world ${a.number + 1} begins`]
          : ['chart', `world ${a.number} to be charted whole`];
    setSending(true);
    void act(path, { number: a.number }, what).then(() => {
      setSending(false);
      setAsked(null);
    });
  };

  return (
    <section class="card" aria-label="The world by hand">
      <h2>The world by hand</h2>
      <p class="small">
        {l.ends > 0 ? (
          <>
            The scheduled switch: world {l.world} ends <Moment ms={l.ends} zone={l.zone} />.
            {l.remakeUntil > 0 && !late ? (
              <>
                {' '}
                The next world may be made or begun by hand until{' '}
                <Moment ms={l.remakeUntil} zone={l.zone} />.
              </>
            ) : null}
          </>
        ) : (
          `World ${l.world} has no end set.`
        )}
      </p>
      {hands.map((h) => (
        <div key={h} class="hand">
          {told[h] !== null ? <p class="small">{told[h]}</p> : null}
          <p>
            <button
              type="button"
              name={NAMES[h]}
              disabled={why[h] !== null || (h === 'chart' && whole)}
              onClick={() => setAsked({ hand: h, number: h === 'make' ? l.world + 1 : l.world })}
            >
              {label[h]}
            </button>
            {why[h] !== null ? (
              <span class="small" data-field={`${NAMES[h]}-why`}>
                {' '}
                {why[h]}
              </span>
            ) : null}
          </p>
        </div>
      ))}
      {asked !== null ? (
        <div class="confirm" data-field="confirmation" data-hand={asked.hand}>
          <p>{ask(asked)}</p>
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

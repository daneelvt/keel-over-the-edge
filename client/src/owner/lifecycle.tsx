// SPDX-License-Identifier: AGPL-3.0-only

// The world's life on the world page: its end at the top of the page, the
// time left ticking by keel's clock, and the moment in three zones; a card
// of the closing, the next world and the jobs' last runs; the owner's hand
// on it, beginning the next world now or making the next world again, each
// with a number typed so that no stray click does either.

import { useEffect, useState } from 'preact/hooks';
import type { Control, Lifecycle } from './api';
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
          <dd data-field="next">not made yet; made from {brief(l.nextMadeAt)}</dd>
        ) : (
          <dd data-field="next">
            world {n.number}, seed {n.seed}; made {brief(n.created)};{' '}
            {n.stored ? `its terrain stored ${brief(n.storedAt)}` : 'its terrain not yet stored'}
            {n.attempts > 0 ? `; ${n.attempts} attempt${n.attempts === 1 ? '' : 's'}` : ''}
            {n.generationMs > 0 ? `, ${(n.generationMs / 1000).toFixed(1)} s` : ''}
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

/** Begins the next world now: the active world's number typed, then the control. */
export function BeginNext({
  number,
  switching,
  act,
}: {
  number: number;
  switching: boolean;
  act: Act;
}) {
  const [typed, setTyped] = useState('');
  const n = number;
  return (
    <section class="card" aria-label="Begin the next world">
      <h2>Begin the next world now</h2>
      <p class="small">
        Ends world {n} now and begins world {n + 1} in the running process, as its end on the
        schedule would. World {n + 1} is made first if it is not yet, which takes some seconds.
        Every boat goes with the old world. Type {n} to end it.
      </p>
      <input
        name="world-number"
        inputMode="numeric"
        value={typed}
        onInput={(e) => setTyped(e.currentTarget.value)}
      />{' '}
      <button
        type="button"
        name="new-world"
        disabled={typed !== String(n) || switching}
        onClick={() =>
          void act('world', { number: n }, `world ${n} ended; world ${n + 1} begins`).then(
            (ok) => ok && setTyped(''),
          )
        }
      >
        Begin world {n + 1} now
      </button>
      {switching ? <p class="small">A switch is under way.</p> : null}
    </section>
  );
}

/** Makes another next world: its number typed, until too near the world's end. */
export function RemakeNext({ life, act }: { life: Life; act: Act }) {
  useSecond();
  const [typed, setTyped] = useState('');
  const l = life.life;
  const n = l.next;
  if (n === null) {
    return (
      <section class="card" aria-label="Make another next world">
        <h2>Make another next world</h2>
        <p class="small">
          No next world yet: world {l.world + 1} is made from{' '}
          <Moment ms={l.nextMadeAt} zone={l.zone} />.
        </p>
      </section>
    );
  }
  const m = n.number;
  const late = l.remakeUntil > 0 && serverNow(life.offset) > l.remakeUntil;
  return (
    <section class="card" aria-label="Make another next world">
      <h2>Make another next world</h2>
      <p class="small">
        Discards world {m}, seed {n.seed}, which no one has sailed, and makes another from a new
        seed under the same number. Type {m} to make it again.
      </p>
      {late ? (
        <p class="small" data-field="remake-late">
          Too near world {l.world}'s end: the next world could be made again until{' '}
          <Moment ms={l.remakeUntil} zone={l.zone} />.
        </p>
      ) : l.remakeUntil > 0 ? (
        <p class="small">
          It may be made again until <Moment ms={l.remakeUntil} zone={l.zone} />.
        </p>
      ) : null}
      {l.switching ? <p class="small">A switch is under way.</p> : null}
      {!n.stored && !l.switching ? <p class="small">World {m} is being made.</p> : null}
      <input
        name="next-number"
        inputMode="numeric"
        value={typed}
        onInput={(e) => setTyped(e.currentTarget.value)}
      />{' '}
      <button
        type="button"
        name="remake"
        disabled={typed !== String(m) || late || l.switching}
        onClick={() =>
          void act('next', { number: m }, `world ${m} to be made again`).then(
            (ok) => ok && setTyped(''),
          )
        }
      >
        Make world {m} again
      </button>
    </section>
  );
}

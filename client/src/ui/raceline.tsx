// SPDX-License-Identifier: AGPL-3.0-only

// The racer's screen: the race line, one line over the case while the
// boat races (before the start the flag, the countdown and the line's
// distance and side; racing the place, the gap ahead and the next mark;
// a call for a few seconds in its stead), and its ⋯, the race's window:
// the race clock, the course card and Retire. At the finish a card (the
// place, the time, the gap to the winner, the boat's track drawn small,
// Share); as the race ends its results, a period sheet, the rosettes and
// ribbons, the awards read warmly, the wooden spoon's question and Race
// again for its owner. Loaded when the boat is first in a race: none of
// it is in the game's first download.

import './raceline.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Fetch } from '../account/me';
import type { RaceToldIn } from '../net/messages';
import { Prize, raceColour } from './prize';
import { hangSpoon, raceAct, readCard } from './raceapi';
import { fitBox, type Pt } from './racecourse';
import {
  awardLines,
  awardName,
  clockOf,
  fleetOf,
  type LineView,
  lineView,
  ordinal,
  resultWords,
} from './racelinewords';
import type { RacesView } from './raceslazy';
import { entrantName, type Racing } from './racestate';
import type { RaceWatch } from './racewatch';
import { Window } from './racewindow';
import { browserSharer, shareLink } from './sharelink';

/** What the race's parts need of the game. */
export interface RaceSource {
  racing: Racing;
  /** The world's tick now. */
  tick: () => number;
  /** The boat now: where, and its heading, rad. */
  boat: () => { east: number; north: number; heading: number };
  /** Retires the boat; null where the boat is not the player's to retire. */
  retire: (() => void) | null;
  /** Races ashore, for Race again's new card; null without. */
  races: RacesView | null;
  /** The server, as races reach it. */
  fetch?: Fetch;
  /** The game's address, for the race's link. */
  origin: string;
  /** Watching a race: the spectator's side of it, and the crier and cheers for racers too; null without. */
  watch?: RaceWatch | null;
  /** Opens the list of sailors to watch; absent where not offered. */
  another?: () => void;
  /** Takes the player's own boat to sea; absent where not offered. */
  sail?: () => void;
  /** Opens a race's replay on the chart by its code; absent where not offered. */
  replay?: (code: string) => void;
}

export { BarMore, CrierLine, RaceBar, Standings } from './racebar';

/** The flag up: the class's pennant, or P, the blue flag with its white square. */
function Flag({ kind }: { kind: 'class' | 'P' }) {
  return kind === 'P' ? (
    <svg class="rl-flag" viewBox="0 0 18 14" role="img" aria-label="P flag">
      <rect x="0.5" y="0.5" width="17" height="13" fill="#1f4f9a" stroke="#0d1a2a" />
      <rect x="5.5" y="4" width="7" height="6" fill="#f4f1e8" />
    </svg>
  ) : (
    <svg class="rl-flag" viewBox="0 0 18 14" role="img" aria-label="The class’s flag">
      <path d="M0.5 0.5 L17.5 7 L0.5 13.5 Z" fill="#e8b450" stroke="#5b3d12" />
    </svg>
  );
}

/** The race line's words as cells. */
function Cells({ v }: { v: LineView }) {
  switch (v.kind) {
    case 'before':
      return (
        <>
          <Flag kind={v.flag} />
          <span class="rl-clock" data-readout="race-countdown">
            {v.clock}
          </span>
          <span class={`rl-side${v.over ? ' rl-over' : ''}`} data-readout="race-side">
            {v.line}
          </span>
        </>
      );
    case 'trial':
      return (
        <>
          <span class="rl-clock">Trial</span>
          <span class="rl-side" data-readout="race-side">
            Cross the line to start · {v.line}
          </span>
        </>
      );
    case 'racing':
      return (
        <>
          <span class="rl-place" data-readout="race-place">
            {v.place}
          </span>
          {v.gap !== '' ? (
            <span class="rl-gap" data-readout="race-gap">
              {v.gap}
            </span>
          ) : null}
          <span class="rl-next" data-readout="race-next">
            <span class="rl-label">{v.next.label}</span>
            <span class="rl-turn" aria-hidden="true">
              <span style={{ rotate: `${Math.round(v.next.turn)}deg` }}>▲</span>
            </span>
            <span class="rl-bearing">{v.next.bearing}</span>
            <span class="rl-distance">{v.next.distance}</span>
          </span>
        </>
      );
    default:
      return (
        <span class="rl-done" data-readout="race-done">
          {v.text}
        </span>
      );
  }
}

/** How often the line is read again, ms: the countdown's seconds and the bearing as the boat turns. */
const LINE_EVERY = 250;

/** The race's line as it stands now. */
function useLine(src: RaceSource): LineView | null {
  const r = src.racing;
  const told = r.told.value;
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (told === null) {
      return;
    }
    const t = setInterval(() => {
      r.expire();
      setBeat((b) => b + 1);
    }, LINE_EVERY);
    return () => clearInterval(t);
  }, [told === null, r]);
  // Read the signals so that a picture or a call draws it again at once.
  const pic = r.picture.value;
  const finish = r.finish.value;
  if (told === null) {
    return null;
  }
  return lineView({
    told,
    me: r.mine(),
    racers: pic?.racers ?? [],
    tick: src.tick(),
    boat: src.boat(),
    finish,
  });
}

/**
 * Where the line stands held sideways: in the top middle, between the
 * case and the pocket chart, measured from them; held upright it is the
 * first line of the top, over the case, and nothing is set.
 */
function useSideways(el: { current: HTMLElement | null }) {
  useLayoutEffect(() => {
    const line = el.current;
    if (line === null) {
      return;
    }
    const place = () => {
      const sideways = globalThis.matchMedia?.('(orientation: landscape)').matches === true;
      if (!sideways) {
        line.style.removeProperty('--rl-left');
        line.style.removeProperty('--rl-width');
        return;
      }
      const hud = line.closest('.hud-screen') ?? document;
      let right = 0;
      for (const e of hud.querySelectorAll('.case-top, .case [data-pusher]')) {
        right = Math.max(right, e.getBoundingClientRect().right);
      }
      let left = innerWidth;
      for (const e of hud.querySelectorAll('.pocket-frame, .pocket [data-pusher]')) {
        left = Math.min(left, e.getBoundingClientRect().left);
      }
      const top = line.offsetParent?.getBoundingClientRect().left ?? 0;
      line.style.setProperty('--rl-left', `${right + 8 - top}px`);
      line.style.setProperty('--rl-width', `${Math.max(0, left - 8 - (right + 8))}px`);
    };
    place();
    addEventListener('resize', place);
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    const hud = line.closest('.hud-screen');
    for (const e of hud?.querySelectorAll('.case-top, .pocket-frame') ?? []) {
      sized?.observe(e);
    }
    return () => {
      removeEventListener('resize', place);
      sized?.disconnect();
    };
  }, []);
}

/** The race line, while the boat races: one line, its ⋯ at its end. */
export function RaceLine({ src }: { src: RaceSource }) {
  const v = useLine(src);
  const el = useRef<HTMLDivElement | null>(null);
  useSideways(el);
  const call = src.racing.call.value;
  // A boat watched has the race bar at the foot instead.
  const watching = src.racing.eye.value > 0 && src.racing.number() === 0;
  if (v === null || watching) {
    return null;
  }
  return (
    <div
      class={`panel racer-line${call?.warn ? ' rl-warn' : ''}${v.kind === 'before' && v.over ? ' rl-over-line' : ''}`}
      ref={el}
      role="status"
      data-readout="race-line"
      data-state={call !== null ? 'call' : v.kind}
    >
      <button
        type="button"
        class="rl-words"
        aria-label="The race"
        onClick={() => (src.racing.more.value = true)}
      >
        {call !== null ? (
          <>
            <span class="rl-call rl-long" data-readout="race-call">
              {call.text}
            </span>
            <span class="rl-call rl-short" aria-hidden="true">
              {call.short}
            </span>
          </>
        ) : (
          <Cells v={v} />
        )}
      </button>
      <button
        type="button"
        class="rl-more"
        aria-label="The race: its clock, its course and Retire"
        onClick={() => (src.racing.more.value = true)}
      >
        ⋯
      </button>
    </div>
  );
}

/** A course drawn small: its way, its lines, its marks numbered, the boat's track and where it is. */
export function CourseCard({
  told,
  size,
  track = [],
  at = null,
  next = -1,
}: {
  told: RaceToldIn;
  size: number;
  track?: readonly number[];
  at?: { east: number; north: number } | null;
  next?: number;
}) {
  const pts: Pt[] = [];
  const add = (p: { east: number; north: number }) => pts.push({ x: p.east, y: -p.north });
  for (const p of told.way) {
    add(p);
  }
  for (const m of told.marks) {
    add(m);
  }
  if (told.pin !== null && told.committee !== null) {
    add(told.pin);
    add(told.committee);
  }
  for (let i = 0; i + 1 < track.length; i += 2) {
    add({ east: track[i] ?? 0, north: track[i + 1] ?? 0 });
  }
  if (at !== null) {
    add(at);
  }
  const fit = fitBox(pts, size, size, Math.max(10, size * 0.1));
  let k = 0;
  const take = (n: number) => {
    const out = fit.slice(k, k + n);
    k += n;
    return out;
  };
  const way = take(told.way.length);
  const marks = take(told.marks.length);
  const line = told.pin !== null && told.committee !== null ? take(2) : [];
  const trackPts = take(Math.floor(track.length / 2));
  const me = at !== null ? take(1)[0] : undefined;
  const path = (ps: Pt[]) =>
    ps.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  const nextMark = told.legs[next]?.mark ?? 0;
  return (
    <svg
      class="rl-course"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={told.name === '' ? 'The course' : `The course of ${told.name}`}
    >
      <rect class="rl-paper" x="0" y="0" width={size} height={size} rx="6" />
      {way.length > 1 ? <path class="rl-way" d={path(way)} /> : null}
      {line.length === 2 ? (
        <line
          class="rl-startline"
          x1={line[0]?.x}
          y1={line[0]?.y}
          x2={line[1]?.x}
          y2={line[1]?.y}
        />
      ) : null}
      {trackPts.length > 1 ? <path class="rl-track" d={path(trackPts)} /> : null}
      {marks.map((p, i) => {
        const m = told.marks[i];
        const ringed = m !== undefined && m.number === nextMark && nextMark > 0;
        return (
          <g key={i}>
            {ringed ? <circle class="rl-next-ring" cx={p.x} cy={p.y} r={7} /> : null}
            <circle class="rl-mark" cx={p.x} cy={p.y} r={3.2} />
            <text class="rl-mark-number" x={p.x + 6} y={p.y - 5}>
              {m?.number ?? ''}
            </text>
          </g>
        );
      })}
      {me !== undefined ? <circle class="rl-me" cx={me.x} cy={me.y} r={3.5} /> : null}
    </svg>
  );
}

/** The race's window, from the line's ⋯: the race clock, the course card, the seconds added, Retire. */
function MoreWindow({ src }: { src: RaceSource }) {
  const r = src.racing;
  const told = r.told.value;
  const [asking, setAsking] = useState(false);
  const [, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (told === null) {
    return null;
  }
  const close = () => {
    r.more.value = false;
  };
  const me = r.mine();
  const tick = src.tick();
  const started = told.start > 0 && tick >= told.start;
  const clock = started
    ? `Race clock ${clockOf((tick - told.start) / 30)}`
    : told.start > 0
      ? `The start in ${clockOf((told.start - tick) / 30)}`
      : 'The clock starts as you cross the line';
  const racing = me !== null && r.number() > 0 && (me.state === 'placed' || me.state === 'racing');
  const fleet = fleetOf(r.picture.value?.racers ?? []);
  return (
    <Window name="race-more" title={told.name === '' ? 'The race' : told.name} close={close}>
      <p class="rl-faint" data-readout="race-clock">
        {clock}
        {fleet > 0 && !told.trial ? ` · ${fleet} boats` : ''}
        {told.laps > 1 ? ` · ${told.laps} laps` : ''}
      </p>
      <div class="rl-card-row">
        <CourseCard
          told={told}
          size={132}
          track={r.tracks().get(r.number()) ?? []}
          at={src.boat()}
          next={me?.leg ?? -1}
        />
        <ul class="rl-facts">
          <li>
            Leave every mark {told.marks.every((m) => m.side >= 0) ? 'to starboard' : 'to port'}, in
            order
          </li>
          <li>A bump at fault or over early: 10 seconds added</li>
          {me !== null && me.added > 0 ? (
            <li class="rl-warn-words">{me.added} seconds added so far</li>
          ) : null}
        </ul>
      </div>
      {asking ? (
        <div class="rl-keys">
          <p class="rl-faint">Retire from the race? You can still watch it.</p>
          <button type="button" onClick={() => setAsking(false)}>
            Keep racing
          </button>
          <button
            type="button"
            class="rl-danger"
            onClick={() => {
              src.retire?.();
              setAsking(false);
              close();
            }}
          >
            Retire
          </button>
        </div>
      ) : (
        <div class="rl-keys">
          {src.retire !== null && racing ? (
            <button type="button" class="rl-danger" onClick={() => setAsking(true)}>
              Retire…
            </button>
          ) : null}
          <button type="button" class="key-main" onClick={close}>
            Close
          </button>
        </div>
      )}
    </Window>
  );
}

/** The race's link. */
function linkOf(src: RaceSource, code: string): string {
  return `${src.origin}/?r=${code}`;
}

/** The finish's card: the place, the time, the gap to the winner, the track drawn small, Share. */
function FinishCard({ src }: { src: RaceSource }) {
  const r = src.racing;
  const f = r.finish.value;
  const told = r.told.value;
  const [said, setSaid] = useState('');
  if (f === null || told === null) {
    return null;
  }
  const close = () => {
    r.finishOpen.value = false;
  };
  const fleet = fleetOf(r.picture.value?.racers ?? []);
  const first = [...r.homes.values()].find((h) => h.place === 1);
  const gap =
    told.trial || f.place === 1 || first === undefined
      ? ''
      : ` · ${clockOf((f.elapsedMs + f.added * 1000 - (first.elapsedMs + first.added * 1000)) / 1000)} behind the winner`;
  const words = told.trial
    ? 'Your run is home'
    : f.place === 1
      ? 'First home!'
      : `${ordinal(f.place)} home${fleet > 1 ? ` of ${fleet}` : ''}`;
  const share = () => {
    if (told.code === '') {
      return;
    }
    const url = linkOf(src, told.code);
    void shareLink(
      {
        url,
        text: `${told.trial ? 'I sailed' : `I came ${ordinal(f.place)} in`} ${told.name} on Keel Over the Edge: ${url}`,
      },
      browserSharer(),
    ).then((res) => setSaid(res === 'copied' ? 'The link is copied.' : ''));
  };
  return (
    <Window name="race-finish" title={words} close={close}>
      <div class="rl-card-row">
        <Prize
          place={told.trial ? 0 : f.place}
          of={fleet}
          colour={raceColour(told.code)}
          size={56}
        />
        <div>
          <p class="rl-big" data-readout="race-finish">
            {clockOf(f.elapsedMs / 1000)}
            {f.added > 0 ? ` · ${f.added} s added` : ''}
          </p>
          <p class="rl-faint">
            {told.name}
            {gap}
          </p>
        </div>
      </div>
      <CourseCard told={told} size={150} track={r.tracks().get(f.number) ?? []} />
      <p class="rl-faint">The results come as the race ends.</p>
      {said !== '' ? (
        <p class="rl-faint" role="status">
          {said}
        </p>
      ) : null}
      <div class="rl-keys">
        {told.code !== '' ? (
          <button type="button" onClick={share}>
            Share
          </button>
        ) : null}
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** The race's results as it ends: a period sheet of every boat, the awards, the spoon's question, Race again. */
function ResultsWindow({ src }: { src: RaceSource }) {
  const r = src.racing;
  const ended = r.ended.value;
  const [owner, setOwner] = useState(false);
  const [spoon, setSpoon] = useState<'ask' | 'hung' | 'down' | 'none'>('ask');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const code = ended?.told.code ?? '';
  const f = src.fetch;
  useEffect(() => {
    if (code === '') {
      return;
    }
    let live = true;
    void readCard(code, f).then((a) => {
      if (live && a.ok) {
        setOwner(a.value.mine.owner && !a.value.harbour);
      }
    });
    return () => {
      live = false;
    };
  }, [code]);
  if (ended === null) {
    return null;
  }
  const { told, results } = ended;
  const close = () => {
    r.resultsOpen.value = false;
  };
  const me = told.entrants.find((e) => e.me)?.number ?? 0;
  const mine = results.results.find((x) => x.number === me);
  const placed = results.results.filter((x) => x.place > 0).length;
  const name = (n: number) => entrantName(told, n);
  const awards = results.prizes ? awardLines(results.results, name) : [];
  const spooned = results.prizes && mine?.awards.includes('spoon') === true && code !== '';
  const again = () => {
    if (busy) {
      return;
    }
    setBusy(true);
    void raceAct(code, 'again', undefined, f).then((a) => {
      setBusy(false);
      if (a.ok) {
        close();
        if (src.races !== null) {
          src.races.card.value = a.value.code;
        }
      } else {
        setSaid('The race can’t be made again just now.');
      }
    });
  };
  const hang = (on: boolean) => {
    setBusy(true);
    void hangSpoon(code, on, f).then((a) => {
      setBusy(false);
      setSpoon(a.ok ? (on ? 'hung' : 'down') : 'none');
    });
  };
  return (
    <Window name="race-results" title={told.name === '' ? 'The results' : told.name} close={close}>
      <p class="rl-faint">
        {told.trial ? 'A time trial’s run' : `The results · ${placed} placed`}
        {told.laps > 1 ? ` · ${told.laps} laps` : ''}
      </p>
      <ol class="rl-results" data-readout="race-results">
        {results.results.map((x) => (
          <li key={x.number} class={x.number === me ? 'rl-mine' : undefined}>
            <Prize
              place={x.place}
              of={placed}
              colour={raceColour(code)}
              medal={x.medal}
              size={36}
            />
            <span class="rl-who">
              <span class="rl-name">{name(x.number)}</span>
              <span class="rl-faint">
                {resultWords(x)}
                {x.awards.length > 0 && results.prizes
                  ? ` · ${x.awards
                      .map(awardName)
                      .filter((w) => w !== '')
                      .join(', ')}`
                  : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {awards.length > 0 ? (
        <ul class="rl-awards" data-readout="race-awards">
          {awards.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : !told.trial && !results.prizes ? (
        <p class="rl-faint">No prizes this time: they need three boats sailed by three sailors.</p>
      ) : null}
      {spooned && spoon === 'ask' ? (
        <div class="rl-spoon" data-readout="race-spoon">
          <p>Hang the spoon from your stern for the rest of the world?</p>
          <div class="rl-keys">
            <button type="button" disabled={busy} onClick={() => setSpoon('down')}>
              No
            </button>
            <button type="button" disabled={busy} onClick={() => hang(true)}>
              Yes, hang it
            </button>
          </div>
        </div>
      ) : spooned && spoon === 'hung' ? (
        <p class="rl-faint" role="status">
          The spoon hangs from your stern. Take it down from your log’s Ribbons whenever you like.
        </p>
      ) : null}
      {said !== '' ? (
        <p class="rl-faint" role="status">
          {said}
        </p>
      ) : null}
      <div class="rl-keys">
        {owner ? (
          <button type="button" disabled={busy} onClick={again}>
            Race again
          </button>
        ) : null}
        {src.replay !== undefined && code !== '' ? (
          <button
            type="button"
            onClick={() => {
              close();
              src.replay?.(code);
            }}
          >
            {told.trial ? 'Replay the runs' : 'Replay'}
          </button>
        ) : null}
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** Whichever of the race's windows is open: its ⋯, the finish's card, the results. */
export function RaceWindows({ src }: { src: RaceSource }) {
  const r = src.racing;
  if (r.resultsOpen.value && r.ended.value !== null) {
    return <ResultsWindow src={src} />;
  }
  if (r.finishOpen.value && r.finish.value !== null) {
    return <FinishCard src={src} />;
  }
  if (r.more.value && r.told.value !== null) {
    return <MoreWindow src={src} />;
  }
  return null;
}

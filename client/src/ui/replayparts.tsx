// SPDX-License-Identifier: AGPL-3.0-only

// A race replayed, on the chart and no sea: under the chart's strip the
// race's name and the standings at the slider's moment (a tap opens them
// all, and a boat tapped there is followed); at its foot, in the weather's
// time's place, Play, the slider from the warning signal to the end and
// its clock, 1×, 10× and 30×, the results and Share. The results list
// every boat, its time or its progress, its awards and those aboard; a
// time trial's list its runs, any eight of them drawn together. A race
// whose world has gone shows its results alone, over the screen.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { catalog } from '../catalog';
import type { Chart } from '../chart/chart';
import './raceline.css';
import './replay.css';
import { Prize, raceColour } from './prize';
import { type ReplayBoat, type ReplayRun, type ReplayTold, readReplay } from './raceapi';
import { trackColour } from './racecolours';
import {
  awardLines,
  awardName,
  distanceOf,
  medalName,
  ordinal,
  resultWords,
} from './racelinewords';
import { Window } from './racewindow';
import { boatsText, kindText } from './racewords';
import {
  boatName,
  clockAt,
  MOST_DRAWN,
  PLAY_EVERY,
  ReplayModel,
  runTime,
  SPEEDS,
  type Standing,
} from './replay';
import type { ReplayHost } from './replayhost';
import { browserSharer, shareLink } from './sharelink';

/**
 * How far off a replay looks at its course, its course alone in view, as
 * many times as a race's chart frames its area: its head and its foot
 * take more of the screen, most of it held sideways.
 */
const REPLAY_ROOM = 1.3;
const REPLAY_ROOM_SIDEWAYS = 2.7;
/** How far lower on the screen a replay sets its course, as a share of its reach: clear of its head. */
const REPLAY_LOWER = 0.15;
const REPLAY_LOWER_SIDEWAYS = 0.2;

/** Why a replay cannot be had, in words. */
export function replayRefusal(reason: string): string {
  switch (reason) {
    case 'not-finished':
      return 'The race isn’t over yet: its replay comes when it ends.';
    case 'cancelled':
      return 'This race was cancelled.';
    case 'not-found':
      return 'There is no race at this link. It may have been copied short.';
    case 'offline':
      return 'The harbour cannot be reached. Check the connection and try again.';
    default:
      return 'The replay cannot be had just now. Try again in a moment.';
  }
}

/**
 * Opens a race's replay on the chart, a trial's runs asked for drawn; a
 * race whose world has gone shows its results alone, and a replay that
 * cannot be had says why, each over the screen. True if it opened.
 */
export async function openReplay(
  host: ReplayHost,
  chart: Chart,
  code: string,
  runs: number[] = [],
): Promise<boolean> {
  const a = await readReplay(code, runs, host.fetch);
  if (!a.ok) {
    void showSaid(document.body, replayRefusal(a.refusal.reason));
    return false;
  }
  return showReplay(host, chart, a.value);
}

/** Shows a replay read: on the chart while its tracks are kept, else its results alone. */
export function showReplay(host: ReplayHost, chart: Chart, told: ReplayTold): boolean {
  const index = catalog.boats.findIndex((b) => b.id === told.boat.id);
  const m = told.kept ? new ReplayModel(told, Math.max(index, 0)) : null;
  if (m === null || m.drawing() === null) {
    void showReplayAlone(document.body, told, host.origin);
    return true;
  }
  const was = host.model.peek();
  if (was !== null && was.told.code === told.code) {
    // Runs drawn again: at the same moment, the same boat followed if drawn.
    m.setTime(was.t.peek());
    m.speed.value = was.speed.peek();
  }
  host.model.value = m;
  host.standings.value = false;
  if (!chart.open.peek() || chart.mode.peek() !== 'chart') {
    chart.show('chart');
  }
  // Room for the replay's head and its time at the foot.
  const sideways = innerWidth > innerHeight;
  chart.view.frameRace(
    sideways ? REPLAY_ROOM_SIDEWAYS : REPLAY_ROOM,
    true,
    sideways ? REPLAY_LOWER_SIDEWAYS : REPLAY_LOWER,
  );
  return true;
}

/** The race's link. */
function linkOf(origin: string, code: string): string {
  return `${origin}/?r=${code}`;
}

/** Shares a race's link with its words; says if it was copied. */
function share(origin: string, told: ReplayTold, said: (s: string) => void): void {
  const url = linkOf(origin, told.code);
  void shareLink(
    {
      url,
      text: `${told.kind === 'trial' ? 'The runs of' : 'The replay of'} ${told.name} on Keel Over the Edge: ${url}`,
    },
    browserSharer(),
  ).then((r) => said(r === 'copied' ? 'The link is copied.' : ''));
}

/** A standing's words: home and when, the way left, or why out of it. */
export function standingWords(s: Standing): string {
  const b = s.line.boat;
  switch (s.state) {
    case 'line':
      return 'On the line';
    case 'home':
      return `Home ${clockAt(b.elapsed)}${b.added > 0 ? ` · +${b.added} s` : ''}`;
    case 'placed':
      return b.place > 0 ? `Placed ${ordinal(b.place)} at the end` : 'Placed at the end';
    case 'retired':
      return 'Retired';
    case 'dns':
      return 'Did not start';
    default:
      return `${distanceOf(s.toGo)} to go`;
  }
}

/** The race's name and the standings at the slider's moment, under the chart's strip; a tap opens them all. */
export function ReplayHead({ host }: { host: ReplayHost }) {
  const m = host.model.value;
  if (m === null) {
    return null;
  }
  m.version.value;
  const t = m.t.value;
  const told = m.told;
  const st = m.standings();
  const top = st.filter((x) => x.place > 0).slice(0, 3);
  return (
    <div class="chart-case rp-head" data-readout="replay-head">
      <p class="rp-title">
        <span class="rp-name">{told.name}</span>
        <span class="rp-faint">
          {' · '}
          {told.kind === 'trial' ? `${kindText('trial')} · ` : ''}
          {boatsText(told.boat.name)}
        </span>
      </p>
      <button
        type="button"
        class="rp-standing"
        aria-expanded={host.standings.value}
        aria-label="The standings"
        data-readout="replay-standing"
        onClick={() => {
          host.standings.value = !host.standings.peek();
          host.results.value = false;
        }}
      >
        {t < 0 || top.length === 0 ? (
          <span class="rp-faint">
            {told.kind === 'trial'
              ? `${m.lines.filter((l) => l.track !== null).length} runs together`
              : `${m.lines.filter((l) => l.track !== null).length} boats on the line`}
          </span>
        ) : (
          top.map((x) => (
            <span key={x.key} class="rp-place">
              <b>{x.place}</b>
              <i class="rp-dot" style={{ background: trackColour(x.key) }} aria-hidden="true" />
              <span class="rp-place-name">{x.line.name}</span>
            </span>
          ))
        )}
      </button>
    </div>
  );
}

/** Play's mark, and Pause's. */
function PlayMark({ playing }: { playing: boolean }) {
  return (
    <svg class="chart-play-mark" viewBox="0 0 16 16" aria-hidden="true">
      {playing ? <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" /> : <path d="M4 2l10 6-10 6z" />}
    </svg>
  );
}

/** The replay's time at the chart's foot: Play, the slider and its clock, the speeds, the results and Share. */
export function ReplayBar({ host }: { host: ReplayHost }) {
  const m = host.model.value;
  const playing = m?.playing.value ?? false;
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (m === null || !playing) {
      return;
    }
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      m.play(now - last);
      last = now;
    }, PLAY_EVERY);
    return () => clearInterval(t);
  }, [m, playing]);
  if (m === null) {
    return null;
  }
  const t = m.t.value;
  const speed = m.speed.value;
  const onKey = (e: KeyboardEvent) => {
    const step = {
      ArrowRight: 2,
      ArrowUp: 2,
      ArrowLeft: -2,
      ArrowDown: -2,
      PageUp: 30,
      PageDown: -30,
    }[e.key];
    if (e.key === 'Home' || e.key === 'End' || step !== undefined) {
      e.preventDefault();
      m.playing.value = false;
      m.setTime(e.key === 'Home' ? m.lo : e.key === 'End' ? m.hi : t + (step ?? 0));
    }
  };
  return (
    <section
      class="chart-case chart-time rp-bar"
      aria-label="The replay’s time"
      data-readout="replay-bar"
    >
      <button
        type="button"
        class="chart-button chart-play"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        onClick={() => m.toggle()}
      >
        <PlayMark playing={playing} />
      </button>
      <div class="chart-time-track">
        <p class="chart-time-text" data-readout="replay-clock">
          {said !== '' ? said : `${clockAt(t)}${t < 0 ? ' to the gun' : ''}`}
        </p>
        <input
          type="range"
          class="chart-slider"
          min={m.lo}
          max={m.hi}
          step={1}
          value={Math.round(t)}
          aria-label="The race’s time"
          aria-valuetext={clockAt(t)}
          onInput={(e) => {
            m.playing.value = false;
            m.setTime(Number(e.currentTarget.value));
          }}
          onKeyDown={onKey}
        />
      </div>
      <div class="rp-keys">
        <fieldset class="rp-speeds">
          <legend class="visually-hidden">Speed</legend>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              class="chart-button rp-speed"
              aria-pressed={speed === s}
              onClick={() => {
                m.speed.value = s;
              }}
            >
              {s}×
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          class="chart-button"
          aria-expanded={host.results.value}
          onClick={() => {
            host.results.value = !host.results.peek();
            host.standings.value = false;
          }}
        >
          Results
        </button>
        <button
          type="button"
          class="chart-button"
          onClick={() =>
            share(host.origin, m.told, (s) => {
              setSaid(s);
              if (s !== '') {
                setTimeout(() => setSaid(''), 3000);
              }
            })
          }
        >
          Share
        </button>
      </div>
    </section>
  );
}

/** Every boat's standing at the slider's moment; a boat tapped is followed. */
function StandingsWindow({ host, m }: { host: ReplayHost; m: ReplayModel }) {
  m.version.value;
  const close = () => {
    host.standings.value = false;
  };
  const st = m.standings();
  return (
    <Window name="replay-standings" title={`The standings at ${clockAt(m.t.value)}`} close={close}>
      <ol class="rp-rows" data-readout="replay-standings">
        {st.map((x) => (
          <li key={x.key}>
            <button
              type="button"
              class="rp-row"
              aria-pressed={m.followed.value === x.key}
              disabled={x.line.track === null}
              onClick={() => {
                m.follow(x.key);
                close();
              }}
            >
              <b class="rp-row-place">{x.place > 0 ? x.place : '·'}</b>
              <i class="rp-dot" style={{ background: trackColour(x.key) }} aria-hidden="true" />
              <span class="rl-who">
                <span class="rl-name">{x.line.name}</span>
                <span class="rl-faint">{standingWords(x)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div class="rl-keys">
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** Those aboard a boat, as the results list them: the named by name, the rest counted. */
export function crewWords(b: ReplayBoat): string {
  const crew = b.crew ?? [];
  if (crew.length === 0) {
    return '';
  }
  const named = crew
    .filter((c) => c.name !== null && c.name !== '')
    .map((c) => (c.machine ? `${c.name} ⚙` : c.name));
  const more = crew.length - named.length;
  const rest = more > 0 ? `${more === 1 ? 'one' : more} more` : '';
  return `Aboard: ${[...named, rest].filter((x) => x !== '').join(', ')}`;
}

/** A race's results: every boat, its prize, its time or progress, its awards and those aboard; then the awards read out. */
function RaceResults({ told, run, mine }: { told: ReplayTold; run: ReplayRun; mine: boolean }) {
  const placed = run.boats.filter((b) => b.place > 0).length;
  const name = (n: number) => {
    const b = run.boats.find((x) => x.number === n);
    return b === undefined ? `No. ${n}` : boatName(b);
  };
  const awards = run.prizes ? awardLines(run.boats, name) : [];
  return (
    <>
      <ol class="rl-results" data-readout="replay-results">
        {run.boats.map((b) => (
          <li key={b.number} class={mine && b.me === true ? 'rl-mine' : undefined}>
            <Prize place={b.place} of={placed} colour={raceColour(told.code)} size={36} />
            <span class="rl-who">
              <span class="rl-name">
                <i
                  class="rp-dot"
                  style={{ background: trackColour(b.number) }}
                  aria-hidden="true"
                />
                {boatName(b)}
              </span>
              <span class="rl-faint">
                {resultWords({
                  how: b.how,
                  elapsedMs: Math.max(b.elapsed, 0) * 1000,
                  toGo: Math.max(b.toGo, 0),
                  added: b.added,
                })}
                {b.awards.length > 0 && run.prizes
                  ? ` · ${b.awards
                      .map(awardName)
                      .filter((w) => w !== '')
                      .join(', ')}`
                  : ''}
              </span>
              {crewWords(b) !== '' ? <span class="rl-faint rp-crew">{crewWords(b)}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {awards.length > 0 ? (
        <ul class="rl-awards" data-readout="replay-awards">
          {awards.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : !run.prizes ? (
        <p class="rl-faint">No prizes this time: they need three boats sailed by three sailors.</p>
      ) : null}
    </>
  );
}

/** A time trial's runs, the fastest first, each with its medal and time; with a model, a run tapped is drawn or taken off the chart. */
function TrialRuns({
  told,
  drawn = null,
  pick = null,
}: {
  told: ReplayTold;
  drawn?: ReadonlyMap<number, number> | null;
  pick?: ((run: number) => void) | null;
}) {
  const runs = [...told.runs].sort((a, b) => runTime(a) - runTime(b) || a.run - b.run);
  if (runs.length === 0) {
    return <p class="rl-faint">No run has been sailed home yet.</p>;
  }
  return (
    <ol class="rl-results" data-readout="replay-runs">
      {runs.map((r) => {
        const b = r.boats[0];
        if (b === undefined) {
          return null;
        }
        const key = drawn?.get(r.run) ?? 0;
        const words = (
          <span class="rl-who">
            <span class="rl-name">
              {key > 0 ? (
                <i class="rp-dot" style={{ background: trackColour(key) }} aria-hidden="true" />
              ) : null}
              {boatName(b)}
            </span>
            <span class="rl-faint">
              Run {r.run} ·{' '}
              {resultWords({
                how: b.how,
                elapsedMs: Math.max(b.elapsed, 0) * 1000,
                toGo: Math.max(b.toGo, 0),
                added: b.added,
              })}
              {b.medal !== undefined && b.medal !== '' ? ` · ${medalName(b.medal)}` : ''}
            </span>
          </span>
        );
        return (
          <li key={r.run} class={b.me === true ? 'rl-mine' : undefined}>
            <Prize
              place={b.place}
              of={0}
              colour={raceColour(told.code)}
              medal={b.medal ?? ''}
              size={36}
            />
            {pick !== null ? (
              <button
                type="button"
                class="rp-row rp-run"
                aria-pressed={key > 0}
                aria-label={`${boatName(b)}, run ${r.run}: ${key > 0 ? 'drawn' : 'not drawn'}`}
                onClick={() => pick(r.run)}
              >
                {words}
              </button>
            ) : (
              words
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The replay's results over the chart: a race's boats or a trial's runs, Share, Close. */
function ResultsWindow({ host, chart, m }: { host: ReplayHost; chart: Chart; m: ReplayModel }) {
  const [said, setSaid] = useState('');
  const told = m.told;
  const close = () => {
    host.results.value = false;
  };
  const drawn = new Map(m.lines.filter((l) => l.track !== null).map((l) => [l.run, l.key]));
  const pick = (run: number) => {
    const runs = [...drawn.keys()];
    const next = drawn.has(run) ? runs.filter((r) => r !== run) : [...runs, run].slice(-MOST_DRAWN);
    if (next.length === 0) {
      return;
    }
    setSaid('');
    void readReplay(told.code, next, host.fetch).then((a) => {
      if (a.ok) {
        showReplay(host, chart, a.value);
        host.results.value = true;
      } else {
        setSaid(replayRefusal(a.refusal.reason));
      }
    });
  };
  const run = told.runs[0];
  return (
    <Window name="replay-results" title={told.name} close={close}>
      <p class="rl-faint">
        {told.kind === 'trial'
          ? `${kindText('trial')} · ${told.course} · tap a run to draw it, up to ${MOST_DRAWN}`
          : `${told.course}${run !== undefined && run.course !== undefined && run.course.laps > 1 ? ` · ${run.course.laps} laps` : ''}`}
      </p>
      {told.kind === 'trial' ? (
        <TrialRuns told={told} drawn={drawn} pick={pick} />
      ) : run !== undefined ? (
        <RaceResults told={told} run={run} mine={true} />
      ) : null}
      {said !== '' ? (
        <p class="rl-faint" role="status">
          {said}
        </p>
      ) : null}
      <div class="rl-keys">
        <button type="button" onClick={() => share(host.origin, told, setSaid)}>
          Share
        </button>
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** The replay's windows over the chart: the standings, or the results. */
export function ReplayWindows({ host, chart }: { host: ReplayHost; chart: Chart }) {
  const m = host.model.value;
  if (m === null) {
    return null;
  }
  if (host.results.value) {
    return <ResultsWindow host={host} chart={chart} m={m} />;
  }
  if (host.standings.value) {
    return <StandingsWindow host={host} m={m} />;
  }
  return null;
}

/** When a race was, in words: "Tuesday 14 November". */
function dayOf(ms: number): string {
  if (ms <= 0) {
    return '';
  }
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/** A race whose world has gone: its results and awards alone, Share and Close. */
export function ReplayAlone({
  told,
  origin,
  close,
}: {
  told: ReplayTold;
  origin: string;
  close: () => void;
}) {
  const [said, setSaid] = useState('');
  const run = told.runs[0];
  const day = dayOf(told.at);
  return (
    <Window name="replay-alone" title={told.name} close={close}>
      <p data-readout="replay-alone-kind">
        {told.harbour ? 'Harbour race' : kindText(told.kind)} · {boatsText(told.boat.name)}
      </p>
      <p class="rl-faint">
        {told.course} · World {told.world.toLocaleString('en')}
        {day !== '' ? ` · ${day}` : ''}
      </p>
      <p class="rl-faint" data-readout="replay-alone-note">
        {told.kept
          ? 'Its course was not kept: here are its results.'
          : `World ${told.world.toLocaleString('en')} has ended, and the race’s tracks went with it. Its results are kept.`}
      </p>
      {told.kind === 'trial' ? (
        <TrialRuns told={told} />
      ) : run !== undefined ? (
        <RaceResults told={told} run={run} mine={true} />
      ) : null}
      {said !== '' ? (
        <p class="rl-faint" role="status">
          {said}
        </p>
      ) : null}
      <div class="rl-keys">
        <button type="button" onClick={() => share(origin, told, setSaid)}>
          Share
        </button>
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  );
}

/** Shows a window over the page until it is closed. */
function overPage(
  parent: HTMLElement,
  draw: (close: () => void) => preact.ComponentChild,
): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'hud rp-host';
    parent.append(root);
    const close = () => {
      render(null, root);
      root.remove();
      resolve();
    };
    render(draw(close), root);
  });
}

/** Shows a race's results alone over the page, as the start screen does before the sea, until closed. */
export function showReplayAlone(
  parent: HTMLElement,
  told: ReplayTold,
  origin: string,
): Promise<void> {
  return overPage(parent, (close) => <ReplayAlone told={told} origin={origin} close={close} />);
}

/** Says why a replay cannot be had, over the page, until closed. */
export function showSaid(parent: HTMLElement, words: string): Promise<void> {
  return overPage(parent, (close) => (
    <Window name="replay-said" title="The replay" close={close}>
      <p data-readout="replay-said">{words}</p>
      <div class="rl-keys">
        <button type="button" class="key-main" onClick={close}>
          Close
        </button>
      </div>
    </Window>
  ));
}

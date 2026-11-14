// SPDX-License-Identifier: AGPL-3.0-only

// The chart's screens: the chart itself over the whole screen, where a
// drag moves it, two fingers pinch and turn it, a double tap fits the whole
// disk and a tap opens a place's box, or a weather system's with the
// course to meet it; its list, everything charted nearest first, the
// chart's readable twin; the news, a period sheet; the pocket chart in the
// corner at sea, with its weather's pusher, whose decal is the sky at the
// boat now; and the notice line.

import './chart.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Raycaster, Vector2 } from 'three';
import type { Chart, ChartMode, TappedWeather } from '../chart/chart';
import type { Forecasting } from '../chart/forecasting';
import { drawPocketWeather, type PocketWeather, pocketWeather } from '../chart/pocketweather';
import { formatPosition } from '../chart/position';
import {
  type ChartStore,
  chartList,
  dayText,
  edgeCaption,
  pocketCaption,
  whenText,
} from '../chart/store';
import { hitTest, type SystemBox, tappedBox, type WeatherHit } from '../chart/systembox';
import type { BoatAt, ChartView } from '../chart/view';
import { momentOf } from '../chart/weather';
import type { ChartEntry } from '../net/messages';
import { Pusher, useUpright } from './case';
import { PlaceWeatherLines, TimeBar } from './chartweather';
import { clockAngles, worldTimeText } from './clock';
import { ClockFace } from './clockdial';
import type { Countdown } from './countdown';
import { WeatherDecal } from './decals';
import { threeDigits, wholeDegrees } from './format';
import { useLog } from './loglazy';
import { OPENING, useNews } from './newslazy';
import { checkUnread, type NewsSource, unread } from './newsread';
import type { NewsStory } from './newswords';
import type { Notices } from './notices';
import { MachineMark, PlayerText } from './player';

/** What the chart's screens need of the world beyond the chart. */
export interface ChartSea {
  chart: Chart;
  /** The boat, where it is and which way it heads. */
  boat: () => BoatAt;
  /** The world's tick now. */
  tick: () => number;
  /** The hour of the world's day at a tick, as the sky is drawn at it, noon at 12; null before the world's time is known. */
  hour: (tick: number) => number | null;
  /** The degrees the pole sinks a nautical mile, and the lip, m. */
  scale: number;
  lip: number;
  /** The lights' characters' notations, by index. */
  characters: readonly string[];
  /** The news, a day's edition. */
  news: NewsSource;
  /** The forecast and what has been, or null without. */
  forecasting: Forecasting | null;
  /** The boat's speed over the ground now, m/s. */
  speed: () => number;
  /** Sets the autopilot to hold a heading, rad, as its panel does; null with no boat to steer. */
  steer: ((heading: number) => void) | null;
}

/** "Charted by <name>, Tuesday", the name as the player wrote it. */
function Credit({ e, now }: { e: ChartEntry; now: number }) {
  if (e.by === '') {
    return (
      <span class="chart-credit">
        {e.withSubject !== null ? 'Charted with its island' : 'Known'}
      </span>
    );
  }
  return (
    <span class="chart-credit">
      Charted by <PlayerText text={e.by} />
      {e.ai ? <MachineMark /> : null}, {dayText(e.at, now)}
    </span>
  );
}

/** The words for an island's class of scenery. */
function classWords(c: string): string {
  switch (c) {
    case 'A':
      return 'Worth the voyage';
    case 'B':
      return 'Worth a visit';
  }
  return '';
}

/** A charted thing's box: what it is, who charted it, and what was found with it. */
function ChartBox({ sea, e, close }: { sea: ChartSea; e: ChartEntry; close: () => void }) {
  const store = sea.chart.store;
  const now = Date.now();
  const found = store.entries.filter((o) => o.island === e.number && e.subject === 'island');
  const island = store.islandOf(e);
  return (
    <section class="chart-panel chart-box" aria-label={store.title(e)}>
      <h2>{store.title(e)}</h2>
      <p class="chart-kind">
        {store.kindName(e)}
        {island !== undefined && e.subject !== 'island' ? ` on ${island.name}` : ''}
      </p>
      <p>
        <Credit e={e} now={now} />
      </p>
      {e.by !== '' ? <p class="chart-when">{whenText(e.at)}</p> : null}
      {e.subject === 'island' && classWords(e.className) !== '' ? (
        <p class="chart-class">{classWords(e.className)}</p>
      ) : null}
      {e.light >= 0 ? (
        <p class="chart-light">
          {sea.characters[e.character] ?? ''} {Math.round(e.focal)}m {(e.range / 1852).toFixed(1)}M
        </p>
      ) : null}
      {found.length > 0 ? (
        <p class="chart-found">
          Found here: {found.map((f) => store.title(f).replace(/ on .*$/, '')).join(', ')}
        </p>
      ) : null}
      {sea.forecasting !== null && store.weathered(e) ? (
        <PlaceWeatherLines chart={sea.chart} src={sea.forecasting} e={e} />
      ) : (
        <p class="chart-place-position">{formatPosition(e.east, e.north)}</p>
      )}
      <div class="chart-buttons">
        <button type="button" onClick={() => sea.chart.show('list')}>
          Show in the list
        </button>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </section>
  );
}

/** Where the boat is, as its latitude and longitude, and how far the edge. */
function Position({ sea }: { sea: ChartSea }) {
  const [text, setText] = useState(['', '']);
  useEffect(() => {
    const at = () => {
      const b = sea.boat();
      setText([formatPosition(b.east, b.north), edgeCaption(b.east, b.north, sea.lip)]);
    };
    at();
    const t = setInterval(at, 1000);
    return () => clearInterval(t);
  }, [sea]);
  return (
    <p class="chart-position" data-readout="position">
      <span>{text[0]}</span>
      <span class="visually-hidden"> · </span>
      <span>{text[1]}</span>
    </p>
  );
}

/**
 * Pointers on the chart, on its paper or its names: a drag moves it, two
 * fingers pinch and turn it, a double tap fits it, a tap picks. A name's
 * own tap opens its box; a name under a finger that drags or twists does
 * not.
 */
function useGestures(sea: ChartSea) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const root = el?.parentElement ?? null;
    if (el === null || root === null) {
      return;
    }
    const view = sea.chart.view;
    const pts = new Map<number, { x: number; y: number }>();
    let lastTap = 0;
    let down: { x: number; y: number; at: number; moved: number; name: boolean } | null = null;
    // Whether the pointers down now have dragged or twisted the chart.
    let moved = false;
    const onName = (t: EventTarget | null) =>
      t instanceof Element && t.closest('.chart-labels') !== null;
    const pair = () => {
      const [a, b] = [...pts.values()];
      return a === undefined || b === undefined
        ? null
        : { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    let before = pair();
    const onDown = (e: PointerEvent) => {
      const name = onName(e.target);
      if (e.target !== el && !name) {
        return;
      }
      // A name keeps its pointer, so that its own tap still opens its box.
      if (!name) {
        el.setPointerCapture(e.pointerId);
      }
      if (pts.size === 0) {
        moved = false;
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down =
        pts.size === 1 ? { x: e.clientX, y: e.clientY, at: e.timeStamp, moved: 0, name } : null;
      if (pts.size > 1) {
        moved = true;
      }
      before = pair();
    };
    const onMove = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (p === undefined) {
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (down !== null) {
        down.moved += Math.hypot(dx, dy);
        moved ||= down.moved >= 8;
      }
      if (pts.size === 1) {
        view.drag(dx, dy);
      } else if (pts.size === 2) {
        const now = pair();
        if (before !== null && now !== null && now.d > 0) {
          view.zoom(before.d / now.d);
          // The paper turns with the fingers: a twist clockwise on the
          // screen turns the view's bearing back.
          view.turn(before.a - now.a);
        }
        before = now;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) {
        return;
      }
      if (
        e.type === 'pointerup' &&
        down !== null &&
        !down.name &&
        down.moved < 8 &&
        e.timeStamp - down.at < 500 &&
        pts.size === 1
      ) {
        const r = el.getBoundingClientRect();
        if (e.timeStamp - lastTap < 350) {
          view.fit();
          lastTap = 0;
        } else {
          lastTap = e.timeStamp;
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          let picked = view.pick(x, y);
          const weather = weatherTapped(sea, x, y, r);
          // Within a system, a place wins only under the finger.
          if (picked !== null && weather !== null) {
            const p = view.screenOf(picked.east, picked.north);
            if (p === null || Math.hypot(p.x - x, p.y - y) > FINGER) {
              picked = null;
            }
          }
          sea.chart.picked.value = picked;
          sea.chart.tapped.value = picked === null ? weather : null;
        }
      }
      pts.delete(e.pointerId);
      down = null;
      before = pair();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.target !== el && !onName(e.target)) {
        return;
      }
      e.preventDefault();
      view.zoom(Math.exp(e.deltaY * 0.001));
    };
    // A name dragged or twisted is not tapped.
    const onClick = (e: MouseEvent) => {
      if (moved && onName(e.target)) {
        e.stopPropagation();
      }
    };
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('click', onClick, true);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('click', onClick, true);
    };
  }, [sea]);
  return ref;
}

const ray = new Raycaster();

/** A tap within a weather system opens a place's box rather than the system's only this near the place's mark, CSS pixels. */
const FINGER = 22;

/** Where a tap at (x, y) CSS pixels of a surface of a size meets the paper, m east and north; null off it. */
function paperAt(view: ChartView, x: number, y: number, size: { width: number; height: number }) {
  ray.setFromCamera(new Vector2((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1), view.camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  if (d.y >= 0) {
    return null;
  }
  const t = -o.y / d.y;
  return { east: o.x + d.x * t, north: -(o.z + d.z * t) };
}

/** The weather system or front a tap at (x, y) falls within, as the chart's weather draws it, or null. */
function weatherTapped(
  sea: ChartSea,
  x: number,
  y: number,
  size: { width: number; height: number },
): TappedWeather | null {
  const scene = sea.chart.view.weather?.scene ?? null;
  if (scene === null || !sea.chart.layers.value.systems) {
    return null;
  }
  const at = paperAt(sea.chart.view, x, y, size);
  const hit = at === null ? null : hitTest(scene, at, sea.lip);
  if (hit === null) {
    return null;
  }
  return hit.kind === 'system'
    ? { kind: 'system', slot: hit.system.slot, seed: hit.system.seed }
    : { kind: 'front', sin: hit.front.sin, cos: hit.front.cos };
}

/** The tapped thing as the chart's weather last drew it, or null if it is no longer drawn. */
function hitOf(sea: ChartSea, t: TappedWeather): { hit: WeatherHit; shown: number } | null {
  const scene = sea.chart.view.weather?.scene ?? null;
  if (scene === null) {
    return null;
  }
  if (t.kind === 'system') {
    const s = scene.systems.find((x) => x.slot === t.slot && x.seed === t.seed);
    return s === undefined
      ? null
      : { hit: { kind: 'system', system: s }, shown: scene.moment.tick };
  }
  const f = scene.fronts.find(
    (x) => Math.abs(x.sin - t.sin) < 1e-6 && Math.abs(x.cos - t.cos) < 1e-6,
  );
  return f === undefined ? null : { hit: { kind: 'front', front: f }, shown: scene.moment.tick };
}

/** A tapped thing's box now, from the chart's weather and the forecast; null if it is gone. */
function systemBoxOf(sea: ChartSea, t: TappedWeather): SystemBox | null {
  const src = sea.forecasting;
  const found = hitOf(sea, t);
  const scene = sea.chart.view.weather?.scene ?? null;
  if (src === null || found === null || scene === null) {
    return null;
  }
  const fields = src.fields();
  const b = sea.boat();
  return tappedBox({
    hit: found.hit,
    grid: scene.grid,
    boat: { east: b.east, north: b.north },
    speed: sea.speed(),
    physics: fields?.physics ?? null,
    latest: src.forecasts.latest,
    shown: found.shown,
    now: src.tick(),
    reach: fields?.physics.frontReach() ?? sea.lip,
  });
}

/** A weather system's box: its kind, its wind, where it is, how it moves and lives, the course to meet it, and Steer. */
function SystemBoxPanel({ sea, t, close }: { sea: ChartSea; t: TappedWeather; close: () => void }) {
  const [box, setBox] = useState<SystemBox | null>(() => systemBoxOf(sea, t));
  useEffect(() => {
    setBox(systemBoxOf(sea, t));
    // The boat and the system move on.
    const i = setInterval(() => setBox(systemBoxOf(sea, t)), 1000);
    return () => clearInterval(i);
  }, [sea, t]);
  const steer = box?.steer ?? null;
  const to = box?.to ?? null;
  return (
    <section
      class="chart-panel chart-box chart-system"
      aria-label={box?.name ?? 'Weather'}
      data-readout="system-box"
    >
      {box === null ? (
        <p>It has gone from the chart.</p>
      ) : (
        <>
          <h2>{box.name}</h2>
          <dl class="chart-weather">
            <dt>Wind</dt>
            <dd>{box.wind}</dd>
            <dt>Where</dt>
            <dd>{box.where}</dd>
            <dt>Moving</dt>
            <dd>{box.motion}</dd>
            {box.life !== '' ? (
              <>
                <dt>Lives</dt>
                <dd>{box.life}</dd>
              </>
            ) : null}
          </dl>
          {box.course !== '' ? (
            <p class="chart-course" data-readout="system-course">
              {box.course}
            </p>
          ) : null}
        </>
      )}
      <div class="chart-buttons">
        {steer !== null && to !== null && sea.steer !== null ? (
          <button
            type="button"
            data-steer="system"
            onClick={() => {
              sea.steer?.(steer);
              sea.chart.steered.value = { heading: steer, ...to };
              sea.chart.show(null);
            }}
          >
            Steer {threeDigits(wholeDegrees(steer))}°
          </button>
        ) : null}
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </section>
  );
}

/** How often the News tab's dot is looked to while the chart screen is open, ms. */
const DOT_AGAIN = 120_000;

/**
 * The tabs between the chart, its list, the news and the log; the Log tab
 * opens the reader's own, the News tab today's edition. The News tab has a
 * dot while today's edition has a story not yet read: set over its corner,
 * so the strip keeps its width.
 */
function Tabs({ sea }: { sea: ChartSea }) {
  const mode = sea.chart.mode.value;
  const dot = unread.value && mode !== 'news';
  useEffect(() => {
    const look = () => void checkUnread(() => sea.news(null));
    look();
    const t = setInterval(look, DOT_AGAIN);
    return () => clearInterval(t);
  }, [sea]);
  const open = (m: ChartMode) => {
    if (m === 'log') {
      sea.chart.showLog({ kind: 'own' });
    } else if (m === 'news') {
      sea.chart.showNews(null);
    } else {
      sea.chart.show(m);
    }
  };
  const tab = (m: ChartMode, label: string) => (
    <button
      type="button"
      class={mode === m ? 'chart-tab chosen' : 'chart-tab'}
      aria-pressed={mode === m}
      onClick={() => open(m)}
    >
      {label}
      {m === 'news' && dot ? (
        <span class="chart-tab-dot" role="img" aria-label="new stories" title="new stories" />
      ) : null}
    </button>
  );
  return (
    <nav class="chart-tabs" aria-label="Chart">
      {tab('chart', 'Chart')}
      {tab('list', 'List')}
      {tab('news', 'News')}
      {tab('log', 'Log')}
    </nav>
  );
}

/** Everything charted, by kind, nearest first: a tap opens the chart there. */
export function ChartList({ sea }: { sea: ChartSea }) {
  const store = sea.chart.store;
  void store.version.value;
  const b = sea.boat();
  const now = Date.now();
  return (
    <section class="chart-panel chart-list" aria-label="Everything charted">
      <h2>Charted: {store.size}</h2>
      {chartList(store.entries, b.east, b.north).map(({ title, lines }) =>
        lines.length === 0 ? null : (
          <div key={title}>
            <h3>{title}</h3>
            <ul>
              {lines.map(({ entry: e, where }) => (
                <li key={`${e.subject}:${e.number}`}>
                  <button type="button" onClick={() => sea.chart.showAt(e)}>
                    <span class="chart-list-name">{store.title(e)}</span>
                    <span class="chart-list-kind">{store.kindName(e)}</span>
                    <span class="chart-list-where">{where}</span>
                    <Credit e={e} now={now} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}

/** The news made from the chart itself, offline: each island, port, light and wreck charted, the newest first, as one day's stories. */
export function chartNews(store: ChartStore, news: (e: ChartEntry) => boolean): NewsSource {
  return async () => {
    const stories: NewsStory[] = store.entries
      .filter((e) => e.by !== '' && news(e))
      .map((e) => ({
        id: `${e.subject}:${e.number}`,
        kind: 'charting',
        at: e.at,
        head: store.title(e).toUpperCase(),
        text: `${store.kindName(e)}, charted by {0}.`,
        names: [{ kind: e.ai ? ('machine' as const) : ('human' as const), name: e.by }],
        subject: e.subject,
        number: e.number,
        x: e.east,
        y: e.north,
      }))
      .reverse();
    const figures = { boats: 0, machines: 0, run: 0, charted: stories.length, crews: 0, over: 0 };
    return {
      world: 0,
      day: '',
      number: 1,
      zone: '',
      set: false,
      figures,
      figuresText: '',
      lead: [],
      stories,
      shipmates: [],
      notices: [],
      days: [],
    };
  };
}

/** The countdown at the chart's rim, over its list and the news: the day and hour it ends are the news's, and its title's. */
function RimCountdown({ end }: { end: Countdown | null }) {
  if (end === null || end.text.value === '') {
    return null;
  }
  const when = end.when.value;
  return (
    <p
      class={`chart-case chart-falls${end.closing.value ? ' closing' : ''}`}
      data-readout="chart-falls"
      title={when === '' ? undefined : when}
    >
      <span role="timer">New world in {end.text.value}</span>
    </p>
  );
}

/**
 * The chart's ship's clock, in the strip or held upright under it: the
 * world's time of the moment the chart shows, now or the slider's, its hands sweeping on as Play plays and back
 * with Now; its rim gold while it reads ahead, as the slider's knob is.
 */
function StripClock({ sea }: { sea: ChartSea }) {
  const minutes = sea.chart.minutes.value;
  const [, tick] = useState(0);
  useEffect(() => {
    // The world's time now moves on.
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const src = sea.forecasting;
  const m = src === null ? null : momentOf(minutes, src);
  const hour = sea.hour(m?.tick ?? sea.tick());
  if (hour === null) {
    return null;
  }
  const ahead = m !== null && m.kind === 'ahead' ? m.minutes : 0;
  const words = `${worldTimeText(hour)}${ahead > 0 ? `, in ${ahead} minutes` : ''}`;
  return (
    <span
      class={`chart-clock${ahead > 0 ? ' ahead' : ''}`}
      role="img"
      aria-label={words}
      title={words}
      data-readout="chart-clock"
    >
      <ClockFace id="chart-clock-face" angles={clockAngles(hour)} numerals="none" />
    </span>
  );
}

/** The News tab: the day's edition, its sheet loaded when first opened. */
function NewsTab({ sea }: { sea: ChartSea }) {
  const m = useNews();
  if (m === null) {
    return (
      <section class="chart-panel news-sheet" aria-label="The news">
        <p>{OPENING}</p>
      </section>
    );
  }
  return <m.NewsTab sea={sea} />;
}

/** The Log tab: a sailor's log, loaded when first opened. */
function LogTab({ sea, watch }: { sea: ChartSea; watch: ((name: string) => void) | null }) {
  const m = useLog();
  const who = sea.chart.logOf.value;
  if (m === null) {
    return (
      <section class="chart-panel log-sheet" aria-label="The log">
        <p>Opening the log…</p>
      </section>
    );
  }
  return (
    <m.LogSheet
      who={who}
      setWho={(w) => {
        sea.chart.logOf.value = w;
      }}
      watch={watch}
    />
  );
}

/**
 * The chart over the whole screen, its list, the news or the log; the notices
 * under its top, out of the way of its working foot.
 */
export function ChartScreen({
  sea,
  end = null,
  notices = null,
  watch = null,
}: {
  sea: ChartSea;
  end?: Countdown | null;
  notices?: Notices | null;
  /** Watches a sailor from their log, the chart closed; null where none may be watched from it. */
  watch?: ((name: string) => void) | null;
}) {
  const chart = sea.chart;
  const surface = useGestures(sea);
  const labels = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chart.view.attachLabels(labels.current);
    return () => chart.view.attachLabels(null);
  }, [chart]);
  // How far down the top reaches, strip, countdown and notice: the boxes
  // and the key keep below it.
  const screen = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const s = screen.current;
    const t = top.current;
    if (s === null || t === null) {
      return;
    }
    const foot = () => s.style.setProperty('--chart-head', `${t.getBoundingClientRect().bottom}px`);
    foot();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const sized = new ResizeObserver(foot);
    sized.observe(t);
    return () => sized.disconnect();
  }, []);
  const mode = chart.mode.value;
  const upright = useUpright();
  const picked = chart.picked.value;
  const tapped = chart.tapped.value;
  return (
    <div class="chart-screen" data-mode={mode} ref={screen}>
      <div class="chart-surface" ref={surface} hidden={mode !== 'chart'} />
      <div class="chart-labels" ref={labels} hidden={mode !== 'chart'} />
      <header class="chart-top" ref={top}>
        <div class="chart-case chart-strip">
          <Tabs sea={sea} />
          <Position sea={sea} />
          {mode === 'chart' && !upright ? <StripClock sea={sea} /> : null}
          <button
            type="button"
            class="chart-button chart-back"
            aria-label="Back to sea"
            title="Back to sea"
            onClick={() => chart.show(null)}
          >
            ✕
          </button>
        </div>
        {/* Held upright the strip has no room for the clock: it stands under it. */}
        {mode === 'chart' && upright ? <StripClock sea={sea} /> : null}
        <RimCountdown end={end} />
        {notices !== null ? (
          <div class="chart-notices">
            <NoticeLine notices={notices} />
          </div>
        ) : null}
      </header>
      {mode === 'chart' && picked !== null ? (
        <ChartBox sea={sea} e={picked} close={() => (chart.picked.value = null)} />
      ) : null}
      {mode === 'chart' && picked === null && tapped !== null ? (
        <SystemBoxPanel sea={sea} t={tapped} close={() => (chart.tapped.value = null)} />
      ) : null}
      {mode === 'chart' && sea.forecasting !== null ? (
        <TimeBar chart={chart} src={sea.forecasting} />
      ) : null}
      {mode === 'list' ? <ChartList sea={sea} /> : null}
      {mode === 'news' ? <NewsTab sea={sea} /> : null}
      {mode === 'log' ? <LogTab sea={sea} watch={watch} /> : null}
    </div>
  );
}

/** The longest the pocket chart's caption says: the farthest edge, and a week to a new world. */
const POCKET_SIZES = ['edge 99.9 NM', 'new world 6d 23h'];

/**
 * The pocket chart, cased in the instruments' brass: the whole disk small,
 * tilted, with the boat, and its weather now while its pusher is in; how
 * far the edge is and the time until a new world beneath it. A tap opens
 * the chart. Its weather's pusher is set into its frame, on the left edge
 * at its foot, or the bottom edge held upright.
 */
export function PocketChart({
  sea,
  end = null,
  weather = true,
  setWeather = null,
}: {
  sea: ChartSea;
  end?: Countdown | null;
  weather?: boolean;
  setWeather?: ((on: boolean) => void) | null;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Empty before the boat's first position.
  const [edge, setCaption] = useState('');
  const caption = pocketCaption(edge, end?.text.value ?? '');
  const closing = end?.closing.value === true;
  const upright = useUpright();
  useEffect(() => {
    const c = canvas.current;
    if (c === null) {
      return;
    }
    const draw = () => {
      const b = sea.boat();
      setCaption(edgeCaption(b.east, b.north, sea.lip));
      const w = weather && sea.forecasting !== null ? pocketWeather(sea.forecasting) : null;
      drawPocket(c, sea, b, w);
    };
    draw();
    const t = setInterval(draw, 500);
    return () => clearInterval(t);
  }, [sea, weather]);
  const pusher = setWeather !== null && sea.forecasting !== null;
  return (
    <div class={`pocket${pusher ? ' with-pusher' : ''}`}>
      <div class="pocket-frame">
        <button
          type="button"
          class="pocket-chart"
          onClick={() => sea.chart.show('chart')}
          aria-label={caption.name}
        >
          <canvas ref={canvas} width={240} height={156} />
          <span class="pocket-caption" data-readout="pocket">
            {/* As wide as the longest each line says, so the chart keeps its size. */}
            {POCKET_SIZES.map((z) => (
              <span key={z} class="pocket-size" aria-hidden="true">
                {z}
              </span>
            ))}
            {caption.lines.map((l, i) => (
              <span
                key={i}
                class={`pocket-line${i > 0 ? ` pocket-left${closing ? ' closing' : ''}` : ''}`}
                data-readout={i > 0 ? 'falls' : undefined}
              >
                {l}
              </span>
            ))}
          </span>
        </button>
        {pusher ? (
          <Pusher
            name="Weather on the chart"
            id="weather"
            controls=""
            out={weather}
            pressed={weather}
            press={() => setWeather(!weather)}
            edge={upright ? 'bottom' : 'left'}
            class={`pocket-weather${weather ? ' held' : ''}`}
          >
            <WeatherDecal />
          </Pusher>
        ) : null}
      </div>
      {end !== null && end.last.value !== '' ? (
        <span class="visually-hidden" role="status">
          {end.last.value}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Draws the pocket chart: a disk seen tilted, its weather now if given,
 * its charted islands and lights, the mist band, the boat.
 */
export function drawPocket(
  c: HTMLCanvasElement,
  sea: ChartSea,
  b: BoatAt,
  weather: PocketWeather | null = null,
): void {
  // Drawn by the CPU: a canvas the GPU draws, drawn again twice a second,
  // took most of the sea's frames from a second page on a software renderer.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    return;
  }
  const w = c.width;
  const h = c.height;
  // The disk nearly the canvas's width, room left at the rim for the
  // boat's mark; its weather cut to the disk's shape.
  const k = (w * 0.48) / sea.lip;
  const tilt = 0.62;
  const x = (east: number) => w / 2 + east * k;
  const y = (north: number) => h / 2 - north * k * tilt;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, sea.lip * k, sea.lip * k * tilt, 0, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(236, 224, 194, 0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(59, 46, 34, 0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // The mist band.
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, sea.lip * k * 0.93, sea.lip * k * tilt * 0.93, 0, 0, 2 * Math.PI);
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  if (weather !== null) {
    // The weather within the rim: a storm on it is cut by the world's edge.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, sea.lip * k - 1, sea.lip * k * tilt - 1, 0, 0, 2 * Math.PI);
    ctx.clip();
    drawPocketWeather(ctx, weather, x, y, k, tilt);
    ctx.restore();
  }
  for (const e of sea.chart.store.entries) {
    if (e.subject === 'island' && e.bounds !== null) {
      const [w0, s0, e0, n0] = e.bounds;
      ctx.fillStyle = '#6d7a4c';
      ctx.fillRect(x(w0), y(n0), Math.max((e0 - w0) * k, 1.5), Math.max((n0 - s0) * k * tilt, 1.5));
    } else if (e.light >= 0) {
      ctx.fillStyle = '#a8236e';
      ctx.fillRect(x(e.east) - 1.5, y(e.north) - 1.5, 3, 3);
    }
  }
  // The boat, and its heading.
  const bx = x(b.east);
  const by = y(b.north);
  ctx.strokeStyle = '#c8952c';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + Math.sin(b.heading) * 14, by - Math.cos(b.heading) * 14 * tilt);
  ctx.stroke();
  ctx.fillStyle = '#c8952c';
  ctx.beginPath();
  ctx.arc(bx, by, 4, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

/** The notice shown, with its way to dismiss it; the line is in the page from the start, empty. */
export function NoticeLine({ notices }: { notices: Notices }) {
  const n = notices.shown.value;
  useEffect(() => {
    const t = setInterval(() => notices.tick(performance.now()), 250);
    return () => clearInterval(t);
  }, [notices]);
  return (
    <div class="notice-line" role="status" data-readout="notice">
      {n === null ? null : (
        <p class={`panel notice notice-${n.kind.level}`}>
          <span>{n.text}</span>
          <button
            type="button"
            class="notice-dismiss"
            aria-label="Dismiss"
            onClick={() => notices.dismiss(performance.now())}
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}

/** The menu's switches, a kind of notice each, kept on the account. */
export function NoticeSwitches({ notices }: { notices: Notices }) {
  const off = notices.off.value;
  return (
    <>
      <h3>Notices</h3>
      {notices.kinds
        .filter((k) => k.switchable)
        .map((k) => (
          <label class="menu-row" key={k.id}>
            <span>{k.name}</span>
            <input
              type="checkbox"
              name={`notice-${k.id}`}
              checked={!off.has(k.id)}
              onChange={(e) => void notices.set(k.id, e.currentTarget.checked)}
            />
          </label>
        ))}
    </>
  );
}

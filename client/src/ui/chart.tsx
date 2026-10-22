// SPDX-License-Identifier: AGPL-3.0-only

// The chart's screens: the chart itself over the whole screen, where a
// drag moves it, two fingers pinch and turn it, a double tap fits the whole
// disk and a tap opens a place's box; its list, everything charted nearest
// first, the chart's readable twin; the news, a period sheet; the pocket
// chart in the corner at sea; and the notice line.

import './chart.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Chart } from '../chart/chart';
import type { Forecasting } from '../chart/forecasting';
import { formatPosition } from '../chart/position';
import {
  bearingText,
  type ChartStore,
  dayText,
  distanceText,
  edgeCaption,
  whenText,
} from '../chart/store';
import type { BoatAt } from '../chart/view';
import type { ChartEntry } from '../net/messages';
import { PlaceWeatherLines, TimeBar } from './chartweather';
import { type Countdown, endText } from './countdown';
import type { Notices } from './notices';
import { PlayerText } from './player';

/** What the chart's screens need of the world beyond the chart. */
export interface ChartSea {
  chart: Chart;
  /** The boat, where it is and which way it heads. */
  boat: () => BoatAt;
  /** The degrees the pole sinks a nautical mile, and the lip, m. */
  scale: number;
  lip: number;
  /** The lights' characters' notations, by index. */
  characters: readonly string[];
  /** The news, a page at a time, and its columns. */
  news: NewsSource;
  columns: readonly NewsColumn[];
  /** The forecast and what has been, or null without. */
  forecasting: Forecasting | null;
}

/** A column of the news: what its items tell of, what is charted or the world itself. */
export interface NewsColumn {
  id: string;
  title: string;
  of: string;
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
      {e.ai ? ' (AI)' : ''}, {dayText(e.at, now)}
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
  const [text, setText] = useState('');
  useEffect(() => {
    const at = () => {
      const b = sea.boat();
      setText(
        `${formatPosition(b.east, b.north)} · ${edgeCaption(b.east, b.north, sea.lip).replace('Chart · ', '')}`,
      );
    };
    at();
    const t = setInterval(at, 1000);
    return () => clearInterval(t);
  }, [sea]);
  return (
    <p class="chart-position" data-readout="position">
      {text}
    </p>
  );
}

/** Pointers on the chart: a drag moves it, two fingers pinch and turn it, a double tap fits it, a tap picks. */
function useGestures(sea: ChartSea) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const view = sea.chart.view;
    const pts = new Map<number, { x: number; y: number }>();
    let lastTap = 0;
    let down: { x: number; y: number; at: number; moved: number } | null = null;
    const pair = () => {
      const [a, b] = [...pts.values()];
      return a === undefined || b === undefined
        ? null
        : { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    let before = pair();
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = pts.size === 1 ? { x: e.clientX, y: e.clientY, at: e.timeStamp, moved: 0 } : null;
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
      }
      if (pts.size === 1) {
        view.drag(dx, dy);
      } else if (pts.size === 2) {
        const now = pair();
        if (before !== null && now !== null && now.d > 0) {
          view.zoom(before.d / now.d);
          view.turn(now.a - before.a);
        }
        before = now;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (
        e.type === 'pointerup' &&
        down !== null &&
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
          const picked = view.pick(e.clientX - r.left, e.clientY - r.top);
          sea.chart.picked.value = picked;
        }
      }
      pts.delete(e.pointerId);
      down = null;
      before = pair();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.zoom(Math.exp(e.deltaY * 0.001));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [sea]);
  return ref;
}

/** The tabs between the chart, its list and the news, and the way back to sea. */
function Tabs({ sea }: { sea: ChartSea }) {
  const mode = sea.chart.mode.value;
  const tab = (m: 'chart' | 'list' | 'news', label: string) => (
    <button
      type="button"
      class={mode === m ? 'chart-tab chosen' : 'chart-tab'}
      aria-pressed={mode === m}
      onClick={() => sea.chart.show(m)}
    >
      {label}
    </button>
  );
  return (
    <nav class="chart-tabs" aria-label="Chart">
      {tab('chart', 'Chart')}
      {tab('list', 'List')}
      {tab('news', 'News')}
      <button type="button" class="chart-tab chart-close" onClick={() => sea.chart.show(null)}>
        Back to sea
      </button>
    </nav>
  );
}

/** Everything charted, by kind, nearest first: a tap opens the chart there. */
export function ChartList({ sea }: { sea: ChartSea }) {
  const store = sea.chart.store;
  void store.version.value;
  const b = sea.boat();
  const now = Date.now();
  const groups: [string, ChartEntry[]][] = [
    ['Islands', []],
    ['Places', []],
    ['Features', []],
  ];
  for (const e of store.entries) {
    groups[e.subject === 'island' ? 0 : e.subject === 'place' ? 1 : 2]?.[1].push(e);
  }
  const d = (e: ChartEntry) => Math.hypot(e.east - b.east, e.north - b.north);
  return (
    <section class="chart-panel chart-list" aria-label="Everything charted">
      <h2>Charted: {store.size}</h2>
      {groups.map(([title, es]) =>
        es.length === 0 ? null : (
          <div key={title}>
            <h3>{title}</h3>
            <ul>
              {es
                .sort((x, y) => d(x) - d(y))
                .map((e) => (
                  <li key={`${e.subject}:${e.number}`}>
                    <button type="button" onClick={() => sea.chart.showAt(e)}>
                      <span class="chart-list-name">{store.title(e)}</span>
                      <span class="chart-list-kind">{store.kindName(e)}</span>
                      <span class="chart-list-where">
                        {bearingText(Math.atan2(e.east - b.east, e.north - b.north))}{' '}
                        {distanceText(d(e))} · {formatPosition(e.east, e.north)}
                      </span>
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

/** An item of the news. */
export interface NewsItem {
  id: string;
  column: string;
  at: number;
  by: string;
  ai: boolean;
  subject: string;
  number: number;
  title: string;
  what: string;
  worth: number;
  east: number;
  north: number;
  also: { subject: string; number: number; title: string }[];
  /** An item about the world itself: the end it tells of, ms of UTC. */
  endsAt?: number;
}

/** The news, a page at a time, older than before (an item's id), or the newest. */
export type NewsSource = (
  before: string | null,
) => Promise<{ items: NewsItem[]; more: boolean } | null>;

/** The news as the server serves it: GET /api/news. */
export const serverNews: NewsSource = async (before) => {
  try {
    const res = await fetch(`/api/news${before === null ? '' : `?before=${before}`}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as { items: NewsItem[]; more: boolean };
  } catch {
    return null;
  }
};

/** The news made from the chart itself, offline: each island, port, light and wreck charted, newest first. */
export function chartNews(store: ChartStore, news: (e: ChartEntry) => boolean): NewsSource {
  return async () => {
    const items: NewsItem[] = store.entries
      .filter((e) => e.by !== '' && news(e))
      .map((e) => ({
        id: `${e.subject}:${e.number}`,
        column: 'discoveries',
        at: e.at,
        by: e.by,
        ai: e.ai,
        subject: e.subject,
        number: e.number,
        title: store.title(e),
        what: store.kindName(e).toLowerCase(),
        worth: e.worth,
        east: e.east,
        north: e.north,
        also: [],
      }))
      .reverse();
    return { items, more: false };
  };
}

/** An item of the news about what is charted. */
function ChartedItem({ sea, it, now }: { sea: ChartSea; it: NewsItem; now: number }) {
  return (
    <li>
      <button type="button" onClick={() => sea.chart.showPoint(it.east, it.north)}>
        <span class="news-title">{it.title.toUpperCase()}</span>
        {it.what !== '' ? `, ${it.what}` : ''}
        {it.also.length > 0 ? `, with ${it.also.map((a) => a.title).join(' and ')}` : ''}. Charted
        by <PlayerText text={it.by} />
        {it.ai ? ' (AI)' : ''}, {dayText(it.at, now)}.
      </button>
    </li>
  );
}

/** An item of the Notices to Mariners: the world's end, in the reader's own time. */
function WorldItem({ sea, it, zone }: { sea: ChartSea; it: NewsItem; zone: string }) {
  if (it.subject === 'gale') {
    // A gale warning: where its strongest wind was forecast, on the chart at a tap.
    return (
      <li class="news-world news-gale">
        <button type="button" onClick={() => sea.chart.showPoint(it.east, it.north)}>
          <span class="news-title">{it.title.toUpperCase()}.</span> {it.what}.
        </button>
      </li>
    );
  }
  return (
    <li class="news-world">
      <span class="news-title">{it.title.toUpperCase()}.</span> The falls take this world on{' '}
      {endText(it.endsAt ?? 0, zone)}.
    </li>
  );
}

/** The news: a sheet of the period, its columns of discoveries and of notices to mariners, a tap showing where on the chart. */
export function NewsSheet({ sea, end = null }: { sea: ChartSea; end?: Countdown | null }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [failed, setFailed] = useState(false);
  const load = async (before: string | null) => {
    const page = await sea.news(before);
    if (page === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setItems((had) => (before === null ? page.items : [...had, ...page.items]));
    setMore(page.more);
    setFresh(0);
  };
  useEffect(() => {
    void load(null);
    // What is charted while it is open is noted, to be read on asking.
    let on = true;
    sea.chart.store.onCharted((es) => {
      if (on) {
        setFresh((n) => n + es.filter((e) => e.by !== '').length);
      }
    });
    return () => {
      on = false;
    };
  }, [sea]);
  const now = Date.now();
  const worldOf = new Set(sea.columns.filter((c) => c.of === 'world').map((c) => c.id));
  const notices = items.filter((it) => worldOf.has(it.column));
  const charted = items.filter((it) => !worldOf.has(it.column));
  const zone = end?.end.value?.zone ?? '';
  return (
    <section class="chart-panel news-sheet" aria-label="The news">
      <header class="news-masthead">
        <h2>The Shipping Intelligence</h2>
        <p>{sea.columns.map((c) => c.title).join(' · ')}</p>
      </header>
      {notices.length > 0 ? (
        <section class="news-column" aria-label="Notices to Mariners">
          <h3>{sea.columns.find((c) => c.of === 'world')?.title}</h3>
          <ol class="news-items">
            {notices.map((it) => (
              <WorldItem key={it.id} sea={sea} it={it} zone={zone} />
            ))}
          </ol>
        </section>
      ) : null}
      {fresh > 0 ? (
        <button type="button" class="news-fresh" onClick={() => void load(null)}>
          {fresh} new {fresh === 1 ? 'discovery' : 'discoveries'}: read
        </button>
      ) : null}
      {failed ? <p class="news-failed">The news cannot be had just now.</p> : null}
      {charted.length === 0 && !failed ? (
        <p class="news-none">Nothing charted yet: the chart is blank.</p>
      ) : null}
      <ol class="news-items">
        {charted.map((it) => (
          <ChartedItem key={it.id} sea={sea} it={it} now={now} />
        ))}
      </ol>
      {more ? (
        <button
          type="button"
          class="news-more"
          onClick={() => void load(items[items.length - 1]?.id ?? null)}
        >
          Earlier
        </button>
      ) : null}
    </section>
  );
}

/** The countdown at the chart's rim, and at the head of its list. */
function RimCountdown({ end }: { end: Countdown | null }) {
  if (end === null || end.text.value === '') {
    return null;
  }
  return (
    <p class={`chart-falls${end.closing.value ? ' closing' : ''}`} data-readout="chart-falls">
      <span role="timer">Falls in {end.text.value}</span>
    </p>
  );
}

/** The chart over the whole screen, its list, or the news. */
export function ChartScreen({ sea, end = null }: { sea: ChartSea; end?: Countdown | null }) {
  const chart = sea.chart;
  const surface = useGestures(sea);
  const labels = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chart.view.attachLabels(labels.current);
    return () => chart.view.attachLabels(null);
  }, [chart]);
  const mode = chart.mode.value;
  const picked = chart.picked.value;
  return (
    <div class={`chart-screen chart-${mode}`}>
      <div class="chart-surface" ref={surface} hidden={mode !== 'chart'} />
      <div class="chart-labels" ref={labels} hidden={mode !== 'chart'} />
      <header class="chart-top">
        <Tabs sea={sea} />
        <Position sea={sea} />
        <RimCountdown end={end} />
      </header>
      {mode === 'chart' && picked !== null ? (
        <ChartBox sea={sea} e={picked} close={() => (chart.picked.value = null)} />
      ) : null}
      {mode === 'chart' && sea.forecasting !== null ? (
        <TimeBar chart={chart} src={sea.forecasting} />
      ) : null}
      {mode === 'list' ? <ChartList sea={sea} /> : null}
      {mode === 'news' ? <NewsSheet sea={sea} end={end} /> : null}
    </div>
  );
}

/** The pocket chart: the whole disk small, tilted, with the boat; a tap opens the chart. */
export function PocketChart({ sea, end = null }: { sea: ChartSea; end?: Countdown | null }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [edge, setCaption] = useState('Chart');
  // In the world's last days the caption carries the countdown too.
  const caption =
    end?.closing.value && end.text.value !== '' ? `${edge} · falls ${end.text.value}` : edge;
  useEffect(() => {
    const c = canvas.current;
    if (c === null) {
      return;
    }
    const draw = () => {
      const b = sea.boat();
      setCaption(edgeCaption(b.east, b.north, sea.lip));
      drawPocket(c, sea, b);
    };
    draw();
    const t = setInterval(draw, 500);
    return () => clearInterval(t);
  }, [sea]);
  return (
    <button
      type="button"
      class="panel pocket-chart"
      onClick={() => sea.chart.show('chart')}
      aria-label={`${caption}: open the chart`}
    >
      <canvas ref={canvas} width={240} height={180} />
      <span class="pocket-caption" data-readout="pocket">
        {caption}
      </span>
    </button>
  );
}

/** Draws the pocket chart: a disk seen tilted, its charted islands and lights, the mist band, the boat. */
export function drawPocket(c: HTMLCanvasElement, sea: ChartSea, b: BoatAt): void {
  // Drawn by the CPU: a canvas the GPU draws, drawn again twice a second,
  // took most of the sea's frames from a second page on a software renderer.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    return;
  }
  const w = c.width;
  const h = c.height;
  const k = (w * 0.46) / sea.lip;
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
      <h2>Notices</h2>
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

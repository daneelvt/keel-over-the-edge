// SPDX-License-Identifier: AGPL-3.0-only

// The news sheet: a day's edition as a period front page, on the chart's
// paper with its grain. The masthead in IM Fell's capitals with the
// edition's number and date; the day in figures, in italic; the stories,
// each opening with its headword in small capitals, ruled apart, a tap
// opening the chart there with its place's box and a name the sailor's log;
// the reader's own box, ruled round; the Notices to Mariners; and keys to
// the world's other editions. A story the phone has not shown before
// carries a small "new"; one that comes in while the sheet is open slips in
// lit. Loaded the first time the news is opened.

import './news.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { catalog } from '../catalog';
import type { ChartSubject } from '../net/messages';
import type { ChartSea } from './chart';
import { endText } from './countdown';
import { openLog, THEIR_LOG } from './loglazy';
import { markRead, type NewsSource, readStories, serverNews, unread } from './newsread';
import {
  type Edition,
  editionDate,
  editionDay,
  headWords,
  type NewsStory,
  nameWords,
  nextWords,
  storiesOf,
  storyParts,
} from './newswords';
import { MachineMark, PlayerText } from './player';

/** The sheet's words. */
export const MASTHEAD = 'The Shipping Intelligence';
export const SHIPMATES = 'From your shipmates';
export const NEW = 'new';
export const CLOSE = 'Close';
export const NONE = 'No news yet: the day is young.';
export const FAILED = 'The news cannot be had just now.';
/** A story's key to the chart, read with its headword. */
export const ON_THE_CHART = 'on the chart';

/** How often today's edition is read again while the sheet is open, ms: its stories are chosen afresh every ten minutes. */
export const AGAIN = 60_000;

/** How long after a charting today's edition is read again, ms: the chartings of a moment come in together. */
export const AFTER_CHARTING = 3_000;

/** What the sheet is given: where its editions come from, and what it can open. */
export interface NewsSheetProps {
  source: NewsSource;
  /** The edition it opens on, today's for null. */
  day: string | null;
  /** Each asking for an edition: a new one turns the sheet to day again. */
  asked?: object;
  /** What a tap on a story opens: the chart there, or null where it opens nothing (no chart, no place). */
  where: (s: NewsStory) => (() => void) | null;
  /** Listens for chartings, returning what stops it; null where none are heard. */
  charted: ((told: () => void) => () => void) | null;
  /** Closes the sheet, where it stands on its own; null on the chart screen. */
  close: (() => void) | null;
}

/** Words with a figure kept on one line with its unit: "8 m", "41.7 NM". */
export function keptTogether(words: string): string {
  return words.replace(/(\d) (?=(?:m|NM|kn|h)\b)/g, '$1\u00a0');
}

/** The words of a story, its names set in: a name the reader may open a link to its log, a boat's name in italic, ⚙ for a machine. */
function StoryWords({ s }: { s: NewsStory }) {
  const parts = storyParts(s.text, s.names);
  return (
    <>
      {parts.map((p, i) => {
        if ('words' in p) {
          return keptTogether(p.words);
        }
        const n = p.name;
        const w = nameWords(n, p.opens, nextWords(parts, i));
        const machine = n.kind === 'machine';
        const name =
          w.text === '' ? null : n.logged === true && n.name !== undefined ? (
            <button
              type="button"
              class="news-name"
              aria-label={`${n.name}${machine ? ', machine sailor' : ''}: ${THEIR_LOG}`}
              onClick={() => openLog({ kind: 'sailor', name: n.name ?? '' })}
            >
              <PlayerText text={w.text} />
              {machine ? <MachineMark /> : null}
            </button>
          ) : (
            <>
              <PlayerText text={w.text} />
              {machine ? <MachineMark /> : null}
            </>
          );
        return (
          <span key={i}>
            {w.before}
            {w.boat !== '' ? (
              <i>
                <PlayerText text={w.boat} />
              </i>
            ) : null}
            {w.boat !== '' && name !== null ? ', ' : null}
            {name}
            {machine ? w.after.replace(' ⚙', '') : w.after}
          </span>
        );
      })}
    </>
  );
}

/** A story: its headword in small capitals, its words; a tap anywhere on it opens the chart there. */
function Story({
  s,
  fresh,
  arrived,
  go,
}: {
  s: NewsStory;
  fresh: boolean;
  arrived: boolean;
  go: (() => void) | null;
}) {
  const cls = `news-story${go !== null ? ' news-tap' : ''}${arrived ? ' news-arrived' : ''}`;
  return (
    <li class={cls} data-story={s.id}>
      <p class="news-words">
        <span class="news-head">{headWords(s.head)}.</span>
        {fresh ? <span class="news-new">{NEW}</span> : null} <StoryWords s={s} />
        {go !== null ? (
          <button
            type="button"
            class="news-go"
            aria-label={`${headWords(s.head)}, ${ON_THE_CHART}`}
            onClick={go}
          >
            ›
          </button>
        ) : null}
      </p>
    </li>
  );
}

/** The world's notices' column title, from the catalog. */
function marinersTitle(): string {
  return catalog.news.columns.find((c) => c.of === 'world')?.title ?? 'Notices to Mariners';
}

/**
 * The news: a day's edition as a period front page. It reads the edition
 * asked for, today's by default; today's again while it is open, so the
 * stories chosen as the day goes slip in; it notes what it has shown as
 * read.
 */
export function NewsSheet({ source, day, asked, where, charted, close }: NewsSheetProps) {
  const [edition, setEdition] = useState<Edition | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState<string | null>(day);
  // The stories not read when the edition was opened, and those that came in since.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const top = useRef<HTMLElement | null>(null);
  useEffect(() => setShown(day), [day, asked]);
  useEffect(() => {
    let live = true;
    let had: Edition | null = null;
    let t: ReturnType<typeof setInterval> | null = null;
    let soon: ReturnType<typeof setTimeout> | null = null;
    let stop: (() => void) | null = null;
    const again = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        void read();
      }
    };
    // Today's edition fills as the day goes: read again now and then, and
    // soon after a charting, while the sheet is open. A set one never changes.
    const follow = () => {
      t = setInterval(again, AGAIN);
      stop =
        charted?.(() => {
          if (soon === null) {
            soon = setTimeout(() => {
              soon = null;
              again();
            }, AFTER_CHARTING);
          }
        }) ?? null;
    };
    const read = async () => {
      const e = await source(shown);
      if (!live) {
        return;
      }
      if (e === null) {
        if (had === null) {
          setFailed(true);
          setEdition(null);
        }
        return;
      }
      setFailed(false);
      const seen = readStories();
      const ids = storiesOf(e).map((x) => x.id);
      const isNew = ids.filter((id) => !seen.has(id));
      if (had === null) {
        setFresh(new Set(isNew));
        setArrived(new Set());
        if (!e.set) {
          follow();
        }
      } else {
        const before = new Set(storiesOf(had).map((x) => x.id));
        const came = ids.filter((id) => !before.has(id));
        if (came.length > 0) {
          setArrived((a) => new Set([...a, ...came]));
          setFresh((f) => new Set([...f, ...isNew]));
        }
      }
      had = e;
      setEdition(e);
      markRead(ids);
      if (!e.set) {
        unread.value = false;
      }
    };
    void read();
    top.current?.scrollTo?.({ top: 0 });
    return () => {
      live = false;
      if (t !== null) {
        clearInterval(t);
      }
      if (soon !== null) {
        clearTimeout(soon);
      }
      stop?.();
    };
  }, [source, shown, charted, asked]);
  const e = edition;
  const at = e === null ? -1 : e.days.findIndex((d) => d.day === e.day);
  const older = e === null || at < 0 ? undefined : e.days[at + 1];
  const newer = e === null || at <= 0 ? undefined : e.days[at - 1];
  const mariners = marinersTitle();
  const story = (s: NewsStory) => (
    <Story key={s.id} s={s} fresh={fresh.has(s.id)} arrived={arrived.has(s.id)} go={where(s)} />
  );
  return (
    <section
      class={`chart-panel news-sheet${close !== null ? ' news-alone' : ''}`}
      aria-label="The news"
      ref={top}
    >
      {close !== null ? (
        <div class="news-keys news-top-keys">
          <button type="button" class="news-key news-close" onClick={close}>
            {CLOSE}
          </button>
        </div>
      ) : null}
      <header class="news-masthead">
        <h2>{MASTHEAD}</h2>
        {e !== null && e.day !== '' ? (
          <p class="news-edition" data-readout="edition">
            No. {e.number} · {editionDate(e.day, e.zone)}
          </p>
        ) : null}
      </header>
      {e !== null && e.figuresText !== '' ? <p class="news-figures">{e.figuresText}</p> : null}
      {failed ? <p class="news-status">{FAILED}</p> : null}
      {e !== null &&
      e.lead.length + e.stories.length === 0 &&
      !e.set &&
      e.figures.boats + e.figures.charted > 0 ? (
        <p class="news-status">{NONE}</p>
      ) : null}
      {e !== null && e.lead.length > 0 ? (
        <ol class="news-stories news-lead">{e.lead.map(story)}</ol>
      ) : null}
      {e !== null && e.stories.length > 0 ? (
        <ol class="news-stories">{e.stories.map(story)}</ol>
      ) : null}
      {e !== null && e.shipmates.length > 0 ? (
        <section class="news-box" aria-label={SHIPMATES}>
          <h3>{SHIPMATES}</h3>
          <ol class="news-stories">{e.shipmates.map(story)}</ol>
        </section>
      ) : null}
      {e !== null && e.notices.length > 0 ? (
        <section class="news-notices" aria-label={mariners}>
          <h3>{mariners}</h3>
          {e.notices.map((n) => (
            <p key={n.id} class="news-words">
              <span class="news-head">{headWords(n.head)}.</span> The falls take this world on{' '}
              {endText(n.endsAt, e.zone)}.
            </p>
          ))}
        </section>
      ) : null}
      {older !== undefined || newer !== undefined ? (
        <nav class="news-keys news-days" aria-label="Other editions">
          {older !== undefined ? (
            <button
              type="button"
              class="news-key news-older"
              aria-label={`No. ${older.number}, ${editionDay(older.day)}`}
              onClick={() => setShown(older.day)}
            >
              ‹ {editionDay(older.day)}
            </button>
          ) : null}
          {newer !== undefined ? (
            <button
              type="button"
              class="news-key news-newer"
              aria-label={`No. ${newer.number}, ${editionDay(newer.day)}`}
              onClick={() => setShown(newer.set ? newer.day : null)}
            >
              {editionDay(newer.day)} ›
            </button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

/** The News tab: the sheet on the chart screen, a tap on a story opening the chart there with its place's box. */
export function NewsTab({ sea }: { sea: ChartSea }) {
  const chart = sea.chart;
  const asked = chart.newsDay.value;
  return (
    <NewsSheet
      source={sea.news}
      day={asked.day}
      asked={asked}
      where={(s) => storyPlace(sea, s)}
      charted={charting(sea)}
      close={null}
    />
  );
}

/** What opens a story's place on the chart: its place's box, or its point; null for neither. */
export function storyPlace(sea: ChartSea, s: NewsStory): (() => void) | null {
  const chart = sea.chart;
  const e =
    s.subject === undefined ? undefined : chart.store.get(s.subject as ChartSubject, s.number);
  if (e !== undefined) {
    return () => chart.showAt(e);
  }
  const { x, y } = s;
  if (x !== undefined && y !== undefined) {
    return () => chart.showPoint(x, y);
  }
  return null;
}

/** The chart's chartings, heard while the sheet is open, one listener for each sea. */
const heard = new WeakMap<ChartSea, (told: () => void) => () => void>();

function charting(sea: ChartSea): (told: () => void) => () => void {
  let h = heard.get(sea);
  if (h === undefined) {
    h = (told) => sea.chart.store.onCharted(() => told());
    heard.set(sea, h);
  }
  return h;
}

/**
 * The news opened where the chart is not shown (before the sea, waiting to
 * watch): the same sheet over the screen, closed by its Close; its stories
 * open no chart, its names their logs. Opening it again moves it to that
 * edition.
 */
let alone: HTMLElement | null = null;

export function showNewsAlone(day: string | null, source: NewsSource = serverNews): void {
  if (alone === null) {
    alone = document.createElement('div');
    alone.className = 'chart-screen news-alone-screen';
    document.body.append(alone);
  }
  const root = alone;
  render(
    <NewsSheet
      source={source}
      day={day}
      asked={{}}
      where={() => null}
      charted={null}
      close={() => {
        render(null, root);
        root.remove();
        if (alone === root) {
          alone = null;
        }
      }}
    />,
    root,
  );
}

/** Whether the news stands on its own over the screen now. */
export function newsAlone(): boolean {
  return alone !== null;
}

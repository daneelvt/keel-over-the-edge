// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's log, the chart screen's Log tab: on the chart's paper, in the
// logbook's hand. Its head, the sailor's inked portrait, their name and
// since when; the abstract, four figures; then the days, a ruled logbook
// of day, remarks and the day's run, each day opening to its voyages, with
// the whole record at their foot and the log's other worlds; or the
// collection, every kind found, and the rest as silhouettes. Held upright
// one column; held sideways the head and the abstract on the left, the
// rest beside them. The reader's own log has who may read it behind its
// ⋯; another's has the way back to the reader's own, and Watch while its
// sailor can be watched. Loaded when the log is first opened.

import './log.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { inkFile } from '../account/portraitfiles';
import { catalog } from '../catalog';
import { type Look, lookWords, partsOf } from '../catalog/looks';
import type { LogWho } from '../chart/chart';
import {
  type Log,
  type LogAnswer,
  type LogDay,
  type LogGroup,
  type LogKind,
  type LogRibbon,
  type LogShown,
  type LogSource,
  serverLogs,
} from './logapi';
import { Glyph } from './logglyphs';
import {
  CLOSE,
  COCKADE,
  COLLECTION,
  DAYS,
  dayCell,
  dayLong,
  empty,
  figureWords,
  firstWords,
  groupTitle,
  kindName,
  loggedFromLine,
  MACHINE_SAILOR,
  NO_RACES,
  NO_SAILOR,
  NO_SUCH_LOG,
  NOT_HAD,
  NOT_YET,
  OLDER_RACES,
  ONLY_YOU,
  READING,
  RIBBONS,
  recordLines,
  remarks,
  remarksLine,
  ribbonCounts,
  ribbonLines,
  runCell,
  SAILORS,
  shownLine,
  sinceLine,
  TRY_AGAIN,
  voyageLine,
  voyageMore,
  WATCH,
  WHO_READS,
  WHOLE_RECORD,
  worldHeading,
  YOUR_LOG,
} from './logwords';
import { PlayerText } from './player';
import { Prize, raceColour } from './prize';
import { hangSpoon } from './raceapi';

/** The log's inked portrait, the look's drawing on the log's paper; nothing for a look the build has not. With the winner's cockade pinned where the look wears it, for a race won in the world sailed now. */
function Ink({ look, cockade }: { look: Look; cockade: boolean }) {
  const version = partsOf(catalog, look).version;
  const src = version === undefined ? null : inkFile(version.art);
  if (src === null) {
    return <span class="log-ink" />;
  }
  const img = (
    <img
      class="log-ink"
      src={src}
      alt={lookWords(catalog, look)}
      width={88}
      height={110}
      decoding="async"
    />
  );
  if (!cockade || version === undefined) {
    return img;
  }
  const [u, v] = version.art.cockade.inked;
  return (
    <span class="log-ink-frame">
      {img}
      <Cockade at={[u ?? 0.7, v ?? 0.3]} />
    </span>
  );
}

/** The winner's cockade on the inked portrait: a pleated gold rosette about a button, in the log's ink. */
function Cockade({ at }: { at: [number, number] }) {
  const { ribbon, button } = catalog.world.committee.prizes.cockade;
  // Scalloped: the ribbon's pleats round the edge.
  const pleats = 14;
  const edge = Array.from({ length: pleats * 2 }, (_, i) => {
    const a = (Math.PI * i) / pleats;
    const r = i % 2 === 0 ? 10 : 8.4;
    return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
  return (
    <svg
      class="log-cockade"
      viewBox="0 0 24 24"
      role="img"
      aria-label={COCKADE}
      style={{ left: `${(at[0] * 100).toFixed(1)}%`, top: `${(at[1] * 100).toFixed(1)}%` }}
    >
      <polygon points={edge} fill={ribbon} stroke="#2b2622" stroke-width="1" />
      <circle cx="12" cy="12" r="6" fill="none" stroke="#2b2622" stroke-width="0.8" />
      <circle cx="12" cy="12" r="3.4" fill={button} stroke="#2b2622" stroke-width="0.8" />
    </svg>
  );
}

/** Who may read the player's own log: two keys, the one chosen pressed. */
function WhoReads({
  log,
  set,
  close,
}: {
  log: Log;
  set: (s: LogShown) => void;
  close: () => void;
}) {
  const shown = log.shown ?? 'sailors';
  const at = useRef<HTMLElement | null>(null);
  // Opened under the head, which held sideways may be out of view.
  useEffect(() => at.current?.scrollIntoView?.({ block: 'nearest' }), []);
  return (
    <section class="log-who" aria-label={WHO_READS} ref={at}>
      <h3>{WHO_READS}</h3>
      <div class="log-keys">
        {(['sailors', 'me'] as const).map((s) => (
          <button
            key={s}
            type="button"
            class="log-key"
            aria-pressed={shown === s}
            onClick={() => set(s)}
          >
            {s === 'sailors' ? SAILORS : ONLY_YOU}
          </button>
        ))}
      </div>
      <p class="log-faint">{shownLine(shown, false)}</p>
      <button type="button" class="log-key" onClick={close}>
        {CLOSE}
      </button>
    </section>
  );
}

/** The log's head: the portrait, the name, since when, the worlds; ⋯ in one's own; the way back from another's; Watch. */
function Head({
  log,
  who,
  back,
  more,
  setMore,
  watch,
  close,
}: {
  log: Log;
  who: LogWho;
  back: (() => void) | null;
  more: boolean;
  setMore: (on: boolean) => void;
  watch: (() => void) | null;
  close: (() => void) | null;
}) {
  const since = sinceLine(log.since, log.zone);
  const worlds = log.record.worlds;
  const keyed = log.own && !log.machine && who.kind === 'own';
  return (
    <header class="log-head">
      {back !== null || close !== null ? (
        <div class="log-keys log-top-keys">
          {back !== null ? (
            <button type="button" class="log-key log-back" onClick={back}>
              ‹ {YOUR_LOG}
            </button>
          ) : null}
          {close !== null ? (
            <button type="button" class="log-key log-close" onClick={close}>
              {CLOSE}
            </button>
          ) : null}
        </div>
      ) : null}
      <div class="log-id">
        <Ink look={log.look} cockade={log.cockade === true} />
        <div class="log-name">
          <h2>
            <PlayerText text={log.name} />
          </h2>
          {log.machine ? <p class="log-sub">{MACHINE_SAILOR}</p> : null}
          {since !== '' || worlds > 0 ? (
            <p class="log-sub">
              {[since, worlds === 0 ? '' : worlds === 1 ? '1 world' : `${worlds} worlds`]
                .filter((x) => x !== '')
                .join(' · ')}
            </p>
          ) : null}
          {log.own && log.loggedFrom !== undefined && log.loggedFrom > 0 ? (
            <p class="log-sub log-faint">{loggedFromLine(log.loggedFrom, log.zone)}</p>
          ) : null}
        </div>
        {keyed ? (
          <button
            type="button"
            class="log-key log-more"
            aria-label={WHO_READS}
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            ⋯
          </button>
        ) : null}
      </div>
      {watch !== null ? (
        <div class="log-keys">
          <button type="button" class="log-key log-watch" onClick={watch}>
            {WATCH}
          </button>
        </div>
      ) : null}
    </header>
  );
}

/** The abstract: four figures, or the empty log's words. */
function Abstract({ log }: { log: Log }) {
  if (empty(log.record)) {
    return <p class="log-empty">{NOT_YET}</p>;
  }
  return (
    <dl class="log-abstract">
      {log.abstract.map((f) => {
        const [figure, what] = figureWords(f.kind, f.value, log.record);
        return (
          <div key={f.kind} class="log-figure" data-figure={f.kind}>
            <dt>{figure}</dt>
            <dd>{what}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A day of the logbook: its row, and, opened, its voyages. */
function Day({
  d,
  zone,
  open,
  toggle,
}: {
  d: LogDay;
  zone: string;
  open: boolean;
  toggle: () => void;
}) {
  const lines = remarks(d);
  return (
    <li class="log-day-item">
      <button
        type="button"
        class="log-day"
        aria-expanded={open}
        aria-label={`${dayLong(d.date)}: ${remarksLine(lines)}`}
        onClick={toggle}
      >
        <span class="log-day-date">{dayCell(d.date)}</span>
        <span class="log-day-remarks">{remarksLine(lines)}</span>
        <span class="log-day-run">{runCell(d.runM)}</span>
      </button>
      {open ? (
        <ul class="log-voyages">
          {d.voyages.map((v) => (
            <li key={`${v.began}-${v.boat}-${v.ended}`}>
              <p>{voyageLine(v, zone)}</p>
              {voyageMore(v).map((l) => (
                <p key={l} class="log-faint">
                  {l}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The days of a world, the newest first; the whole record; the log's other worlds. */
function Days({ log, read }: { log: Log; read: (world: number) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const w = log.world;
  const others = log.worlds.filter((x) => x.number !== w?.number);
  return (
    <div class="log-days-part">
      {w === null ? (
        <p class="log-faint">
          {empty(log.record)
            ? 'Each day at sea is written here, a line a day; the collection waits to be found.'
            : 'No days logged in this world yet.'}
        </p>
      ) : (
        <>
          <h3 class="log-world">{worldHeading(w, log.zone)}</h3>
          {w.days.length === 0 ? (
            <p class="log-faint">No days logged in this world yet.</p>
          ) : (
            <>
              <div class="log-day log-day-heads" aria-hidden="true">
                <span class="log-day-date">Day</span>
                <span class="log-day-remarks">Remarks</span>
                <span class="log-day-run">NM</span>
              </div>
              <ol class="log-days">
                {w.days.map((d) => (
                  <Day
                    key={d.date}
                    d={d}
                    zone={log.zone}
                    open={open === d.date}
                    toggle={() => setOpen(open === d.date ? null : d.date)}
                  />
                ))}
              </ol>
            </>
          )}
        </>
      )}
      {others.length > 0 ? (
        <nav class="log-worlds" aria-label="Other worlds">
          {others.map((x) => (
            <button
              key={x.number}
              type="button"
              class="log-key"
              onClick={() => read(x.current === true ? 0 : x.number)}
            >
              World {x.number}
            </button>
          ))}
        </nav>
      ) : null}
      {empty(log.record) ? null : (
        <>
          <button
            type="button"
            class="log-key log-whole"
            aria-expanded={whole}
            onClick={() => setWhole(!whole)}
          >
            {WHOLE_RECORD}
          </button>
          {whole ? (
            <dl class="log-record">
              {recordLines(log.record).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A kind of the collection, tapped: its name, where and when first found, how often. */
function KindCard({
  group,
  k,
  zone,
  close,
}: {
  group: string;
  k: LogKind;
  zone: string;
  close: () => void;
}) {
  const found = k.count > 0;
  return (
    <section class="log-card" aria-label={found ? kindName(group, k.id) : 'Not yet found'}>
      <p class="log-card-name">{found || group === 'edge' ? kindName(group, k.id) : '?'}</p>
      {firstWords(group, k, zone).map((l) => (
        <p key={l} class="log-faint">
          {l}
        </p>
      ))}
      <button type="button" class="log-key" onClick={close}>
        {CLOSE}
      </button>
    </section>
  );
}

/** A group of the collection: its title and how many found, its kinds three or five across. */
function Group({ g, zone }: { g: LogGroup; zone: string }) {
  const [card, setCard] = useState<string | null>(null);
  const shown = g.kinds.find((k) => k.id === card);
  return (
    <section class="log-group" data-group={g.id} aria-label={groupTitle(g.id)}>
      <h3>
        {groupTitle(g.id)}{' '}
        <span class="log-faint">
          · {g.found} of {g.kinds.length}
        </span>
      </h3>
      <ul class="log-grid">
        {g.kinds.map((k) => {
          const found = k.count > 0;
          const name = kindName(g.id, k.id);
          return (
            <li key={k.id}>
              <button
                type="button"
                class={`log-cell${found ? '' : ' unfound'}`}
                aria-label={
                  found
                    ? `${name}, found ${k.count === 1 ? 'once' : `${k.count} times`}`
                    : 'Not yet found'
                }
                aria-expanded={card === k.id}
                data-kind={k.id}
                onClick={() => setCard(card === k.id ? null : k.id)}
              >
                <Glyph group={g.id} id={k.id} found={found} />
                <span class="log-cell-name">{found ? name : '?'}</span>
                {k.count > 1 ? <span class="log-count">×{k.count}</span> : null}
                {k.thisWorld === true ? (
                  <span class="log-this" title="Found this world">
                    •
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {shown !== undefined ? (
        <KindCard group={g.id} k={shown} zone={zone} close={() => setCard(null)} />
      ) : null}
    </section>
  );
}

/** The collection, every group. */
function Collection({ log }: { log: Log }) {
  return (
    <div class="log-collection">
      {log.collection.map((g) => (
        <Group key={g.id} g={g} zone={log.zone} />
      ))}
    </div>
  );
}

/** A race's ribbon: its prize drawn, its line, its details; in the reader's own log this world, the spoon's key. */
function RibbonRow({ r, maiden, spoonKey }: { r: LogRibbon; maiden: boolean; spoonKey: boolean }) {
  const [hung, setHung] = useState(r.hung === true);
  const [busy, setBusy] = useState(false);
  const boat = catalog.boats.find((b) => b.id === r.boat)?.name ?? '';
  const [line, more] = ribbonLines(r, boat);
  const placed = r.kind === 'race' && r.how !== 'ret' ? (r.place ?? 0) : 0;
  return (
    <li class="log-ribbon" data-ribbon={r.code}>
      <span class={`log-ribbon-prize${r.newcomers === true ? ' newcomers' : ''}`}>
        <Prize
          place={placed}
          of={r.fleet}
          colour={r.newcomers === true ? '#3d7a46' : raceColour(r.code)}
          medal={r.kind === 'trial' ? (r.medal ?? '') : ''}
          size={40}
        />
      </span>
      <span class="log-ribbon-words">
        <span class="log-ribbon-line">
          <PlayerText text={line} />
        </span>
        {more !== '' || maiden ? (
          <span class="log-faint">
            {[maiden ? 'Maiden race' : '', more].filter((x) => x !== '').join(' · ')}
          </span>
        ) : null}
        {spoonKey ? (
          <span class="log-keys">
            <button
              type="button"
              class="log-key"
              aria-pressed={hung}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void hangSpoon(r.code, !hung).then((a) => {
                  setBusy(false);
                  if (a.ok) {
                    setHung(a.value.hang);
                  }
                });
              }}
            >
              {hung ? 'The spoon hangs at the stern' : 'Hang the spoon at the stern'}
            </button>
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** The ribbons read so far: their pages, and whether one is being read, failed, or more follow. */
interface RibbonsRead {
  races: LogRibbon[];
  more: boolean;
  reading: boolean;
  failed: boolean;
}

/**
 * The log's ribbons: the counts kept for good, then each race's ribbon
 * by world, the newest first, read a page at a time when the tab opens,
 * older pages on asking.
 */
function Ribbons({ log, who, source }: { log: Log; who: LogWho; source: LogSource }) {
  const rb = log.ribbons ?? null;
  const sailed = rb?.counts.sailed ?? 0;
  const [read, setRead] = useState<RibbonsRead>({
    races: [],
    more: sailed > 0,
    reading: false,
    failed: false,
  });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const page = (from: number) => {
    setRead((r) => ({ ...r, reading: true, failed: false }));
    void source.ribbons(who, from).then((got) => {
      if (!live.current) {
        return;
      }
      setRead((r) =>
        got === null
          ? { ...r, reading: false, failed: true }
          : {
              races: [...r.races.slice(0, from), ...(got.races ?? [])],
              more: got.more === true,
              reading: false,
              failed: false,
            },
      );
    });
  };
  useEffect(() => {
    if (sailed > 0) {
      page(0);
    }
  }, []);
  if (rb === null || sailed === 0) {
    return (
      <div class="log-ribbons-part">
        <p class="log-faint">{NO_RACES}</p>
        {rb !== null && rb.counts.ran > 0 ? <p>{ribbonCounts(rb.counts).at(-1)}</p> : null}
      </div>
    );
  }
  const worlds: { world: number; races: LogRibbon[] }[] = [];
  for (const r of read.races) {
    const last = worlds.at(-1);
    if (last !== undefined && last.world === r.world) {
      last.races.push(r);
    } else {
      worlds.push({ world: r.world, races: [r] });
    }
  }
  // The whole record is here: its oldest race is the sailor's first.
  const all = !read.more && read.races.length === sailed;
  const oldest = read.races.at(-1);
  return (
    <div class="log-ribbons-part" data-readout="log-ribbons">
      <div class="log-ribbon-counts">
        {ribbonCounts(rb.counts).map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
      {worlds.map((w) => (
        <section key={w.world} class="log-ribbon-world">
          <h3 class="log-world">World {w.world.toLocaleString('en')}</h3>
          <ol class="log-ribbons">
            {w.races.map((r) => (
              <RibbonRow
                key={`${r.code}-${r.at}`}
                r={r}
                maiden={all && r === oldest}
                spoonKey={
                  log.own && !log.machine && r.world === log.worldNow && r.awards.includes('spoon')
                }
              />
            ))}
          </ol>
        </section>
      ))}
      {read.reading ? (
        <p class="log-faint" aria-live="polite">
          {READING}
        </p>
      ) : read.failed ? (
        <div class="log-keys">
          <p class="log-faint">{NOT_HAD}</p>
          <button type="button" class="log-key" onClick={() => page(read.races.length)}>
            {TRY_AGAIN}
          </button>
        </div>
      ) : read.more ? (
        <div class="log-keys">
          <button
            type="button"
            class="log-key"
            data-key="older-ribbons"
            onClick={() => page(read.races.length)}
          >
            {OLDER_RACES}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** What reading a log has come to, while it is read. */
type Reading = { kind: 'reading' } | { kind: 'read'; answer: LogAnswer };

/**
 * A sailor's log: whose is who, the reader's own unless set; setWho moves
 * to another's or back. watch, if given, watches a sailor (closing the
 * chart); close, if given, closes a log opened on its own.
 */
export function LogSheet({
  who,
  setWho,
  source = serverLogs,
  watch = null,
  close = null,
}: {
  who: LogWho;
  setWho: (w: LogWho) => void;
  source?: LogSource;
  watch?: ((name: string) => void) | null;
  close?: (() => void) | null;
}) {
  const [world, setWorld] = useState(0);
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const [tab, setTab] = useState<'days' | 'collection' | 'ribbons'>('days');
  const [more, setMore] = useState(false);
  const [watchable, setWatchable] = useState(false);
  const [again, setAgain] = useState(0);
  const sheet = useRef<HTMLElement | null>(null);
  const key = who.kind === 'own' ? 'own' : who.kind === 'sailor' ? `s:${who.name}` : `m:${who.id}`;
  // Another log, or the reader's own again: from its newest world, at its top.
  useEffect(() => {
    setWorld(0);
    setMore(false);
    setTab('days');
    sheet.current?.scrollTo?.({ top: 0 });
    for (const el of sheet.current?.querySelectorAll('.log-side, .log-main') ?? []) {
      el.scrollTo?.({ top: 0 });
    }
  }, [key]);
  useEffect(() => {
    let live = true;
    setReading({ kind: 'reading' });
    void source.read(who, world).then((answer) => {
      if (live) {
        setReading({ kind: 'read', answer });
      }
    });
    return () => {
      live = false;
    };
  }, [key, world, again]);
  // Watch, while the sailor whose log it is can be watched.
  useEffect(() => {
    setWatchable(false);
    if (watch === null || who.kind === 'own') {
      return;
    }
    let live = true;
    const name = who.name;
    void source.watchable(name).then((on) => {
      if (live) {
        setWatchable(on);
      }
    });
    return () => {
      live = false;
    };
  }, [key, watch === null]);
  const back = who.kind === 'own' ? null : () => setWho({ kind: 'own' });
  const answer = reading.kind === 'read' ? reading.answer : null;
  const log = answer !== null && 'log' in answer ? answer.log : null;
  const setShown = (s: LogShown) => {
    if (log === null) {
      return;
    }
    void source.setShown(s).then((ok) => {
      if (ok) {
        setReading({ kind: 'read', answer: { log: { ...log, shown: s, chosen: true } } });
      }
    });
  };
  let body: preact.ComponentChildren;
  if (reading.kind === 'reading') {
    body = (
      <p class="log-faint log-status" aria-live="polite">
        {READING}
      </p>
    );
  } else if (log === null) {
    const refused = answer !== null && 'refused' in answer;
    body = (
      <div class="log-status">
        <p>{refused ? (who.kind === 'own' ? NO_SAILOR : NO_SUCH_LOG) : NOT_HAD}</p>
        {refused ? null : (
          <button type="button" class="log-key" onClick={() => setAgain((n) => n + 1)}>
            {TRY_AGAIN}
          </button>
        )}
      </div>
    );
  }
  const keys =
    back !== null || close !== null ? (
      <div class="log-keys log-top-keys">
        {back !== null ? (
          <button type="button" class="log-key log-back" onClick={back}>
            ‹ {YOUR_LOG}
          </button>
        ) : null}
        {close !== null ? (
          <button type="button" class="log-key log-close" onClick={close}>
            {CLOSE}
          </button>
        ) : null}
      </div>
    ) : null;
  return (
    <section
      class={`chart-panel log-sheet${log === null ? ' log-alone' : ''}`}
      aria-label={log === null ? 'The log' : `The log of ${log.name}`}
      ref={sheet}
      data-log={key}
    >
      {log === null ? (
        <div class="log-main">
          {keys}
          {body}
        </div>
      ) : (
        <>
          <div class="log-side">
            <Head
              log={log}
              who={who}
              back={back}
              more={more}
              setMore={setMore}
              watch={
                watchable && watch !== null && who.kind !== 'own' ? () => watch(who.name) : null
              }
              close={close}
            />
            {more ? <WhoReads log={log} set={setShown} close={() => setMore(false)} /> : null}
            <Abstract log={log} />
          </div>
          <div class="log-main">
            <div class="log-keys log-switch" role="tablist" aria-label="The log">
              {(['days', 'collection', 'ribbons'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  class="log-key"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                >
                  {t === 'days' ? DAYS : t === 'collection' ? COLLECTION : RIBBONS}
                </button>
              ))}
            </div>
            {tab === 'days' ? (
              <Days log={log} read={setWorld} />
            ) : tab === 'collection' ? (
              <Collection log={log} />
            ) : (
              <Ribbons key={`${key}-${again}`} log={log} who={who} source={source} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A log opened where the chart screen is not, the start screen's: the
 * same sheet over the screen, closed by its Close. Opening another moves
 * it to that log.
 */
let alone: { root: HTMLElement; who: LogWho } | null = null;

export function showLogAlone(who: LogWho, source: LogSource = serverLogs): void {
  if (alone === null) {
    const root = document.createElement('div');
    root.className = 'chart-screen log-alone-screen';
    document.body.append(root);
    alone = { root, who };
  }
  const a = alone;
  const draw = (w: LogWho) => {
    a.who = w;
    render(
      <LogSheet
        who={w}
        setWho={draw}
        source={source}
        close={() => {
          render(null, a.root);
          a.root.remove();
          alone = null;
        }}
      />,
      a.root,
    );
  };
  draw(who);
}

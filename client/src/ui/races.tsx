// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore's windows over the sea: Make a race, one panel with every
// choice filled in so that Make it works at once (a race or a time trial,
// the course on a small chart of its own, the boat, when, who may enter,
// and a name suggested with character); the share of a race made, its
// link with a picture of the course drawn on the phone; and a race's
// card, which its link opens: the name, the course drawn small, the boat,
// the start in the reader's own time and the time to it, its owner, the
// entrants (machine sailors marked, newcomers' green ribbons, one not
// named to the reader by their boat and number), and Enter, Watch when it
// starts and Add to calendar; the owner's rarer acts behind ⋯. A refusal
// says why, kindly, and when it lifts; the reader can still watch. Every
// key is the instruments' head keys' size. Loaded the first time one
// opens: none of it is in the game's first download.

import './races.css';
import { batch, effect } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MachineMark, PlayerText } from './player';
import {
  type CourseTold,
  type Entrant,
  type MakeChoices,
  makeRace,
  type RaceCard,
  type RaceVerb,
  type Refusal,
  raceAct,
  readCard,
  saveCalendar,
  suggestName,
  type Who,
  watchRace,
} from './raceapi';
import { courseShape, pathData, shapeText } from './racecourse';
import { drawPicture, pictureWords, shareRace } from './racepicture';
import { type RacesView, racesShown } from './raceslazy';
import {
  ADD_TO_CALENDAR,
  actRefusalText,
  boatsText,
  CLOSE,
  ENTER,
  ENTER_LINE,
  ENTER_WITH_CREW,
  enteredText,
  enterRefusalText,
  entrantLabel,
  fromLocalInput,
  kindText,
  laterDefault,
  lengthText,
  localInput,
  MAKE_A_RACE,
  MAKE_IT,
  makeRefusalText,
  minutesText,
  NEWCOMERS_DETAIL,
  ownerText,
  phaseText,
  STARTS,
  startChoiceText,
  startOf,
  startsInText,
  WATCH_LATER,
  WATCH_WHEN_STARTS,
  WITHDRAW,
  whenLine,
  whoText,
} from './racewords';
import { browserSharer, type Sharer, shareLink } from './sharelink';
import { COPIED } from './watchwords';

/** A course drawn small: its legs, marks, line and the wind's arrow, in an SVG of size × size. */
export function CoursePicture({ course, size }: { course: CourseTold; size: number }) {
  const s = courseShape(course, size, size, Math.max(4, size * 0.08));
  const r = Math.max(2.5, size / 26);
  return (
    <svg
      class="race-course-picture"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={course.kind === 'island' ? course.name : shapeText(course)}
    >
      <rect class="race-paper" x="0" y="0" width={size} height={size} rx="6" />
      <path class="race-legs" d={pathData(s.legs)} />
      {s.line !== null ? (
        <line
          class="race-line"
          x1={s.line[0].x}
          y1={s.line[0].y}
          x2={s.line[1].x}
          y2={s.line[1].y}
        />
      ) : null}
      {s.marks.map((m) => (
        <circle key={`${m.x},${m.y}`} class="race-mark" cx={m.x} cy={m.y} r={r} />
      ))}
      {s.wind !== null ? (
        <>
          <line
            class="race-wind"
            x1={s.wind[0].x}
            y1={s.wind[0].y}
            x2={s.wind[1].x}
            y2={s.wind[1].y - r}
          />
          <path
            class="race-wind-head"
            d={`M${s.wind[1].x} ${s.wind[1].y + r * 0.6} l${-r * 1.2} ${-r * 1.8} h${r * 2.4} z`}
          />
        </>
      ) : null}
    </svg>
  );
}

/** The green ribbon beside a newcomer's name. */
export function Ribbon() {
  return (
    <span class="race-ribbon" role="img" aria-label="newcomer" title="newcomer">
      <svg viewBox="0 0 12 16" width="10" height="14" aria-hidden="true">
        <path d="M3 9 L1 15 L4 13 L6 15 L6 10 Z M9 9 L11 15 L8 13 L6 15 L6 10 Z" />
        <circle cx="6" cy="5.5" r="4.5" />
      </svg>
    </span>
  );
}

/** An entrant as the card shows them. */
function EntrantRow({ e }: { e: Entrant }) {
  const l = entrantLabel(e);
  return (
    <li class={`race-entrant${e.me === true ? ' me' : ''}`} data-entrant={e.number}>
      <span class="race-entrant-number">{e.number}</span>
      <span class="race-entrant-name">
        {l.kind === 'name' ? (
          <PlayerText text={l.name} />
        ) : l.kind === 'boat' ? (
          <span>
            the <i>{l.boat}</i>, {l.number}
          </span>
        ) : (
          <span>No. {l.number}</span>
        )}
        {e.machine ? <MachineMark /> : null}
        {e.newcomer ? <Ribbon /> : null}
        {e.me === true ? <span class="race-faint"> (you)</span> : null}
      </span>
    </li>
  );
}

/** A row of keys of which one is chosen, pressed in. */
function Choice<T extends string | number>({
  label,
  name,
  options,
  chosen,
  choose,
  text,
}: {
  label: string;
  name: string;
  options: readonly T[];
  chosen: T;
  choose: (v: T) => void;
  text: (v: T) => string;
}) {
  return (
    <fieldset class="race-choice" aria-label={label} data-choice={name}>
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={o === chosen}
          class={o === chosen ? 'chosen' : ''}
          onClick={() => choose(o)}
        >
          {text(o)}
        </button>
      ))}
    </fieldset>
  );
}

/** Takes the focus into a window as it opens, and lets Escape close it. */
function useWindow(close: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  return { ref, onKeyDown };
}

/** The courses offered to a boat, buoy courses first. */
export function coursesFor(make: MakeChoices, boat: string): CourseTold[] {
  const b = make.boats.find((x) => x.id === boat);
  return make.courses.filter(
    (c) => c.boats?.[boat] !== undefined && (c.kind === 'island' || b?.buoys !== false),
  );
}

/** Make a race: one panel, everything filled in. */
export function MakeRace({ view, close }: { view: RacesView; close: () => void }) {
  const board = view.board.value;
  useEffect(() => {
    void view.refresh();
  }, [view]);
  const win = useWindow(close);
  return (
    <section
      class="panel race-window race-make"
      role="dialog"
      aria-labelledby="race-make-title"
      tabIndex={-1}
      ref={win.ref}
      onKeyDown={win.onKeyDown}
      data-panel="make-race"
    >
      <h2 id="race-make-title">{MAKE_A_RACE}</h2>
      {board === null ? (
        <>
          <p class="race-faint" aria-live="polite">
            Reading the races…
          </p>
          <div class="race-keys race-foot">
            <button type="button" onClick={close}>
              {CLOSE}
            </button>
          </div>
        </>
      ) : !board.make.can.ok ? (
        <>
          <p class="race-refused" role="status" data-readout="race-refused">
            {makeRefusalText(board.make.can.reason ?? '', {
              until: board.make.can.until,
              now: view.now(),
            })}
          </p>
          <div class="race-keys race-foot">
            <button type="button" onClick={close}>
              {CLOSE}
            </button>
          </div>
        </>
      ) : (
        <MakeForm view={view} make={board.make} close={close} />
      )}
    </section>
  );
}

function MakeForm({
  view,
  make,
  close,
}: {
  view: RacesView;
  make: MakeChoices;
  close: () => void;
}) {
  const [kind, setKind] = useState<'race' | 'trial'>('race');
  const [boat, setBoat] = useState(() =>
    make.boats.some((b) => b.id === make.boat) ? make.boat : (make.boats[0]?.id ?? ''),
  );
  const offered = useMemo(() => coursesFor(make, boat), [make, boat]);
  const [course, setCourse] = useState(() => offered[0]?.id ?? '');
  const [when, setWhen] = useState<number>(10);
  const [later, setLater] = useState(() =>
    localInput(laterDefault(view.now(), make.earliest, make.latest)),
  );
  const [who, setWho] = useState<Who>(() =>
    make.who.includes('everyone') ? 'everyone' : (make.who[0] ?? 'everyone'),
  );
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  // A course no longer offered to the boat chosen: the first that is.
  const chosen = offered.find((c) => c.id === course) ?? offered[0];
  const courseId = chosen?.id ?? '';
  // The name suggested afresh as the choices change, until the player writes their own.
  const suggestAt = kind === 'trial' ? 0 : when > 0 ? when : later;
  useEffect(() => {
    if (edited || courseId === '' || boat === '') {
      return;
    }
    let live = true;
    const at = kind === 'trial' ? view.now() : startOf(when, later, view.now());
    void suggestName({ kind, course: courseId, boat, at }, view.fetch).then((n) => {
      if (live && n !== '') {
        setName(n);
      }
    });
    return () => {
      live = false;
    };
  }, [kind, courseId, boat, suggestAt, edited]);

  const submit = async () => {
    if (busy || courseId === '') {
      return;
    }
    setBusy(true);
    setRefusal(null);
    const at = kind === 'trial' ? view.now() : startOf(when, later, view.now());
    const a = await makeRace(
      { kind, course: courseId, boat, at: Number.isFinite(at) ? at : 0, who, name: name.trim() },
      view.fetch,
    );
    setBusy(false);
    if (a.ok) {
      // One change: the window passes from the panel to the share, never closed.
      batch(() => {
        view.make.value = false;
        view.shared.value = a.value;
      });
      void view.refresh();
      return;
    }
    setRefusal(a.refusal);
  };

  const minutes = chosen?.boats?.[boat] ?? 0;
  const said =
    refusal === null
      ? ''
      : makeRefusalText(refusal.reason, { until: refusal.until, now: view.now() }, refusal.name);
  return (
    <form
      class="race-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Choice
        label="Race or time trial"
        name="kind"
        options={['race', 'trial'] as const}
        chosen={kind}
        choose={setKind}
        text={kindText}
      />
      <label class="race-label" for="race-boat">
        Boat
      </label>
      <select
        id="race-boat"
        name="boat"
        value={boat}
        onChange={(e) => setBoat(e.currentTarget.value)}
      >
        {make.boats.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <p class="race-label" id="race-course-label">
        Course
      </p>
      {offered.length === 0 ? (
        <p class="race-faint">No course is open to this boat yet.</p>
      ) : (
        <fieldset class="race-courses" aria-labelledby="race-course-label">
          {offered.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.id === courseId}
              class={`race-course${c.id === courseId ? ' chosen' : ''}`}
              data-course={c.id}
              onClick={() => setCourse(c.id)}
            >
              <CoursePicture course={c} size={56} />
              <span class="race-course-name">{c.name}</span>
            </button>
          ))}
        </fieldset>
      )}
      {chosen !== undefined ? (
        <p class="race-faint race-course-about">
          {[
            chosen.kind === 'island' ? lengthText(chosen.length ?? 0) : shapeText(chosen),
            minutesText(minutes),
          ]
            .filter((s) => s !== '')
            .join(' · ')}
        </p>
      ) : null}
      {kind === 'race' ? (
        <>
          <p class="race-label" id="race-when-label">
            Start
          </p>
          <Choice
            label="Start"
            name="when"
            options={STARTS}
            chosen={when as (typeof STARTS)[number]}
            choose={setWhen}
            text={startChoiceText}
          />
          {when === 0 ? (
            <input
              type="datetime-local"
              name="later"
              aria-label="The start, in your own time"
              value={later}
              min={localInput(make.earliest)}
              max={localInput(make.latest)}
              onInput={(e) => setLater(e.currentTarget.value)}
            />
          ) : null}
          <p class="race-faint" data-readout="race-start">
            {Number.isFinite(startOf(when, later, view.now()))
              ? whenLine(startOf(when, later, view.now()), view.now())
              : 'Choose a day and a time.'}
          </p>
        </>
      ) : (
        <p class="race-faint">A time trial opens at once and runs to the world’s last hours.</p>
      )}
      <label class="race-label" for="race-who">
        Who may enter
      </label>
      <select
        id="race-who"
        name="who"
        value={who}
        onChange={(e) => setWho(e.currentTarget.value as Who)}
      >
        {make.who.map((w) => (
          <option key={w} value={w}>
            {whoText(w)}
          </option>
        ))}
      </select>
      {who === 'newcomers' ? <p class="race-faint">{NEWCOMERS_DETAIL}</p> : null}
      <label class="race-label" for="race-name">
        Name
      </label>
      <input
        id="race-name"
        type="text"
        name="race-name"
        autocomplete="off"
        spellcheck={false}
        maxLength={48}
        value={name}
        aria-invalid={refusal?.reason === 'name'}
        onInput={(e) => {
          setName(e.currentTarget.value);
          setEdited(true);
        }}
      />
      <div class="race-keys race-foot">
        {said !== '' ? (
          <p class="race-refused race-foot-said" role="status" data-readout="race-refused">
            {said}
          </p>
        ) : null}
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" class="key-main" disabled={busy || courseId === ''}>
          {MAKE_IT}
        </button>
      </div>
    </form>
  );
}

/** The share of a race made: its picture, Share the race, Copy the link, and its card. */
export function RaceShare({
  view,
  card,
  close,
  sharer = browserSharer(),
}: {
  view: RacesView;
  card: RaceCard;
  close: () => void;
  sharer?: Sharer;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const words = useMemo(() => pictureWords(card), [card]);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const draw = () => {
      if (canvas.current !== null) {
        drawPicture(canvas.current, card, words);
      }
    };
    draw();
    // Again once the type is in, the first drawing in the fallbacks.
    void Promise.all([
      document.fonts.load('60px "IM Fell English SC"'),
      document.fonts.load('500 36px "Alegreya Sans"'),
    ])
      .then(draw)
      .catch(() => {});
  }, [card, words]);
  const win = useWindow(close);
  return (
    <section
      class="panel race-window race-share"
      role="dialog"
      aria-labelledby="race-share-title"
      tabIndex={-1}
      ref={win.ref}
      onKeyDown={win.onKeyDown}
      data-panel="race-share"
    >
      <h2 id="race-share-title">Your race is made</h2>
      <p class="race-faint">Share its link: whoever has it can enter.</p>
      <canvas
        ref={canvas}
        class="race-share-picture"
        role="img"
        aria-label={`${card.name}: ${words.boats}, ${words.when}`}
        data-readout="race-picture"
      />
      <p class="race-link" data-readout="race-link">
        {card.link}
      </p>
      {said !== '' ? (
        <p class="race-faint" role="status">
          {said}
        </p>
      ) : null}
      <div class="race-keys">
        <button
          type="button"
          class="key-main"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setSaid('');
            void shareRace(card, words, sharer).then((r) => {
              setBusy(false);
              setSaid(
                r === 'saved'
                  ? 'Picture saved, link copied'
                  : r === 'failed'
                    ? 'No picture can be made just now.'
                    : '',
              );
            });
          }}
        >
          Share the race
        </button>
        <button
          type="button"
          onClick={() => {
            void shareLink({ url: card.link, text: card.link }, { copy: sharer.copy }).then((r) =>
              setCopied(r === 'copied'),
            );
          }}
        >
          {copied ? COPIED : 'Copy the link'}
        </button>
      </div>
      <div class="race-keys race-foot">
        <button
          type="button"
          onClick={() => {
            batch(() => {
              view.shared.value = null;
              view.card.value = card.code;
            });
          }}
        >
          See the race
        </button>
        <button type="button" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

/** Whether a race is still before its start: entering, withdrawing and the owner's acts are open. */
function beforeStart(card: RaceCard): boolean {
  return card.phase === 'open' || card.phase === 'closed';
}

/** The owner's rarer acts, behind ⋯: close entry, change the start once, remove an entrant, cancel. */
function OwnerActs({
  card,
  act,
  busy,
  now,
}: {
  card: RaceCard;
  act: (verb: RaceVerb, body?: unknown) => void;
  busy: boolean;
  now: number;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [number, setNumber] = useState('');
  const [at, setAt] = useState(() => localInput(card.startsAt));
  const others = card.entrants.filter((e) => e.me !== true);
  return (
    <div class="race-owner" data-readout="race-owner">
      {card.phase === 'open' ? (
        <button type="button" disabled={busy} onClick={() => act('close')}>
          Close entry
        </button>
      ) : null}
      {!card.mine.moved && card.kind === 'race' ? (
        <div class="race-owner-row">
          <input
            type="datetime-local"
            name="move"
            aria-label="A new start, in your own time"
            value={at}
            min={localInput(now)}
            onInput={(e) => setAt(e.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy || !Number.isFinite(fromLocalInput(at))}
            onClick={() => act('move', { at: fromLocalInput(at) })}
          >
            Change the start
          </button>
        </div>
      ) : null}
      {others.length > 0 ? (
        <div class="race-owner-row">
          <select
            name="remove"
            aria-label="The entrant to remove"
            value={number}
            onChange={(e) => setNumber(e.currentTarget.value)}
          >
            <option value="">An entrant…</option>
            {others.map((e) => (
              <option key={e.number} value={String(e.number)}>
                {e.number}. {e.name ?? (e.boat != null ? `the ${e.boat}` : `No. ${e.number}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || number === ''}
            onClick={() => act('remove', { number: Number(number) })}
          >
            Remove
          </button>
        </div>
      ) : null}
      {cancelling ? (
        <fieldset class="race-owner-row" aria-label="Cancel the race">
          <p class="race-faint">Cancel the race? Its entrants are told.</p>
          <button type="button" onClick={() => setCancelling(false)}>
            Keep it
          </button>
          <button type="button" class="race-danger" disabled={busy} onClick={() => act('cancel')}>
            Cancel the race
          </button>
        </fieldset>
      ) : (
        <button type="button" disabled={busy} onClick={() => setCancelling(true)}>
          Cancel the race…
        </button>
      )}
    </div>
  );
}

/** How often an open card is read again, ms. */
const CARD_EVERY = 30_000;

/** A race's card, by its code. */
export function RaceCardPanel({
  view,
  code,
  close,
}: {
  view: RacesView;
  code: string;
  close: () => void;
}) {
  const [card, setCard] = useState<RaceCard | null>(null);
  const [unread, setUnread] = useState<Refusal | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(() => view.now());
  useEffect(() => {
    let live = true;
    const read = () => {
      void readCard(code, view.fetch).then((a) => {
        if (!live) {
          return;
        }
        if (a.ok) {
          setCard(a.value);
          setUnread(null);
        } else {
          setUnread(a.refusal);
        }
      });
    };
    read();
    const r = setInterval(read, CARD_EVERY);
    const t = setInterval(() => setNow(view.now()), 1000);
    return () => {
      live = false;
      clearInterval(r);
      clearInterval(t);
    };
  }, [code, view]);
  const win = useWindow(close);

  const act = (verb: RaceVerb, body?: unknown) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSaid('');
    void raceAct(code, verb, body, view.fetch).then((a) => {
      setBusy(false);
      if (a.ok) {
        setCard(a.value);
        setMore(false);
        void view.refresh();
        return;
      }
      const t = { until: a.refusal.until, now: view.now() };
      setSaid(
        verb === 'enter'
          ? enterRefusalText(a.refusal.reason, t)
          : verb === 'withdraw' && a.refusal.reason === 'not-entered'
            ? enterRefusalText(a.refusal.reason, t)
            : actRefusalText(a.refusal.reason, t),
      );
    });
  };

  const head = (
    <h2 id="race-card-title">{card === null ? 'A race' : <PlayerText text={card.name} />}</h2>
  );
  if (card === null) {
    return (
      <section
        class="panel race-window race-card"
        role="dialog"
        aria-labelledby="race-card-title"
        tabIndex={-1}
        ref={win.ref}
        onKeyDown={win.onKeyDown}
        data-panel="race-card"
      >
        {head}
        <p class="race-faint" aria-live="polite" data-readout="race-unread">
          {unread === null ? 'Reading the race…' : enterRefusalText(unread.reason, { now })}
        </p>
        <div class="race-keys race-foot">
          <button type="button" onClick={close}>
            {CLOSE}
          </button>
        </div>
      </section>
    );
  }
  const before = beforeStart(card);
  const phase = phaseText(card.phase);
  const enter = card.enter;
  const mine = card.mine;
  const crew = view.crew();
  const refused =
    before && !mine.entered && !enter.ok
      ? enterRefusalText(enter.reason ?? '', { until: enter.until, now })
      : '';
  return (
    <section
      class="panel race-window race-card"
      role="dialog"
      aria-labelledby="race-card-title"
      tabIndex={-1}
      ref={win.ref}
      onKeyDown={win.onKeyDown}
      data-panel="race-card"
      data-code={card.code}
    >
      <div class="race-card-head">
        {head}
        {mine.owner && before ? (
          <button
            type="button"
            class="race-more"
            aria-label="The race’s owner’s choices"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            ⋯
          </button>
        ) : null}
      </div>
      <div class="race-card-top">
        <CoursePicture course={card.course} size={72} />
        <div class="race-card-words">
          <p data-readout="race-kind">
            {card.harbour ? 'Harbour race' : kindText(card.kind)} · {boatsText(card.boat.name)}
          </p>
          <p class="race-faint">
            {card.course.name}
            {minutesText(card.minutes) === '' ? '' : ` · ${minutesText(card.minutes)}`}
          </p>
          <p class="race-faint">
            Made by{' '}
            {card.owner?.name != null && !card.harbour ? (
              <PlayerText text={card.owner.name} />
            ) : (
              ownerText(card)
            )}
            {card.owner?.machine === true && !card.harbour ? <MachineMark /> : null}
          </p>
        </div>
      </div>
      {card.kind === 'race' ? (
        <p class="race-start" data-readout="race-start">
          <strong>{whenLine(card.startsAt, now)}</strong>
          {before ? (
            <span class="race-faint" data-readout="race-countdown">
              {' '}
              · {startsInText(card.startsAt - now)}
            </span>
          ) : null}
        </p>
      ) : (
        <p class="race-start">Open now: sail it whenever you like.</p>
      )}
      {card.who !== 'everyone' ? (
        <p class="race-who">
          {whoText(card.who)}
          {card.who === 'newcomers' ? <Ribbon /> : null}
        </p>
      ) : null}
      {phase !== '' ? (
        <p class="race-phase" data-readout="race-phase">
          {phase}
        </p>
      ) : null}
      {more && mine.owner && before ? (
        <OwnerActs card={card} act={act} busy={busy} now={now} />
      ) : null}
      {before && mine.entered ? (
        <p class="race-entered" data-readout="race-entered">
          You’re entered{mine.number > 0 ? `, No. ${mine.number}` : ''}
          {mine.withCrew ? ', with your crew' : ''}.
        </p>
      ) : null}
      {refused !== '' ? (
        <p class="race-refused" role="status" data-readout="race-refused">
          {refused}
        </p>
      ) : null}
      {said !== '' ? (
        <p class="race-refused" role="status" data-readout="race-said">
          {said}
        </p>
      ) : null}
      {before ? (
        <>
          {!mine.entered && enter.ok ? (
            <>
              <div class="race-keys">
                <button
                  type="button"
                  class="key-main"
                  disabled={busy}
                  onClick={() => act('enter', { crew: false })}
                >
                  {ENTER}
                </button>
                {crew ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act('enter', { crew: true })}
                  >
                    {ENTER_WITH_CREW}
                  </button>
                ) : null}
              </div>
              <p class="race-faint">{ENTER_LINE}</p>
            </>
          ) : null}
          <div class="race-keys">
            <WatchLater code={card.code} />
            {card.kind === 'race' ? <Calendar view={view} code={card.code} /> : null}
            {mine.entered ? (
              <button type="button" disabled={busy} onClick={() => act('withdraw')}>
                {WITHDRAW}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <h3 class="race-entrants-head">{enteredText(card.entrants.length, card.most)}</h3>
      {card.entrants.length === 0 ? (
        <p class="race-faint">Nobody yet: be the first.</p>
      ) : (
        <ol class="race-entrants" data-readout="race-entrants">
          {card.entrants.map((e) => (
            <EntrantRow key={e.number} e={e} />
          ))}
        </ol>
      )}
      <div class="race-keys race-foot">
        <button type="button" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

/** Watch when it starts: remembered on this device, and said so. */
function WatchLater({ code }: { code: string }) {
  const [asked, setAsked] = useState(false);
  return asked ? (
    <p class="race-faint race-key-note" role="status">
      {WATCH_LATER}
    </p>
  ) : (
    <button
      type="button"
      onClick={() => {
        watchRace(code);
        setAsked(true);
      }}
    >
      {WATCH_WHEN_STARTS}
    </button>
  );
}

/** Add to calendar: the race's calendar file, saved. */
function Calendar({ view, code }: { view: RacesView; code: string }) {
  const [said, setSaid] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void saveCalendar(code, view.fetch).then((ok) =>
            setSaid(ok ? '' : 'The calendar file cannot be made just now.'),
          );
        }}
      >
        {ADD_TO_CALENDAR}
      </button>
      {said !== '' ? (
        <p class="race-faint race-key-note" role="status">
          {said}
        </p>
      ) : null}
    </>
  );
}

/** Whichever of races' windows is open, over a scrim a tap on which closes it. */
export function RacesWindows({ view }: { view: RacesView }) {
  const shared = view.shared.value;
  const code = view.card.value;
  const close = () => {
    if (view.shared.value !== null) {
      view.shared.value = null;
    } else if (view.make.value) {
      view.make.value = false;
    } else {
      view.card.value = null;
    }
  };
  const open = shared !== null ? 'share' : view.make.value ? 'make' : code !== null ? 'card' : '';
  if (open === '') {
    return null;
  }
  return (
    <>
      <div class="race-scrim" aria-hidden="true" onClick={close} />
      {shared !== null ? (
        <RaceShare view={view} card={shared} close={close} />
      ) : view.make.value ? (
        <MakeRace view={view} close={close} />
      ) : code !== null ? (
        <RaceCardPanel key={code} view={view} code={code} close={close} />
      ) : null}
    </>
  );
}

/**
 * Shows races' windows over the page, as the start screen and the player's
 * own panel do before the sea, until every one is closed.
 */
export function showRaces(parent: HTMLElement, view: RacesView): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'hud race-host';
    parent.append(root);
    render(<RacesWindows view={view} />, root);
    const stop = effect(() => {
      if (!racesShown(view)) {
        // Unmounted after this effect has run, not within it, and only if
        // no other window opened meanwhile.
        queueMicrotask(() => {
          if (racesShown(view)) {
            return;
          }
          stop();
          render(null, root);
          root.remove();
          resolve();
        });
      }
    });
  });
}

// SPDX-License-Identifier: AGPL-3.0-only

// Shipmates, the screens' parts of them. The panel over the sea: offers
// waiting first, each with Accept and ✕ (declined without a word to
// them); then the shipmates, each with where they are and Message, and
// behind the row's ⋯ asking to come aboard the boat they skipper,
// watching them at sea, ending, blocking and reporting; then the recent
// crew of the last day, with Be shipmates while it may be offered; and
// "Appear offline" at its foot. Ending, a block and leaving the water to
// watch ask once, in the row's place. A thread with one shipmate: its
// lines, the field and Send, kept above the keyboard on a phone; a long
// press on their line opens chat's sheet of mute, block and report. And
// under the case, a notice of a message whose thread is not open, or of
// an offer.
//
// Loaded with sailing together's parts (deck.tsx), only when first
// needed: none of it is in the game's first download.

import './shipmates.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Portrait } from '../account/portraits';
import type { RecentCrew, Shipmate, ShipmateOffer } from '../account/shipmatesapi';
import { catalog } from '../catalog';
import { lookOf } from '../catalog/looks';
import { LineRow, useKeyboard } from './chat';
import { type ChatLine, lineLength, lineOf } from './chatlog';
import { BLOCK, blockWords, CANCEL, CLOSE, leftText, REPORT, SEND } from './chatwords';
import type { DeckView } from './decklazy';
import { actionName, DISMISS, MORE, moreFor, plain, type Words } from './deckwords';
import { PlayerText } from './player';
import type { ThreadNote } from './shipmatelog';
import { nameOf, REFRESH_EVERY, type ShipmateAsk, type ShipmatesView } from './shipmatesview';
import {
  ACCEPT,
  APPEAR_OFFLINE,
  APPEAR_OFFLINE_DETAIL,
  ASK_ABOARD,
  BE_SHIPMATES,
  CLOSE_THREAD,
  DECLINE,
  emptyThreadWords,
  endWords,
  KEEP,
  MESSAGE,
  MESSAGE_FIELD,
  MESSAGE_LOST,
  MESSAGES_RESTING,
  messageHint,
  messageRefusedWords,
  NO_LONGER,
  NO_RECENT,
  NO_SHIPMATES,
  OFFERED_TAG,
  OFFERS_WAITING,
  OPEN,
  presenceText,
  READING,
  RECENT_CREW,
  RECENT_DETAIL,
  SEE,
  SHIPMATE,
  SHIPMATES,
  STAR,
  threadWords,
  UNREADABLE,
  wouldLikeWords,
  wroteWords,
} from './shipmatewords';
import { LEAVE, LEAVE_QUESTION, STAY, WATCH } from './watchwords';

/** Words with a player's text among them, that text as player text. */
function Said({ words }: { words: Words }) {
  return (
    <>
      {words.map((w, i) =>
        typeof w === 'string' ? w : <PlayerText key={`${i}-${w.player}`} text={w.player} />,
      )}
    </>
  );
}

/** A sailor's portrait from their look code, or nothing for a code the catalog cannot read. */
function Face({ look }: { look: number }) {
  const l = look < 0 ? null : lookOf(catalog, look);
  return l === null ? <span class="deck-face" /> : <Portrait looks={catalog} look={l} size={40} />;
}

/** The mark beside a shipmate's name. */
export function Star() {
  return (
    <span class="deck-star" role="img" aria-label={SHIPMATE} title={SHIPMATE}>
      {STAR}
    </span>
  );
}

/** Escape calls back, while drawn. */
function useEscape(back: () => void) {
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        back();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
}

/** The list read again every REFRESH_EVERY while drawn, and once as it is. */
function useRefresh(view: ShipmatesView) {
  useEffect(() => {
    void view.refresh();
    const t = setInterval(() => void view.refresh(), REFRESH_EVERY);
    return () => clearInterval(t);
  }, []);
}

/** The notice under the case: a message whose thread is not open, or an offer; the oldest first. */
export function ShipmateNotices({ view }: { view: ShipmatesView }) {
  const n = view.notices.value[0];
  if (n === undefined) {
    return null;
  }
  const message = n.kind === 'message';
  const words = message ? wroteWords(n.name) : wouldLikeWords(n.name);
  const put = () => {
    view.notices.value = view.notices.value.filter((x) => x !== n);
  };
  return (
    <section
      class="panel deck-line shipmate-notice"
      role="status"
      aria-label={plain(words)}
      data-notice={n.kind}
      data-shipmate={n.id}
    >
      <span class="deck-line-words">
        <Said words={words} />
      </span>
      <button
        type="button"
        class="plate-key key-main"
        onClick={() => {
          put();
          if (message) {
            view.thread.value = n.id;
          } else {
            view.panel.value = true;
          }
        }}
      >
        {message ? OPEN : SEE}
      </button>
      <button type="button" class="notice-dismiss" aria-label={DISMISS} onClick={put}>
        ✕
      </button>
    </section>
  );
}

/** A row's name, its marks and its faint line beneath. */
function Who({ name, star = false, faint = '' }: { name: string; star?: boolean; faint?: string }) {
  return (
    <div class="deck-row-who">
      <p class="deck-row-name">
        <strong>
          <PlayerText text={name} />
        </strong>
        {star ? <Star /> : null}
      </p>
      {faint !== '' ? <p class="deck-faint">{faint}</p> : null}
    </div>
  );
}

/** What came of the player's last act on this row, under it. */
function Told({ view, id }: { view: ShipmatesView; id: string }) {
  const t = view.told.value;
  return t !== null && t.id === id ? (
    <p class="deck-row-note" role="status">
      <Said words={t.words} />
    </p>
  ) : null;
}

/** A key on a row, the person it acts on named for a screen reader. */
function Key({
  words,
  name,
  main = false,
  act,
}: {
  words: string;
  name: string;
  main?: boolean;
  act: () => void;
}) {
  return (
    <button
      type="button"
      class={`plate-key${main ? ' key-main' : ''}`}
      aria-label={actionName(words, name)}
      onClick={act}
    >
      {words}
    </button>
  );
}

/** A row's ⋯ key, and what is behind it, opened under the row. */
function More({
  name,
  open,
  toggle,
  keys,
}: {
  name: string;
  open: boolean;
  toggle: () => void;
  keys: { words: string; act: () => void }[];
}) {
  return (
    <>
      <button
        type="button"
        class="plate-key deck-more"
        aria-label={moreFor(name)}
        aria-expanded={open}
        onClick={toggle}
      >
        {MORE}
      </button>
      {open ? (
        <div class="deck-row-more">
          {keys.map((k) => (
            <Key key={k.words} words={k.words} name={name} act={k.act} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The one question asked in a row's place: ending, a block, leaving the water to watch. */
function AskRow({
  id,
  what,
  name,
  yes,
  no,
}: {
  id: string;
  what: ShipmateAsk['what'];
  name: string;
  yes: () => void;
  no: () => void;
}) {
  const [words, sure, keep]: [Words, string, string] =
    what === 'end'
      ? [endWords(name), NO_LONGER, KEEP]
      : what === 'block'
        ? [blockWords(name), BLOCK, CANCEL]
        : [[LEAVE_QUESTION], LEAVE, STAY];
  return (
    <li class="deck-row deck-putting" data-shipmate={id} data-asking={what}>
      <p>
        <Said words={words} />
      </p>
      <span class="deck-row-keys">
        <button type="button" class="plate-key key-main" onClick={yes}>
          {sure}
        </button>
        <button type="button" class="plate-key" onClick={no}>
          {keep}
        </button>
      </span>
    </li>
  );
}

/** Whether watching another boat would take the own boat out of the water first. */
function leavesWater(deck: DeckView): boolean {
  return (
    deck.status.value === 'sailing' && deck.watching.value === null && deck.aboard.value === null
  );
}

/**
 * The shipmates' panel, over the sea: offers waiting, shipmates, the
 * recent crew, and "Appear offline" at its foot.
 */
export function ShipmatesPanel({ deck, view }: { deck: DeckView; view: ShipmatesView }) {
  const list = view.list.value;
  const [opened, setOpened] = useState(view.openRow ?? '');
  const [asking, setAsking] = useState<ShipmateAsk | null>(view.asking ?? null);
  const close = () => {
    view.panel.value = false;
  };
  useEscape(close);
  useRefresh(view);
  const toggle = (id: string) => setOpened(opened === id ? '' : id);
  const ask = (id: string, what: ShipmateAsk['what']) => {
    setOpened('');
    setAsking({ id, what });
  };
  const report = (id: string, name: string) => {
    setOpened('');
    // Reported over HTTP by account: the line it names is none.
    deck.chat.sheet.value = {
      who: { line: 0 },
      name,
      machine: false,
      step: 'report',
      shipmate: id,
    };
  };
  const answer = (id: string, name: string) => {
    const a = asking;
    setAsking(null);
    if (a === null) {
      return;
    }
    if (a.what === 'end') {
      void view.end({ id }, name);
    } else if (a.what === 'block') {
      void view.block(id, name);
    } else {
      close();
      view.watch(name);
    }
  };
  const asked = (id: string, name: string) =>
    asking !== null && asking.id === id ? (
      <AskRow
        key={`ask-${id}`}
        id={id}
        what={asking.what}
        name={name}
        yes={() => answer(id, name)}
        no={() => setAsking(null)}
      />
    ) : null;

  const offerRow = (o: ShipmateOffer) =>
    asked(o.id, o.name) ?? (
      <li class="deck-row" key={`offer-${o.id}`} data-shipmate={o.id} data-row="offer">
        <Face look={o.look} />
        <Who name={o.name} />
        <span class="deck-row-keys">
          <Key words={ACCEPT} name={o.name} main act={() => void view.accept(o)} />
          <button
            type="button"
            class="plate-key"
            aria-label={actionName(DECLINE, o.name)}
            title={DECLINE}
            onClick={() => void view.decline(o)}
          >
            ✕
          </button>
        </span>
        <Told view={view} id={o.id} />
      </li>
    );

  const shipmateRow = (s: Shipmate) => {
    const more: { words: string; act: () => void }[] = [];
    if (s.skipper) {
      more.push({
        words: ASK_ABOARD,
        act: () => {
          close();
          view.knock(s.id);
        },
      });
    }
    if (s.presence === 'sea' && deck.aboard.value === null) {
      more.push({
        words: WATCH,
        act: () => {
          if (leavesWater(deck)) {
            ask(s.id, 'watch');
          } else {
            close();
            view.watch(s.name);
          }
        },
      });
    }
    more.push(
      { words: NO_LONGER, act: () => ask(s.id, 'end') },
      { words: BLOCK, act: () => ask(s.id, 'block') },
      { words: REPORT, act: () => report(s.id, s.name) },
    );
    return (
      asked(s.id, s.name) ?? (
        <li
          class="deck-row"
          key={`mate-${s.id}`}
          data-shipmate={s.id}
          data-row="shipmate"
          data-presence={s.presence}
        >
          <Face look={s.look} />
          <Who name={s.name} faint={presenceText(s.presence)} />
          <span class="deck-row-keys">
            <Key
              words={MESSAGE}
              name={s.name}
              act={() => {
                view.thread.value = s.id;
              }}
            />
            <More name={s.name} open={opened === s.id} toggle={() => toggle(s.id)} keys={more} />
          </span>
          <Told view={view} id={s.id} />
        </li>
      )
    );
  };

  const recentRow = (r: RecentCrew) =>
    asked(r.id, r.name) ?? (
      <li class="deck-row" key={`recent-${r.id}`} data-shipmate={r.id} data-row="recent">
        <Face look={r.look} />
        <Who name={r.name} star={r.shipmate} faint={r.offered && !r.shipmate ? OFFERED_TAG : ''} />
        <span class="deck-row-keys">
          {r.can ? (
            <Key
              words={BE_SHIPMATES}
              name={r.name}
              act={() => void view.offer({ id: r.id }, r.name)}
            />
          ) : null}
          <More
            name={r.name}
            open={opened === `recent-${r.id}`}
            toggle={() => toggle(`recent-${r.id}`)}
            keys={[
              { words: BLOCK, act: () => ask(r.id, 'block') },
              { words: REPORT, act: () => report(r.id, r.name) },
            ]}
          />
        </span>
        {/* An offer's words under the recent row it was made from, unless its shipmate's row shows them. */}
        {list?.shipmates.some((s) => s.id === r.id) ? null : <Told view={view} id={r.id} />}
      </li>
    );

  // What came of an act on a row no longer listed: said at the foot.
  const t = view.told.value;
  const rows = new Set([
    ...(list?.offers ?? []).map((o) => o.id),
    ...(list?.shipmates ?? []).map((s) => s.id),
    ...(list?.recent ?? []).map((r) => r.id),
  ]);
  const orphan = t !== null && !rows.has(t.id) ? t.words : null;

  return (
    <section
      class="panel deck-window deck-list shipmates-panel"
      aria-labelledby="shipmates-title"
      data-panel="shipmates"
    >
      <h2 id="shipmates-title">{SHIPMATES}</h2>
      {list === null ? (
        <p class="deck-faint" aria-live="polite">
          {view.failed.value ? UNREADABLE : READING}
        </p>
      ) : (
        <>
          {list.offers.length > 0 ? (
            <>
              <h3 class="shipmates-head">{OFFERS_WAITING}</h3>
              <ul class="deck-rows" data-rows="offers">
                {list.offers.map(offerRow)}
              </ul>
            </>
          ) : null}
          {list.shipmates.length > 0 ? (
            <ul class="deck-rows" data-rows="shipmates">
              {list.shipmates.map(shipmateRow)}
            </ul>
          ) : (
            <p class="deck-faint">{NO_SHIPMATES}</p>
          )}
          <h3 class="shipmates-head">
            {RECENT_CREW}
            <span class="deck-faint shipmates-detail">{RECENT_DETAIL}</span>
          </h3>
          {list.recent.length > 0 ? (
            <ul class="deck-rows" data-rows="recent">
              {list.recent.map(recentRow)}
            </ul>
          ) : (
            <p class="deck-faint">{NO_RECENT}</p>
          )}
        </>
      )}
      {orphan !== null ? (
        <p class="deck-row-note" role="status">
          <Said words={orphan} />
        </p>
      ) : null}
      <label class="deck-switch shipmates-offline">
        <span>
          {APPEAR_OFFLINE}
          <span class="deck-faint deck-switch-detail">{APPEAR_OFFLINE_DETAIL}</span>
        </span>
        <input
          type="checkbox"
          name="appear-offline"
          checked={list?.offline === true}
          disabled={list === null}
          onChange={(e) => void view.setOffline(e.currentTarget.checked)}
        />
      </label>
      <div class="deck-keys deck-list-foot">
        <button type="button" class="plate-key deck-close" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

/** A thread's note in words: why a message was not sent, or that it never went. */
export function threadNoteWords(n: ThreadNote, name: string): Words {
  return n.kind === 'lost' ? [MESSAGE_LOST] : messageRefusedWords(n.why, name);
}

/** The name a thread goes by: the list's, or the one its shipmate's last message came with. */
function threadName(view: ShipmatesView, id: string, lines: readonly ChatLine[]): string {
  const heard = [...lines].reverse().find((l) => !l.you)?.name ?? '';
  return nameOf(view.list.value, id, heard);
}

/**
 * A thread with one shipmate, in a window over the sea and above the
 * keyboard: its lines, what came of the last, and the field with Send;
 * or, with messages resting, why there is no field.
 */
export function ShipmateThread({
  deck,
  view,
  id,
  sailor,
}: {
  deck: DeckView;
  view: ShipmatesView;
  id: string;
  sailor: string | null;
}) {
  const threads = view.threads;
  const all = threads.lines(id);
  const hidden = deck.chat.log.hidden.value;
  const lines = all.filter((l) => l.you || !hidden.has(l.name));
  const note = threads.note(id);
  const list = view.list.value;
  const name = threadName(view, id, all);
  const presence = presenceText(list?.shipmates.find((s) => s.id === id)?.presence ?? '');
  const resting = list !== null && !list.messages;
  const draft = view.drafts.value.get(id) ?? '';
  const keyboard = useKeyboard(view.keyboard ?? deck.chat.keyboard, true);
  const ol = useRef<HTMLOListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const setDraft = (text: string) => {
    const next = new Map(view.drafts.value);
    if (text === '') {
      next.delete(id);
    } else {
      next.set(id, text);
    }
    view.drafts.value = next;
  };
  const close = () => {
    view.thread.value = null;
  };
  useEscape(close);
  useRefresh(view);

  // Own messages with no echo, and old notes, go in time.
  const waiting = threads.waiting.value;
  useEffect(() => {
    if (!waiting && note === null) {
      return;
    }
    const t = setInterval(() => threads.expire(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting, note]);

  // A message refused, or lost, comes back to the field to be mended.
  useEffect(() => {
    if (note !== null && note.text !== '' && (view.drafts.value.get(id) ?? '') === '') {
      setDraft(note.text);
    }
  }, [note]);

  // The newest line in view.
  useLayoutEffect(() => {
    const el = ol.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, lines[lines.length - 1]?.pending, keyboard]);

  const act = (l: ChatLine) => {
    deck.chat.sheet.value = { who: { line: l.id }, name: l.name, machine: false, step: 'menu' };
  };
  const length = lineLength(draft.trim());
  const left = leftText(length, 200);
  const send = (e: Event) => {
    e.preventDefault();
    if (lineOf(draft) === null) {
      return;
    }
    const self = sailor ?? '';
    if (view.say(id, draft, self)) {
      setDraft('');
    }
    field.current?.focus();
  };
  // Over the keyboard, the window stands in the part of the screen left.
  const shown = typeof innerHeight === 'number' ? innerHeight - keyboard : 0;
  const style =
    keyboard > 0 ? { top: `${shown / 2}px`, maxHeight: `${Math.max(0, shown - 16)}px` } : undefined;
  const closeKey = (where: 'head' | 'foot') => (
    <button
      type="button"
      class={`plate-key shipmate-close ${where}-close`}
      aria-label={CLOSE_THREAD}
      onClick={close}
    >
      {CLOSE}
    </button>
  );
  return (
    <section
      class={`panel deck-window shipmate-thread${keyboard > 0 ? ' keyboard' : ''}`}
      role="dialog"
      aria-label={plain(threadWords(name))}
      data-thread={id}
      style={style}
    >
      <div class="shipmate-thread-head">
        <h2 class="shipmate-thread-name">
          <PlayerText text={name} />
          <Star />
        </h2>
        {presence !== '' ? <span class="deck-faint shipmate-presence">{presence}</span> : null}
        {closeKey('head')}
      </div>
      <ol class="chat-lines shipmate-lines" ref={ol} aria-live="polite">
        {lines.length === 0 ? (
          <li class="chat-line faint">
            <Said words={emptyThreadWords(name)} />
          </li>
        ) : null}
        {lines.map((l) => (
          <LineRow key={l.key} line={l} act={act} />
        ))}
      </ol>
      {note !== null ? (
        <p class="chat-note" role="status">
          <Said words={threadNoteWords(note, name)} />
        </p>
      ) : null}
      {resting ? (
        <div class="chat-foot">
          <p class="chat-state">{MESSAGES_RESTING}</p>
          {closeKey('foot')}
        </div>
      ) : (
        <form class="chat-foot" onSubmit={send}>
          <input
            ref={field}
            type="text"
            name="shipmate-message"
            aria-label={MESSAGE_FIELD}
            placeholder={messageHint(name)}
            autocomplete="off"
            enterkeyhint="send"
            maxLength={400}
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <button type="submit" class="plate-key key-main" disabled={length === 0 || length > 200}>
            {SEND}
          </button>
          {closeKey('foot')}
          {left !== '' ? <span class="chat-left">{left}</span> : null}
        </form>
      )}
    </section>
  );
}

/** Shipmates' windows over the sea: a thread, or the panel. */
export function ShipmatesWindows({
  deck,
  view,
  sailor,
}: {
  deck: DeckView;
  view: ShipmatesView;
  sailor: string | null;
}) {
  const id = view.thread.value;
  if (id !== null) {
    return <ShipmateThread key={id} deck={deck} view={view} id={id} sailor={sailor} />;
  }
  return view.panel.value ? <ShipmatesPanel deck={deck} view={view} /> : null;
}

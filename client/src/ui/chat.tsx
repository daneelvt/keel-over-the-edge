// SPDX-License-Identifier: AGPL-3.0-only

// Chat aboard, the screens' parts of it. The strip under the case, with
// sailing together's other parts: folded, one line, the newest said;
// open, the last lines, what came of the player's last line, and the
// field with Send, kept above the keyboard on a phone. Each line is its
// sender's name and words as player text, with the machine mark for a
// machine sailor; a long press on another's line (a right-click on a
// computer) opens the sheet of mute, block and report, as the keys on
// each row of who is aboard do. Anyone watching a boat where everyone
// aboard is a machine sailor reads the lines and has no field. Before a first
// line, the Rules of the sea; with the player's own chat off, a key to
// turn it on (the card first for a player of 13 to 17).
//
// Loaded with sailing together's parts (deck.tsx), only when first
// needed: none of it is in the game's first download.

import './chat.css';
import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ChatTurnOn } from '../account/chatcard';
import { RulesCard } from '../account/firstasks';
import type { ReportReasonTold } from '../net/messages';
import { type ChatLine, type ChatNote, fitStrip, lineLength, lineOf } from './chatlog';
import {
  BLOCK,
  BLOCK_ASHORE,
  BLOCK_DETAIL,
  blockWords,
  CANCEL,
  CHAT_ABOARD,
  CHAT_OFF_FOR_YOU,
  CHAT_RESTING,
  CHOOSE_REASON,
  CLOSE,
  FOLD_CHAT,
  LINE_FIELD,
  LINE_LOST,
  leftText,
  lineWords,
  MACHINE_SAILOR,
  MAX_NOTE,
  MORE_FOR,
  MUTE,
  MUTE_DETAIL,
  NOT_REPORTED,
  NOTHING_SAID,
  OPEN_CHAT,
  REPORT,
  REPORT_DETAIL,
  REPORT_NOTE,
  REPORT_REASONS,
  REPORT_WHY,
  REPORTED,
  refusedText,
  reportWords,
  restingText,
  SAY_SOMETHING,
  SEND,
  SEND_REPORT,
  spectatorReadsWords,
  TURN_CHAT_ON,
  tiedWords,
  UNBLOCK,
  UNMUTE,
} from './chatwords';
import { type ChatSheet, chatReadOnly, type DeckView, selfOf } from './decklazy';
import { plain, type Words } from './deckwords';
import { PlayerText } from './player';
import { REPORT_SHIPMATE_DETAIL } from './shipmatewords';

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

/** How long a press is before it opens the sheet, ms; and how far a finger may move, px. */
const LONG_PRESS = 500;
const PRESS_SLOP = 10;

/** The words of a note, as the strip shows it. */
export function noteWords(n: ChatNote): Words {
  switch (n.kind) {
    case 'refused':
      return [refusedText(n.why)];
    case 'lost':
      return [LINE_LOST];
    case 'tied':
      return tiedWords(n);
    case 'reported':
      return [n.ok ? REPORTED : NOT_REPORTED];
  }
}

/** The handlers that open the sheet on a long press, a right-click, or the menu key. */
function usePress(open: (() => void) | null) {
  const timer = useRef<number | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const stop = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    from.current = null;
  };
  useEffect(() => stop, []);
  if (open === null) {
    return {};
  }
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      stop();
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        open();
      }, LONG_PRESS);
    },
    onPointerMove: (e: PointerEvent) => {
      const f = from.current;
      if (f !== null && Math.hypot(e.clientX - f.x, e.clientY - f.y) > PRESS_SLOP) {
        stop();
      }
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu: (e: Event) => {
      e.preventDefault();
      stop();
      open();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        open();
      }
    },
  };
}

/** The machine mark beside a machine sailor's name. */
function Cog() {
  return (
    <span class="deck-cog" role="img" aria-label={MACHINE_SAILOR} title={MACHINE_SAILOR}>
      ⚙
    </span>
  );
}

/** One line: the sender's name and words; another's opens the sheet on a long press. */
export function LineRow({ line, act }: { line: ChatLine; act: ((l: ChatLine) => void) | null }) {
  const can = act !== null && !line.you && line.id !== 0;
  const press = usePress(can ? () => act(line) : null);
  return (
    <li
      class={`chat-line${line.you ? ' mine' : ''}${line.pending ? ' pending' : ''}`}
      data-line={line.id}
      tabIndex={can ? 0 : undefined}
      aria-haspopup={can ? 'dialog' : undefined}
      title={can ? MORE_FOR : undefined}
      {...press}
    >
      <strong class="chat-name">
        <PlayerText text={line.name} />
      </strong>
      {line.machine ? <Cog /> : null}{' '}
      <span class="chat-text">
        <PlayerText text={line.text} />
      </span>
    </li>
  );
}

/** What the strip says instead of its field, by how chat stands; '' for the field. */
function stateText(d: DeckView, now: number): string {
  const s = d.chat.state.value;
  switch (s?.status) {
    case 'off':
      return CHAT_RESTING;
    case 'own-off':
      return CHAT_OFF_FOR_YOU;
    case 'resting':
      return restingText(s.until, now);
    default:
      return '';
  }
}

/** The height the keyboard covers at the foot of the screen, px: the scene's held, or the visual viewport's. */
export function useKeyboard(held: ReadonlySignal<number> | null, on: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (held !== null || !on || vv == null) {
      return;
    }
    const read = () => setInset(Math.max(0, innerHeight - (vv.offsetTop + vv.height)));
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, [held, on]);
  return held !== null ? held.value : inset;
}

/** The lines' least and most height in the open strip, px: two lines, and seven. */
const LINES_MIN = 40;
const LINES_MAX = 140;

/** The parts the open strip stays above: the controls, the plate at the foot, the watch's bar. */
const BELOW =
  '[data-control=helm], [data-control=sheet], .pilot-head, .pilot-button, .reef-key, .deck-plate, .watch-bar';

/**
 * Chat aboard's strip, under the case: folded to the newest line, or open
 * to the last lines and the field.
 */
export function ChatStrip({ deck, sailor }: { deck: DeckView; sailor: string | null }) {
  const chat = deck.chat;
  const log = chat.log;
  const open = chat.open.value;
  const readOnly = chatReadOnly(deck);
  const lines = log.lines.value;
  const note = log.note.value;
  const now = Date.now();
  const blocked = stateText(deck, now);
  const self = selfOf(deck.crew.value)?.name || sailor || '';
  const strip = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const keyboard = useKeyboard(deck.chat.keyboard, open);
  const [fit, setFit] = useState<{ lines: number; lift: number }>({ lines: LINES_MAX, lift: 0 });
  // Counts the changes to the screen about the open strip: a part shown
  // or gone below it, a turn of the phone, fits it again.
  const [, setMoved] = useState(0);
  useEffect(() => {
    // The screen's parts are its own children: the readouts that change
    // within them each frame are not watched.
    const screen = strip.current?.closest('.hud-screen');
    if (!open || screen == null) {
      return;
    }
    const moved = () => setMoved((n) => n + 1);
    const seen = new MutationObserver(moved);
    seen.observe(screen, { childList: true });
    addEventListener('resize', moved);
    // The parts drawn since the strip was first fitted.
    const frame = requestAnimationFrame(moved);
    return () => {
      seen.disconnect();
      removeEventListener('resize', moved);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  // Own lines with no echo, and old notes, go in time.
  const waiting = log.waiting;
  useEffect(() => {
    if (!waiting && note === null) {
      return;
    }
    const t = setInterval(() => log.expire(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting, note]);

  // A line refused, or lost, comes back to the field to be mended.
  useEffect(() => {
    if (note !== null && (note.kind === 'refused' || note.kind === 'lost') && note.text !== '') {
      if (chat.draft.value === '') {
        chat.draft.value = note.text;
      }
    }
  }, [note]);

  // Escape folds the strip.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && chat.sheet.value === null && chat.ask.value === null) {
        chat.open.value = false;
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);

  // Open, the strip fits above the controls, and above the keyboard.
  useLayoutEffect(() => {
    const el = strip.current;
    const ol = list.current;
    if (!open || el === null || ol === null) {
      return;
    }
    const r = el.getBoundingClientRect();
    const top = r.top + fit.lift;
    const rest = r.height - ol.getBoundingClientRect().height;
    let bottom = innerHeight - keyboard - 8;
    if (keyboard === 0) {
      for (const b of document.querySelectorAll(BELOW)) {
        const c = b.getBoundingClientRect();
        if (c.width > 0 && c.left < r.right && c.right > r.left && c.top > top) {
          bottom = Math.min(bottom, c.top - 8);
        }
      }
    }
    const next = fitStrip(top, rest, bottom, LINES_MIN, LINES_MAX);
    if (Math.abs(next.lines - fit.lines) > 0.5 || Math.abs(next.lift - fit.lift) > 0.5) {
      setFit(next);
    }
  });

  // The newest line in view.
  useLayoutEffect(() => {
    const ol = list.current;
    if (ol !== null) {
      ol.scrollTop = ol.scrollHeight;
    }
  }, [open, lines.length, lines[lines.length - 1]?.pending]);

  const act = (l: ChatLine) => {
    chat.sheet.value = { who: { line: l.id }, name: l.name, machine: l.machine, step: 'menu' };
  };

  if (!open) {
    const newest = lines[lines.length - 1];
    const words: Words =
      note !== null
        ? noteWords(note)
        : newest !== undefined
          ? lineWords(newest.name, newest.text)
          : [blocked || (readOnly ? NOTHING_SAID : SAY_SOMETHING)];
    return (
      <section class="panel chat-strip" aria-label={CHAT_ABOARD} data-readout="chat">
        <button
          type="button"
          class="chat-folded"
          aria-expanded="false"
          aria-label={`${OPEN_CHAT}: ${plain(words)}`}
          onClick={() => {
            chat.open.value = true;
          }}
        >
          <span class={`chat-folded-line${newest === undefined && note === null ? ' faint' : ''}`}>
            {note === null && newest !== undefined ? (
              <>
                <strong class="chat-name">
                  <PlayerText text={newest.name} />
                </strong>
                {newest.machine ? <Cog /> : null} <PlayerText text={newest.text} />
              </>
            ) : (
              <Said words={words} />
            )}
          </span>
          <span class="chat-mark" aria-hidden="true">
            ▾
          </span>
        </button>
      </section>
    );
  }

  const w = deck.watching.value;
  const draft = chat.draft.value;
  const length = lineLength(draft.trim());
  const left = leftText(length, 200);
  const send = (e: Event) => {
    e.preventDefault();
    const text = chat.draft.value;
    if (lineOf(text) === null) {
      return;
    }
    if (chat.state.value?.rules === true) {
      // The Rules of the sea before a first line: the line waits for them.
      chat.held.value = text;
      chat.ask.value = 'rules';
      return;
    }
    if (chat.say(text, self)) {
      chat.draft.value = '';
    }
    field.current?.focus();
  };
  // The fold key heads the strip; on a short screen, where every row
  // counts, it stands at the field's end instead.
  const fold = (where: 'head' | 'foot') => (
    <button
      type="button"
      class={`plate-key chat-fold ${where}-fold`}
      aria-expanded="true"
      aria-label={FOLD_CHAT}
      onClick={() => {
        chat.open.value = false;
      }}
    >
      ▴
    </button>
  );
  return (
    <section
      ref={strip}
      class={`panel chat-strip open${readOnly ? ' reads' : ''}`}
      aria-label={CHAT_ABOARD}
      data-readout="chat"
      style={fit.lift > 0 ? { translate: `0 ${-fit.lift}px` } : undefined}
    >
      <div class="chat-head">
        <span class="chat-title">
          {readOnly && w !== null ? <Said words={spectatorReadsWords(w.sailor)} /> : CHAT_ABOARD}
        </span>
        {fold('head')}
      </div>
      <ol class="chat-lines" ref={list} style={{ maxHeight: `${fit.lines}px` }} aria-live="polite">
        {lines.length === 0 ? <li class="chat-line faint">{NOTHING_SAID}</li> : null}
        {lines.map((l) => (
          <LineRow key={l.key} line={l} act={act} />
        ))}
      </ol>
      {note !== null ? (
        <p class="chat-note" role="status">
          <Said words={noteWords(note)} />
        </p>
      ) : null}
      {readOnly ? null : blocked !== '' ? (
        <div class="chat-foot">
          <p class="chat-state">{blocked}</p>
          {chat.state.value?.status === 'own-off' ? (
            <button
              type="button"
              class="plate-key key-main"
              onClick={() => {
                chat.ask.value = 'turn-on';
              }}
            >
              {TURN_CHAT_ON}
            </button>
          ) : null}
          {fold('foot')}
        </div>
      ) : (
        <form class="chat-foot" onSubmit={send}>
          <input
            ref={field}
            type="text"
            name="chat-line"
            aria-label={LINE_FIELD}
            placeholder={SAY_SOMETHING}
            autocomplete="off"
            enterkeyhint="send"
            maxLength={400}
            value={draft}
            onInput={(e) => {
              chat.draft.value = e.currentTarget.value;
            }}
          />
          <button type="submit" class="plate-key key-main" disabled={length === 0 || length > 200}>
            {SEND}
          </button>
          {fold('foot')}
          {left !== '' ? <span class="chat-left">{left}</span> : null}
        </form>
      )}
    </section>
  );
}

/** Whether the person a sheet is about is aboard the player's own boat, and the player its skipper. */
function skipperOf(d: DeckView, name: string): boolean {
  const crew = d.crew.value;
  return (
    d.aboard.value === null &&
    d.watching.value === null &&
    selfOf(crew)?.seat === 0 &&
    (crew?.people.some((p) => p.name === name && !p.you) ?? false)
  );
}

/** The report's form: a reason (a child at risk first) and a note for the owner alone. */
function ReportForm({ deck, sheet }: { deck: DeckView; sheet: ChatSheet }) {
  const chat = deck.chat;
  const [reason, setReason] = useState<ReportReasonTold | null>(null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  // A report from the shipmates panel goes over HTTP: its answer is its own.
  const [answered, setAnswered] = useState<boolean | null>(null);
  const told = chat.log.note.value;
  const back =
    sheet.shipmate !== undefined
      ? answered !== null
      : told !== null && told.kind === 'reported' && sent !== null && told.at >= sent;
  const ok =
    sheet.shipmate !== undefined ? answered === true : told?.kind === 'reported' && told.ok;
  if (sent !== null) {
    return (
      <section class="panel deck-window chat-sheet" role="dialog" aria-labelledby="chat-report">
        <h2 id="chat-report">
          <Said words={reportWords(sheet.name)} />
        </h2>
        <p role="status">{back ? (ok ? REPORTED : NOT_REPORTED) : '…'}</p>
        <div class="deck-keys">
          <button
            type="button"
            class="plate-key deck-close"
            onClick={() => {
              chat.sheet.value = null;
            }}
          >
            {CLOSE}
          </button>
        </div>
      </section>
    );
  }
  const send = (e: Event) => {
    e.preventDefault();
    if (reason === null) {
      setProblem(CHOOSE_REASON);
      return;
    }
    setSent(Date.now() - 1);
    const id = sheet.shipmate;
    const shipmates = deck.shipmates;
    if (id !== undefined && shipmates !== null) {
      void shipmates.report(id, reason, note.trim()).then(setAnswered);
    } else {
      chat.report(sheet.who, reason, note.trim());
    }
  };
  const used = lineLength(note);
  return (
    <section
      class="panel deck-window chat-sheet chat-report"
      role="dialog"
      aria-labelledby="chat-report"
    >
      <form class="chat-report-form" onSubmit={send}>
        <h2 id="chat-report">
          <Said words={reportWords(sheet.name)} />
        </h2>
        <fieldset class="chat-reasons">
          <legend>{REPORT_WHY}</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r.reason} class={`chat-reason${r.reason === 'child' ? ' first' : ''}`}>
              <input
                type="radio"
                name="chat-reason"
                value={r.reason}
                checked={reason === r.reason}
                onChange={() => {
                  setReason(r.reason);
                  setProblem('');
                }}
              />
              <span>{r.text}</span>
            </label>
          ))}
        </fieldset>
        <label class="chat-report-note">
          <span>{REPORT_NOTE}</span>
          <textarea
            name="chat-report-note"
            rows={2}
            maxLength={MAX_NOTE * 2}
            value={note}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
          <span class="deck-faint">{leftText(used, MAX_NOTE)}</span>
        </label>
        <p class="deck-faint">
          {sheet.shipmate !== undefined ? REPORT_SHIPMATE_DETAIL : REPORT_DETAIL}
        </p>
        <p class="deck-problem" aria-live="polite">
          {problem}
        </p>
        <div class="deck-keys">
          <button type="submit" class="plate-key key-main" disabled={used > MAX_NOTE}>
            {SEND_REPORT}
          </button>
          <button
            type="button"
            class="plate-key"
            onClick={() => {
              chat.sheet.value = null;
            }}
          >
            {CANCEL}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The sheet of mute, block and report, about one person; or its one question before a block; or the report's form. */
export function ChatSheetWindow({ deck, sheet }: { deck: DeckView; sheet: ChatSheet }) {
  const chat = deck.chat;
  const close = () => {
    chat.sheet.value = null;
  };
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  if (sheet.step === 'report') {
    return <ReportForm deck={deck} sheet={sheet} />;
  }
  const tie = chat.log.tieOf(sheet.name);
  if (sheet.step === 'block') {
    return (
      <section
        class="panel deck-window deck-question chat-sheet"
        role="alertdialog"
        aria-labelledby="chat-block"
      >
        <h2 id="chat-block">
          <Said words={blockWords(sheet.name)} />
        </h2>
        <p>
          {BLOCK_DETAIL}
          {skipperOf(deck, sheet.name) ? ` ${BLOCK_ASHORE}` : ''}
        </p>
        <div class="deck-keys">
          <button
            type="button"
            class="plate-key key-main"
            onClick={() => {
              chat.block(sheet.who, sheet.name, true);
              close();
            }}
          >
            {BLOCK}
          </button>
          <button type="button" class="plate-key" onClick={close}>
            {CANCEL}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section class="panel deck-window chat-sheet" role="dialog" aria-labelledby="chat-sheet">
      <h2 id="chat-sheet" class="chat-sheet-name">
        <PlayerText text={sheet.name} />
        {sheet.machine ? <Cog /> : null}
      </h2>
      <p class="deck-faint">{MUTE_DETAIL}</p>
      <div class="deck-keys">
        <button
          type="button"
          class="plate-key"
          onClick={() => {
            chat.mute(sheet.who, sheet.name, !tie.muted);
            close();
          }}
        >
          {tie.muted ? UNMUTE : MUTE}
        </button>
        <button
          type="button"
          class="plate-key"
          onClick={() => {
            if (tie.blocked) {
              chat.block(sheet.who, sheet.name, false);
              close();
            } else {
              chat.sheet.value = { ...sheet, step: 'block' };
            }
          }}
        >
          {tie.blocked ? UNBLOCK : BLOCK}
        </button>
        <button
          type="button"
          class="plate-key"
          onClick={() => {
            chat.sheet.value = { ...sheet, step: 'report' };
          }}
        >
          {REPORT}
        </button>
      </div>
      <button type="button" class="plate-key deck-close" onClick={close}>
        {CLOSE}
      </button>
    </section>
  );
}

/** Chat's windows over the sea: the Rules before a first line, turning chat on, and the sheet. */
export function ChatWindows({ deck, sailor }: { deck: DeckView; sailor: string | null }) {
  const chat = deck.chat;
  const ask = chat.ask.value;
  if (ask === 'rules') {
    return (
      <div class="deck-window deck-asks">
        <RulesCard
          fetch={chat.server.fetch}
          onAccepted={() => {
            chat.ask.value = null;
            const held = chat.held.value;
            chat.held.value = '';
            if (held !== '' && chat.say(held, selfOf(deck.crew.value)?.name || sailor || '')) {
              chat.draft.value = '';
            }
          }}
          onCancel={() => {
            chat.ask.value = null;
          }}
        />
      </div>
    );
  }
  if (ask === 'turn-on') {
    return (
      <div class="deck-window deck-asks">
        <ChatTurnOn
          server={chat.server}
          done={() => {
            chat.ask.value = null;
          }}
        />
      </div>
    );
  }
  const sheet = chat.sheet.value;
  return sheet === null ? null : <ChatSheetWindow deck={deck} sheet={sheet} />;
}

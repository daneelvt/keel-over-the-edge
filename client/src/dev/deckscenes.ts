// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together's screens with no server, for the browser tests and
// their pictures: a stand-in for the game connection's side in each of
// its states, the knocks on the skipper's boat, the player's own knock,
// aboard with the controls or without, the skipper while another holds
// them, the controls offered, who is aboard and the skipper's link. What
// the screens ask of it is written down, not sent. And chat aboard's: the
// strip folded and open, the keyboard up, a line refused (its sender's
// side) and a line refused for a word (seen as said), the sheet of mute,
// block and report and the report's form, the teens' card, the Rules
// before a first line, chat resting or off, an owner reading their
// machine sailor's chat, and a statement of reasons.

import { computed, type Signal, signal } from '@preact/signals';
import type { ChatServer, ChatSetting, Statement } from '../account/chatapi';
import { catalog } from '../catalog';
import { codeOf, drawLook } from '../catalog/looks';
import type {
  AboardTold,
  ChatStateTold,
  CrewTold,
  HandedTold,
  KnockCardTold,
  KnockingTold,
  KnockStateTold,
  PersonTold,
  WatchingTold,
} from '../net/messages';
import { ChatLog } from '../ui/chatlog';
import type { ChatSheet, ChatView, DeckView } from '../ui/decklazy';
import { type StatementsView, statementsOf } from '../ui/statementlazy';
import type { WatchView } from '../ui/watchlazy';

/** The scenes, by name. */
export const DECK_SCENES = [
  'knocks',
  'knocking',
  'skipper',
  'skipper-away',
  'aboard',
  'aboard-holding',
  'handed',
  'list',
  'list-skipper',
  'ashore',
  'link',
  'chat',
  'chat-open',
  'chat-crew',
  'chat-keyboard',
  'chat-refused',
  'chat-word',
  'chat-list',
  'chat-sheet',
  'chat-block',
  'chat-report',
  'chat-teen',
  'chat-rules',
  'chat-resting',
  'chat-off',
  'chat-own-off',
  'chat-owner',
  'chat-statement',
] as const;

export type DeckSceneName = (typeof DECK_SCENES)[number];

/** A look code drawn from the catalog by a fixed number, so each scene's faces stay the same. */
function look(n: number): number {
  return codeOf(
    catalog,
    drawLook(catalog, () => n),
  );
}

/** The screen's views of a scene: sailing together's, watching's (nothing steers without the controls), and the statements'. */
export interface DeckScene {
  deck: DeckView;
  watch: WatchView;
  statements: StatementsView | null;
  /** What the screens asked of it, in order: "answer 1 let", "take". */
  calls: string[];
}

/** The lines said aboard in the chat scenes: the sailor named, the crew, a machine sailor and the player. */
function chatLines(log: ChatLog, sailor: string, self: string, at: number): void {
  const said: [string, boolean, string][] = [
    ['Bosun Bly', false, 'Fair winds! Where are we heading?'],
    [sailor, false, 'North-west, to the light on the point. Keep her full and by.'],
    ['Gull', true, 'I can see the light already, two points off the bow.'],
    [
      'Bosun Bly',
      false,
      'Wonderful. A long line now, to see how the strip wraps a line that runs on and on past its edge.',
    ],
  ];
  said.forEach(([name, machine, text], i) => {
    log.receive(
      {
        id: i + 1,
        seat: i + 1,
        name,
        machine,
        at: at - (said.length - i) * 30_000,
        text,
        you: false,
        echo: 0,
        refused: '',
      },
      at,
    );
  });
  const mine = log.say('Trimming the sheet now.', self, at);
  if (mine !== null) {
    log.receive(
      {
        id: 9,
        seat: 2,
        name: self,
        machine: false,
        at,
        text: mine.text,
        you: true,
        echo: mine.id,
        refused: '',
      },
      at,
    );
  }
}

/** The account's side of chat with no server: the answers a scene gives, what it was asked written down. */
function chatServerOf(calls: string[], setting: ChatSetting, statements: Statement[]): ChatServer {
  return {
    fetch: async (input) => {
      calls.push(`fetch ${input}`);
      return new Response(null, { status: 204 });
    },
    read: async () => setting,
    set: async (on) => {
      calls.push(`chat ${on ? 'on' : 'off'}`);
      return 'ok';
    },
    ties: async () => [
      { id: 'a', name: 'Bosun Bly', kind: 'mute' },
      { id: 'b', name: 'Gull', kind: 'block' },
    ],
    untie: async (t) => {
      calls.push(`untie ${t.name}`);
      return true;
    },
    statements: async () => statements,
    markRead: async (id) => {
      calls.push(`read ${id}`);
      return true;
    },
    answer: async (id) => {
      calls.push(`answer ${id}`);
      return 'ok';
    },
  };
}

/** The height a phone's keyboard covers on a screen of that size, px. */
function keyboardOn(width: number, height: number): number {
  return Math.round(height * (height >= width ? 0.42 : 0.55));
}

/**
 * A scene: name, the sailor named in it (the skipper, or the one who
 * knocks), and for a knock the state it stands in.
 */
export function deckScene(
  name: DeckSceneName,
  sailor = 'Iron Mary',
  state: KnockStateTold = 'waiting',
): DeckScene {
  const calls: string[] = [];
  const chatting = name.startsWith('chat');
  const owner = name === 'chat-owner';
  const aboard =
    name.startsWith('aboard') ||
    name === 'handed' ||
    name === 'list' ||
    name === 'ashore' ||
    name === 'chat-crew';
  const skipper =
    name.startsWith('skipper') ||
    name === 'list-skipper' ||
    name === 'link' ||
    (chatting && !aboard && !owner);
  const away = name === 'skipper-away' || name === 'list-skipper';
  const holding = owner ? false : !aboard ? !away : name === 'aboard-holding';
  const person = (seat: number, n: number, who: string, you: boolean): PersonTold => ({
    seat,
    look: look(n),
    // A spectator is told no names.
    name: owner ? '' : who,
    machine: false,
    you,
    muted: name === 'chat-list' && who === 'Bosun Bly',
    blocked: false,
  });
  const people: PersonTold[] = [
    person(0, 0.1, skipper ? 'Saltpeter Sue' : sailor, skipper),
    person(1, 0.5, skipper ? sailor : 'Bosun Bly', false),
    person(2, 0.8, 'Saltpeter Sue', aboard),
  ];
  if (skipper) {
    people[2] = person(2, 0.8, 'Bosun Bly', false);
  }
  const crew: CrewTold | null =
    aboard || skipper || owner
      ? { people, holder: name === 'aboard-holding' ? 2 : away ? 1 : 0 }
      : null;
  const knocks: KnockCardTold[] =
    name === 'knocks'
      ? [
          { id: 1, sailor, look: look(0.3), gone: false },
          { id: 2, sailor: 'Bosun Bly', look: look(0.6), gone: false },
          { id: 3, sailor: 'Gull', look: look(0.9), gone: false },
        ]
      : [];
  const knocking: KnockingTold | null =
    name === 'knocking' ? { state, skipper: sailor, kind: 1, boat: '' } : null;
  const handed: HandedTold | null =
    name === 'handed' ? { from: sailor, seconds: 15, gone: false } : null;
  const told: AboardTold | null = aboard ? { skipper: sailor, look: look(0.1), seat: 2 } : null;
  const watching: WatchingTold | null = owner
    ? { sailor: 'Gull', machine: true, mine: true, look: look(0.9) }
    : null;
  const closed = signal(false);
  const now = Date.now();
  const statements = name === 'chat-statement' ? [statementOf(now)] : [];
  const chat = chatScene(name, sailor, calls, now, statements);
  const deck: DeckView = {
    aboard: signal(told),
    crew: signal(crew),
    knocks: signal(knocks),
    knocking: signal(knocking),
    handed: signal(handed),
    holding: signal(holding),
    watching: signal(watching),
    status: signal('sailing'),
    kind: signal(1),
    boatName: computed(() => ''),
    closed,
    link: signal(name === 'link'),
    list: signal(name === 'list' || name === 'list-skipper' || name === 'chat-list'),
    ashore: signal(name === 'ashore'),
    dismissed: signal(null),
    answer: (k, l) => calls.push(`answer ${k} ${l ? 'let' : 'not now'}`),
    hand: (seat) => calls.push(`hand ${seat}`),
    take: () => calls.push('take'),
    giveBack: () => calls.push('give back'),
    goAshore: () => calls.push('go ashore'),
    putAshore: (seat) => calls.push(`put ashore ${seat}`),
    closeKnocks: (c) => {
      closed.value = c;
      calls.push(`closed ${c}`);
    },
    chat,
  };
  const watch: WatchView = {
    watching: signal(watching),
    spectating: signal(!holding),
    status: signal('sailing'),
    ended: signal(null),
    place: signal(null),
    boatPlace: signal(null),
    watchers: signal(0),
    list: signal(false),
    watch: () => {},
    sail: () => {},
    unwatch: () => {},
  };
  let view: StatementsView | null = null;
  if (statements.length > 0) {
    view = statementsOf(chat.server);
    view.waiting.value = statements;
    view.open.value = statements[0] ?? null;
  }
  return { deck, watch, statements: view, calls };
}

/** A statement of reasons: a line of the player's removed, and their chat rested a day. */
function statementOf(now: number): Statement {
  return {
    id: 'statement-1',
    made: now - 3_600_000,
    action: 'mute-chat',
    rule: 'No contact details or links',
    seen: 'A line giving a phone number, said aboard Saltpeter Sue’s keelboat.',
    until: now + 23 * 3_600_000,
    read: false,
    answer: '',
    answered: 0,
  };
}

/** Chat aboard as a scene has it: its lines, how chat stands, and what is open. */
function chatScene(
  name: DeckSceneName,
  sailor: string,
  calls: string[],
  now: number,
  statements: Statement[],
): ChatView {
  const self = 'Saltpeter Sue';
  const log = new ChatLog();
  if (name.startsWith('chat') && name !== 'chat-teen') {
    chatLines(log, sailor, self, now);
  }
  if (name === 'chat-refused') {
    // The player's line with an address in it, refused: its words back in the field.
    const s = log.say('Write to me at sue at example dot com', self, now);
    log.receive(
      {
        id: 0,
        seat: 0,
        name: '',
        machine: false,
        at: 0,
        text: '',
        you: true,
        echo: s?.id ?? 0,
        refused: 'contact',
      },
      now,
    );
  }
  if (name === 'chat-word') {
    // A line refused for a word: back as said, to its sender alone.
    const s = log.say('You absolute barnacle', self, now);
    log.receive(
      {
        id: 0,
        seat: 0,
        name: '',
        machine: false,
        at: now,
        text: s?.text ?? '',
        you: true,
        echo: s?.id ?? 0,
        refused: '',
      },
      now,
    );
  }
  const status: ChatStateTold['status'] =
    name === 'chat-resting'
      ? 'resting'
      : name === 'chat-off'
        ? 'off'
        : name === 'chat-own-off' || name === 'chat-teen'
          ? 'own-off'
          : 'on';
  const state = signal<ChatStateTold | null>({
    status,
    until: name === 'chat-resting' ? now + 2 * 3_600_000 : 0,
    rules: name === 'chat-rules',
  });
  const who = { line: 1 };
  const sheets: Partial<Record<DeckSceneName, ChatSheet>> = {
    'chat-sheet': { who, name: 'Bosun Bly', machine: false, step: 'menu' },
    'chat-block': { who: { seat: 1 }, name: sailor, machine: false, step: 'block' },
    'chat-report': { who, name: 'Bosun Bly', machine: false, step: 'report' },
  };
  const closedStrip: DeckSceneName[] = ['chat', 'chat-list', 'chat-statement'];
  const keyboard: Signal<number> | null =
    name === 'chat-keyboard' && typeof innerWidth === 'number'
      ? signal(keyboardOn(innerWidth, innerHeight))
      : null;
  return {
    log,
    state,
    open: signal(name.startsWith('chat') && !closedStrip.includes(name)),
    draft: signal(name === 'chat-rules' ? 'Ahoy all' : ''),
    sheet: signal(sheets[name] ?? null),
    ask: signal(name === 'chat-teen' ? 'turn-on' : name === 'chat-rules' ? 'rules' : null),
    held: signal(name === 'chat-rules' ? 'Ahoy all' : ''),
    keyboard,
    server: chatServerOf(
      calls,
      { on: false, card: name === 'chat-teen', rules: name === 'chat-rules', asked: true },
      statements,
    ),
    say: (text, from) => {
      const s = log.say(text, from, Date.now());
      if (s === null) {
        return false;
      }
      calls.push(`say ${s.text}`);
      log.receive(
        {
          id: 100 + s.id,
          seat: 0,
          name: from,
          machine: false,
          at: Date.now(),
          text: s.text,
          you: true,
          echo: s.id,
          refused: '',
        },
        Date.now(),
      );
      return true;
    },
    mute: (_w, n, on) => {
      log.tie(n, 'mute', on);
      calls.push(`mute ${n} ${on}`);
    },
    block: (_w, n, on) => {
      log.tie(n, 'block', on);
      calls.push(`block ${n} ${on}`);
    },
    report: (w, reason, note) => {
      calls.push(`report ${'seat' in w ? `seat ${w.seat}` : `line ${w.line}`} ${reason} ${note}`);
      log.reported(true, Date.now());
    },
  };
}

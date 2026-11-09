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
// machine sailor's chat, and a statement of reasons. And shipmates': the
// panel (offers, shipmates where they are, the recent crew), a row's ⋯,
// an offer made and accepted, ending's question, appearing offline and
// the panel empty; a thread, a message refused for its shipmate away, the
// keyboard up; the notices of a message and of an offer; and who is aboard
// with a shipmate among them.

import { computed, type Signal, signal } from '@preact/signals';
import type { ChatServer, ChatSetting, Statement } from '../account/chatapi';
import type { ShipmatesList, ShipmatesServer } from '../account/shipmatesapi';
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
import { ShipmateThreads } from '../ui/shipmatelog';
import { type ShipmatesView, shipmatesOf } from '../ui/shipmatesview';
import { offerWords } from '../ui/shipmatewords';
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
  'list-more',
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
  'chat-list-shipmate',
  'shipmates',
  'shipmates-more',
  'shipmates-offered',
  'shipmates-made',
  'shipmates-thread',
  'shipmates-away',
  'shipmates-keyboard',
  'shipmates-notice',
  'shipmates-offer-notice',
  'shipmates-end',
  'shipmates-offline',
  'shipmates-empty',
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
        thread: '',
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
        thread: '',
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
    name === 'list-more' ||
    name === 'link' ||
    (chatting && !aboard && !owner);
  const away = name === 'skipper-away' || name === 'list-skipper';
  const holding = owner ? false : !aboard ? !away : name === 'aboard-holding';
  const person = (seat: number, n: number, who: string, you: boolean): PersonTold => ({
    seat,
    look: look(n),
    // A spectator is told no names.
    name: owner ? '' : who,
    machine: owner,
    you,
    muted: name === 'chat-list' && who === 'Bosun Bly',
    blocked: false,
    shipmate: name === 'chat-list-shipmate' && who === 'Bosun Bly',
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
    list: signal(
      name === 'list' ||
        name === 'list-skipper' ||
        name === 'list-more' ||
        name === 'chat-list' ||
        name === 'chat-list-shipmate',
    ),
    ...(name === 'list-more' ? { openRow: 1 } : {}),
    ...(name === 'chat-list-shipmate' ? { openRow: 2 } : {}),
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
    shipmates: shipmatesScene(name, sailor, calls, now),
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
        thread: '',
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
        thread: '',
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
  const closedStrip: DeckSceneName[] = [
    'chat',
    'chat-list',
    'chat-statement',
    'chat-list-shipmate',
  ];
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
          thread: '',
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

/** The shipmates' list a scene reads: the sailor named at sea, skippering; one in the game; one with nothing shown; an offer; the recent crew. */
function shipmatesListOf(name: DeckSceneName, sailor: string): ShipmatesList {
  if (name === 'shipmates-empty') {
    return { offline: false, messages: true, shipmates: [], offers: [], recent: [] };
  }
  const made = name === 'shipmates-made';
  const shipmates = [
    { id: 'iron', name: sailor, look: look(0.1), presence: 'sea' as const, skipper: true },
    { id: 'bly', name: 'Bosun Bly', look: look(0.5), presence: 'game' as const, skipper: false },
    { id: 'meg', name: 'Marlinspike Meg', look: look(0.7), presence: '' as const, skipper: false },
  ];
  if (made) {
    shipmates.push({
      id: 'quill',
      name: 'Captain Quill',
      look: look(0.3),
      presence: 'game',
      skipper: false,
    });
  }
  // An offer waits on the panel's scenes and the offer's notice; the
  // threads' scenes have none, or reading the list would make it a notice.
  const offering =
    name.startsWith('shipmates') &&
    !made &&
    !['shipmates-thread', 'shipmates-away', 'shipmates-keyboard', 'shipmates-notice'].includes(
      name,
    );
  const offers = offering ? [{ id: 'quill', name: 'Captain Quill', look: look(0.3) }] : [];
  return {
    offline: name === 'shipmates-offline',
    messages: true,
    shipmates,
    offers,
    recent: [
      {
        id: 'tom',
        name: 'Tarry Tom',
        look: look(0.6),
        shipmate: false,
        offered: name === 'shipmates-offered',
        can: name !== 'shipmates-offered',
      },
      {
        id: 'bly',
        name: 'Bosun Bly',
        look: look(0.5),
        shipmate: true,
        offered: false,
        can: false,
      },
      {
        id: 'ned',
        name: 'Ned Hawser',
        look: look(0.9),
        shipmate: false,
        offered: true,
        can: false,
      },
    ],
  };
}

/**
 * The shipmates' side of the server with no server: the scene's list,
 * changed as the server would change it, what it was asked written down.
 */
function shipmatesServerOf(calls: string[], list: ShipmatesList): ShipmatesServer {
  const without = (id: string) => {
    list.shipmates = list.shipmates.filter((s) => s.id !== id);
    list.offers = list.offers.filter((o) => o.id !== id);
  };
  return {
    list: async () => structuredClone(list),
    offer: async (to) => {
      calls.push(`offer ${'id' in to ? to.id : `seat ${to.seat}`}`);
      list.recent = list.recent.map((r) =>
        'id' in to && r.id === to.id ? { ...r, offered: true, can: false } : r,
      );
      return 'offered';
    },
    accept: async (id) => {
      calls.push(`accept ${id}`);
      const o = list.offers.find((x) => x.id === id);
      without(id);
      if (o !== undefined) {
        list.shipmates.push({ ...o, presence: 'game', skipper: false });
      }
      return 'made';
    },
    decline: async (id) => {
      calls.push(`decline ${id}`);
      without(id);
      return true;
    },
    end: async (to) => {
      calls.push(`end ${'id' in to ? to.id : `seat ${to.seat}`}`);
      if ('id' in to) {
        without(to.id);
      }
      return true;
    },
    block: async (id) => {
      calls.push(`block ${id}`);
      without(id);
      list.recent = list.recent.filter((r) => r.id !== id);
      return true;
    },
    report: async (id, reason) => {
      calls.push(`report ${id} ${reason}`);
      return true;
    },
    offline: async (on) => {
      calls.push(`offline ${on}`);
      list.offline = on;
      return true;
    },
  };
}

/** A shipmate's message, or the player's own back, as the server would send it. */
function message(
  threads: ShipmateThreads,
  thread: string,
  name: string,
  text: string,
  at: number,
  id: number,
): void {
  threads.receive(
    { id, seat: 0, name, machine: false, at, text, you: false, echo: 0, refused: '', thread },
    at,
  );
}

/** Shipmates as a scene has them: the list, what is open, the threads' lines. */
function shipmatesScene(
  name: DeckSceneName,
  sailor: string,
  calls: string[],
  now: number,
): ShipmatesView {
  const self = 'Saltpeter Sue';
  const threads = new ShipmateThreads();
  const list = shipmatesListOf(name, sailor);
  const echo = (to: string, s: { id: number; text: string } | null, at: number) => {
    if (s !== null) {
      threads.receive(
        {
          id: 200 + s.id,
          seat: 0,
          name: self,
          machine: false,
          at,
          text: s.text,
          you: true,
          echo: s.id,
          refused: '',
          thread: to,
        },
        at,
      );
    }
  };
  const view = shipmatesOf(
    {
      threads,
      shipmatesChanged: signal(0),
      // Not welcomed: the scene's list is set, not read at once.
      status: signal('connecting'),
      sayTo: (to, text, from) => {
        const s = threads.say(to, text, from, Date.now());
        if (s === null) {
          return false;
        }
        calls.push(`message ${to} ${s.text}`);
        echo(to, s, Date.now());
        return true;
      },
      knockShipmate: (id) => calls.push(`knock ${id}`),
      watch: (n) => calls.push(`watch ${n}`),
    },
    { server: shipmatesServerOf(calls, list) },
  );
  if (!name.startsWith('shipmates')) {
    return view;
  }
  view.list.value = structuredClone(list);
  const threaded = name === 'shipmates-thread' || name === 'shipmates-keyboard';
  if (threaded || name === 'shipmates-notice') {
    message(
      threads,
      'bly',
      'Bosun Bly',
      'Ahoy! Are you out on the water today?',
      now - 300_000,
      1,
    );
  }
  if (threaded) {
    echo('bly', threads.say('bly', 'Just left Port Royal, reaching north.', self, now), now);
    message(threads, 'bly', 'Bosun Bly', 'Shall I knock? I’d crew for you.', now - 60_000, 2);
    echo('bly', threads.say('bly', 'Do! Ask from your shipmates list.', self, now), now);
  }
  if (name === 'shipmates-away') {
    // A message to a shipmate not in the game: refused, its words back in the field.
    const s = threads.say('meg', 'Fair winds, Meg! See you at the light.', self, now);
    threads.receive(
      {
        id: 0,
        seat: 0,
        name: '',
        machine: false,
        at: 0,
        text: '',
        you: true,
        echo: s?.id ?? 0,
        refused: 'away',
        thread: 'meg',
      },
      now,
    );
  }
  view.thread.value = threaded ? 'bly' : name === 'shipmates-away' ? 'meg' : null;
  view.panel.value = ![
    'shipmates-thread',
    'shipmates-away',
    'shipmates-keyboard',
    'shipmates-notice',
    'shipmates-offer-notice',
  ].includes(name);
  if (name === 'shipmates-offer-notice') {
    view.notices.value = [{ kind: 'offer', id: 'quill', name: 'Captain Quill', key: 1 }];
  }
  if (name === 'shipmates-more') {
    view.openRow = 'iron';
  }
  if (name === 'shipmates-end') {
    view.asking = { id: 'iron', what: 'end' };
  }
  if (name === 'shipmates-offered') {
    view.told.value = { id: 'tom', words: offerWords('offered', 'Tarry Tom') };
  }
  if (name === 'shipmates-made') {
    view.told.value = { id: 'quill', words: offerWords('made', 'Captain Quill') };
  }
  if (name === 'shipmates-keyboard' && typeof innerWidth === 'number') {
    view.keyboard = signal(keyboardOn(innerWidth, innerHeight));
  }
  return view;
}

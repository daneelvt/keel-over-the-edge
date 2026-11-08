// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together, the screens' parts of it. For the skipper: the knocks
// on their boat, a card each, the oldest shown with how many more wait
// behind it, Let aboard and Not now; and, while another aboard holds the
// controls, a plate at the foot of the screen naming who does, with Take
// back the controls. For the knocker: their own knock as it stands, in a
// sailor's words, put away by its ×. Aboard another's boat without the
// controls: the plate at the foot, "Aboard Iron Mary’s keelboat", with
// Crew and Go ashore, where the controls are while sailing (nothing on
// the screen steers then); with the controls, a line under the case
// instead. The controls offered: a card under the case with the seconds
// left to take them. And who is aboard: a window listing each person by
// name, the helm's mark beside whoever holds the controls, each row with
// what the player may do to that person, by who the player is and who
// holds the controls; and the skipper's link (sailwithme.tsx).
//
// Loaded only when first needed (decklazy.ts): none of it is in the
// game's first download.

import './deck.css';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { Portrait } from '../account/portraits';
import { catalog } from '../catalog';
import { lookOf } from '../catalog/looks';
import type { CrewTold, PersonTold } from '../net/messages';
import { Decal } from './decals';
import { type DeckView, deckPlate, selfOf, skipperAway } from './decklazy';
import {
  ABOARD,
  AT_THE_HELM,
  aboardCountText,
  aboardWords,
  actionName,
  asksWords,
  CLOSE,
  CREW,
  DISMISS,
  GIVE_BACK,
  GO_ASHORE,
  GO_ASHORE_DETAIL,
  GO_ASHORE_QUESTION,
  HAND_OVER,
  HOLDS,
  handedWords,
  KEEP_ABOARD,
  knockingWords,
  LET_ABOARD,
  moreWaitingText,
  NOT_NOW,
  PUT_ASHORE,
  plain,
  putAshoreWords,
  SKIPPER,
  STAY_ABOARD,
  secondsText,
  TAKE_BACK,
  TAKE_THEM,
  WHO_IS_ABOARD,
  type Words,
  whoseBoatWords,
  YOU,
  YOU_HOLD,
} from './deckwords';
import { PlayerText } from './player';
import { SailWithMe } from './sailwithme';

export { SailWithMe } from './sailwithme';

/** Words with a player's text among them, that text as player text. */
export function Said({ words }: { words: Words }) {
  return (
    <>
      {words.map((w, i) =>
        typeof w === 'string' ? w : <PlayerText key={`${i}-${w.player}`} text={w.player} />,
      )}
    </>
  );
}

/** A boat's kind by its index in the catalog's boats, by name: "" for none. */
export function kindNameOf(kind: number): string {
  return catalog.boats[kind]?.name ?? '';
}

/** A sailor's portrait from their look code, or nothing for a code the catalog cannot read. */
function Face({ look }: { look: number }) {
  const l = lookOf(catalog, look);
  return l === null ? <span class="deck-face" /> : <Portrait looks={catalog} look={l} size={40} />;
}

/** The mark of whoever holds the controls: a ship's wheel, engraved. */
export function HelmMark() {
  const spokes = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <span class="deck-helm" role="img" aria-label={HOLDS} title={HOLDS}>
      <Decal>
        <circle class="decal-line" r="6" />
        <circle class="decal-fill" r="1.8" />
        {spokes.map((a) => {
          const t = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              class="decal-line thin"
              x1={0}
              y1={0}
              x2={10 * Math.sin(t)}
              y2={-10 * Math.cos(t)}
            />
          );
        })}
      </Decal>
    </span>
  );
}

/** What the player may do to a person aboard, by who the player is and who holds the controls. */
export type RowAction = 'hand' | 'take' | 'giveBack' | 'putAshore';

/**
 * The keys on the row of the person in seat: whoever holds the controls
 * hands them to anyone else; the skipper takes them back (on their own
 * row) while another holds them, and puts anyone else ashore; one of the
 * crew who holds them gives them back (on their own row). Nothing for a
 * spectator, who is not aboard.
 */
export function rowActions(crew: CrewTold, seat: number): RowAction[] {
  const me = selfOf(crew);
  const person = crew.people.find((p) => p.seat === seat);
  if (me === null || person === undefined) {
    return [];
  }
  const skipper = me.seat === 0;
  const holds = crew.holder === me.seat;
  const out: RowAction[] = [];
  if (person.you) {
    if (skipper && crew.holder !== 0) {
      out.push('take');
    }
    if (!skipper && holds) {
      out.push('giveBack');
    }
    return out;
  }
  if (holds) {
    out.push('hand');
  }
  if (skipper) {
    out.push('putAshore');
  }
  return out;
}

/** A key's words for each action. */
const ACTION_WORDS: Record<RowAction, string> = {
  hand: HAND_OVER,
  take: TAKE_BACK,
  giveBack: GIVE_BACK,
  putAshore: PUT_ASHORE,
};

/** The name of whoever holds the controls; "" for none known. */
export function holderName(crew: CrewTold | null): string {
  return crew?.people.find((p) => p.seat === crew.holder)?.name ?? '';
}

/**
 * The knocks on the skipper's boat: the oldest as a card, the sailor's
 * portrait and name, Let aboard and Not now, and how many more wait
 * behind it. Never anything of their age.
 */
export function KnockCards({ deck }: { deck: DeckView }) {
  const knocks = deck.knocks.value;
  const k = knocks[0];
  if (k === undefined) {
    return null;
  }
  const more = moreWaitingText(knocks.length - 1);
  const words = asksWords(k.sailor);
  return (
    <section
      class={`panel deck-knock${more === '' ? '' : ' stacked'}`}
      aria-label={plain(words)}
      data-knock={k.id}
      role="alert"
    >
      <div class="deck-knock-who">
        <Face look={k.look} />
        <p>
          <Said words={words} />
        </p>
      </div>
      <div class="deck-keys">
        <button type="button" class="plate-key key-main" onClick={() => deck.answer(k.id, true)}>
          {LET_ABOARD}
        </button>
        <button type="button" class="plate-key" onClick={() => deck.answer(k.id, false)}>
          {NOT_NOW}
        </button>
      </div>
      {more !== '' ? <p class="deck-faint">{more}</p> : null}
    </section>
  );
}

/** The player's own knock as it stands, until put away; nothing once aboard by it. */
export function KnockingCard({ deck }: { deck: DeckView }) {
  const k = deck.knocking.value;
  if (
    k === null ||
    k === deck.dismissed.value ||
    (k.state === 'let' && deck.aboard.value !== null)
  ) {
    return null;
  }
  return (
    <p class="panel deck-knocking" role="status" data-knocking={k.state}>
      <span>
        <Said words={knockingWords(k.state, k.skipper, k.boat, kindNameOf(k.kind))} />
      </span>
      <button
        type="button"
        class="notice-dismiss"
        aria-label={DISMISS}
        onClick={() => (deck.dismissed.value = k)}
      >
        ×
      </button>
    </p>
  );
}

/**
 * Under the case, while the player holds the controls with others
 * aboard: the skipper's how many are aboard, the crew's that they hold
 * them; and Crew, which opens who is aboard.
 */
export function DeckLine({ deck }: { deck: DeckView }) {
  const crew = deck.crew.value;
  if (deck.watching.value !== null || deckPlate(deck) || crew === null) {
    return null;
  }
  const aboard = deck.aboard.value !== null;
  return (
    <section class="panel deck-line" data-readout="aboard">
      <span class="deck-line-words">{aboard ? YOU_HOLD : aboardCountText(crew.people.length)}</span>
      <button type="button" class="plate-key" onClick={() => (deck.list.value = true)}>
        {CREW}
      </button>
    </section>
  );
}

/** The question before going ashore: Escape is Stay aboard. */
export function AshoreQuestion({ deck }: { deck: DeckView }) {
  const stay = () => (deck.ashore.value = false);
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        stay();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <section
      class="panel deck-window deck-question"
      role="alertdialog"
      aria-labelledby="deck-ashore"
    >
      <h2 id="deck-ashore">{GO_ASHORE_QUESTION}</h2>
      <p>{GO_ASHORE_DETAIL}</p>
      <div class="deck-keys">
        <button
          type="button"
          class="plate-key key-main"
          onClick={() => {
            deck.ashore.value = false;
            deck.list.value = false;
            deck.goAshore();
          }}
        >
          {GO_ASHORE}
        </button>
        <button type="button" class="plate-key" onClick={stay}>
          {STAY_ABOARD}
        </button>
      </div>
    </section>
  );
}

/** How many seconds are left of an offer of seconds made at since (ms), at now. */
export function secondsLeft(seconds: number, since: number, now: number): number {
  return Math.max(0, seconds - (now - since) / 1000);
}

/** The controls offered: whose offer, Take them, and the seconds left to. */
export function HandedCard({ deck }: { deck: DeckView }) {
  const h = deck.handed.value;
  const [since, setSince] = useState(() => performance.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const t0 = performance.now();
    setSince(t0);
    setNow(t0);
    if (h === null) {
      return;
    }
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, [h]);
  if (h === null) {
    return null;
  }
  const words = handedWords(h.from);
  return (
    <section class="panel deck-handed" role="alert" aria-label={plain(words)}>
      <p>
        <Said words={words} />
      </p>
      <span class="deck-faint deck-seconds">{secondsText(secondsLeft(h.seconds, since, now))}</span>
      <button type="button" class="plate-key key-main" onClick={() => deck.take()}>
        {TAKE_THEM}
      </button>
    </section>
  );
}

/**
 * The plate at the foot of the screen, in the controls' place: aboard
 * without the controls, whose boat with Crew and Go ashore; the skipper
 * while another holds them, who does, with Take back the controls and
 * Crew. A long name ends in an ellipsis; the plate's label says it whole.
 */
export function DeckPlate({ deck }: { deck: DeckView }) {
  const a = deck.aboard.value;
  const crewKey = (
    <button type="button" class="head-key" onClick={() => (deck.list.value = true)}>
      {CREW}
    </button>
  );
  if (a !== null && !deck.holding.value) {
    const kind = kindNameOf(deck.kind.value);
    const boat = deck.boatName.value;
    return (
      <section
        class="deck-plate"
        aria-label={plain(aboardWords(a.skipper, boat, kind))}
        data-readout="aboard"
      >
        <div class="deck-plate-words">
          <span class="deck-plate-label">{ABOARD}</span>
          <strong class="deck-plate-name">
            <Said words={whoseBoatWords(a.skipper, boat, kind)} />
          </strong>
        </div>
        {crewKey}
        <button type="button" class="head-key" onClick={() => (deck.ashore.value = true)}>
          {GO_ASHORE}
        </button>
      </section>
    );
  }
  if (!skipperAway(deck)) {
    return null;
  }
  const holder = holderName(deck.crew.value);
  return (
    <section class="deck-plate" aria-label={`${AT_THE_HELM} ${holder}`} data-readout="aboard">
      <div class="deck-plate-words">
        <span class="deck-plate-label">{AT_THE_HELM}</span>
        <strong class="deck-plate-name">
          <PlayerText text={holder} />
        </strong>
      </div>
      <button type="button" class="head-key key-main deck-take" onClick={() => deck.take()}>
        {TAKE_BACK}
      </button>
      {crewKey}
    </section>
  );
}

/** One person aboard: their portrait and name, who they are, the helm's mark, and the keys. */
export function PersonRow({
  person,
  crew,
  act,
}: {
  person: PersonTold;
  crew: CrewTold;
  act: (a: RowAction, p: PersonTold) => void;
}) {
  const actions = rowActions(crew, person.seat);
  const tags = [person.seat === 0 ? SKIPPER : '', person.you ? YOU : ''].filter((t) => t !== '');
  return (
    <li class="deck-row" data-seat={person.seat}>
      <Face look={person.look} />
      <div class="deck-row-who">
        <p class="deck-row-name">
          <strong>
            <PlayerText text={person.name} />
          </strong>
          {person.machine ? (
            <span class="deck-cog" role="img" aria-label="machine sailor" title="machine sailor">
              ⚙
            </span>
          ) : null}
          {crew.holder === person.seat ? <HelmMark /> : null}
        </p>
        {tags.length > 0 ? <p class="deck-faint">{tags.join(' · ')}</p> : null}
      </div>
      <span class="deck-row-keys">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            class={`plate-key${a === 'take' ? ' key-main' : ''}`}
            aria-label={person.you ? ACTION_WORDS[a] : actionName(ACTION_WORDS[a], person.name)}
            onClick={() => act(a, person)}
          >
            {ACTION_WORDS[a]}
          </button>
        ))}
      </span>
    </li>
  );
}

/**
 * Who is aboard, in a window over the sea: a row each, the skipper
 * first; putting someone ashore asks first, in one line in their row's
 * place. The crew's Go ashore at its foot.
 */
export function AboardList({ deck }: { deck: DeckView }) {
  const crew = deck.crew.value;
  const [putting, setPutting] = useState<PersonTold | null>(null);
  const close = () => (deck.list.value = false);
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
  const act = (a: RowAction, p: PersonTold) => {
    switch (a) {
      case 'hand':
        deck.hand(p.seat);
        break;
      case 'take':
        deck.take();
        break;
      case 'giveBack':
        deck.giveBack();
        break;
      case 'putAshore':
        setPutting(p);
        break;
    }
  };
  const people = crew?.people ?? [];
  const self = selfOf(crew);
  return (
    <section class="panel deck-window deck-list" aria-labelledby="deck-list-title">
      <h2 id="deck-list-title">{WHO_IS_ABOARD}</h2>
      <ul class="deck-rows">
        {people.map((p) =>
          putting?.seat === p.seat && crew !== null ? (
            <li class="deck-row deck-putting" key={p.seat} data-seat={p.seat}>
              <p>
                <Said words={putAshoreWords(p.name)} />
              </p>
              <span class="deck-row-keys">
                <button
                  type="button"
                  class="plate-key key-main"
                  onClick={() => {
                    setPutting(null);
                    deck.putAshore(p.seat);
                  }}
                >
                  {PUT_ASHORE}
                </button>
                <button type="button" class="plate-key" onClick={() => setPutting(null)}>
                  {KEEP_ABOARD}
                </button>
              </span>
            </li>
          ) : crew !== null ? (
            <PersonRow key={p.seat} person={p} crew={crew} act={act} />
          ) : null,
        )}
      </ul>
      <div class="deck-keys deck-list-foot">
        {deck.aboard.value !== null && self !== null && self.seat !== 0 ? (
          <button type="button" class="plate-key" onClick={() => (deck.ashore.value = true)}>
            {GO_ASHORE}
          </button>
        ) : null}
        <button type="button" class="plate-key deck-close" onClick={close}>
          {CLOSE}
        </button>
      </div>
    </section>
  );
}

/** What the screen shows of sailing together under the case: the controls offered, the knocks, the own knock, the line. */
export function DeckTop({ deck }: { deck: DeckView }) {
  if (deck.watching.value !== null) {
    return null;
  }
  return (
    <>
      <HandedCard deck={deck} />
      <KnockCards deck={deck} />
      <KnockingCard deck={deck} />
      <DeckLine deck={deck} />
    </>
  );
}

/** At the foot of the screen, in the controls' place: the plate. */
export function DeckFoot({ deck }: { deck: DeckView }) {
  if (deck.watching.value !== null || !deckPlate(deck)) {
    return null;
  }
  return (
    <div class="deck-foot">
      <DeckPlate deck={deck} />
    </div>
  );
}

/** The windows over the sea: going ashore's question, who is aboard, the skipper's link. */
export function DeckWindows({ deck, sailor }: { deck: DeckView; sailor: string | null }) {
  if (deck.ashore.value && deck.aboard.value !== null) {
    return <AshoreQuestion deck={deck} />;
  }
  if (deck.list.value && deck.crew.value !== null && deck.watching.value === null) {
    return <AboardList deck={deck} />;
  }
  if (deck.link.value) {
    return <SailWithMe deck={deck} sailor={sailor} close={() => (deck.link.value = false)} />;
  }
  return null;
}

// SPDX-License-Identifier: AGPL-3.0-only

// The way home: Back to Port Royal in the menu at sea, while the player
// sails their own boat (not aboard another's, where Go ashore is, nor
// watching, where Sail is). Its question says what happens: the boat
// lifted to the start off Port Royal, the voyage ended; and, racing, that
// the boat retires, and with shipmates aboard, that they come too. Back
// to Port Royal lifts it, under the page's cover; Stay, or Escape, puts
// the question away.

import './home.css';
import type { Signal } from '@preact/signals';
import type { Ref } from 'preact';
import { BACK_TO_PORT_ROYAL, HOME_QUESTION, HOME_STAY, homeLines } from './homewords';
import { useModal } from './modal';

/** The way home, as the menu and its question see it. */
export interface HomeView {
  /** Whether the way home is offered: the own boat sailed, not aboard another's nor watching. */
  offered: () => boolean;
  /** Whether the question is asked. */
  asking: Signal<boolean>;
  /** Whether the boat races now: it retires. */
  racing: () => boolean;
  /** Whether anyone else is aboard: they come too. */
  shipmates: () => boolean;
  /** Lifts the boat home. */
  go: () => void;
}

/**
 * The question before the boat is lifted home: Stay takes the focus, and
 * Escape is Stay; the screen behind is inert while it is asked.
 */
export function HomeQuestion({ home }: { home: HomeView }) {
  const ref = useModal(
    () => {
      home.asking.value = false;
    },
    { inert: true, focus: '[data-stay]', back: '.menu-button' },
  );
  return <HomeWindow home={home} win={ref} />;
}

/** The question's window: its head, its lines, Back to Port Royal and Stay. */
export function HomeWindow({ home, win }: { home: HomeView; win?: Ref<HTMLElement> }) {
  const stay = () => {
    home.asking.value = false;
  };
  return (
    <section
      class="panel home-question"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="home-title"
      ref={win ?? null}
    >
      <h2 id="home-title">{HOME_QUESTION}</h2>
      {homeLines(home.racing(), home.shipmates()).map((l) => (
        <p key={l}>{l}</p>
      ))}
      <div class="home-keys">
        <button
          type="button"
          class="plate-key key-main"
          onClick={() => {
            home.asking.value = false;
            home.go();
          }}
        >
          {BACK_TO_PORT_ROYAL}
        </button>
        <button type="button" class="plate-key" data-stay onClick={stay}>
          {HOME_STAY}
        </button>
      </div>
    </section>
  );
}

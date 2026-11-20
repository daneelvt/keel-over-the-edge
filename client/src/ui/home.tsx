// SPDX-License-Identifier: AGPL-3.0-only

// The way home: Back to Port Royal in the menu at sea, while the player
// sails their own boat (not aboard another's, where Go ashore is, nor
// watching, where Sail is). Its question says what happens: the boat
// lifted to the start off Port Royal, the voyage ended; and, racing, that
// the boat retires, and with shipmates aboard, that they come too. Back
// to Port Royal lifts it, under the page's cover; Stay, or Escape, puts
// the question away. Change boat, under it in the menu, asks the same
// way: the boat taken out of the water, the voyage ended, and the page
// back at the start screen with the boats to choose from. Both questions
// stand in the menu's place, beside the boat.

import './home.css';
import { type Signal, signal } from '@preact/signals';
import type { Ref } from 'preact';
import {
  BACK_TO_PORT_ROYAL,
  CHANGE_BOAT,
  CHANGE_FAILED,
  CHANGE_QUESTION,
  changeLines,
  HOME_QUESTION,
  HOME_STAY,
  homeLines,
} from './homewords';
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
  /** Whether Change boat's question is asked. */
  changing: Signal<boolean>;
  /**
   * Takes the boat out of the water and opens the start screen on the
   * boats to choose from; false if the boat could not be taken out.
   */
  change: () => Promise<boolean>;
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
      class="panel home-question at-side"
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

/** Change boat's question, asked as the way home's is. */
export function ChangeQuestion({ home }: { home: HomeView }) {
  const ref = useModal(
    () => {
      home.changing.value = false;
    },
    { inert: true, focus: '[data-stay]', back: '.menu-button' },
  );
  return <ChangeWindow home={home} win={ref} />;
}

/** What the question shows of the change: under way, and why it failed. */
const changeBusy = signal(false);
const changeProblem = signal('');

/** The question's window: its head, its lines, Change boat and Stay. */
export function ChangeWindow({ home, win }: { home: HomeView; win?: Ref<HTMLElement> }) {
  const stay = () => {
    changeProblem.value = '';
    home.changing.value = false;
  };
  const go = async () => {
    if (changeBusy.value) {
      return;
    }
    changeBusy.value = true;
    changeProblem.value = '';
    const out = await home.change();
    changeBusy.value = false;
    if (!out) {
      changeProblem.value = CHANGE_FAILED;
    }
  };
  return (
    <section
      class="panel home-question at-side"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="change-title"
      data-question="change-boat"
      ref={win ?? null}
    >
      <h2 id="change-title">{CHANGE_QUESTION}</h2>
      {changeLines(home.racing(), home.shipmates()).map((l) => (
        <p key={l}>{l}</p>
      ))}
      {changeProblem.value !== '' ? (
        <p class="home-problem" aria-live="polite">
          {changeProblem.value}
        </p>
      ) : null}
      <div class="home-keys">
        <button
          type="button"
          class="plate-key key-main"
          disabled={changeBusy.value}
          onClick={() => void go()}
        >
          {CHANGE_BOAT}
        </button>
        <button type="button" class="plate-key" data-stay onClick={stay}>
          {HOME_STAY}
        </button>
      </div>
    </section>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only

// The world changed under the cover. The cover comes down over the screen,
// the world changes under it, and it lifts once the world under it is
// ready (gate.ts): at the start, at a change of boat, and when the page
// snaps to where its boat is now, after a while hidden or on a connection
// made again, rather than show the world lurch there.

import { effect, type ReadonlySignal } from '@preact/signals';
import type { Online } from '../net/online';
import type { SeaScene } from '../render/scene';
import { type Cover, DROP, LIFT, LIFT_REDUCED, QUIET } from './cover';
import { Gate, type Revealed, WAITING_WORDS, type Waiting } from './gate';

/** How long the camera comes down into the first view, s: at the start, and after a change of boat. */
export const DESCENT = 2.5;
export const DESCENT_CHANGE = 1.5;

/** Whether the reader asks for less motion. */
export function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Resolves after n animation frames: the scene's update has run since. */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => next(left - 1));
    next(n);
  });
}

/** Resolves once a count has passed n: a boat arrived, a snap seen through. */
export function whenPast(count: ReadonlySignal<number>, n: number): Promise<void> {
  let stop = (): void => {};
  return new Promise<void>((resolve) => {
    stop = effect(() => {
      if (count.value > n) {
        resolve();
      }
    });
  }).finally(() => stop());
}

/**
 * Waits on the gate, from start (ms), the cover saying what it waits for
 * once the wait passes a second; the frame loop draws once the frames are
 * waited for. Resolves with what it waited for, and when.
 */
export async function untilReady(
  gate: Gate,
  world: SeaScene,
  cover: Cover,
  start: number,
): Promise<Pick<Revealed, 'waits' | 'at' | 'timedOut' | 'drawn'>> {
  const waits: { waiting: Waiting; at: number }[] = [];
  let drawn = 0;
  world.onDrawn = (work) => {
    drawn++;
    gate.drawn(work);
  };
  for (;;) {
    const now = performance.now();
    const w = gate.step(now);
    if (waits[waits.length - 1]?.waiting !== w) {
      waits.push({ waiting: w, at: Math.round(now - start) });
    }
    if (w === 'ready') {
      break;
    }
    if (w === 'sail' && world.drawsWhenReady) {
      world.stage.loopDraws = true;
    }
    if (now - start >= QUIET) {
      cover.say(WAITING_WORDS[w]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  world.onDrawn = null;
  if (world.drawsWhenReady) {
    world.stage.loopDraws = true;
  }
  return { waits, at: Math.round(performance.now() - start), timedOut: gate.timedOut, drawn };
}

/**
 * The world revealed: the cover fades out as the camera comes down into
 * the first view over descent seconds, the screen at sea coming in after
 * it. With less motion asked for, a short fade and no descent; on a page
 * under test, at once.
 */
export function reveal(world: SeaScene, cover: Cover, descent: number): void {
  if (world.underTest) {
    void cover.lift(0);
    return;
  }
  const reduced = reducedMotion();
  world.camera.descend(reduced ? 0 : descent);
  void cover.lift(reduced ? LIFT_REDUCED : LIFT);
}

/** What the cover at sea works with. */
export interface UnderCoverParts {
  world: SeaScene;
  cover: Cover;
  online: Online;
  /** Whether the land within reach of the boat is built. */
  landNear(): boolean;
  /** Brings the screen back from the clear view. */
  showScreen(): void;
}

/**
 * The cover at sea, one change at a time: the cover takes the taps
 * meanwhile, and a snap during a change is the change's to see through.
 */
export class UnderCover {
  /** The world has been revealed once: before, the start's own gate covers everything. */
  atSea = false;
  readonly #p: UnderCoverParts;
  #busy = false;

  constructor(parts: UnderCoverParts) {
    this.#p = parts;
  }

  /** Whether a change or a snap is under the cover now. */
  get busy(): boolean {
    return this.#busy;
  }

  /**
   * A change of boat: the cover down over the screen, the boat asked for
   * (act) under it, and the cover up again once the new boat's world is
   * ready; at once if none comes (a watch refused, a queue).
   */
  async change(act: () => void): Promise<void> {
    const { world, cover, online } = this.#p;
    if (!this.atSea) {
      act();
      return;
    }
    if (this.#busy) {
      return;
    }
    this.#busy = true;
    const n = online.arrived.value;
    const ended = online.ended.value;
    this.#p.showScreen();
    const start = performance.now();
    await cover.drop(world.underTest || reducedMotion() ? 0 : DROP);
    if (world.drawsWhenReady) {
      world.stage.loopDraws = false;
    }
    act();
    const arrived = () => online.arrived.value > n;
    await this.#until(arrived, start, online.arrived, n, () => {
      return (
        online.ended.value !== ended ||
        online.watchPlace.value !== null ||
        online.place.value !== null
      );
    });
    reveal(world, cover, arrived() ? DESCENT_CHANGE : 0);
    this.#busy = false;
  }

  /**
   * The way home, as a change of boat: the cover down over the screen, the
   * lift asked for under it (ask), and the cover up again once the boat is
   * drawn at the start with the land about it; at once if the lift comes to
   * nothing (too soon). A page aboard, whose skipper asked, is covered at
   * once as the lift comes (ask false), and lifted the same way.
   */
  async home(ask: boolean): Promise<void> {
    const { world, cover, online } = this.#p;
    if (!this.atSea || this.#busy) {
      if (ask) {
        online.home();
      }
      return;
    }
    this.#busy = true;
    const n = online.lifted.value;
    const refused = online.unlifted.value;
    this.#p.showScreen();
    const start = performance.now();
    await cover.drop(world.underTest || reducedMotion() || !ask ? 0 : DROP);
    if (world.drawsWhenReady) {
      world.stage.loopDraws = false;
    }
    if (ask) {
      online.home();
    }
    const lifted = () => online.lifted.value > n;
    await this.#until(lifted, start, online.lifted, n, () => online.unlifted.value > refused);
    reveal(world, cover, lifted() ? DESCENT_CHANGE : 0);
    this.#busy = false;
  }

  /**
   * A snap (Online's onSnap), the page started again from the newest
   * snapshot: the cover down at once, so the world is never seen lurching
   * from where it was; the wakes, and the frames' time, from now; the
   * camera behind the boat where it is now; and the cover up once its
   * world is ready. Nothing to wait for once the connection cannot bring
   * a snapshot by itself.
   */
  async snap(): Promise<void> {
    const { world, cover, online } = this.#p;
    world.afresh();
    if (!this.atSea || this.#busy) {
      return;
    }
    this.#busy = true;
    const n = online.snapped.value;
    const start = performance.now();
    await cover.drop(0);
    if (world.drawsWhenReady) {
      world.stage.loopDraws = false;
    }
    const came = () => online.snapped.value > n;
    await this.#until(came, start, online.snapped, n, () => {
      const s = online.status.value;
      return s !== 'sailing' && s !== 'connecting';
    });
    reveal(world, cover, 0);
    this.#busy = false;
  }

  /**
   * Waits under the cover, from start (ms), for the world: came once the
   * boat's snapshot is taken (count past n), the first view placed two
   * frames on, the land near and the first frames drawn; or nothing more
   * once given up.
   */
  async #until(
    came: () => boolean,
    start: number,
    count: ReadonlySignal<number>,
    n: number,
    givenUp: () => boolean,
  ): Promise<void> {
    const { world, cover } = this.#p;
    let placed = false;
    const gate = new Gate(
      {
        epoch: () => true,
        boat: came,
        view: () => placed,
        land: () => this.#p.landNear() && world.sailorReady,
        abandoned: () => !came() && givenUp(),
      },
      { start, draws: world.drawsWhenReady },
    );
    const ready = untilReady(gate, world, cover, start);
    // A boat that comes after the wait was given up is not this one's.
    let waiting = true;
    void whenPast(count, n).then(async () => {
      if (!waiting) {
        return;
      }
      await frames(2);
      world.placeFirstView();
      placed = true;
    });
    await ready;
    waiting = false;
  }
}

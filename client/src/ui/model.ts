// SPDX-License-Identifier: AGPL-3.0-only

// What the screen at sea shows, kept out of the frame's budget. The words
// and numbers (speed, heading, wind, the sailor's state) are signals,
// written at most ten times a second, so the interface renders at most that
// often. What moves every frame (the compass card, the controls' knobs, the
// clinometer) is moved through style.transform on elements the components
// hand over, without a render, and only when it has moved.

import { signal } from '@preact/signals';
import type { Wind } from '../game/driver';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import { headingText, knots, windText } from './format';

/** The signals are written at most this often, in milliseconds. */
export const SIGNAL_INTERVAL = 100;

/** The sailor's modes, as State.SailorMode has them, and what the screen says. */
const SAILOR_LINES = ['', 'In the water', 'Righting the boat', 'Climbing back in'];

/** An element moved by a transform, and the value it was last moved to. */
class Moved {
  el: HTMLElement | SVGElement | null = null;
  #last = Number.NaN;
  readonly #write: (el: HTMLElement | SVGElement, v: number) => void;
  readonly #step: number;

  constructor(write: (el: HTMLElement | SVGElement, v: number) => void, step: number) {
    this.#write = write;
    this.#step = step;
  }

  set(v: number): void {
    if (this.el === null || Math.abs(v - this.#last) < this.#step) {
      return;
    }
    this.#last = v;
    this.#write(this.el, v);
  }

  /** Forgets the last value (a new element was attached). */
  attach(el: HTMLElement | SVGElement | null): void {
    this.el = el;
    this.#last = Number.NaN;
  }
}

const rotate = (el: HTMLElement | SVGElement, deg: number): void => {
  el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
};

/** The helm's knob travels along an arc of this many degrees each side of the top. */
export const HELM_ARC = 55;

export class HudModel {
  readonly speed = signal('0.0');
  readonly heading = signal('000° N');
  readonly wind = signal('0 kn N');
  /** What the sailor is doing when not sailing; empty while sailing. */
  readonly sailor = signal('');
  /** How many times the signals were written. */
  writes = 0;

  /** The compass rose, turned so the boat's heading is up. */
  readonly rose = new Moved(rotate, 0.1);
  /** The wind's mark on the rim, at the direction the true wind comes from. */
  readonly windMark = new Moved(rotate, 0.1);
  /** The helm's knob (the target) and its shadow (where the rudder is). */
  readonly helmKnob = new Moved(rotate, 0.1);
  readonly helmActual = new Moved(rotate, 0.1);
  /** The sheet's knob and its shadow, as a fraction of the slider down from Trim. */
  readonly sheetKnob = new Moved((el, v) => {
    el.style.transform = `translateY(${(v * 100).toFixed(2)}%)`;
  }, 0.001);
  readonly sheetActual = new Moved((el, v) => {
    el.style.transform = `translateY(${(v * 100).toFixed(2)}%)`;
  }, 0.001);
  /** The controls' values, for assistive technology. */
  readonly helmValue = new Moved((el, v) => el.setAttribute('aria-valuenow', v.toFixed(2)), 0.01);
  readonly sheetValue = new Moved((el, v) => el.setAttribute('aria-valuenow', v.toFixed(2)), 0.01);
  /** The clinometer's needle. */
  readonly clinometer = new Moved(rotate, 0.1);

  #lastWrite = Number.NEGATIVE_INFINITY;

  /** Writes the signals on the next frame, however soon. */
  flush(): void {
    this.#lastWrite = Number.NEGATIVE_INFINITY;
  }

  /**
   * Updates the screen for a frame at now (ms). helm and sheet are the
   * targets; rudder and sheetOut where the rudder and the sheet really are,
   * on the same scales (−1 to 1, 0 to 1).
   */
  frame(
    now: number,
    pose: BoatPose,
    out: Float64Array,
    wind: Readonly<Wind>,
    helm: number,
    sheet: number,
    rudder: number,
    sheetOut: number,
  ): void {
    const headingDeg = (pose.heading * 180) / Math.PI;
    this.rose.set(-headingDeg);
    this.windMark.set(((wind.from - pose.heading) * 180) / Math.PI);
    this.helmKnob.set(helm * HELM_ARC);
    this.helmActual.set(rudder * HELM_ARC);
    this.sheetKnob.set(sheet);
    this.sheetActual.set(sheetOut);
    this.helmValue.set(helm);
    this.sheetValue.set(sheet);
    this.clinometer.set((pose.heel * 180) / Math.PI);
    if (now - this.#lastWrite < SIGNAL_INTERVAL) {
      return;
    }
    this.#lastWrite = now;
    this.writes++;
    this.speed.value = knots(out[RECORDS.out.speedOverGround] ?? 0);
    this.heading.value = headingText(pose.heading);
    this.wind.value = windText(wind.speed, wind.from);
    this.sailor.value = SAILOR_LINES[pose.sailorMode] ?? '';
  }
}

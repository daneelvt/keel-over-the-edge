// SPDX-License-Identifier: AGPL-3.0-only

// The game at sea: the frame loop that joins the controls, the boat driver
// and the scene. Each drawn frame the keys move their targets, the step
// loop takes the steps due (each with the controls at their resolution),
// and the scene is given the boat between its last two steps, the latest
// Out and world time; then the instruments and the sound follow. Input
// events arrive between frames and only move targets (the helm's, the
// sheet's, the camera's); the frame reads them. Nothing in the frame
// allocates.

import { effect } from '@preact/signals';
import { SoundEngine } from '../audio/engine';
import { type SoundInput, soundInput } from '../audio/voices';
import { HelmInput } from '../input/helm';
import { KeyInput } from '../input/keys';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import { SheetInput } from '../input/sheet';
import type { SeaScene } from '../render/scene';
import { HudModel } from '../ui/model';
import type { SettingsSignal } from '../ui/settings';
import { WorldClock } from './clock';
import type { BoatDriver, Pacer } from './driver';
import { StepLoop } from './loop';

const DEG = Math.PI / 180;

export class Game {
  readonly clock = new WorldClock();
  readonly loop: StepLoop;
  readonly helm = new HelmInput();
  readonly sheet = new SheetInput();
  readonly keys = new KeyInput(this.helm, this.sheet);
  readonly hud = new HudModel();
  readonly sound = new SoundEngine();
  readonly world: SeaScene;
  readonly settings: SettingsSignal;
  driver: BoatDriver | null = null;
  /** Paces the driver by the world clock instead of real time: the game online. */
  pacer: Pacer | null = null;
  /** Held: no steps are taken and world time stands (the browser tests). */
  frozen = false;
  /** Called before each step, after the controls are read (the browser tests script controls). */
  beforeStep: (() => void) | null = null;

  readonly #sound: SoundInput = { apparentWind: 0, speed: 0, luffing: 0, time: 0 };
  readonly #rudderMax: number;
  readonly #boomIn: number;
  readonly #boomOut: number;
  #lastTime = 0;

  constructor(world: SeaScene, settings: SettingsSignal) {
    this.world = world;
    this.settings = settings;
    this.loop = new StepLoop(this.clock, () => this.#step());
    const { foils, rig } = world.kind.physics;
    this.#rudderMax = foils.rudderAngle * DEG;
    this.#boomIn = rig.boomIn * DEG;
    this.#boomOut = rig.boomOut * DEG;
    this.sheet.target = 0.5;
    world.tick = (dt, now) => this.#frame(dt, now);
    effect(() => {
      const s = settings.value.value;
      world.stage.cap.limit = s.frameRate;
      this.sound.enabled = s.sound;
      this.helm.centreOnRelease = s.centreHelm;
      world.overlays.set(s.windOverlay, s.forcesOverlay);
    });
  }

  /** Puts a driver in charge of the boat, with its controls as the player's. */
  setDriver(d: BoatDriver): void {
    this.driver = d;
    this.world.out = d.out;
    this.world.wind = d.wind;
  }

  /** Holds world time at t seconds (the nearest step). */
  freeze(t: number): void {
    this.clock.set(t);
    this.frozen = true;
    this.settle();
  }

  /** Lets what eases on screen (telltales, pennant, ripple) reach its pose on the next frame. */
  settle(): void {
    this.#lastTime = this.clock.time - 1;
  }

  thaw(): void {
    this.frozen = false;
    this.loop.accumulator = 0;
  }

  /** Listens to the keyboard, the camera's pointers and the page's visibility. */
  listen(doc: Document, surface: HTMLElement): void {
    const typing = (e: Event): boolean => {
      const t = e.target;
      return (
        t instanceof HTMLInputElement ||
        t instanceof HTMLSelectElement ||
        t instanceof HTMLTextAreaElement
      );
    };
    doc.addEventListener('keydown', (e) => {
      if (!typing(e) && !e.metaKey && !e.ctrlKey && !e.altKey && this.keys.down(e.code)) {
        e.preventDefault();
      }
    });
    doc.addEventListener('keyup', (e) => {
      if (this.keys.up(e.code)) {
        e.preventDefault();
      }
    });
    doc.defaultView?.addEventListener('blur', () => this.keys.release());
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') {
        this.world.stage.resumed();
      } else {
        this.keys.release();
      }
    });
    // Safari's own pinch-zoom of the page would fight the camera's pinch.
    doc.addEventListener('gesturestart', (e) => e.preventDefault());
    this.sound.listen(doc);
    bindCamera(surface, this.world);
    const motion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (motion !== undefined) {
      this.world.camera.reducedMotion = motion.matches;
      motion.addEventListener('change', () => {
        this.world.camera.reducedMotion = motion.matches;
      });
    }
  }

  /** Steps once with the controls as they are (the panel's single step, the tests). */
  stepOnce(): void {
    this.loop.stepOnce();
  }

  #step(): void {
    const d = this.driver;
    if (d === null) {
      return;
    }
    this.beforeStep?.();
    d.step(quantiseHelm(this.helm.target), quantiseSheet(this.sheet.target));
  }

  #frame(dt: number, now: number): void {
    const d = this.driver;
    const w = this.world;
    if (!this.frozen) {
      this.keys.update(dt);
      if (this.pacer !== null) {
        this.pacer.frame(dt);
      } else if (d !== null) {
        this.loop.advance(dt);
      }
    }
    if (d !== null) {
      d.states.blend(this.clock.alpha, w.pose);
      d.decorate?.(w.pose, dt);
    }
    const time = this.clock.time;
    // At most a second: after a pause or a jump, what eases simply arrives.
    w.timeStep = Math.min(1, Math.max(0, time - this.#lastTime));
    w.time = time;
    this.#lastTime = time;
    const p = w.pose;
    this.hud.frame(
      now,
      p,
      w.out,
      w.wind,
      this.helm.target,
      this.sheet.target,
      p.rudder / this.#rudderMax,
      (p.sheetLimit - this.#boomIn) / (this.#boomOut - this.#boomIn),
    );
    this.sound.update(now, soundInput(w.out, time, this.#sound));
  }
}

/**
 * The camera under the pointer on the open sea: one finger or the mouse
 * swings it, a pinch or the wheel sets its distance. The controls over the
 * scene take their own pointers, so these are the sea's.
 */
function bindCamera(surface: HTMLElement, world: SeaScene): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let spread = 0;
  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
  };
  surface.addEventListener('pointerdown', (e) => {
    if (e.target !== surface && !(e.target instanceof HTMLCanvasElement)) {
      return;
    }
    surface.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    spread = distance();
    world.camera.holding = true;
  });
  surface.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (p === undefined) {
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      world.camera.drag(dx, dy, e.timeStamp);
    } else if (pointers.size === 2) {
      const now = distance();
      if (spread > 0 && now > 0) {
        world.camera.zoom(spread / now, e.timeStamp);
      }
      spread = now;
    }
  });
  const end = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    spread = distance();
    world.camera.holding = pointers.size > 0;
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  surface.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      world.camera.zoom(Math.exp(e.deltaY * 0.001), e.timeStamp);
    },
    { passive: false },
  );
}

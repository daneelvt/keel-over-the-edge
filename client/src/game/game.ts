// SPDX-License-Identifier: AGPL-3.0-only

// The game at sea: the frame loop that joins the controls, the boat driver
// and the scene. Each drawn frame the keys move their targets, the step
// loop takes the steps due (each with the controls at their resolution,
// and the autopilot's control, which the step steers by while it is on),
// and the scene is given the boat between its last two steps, the latest
// Out and world time; then the instruments and the sound follow. Input
// events arrive between frames and only move targets (the helm's, the
// sheet's, the autopilot's, the camera's); the frame reads them. Nothing in
// the frame allocates.

import { effect } from '@preact/signals';
import { SoundEngine } from '../audio/engine';
import { groundSound, SCRAPE, scrapeOf } from '../audio/ground';
import { KNOCK, knockOf } from '../audio/knock';
import { type SoundInput, soundInput } from '../audio/voices';
import { HelmInput } from '../input/helm';
import { KeyInput } from '../input/keys';
import { PILOT_HEADING, PILOT_WIND, type PilotActions, PilotInput, WAY_HOLD } from '../input/pilot';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import { SheetInput } from '../input/sheet';
import type { BumpTold } from '../net/messages';
import { RECORDS } from '../predict/layout.gen';
import type { SeaScene } from '../render/scene';
import { HudModel, PUSHED_OFF } from '../ui/model';
import type { SettingsSignal } from '../ui/settings';
import { bumpLine } from '../ui/verdict';
import { WorldClock } from './clock';
import type { BoatDriver, Pacer } from './driver';
import { StepLoop } from './loop';

const DEG = Math.PI / 180;

export class Game implements PilotActions {
  readonly clock = new WorldClock();
  readonly loop: StepLoop;
  readonly helm = new HelmInput();
  readonly sheet = new SheetInput();
  readonly pilot = new PilotInput();
  readonly keys = new KeyInput(this.helm, this.sheet, this);
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
  /** The last bump told, and how many (the developer panel, the tests). */
  lastBump: BumpTold | null = null;
  bumps = 0;
  /** How the boat met the ground as it last touched it, and how often (the tests). */
  lastGround: 'knock' | 'scrape' | null = null;
  groundings = 0;
  /** The friction of the bed under a point, from the land held; 0 where none is held. */
  bedFriction: (east: number, north: number) => number = () => 0;

  readonly #sound: SoundInput = {
    apparentWind: 0,
    speed: 0,
    throughWater: 0,
    seaHeight: 0,
    whitecaps: 0,
    luffing: 0,
    time: 0,
  };
  /** Out's aground after the last frame, the boat's speed then, and the pushes counted. */
  #aground = 0;
  #speed = 0;
  #pushes = 0;
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
    // The dial and the keys go no closer to the wind than ten degrees
    // inside close-hauled.
    this.pilot.least = (rig.closeHauled - 10) * DEG;
    this.helm.onTake = () => this.takeHelm();
    this.sheet.target = 0.5;
    world.tick = (dt, now) => this.#frame(dt, now);
    effect(() => {
      const s = settings.value.value;
      world.stage.cap.limit = s.frameRate;
      world.setDetail(s.detail);
      this.sound.enabled = s.sound;
      this.helm.centreOnRelease = s.centreHelm;
      world.overlays.set(s.windOverlay, s.forcesOverlay);
      world.rightOfWay.set(s.rightOfWay);
    });
  }

  /** Puts a driver in charge of the boat, with its controls as the player's. */
  setDriver(d: BoatDriver): void {
    this.driver = d;
    if ('clock' in d) {
      d.clock = this.clock;
    }
    this.world.out = d.out;
    this.world.wind = d.wind;
    this.world.ocean.source =
      d.physics !== undefined && d.seas !== undefined
        ? { physics: d.physics, seas: d.seas, weather: d.weather !== undefined }
        : null;
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
      if (
        !typing(e) &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        this.keys.down(e.code, e.shiftKey)
      ) {
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

  /**
   * A bump the server told of, at now (ms): a knock of timber, placed where
   * the hulls touched; and, if the boat was one of the two, a shake of the
   * camera and the Articles' verdict under the readout. Played once.
   */
  bump(b: BumpTold, now: number): void {
    this.lastBump = b;
    this.bumps++;
    const p = this.world.pose;
    const dx = b.east - p.east;
    const dy = b.north - p.north;
    this.sound.knock(knockOf(KNOCK, b.closing, Math.hypot(dx, dy), Math.atan2(dx, dy) - p.heading));
    if (b.part === 'seen') {
      return;
    }
    this.world.camera.shake(b.closing, now);
    this.hud.showBump(bumpLine(b.article, b.part), now);
  }

  /**
   * The boat and the ground, at now (ms): as it first touches, a scrape on a
   * soft bottom or a knock on land or a hard one, by its speed, and against
   * land a shake; and after each push off, the line that says so.
   */
  #ground(d: BoatDriver, now: number): void {
    const aground = d.out[RECORDS.out.aground] ?? 0;
    if (aground !== 0 && this.#aground === 0) {
      const p = this.world.pose;
      const sound = groundSound(aground, this.bedFriction(p.east, p.north));
      if (sound === 'scrape') {
        this.sound.scrape(scrapeOf(SCRAPE, this.#speed));
      } else if (sound === 'knock') {
        this.sound.knock(knockOf(KNOCK, this.#speed, 0, 0));
      }
      if (aground === 2) {
        this.world.camera.shake(this.#speed, now);
      }
      this.lastGround = sound;
      this.groundings++;
    }
    this.#aground = aground;
    this.#speed = d.out[RECORDS.out.speedOverGround] ?? 0;
    const pushes = d.pushes ?? 0;
    if (pushes > this.#pushes) {
      this.hud.showBump(PUSHED_OFF, now);
    }
    this.#pushes = pushes;
  }

  /** Steps once with the controls as they are (the panel's single step, the tests). */
  stepOnce(): void {
    this.loop.stepOnce();
  }

  togglePilot(): void {
    if (this.pilot.on) {
      this.takeHelm();
    } else {
      this.engagePilot(PILOT_WIND);
    }
  }

  engagePilot(mode: number): void {
    const d = this.driver;
    if (d === null) {
      return;
    }
    this.pilot.engage(mode, d.states.current[RECORDS.state.heading] ?? 0, d.wind.meanFrom);
  }

  takeHelm(): void {
    if (!this.pilot.on) {
      return;
    }
    // The helm stays where the autopilot left it, so nothing jumps.
    const d = this.driver;
    if (d !== null) {
      this.helm.target = quantiseHelm(d.out[RECORDS.out.pilotHelm] ?? 0);
    }
    this.pilot.off();
  }

  pilotTack(): void {
    this.pilot.tack(this.driver?.wind.meanFrom ?? 0);
  }

  pilotGybe(): void {
    this.pilot.gybe(this.driver?.wind.meanFrom ?? 0);
  }

  pilotAdjust(degrees: number): void {
    this.pilot.adjust(degrees);
  }

  /** Switches the autopilot between holding an angle to the wind and a heading, at what the boat does now. */
  pilotMode(): void {
    this.engagePilot(this.pilot.mode === PILOT_WIND ? PILOT_HEADING : PILOT_WIND);
  }

  #step(): void {
    const d = this.driver;
    if (d === null) {
      return;
    }
    this.beforeStep?.();
    d.step(quantiseHelm(this.helm.target), quantiseSheet(this.sheet.target), this.pilot);
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
    w.overlays.setPilot(this.pilot.on);
    if (d !== null) {
      d.states.blend(this.clock.alpha, w.pose);
      d.decorate?.(w.pose, dt);
      if (this.pilot.on) {
        // Held on the boat's new tack after it gybed by itself: what the
        // player holds follows.
        const turning = (d.states.current[RECORDS.state.pilotWay] ?? 0) !== WAY_HOLD;
        this.pilot.follow(d.out[RECORDS.out.pilotHeading] ?? 0, d.wind.meanFrom, turning);
      }
    }
    if (d !== null) {
      this.#ground(d, now);
    }
    const time = this.clock.time;
    // At most a second: after a pause or a jump, what eases simply arrives.
    w.timeStep = Math.min(1, Math.max(0, time - this.#lastTime));
    w.time = time;
    w.ticks = this.clock.steps + this.clock.alpha;
    this.#lastTime = time;
    const p = w.pose;
    this.hud.frame(
      now,
      time,
      p,
      w.out,
      w.wind,
      // While the autopilot steers, the knob shows its helm.
      this.pilot.on ? (w.out[RECORDS.out.pilotHelm] ?? 0) : this.helm.target,
      this.sheet.target,
      p.rudder / this.#rudderMax,
      (p.sheetLimit - this.#boomIn) / (this.#boomOut - this.#boomIn),
      this.pilot,
      d === null ? 0 : (d.states.current[RECORDS.state.pilotWay] ?? 0),
    );
    this.hud.tack.value = w.rightOfWay.tack;
    this.sound.update(now, soundInput(w.out, w.sea, time, this.#sound));
  }
}

/** A tap moves less than this, CSS pixels, and is over within this, milliseconds. */
const TAP_TRAVEL = 8;
const TAP_TIME = 500;

/**
 * The camera under the pointer on the open sea: one finger or the mouse
 * swings it, a pinch or the wheel sets its distance, and a tap on a named
 * star shows its name. The controls over the
 * scene take their own pointers, so these are the sea's.
 */
function bindCamera(surface: HTMLElement, world: SeaScene): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let spread = 0;
  // A tap: one pointer, down and up within a moment and a few pixels. A
  // drag is not a tap.
  let tap: { x: number; y: number; at: number; moved: number } | null = null;
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
    tap = pointers.size === 1 ? { x: e.clientX, y: e.clientY, at: e.timeStamp, moved: 0 } : null;
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
    if (tap !== null) {
      tap.moved += Math.hypot(dx, dy);
    }
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
    if (
      e.type === 'pointerup' &&
      tap !== null &&
      pointers.size === 1 &&
      tap.moved < TAP_TRAVEL &&
      e.timeStamp - tap.at < TAP_TIME
    ) {
      const r = surface.getBoundingClientRect();
      world.tap(tap.x - r.left, tap.y - r.top, performance.now());
    }
    tap = null;
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

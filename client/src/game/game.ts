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
//
// The free camera: F flies it off the boat and back, Escape brings it back;
// while it flies the keys and the pointers fly it, the boat stays where it
// was, the screen is clean (a tap shows the way back for a few seconds),
// and the server is told where it is, so it sends what is about it. Online it is offered only
// to an account with the owner's flag; in the sandbox, to anyone.
//
// Watching another sailor's boat, nothing the player holds steers it: the
// keys move no control, and the free camera is not offered.

import { effect, signal } from '@preact/signals';
import { SoundEngine } from '../audio/engine';
import type { FeaturesInput } from '../audio/features';
import { FOG_SIGNAL_RULES, type FogSignalsInput, poorBy } from '../audio/fogsignals';
import { groundSound, SCRAPE, scrapeOf } from '../audio/ground';
import { KNOCK, knockOf } from '../audio/knock';
import type { ThunderInput } from '../audio/thunder';
import { edgeInput, type SoundInput, soundInput } from '../audio/voices';
import { catalog } from '../catalog';
import {
  ApproachWatch,
  BACK_AT_PORT,
  closestLine,
  FADE_IN,
  type FallShape,
  fadeOver,
  fallPose,
  OVER_THE_FALLS,
  overhang,
} from '../edge/over';
import { HelmInput } from '../input/helm';
import { KeyInput } from '../input/keys';
import { PILOT_HEADING, PILOT_WIND, type PilotActions, PilotInput, WAY_HOLD } from '../input/pilot';
import { quantiseHelm, quantiseSheet } from '../input/quantise';
import { SheetInput } from '../input/sheet';
import type { BumpTold } from '../net/messages';
import { RECORDS } from '../predict/layout.gen';
import { wavePeriod } from '../render/features';
import { type FlyKeys, RoamTeller } from '../render/freecam';
import type { SeaScene } from '../render/scene';
import { HOURS, hourAt, skyPeriods } from '../sky/skytime';
import { HudModel, PUSHED_OFF } from '../ui/model';
import type { SettingsSignal } from '../ui/settings';
import { bumpLine } from '../ui/verdict';
import { bumpedLine } from '../ui/watchwords';
import { STEPS_PER_SECOND, WorldClock } from './clock';
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
  /** The approaches to the lip on the boat's own track, for the screen. */
  readonly approach: ApproachWatch;
  /** Whether the free camera flies: the screen is clean. */
  readonly flying = signal(false);
  /** Whether the way back to the boat shows: for a few seconds after a tap on the free camera's picture. */
  readonly backShown = signal(false);
  #backTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the free camera is offered: online, the owner's flag; in the sandbox, always. */
  canFly: () => boolean = () => true;
  /** Whether the keys steer the boat drawn: not one watched. */
  canSteer: () => boolean = () => true;
  /** Told where the free camera is, as it leaves the boat, moves and comes back: online, the server. */
  onRoam: ((on: boolean, east: number, north: number, height: number) => void) | null = null;
  readonly #roam = new RoamTeller();
  /** The tick the drawn boat went over the lip, 0 while afloat; the starts again seen; when the last was, s. */
  #over = 0;
  #restarts = 0;
  #back = Number.NEGATIVE_INFINITY;
  /** How a boat over the lip is drawn falling: the own and the others. */
  readonly fallShape: FallShape;
  readonly #halfLength: number;

  readonly #sound: SoundInput = {
    apparentWind: 0,
    speed: 0,
    throughWater: 0,
    seaHeight: 0,
    whitecaps: 0,
    luffing: 0,
    time: 0,
    lip: Number.POSITIVE_INFINITY,
    lipPan: 0,
    falling: false,
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
    const edge = world.edge;
    this.approach = new ApproachWatch(edge.lip, edge.band, catalog.world.edge.clear);
    const slabs = catalog.world.edge.look.slabs;
    this.fallShape = {
      lip: edge.lip,
      drain: edge.drain.speed[2],
      gravity: slabs.gravity,
      tip: [slabs.tip[0] ?? 0.3, slabs.tip[1] ?? 1.9],
    };
    this.#halfLength = world.kind.physics.hull.waterlineLength / 2;
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
    const free = this.world.freeCam;
    doc.addEventListener('keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.code === 'KeyF' && !e.repeat && this.canFly()) {
        this.toggleFly();
        e.preventDefault();
        return;
      }
      if (free.on) {
        if (e.code === 'Escape') {
          this.land();
          e.preventDefault();
        } else if (flyKey(free.keys, e.code, true)) {
          e.preventDefault();
        }
        return;
      }
      if (!this.canSteer()) {
        this.keys.release();
        return;
      }
      if (this.keys.down(e.code, e.shiftKey)) {
        e.preventDefault();
      }
    });
    doc.addEventListener('keyup', (e) => {
      if (flyKey(free.keys, e.code, false) && free.on) {
        e.preventDefault();
        return;
      }
      if (this.keys.up(e.code)) {
        e.preventDefault();
      }
    });
    doc.defaultView?.addEventListener('blur', () => {
      this.keys.release();
      for (const k of Object.keys(free.keys) as (keyof FlyKeys)[]) {
        free.keys[k] = false;
      }
    });
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
    bindCamera(surface, this.world, () => this.showBack());
    const motion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (motion !== undefined) {
      this.world.camera.reducedMotion = motion.matches;
      this.world.freeCam.reducedMotion = motion.matches;
      this.world.lightning.reducedMotion = motion.matches;
      motion.addEventListener('change', () => {
        this.world.camera.reducedMotion = motion.matches;
        this.world.freeCam.reducedMotion = motion.matches;
        this.world.lightning.reducedMotion = motion.matches;
      });
    }
  }

  /**
   * A bump the server told of, at now (ms): a knock of timber, placed where
   * the hulls touched; and, if the boat was one of the two, a shake of the
   * camera and the Articles' verdict under the readout, or, for a boat
   * watched, that its sailor was bumped. Played once.
   */
  bump(b: BumpTold, now: number, watched: string | null = null): void {
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
    this.hud.showBump(watched === null ? bumpLine(b.article, b.part) : bumpedLine(watched), now);
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

  /**
   * The boat at the edge, at now (ms): as it goes over, the notice, the
   * camera held where it is and the boat drawn falling, the screen fading
   * to the mist; as it starts again, the notice, the autopilot off and the
   * helm centred, the camera behind it, the screen fading back. Afloat, a
   * hull hanging over the lip is drawn pitching over it, and an approach
   * survived is told.
   */
  #edge(d: BoatDriver, now: number): void {
    const w = this.world;
    const over = d.over ?? 0;
    const restarts = d.restarts ?? 0;
    const reduced = w.camera.reducedMotion;
    if (restarts > this.#restarts) {
      this.#restarts = restarts;
      this.#over = 0;
      this.#back = this.clock.time;
      this.hud.showBump(BACK_AT_PORT, now);
      this.pilot.off();
      this.helm.target = 0;
      this.approach.over();
      w.releaseCamera();
    }
    if (over !== 0 && this.#over === 0) {
      this.#over = over;
      this.hud.showBump(OVER_THE_FALLS, now);
      this.approach.over();
      if (!reduced) {
        w.holdCamera();
      }
    } else if (over === 0 && this.#over !== 0) {
      // A correction found the boat afloat after all.
      this.#over = 0;
      w.releaseCamera();
    }
    if (this.#over !== 0) {
      const t = (this.clock.steps + this.clock.alpha - this.#over) / STEPS_PER_SECOND;
      if (!reduced) {
        fallPose(w.pose, t, this.fallShape);
      }
      w.setFade(fadeOver(t, reduced));
      return;
    }
    overhang(w.pose, this.#halfLength, this.fallShape.lip);
    const s = d.states.current;
    const survived = this.approach.follow(s[RECORDS.state.x] ?? 0, s[RECORDS.state.y] ?? 0);
    if (survived !== null) {
      this.hud.showBump(closestLine(survived), now);
    }
    w.setFade(reduced ? 0 : 1 - (this.clock.time - this.#back) / FADE_IN);
  }

  /** F: the free camera off the boat, or back on it. */
  toggleFly(): void {
    if (this.world.freeCam.on) {
      this.land();
    } else {
      this.fly();
    }
  }

  /** The free camera off the boat, from where the camera is, if it is offered. */
  fly(): void {
    if (this.world.freeCam.on || !this.canFly()) {
      return;
    }
    this.keys.release();
    this.world.flyFree();
    this.driver?.stay?.(true);
    this.flying.value = true;
  }

  /** A tap on the free camera's picture: the way back shows for BACK_SHOWN ms. */
  showBack(): void {
    this.backShown.value = true;
    if (this.#backTimer !== null) {
      clearTimeout(this.#backTimer);
    }
    this.#backTimer = setTimeout(() => {
      this.backShown.value = false;
      this.#backTimer = null;
    }, BACK_SHOWN);
  }

  /** The free camera back on the boat: the chase camera behind it at once, the boat sailing again. */
  land(): void {
    this.backShown.value = false;
    if (!this.world.freeCam.on) {
      return;
    }
    this.world.landFree();
    this.driver?.stay?.(false);
    this.flying.value = false;
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
      this.#edge(d, now);
    }
    // The free camera withdrawn (the owner's flag cleared) comes back.
    if (w.freeCam.on && !this.canFly()) {
      this.land();
    }
    const roam = this.onRoam;
    if (roam !== null) {
      this.#roam.tell(w.freeCam, now / 1000, roam);
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
    // The falls: how far the lip is from the boat, and which way it lies
    // from where the camera looks.
    const look = w.lookBearing();
    const out = Math.atan2(p.east, p.north);
    edgeInput(
      this.fallShape.lip - Math.hypot(p.east, p.north),
      Math.sin(out - look),
      this.#over !== 0,
      this.#sound,
    );
    this.#sound.endNear = w.endStage.sound;
    this.#sound.rain = w.weather.rain;
    this.sound.update(now, soundInput(w.out, w.sea, time, this.#sound));
    this.#harbour(now, look);
    this.#features(now, look);
    this.#fogSignals(now, look);
    this.#thunder(now, look);
  }

  /** The sky's periods, and how long an hour of the world's day lasts, s. */
  readonly #periods = skyPeriods(catalog.sky);
  readonly #secondsPerHour = (catalog.sky.day * 60) / HOURS;

  /** The features' sounds, heard at the boat: falls, blowholes and colonies near it. */
  #features(now: number, look: number): void {
    const w = this.world;
    const land = w.land;
    if (land === null) {
      return;
    }
    const p = w.pose;
    const x: FeaturesInput = {
      seconds: w.ticks / STEPS_PER_SECOND,
      day: w.sky.now.sunHeight > 0,
      listener: { east: p.east, north: p.north },
      look,
      seaHeight: w.sea.height,
      period: wavePeriod(w.sea.height),
      falls: [],
      blowholes: [],
      colonies: [],
    };
    for (const { part, kind } of land.features.held()) {
      if (Math.hypot(part.east - p.east, part.north - p.north) > FEATURES_HEARD) {
        continue;
      }
      const at = { east: part.east, north: part.north };
      if (kind.site === 'waterfall') {
        x.falls.push({ ...at, drop: part.level });
      } else if (kind.site === 'blowhole') {
        x.blowholes.push({ ...at, seed: part.seed });
      } else if (kind.site === 'colony' && kind.birds !== undefined) {
        x.colonies.push({ ...at, call: kind.birds.call, seed: part.seed });
      }
    }
    this.sound.features(now, x);
  }

  /** The harbour's sounds, heard at the boat: in port, or near a town. */
  #harbour(now: number, look: number): void {
    const w = this.world;
    const land = w.land;
    const sky = w.skyTime;
    if (land === null || sky === null) {
      return;
    }
    const p = w.pose;
    const heard = land.towns.heardFrom(p.east, p.north, (e, n) => (land.heightAt(e, n) ?? -1) <= 0);
    this.sound.harbour(
      now,
      {
        seconds: w.ticks / STEPS_PER_SECOND,
        hour: hourAt(sky.world(w.ticks), this.#periods),
        day: w.sky.now.sunHeight > 0,
        listener: { east: p.east, north: p.north },
        look,
        ...heard,
        seaHeight: w.sea.height,
        period: 4,
      },
      this.#secondsPerHour,
    );
  }

  /** The lights' fog signals, heard at the boat in fog. */
  readonly #fogInput: FogSignalsInput = {
    seconds: 0,
    listener: { east: 0, north: 0 },
    look: 0,
    lights: [],
    // A blast sounds while the visibility at its light, when it begins, is
    // under the rule's limit; with no weather, none does.
    poorAt: poorBy(FOG_SIGNAL_RULES.rule, (e, n, tick) => {
      const source = this.world.ocean.source;
      const physics = source?.weather === true ? source.physics : null;
      return physics === null ? Number.POSITIVE_INFINITY : physics.visibilityAtTick(e, n, tick);
    }),
  };

  #fogSignals(now: number, look: number): void {
    const w = this.world;
    const source = w.ocean.source;
    if (source?.weather !== true) {
      return;
    }
    const x = this.#fogInput;
    x.seconds = w.ticks / STEPS_PER_SECOND;
    x.listener.east = w.pose.east;
    x.listener.north = w.pose.north;
    x.look = look;
    x.lights = w.lighthouses.lights.values();
    this.sound.fogSignals(now, x);
  }

  /** The thunder after each flash, heard at the boat. */
  readonly #thunderInput: ThunderInput = {
    seconds: 0,
    listener: { east: 0, north: 0 },
    look: 0,
    flashes: [],
  };

  #thunder(now: number, look: number): void {
    const w = this.world;
    const x = this.#thunderInput;
    x.seconds = w.ticks / STEPS_PER_SECOND;
    x.listener.east = w.pose.east;
    x.listener.north = w.pose.north;
    x.look = look;
    x.flashes = w.lightning.flashes;
    this.sound.thunder(now, x);
  }
}

/** The features are listened for within this of the boat, m. */
const FEATURES_HEARD = 400;

/** How long the way back shows after a tap on the free camera's picture, ms. */
const BACK_SHOWN = 3000;

/** The free camera's keys, by their place on the keyboard: held down or let go. */
const FLY_KEYS: Record<string, keyof FlyKeys> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyQ: 'down',
  KeyE: 'up',
  ShiftLeft: 'fast',
  ShiftRight: 'fast',
};

/** Sets a free camera's key held or let go; returns whether it is one. */
function flyKey(keys: FlyKeys, code: string, down: boolean): boolean {
  const k = FLY_KEYS[code];
  if (k === undefined) {
    return false;
  }
  keys[k] = down;
  return true;
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
function bindCamera(surface: HTMLElement, world: SeaScene, flyingTap: () => void): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let spread = 0;
  // When two fingers last flew the free camera, ms, for its glide.
  let lastPan = -1;
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
    const free = world.freeCam;
    if (pointers.size === 1) {
      if (free.on) {
        free.look(dx, dy);
      } else {
        world.camera.drag(dx, dy, e.timeStamp);
      }
    } else if (pointers.size === 2) {
      const now = distance();
      if (spread > 0 && now > 0) {
        if (free.on) {
          free.pinch(spread / now);
          // Two fingers fly it: each moves the water half the way.
          const dt = lastPan < 0 ? 0 : (e.timeStamp - lastPan) / 1000;
          free.pan(dx / 2, dy / 2, dt);
          lastPan = e.timeStamp;
        } else {
          world.camera.zoom(spread / now, e.timeStamp);
        }
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
      if (world.freeCam.on) {
        flyingTap();
      } else {
        world.tap(tap.x - r.left, tap.y - r.top, performance.now());
      }
    }
    tap = null;
    pointers.delete(e.pointerId);
    spread = distance();
    lastPan = -1;
    world.camera.holding = pointers.size > 0;
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  surface.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (world.freeCam.on) {
        world.freeCam.wheel(e.deltaY);
      } else {
        world.camera.zoom(Math.exp(e.deltaY * 0.001), e.timeStamp);
      }
    },
    { passive: false },
  );
}

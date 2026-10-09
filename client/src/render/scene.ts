// SPDX-License-Identifier: AGPL-3.0-only

// The scene at sea: an open sea under a fair sky, the player's boat on it as
// the physics sails it, the other boats in view, the chase camera, and the
// beginners' overlays. Each
// drawn frame, whatever drives the boat (the game's tick) first sets the
// pose to draw, the latest step's Out and world time; the scene then
// follows the boat with the floating origin, the tile field and the camera,
// and draws it all at that time.

import { Vector3 } from 'three';
import { fog, rangeFogFactor } from 'three/tsl';
import { catalog } from '../catalog';
import type { Wind } from '../game/driver';
import type { DrawnBoat } from '../game/fleet';
import { Ocean, TEST_SEAS } from '../ocean/ocean';
import { type BoatPose, newPose } from '../predict/blend';
import { SIZES } from '../predict/layout.gen';
import { Boat } from './boat';
import { CAMERA_PRESETS, type CameraView, ChaseCamera } from './camera';
import { FloatingOrigin, type ScenePoint } from './coords';
import { FleetView } from './fleet';
import { domeCentre } from './materials';
import { Overlays } from './overlays';
import type { Backend, Gfx } from './renderer';
import { look, Sky, toLinear } from './sky';
import { Stage } from './stage';
import { Stats } from './stats';

export { CAMERA_PRESETS, type CameraView };

/** What draws the other boats: their poses this frame, drawn[0 … count). */
export interface FleetSource {
  readonly drawn: readonly DrawnBoat[];
  readonly count: number;
}

export class SeaScene {
  readonly stage: Stage;
  readonly origin = new FloatingOrigin();
  readonly ocean: Ocean;
  readonly sky: Sky;
  readonly stats = new Stats();
  readonly camera = new ChaseCamera();
  /** The catalog's first boat, the one a new sailor starts in. */
  readonly kind = catalog.boats[0];
  readonly overlays: Overlays;
  readonly boatScene: ScenePoint = { x: 0, y: 0, z: 0 };
  boat: Boat | null = null;
  /** The other boats, drawn many at once. */
  readonly fleet = new FleetView(this.kind);
  /** Where the other boats' poses come from: the game's fleet online, or a test's. */
  fleetSource: FleetSource | null = null;

  /** What to draw: the boat between its last two steps, the latest step's Out, the wind. */
  readonly pose: BoatPose = newPose();
  out: Float64Array = new Float64Array(SIZES.out);
  wind: Readonly<Wind> = { speed: 0, from: 0 };
  /** World time, seconds, and how much it moved since the last frame. */
  time = 0;
  timeStep = 0;

  /** The developer test sea: flat (the default), calm, breeze, fresh or gale. */
  testSea = 'flat';
  usePass = true;
  /** Called at the start of each drawn frame, with the real time since the last one (s) and now (ms). */
  tick: ((dt: number, now: number) => void) | null = null;
  /** Called after each frame is placed (the panel's statistics, the tests). */
  onFrame: (() => void) | null = null;

  readonly #target = new Vector3();
  readonly #v = new Vector3();

  constructor(container: HTMLElement, backend: Backend) {
    this.stage = new Stage(container, backend, {
      frame: (gfx, info) => this.#frame(gfx, info.dt, info.now),
      drawn: (gfx, work) => this.stats.drawn(gfx, work),
      attached: (gfx) => this.#attached(gfx),
    });
    const scene = this.stage.scene;
    this.sky = new Sky(scene);
    this.ocean = new Ocean(scene);
    this.overlays = new Overlays(this.kind);
    scene.add(this.overlays.world);
    scene.add(this.fleet.root);
    // Lit materials blend toward the horizon's colour with distance, as the sea does.
    scene.fogNode = fog(toLinear(look.skyHorizon), rangeFogFactor(look.hazeNear, look.hazeFar));
    this.setTestSea(this.testSea);
  }

  async start(): Promise<void> {
    await this.stage.start();
    this.placeCamera(CAMERA_PRESETS.chase as CameraView);
    await this.loadBoat();
  }

  /**
   * Loads the boat and its sailor. Its sail number and insignia are fixed
   * until boats can be customised; the sailor is the catalog's first.
   */
  async loadBoat(): Promise<void> {
    const boat = new Boat(this.kind);
    await boat.load('17', this.kind.name.slice(0, 1));
    const sailor = catalog.sailors[0];
    if (sailor !== undefined) {
      await Promise.all([boat.loadSailor(sailor.art.model), this.fleet.load(sailor.art)]);
    }
    boat.model.add(this.overlays.onBoat);
    this.boat = boat;
    this.stage.scene.add(boat.root);
  }

  setTestSea(name: string): void {
    this.testSea = name;
    this.ocean.setTestSea(TEST_SEAS[name] ?? null);
  }

  setUsePass(on: boolean): void {
    this.usePass = on;
    this.ocean.choose(on, this.stage.gfx?.floatTargets ?? true);
  }

  /** Puts the camera at a view behind the boat as it is now; the view becomes its resting one. */
  placeCamera(v: CameraView): void {
    this.camera.place(v, this.pose.heading);
    this.#updateBoatScene();
    this.#placeCamera();
  }

  #attached(gfx: Gfx): void {
    this.ocean.choose(this.usePass, gfx.floatTargets);
    this.boat?.attached(gfx);
  }

  #updateBoatScene(): void {
    const p = this.pose;
    this.origin.follow(p.east, p.north);
    this.origin.toScene(p.east, p.north, 0, this.boatScene);
  }

  #placeCamera(): void {
    const bs = this.boatScene;
    const camera = this.stage.camera;
    this.camera.place3(bs.x, bs.y, bs.z, camera.position, this.#target);
    camera.lookAt(this.#target);
    // The scene pass reads the camera's matrices before the render updates
    // them; without this the picture would lag the camera by a frame.
    camera.updateMatrixWorld();
  }

  #frame(gfx: Gfx, dt: number, now: number): void {
    this.stats.frame(now, gfx);
    this.tick?.(dt, now);
    this.#updateBoatScene();
    const bs = this.boatScene;
    domeCentre.value.set(bs.x, bs.z);

    this.camera.update(dt, this.pose.heading, now);
    this.#placeCamera();
    const camera = this.stage.camera;

    this.ocean.update(gfx.renderer, this.origin, this.time, camera.position.y);
    this.sky.follow(camera.position, this.#v.set(bs.x, bs.y, bs.z));
    this.boat?.draw(bs, this.pose, this.out, this.time, this.timeStep);
    const fs = this.fleetSource;
    if (this.fleet.loaded) {
      this.fleet.draw(
        fs?.drawn ?? [],
        fs?.count ?? 0,
        this.origin,
        camera.position,
        this.time,
        this.timeStep,
      );
    }
    const o = this.overlays;
    if (o.wind || o.forces) {
      o.update(bs.x, bs.z, this.pose, this.wind, this.out);
      // The overlays ride the boat: their world matrices must be current to place their labels.
      this.boat?.root.updateMatrixWorld();
      o.world.updateMatrixWorld();
      const size = gfx.canvas;
      o.placeLabels(camera, size.clientWidth, size.clientHeight);
    }
    this.onFrame?.();
  }
}

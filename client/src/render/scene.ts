// SPDX-License-Identifier: AGPL-3.0-only

// The scene of this stage of the game: an open sea under a fair sky, the
// Jolly boat placed on it, and an orbit camera for looking. Nothing is
// sailed yet. The boat can be moved along a straight line, to exercise the
// floating origin and the tile field.

import { Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fog, rangeFogFactor } from 'three/tsl';
import { catalog } from '../catalog';
import { Ocean, TEST_SEAS } from '../ocean/ocean';
import { Boat } from './boat';
import { FloatingOrigin, headingToRotationY, type ScenePoint } from './coords';
import { domeCentre } from './materials';
import type { Backend, Gfx } from './renderer';
import { look, Sky, toLinear } from './sky';
import { Stage } from './stage';
import { Stats } from './stats';

/** Camera views: azimuth and elevation in radians, distance in metres, around the boat. */
export interface CameraPreset {
  azimuth: number;
  elevation: number;
  distance: number;
}

/** The waves rendering's "Sea states" and "Two bands" views, for side-by-side comparison. */
export const CAMERA_PRESETS: Record<string, CameraPreset> = {
  sea: { azimuth: 2.15, elevation: 0.2, distance: 42 },
  bands: { azimuth: 2.3, elevation: 0.62, distance: 46 },
  aboard: { azimuth: 2.45, elevation: 0.24, distance: 21 },
  high: { azimuth: 2.3, elevation: 1.0, distance: 160 },
};

/** The camera looks at this point above the boat, in metres. */
const LOOK_HEIGHT = 1.8;

export interface BoatState {
  /** World position, metres east and north of the disk's centre. */
  east: number;
  north: number;
  /** Heading, clockwise from north, in radians. */
  heading: number;
  /** Speed along the heading, in m/s. */
  speed: number;
}

/** Moves a boat along its heading at its speed for dt seconds. */
export function advance(b: BoatState, dt: number): void {
  b.east += b.speed * dt * Math.sin(b.heading);
  b.north += b.speed * dt * Math.cos(b.heading);
}

export class SeaScene {
  readonly stage: Stage;
  readonly origin = new FloatingOrigin();
  readonly ocean: Ocean;
  readonly sky: Sky;
  readonly stats = new Stats();
  /** On a beam reach across the test sea's wind, from 240°. */
  readonly boatState: BoatState = { east: 0, north: 0, heading: (330 * Math.PI) / 180, speed: 0 };
  readonly boatScene: ScenePoint = { x: 0, y: 0, z: 0 };
  boat: Boat | null = null;
  controls: OrbitControls | null = null;
  /** The developer test sea: flat (the default), calm, breeze, fresh or gale. */
  testSea = 'flat';
  usePass = true;
  /** World time in seconds; held when frozen. */
  time = 0;
  frozen = false;
  /** Called after each frame (the panel's statistics). */
  onFrame: (() => void) | null = null;

  readonly #lookAt = new Vector3();
  readonly #prevBoat = new Vector3();
  readonly #v = new Vector3();

  constructor(container: HTMLElement, backend: Backend) {
    this.stage = new Stage(container, backend, {
      frame: (gfx, info) => this.#frame(gfx, info.dt, info.now),
      drawn: (gfx) => this.stats.drawn(gfx),
      attached: (gfx) => this.#attached(gfx),
    });
    const scene = this.stage.scene;
    this.sky = new Sky(scene);
    this.ocean = new Ocean(scene);
    // Lit materials blend toward the horizon's colour with distance, as the sea does.
    scene.fogNode = fog(toLinear(look.skyHorizon), rangeFogFactor(look.hazeNear, look.hazeFar));
    this.setTestSea(this.testSea);
  }

  async start(): Promise<void> {
    await this.stage.start();
    this.placeCamera(CAMERA_PRESETS.sea as CameraPreset);
    await this.loadBoat();
  }

  /**
   * Loads the catalog's first boat, the one a new sailor starts in. Its sail
   * number and insignia are fixed until boats can be customised.
   */
  async loadBoat(): Promise<void> {
    const kind = catalog.boats[0];
    const boat = new Boat();
    await boat.load(kind.art.model, '17', kind.name.slice(0, 1));
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

  /** Puts the boat at a world position; the origin and field follow on the next frame. */
  placeBoat(east: number, north: number): void {
    this.boatState.east = east;
    this.boatState.north = north;
  }

  /** Puts the camera at a preset's place around the boat. */
  placeCamera(p: CameraPreset): void {
    this.#updateBoatScene();
    const t = this.#lookAt.set(this.boatScene.x, this.boatScene.y + LOOK_HEIGHT, this.boatScene.z);
    const c = Math.cos(p.elevation);
    this.stage.camera.position
      .set(c * Math.cos(p.azimuth), Math.sin(p.elevation), c * Math.sin(p.azimuth))
      .multiplyScalar(p.distance)
      .add(t);
    this.stage.camera.lookAt(t);
    this.#prevBoat.set(this.boatScene.x, this.boatScene.y, this.boatScene.z);
    if (this.controls !== null) {
      this.controls.target.copy(t);
      this.controls.update();
    }
  }

  #attached(gfx: Gfx): void {
    this.ocean.choose(this.usePass, gfx.floatTargets);
    this.controls?.dispose();
    const controls = new OrbitControls(this.stage.camera, gfx.canvas);
    controls.enableDamping = true;
    controls.minDistance = 4;
    controls.maxDistance = 400;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.target.set(this.boatScene.x, this.boatScene.y + LOOK_HEIGHT, this.boatScene.z);
    controls.update();
    this.controls = controls;
    this.boat?.attached(gfx);
  }

  #updateBoatScene(): void {
    const b = this.boatState;
    this.origin.follow(b.east, b.north);
    this.origin.toScene(b.east, b.north, 0, this.boatScene);
  }

  #frame(gfx: Gfx, dt: number, now: number): void {
    this.stats.frame(now, gfx);
    if (!this.frozen) {
      this.time += dt;
      advance(this.boatState, dt);
    }
    this.#updateBoatScene();
    const bs = this.boatScene;
    domeCentre.value.set(bs.x, bs.z);

    // The camera keeps its place relative to the boat as the boat moves and
    // as the origin jumps.
    const camera = this.stage.camera;
    const d = this.#v.set(bs.x, bs.y, bs.z).sub(this.#prevBoat);
    camera.position.add(d);
    this.#prevBoat.set(bs.x, bs.y, bs.z);
    if (this.controls !== null) {
      this.controls.target.add(d);
      this.controls.update();
    }
    // The scene pass reads the camera's matrices before the render updates
    // them; without this the picture would lag the camera by a frame.
    camera.updateMatrixWorld();

    this.ocean.update(gfx.renderer, this.origin, this.time, camera.position.y);
    this.sky.follow(camera.position, this.#v.set(bs.x, bs.y, bs.z));
    this.boat?.place(bs, headingToRotationY(this.boatState.heading));
    this.onFrame?.();
  }
}

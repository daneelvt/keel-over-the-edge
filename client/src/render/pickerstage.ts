// SPDX-License-Identifier: AGPL-3.0-only

// The picker's stage: while a look is chosen, the game's renderer draws the
// sailor standing on a disc of deck planks with the sea behind, in a fixed
// morning light, in place of the sea (the scene's cover): in the screen's
// upper part held upright, its left held sideways, the panel beside it. The
// figure is the look's close level in its colours; it idles, and now and
// then goes through its look's habit, standing; under reduced motion it
// stands and breathes. A drag turns it; Front, Behind and Face move the
// camera. A look not loaded yet keeps the last figure until it is.

import {
  type AnimationAction,
  AnimationMixer,
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { SailorArt } from '../catalog';
import type { SailorLook } from './boat';
import { litMaterial } from './materials';
import { readSailorLight, sailorColours } from './sailors/material';
import { loadClips, loadSailor, type SailorModel } from './sailors/model';

/** The disc's top, and the camera's field of view. */
const DISC_TOP = 0.4;
const FOV = 30;
/** How tall a standing figure is drawn about, hat and all, m. */
const FIGURE = 1.95;
/** Seconds between habits, at the least. */
const HABIT_EVERY = 9;

/** Where the camera stands: before the figure, behind it, or at its face. */
export type StageView = 'front' | 'behind' | 'face';

interface Figure {
  model: SailorModel;
  mixer: AnimationMixer;
  idle: AnimationAction | null;
  habit: AnimationAction | null;
}

/** The URL of a sailor's file, which may load it when first wanted. */
export type StageFiles = (path: string) => Promise<string>;

export class PickerStage {
  /** Whether it is drawn in place of the sea. */
  open = false;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 600);
  view: StageView = 'front';
  /** The figure's turn from facing the camera, radians, as a drag leaves it. */
  yaw = 0;
  /** Told whether a figure is drawn: the picker shows the portrait till then. */
  onShown: (shown: boolean) => void = () => {};

  readonly #sun = new DirectionalLight(new Color(1, 0.93, 0.82), 2.4);
  readonly #sky = new HemisphereLight(
    new Color(0.78, 0.86, 0.94),
    new Color(0.12, 0.24, 0.28),
    1.1,
  );
  readonly #figures = new Map<SailorArt, Figure>();
  readonly #loading = new Set<SailorArt>();
  #shown: Figure | null = null;
  #wanted: SailorLook | null = null;
  #time = 0;
  #nextHabit = HABIT_EVERY;
  readonly #still: boolean;
  readonly #look = new Vector3();

  constructor(
    readonly files: StageFiles,
    readonly renderer: () => WebGPURenderer | null,
  ) {
    this.scene.background = new Color(0.74, 0.83, 0.9);
    const sea = new Mesh(
      new PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2),
      litMaterial({ color: 0x1d4e5c, roughness: 0.35, metalness: 0 }),
    );
    sea.name = 'stage sea';
    const disc = new Mesh(
      new CylinderGeometry(1.3, 1.3, 0.12, 48).translate(0, DISC_TOP - 0.06, 0),
      litMaterial({ color: 0x9a7650, roughness: 0.85, metalness: 0 }),
    );
    disc.name = 'stage disc';
    // The morning sun low over the figure's left shoulder.
    this.#sun.position.set(-4, 3, 6);
    this.scene.add(sea, disc, this.#sun, this.#sun.target, this.#sky);
    this.#still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Whether a figure is drawn. */
  get shown(): boolean {
    return this.#shown !== null;
  }

  /** Stands a sailor of a look on the stage: its art loaded the first time, its colours at once. */
  async setLook(look: SailorLook): Promise<void> {
    this.#wanted = look;
    const renderer = this.renderer();
    if (renderer === null) {
      return;
    }
    let f = this.#figures.get(look.art);
    if (f === undefined) {
      if (this.#loading.has(look.art)) {
        return;
      }
      this.#loading.add(look.art);
      try {
        f = await this.#load(look, renderer);
      } catch (e) {
        console.error('the picker’s sailor did not load', e);
        return;
      } finally {
        this.#loading.delete(look.art);
      }
      this.#figures.set(look.art, f);
    }
    const wanted = this.#wanted;
    if (wanted === null || wanted.art !== look.art) {
      if (wanted !== null && this.#figures.has(wanted.art)) {
        await this.setLook(wanted);
      }
      return;
    }
    const shared = (f.model.meshes[0]?.userData ?? {}) as Partial<ReturnType<typeof sailorColours>>;
    shared.main?.set(wanted.colours.main);
    shared.skin?.set(wanted.colours.skin);
    shared.hair?.set(wanted.colours.hair);
    if (this.#shown !== f) {
      if (this.#shown !== null) {
        this.scene.remove(this.#shown.model.root);
      }
      this.scene.add(f.model.root);
      this.#shown = f;
      this.onShown(true);
    }
  }

  async #load(look: SailorLook, renderer: WebGPURenderer): Promise<Figure> {
    const c = look.colours;
    const [model, clips] = await Promise.all([
      this.files(look.art.close).then((u) =>
        loadSailor(u, renderer, sailorColours(c.main, c.skin, c.hair), look.machine),
      ),
      this.files(look.art.clips).then((u) => loadClips(u, renderer)),
    ]);
    model.root.position.set(0, DISC_TOP, 0);
    const mixer = new AnimationMixer(model.root);
    const clip = (name: string) => clips.clips.find((a) => a.name === name) ?? null;
    const idleClip = clip('standing-idle');
    const habitClip = clip('habit-standing');
    const idle = idleClip === null ? null : mixer.clipAction(idleClip);
    idle?.play();
    const habit = habitClip === null ? null : mixer.clipAction(habitClip);
    if (habit !== null) {
      habit.clampWhenFinished = false;
      habit.repetitions = 1;
    }
    return { model, mixer, idle, habit };
  }

  /** Turns the figure by a drag of dx CSS pixels across a screen width wide. */
  turn(dx: number, width: number): void {
    this.yaw += (dx / Math.max(width, 1)) * Math.PI * 2;
  }

  /** Draws the stage: in place of the sea while open. */
  draw(renderer: WebGPURenderer | null, dt: number): void {
    if (renderer === null) {
      return;
    }
    this.#time += dt;
    const f = this.#shown;
    if (f !== null) {
      // Now and then the look's habit, standing; never under reduced motion.
      if (!this.#still && f.habit !== null && f.idle !== null && this.#time > this.#nextHabit) {
        this.#nextHabit = this.#time + HABIT_EVERY + f.habit.getClip().duration;
        f.habit.reset().play();
        f.idle.crossFadeTo(f.habit, 0.4, false);
        setTimeout(
          () => f.habit?.crossFadeTo(f.idle as AnimationAction, 0.4, false),
          Math.max(0, f.habit.getClip().duration - 0.4) * 1000,
        );
        f.idle.play();
      }
      f.mixer.update(this.#still ? Math.min(dt, 0.05) * 0.5 : dt);
      f.model.root.rotation.y = this.yaw;
    }
    this.#frame(renderer);
    readSailorLight(this.#sun, this.#sky);
    renderer.render(this.scene, this.camera);
  }

  /**
   * Frames the figure where the panel leaves room: in the upper part of a
   * screen held upright, the left part of one held sideways.
   */
  #frame(renderer: WebGPURenderer): void {
    const canvas = renderer.domElement;
    const w = Math.max(canvas.clientWidth, 1);
    const h = Math.max(canvas.clientHeight, 1);
    const upright = h >= w;
    const cam = this.camera;
    cam.aspect = w / h;
    const face = this.view === 'face';
    // The share of the screen's height the figure fills, and where its
    // middle is drawn, as shares of the width and height from the top left.
    const fill = face ? 1 : upright ? 0.36 : 0.78;
    const [cx, cy] = upright ? [0.5, 0.24] : [0.22, 0.5];
    const height = face ? 0.42 : FIGURE;
    const distance = height / fill / (2 * Math.tan(((FOV / 2) * Math.PI) / 180));
    const targetY = face ? DISC_TOP + 1.58 : DISC_TOP + FIGURE / 2;
    const azimuth = this.view === 'behind' ? Math.PI : face ? 0.3 : 0.35;
    this.#look.set(0, targetY, 0);
    cam.position.set(
      distance * Math.sin(azimuth),
      targetY + (face ? 0.02 : 0.25),
      distance * Math.cos(azimuth),
    );
    cam.lookAt(this.#look);
    cam.setViewOffset(w, h, (0.5 - cx) * w, (0.5 - cy) * h, w, h);
    cam.updateProjectionMatrix();
  }
}

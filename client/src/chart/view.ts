// SPDX-License-Identifier: AGPL-3.0-only

// The chart: a miniature of the whole disk seen from above and to one side,
// as the period's charts were engraved, each charted island a small model
// of itself standing on the paper, its heights several times its own, so
// the eye reads its hills. It is a scene of its own, drawn by the game's
// renderer instead of the sea's while it covers the screen: the boat sails
// on, the sea is not drawn. It is drawn at most at the look's frames a
// second, and only while something moves: the camera, the boat, the wind's
// streaks (still, for a reader who asks for less motion), or the chart.
//
// The names are the page's own elements, laid over the picture where the
// camera puts each, lettered as charts letter them (IHO S-4, B-133): land's
// upright, water's sloping; where they crowd, the more worthy keeps its
// place. The lights carry their characters beside their stars, as a chart
// prints them.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { ChartEntry } from '../net/messages';
import { chartMaterial } from '../render/materials';
import type { IslandModel, Models } from './model';
import { PAPER_MARGIN, type PaperLook, paintPaper } from './paper';
import { type ChartStore, keyOf } from './store';
import type { ChartWeather } from './weatherlayer';

/** What the chart is drawn with, from the catalog. */
export interface ChartLook extends PaperLook {
  boat: string;
  light: string;
  /** Heights are drawn this many times their own. */
  heights: number;
  /** The most frames a second. */
  fps: number;
  /** The wind's grid: points a side. */
  wind: number;
  /** The wind's streaks: how many, how wide, CSS pixels, and under what mean wind they fade, m/s. */
  streaks: { count: number; width: number; fade: number };
  /** Each surface's top and side colours, by its index. */
  tops: readonly string[];
  sides: readonly string[];
  /** The lights' characters' notations, by index. */
  characters: readonly string[];
  /** The kinds of place: whether each is water, lettered sloping, its mark, and whether it is news of its own (a port, a light, a wreck). */
  places: readonly { water: boolean; mark: string; news: boolean }[];
  /** A great discovery's worth, and a middling island's, lettered from further off than the rest. */
  great: number;
  middling: number;
  /** The kinds of feature's marks. */
  features: readonly string[];
}

/** Where the boat is and which way it heads: metres, radians clockwise from north. */
export interface BoatAt {
  east: number;
  north: number;
  heading: number;
}

/** The mean wind at points, as the physics samples it: speed (m/s) and the way it comes from (rad). */
export type WindSampler = (
  points: Float64Array,
  speeds: Float64Array,
  froms: Float64Array,
) => boolean;

/** The colour of the table the chart lies on. */
const TABLE = '#22303a';

/** The paper's canvas, pixels a side. */
const PAPER_PIXELS = 2048;
/** How long each of the wind's streaks lives, s. */
const STREAK_LIFE = 6;
/** The camera's elevation above the paper, rad: from above and to one side. */
const TILT = 0.95;
/** The nearest and furthest the camera goes from what it looks at, m. */
const NEAREST = 900;
const FURTHEST = 30000;

/** A label on the chart: its element and what it names. */
interface Label {
  el: HTMLElement;
  entry: ChartEntry;
  /** Its anchor's height above the paper, m. */
  y: number;
  width: number;
  /** How far in the chart must be for it to be lettered: 3 always, 0 only close in. */
  rank: number;
}

/**
 * The least rank lettered from a camera this far off, m: as a chart of a
 * smaller scale names less, the whole disk names its great islands alone,
 * and nearer in the rest come, the coves and reefs last.
 */
export function rankShown(distance: number): number {
  if (distance > 14000) {
    return 3;
  }
  if (distance > 7000) {
    return 2;
  }
  return distance > 3500 ? 1 : 0;
}

/** Within this, m, the lights' characters are printed beside their stars. */
const CHARACTERS_WITHIN = 5000;

/** Room kept about each name, CSS pixels. */
const LABEL_ROOM = 10;

export class ChartView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 50, 120000);
  /** Whether it covers the screen. */
  open = false;
  /** Told when an entry is tapped: the box opens. */
  onPick: ((e: ChartEntry) => void) | null = null;
  /** The reader asks for less motion: the wind's streaks stand still. */
  reducedMotion = false;
  /** Whether the wind's streaks are switched on. */
  streaksOn: () => boolean = () => true;
  /** How many times it was drawn (the tests). */
  draws = 0;

  readonly #store: ChartStore;
  readonly #models: Models;
  readonly #look: ChartLook;
  readonly #boatAt: () => BoatAt;
  readonly #wind: WindSampler | null;
  readonly #paperCanvas: HTMLCanvasElement;
  readonly #paper: CanvasTexture;
  readonly #land = new Mesh(new BufferGeometry(), chartMaterial({ vertexColors: true }));
  readonly #towers = new Mesh(new BufferGeometry(), chartMaterial({ vertexColors: true }));
  readonly #boat: Mesh;
  readonly #streaks: Mesh;
  /** The weather's canvas over the paper, and its texture; null without. */
  #weather: ChartWeather | null = null;
  #weatherTexture: CanvasTexture | null = null;
  readonly #streakXY: Float32Array; // x, y, age, life
  /** The streaks' half width when last laid, m: they are laid again when the camera moves in or out. */
  #streakHalf = 0;
  readonly #windGrid: {
    speeds: Float64Array;
    froms: Float64Array;
    points: Float64Array;
    at: number;
    have: boolean;
  };
  #labelLayer: HTMLElement | null = null;
  readonly #labels = new Map<string, Label>();
  readonly #loaded = new Map<string, IslandModel>();
  /** The models asked for and not yet had. */
  readonly #asked = new Set<string>();
  #built = -1;
  #buildWanted = true;
  #dirty = true;
  #last = Number.NEGATIVE_INFINITY;
  #version = -1;
  #generation = -1;
  // The camera: what it looks at, how far, and its bearing.
  #target = new Vector2();
  #distance = FURTHEST * 0.7;
  #bearing = 0;
  #width = 1;
  #height = 1;
  readonly #v = new Vector3();
  readonly #ray = new Raycaster();

  constructor(
    store: ChartStore,
    models: Models,
    look: ChartLook,
    boatAt: () => BoatAt,
    wind: WindSampler | null,
  ) {
    this.#store = store;
    this.#models = models;
    this.#look = look;
    this.#boatAt = boatAt;
    this.#wind = wind;
    const extent = look.lip * PAPER_MARGIN;
    this.#paperCanvas = document.createElement('canvas');
    this.#paperCanvas.width = this.#paperCanvas.height = PAPER_PIXELS;
    this.#paper = new CanvasTexture(this.#paperCanvas);
    this.#paper.colorSpace = SRGBColorSpace;
    const paper = new Mesh(
      new PlaneGeometry(2 * extent, 2 * extent),
      chartMaterial({ map: this.#paper }),
    );
    paper.name = 'paper';
    paper.rotation.x = -Math.PI / 2;
    this.#land.name = 'islands';
    this.#towers.name = 'lighthouses';
    this.#boat = this.#makeBoat();
    this.#streakXY = new Float32Array(look.streaks.count * 4);
    this.#streaks = this.#makeStreaks();
    const falls = this.#makeFalls();
    this.scene.add(paper, this.#land, this.#towers, this.#boat, this.#streaks, falls);
    // The table the chart lies on.
    this.scene.background = new Color(TABLE);
    const n = look.wind;
    this.#windGrid = {
      speeds: new Float64Array(n * n),
      froms: new Float64Array(n * n),
      points: new Float64Array(2 * n * n),
      at: Number.NEGATIVE_INFINITY,
      have: false,
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        this.#windGrid.points[2 * (j * n + i)] = ((i + 0.5) / n - 0.5) * 2 * look.lip;
        this.#windGrid.points[2 * (j * n + i) + 1] = ((j + 0.5) / n - 0.5) * 2 * look.lip;
      }
    }
    for (let s = 0; s < look.streaks.count; s++) {
      this.#respawn(s, Math.random() * STREAK_LIFE);
    }
    store.version.subscribe(() => {
      this.#dirty = true;
      this.#buildWanted = true;
    });
  }

  /**
   * Lays the weather's canvas over the paper, just above it, under the
   * islands' models: it is painted at the slider's moment and sent to the
   * GPU only when it is painted afresh.
   */
  attachWeather(weather: ChartWeather): void {
    this.#weather = weather;
    const extent = this.#look.lip * PAPER_MARGIN;
    this.#weatherTexture = new CanvasTexture(weather.canvas);
    this.#weatherTexture.colorSpace = SRGBColorSpace;
    const plane = new Mesh(
      new PlaneGeometry(2 * extent, 2 * extent),
      chartMaterial({ map: this.#weatherTexture, transparent: true, depthWrite: false }),
    );
    plane.name = 'weather';
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 2;
    plane.renderOrder = 1;
    this.scene.add(plane);
    this.#dirty = true;
  }

  /** The chart's weather, or null without. */
  get weather(): ChartWeather | null {
    return this.#weather;
  }

  /** Paints the weather again at the next frame, whatever has changed. */
  weatherChanged(): void {
    this.#weather?.invalidate();
    this.#dirty = true;
  }

  /** Puts the chart's labels in a layer over the picture. */
  attachLabels(layer: HTMLElement | null): void {
    this.#labelLayer = layer;
    for (const l of this.#labels.values()) {
      l.el.remove();
    }
    this.#labels.clear();
    this.#dirty = true;
  }

  /** Opens or closes it; opened, it looks at the boat. */
  show(open: boolean): void {
    if (open && !this.open) {
      const b = this.#boatAt();
      this.lookAt(b.east, b.north, 9000);
    }
    this.open = open;
    this.#dirty = true;
  }

  /** Looks at (east, north) from distance m. */
  lookAt(east: number, north: number, distance = this.#distance): void {
    this.#target.set(east, north);
    this.#distance = Math.min(Math.max(distance, NEAREST), FURTHEST);
    this.#dirty = true;
  }

  /** The whole disk in view. */
  fit(): void {
    this.lookAt(0, -this.#look.lip * 0.1, this.#look.lip * 3.4);
  }

  /** Turns the chart by a drag of (dx, dy) pixels: across turns it, along moves it. */
  drag(dx: number, dy: number): void {
    const k = (this.#distance * 1.2) / Math.max(this.#height, 1);
    const s = Math.sin(this.#bearing);
    const c = Math.cos(this.#bearing);
    // Moves what it looks at, as a map is pushed under the finger: right
    // is (cos, −sin) of the bearing, ahead (sin, cos).
    this.#target.x += (-dx * c + dy * s) * k;
    this.#target.y += (dx * s + dy * c) * k;
    const lip = this.#look.lip;
    if (this.#target.length() > lip) {
      this.#target.setLength(lip);
    }
    this.#dirty = true;
  }

  /** Turns it about what it looks at, rad. */
  turn(rad: number): void {
    this.#bearing += rad;
    this.#dirty = true;
  }

  /** Zooms by a factor: under 1 nearer. */
  zoom(f: number): void {
    this.#distance = Math.min(Math.max(this.#distance * f, NEAREST), FURTHEST);
    this.#dirty = true;
  }

  /** The entry nearest a tap at (x, y) CSS pixels, within a hand's breadth of it. */
  pick(x: number, y: number): ChartEntry | null {
    const ndc = new Vector2((x / this.#width) * 2 - 1, -(y / this.#height) * 2 + 1);
    this.#ray.setFromCamera(ndc, this.camera);
    const o = this.#ray.ray.origin;
    const d = this.#ray.ray.direction;
    if (d.y >= 0) {
      return null;
    }
    const t = -o.y / d.y;
    const east = o.x + d.x * t;
    const north = -(o.z + d.z * t);
    let best: ChartEntry | null = null;
    let bestD = this.#distance * 0.04;
    for (const e of this.#store.entries) {
      const dd = Math.hypot(e.east - east, e.north - north);
      if (dd < bestD) {
        best = e;
        bestD = dd;
      }
    }
    return best;
  }

  /** How many islands' models it has. */
  get modelsHad(): number {
    return this.#loaded.size;
  }

  /** Where (east, north) lies on the screen, h m above the paper, CSS pixels; null off it. */
  screenOf(east: number, north: number, h = 0): { x: number; y: number } | null {
    this.#placeCamera();
    this.#v.set(east, h * this.#look.heights, -north).project(this.camera);
    if (this.#v.z >= 1) {
      return null;
    }
    return { x: (this.#v.x * 0.5 + 0.5) * this.#width, y: (-this.#v.y * 0.5 + 0.5) * this.#height };
  }

  /** Draws the chart, if it is due and something has changed. */
  draw(renderer: WebGPURenderer, dt: number, now: number): void {
    const canvas = renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (w !== this.#width || h !== this.#height) {
      this.#width = w;
      this.#height = h;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.#dirty = true;
    }
    if (now - this.#last < 1000 / this.#look.fps - 2) {
      return;
    }
    const step = Math.min((now - this.#last) / 1000, 0.25);
    this.#last = now;
    this.#update(now, Number.isFinite(step) ? step : dt);
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;
    this.#placeCamera();
    renderer.render(this.scene, this.camera);
    this.draws++;
    this.#placeLabels();
  }

  /** Brings what moves to now: the models had, the boat, the wind. */
  #update(now: number, dt: number): void {
    const store = this.#store;
    if (store.generation !== this.#generation) {
      // The chart had whole again: what was drawn of the last goes.
      this.#generation = store.generation;
      for (const l of this.#labels.values()) {
        l.el.remove();
      }
      this.#labels.clear();
      this.#loaded.clear();
      this.#asked.clear();
      this.#built = -1;
      this.#buildWanted = true;
    }
    if (store.version.value !== this.#version) {
      this.#version = store.version.value;
      this.#fetchModels();
    }
    if (this.#buildWanted) {
      this.#buildWanted = false;
      this.#build();
    }
    const b = this.#boatAt();
    const p = this.#boat.position;
    if (
      Math.abs(p.x - b.east) > 1 ||
      Math.abs(p.z + b.north) > 1 ||
      Math.abs(this.#boat.rotation.y + b.heading) > 0.01
    ) {
      p.set(b.east, 0, -b.north);
      this.#boat.rotation.y = -b.heading;
      this.#dirty = true;
    }
    this.#boat.scale.setScalar(Math.max(this.#distance / 9000, 0.25));
    if (this.open && this.#weather?.update(now)) {
      if (this.#weatherTexture !== null) {
        this.#weatherTexture.needsUpdate = true;
      }
      // The streaks follow the weather's moment at once.
      this.#windGrid.at = Number.NEGATIVE_INFINITY;
      this.#dirty = true;
    }
    if (this.#wind !== null && now - this.#windGrid.at > 1000) {
      const g = this.#windGrid;
      g.at = now;
      g.have = this.#wind(g.points, g.speeds, g.froms);
    }
    const streaks = this.#windGrid.have && this.streaksOn();
    // Still for a reader who asks for less motion, but laid again at the
    // camera's new distance, so they stay as wide on the screen.
    if (streaks && (!this.reducedMotion || this.#streakWidth() !== this.#streakHalf)) {
      this.#moveStreaks(this.reducedMotion ? 0 : dt);
      this.#dirty = true;
    }
    if (this.#streaks.visible !== streaks) {
      this.#streaks.visible = streaks;
      this.#dirty = true;
    }
  }

  #placeCamera(): void {
    const t = this.#target;
    const d = this.#distance;
    const up = Math.sin(TILT) * d;
    const back = Math.cos(TILT) * d;
    const s = Math.sin(this.#bearing);
    const c = Math.cos(this.#bearing);
    this.camera.position.set(t.x - s * back, up, -(t.y - c * back));
    this.camera.lookAt(t.x, 0, -t.y);
    this.camera.updateMatrixWorld();
  }

  /** Asks for each charted island's model. */
  #fetchModels(): void {
    for (const e of this.#store.entries) {
      if (
        e.subject !== 'island' ||
        e.model === '' ||
        this.#loaded.has(e.model) ||
        this.#asked.has(e.model)
      ) {
        continue;
      }
      const address = e.model;
      this.#asked.add(address);
      void this.#models.get(address).then((m) => {
        this.#asked.delete(address);
        // Kept only while the chart still has it: not another world's.
        const still = this.#store.entries.some((o) => o.model === address);
        if (m !== null && still) {
          this.#loaded.set(address, m);
        }
        // Built once every model asked for has come, not once a model: the
        // paper is painted again and sent to the GPU each time.
        if (this.#asked.size === 0) {
          this.#buildWanted = true;
          this.#dirty = true;
        }
      });
    }
  }

  /** Builds the islands' columns, the towers and the paper's coasts from what is had. */
  #build(): void {
    const models = [...this.#loaded.values()];
    if (models.length !== this.#built) {
      this.#built = models.length;
      this.#land.geometry.dispose();
      this.#land.geometry = columns(models, this.#look);
      paintPaper(this.#paperCanvas, this.#look, models, this.#look.tops);
      this.#paper.needsUpdate = true;
    }
    this.#towers.geometry.dispose();
    this.#towers.geometry = towers(this.#store.entries, this.#look);
    this.#dirty = true;
  }

  #makeBoat(): Mesh {
    const g = new ConeGeometry(70, 260, 12);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 120, -60);
    const head = new SphereGeometry(55, 12, 8);
    head.translate(0, 120, 70);
    const merged = mergeGeometries([g, head]);
    const m = new Mesh(merged, chartMaterial({ color: this.#look.boat }));
    m.name = 'boat';
    return m;
  }

  #makeFalls(): Mesh {
    const lip = this.#look.lip;
    const g = new CylinderGeometry(lip, lip * 1.01, 700, 128, 1, true);
    g.translate(0, -350, 0);
    const colours = new Float32Array(
      g.attributes.position?.count ? g.attributes.position.count * 4 : 0,
    );
    const pos = g.attributes.position as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const top = pos.getY(i) > -1;
      colours.set(top ? [0.93, 0.95, 0.96, 0.9] : [0.6, 0.65, 0.68, 0], i * 4);
    }
    g.setAttribute('color', new BufferAttribute(colours, 4));
    const m = new Mesh(
      g,
      chartMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthWrite: false }),
    );
    m.name = 'falls';
    return m;
  }

  /**
   * The streaks: a quad each, a corner either side of each end, as a line
   * of WebGL's is one pixel wide whatever is asked.
   */
  #makeStreaks(): Mesh {
    const n = this.#look.streaks.count;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 12), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 16), 4));
    const index = new Uint32Array(n * 6);
    for (let s = 0; s < n; s++) {
      index.set(
        [0, 1, 2, 2, 1, 3].map((i) => 4 * s + i),
        6 * s,
      );
    }
    g.setIndex(new BufferAttribute(index, 1));
    const m = new Mesh(
      g,
      chartMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthWrite: false }),
    );
    m.name = 'wind';
    m.frustumCulled = false;
    return m;
  }

  /** Half a streak's width on the paper, m, at the camera's distance: its pixels' worth at what it looks at. */
  #streakWidth(): number {
    const metres =
      (2 * this.#distance * Math.tan((this.camera.fov * Math.PI) / 360)) / this.#height;
    // Rounded, so a still camera lays them once.
    return Math.round(((this.#look.streaks.width / 2) * metres) / 0.5) * 0.5;
  }

  #respawn(s: number, age = 0): void {
    const lip = this.#look.lip;
    const r = lip * Math.sqrt(Math.random());
    const a = Math.random() * 2 * Math.PI;
    this.#streakXY.set(
      [r * Math.sin(a), r * Math.cos(a), age, STREAK_LIFE * (0.6 + 0.8 * Math.random())],
      s * 4,
    );
  }

  /** The mean wind at (east, north), from the grid: speed and the way it blows to. */
  #windAt(east: number, north: number): [number, number, number] {
    const g = this.#windGrid;
    const n = this.#look.wind;
    const i = Math.min(Math.max(Math.floor((east / (2 * this.#look.lip) + 0.5) * n), 0), n - 1);
    const j = Math.min(Math.max(Math.floor((north / (2 * this.#look.lip) + 0.5) * n), 0), n - 1);
    const k = j * n + i;
    const speed = g.speeds[k] ?? 0;
    const from = g.froms[k] ?? 0;
    return [speed, -Math.sin(from), -Math.cos(from)];
  }

  /** Drifts the streaks down the wind, longer and faster where it is stronger. */
  #moveStreaks(dt: number): void {
    const xy = this.#streakXY;
    const pos = this.#streaks.geometry.attributes.position as BufferAttribute;
    const col = this.#streaks.geometry.attributes.color as BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;
    const lip = this.#look.lip;
    const { count, fade } = this.#look.streaks;
    // The paper's ink, in full, as the paper's own colour space has it.
    const ink = new Color(this.#look.ink);
    const half = this.#streakWidth();
    this.#streakHalf = half;
    for (let s = 0; s < count; s++) {
      let x = xy[s * 4] ?? 0;
      let y = xy[s * 4 + 1] ?? 0;
      const age = (xy[s * 4 + 2] ?? 0) + dt;
      const life = xy[s * 4 + 3] ?? 1;
      if (age > life || x * x + y * y > lip * lip) {
        this.#respawn(s);
        continue;
      }
      const [speed, ux, uy] = this.#windAt(x, y);
      // A chart's streaks move far faster than the wind: 60 s of its drift a second.
      const v = speed * 60;
      x += ux * v * dt;
      y += uy * v * dt;
      xy[s * 4] = x;
      xy[s * 4 + 1] = y;
      xy[s * 4 + 2] = age;
      const len = 40 + speed * 28;
      // Its tail and head, each a corner either side of the way it blows.
      const wx = -uy * half;
      const wy = ux * half;
      const tx = x - ux * len;
      const ty = y - uy * len;
      pa.set(
        [
          tx + wx,
          4,
          -(ty + wy),
          tx - wx,
          4,
          -(ty - wy),
          x + wx,
          4,
          -(y + wy),
          x - wx,
          4,
          -(y - wy),
        ],
        s * 12,
      );
      // Faded in and out over its life, and in a wind too light to read.
      const alpha =
        Math.min(1, Math.sin((Math.PI * age) / life)) * Math.min(1, fade > 0 ? speed / fade : 1);
      const { r, g, b } = ink;
      ca.set([r, g, b, 0, r, g, b, 0, r, g, b, alpha, r, g, b, alpha], s * 16);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** Lays the labels over the picture, the worthier first where they crowd. */
  #placeLabels(): void {
    const layer = this.#labelLayer;
    if (layer === null) {
      return;
    }
    const store = this.#store;
    for (const e of store.entries) {
      const k = keyOf(e.subject, e.number);
      if (!this.#labels.has(k)) {
        this.#labels.set(k, this.#makeLabel(e, layer));
      }
    }
    const sorted = [...this.#labels.values()].sort(
      (a, b) => b.rank - a.rank || b.entry.worth - a.entry.worth,
    );
    const kept: [number, number, number, number][] = [];
    const scale = this.#look.heights;
    const least = rankShown(this.#distance);
    layer.classList.toggle('chart-close', this.#distance < CHARACTERS_WITHIN);
    for (const l of sorted) {
      const e = l.entry;
      if (l.rank < least) {
        l.el.hidden = true;
        continue;
      }
      this.#v.set(e.east, l.y * scale, -e.north).project(this.camera);
      const x = (this.#v.x * 0.5 + 0.5) * this.#width;
      const y = (-this.#v.y * 0.5 + 0.5) * this.#height;
      const on =
        this.#v.z < 1 && x > -40 && x < this.#width + 40 && y > -20 && y < this.#height + 20;
      const box: [number, number, number, number] = [
        x - l.width / 2 - LABEL_ROOM,
        y - 18 - LABEL_ROOM / 2,
        x + l.width / 2 + LABEL_ROOM,
        y + 2 + LABEL_ROOM / 2,
      ];
      const free =
        on && !kept.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]);
      if (free) {
        kept.push(box);
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      }
      l.el.hidden = !free;
      if (free && l.el.offsetWidth > 0) {
        // Its width as drawn, for the next placing.
        l.width = l.el.offsetWidth;
      }
    }
  }

  #makeLabel(e: ChartEntry, layer: HTMLElement): Label {
    const look = this.#look;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `chart-label chart-${e.subject}`;
    const store = this.#store;
    let mark = '';
    let water = false;
    let y = 0;
    if (e.subject === 'place') {
      const kind = look.places[e.sort];
      mark = kind?.mark ?? '';
      water = kind?.water === true;
      y = e.light >= 0 ? e.focal : 0;
    } else if (e.subject === 'feature') {
      mark = look.features[e.sort] ?? '';
    } else {
      y = e.highest;
      el.classList.add(e.worth >= 20 ? 'chart-great' : 'chart-isle');
    }
    if (water) {
      el.classList.add('chart-water');
    }
    const name = document.createElement('span');
    name.className = 'chart-name';
    name.textContent = e.subject === 'feature' ? '' : store.title(e);
    if (mark !== '') {
      const m = document.createElement('span');
      m.className = 'chart-mark';
      m.textContent = mark;
      m.setAttribute('aria-hidden', 'true');
      el.append(m);
    }
    el.append(name);
    if (e.light >= 0) {
      const ch = document.createElement('span');
      ch.className = 'chart-character';
      ch.textContent = `✶ ${look.characters[e.character] ?? ''} ${Math.round(e.focal)}m ${(e.range / 1852).toFixed(1)}M`;
      el.append(ch);
    }
    el.setAttribute('aria-label', store.title(e));
    el.addEventListener('click', () => this.onPick?.(e));
    el.hidden = true;
    layer.append(el);
    // Until it is drawn, its width by its letters.
    const width = Math.max(store.title(e).length * (e.worth >= look.great ? 11 : 7.5), 16);
    return { el, entry: e, y, width, rank: this.#rank(e) };
  }

  /** How far in a name is lettered: the main port's and the great islands' always. */
  #rank(e: ChartEntry): number {
    const look = this.#look;
    if (e.subject === 'island') {
      if (e.number === 0) {
        // The main port's island, lettered before all: the chart's middle.
        return 4;
      }
      if (e.worth >= look.great) {
        return 3;
      }
      return e.worth >= look.middling ? 2 : 1;
    }
    if (e.subject === 'feature') {
      return 0;
    }
    const kind = look.places[e.sort];
    if (kind?.water === true) {
      return 0;
    }
    return kind?.news === true ? 2 : 1;
  }

  /** How many draw calls and triangles the chart's scene takes, roughly: its meshes and their faces. */
  size(): { meshes: number; triangles: number } {
    let meshes = 0;
    let triangles = 0;
    this.scene.traverse((o) => {
      const g = (o as Mesh).geometry as BufferGeometry | undefined;
      if (g === undefined) {
        return;
      }
      meshes++;
      const n = g.index !== null ? g.index.count : (g.attributes.position?.count ?? 0);
      triangles += n / 3;
    });
    return { meshes, triangles };
  }
}

/** A colour #rrggbb as linear-free floats, as the chart's vertices take them. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The islands' columns: each land cell of each model a box standing from
 * the paper to its height, times the look's, its top in its surface's
 * colour, its sides in the side's, shaded by the way they face; a side
 * shared with a cell as high or higher is left out.
 */
export function columns(models: readonly IslandModel[], look: ChartLook): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    colour: [number, number, number],
    shade: number,
  ) => {
    for (const p of [a, b, c, a, c, d]) {
      pos.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
      col.push(colour[0] * shade, colour[1] * shade, colour[2] * shade);
    }
  };
  for (const m of models) {
    const at = (c: number, r: number) =>
      c < 0 || r < 0 || c >= m.columns || r >= m.rows ? 0 : (m.heights[r * m.columns + c] ?? 0);
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.columns; c++) {
        const hm = at(c, r);
        if (hm === 0) {
          continue;
        }
        const s = m.surfaces[r * m.columns + c] ?? 0;
        const top = rgb(look.tops[s] ?? '#a09070');
        const side = rgb(look.sides[s] ?? '#806040');
        const h = hm * look.heights;
        const x0 = m.x + c * m.dx - m.dx / 2;
        const x1 = x0 + m.dx;
        const n0 = m.y + r * m.dy - m.dy / 2;
        const n1 = n0 + m.dy;
        // Scene z is south.
        const z0 = -n0;
        const z1 = -n1;
        quad([x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1], top, 1);
        const sides: [number, number, number[], number[], number][] = [
          [c, r - 1, [x1, 0, z0], [x0, 0, z0], 0.7], // south
          [c, r + 1, [x0, 0, z1], [x1, 0, z1], 0.95], // north
          [c - 1, r, [x0, 0, z0], [x0, 0, z1], 0.8], // west
          [c + 1, r, [x1, 0, z1], [x1, 0, z0], 0.85], // east
        ];
        for (const [nc, nr, a, b, shade] of sides) {
          const nh = at(nc, nr) * look.heights;
          if (nh >= h) {
            continue;
          }
          const ax = a[0] ?? 0;
          const az = a[2] ?? 0;
          const bx = b[0] ?? 0;
          const bz = b[2] ?? 0;
          quad([ax, nh, az], [bx, nh, bz], [bx, h, bz], [ax, h, az], side, shade);
        }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}

/** The charted lighthouses' towers: white columns banded, to their lights' heights times the look's. */
export function towers(entries: readonly ChartEntry[], look: ChartLook): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const e of entries) {
    if (e.light < 0) {
      continue;
    }
    const h = Math.max(e.focal, 8) * look.heights;
    const g = new CylinderGeometry(16, 24, h, 8, 1);
    g.translate(e.east, h / 2, -e.north);
    const n = g.attributes.position?.count ?? 0;
    const colours = new Float32Array(n * 3);
    const [r, gg, b] = rgb(look.light);
    for (let i = 0; i < n; i++) {
      const top = (g.attributes.position as BufferAttribute).getY(i) > h * 0.9;
      colours.set(top ? [r, gg, b] : [0.93, 0.91, 0.86], i * 3);
    }
    g.setAttribute('color', new BufferAttribute(colours, 3));
    parts.push(g.toNonIndexed());
  }
  return parts.length === 0 ? new BufferGeometry() : mergeGeometries(parts);
}

/** Merges non-indexed geometries' positions, and colours where they have them, into one. */
function mergeGeometries(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((p) => (p.index !== null ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of flat) {
    n += p.attributes.position?.count ?? 0;
  }
  const pos = new Float32Array(n * 3);
  const withColour = flat.every((p) => p.attributes.color !== undefined);
  const col = withColour ? new Float32Array(n * 3) : null;
  let at = 0;
  for (const p of flat) {
    const a = p.attributes.position as BufferAttribute;
    pos.set(a.array as Float32Array, at * 3);
    if (col !== null) {
      const c = p.attributes.color as BufferAttribute;
      col.set((c.array as Float32Array).subarray(0, a.count * 3), at * 3);
    }
    at += a.count;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  if (col !== null) {
    g.setAttribute('color', new BufferAttribute(col, 3));
  }
  return g;
}

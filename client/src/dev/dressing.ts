// SPDX-License-Identifier: AGPL-3.0-only

// The dressing room (sailors.html, reached as dev.html#sailors): the
// sailors the Blender build makes (art/sailors/<look>/), drawn by the game's
// renderer with the game's sky, light, fog and material factory, as the
// game will draw them; a page of its own, never part of the game's.
//
// Views:
//   lineup  every look and version in a row on a quay, from the front or
//           behind; a clip placed in the boat seats them each in a dinghy
//           moored before it
//   face    one sailor's head close (who= the sailor's place in the row)
//   deck    a fleet of dinghies at the game's chase camera, each sailor at
//           the helm: the own boat's and the near ones' at the deck level,
//           the far ones' at the far level
//   picker  a sailor on a disc of deck planks, in the screen's upper half
//
// Everything is in the hash, so a view can be linked to and a test can ask
// for it: view, light (noon, dusk, night, morning), level (close, deck,
// far), clip (one of the look's, or rest), side (front, back), main, skin
// and hair (#RRGGBB without the #), black (the silhouettes in black), mask
// (the mask in place of the colours: red main, green skin, blue hair), phone
// (the stage at a phone's 360 × 640), t (the clips held at that many
// seconds, for pictures), who, look (only that look's versions). The back
// end is the game's choice, and
// ?backend=webgl2 or ?compat as in the game.
//
// Drag turns the camera about what it looks at, the wheel or a pinch sets
// its distance.

import './dressing.css';
import {
  type AnimationAction,
  AnimationMixer,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Vector2,
  Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { exp, float, fog, length, positionView, texture } from 'three/tsl';
import { catalog } from '../catalog';
import { newPose } from '../predict/blend';
import { SIZES } from '../predict/layout.gen';
import { BODY, SKY } from '../predict/physics';
import { Boat } from '../render/boat';
import { basicMaterial, checkScene, domeCentre, domeDrop, litMaterial } from '../render/materials';
import { TIERS } from '../render/quality';
import { chooseBackend, wantsCompat } from '../render/renderer';
import { readSailorLight, type SailorColours, sailorColours } from '../render/sailors/material';
import { loadClips, loadSailor, type SailorClips, type SailorModel } from '../render/sailors/model';
import { Shadows } from '../render/shadows';
import { Sky, look as skyLook, toLinear } from '../render/sky';
import { Stage } from '../render/stage';

/** The built looks' files, by their path under art/sailors/. */
const FILES = import.meta.glob<string>(
  ['../../../art/sailors/*/*.glb', '!../../../art/sailors/vendor/**'],
  { query: '?url', import: 'default', eager: true },
);

export type Level = 'close' | 'deck' | 'far';
export type View = 'lineup' | 'face' | 'deck' | 'picker';
export type LightName = 'noon' | 'dusk' | 'night' | 'morning';

/** A look's files: each version's levels and clips, by URL. */
export interface LookFiles {
  look: string;
  versions: Map<string, { levels: Partial<Record<Level, string>>; clips?: string }>;
}

/** The looks the build has written, in the order of their folders' names. */
export function builtLooks(files: Record<string, string>): LookFiles[] {
  const looks = new Map<string, LookFiles>();
  for (const [path, url] of Object.entries(files)) {
    const m = /\/art\/sailors\/([^/]+)\/([a-z]+)(?:\.(deck|far|clips))?\.glb$/.exec(path);
    if (m === null) {
      continue;
    }
    const [, id, version, kind] = m as unknown as [string, string, string, string | undefined];
    const entry = looks.get(id) ?? { look: id, versions: new Map() };
    looks.set(id, entry);
    const v = entry.versions.get(version) ?? { levels: {} };
    entry.versions.set(version, v);
    if (kind === 'clips') {
      v.clips = url;
    } else {
      v.levels[(kind ?? 'close') as Level] = url;
    }
  }
  return [...looks.values()].sort((a, b) => a.look.localeCompare(b.look));
}

/** What the room shows. */
export interface Room {
  view: View;
  light: LightName;
  level: Level;
  /** A clip's name, or rest: the skeleton's rest pose. */
  clip: string;
  side: 'front' | 'back';
  main: string;
  skin: string;
  hair: string;
  black: boolean;
  /** The mask drawn in place of the sailors' colours: red main, green skin, blue hair. */
  mask: boolean;
  phone: boolean;
  /** The clips held at this time, in seconds; null to play. */
  t: number | null;
  who: number;
  /** Only this look's versions, or every look's (''). */
  look: string;
}

/** The test sailor's colours, and the clip each view starts in. */
const DEFAULTS: Room = {
  view: 'lineup',
  light: 'noon',
  level: 'close',
  clip: '',
  side: 'front',
  main: 'E6DCC3',
  skin: 'B2815F',
  hair: '413129',
  black: false,
  mask: false,
  phone: false,
  t: null,
  who: 0,
  look: '',
};
const VIEW_CLIP: Record<View, string> = {
  lineup: 'standing-idle',
  face: 'standing-idle',
  deck: 'helm',
  picker: 'standing-idle',
};
const VIEWS: View[] = ['lineup', 'face', 'deck', 'picker'];
const LIGHTS: LightName[] = ['noon', 'morning', 'dusk', 'night'];
const LEVELS: Level[] = ['close', 'deck', 'far'];
const VIEW_LIGHT: Record<View, LightName> = {
  lineup: 'noon',
  face: 'noon',
  deck: 'noon',
  picker: 'morning',
};

/** The options' colours a sailor may take, to try them on. */
export const SWATCHES = {
  skin: ['E1C0A9', 'CDA385', 'B2815F', '946145', '734736', '52342B'],
  hair: ['251E1C', '413129', '654A37', '834328', '9D7E58', 'C9AC7E', '817B76', 'B5AEA6', 'D2CBC1'],
  main: ['1E1E1E', '1F3A63', '9B2226', '2E7D6B', 'D9B648', '8DB4D6', 'C4622D', 'E6DCC3'],
};

/** The room from the hash: #sailors&view=…; what it does not say, the view's defaults. */
export function readRoom(hash: string): Room {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const view = (VIEWS as string[]).includes(q.get('view') ?? '')
    ? (q.get('view') as View)
    : 'lineup';
  const pick = <T extends string>(name: string, from: readonly T[], fallback: T): T =>
    (from as readonly string[]).includes(q.get(name) ?? '') ? (q.get(name) as T) : fallback;
  const colour = (name: 'main' | 'skin' | 'hair'): string => {
    const c = q.get(name) ?? '';
    return /^[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : DEFAULTS[name];
  };
  const t = Number(q.get('t'));
  return {
    view,
    light: pick('light', LIGHTS, VIEW_LIGHT[view]),
    level: pick('level', LEVELS, 'close'),
    clip: q.get('clip') || VIEW_CLIP[view],
    side: q.get('side') === 'back' ? 'back' : 'front',
    main: colour('main'),
    skin: colour('skin'),
    hair: colour('hair'),
    black: q.get('black') === '1',
    mask: q.get('mask') === '1',
    phone: q.get('phone') === '1',
    t: q.has('t') && Number.isFinite(t) ? t : null,
    who: Math.max(0, Math.floor(Number(q.get('who')) || 0)),
    look: /^[a-z][a-z0-9-]*$/.test(q.get('look') ?? '') ? (q.get('look') as string) : '',
  };
}

/** The hash for a room: only what differs from its view's defaults. */
export function writeRoom(r: Room): string {
  const q = new URLSearchParams();
  q.set('view', r.view);
  if (r.light !== VIEW_LIGHT[r.view]) q.set('light', r.light);
  if (r.level !== 'close') q.set('level', r.level);
  if (r.clip !== VIEW_CLIP[r.view]) q.set('clip', r.clip);
  if (r.side !== 'front') q.set('side', r.side);
  for (const c of ['main', 'skin', 'hair'] as const) {
    if (r[c] !== DEFAULTS[c]) q.set(c, r[c]);
  }
  if (r.black) q.set('black', '1');
  if (r.mask) q.set('mask', '1');
  if (r.phone) q.set('phone', '1');
  if (r.t !== null) q.set('t', String(r.t));
  if (r.who !== 0) q.set('who', String(r.who));
  if (r.look !== '') q.set('look', r.look);
  return `#sailors&${q.toString()}`;
}

const DEG = Math.PI / 180;

/**
 * The sky's record at an hour of the room's: the sun's and the moon's
 * heights and bearings (clockwise from north), and the moon's lit share.
 */
export function skyRecord(light: LightName): Float64Array {
  const r = new Float64Array(SKY.size);
  const body = (at: number, height: number, bearing: number): void => {
    const h = height * DEG;
    const b = bearing * DEG;
    r[at + BODY.east] = Math.cos(h) * Math.sin(b);
    r[at + BODY.north] = Math.cos(h) * Math.cos(b);
    r[at + BODY.up] = Math.sin(h);
    r[at + BODY.altitude] = h;
    r[at + BODY.bearing] = b;
  };
  // The sailors face south, toward the camera in front: the light from
  // over its left shoulder.
  const at: Record<LightName, [number, number, number, number, number]> = {
    noon: [55, 200, -40, 20, 0],
    morning: [22, 135, -50, 300, 0],
    dusk: [2, 245, -30, 60, 0],
    night: [-30, 340, 35, 165, 0.9],
  };
  const [sunH, sunB, moonH, moonB, lit] = at[light];
  body(SKY.sun, sunH, sunB);
  body(SKY.moon, moonH, moonB);
  r[SKY.lit] = lit;
  return r;
}

/** A sailor in the room: a level of a look's version, posed, and where it is. */
interface Figure {
  look: string;
  version: string;
  level: Level;
  model: SailorModel;
  /** Its own copy of the model's scene, skeleton and all. */
  root: Object3D;
  meshes: Mesh[];
  colours: SailorColours;
  clips: SailorClips | null;
  mixer: AnimationMixer | null;
  action: AnimationAction | null;
  /** Seconds its clip is ahead of the others', so the row is not in step. */
  offset: number;
  /** The dinghy it sits in, when its pose is placed in one. */
  boat: Boat | null;
}

/** The quay's top, the line the row stands on, and the space between sailors, in metres. */
const QUAY_TOP = 1.0;
const ROW_Z = -0.8;
const SPACING = 1.1;
/** The dinghies moored before the quay, and the space between them. */
const MOORED_Z = 2.6;
const BOAT_SPACING = 4.2;
/** The picker's disc of planks: its top. */
const DISC_TOP = 0.4;

/** The fleet in the deck view: east and north of the own boat (m) and heading (rad). */
const FLEET: [number, number, number][] = [
  [0, 0, 0],
  [-6, 16, 0.25],
  [8, 24, -0.2],
  [-13, 38, 0.1],
  [15, 47, -0.35],
  [3, 58, 0.4],
  [-32, 92, 0.15],
  [28, 120, -0.1],
  [-55, 160, 0.3],
  [45, 205, -0.25],
  [2, 260, 0.05],
];
/** Beyond this from the camera a fleet sailor is drawn at the far level. */
const NEAR_RANGE = 60;

interface Orbit {
  target: Vector3;
  azimuth: number;
  elevation: number;
  distance: number;
}

/** What tests read of the room: window.dressing. */
export interface DressingHooks {
  ready: boolean;
  error: string;
  backend: string;
  compat: boolean;
  room(): Room;
  set(change: Partial<Room>): Promise<void>;
  /** Draws a frame now. */
  draw(): void;
  figures(): {
    look: string;
    version: string;
    level: Level;
    skinned: boolean;
    bones: number;
    meshes: number;
    inBoat: boolean;
  }[];
  /** Where a figure's bone is drawn, dropped by the dome, in CSS pixels from the stage's top left. */
  project(figure: number, bone: string): { x: number; y: number };
  /** Moves the dome's centre (scene x and z, m): the room drops away from it. */
  dome(x: number, z: number): void;
  /** The scene against the material factory: an empty list is a pass. */
  problems(): string[];
  /** The last frame's draws and triangles. */
  counts(): { draws: number; triangles: number };
}

export class DressingRoom {
  readonly stage: Stage;
  readonly sky: Sky;
  readonly shadows: Shadows;
  readonly looks = builtLooks(FILES);
  room: Room;
  readonly #container: HTMLElement;
  readonly #status: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #figures: Figure[] = [];
  readonly #protos = new Map<string, Promise<SailorModel>>();
  readonly #clips = new Map<string, Promise<SailorClips>>();
  readonly #boats: Boat[] = [];
  readonly #props = new Group();
  readonly #quay: Mesh;
  readonly #disc: Mesh;
  readonly #black = basicMaterial({ color: 0x000000, side: DoubleSide });
  /** Each model's mask, drawn as colour. */
  readonly #masks = new Map<SailorModel, Material>();
  readonly #orbit: Orbit = { target: new Vector3(), azimuth: 0, elevation: 0.1, distance: 6 };
  readonly #out = new Float64Array(SIZES.out);
  /** The dome's centre, and the point the camera looks at, dropped by it. */
  readonly #dome = new Vector2();
  readonly #look = new Vector3();
  #time = 0;
  #applying: Promise<void> = Promise.resolve();
  readonly hooks: DressingHooks;

  constructor(container: HTMLElement, query: URLSearchParams) {
    this.#container = container;
    this.room = readRoom(location.hash);
    const stageBox = document.createElement('div');
    stageBox.className = 'dressing-stage';
    container.append(stageBox);
    this.#status = document.createElement('p');
    this.#status.className = 'dressing-status';
    this.#panel = document.createElement('div');
    this.#panel.className = 'dressing-panel';
    this.#panel.id = 'dressing-panel';
    this.#panel.hidden = true;
    // The panel folds away, so the figures are seen whole.
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'dressing-fold';
    fold.textContent = 'Room';
    fold.setAttribute('aria-controls', this.#panel.id);
    fold.setAttribute('aria-expanded', 'false');
    fold.addEventListener('click', () => {
      this.#panel.hidden = !this.#panel.hidden;
      fold.setAttribute('aria-expanded', String(!this.#panel.hidden));
    });
    container.append(this.#status, this.#panel, fold);

    this.stage = new Stage(stageBox, chooseBackend(query, 'gpu' in navigator), {
      frame: (gfx, info) => {
        this.#frame(info.dt);
        return gfx === null ? false : undefined;
      },
    });
    this.stage.compat = wantsCompat(query);
    this.stage.timestamps = false;
    const scene = this.stage.scene;
    this.sky = new Sky(scene);
    this.shadows = new Shadows(this.sky.light);
    // Solid things fade toward the horizon's colour with distance by
    // Koschmieder's law, as in the game's clear air.
    const clear = length(positionView).mul(3.912).div(skyLook.visualRange);
    scene.fogNode = fog(toLinear(skyLook.skyHorizon), float(1).sub(exp(clear.negate())));

    const sea = new Mesh(
      new PlaneGeometry(6000, 6000, 160, 160).rotateX(-Math.PI / 2),
      litMaterial({ color: 0x0b2a36, roughness: 0.3, metalness: 0 }),
    );
    sea.name = 'sea';
    this.#quay = new Mesh(
      new BoxGeometry(40, QUAY_TOP + 1, 3).translate(0, (QUAY_TOP - 1) / 2, -1.5),
      litMaterial({ color: 0x7d6248, roughness: 0.9, metalness: 0 }),
    );
    this.#quay.name = 'quay';
    this.#quay.receiveShadow = true;
    this.#disc = new Mesh(
      new CylinderGeometry(1.3, 1.3, 0.12, 48).translate(0, DISC_TOP - 0.06, 0),
      litMaterial({ color: 0x9a7650, roughness: 0.85, metalness: 0 }),
    );
    this.#disc.name = 'disc';
    this.#disc.receiveShadow = true;
    this.#props.add(sea, this.#quay, this.#disc);
    scene.add(this.#props);

    this.hooks = {
      ready: false,
      error: '',
      backend: '',
      compat: false,
      room: () => ({ ...this.room }),
      set: (change) => this.set(change),
      draw: () => this.stage.renderOnce(performance.now()),
      figures: () =>
        this.#figures.map((f) => ({
          look: f.look,
          version: f.version,
          level: f.level,
          skinned: f.meshes.some(
            (m) => (m as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true,
          ),
          bones: f.model.skeleton?.bones.length ?? 0,
          meshes: f.meshes.length,
          inBoat: f.boat !== null,
        })),
      project: (figure, bone) => this.#project(figure, bone),
      dome: (x, z) => {
        this.#dome.set(x, z);
      },
      problems: () => checkScene(scene),
      counts: () => {
        const info = this.stage.renderer?.info.render;
        return { draws: info?.drawCalls ?? 0, triangles: info?.triangles ?? 0 };
      },
    };
    this.#controls(stageBox);
  }

  async start(): Promise<void> {
    await this.stage.start();
    const gfx = this.stage.gfx;
    if (gfx !== null) {
      this.shadows.attached(gfx.renderer);
      this.hooks.backend = gfx.backend;
      this.hooks.compat = gfx.compat;
    }
    this.shadows.set(TIERS.high, true, true);
    this.sky.light.castShadow = true;
    window.addEventListener('hashchange', () => {
      const r = readRoom(location.hash);
      if (writeRoom(r) !== writeRoom(this.room)) {
        void this.set(r);
      }
    });
    await this.set({});
    this.hooks.ready = true;
  }

  /** Changes what the room shows; resolves once it is loaded and compiled. */
  set(change: Partial<Room>): Promise<void> {
    const next = { ...this.room, ...change };
    if (change.view !== undefined && change.view !== this.room.view) {
      // A new view starts in its own clip and light unless told otherwise.
      next.clip = change.clip ?? VIEW_CLIP[next.view];
      next.light = change.light ?? VIEW_LIGHT[next.view];
    }
    this.room = next;
    history.replaceState(null, '', writeRoom(next));
    this.#applying = this.#applying
      .then(() => this.#apply())
      .catch((err: unknown) => {
        this.hooks.error = err instanceof Error ? err.message : String(err);
        this.#status.textContent = `Failed: ${this.hooks.error}`;
      });
    return this.#applying;
  }

  async #apply(): Promise<void> {
    const r = this.room;
    const renderer = this.stage.renderer;
    if (renderer === null) {
      return;
    }
    this.#status.textContent = 'Loading…';
    this.sky.read(skyRecord(r.light));
    this.#container.classList.toggle('phone', r.phone);
    this.stage.resize();
    this.#quay.visible = r.view === 'lineup' || r.view === 'face';
    this.#disc.visible = r.view === 'picker';

    // Who is shown, and at which level.
    const wanted: {
      look: string;
      version: string;
      level: Level;
      colours: SailorColours;
      at: number;
    }[] = [];
    const colours = (): SailorColours => sailorColours(`#${r.main}`, `#${r.skin}`, `#${r.hair}`);
    const row = this.#shown().flatMap((l) =>
      [...l.versions.keys()].map((v) => ({ look: l.look, version: v })),
    );
    if (r.view === 'lineup') {
      for (const [i, s] of row.entries()) {
        wanted.push({ ...s, level: r.level, colours: colours(), at: i });
      }
    } else if (r.view === 'face' || r.view === 'picker') {
      const s = row[Math.min(r.who, row.length - 1)];
      if (s !== undefined) {
        wanted.push({
          ...s,
          level: r.view === 'face' ? 'close' : r.level,
          colours: colours(),
          at: 0,
        });
      }
    } else {
      for (const [i] of FLEET.entries()) {
        const s = row[i % row.length];
        if (s === undefined) {
          break;
        }
        const [east, north] = FLEET[i] as [number, number, number];
        const near = Math.hypot(east, north) < NEAR_RANGE;
        // The own boat in the room's colours; the rest from the swatches.
        const c =
          i === 0
            ? colours()
            : sailorColours(
                `#${SWATCHES.main[(i * 3) % SWATCHES.main.length]}`,
                `#${SWATCHES.skin[(i * 5) % SWATCHES.skin.length]}`,
                `#${SWATCHES.hair[(i * 2) % 6]}`,
              );
        wanted.push({
          ...s,
          level: near ? (r.level === 'far' ? 'far' : 'deck') : 'far',
          colours: c,
          at: i,
        });
      }
    }

    for (const f of this.#figures.splice(0)) {
      f.root.removeFromParent();
      f.mixer?.stopAllAction();
      f.boat?.root.removeFromParent();
    }
    const made = await Promise.all(
      wanted.map((w) => this.#figure(w.look, w.version, w.level, w.colours, w.at)),
    );
    for (const [i, f] of made.entries()) {
      this.#place(f, i);
      this.#figures.push(f);
    }
    this.#materials();
    this.#aim(true);
    this.#time = 0;
    this.#frame(0);
    await this.stage.compile(this.stage.scene);
    this.#status.textContent = this.#describe();
    this.#panelFor();
  }

  /** A figure of a look's version at a level: its model's copy, its colours, its clip. */
  async #figure(
    look: string,
    version: string,
    level: Level,
    colours: SailorColours,
    at: number,
  ): Promise<Figure> {
    const files = this.looks.find((l) => l.look === look)?.versions.get(version);
    const url = files?.levels[level] ?? files?.levels.close;
    const renderer = this.stage.renderer;
    if (url === undefined || renderer === null) {
      throw new Error(`no ${level} level of ${look} ${version}`);
    }
    let proto = this.#protos.get(url);
    if (proto === undefined) {
      proto = loadSailor(url, renderer, colours);
      this.#protos.set(url, proto);
    }
    let clips: Promise<SailorClips> | null = null;
    if (files?.clips !== undefined) {
      clips = this.#clips.get(files.clips) ?? loadClips(files.clips, renderer);
      this.#clips.set(files.clips, clips);
    }
    const [model, c] = await Promise.all([proto, clips]);
    const root = cloneSkinned(model.root);
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof Mesh) {
        // A copy's userData is a copy by JSON, which keeps no colours.
        o.userData.main = colours.main;
        o.userData.skin = colours.skin;
        o.userData.hair = colours.hair;
        o.castShadow = true;
        o.receiveShadow = true;
        meshes.push(o);
      }
    });
    const f: Figure = {
      look,
      version,
      level: url === files?.levels[level] ? level : 'close',
      model,
      root,
      meshes,
      colours,
      clips: c,
      mixer: null,
      action: null,
      offset: at * 0.7,
      boat: null,
    };
    const clip = c?.clips.find((k) => k.name === this.room.clip);
    if (model.skeleton !== null && clip !== undefined) {
      f.mixer = new AnimationMixer(root);
      f.action = f.mixer.clipAction(clip);
      f.action.play();
    }
    return f;
  }

  /** Where a figure stands, or sits: on the quay or the disc, or in its dinghy. */
  #place(f: Figure, i: number): void {
    const r = this.room;
    const seat = this.#seat(f);
    if (seat !== null) {
      const boat = this.#boat(i);
      f.boat = boat;
      boat.model.add(f.root);
      f.root.matrixAutoUpdate = true;
      seat.decompose(f.root.position, f.root.quaternion, f.root.scale);
      const scene = this.stage.scene;
      scene.add(boat.root);
      if (r.view === 'deck') {
        const [east, north, heading] = FLEET[i] as [number, number, number];
        boat.root.position.set(east, 0, -north);
        boat.root.rotation.set(0, -heading, 0);
      } else {
        // Moored before the quay, turned so the sailor faces the front.
        const n = this.#figuresWanted();
        boat.root.position.set(
          (i - (n - 1) / 2) * BOAT_SPACING,
          0,
          r.view === 'picker' ? 0 : MOORED_Z,
        );
        boat.root.rotation.set(0, Math.PI / 2, 0);
      }
      return;
    }
    f.boat = null;
    if (r.view === 'picker') {
      f.root.position.set(0, DISC_TOP, 0);
    } else {
      const n = this.#figuresWanted();
      f.root.position.set((i - (n - 1) / 2) * SPACING, QUAY_TOP, ROW_Z);
    }
    f.root.rotation.set(0, 0, 0);
    this.#props.add(f.root);
  }

  #figuresWanted(): number {
    const r = this.room;
    if (r.view !== 'lineup') {
      return 1;
    }
    return this.#shown().reduce((n, l) => n + l.versions.size, 0);
  }

  /** The looks the room shows: one, if it says, or all. */
  #shown(): LookFiles[] {
    const only = this.looks.filter((l) => l.look === this.room.look);
    return only.length > 0 ? only : this.looks;
  }

  /** Where the figure's pose seats it in the boat model, or null if it stands. */
  #seat(f: Figure): Matrix4 | null {
    if (f.model.skeleton === null) {
      // The far level is made seated.
      return f.model.places.get('place') ?? null;
    }
    const place = f.clips?.places.get(`place-${this.room.clip}`);
    if (place === undefined || f.action === null) {
      return null;
    }
    return place.equals(IDENTITY) ? null : place;
  }

  /** The room's i-th dinghy, made once and kept. */
  #boat(i: number): Boat {
    let b = this.#boats[i];
    if (b === undefined) {
      b = new Boat(catalog.boats[0]);
      this.#boats[i] = b;
      void b.load(String(10 + i), catalog.boats[0].name.slice(0, 1)).then(() => {
        b?.model.traverse((o) => {
          if (o instanceof Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
      });
    }
    return b;
  }

  /** Every figure's meshes in the sailor material, or black, or its mask. */
  #materials(): void {
    for (const f of this.#figures) {
      const made = f.model.meshes[0]?.material as Material;
      let mask = this.#masks.get(f.model);
      if (mask === undefined) {
        const m = basicMaterial({ side: DoubleSide });
        m.colorNode = texture(f.model.mask);
        mask = m;
        this.#masks.set(f.model, m);
      }
      for (const m of f.meshes) {
        m.material = this.room.black ? this.#black : this.room.mask ? mask : made;
      }
    }
  }

  /** The camera's resting view for the room; at once, or keeping a turn the drag made. */
  #aim(reset: boolean): void {
    const r = this.room;
    const o = this.#orbit;
    const back = r.side === 'back' ? Math.PI : 0;
    if (r.view === 'lineup') {
      const n = this.#figuresWanted();
      const seated = this.#figures.some((f) => f.boat !== null);
      const width = (n - 1) * (seated ? BOAT_SPACING : SPACING) + (seated ? 3.5 : 1);
      // Seated, the sailors sit on the far side deck, across the cockpit.
      o.target.set(0, seated ? 0.9 : QUAY_TOP + 0.95, seated ? MOORED_Z - 0.5 : ROW_Z);
      if (reset) {
        o.azimuth = back;
        o.elevation = seated ? 0.16 : 0.06;
        o.distance = Math.max(4, (seated ? 0.8 : 1.1) * width + 1.5);
      }
    } else if (r.view === 'face') {
      if (reset) {
        o.azimuth = back;
        o.elevation = 0.04;
        o.distance = 0.75;
      }
    } else if (r.view === 'picker') {
      o.target.set(0, DISC_TOP - 0.05, 0);
      if (reset) {
        o.azimuth = back + 0.35;
        o.elevation = 0.06;
        o.distance = 4.6;
      }
    } else {
      // The game's chase camera behind the own boat: 16 m, 0.3 rad up,
      // looking at 1.8 m above it.
      o.target.set(0, 1.8, 0);
      if (reset) {
        o.azimuth = back;
        o.elevation = 0.3;
        o.distance = 16;
      }
    }
  }

  #frame(dt: number): void {
    const r = this.room;
    this.#time += dt;
    for (const f of this.#figures) {
      if (f.mixer !== null && f.action !== null) {
        const length = f.action.getClip().duration;
        f.mixer.setTime(r.t ?? (this.#time + f.offset) % length);
      }
    }
    // The boats at rest, their sails set.
    const pose = newPose();
    // At sea the boom to port, the sailor to windward on the starboard side
    // deck; moored, to starboard behind the sailor, who faces the camera
    // across the cockpit.
    pose.boom = r.view === 'deck' ? -0.35 : 0.35;
    for (const f of this.#figures) {
      const b = f.boat;
      if (b !== null) {
        const at = b.root.position;
        const turn = b.root.rotation.y;
        b.draw({ x: at.x, y: at.y, z: at.z }, pose, this.#out, this.#time, dt);
        // draw() turns the root to the pose's heading: the room's own turn.
        b.root.rotation.set(0, turn, 0);
      }
    }
    const o = this.#orbit;
    if (r.view === 'face') {
      const f = this.#figures[0];
      const head = f?.root.getObjectByName('head');
      if (head !== undefined) {
        f?.root.updateWorldMatrix(true, true);
        head.getWorldPosition(o.target);
        // Between the brow and the mouth, so a hat is in the picture too.
        o.target.y += 0.05;
      }
    }
    const cam = this.stage.camera;
    const c = Math.cos(o.elevation);
    cam.position.set(
      o.target.x + o.distance * c * Math.sin(o.azimuth),
      o.target.y + o.distance * Math.sin(o.elevation),
      o.target.z + o.distance * c * Math.cos(o.azimuth),
    );
    cam.near = r.view === 'face' ? 0.05 : 0.2;
    cam.updateProjectionMatrix();
    // The dome drops the world away from its centre, the room's middle
    // unless a test moves it: the camera drops with what it looks at.
    const dome = domeCentre.value as Vector2;
    dome.copy(this.#dome);
    const drop = domeDrop(Math.hypot(o.target.x - dome.x, o.target.z - dome.y));
    cam.position.y -= drop;
    this.#look.copy(o.target).setY(o.target.y - drop);
    cam.lookAt(this.#look);
    this.sky.follow(cam.position, this.#look);
    readSailorLight(this.sky.light, this.sky.hemisphere);
  }

  #project(i: number, bone: string): { x: number; y: number } {
    const f = this.#figures[i];
    const b = f?.root.getObjectByName(bone);
    if (f === undefined || b === undefined) {
      throw new Error(`no bone ${bone} on figure ${i}`);
    }
    this.stage.scene.updateMatrixWorld(true);
    // Where it is drawn: dropped by the dome.
    const w = b.getWorldPosition(new Vector3());
    w.y -= domeDrop(Math.hypot(w.x - this.#dome.x, w.z - this.#dome.y));
    const p = w.project(this.stage.camera);
    const { width, height } = this.stage.size();
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
  }

  #describe(): string {
    const g = this.stage.gfx;
    const back =
      g === null
        ? 'no renderer'
        : g.backend === 'webgpu'
          ? g.compat
            ? 'WebGPU, compatibility mode'
            : 'WebGPU'
          : 'WebGL 2';
    const who = this.#figures.map((f) => `${f.look} ${f.version} ${f.level}`);
    const unique = [...new Set(who)];
    return `${back} · ${this.#figures.length} sailors (${unique.join(', ')})`;
  }

  /** Drag to turn the camera, the wheel or a pinch to set its distance. */
  #controls(box: HTMLElement): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let spread = 0;
    box.addEventListener('pointerdown', (e) => {
      box.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    box.addEventListener('pointermove', (e) => {
      const was = pointers.get(e.pointerId);
      if (was === undefined) {
        return;
      }
      const o = this.#orbit;
      if (pointers.size === 1) {
        o.azimuth -= (e.clientX - was.x) * 0.008;
        o.elevation = Math.min(1.4, Math.max(-0.3, o.elevation + (e.clientY - was.y) * 0.006));
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (spread > 0) {
          o.distance = Math.min(400, Math.max(0.3, o.distance * (spread / d)));
        }
        spread = d;
      }
    });
    const up = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      spread = 0;
    };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const o = this.#orbit;
        o.distance = Math.min(400, Math.max(0.3, o.distance * Math.exp(e.deltaY * 0.001)));
      },
      { passive: false },
    );
  }

  /** The panel: the views, the light, the level, the clip, the options. */
  #panelFor(): void {
    const r = this.room;
    const p = this.#panel;
    p.replaceChildren();
    const group = (label: string, items: [string, boolean, () => void][]): void => {
      const g = document.createElement('div');
      g.className = 'dressing-group';
      const l = document.createElement('span');
      l.textContent = label;
      g.append(l);
      for (const [text, on, act] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', act);
        g.append(b);
      }
      p.append(g);
    };
    const swatches = (label: string, key: 'main' | 'skin' | 'hair'): void => {
      const g = document.createElement('div');
      g.className = 'dressing-group';
      const l = document.createElement('span');
      l.textContent = label;
      g.append(l);
      for (const c of SWATCHES[key]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.title = `#${c}`;
        b.setAttribute('aria-label', `${label} #${c}`);
        b.setAttribute('aria-pressed', String(r[key] === c));
        b.style.setProperty('--swatch', `#${c}`);
        b.addEventListener('click', () => {
          // Colours change on the figures as they are.
          this.room = { ...this.room, [key]: c };
          history.replaceState(null, '', writeRoom(this.room));
          // In the fleet, the own boat's sailor alone.
          for (const f of r.view === 'deck' ? this.#figures.slice(0, 1) : this.#figures) {
            f.colours[key].set(`#${c}`);
          }
          this.#panelFor();
        });
        g.append(b);
      }
      p.append(g);
    };
    group(
      'View',
      VIEWS.map((v) => [v, r.view === v, () => void this.set({ view: v })]),
    );
    group(
      'Light',
      LIGHTS.map((l) => [l, r.light === l, () => void this.set({ light: l })]),
    );
    group(
      'Level',
      LEVELS.map((l) => [l, r.level === l, () => void this.set({ level: l })]),
    );
    const names = new Set<string>(['rest']);
    for (const f of this.#figures) {
      for (const c of f.clips?.clips ?? []) {
        names.add(c.name);
      }
    }
    group(
      'Clip',
      [...names].map((c) => [
        c,
        r.clip === c || (c === 'rest' && !names.has(r.clip)),
        () => void this.set({ clip: c }),
      ]),
    );
    group('Side', [
      ['front', r.side === 'front', () => this.#side('front')],
      ['back', r.side === 'back', () => this.#side('back')],
    ]);
    group('Show', [
      ['black', r.black, () => this.#toggle('black')],
      ['mask', r.mask, () => this.#toggle('mask')],
      ['phone', r.phone, () => this.#toggle('phone')],
      ['held', r.t !== null, () => void this.set({ t: r.t === null ? 1 : null })],
    ]);
    swatches('Skin', 'skin');
    swatches('Hair', 'hair');
    swatches('Main', 'main');
  }

  #side(side: 'front' | 'back'): void {
    this.room = { ...this.room, side };
    history.replaceState(null, '', writeRoom(this.room));
    this.#aim(true);
    this.#panelFor();
  }

  #toggle(what: 'black' | 'mask' | 'phone'): void {
    this.room = { ...this.room, [what]: !this.room[what] };
    history.replaceState(null, '', writeRoom(this.room));
    if (what !== 'phone') {
      this.#materials();
    } else {
      this.#container.classList.toggle('phone', this.room.phone);
      this.stage.resize();
    }
    this.#panelFor();
  }
}

const IDENTITY = new Matrix4();

/** Opens the dressing room in place of the developer page. */
export async function openDressingRoom(): Promise<void> {
  const main = document.createElement('div');
  main.className = 'dressing';
  document.body.replaceChildren(main);
  const room = new DressingRoom(main, new URLSearchParams(location.search));
  (window as unknown as { dressing: DressingHooks }).dressing = room.hooks;
  try {
    await room.start();
  } catch (err) {
    room.hooks.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

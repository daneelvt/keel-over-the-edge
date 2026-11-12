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
// seconds, for pictures), who, look (only that look's versions), boat (the
// boat the sailors sit in, by its place in the catalog's boats: 0 the
// first; the clips moved to its seat as the game moves them). A clip at a
// wheel stands each sailor at the wheel of a boat that has one, as the game
// stands it; in a boat that has none, on the quay behind a wheel made to the
// numbers the ships' models are built to. A clip on a trapeze's wire hangs
// each sailor from the wire of the boat whose model has one, whatever boat
// says, placed from its rack's edge, the harness worn and the wire drawn
// from the hounds to its hook. A clip on a rail seats each sailor on the
// rail of the boat whose model has one (the keelboat), placed from her
// deck's edge on the clip's side, the boat turned so the sailor faces the
// front; a crouch's clip puts each on her side deck, the walk going forward
// along it at its speed. The back end is the game's choice, and
// ?backend=webgl2 or ?compat as in the game.
//
// Drag turns the camera about what it looks at, the wheel or a pinch sets
// its distance.

import './dressing.css';
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { exp, float, fog, length, positionView, texture } from 'three/tsl';
import { catalog } from '../catalog';
import { boatCode } from '../catalog/boatlooks';
import { newPose } from '../predict/blend';
import { SIZES } from '../predict/layout.gen';
import { BODY, SKY } from '../predict/physics';
import { Boat } from '../render/boat';
import { basicMaterial, checkScene, domeCentre, domeDrop, litMaterial } from '../render/materials';
import { TIERS } from '../render/quality';
import { chooseBackend, wantsCompat } from '../render/renderer';
import {
  aboard,
  CAT_CLIPS,
  CROSS_SPEED,
  catAnchor,
  catPlace,
  catPoint,
  catSide,
  inCatFile,
  namesCatClips,
} from '../render/sailors/cat';
import { readSailorLight, type SailorColours, sailorColours } from '../render/sailors/material';
import { loadClips, loadSailor, type SailorClips, type SailorModel } from '../render/sailors/model';
import {
  boneNames,
  type Harness,
  loadHarness,
  setWire,
  wireColour,
  wireMesh,
} from '../render/sailors/onboat';
import {
  CROUCH_CLIPS,
  CROUCH_SPEED,
  inRailFile,
  onRail,
  RAIL_CLIPS,
  railEdge,
  railPlace,
  railSide,
} from '../render/sailors/rail';
import { restageAnimation, restageOf, restagePlace } from '../render/sailors/restage';
import { Rig } from '../render/sailors/rig';
import { atWheel, CLIPS } from '../render/sailors/runtime';
import {
  company,
  DECK_CLIPS,
  inAloftFile,
  inShipFile,
  STAGED,
  shipAnchor,
  shipPlace,
  shipPoint,
  shipSide,
  WALK_SPEED,
} from '../render/sailors/ship';
import {
  onPelvis,
  onWire,
  TRAPEZE_CLIPS,
  trapezeData,
  wireNode,
  wirePlace,
  wireSide,
} from '../render/sailors/trapeze';
import { frameIn, wheelOf } from '../render/sailors/wheel';
import { Shadows } from '../render/shadows';
import { Sky, look as skyLook, toLinear } from '../render/sky';
import { Stage } from '../render/stage';

/** The machines' folder under art/sailors/: their lamps glow, and their metal takes the finish. */
const MACHINE_LOOK = 'machine';
/** A machine's lamps' light. */
const LAMP = '#ffb347';

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
  versions: Map<
    string,
    {
      levels: Partial<Record<Level, string>>;
      clips?: string;
      wheel?: string;
      trapeze?: string;
      harness?: string;
      rail?: string;
      ship?: string;
      aloft?: string;
      cat?: string;
    }
  >;
}

/** The looks the build has written, in the order of their folders' names. */
export function builtLooks(files: Record<string, string>): LookFiles[] {
  const looks = new Map<string, LookFiles>();
  for (const [path, url] of Object.entries(files)) {
    const m =
      /\/art\/sailors\/([^/]+)\/([a-z]+)(?:\.(deck|far|clips|wheel|trapeze|harness|rail|ship|aloft|cat))?\.glb$/.exec(
        path,
      );
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
    } else if (kind === 'wheel') {
      v.wheel = url;
    } else if (kind === 'trapeze') {
      v.trapeze = url;
    } else if (kind === 'harness') {
      v.harness = url;
    } else if (kind === 'rail') {
      v.rail = url;
    } else if (kind === 'ship') {
      v.ship = url;
    } else if (kind === 'aloft') {
      v.aloft = url;
    } else if (kind === 'cat') {
      v.cat = url;
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
  /** A machine's metal, in place of skin. */
  finish: string;
  black: boolean;
  /** The mask drawn in place of the sailors' colours: red main, green skin, blue hair. */
  mask: boolean;
  phone: boolean;
  /** The clips held at this time, in seconds; null to play. */
  t: number | null;
  who: number;
  /** Only this look's versions, or every look's (''). */
  look: string;
  /** The boat they sit in: its place in the catalog's boats. */
  boat: number;
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
  finish: 'D9A957',
  black: false,
  mask: false,
  phone: false,
  t: null,
  who: 0,
  look: '',
  boat: 0,
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
  const colour = (name: 'main' | 'skin' | 'hair' | 'finish'): string => {
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
    finish: colour('finish'),
    black: q.get('black') === '1',
    mask: q.get('mask') === '1',
    phone: q.get('phone') === '1',
    t: q.has('t') && Number.isFinite(t) ? t : null,
    who: Math.max(0, Math.floor(Number(q.get('who')) || 0)),
    look: /^[a-z][a-z0-9-]*$/.test(q.get('look') ?? '') ? (q.get('look') as string) : '',
    boat: Math.min(catalog.boats.length - 1, Math.max(0, Math.floor(Number(q.get('boat')) || 0))),
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
  for (const c of ['main', 'skin', 'hair', 'finish'] as const) {
    if (r[c] !== DEFAULTS[c]) q.set(c, r[c]);
  }
  if (r.black) q.set('black', '1');
  if (r.mask) q.set('mask', '1');
  if (r.phone) q.set('phone', '1');
  if (r.t !== null) q.set('t', String(r.t));
  if (r.who !== 0) q.set('who', String(r.who));
  if (r.look !== '') q.set('look', r.look);
  if (r.boat !== 0) q.set('boat', String(r.boat));
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
  /** The boat it sits in, when its pose is placed in one. */
  boat: Boat | null;
  /** The wheel it stands at on the quay, when its clip is at a wheel and the boat has none. */
  wheel: Object3D | null;
  /** On a trapeze's wire: the harness it wears, played with its clip; and the wire drawn to its hook. */
  harness: { root: Object3D; mixer: AnimationMixer; meshes: Mesh[]; hook: Vector3 | null } | null;
  wire: { mesh: Mesh; side: number; hounds: Vector3; hook: Vector3 } | null;
  /** Walking at a crouch along a side deck: where it starts, and how far it goes before it starts again. */
  walk: { from: Vector3; length: number; speed: number; way?: Vector3 } | null;
}

/** The wheel stood at on the quay: its hub ahead of and above the helmsman's place, its rim, spokes and their handles beyond it, as the ships' models are built. */
const WHEEL = { ahead: 0.55, up: 1.05, radius: 0.75, spokes: 8, handles: 0.15 };

/** The quay's top, the line the row stands on, and the space between sailors, in metres. */
const QUAY_TOP = 1.0;
const ROW_Z = -0.8;
const SPACING = 1.1;
/** The dinghies moored before the quay, and the space between them. */
const MOORED_Z = 2.6;
const BOAT_SPACING = 4.2;
/** The picker's disc of planks: its top. */
const DISC_TOP = 0.4;
/**
 * Crouched on the rail boat's side deck: this far in from her deck's edge,
 * from this far aft of the rail's station, walking this far forward along
 * it (short of her shrouds).
 */
const SIDE_DECK_IN = 0.3;
const WALK_FROM = 0.75;
const WALK = 0.9;
/** Aboard the ship, standing about this far inboard of her rail, and walking this far forward. */
const SHIP_STAND_IN = 1.1;
const SHIP_WALK = 2.4;

/** Crossing a beach cat's net, the loops go this far across it, and back. */
const CROSS = 1.0;
/** Righting her: stood on her lower hull's top this far toward her deck from the hull's middle, as the build stands it. */
const CAT_STAND_OUT = 0.05;

/** Whether a clip on a beach cat hangs from the trapeze's wire. */
function catWired(clip: string): boolean {
  const base = clip.replace(/-port$/, '');
  return base === CAT_CLIPS.wire || base === CAT_CLIPS.wireLow || base === CAT_CLIPS.crewWire;
}

/** Whether a clip is the ship's company's: about her decks, or her work and aloft. */
function onShip(clip: string): boolean {
  return inShipFile(clip) || inAloftFile(clip);
}

/** What the camera looks at, seated on the rail boat moored: this high, and this far out from her middle toward the quay. */
const RAIL_LOOK = { y: 1.0, out: 1.0 };

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

/**
 * A wheel to WHEEL's numbers in the helmsman's frame (x to starboard, y
 * up, z aft; the helmsman facing −z): the rim, the spokes out to their
 * handles' ends, and the hub on its axle.
 */
function standInWheel(): Mesh {
  const { ahead, up, radius, spokes, handles } = WHEEL;
  const parts: BufferGeometry[] = [new TorusGeometry(radius, 0.025, 8, 64)];
  for (let k = 0; k < spokes; k++) {
    const a = (2 * Math.PI * k) / spokes;
    const length = radius + handles - 0.06;
    parts.push(
      new BoxGeometry(0.036, length, 0.036).translate(0, 0.06 + length / 2, 0).rotateZ(-a),
    );
  }
  parts.push(new CylinderGeometry(0.07, 0.07, 0.12, 16).rotateX(Math.PI / 2));
  const keep = parts.map((g) => {
    const out = g.index === null ? g : g.toNonIndexed();
    for (const name of Object.keys(out.attributes)) {
      if (name !== 'position' && name !== 'normal') {
        out.deleteAttribute(name);
      }
    }
    return out;
  });
  const merged = mergeGeometries(keep, false) as BufferGeometry;
  merged.translate(0, up, -ahead);
  const mesh = new Mesh(merged, litMaterial({ color: 0x6b4a2e, roughness: 0.7, metalness: 0 }));
  mesh.name = 'wheel';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
  /** Turns the camera about what it looks at, for pictures: as far as said, the rest kept. */
  orbit(o: {
    azimuth?: number;
    elevation?: number;
    distance?: number;
    target?: [number, number, number];
  }): void;
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
  readonly #harnesses = new Map<string, Promise<Harness>>();
  /** The catalog's boat whose model has a trapeze, once found; −1 if none has. */
  #wireBoat: number | null = null;
  /** The catalog's boat whose model has a rail, once found; −1 if none has. */
  #railBoat: number | null = null;
  /** The catalog's beach cat, once looked for: its index, or −1 if none. */
  #cat: number | null = null;
  /** The catalog's boat whose model marks her company's places (the tall ship), once found; −1 if none does. */
  #ship: number | null = null;
  /** The boats made, by the catalog's boat and the place in the room, and their models' loads. */
  readonly #boats = new Map<string, { boat: Boat; loaded: Promise<void> }>();
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
      orbit: (o) => {
        const orbit = this.#orbit;
        orbit.azimuth = o.azimuth ?? orbit.azimuth;
        orbit.elevation = o.elevation ?? orbit.elevation;
        orbit.distance = o.distance ?? orbit.distance;
        if (o.target !== undefined) {
          orbit.target.fromArray(o.target);
        }
        this.#frame(0);
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
      f.wheel?.removeFromParent();
      f.harness?.root.removeFromParent();
      f.harness?.mixer.stopAllAction();
      f.wire?.mesh.removeFromParent();
    }
    if (onWire(r.clip)) {
      await this.#findWireBoat();
    }
    if (inRailFile(r.clip)) {
      await this.#findRailBoat();
    }
    if (onShip(r.clip)) {
      await this.#findShip();
    }
    if (inCatFile(r.clip)) {
      await this.#findCat();
    }
    const made = await Promise.all(
      wanted.map((w) => this.#figure(w.look, w.version, w.level, w.colours, w.at)),
    );
    for (const [i, f] of made.entries()) {
      await this.#place(f, i);
      this.#figures.push(f);
    }
    // A figure seated in a boat needs no disc to stand on.
    this.#disc.visible &&= !this.#figures.some((f) => f.boat !== null);
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
    const machine = look === MACHINE_LOOK;
    if (machine) {
      colours = sailorColours(`#${colours.main.getHexString()}`, `#${this.room.finish}`, LAMP);
    }
    let proto = this.#protos.get(url);
    if (proto === undefined) {
      proto = loadSailor(url, renderer, colours, machine);
      this.#protos.set(url, proto);
    }
    let clips: Promise<SailorClips> | null = null;
    // The clips at a wheel, those on a trapeze's wire and those on a rail
    // (and the crouch) are files of their own.
    const clipsUrl = inCatFile(this.room.clip)
      ? files?.cat
      : onWire(this.room.clip)
        ? files?.trapeze
        : inRailFile(this.room.clip)
          ? files?.rail
          : inShipFile(this.room.clip)
            ? files?.ship
            : inAloftFile(this.room.clip)
              ? files?.aloft
              : atWheel(this.room.clip)
                ? files?.wheel
                : files?.clips;
    if (clipsUrl !== undefined) {
      clips = this.#clips.get(clipsUrl) ?? loadClips(clipsUrl, renderer);
      this.#clips.set(clipsUrl, clips);
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
        o.userData.glow = 1;
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
      wheel: null,
      harness: null,
      wire: null,
      walk: null,
    };
    const clip = c?.clips.find((k) => k.name === this.room.clip);
    if (model.skeleton !== null && clip !== undefined) {
      f.mixer = new AnimationMixer(root);
      f.action = f.mixer.clipAction(clip);
      f.action.play();
      if ((onWire(clip.name) || catWired(clip.name)) && files?.harness !== undefined) {
        f.harness = await this.#harness(files.harness, root, clip);
      }
    }
    return f;
  }

  /**
   * A figure's harness: its own copy of the file's, played with the
   * figure's clip; its hook's eye against the pelvis at rest (the figure
   * not yet posed).
   */
  async #harness(
    url: string,
    figure: Object3D,
    clip: AnimationClip,
  ): Promise<NonNullable<Figure['harness']>> {
    const renderer = this.stage.renderer;
    let proto = this.#harnesses.get(url);
    if (proto === undefined && renderer !== null) {
      proto = loadHarness(url, renderer);
      this.#harnesses.set(url, proto);
    }
    const h = await (proto as Promise<Harness>);
    const root = cloneSkinned(h.root);
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        meshes.push(o);
      }
    });
    const mixer = new AnimationMixer(root);
    mixer.clipAction(clip).play();
    const hook = h.hook === null ? null : onPelvis(Rig.from(figure, boneNames(figure)), h.hook);
    return { root, mixer, meshes, hook };
  }

  /** Finds the catalog's boat whose model has a trapeze, loading the boats' models in turn. */
  async #findWireBoat(): Promise<void> {
    if (this.#wireBoat !== null) {
      return;
    }
    for (let k = 0; k < catalog.boats.length; k++) {
      const { boat, loaded } = this.#boatAt(k, 0);
      await loaded;
      if (trapezeData(boat.parts.get('trapeze')?.userData) !== null) {
        this.#wireBoat = k;
        return;
      }
    }
    this.#wireBoat = -1;
  }

  /** Finds the catalog's boat whose model marks her company's places, loading the boats' models in turn. */
  async #findShip(): Promise<void> {
    if (this.#ship !== null) {
      return;
    }
    for (let k = 0; k < catalog.boats.length; k++) {
      const { boat, loaded } = this.#boatAt(k, 0);
      await loaded;
      if (company(boat.parts) !== null) {
        this.#ship = k;
        return;
      }
    }
    this.#ship = -1;
  }

  /**
   * A figure aboard the ship: a clip placed on her at her place of its
   * kind, on its side (the yard's under the yard's node); standing about
   * on her quarterdeck inboard of her rail, facing outboard; walking along
   * it, forward, at the walk's speed. Her square sails are left out, so a
   * figure aloft is seen. The ship is turned so the figure faces the front.
   * False if the room has no ship or the figure no clip.
   */
  async #onShip(f: Figure, i: number): Promise<boolean> {
    const r = this.room;
    if (!onShip(r.clip) || f.action === null || this.#ship === null || this.#ship < 0) {
      return false;
    }
    // Every figure aboard the one ship, each a little apart from the last.
    const { boat, loaded } = this.#boatAt(this.#ship, 0);
    await loaded;
    const c = company(boat.parts);
    if (c === null) {
      return false;
    }
    const n = this.#figuresWanted();
    const anchor = shipAnchor(r.clip);
    let parent: Object3D = boat.model;
    let seat: Matrix4;
    // Which way the figure faces on her: outboard (+x), forward (−z) or aft (+z).
    let facing = Math.PI / 2;
    // Apart: forward along her rail and deck, along the hatch's edge, to
    // the next topmast shroud forward, out along the yard.
    const apart =
      anchor === 'hatch'
        ? new Vector3((i - (n - 1) / 2) * 0.55, 0, 0)
        : anchor === 'top'
          ? new Vector3(0, 0, -0.5 * i)
          : anchor === 'yard'
            ? new Vector3(0.9 * i, 0, 0)
            : new Vector3(0, 0, -1.4 * i);
    if (anchor === null) {
      const at = new Vector3(c.rail.x - SHIP_STAND_IN, 0, c.rail.z).add(apart);
      at.y = this.#deckAt(boat, at.x, at.z);
      if (r.clip === DECK_CLIPS.walk) {
        facing = Math.PI;
        f.walk = { from: at, length: SHIP_WALK, speed: WALK_SPEED };
        seat = new Matrix4()
          .makeTranslation(at.x, at.y, at.z)
          .multiply(new Matrix4().makeRotationY(Math.PI));
      } else {
        seat = new Matrix4()
          .makeTranslation(at.x, at.y, at.z)
          .multiply(new Matrix4().makeRotationY(facing));
      }
    } else {
      const place = f.clips?.places.get(`place-${r.clip}`);
      if (place === undefined) {
        return false;
      }
      const p = shipPoint(c, anchor);
      if (p.node !== null) {
        parent = boat.parts.get(p.node) ?? boat.model;
      }
      seat = shipPlace(place, p.at.add(apart), shipSide(r.clip));
      if (anchor === 'brace' && i === 0) {
        // The fall, which her model does not draw: from its lead along the
        // deck past the haulers.
        const side = shipSide(r.clip);
        const lead = c.brace.lead.clone().setX(side * c.brace.lead.x);
        lead.y += STAGED.braceUp;
        const fall = c.brace.fall.clone().setX(side * c.brace.fall.x);
        fall.y += STAGED.braceUp;
        const along = fall.clone().sub(lead).normalize();
        const end = lead.clone().addScaledVector(along, STAGED.braceAt + 1.4 * n);
        const rope = new Mesh(
          new CylinderGeometry(0.014, 0.014, end.distanceTo(lead), 6),
          litMaterial({ color: 0x33261a, roughness: 0.9, metalness: 0 }),
        );
        rope.position.copy(lead).add(end).multiplyScalar(0.5);
        rope.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), along);
        boat.model.add(rope);
        f.wheel = rope;
      }
      facing = anchor === 'brace' ? 0 : anchor === 'rail' ? Math.PI / 2 : Math.PI;
    }
    boat.model.traverse((o) => {
      if (o instanceof Mesh && (o.material as Material).name === 'flax') {
        o.visible = false;
      }
    });
    f.boat = boat;
    parent.add(f.root);
    f.root.matrixAutoUpdate = true;
    seat.decompose(f.root.position, f.root.quaternion, f.root.scale);
    this.stage.scene.add(boat.root);
    boat.root.position.set(0, 0, MOORED_Z);
    // Turned so the figure faces +z, the front.
    boat.root.rotation.set(0, -facing * shipSide(r.clip), 0);
    return true;
  }

  /** Finds the catalog's boat whose kind's people are drawn with the beach cat's clips. */
  async #findCat(): Promise<void> {
    if (this.#cat === null) {
      this.#cat = catalog.boats.findIndex((b) => namesCatClips(b.art));
    }
  }

  /**
   * A figure aboard a beach cat, each on her own, moored before the quay:
   * on her starboard hull (or port, for a -port clip) from her station's
   * deck edge, turned so the figure faces the front; crossing her net from
   * its middle, facing forward, the loops going to their side at their
   * speed; or, righting her, standing on her lower hull as she lies on her
   * side, facing her. Her sails are left out, so the people are seen.
   * False if the room has no beach cat or the figure no clip.
   */
  async #onCat(f: Figure, i: number): Promise<boolean> {
    const r = this.room;
    if (!inCatFile(r.clip) || f.action === null || this.#cat === null || this.#cat < 0) {
      return false;
    }
    const { boat, loaded } = this.#boat(i);
    await loaded;
    const a = aboard(boat.parts);
    const place = f.clips?.places.get(`place-${r.clip}`);
    const anchor = catAnchor(r.clip);
    if (a === null || place === undefined || anchor === null) {
      return false;
    }
    boat.model.traverse((o) => {
      if (o instanceof Mesh && (o.material as Material).name === 'flax') {
        o.visible = false;
      }
    });
    const n = this.#figuresWanted();
    const x = (i - (n - 1) / 2) * this.#boatSpacing();
    this.stage.scene.add(boat.root);
    boat.root.position.set(x, 0, MOORED_Z);
    f.boat = boat;
    f.walk = null;
    f.root.matrixAutoUpdate = true;
    const side = catSide(r.clip);
    if (anchor === 'stand') {
      // Lying on her side, her mast to port, turned so the figure faces
      // the front; it stands upright on her lower hull, where a ray down
      // over its middle meets it, as the build stood it.
      boat.root.quaternion
        .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
      boat.root.updateMatrixWorld(true);
      const keel = boat.parts.get('board-root')?.position.x ?? 1;
      const from = new Vector3(-keel, CAT_STAND_OUT, a.crew.inner.z).applyMatrix4(
        boat.model.matrixWorld,
      );
      const hull = boat.parts.get('hull');
      const hit =
        hull === undefined
          ? undefined
          : new Raycaster(from.clone().setY(from.y + 0.6), new Vector3(0, -1, 0)).intersectObject(
              hull,
              true,
            )[0];
      const stand = hit?.point ?? from;
      this.stage.scene.add(f.root);
      new Matrix4()
        .makeTranslation(stand.x, stand.y, stand.z)
        .multiply(new Matrix4().makeRotationY(Math.PI / 2))
        .multiply(place)
        .decompose(f.root.position, f.root.quaternion, f.root.scale);
      return true;
    }
    boat.root.rotation.set(0, anchor === 'net' ? Math.PI : (side * Math.PI) / 2, 0);
    const at = catPoint(a, anchor) ?? new Vector3();
    const seat = catPlace(place, at, side);
    boat.model.add(f.root);
    seat.decompose(f.root.position, f.root.quaternion, f.root.scale);
    const speed = CROSS_SPEED[r.clip];
    if (speed !== undefined) {
      // To the clip's side, from half the way to the other.
      const way = new Vector3(r.clip.endsWith('left') ? -1 : 1, 0, 0);
      const from = f.root.position.clone().addScaledVector(way, -CROSS / 2);
      f.walk = { from, length: CROSS, speed, way };
    }
    if (f.harness !== null) {
      boat.model.add(f.harness.root);
      seat.decompose(f.harness.root.position, f.harness.root.quaternion, f.harness.root.scale);
      const trapeze = trapezeData(boat.parts.get('trapeze')?.userData);
      if (trapeze !== null) {
        const mesh = wireMesh(wireColour(wireNode(boat.parts, side)));
        mesh.castShadow = true;
        boat.model.add(mesh);
        f.wire = { mesh, side, hounds: trapeze.hounds, hook: new Vector3() };
      }
    }
    return true;
  }

  /** Finds the catalog's boat whose model has a rail, loading the boats' models in turn. */
  async #findRailBoat(): Promise<void> {
    if (this.#railBoat !== null) {
      return;
    }
    for (let k = 0; k < catalog.boats.length; k++) {
      const { boat, loaded } = this.#boatAt(k, 0);
      await loaded;
      if (railEdge(boat.parts) !== null) {
        this.#railBoat = k;
        return;
      }
    }
    this.#railBoat = -1;
  }

  /**
   * A figure on the rail boat: sat on her rail from her deck's edge on the
   * clip's side; or crouched on her starboard side deck facing forward, half
   * way from the cuddy's side to the edge, the walk going forward along it.
   * False if the room has no rail boat or the figure no clip.
   */
  async #onRailBoat(f: Figure, i: number): Promise<boolean> {
    const r = this.room;
    if (!inRailFile(r.clip) || f.action === null || this.#railBoat === null || this.#railBoat < 0) {
      return false;
    }
    const { boat, loaded } = this.#boat(i);
    await loaded;
    const edge = railEdge(boat.parts);
    if (edge === null) {
      return false;
    }
    let seat: Matrix4;
    if (onRail(r.clip)) {
      const place = f.clips?.places.get(`place-${r.clip}`);
      if (place === undefined) {
        return false;
      }
      seat = railPlace(place, edge, railSide(r.clip));
    } else {
      const from = new Vector3(
        edge.x - SIDE_DECK_IN,
        this.#deckAt(boat, edge.x - SIDE_DECK_IN, edge.z + WALK_FROM),
        edge.z + WALK_FROM,
      );
      seat = new Matrix4()
        .makeTranslation(from.x, from.y, from.z)
        .multiply(new Matrix4().makeRotationY(Math.PI));
      f.walk = r.clip === CROUCH_CLIPS.walk ? { from, length: WALK, speed: CROUCH_SPEED } : null;
    }
    f.boat = boat;
    boat.model.add(f.root);
    f.root.matrixAutoUpdate = true;
    seat.decompose(f.root.position, f.root.quaternion, f.root.scale);
    this.stage.scene.add(boat.root);
    if (r.view === 'deck') {
      const [east, north, heading] = FLEET[i] as [number, number, number];
      boat.root.position.set(east, 0, -north);
      boat.root.rotation.set(0, -heading, 0);
    } else {
      // Moored before the quay, turned so the sailor faces the front: her
      // starboard side to it, or her port for a clip on the port rail.
      const n = this.#figuresWanted();
      boat.root.position.set(
        (i - (n - 1) / 2) * this.#boatSpacing(),
        0,
        r.view === 'picker' ? 0 : MOORED_Z,
      );
      boat.root.rotation.set(0, (-railSide(r.clip) * Math.PI) / 2, 0);
    }
    return true;
  }

  /** The height of a boat's deck at (x, z) in her model's frame: what a ray down meets first of her hull. */
  #deckAt(boat: Boat, x: number, z: number): number {
    const hull = boat.parts.get('hull');
    if (hull === undefined) {
      return 0;
    }
    boat.model.updateMatrixWorld(true);
    const toWorld = boat.model.matrixWorld;
    const from = new Vector3(x, 5, z).applyMatrix4(toWorld);
    const down = new Vector3(0, -1, 0).transformDirection(toWorld);
    const hit = new Raycaster(from, down).intersectObject(hull, true)[0];
    return hit === undefined ? 0 : hit.point.applyMatrix4(new Matrix4().copy(toWorld).invert()).y;
  }

  /** Where a figure stands, or sits: on the quay or the disc, or in its boat. */
  async #place(f: Figure, i: number): Promise<void> {
    const r = this.room;
    if ((await this.#onRailBoat(f, i)) || (await this.#onShip(f, i)) || (await this.#onCat(f, i))) {
      return;
    }
    let seat = this.#seat(f);
    const wheeled = seat !== null && atWheel(r.clip);
    const wired = seat !== null && onWire(r.clip) && f.model.skeleton !== null;
    if (seat !== null && wheeled) {
      // At a wheel: the boat's, from its helmsman's place; or on the quay.
      const { boat, loaded } = this.#boat(i);
      await loaded;
      const stand = boat.parts.get('sailor');
      if (wheelOf(boat.parts, boat.model) === null || stand === undefined) {
        this.#standAtWheel(f, i, seat);
        return;
      }
      seat = frameIn(stand, boat.model, new Matrix4()).multiply(seat);
    }
    if (seat !== null) {
      const { boat, loaded } = this.#boat(i);
      await loaded;
      // Both wires as they hang, but the one a sailor is hooked on.
      for (const s of [1, -1]) {
        const node = wireNode(boat.parts, s);
        if (node !== undefined) {
          node.visible = true;
        }
      }
      const trapeze = wired ? trapezeData(boat.parts.get('trapeze')?.userData) : null;
      if (trapeze !== null && seat !== null) {
        // On the wire: from the rack's edge on the clip's side, never moved.
        const side = wireSide(r.clip);
        seat = wirePlace(seat, trapeze.rackEdge, side);
        const node = wireNode(boat.parts, side);
        const mesh = wireMesh(wireColour(node));
        mesh.castShadow = true;
        boat.model.add(mesh);
        if (node !== undefined) {
          node.visible = false;
        }
        f.wire = { mesh, side, hounds: trapeze.hounds, hook: new Vector3() };
      } else if (!wheeled) {
        seat = this.#restage(f, boat, seat);
      }
      f.boat = boat;
      boat.model.add(f.root);
      f.root.matrixAutoUpdate = true;
      seat.decompose(f.root.position, f.root.quaternion, f.root.scale);
      if (f.harness !== null) {
        boat.model.add(f.harness.root);
        seat.decompose(f.harness.root.position, f.harness.root.quaternion, f.harness.root.scale);
      }
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
          (i - (n - 1) / 2) * this.#boatSpacing(),
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

  /**
   * A figure at a wheel on the quay: placed from the helmsman's place, on
   * the quay facing the front, behind a wheel made to WHEEL's numbers.
   */
  #standAtWheel(f: Figure, i: number, place: Matrix4): void {
    const n = this.#figuresWanted();
    const at = new Matrix4()
      .makeTranslation(
        this.room.view === 'picker' ? 0 : (i - (n - 1) / 2) * SPACING * 1.6,
        this.room.view === 'picker' ? DISC_TOP : QUAY_TOP,
        this.room.view === 'picker' ? 0 : ROW_Z,
      )
      .multiply(new Matrix4().makeRotationY(Math.PI));
    f.boat = null;
    f.root.matrixAutoUpdate = true;
    new Matrix4()
      .multiplyMatrices(at, place)
      .decompose(f.root.position, f.root.quaternion, f.root.scale);
    this.#props.add(f.root);
    const wheel = standInWheel();
    at.decompose(wheel.position, wheel.quaternion, wheel.scale);
    this.#props.add(wheel);
    f.wheel = wheel;
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

  /**
   * A seated figure's place moved to its boat's seat, if the boat is not
   * the one the clips were placed in: its clip played moved as the game
   * moves it (a cross widened), or its far level's place moved.
   */
  #restage(f: Figure, boat: Boat, seat: Matrix4): Matrix4 {
    const by = restageOf(boat.parts.get('sailor')?.userData);
    if (by === null) {
      return seat;
    }
    if (f.mixer === null || f.action === null) {
      return restagePlace(seat, by);
    }
    const rig = Rig.from(f.root, boneNames(f.root));
    const moved = restageAnimation(f.action.getClip(), seat, rig, by);
    f.mixer.stopAllAction();
    f.action = f.mixer.clipAction(moved.animation);
    f.action.play();
    return moved.place;
  }

  /** The room's boats' kind: on a trapeze's wire, the boat with one; and the room between them moored. */
  #kind() {
    return catalog.boats[this.#boatIndex()] ?? catalog.boats[0];
  }

  /** The room's boats' place in the catalog's. */
  #boatIndex(): number {
    const wire = this.#wireBoat;
    const rail = this.#railBoat;
    if (inRailFile(this.room.clip) && rail !== null && rail >= 0) {
      return rail;
    }
    if (onShip(this.room.clip) && this.#ship !== null && this.#ship >= 0) {
      return this.#ship;
    }
    if (inCatFile(this.room.clip) && this.#cat !== null && this.#cat >= 0) {
      return this.#cat;
    }
    return onWire(this.room.clip) && wire !== null && wire >= 0 ? wire : this.room.boat;
  }

  #boatSpacing(): number {
    return Math.max(BOAT_SPACING, this.#kind().lengthOverall + 1);
  }

  /** The room's i-th boat of its kind, made once and kept, and its model's load. */
  #boat(i: number): { boat: Boat; loaded: Promise<void> } {
    return this.#boatAt(this.#boatIndex(), i);
  }

  /** The i-th boat of the catalog's k-th, made once and kept, and its model's load. */
  #boatAt(k: number, i: number): { boat: Boat; loaded: Promise<void> } {
    const kind = catalog.boats[k] ?? (catalog.boats[0] as (typeof catalog.boats)[number]);
    const key = `${k}:${i}`;
    let b = this.#boats.get(key);
    if (b === undefined) {
      const boat = new Boat(kind, catalog);
      const loaded = boat.load(kind.name.slice(0, 1)).then(() => {
        // Each in the first paint and cloth, numbered.
        boat.setBoatLook(boatCode({ paint: 0, cloth: 0, number: 10 + i }), '');
        boat.model.traverse((o) => {
          if (o instanceof Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
      });
      b = { boat, loaded };
      this.#boats.set(key, b);
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
      // The harness keeps its own colours, but black in the silhouettes.
      for (const m of f.harness?.meshes ?? []) {
        m.userData.made ??= m.material;
        m.material = this.room.black ? this.#black : (m.userData.made as Material);
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
      const wheels = this.#figures.some((f) => f.wheel !== null);
      const width =
        (n - 1) * (seated ? this.#boatSpacing() : SPACING * (wheels ? 1.6 : 1)) +
        (seated ? 3.5 : 1);
      // Seated, the sailors sit on the far side deck, across the cockpit:
      // the boat's seat moved from the first boat's.
      const by =
        restageOf(
          this.#figures.find((f) => f.boat !== null)?.boat?.parts.get('sailor')?.userData,
        ) ?? new Vector3();
      // On a rail boat, the crew are on her side nearest the quay.
      const railed = seated && inRailFile(r.clip);
      const aboard = seated && (onShip(r.clip) || inCatFile(r.clip));
      if (aboard) {
        // Aboard the ship: among the figures, wherever on her they are.
        o.target.set(0, 0, 0);
        const p = new Vector3();
        for (const f of this.#figures) {
          f.root.updateWorldMatrix(true, false);
          o.target.add(f.root.getWorldPosition(p));
        }
        o.target.divideScalar(Math.max(1, this.#figures.length));
        o.target.y += 0.85;
        if (reset) {
          // Hauling, from the side, the hands along the fall seen; sat on
          // the hatch, from above and a little forward of abeam, inboard of
          // her shrouds, clear of the foremast and with neither figure
          // behind the other; else from the front, a little above.
          const anchor = shipAnchor(r.clip);
          if (inCatFile(r.clip)) {
            // Aboard a beach cat, a little above: crossing her net, from
            // ahead and above, under her boom.
            const net = catAnchor(r.clip) === 'net';
            o.azimuth = back;
            o.elevation = net ? 0.35 : 0.22;
            o.distance = 3.0 + 1.4 * n;
            return;
          }
          o.azimuth =
            back + (anchor === 'brace' ? Math.PI / 2 : anchor === 'hatch' ? Math.PI / 2 + 0.6 : 0);
          o.elevation = anchor === 'hatch' ? 0.5 : 0.2;
          o.distance = 3.2 + 1.2 * n;
        }
        return;
      }
      o.target.set(
        0,
        railed ? RAIL_LOOK.y : seated ? 0.9 + by.y : QUAY_TOP + 0.95,
        railed ? MOORED_Z + RAIL_LOOK.out : seated ? MOORED_Z - 0.5 - by.x : ROW_Z,
      );
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
        const t = r.t ?? (this.#time + f.offset) % length;
        f.mixer.setTime(t);
        f.harness?.mixer.setTime(t);
        if (f.walk !== null) {
          // Forward along the side deck at the walk's speed, and again.
          const along =
            r.t !== null
              ? r.t * f.walk.speed
              : ((this.#time + f.offset) * f.walk.speed) % f.walk.length;
          const d = along % f.walk.length;
          if (f.walk.way === undefined) {
            f.root.position.copy(f.walk.from).setZ(f.walk.from.z - d);
          } else {
            f.root.position.copy(f.walk.from).addScaledVector(f.walk.way, d);
          }
        }
      }
    }
    // The boats at rest, their sails set.
    const pose = newPose();
    // At sea the boom to port, the sailor to windward on the starboard side
    // deck; moored, to starboard behind the sailor, who faces the camera
    // across the cockpit, no further out than clears the sailor's head
    // (half a metre out at the seat).
    const kind = this.#kind();
    const lever =
      (this.#boats.get(`${this.#boatIndex()}:0`)?.boat.parts.get('sailor')?.position.z ?? 0) +
      kind.physics.rig.mastPosition;
    pose.boom = inRailFile(r.clip)
      ? // Off to leeward of the crew on the rail.
        -railSide(r.clip) * 0.35
      : r.view === 'deck'
        ? -0.35
        : Math.min(0.35, Math.atan2(0.5, Math.max(lever, 0.1)));
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
    this.#wires();
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

  /** Each wire on a trapeze from the hounds to its sailor's hook, as the figure is posed. */
  #wires(): void {
    const hooked = this.#figures.filter((f) => f.wire !== null && f.harness?.hook != null);
    if (hooked.length === 0) {
      return;
    }
    this.stage.scene.updateMatrixWorld(true);
    for (const f of hooked) {
      const wire = f.wire as NonNullable<Figure['wire']>;
      const pelvis = f.root.getObjectByName('pelvis');
      const model = f.boat?.model;
      if (pelvis === undefined || model === undefined) {
        continue;
      }
      // The hook, carried by the pelvis, into the boat model's frame.
      wire.hook
        .copy(f.harness?.hook as Vector3)
        .applyMatrix4(pelvis.matrixWorld)
        .applyMatrix4(new Matrix4().copy(model.matrixWorld).invert());
      setWire(wire.mesh, wire.hounds, wire.hook);
    }
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
    // The clips at a wheel, and those on a trapeze's wire, from their own files.
    if (this.#shown().some((l) => [...l.versions.values()].some((v) => v.wheel !== undefined))) {
      for (const c of [CLIPS.wheel, `${CLIPS.wheel}-port`, CLIPS.wheelHabit]) {
        names.add(c);
      }
    }
    if (this.#shown().some((l) => [...l.versions.values()].some((v) => v.trapeze !== undefined))) {
      for (const c of [TRAPEZE_CLIPS.out, TRAPEZE_CLIPS.low]) {
        names.add(c);
        names.add(`${c}-port`);
      }
    }
    if (this.#shown().some((l) => [...l.versions.values()].some((v) => v.rail !== undefined))) {
      for (const c of [RAIL_CLIPS.up, RAIL_CLIPS.out]) {
        names.add(c);
        names.add(`${c}-port`);
      }
      for (const c of Object.values(CROUCH_CLIPS)) {
        names.add(c);
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
    group(
      'Boat',
      catalog.boats.map((b, k) => [b.name, r.boat === k, () => void this.set({ boat: k })]),
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

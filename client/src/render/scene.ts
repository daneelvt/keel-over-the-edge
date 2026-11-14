// SPDX-License-Identifier: AGPL-3.0-only

// The scene at sea: an open sea under the sky of the hour, the player's
// boat on it as the physics sails it, the other boats in view with their
// lanterns, the stars, the chase camera, and the beginners' overlays. Each
// drawn frame, whatever drives the boat (the game's tick) first sets the
// pose to draw, the latest step's Out and world time; the scene then
// follows its focus with the floating origin, the tile field, the land, the
// dome's bend and the camera, asks the physics module where the sun, the
// moon and the stars stand from the focus at that time, lights everything
// by the hour, and draws it. The focus is the boat; or, while the free
// camera flies, the point beneath it, and the boat is drawn where it is.
// Every boat is drawn as its own kind: the player's own by the kind the
// server welcomed it with (or the sandbox's), the others by theirs, each
// with its own model, lanterns, hull in the sea and wake, and the camera
// and the shadows sized to the own boat.
//
// Nothing is drawn until the world is ready under the page's cover: its
// frames update the scene alone until the page lets them draw.

import { signal } from '@preact/signals';
import { type Camera, type Color, type Vector2, Vector3, type Vector4 } from 'three';
import { exp, float, fog, length, max, mix, positionView, positionWorld } from 'three/tsl';
import type { WebGPURenderer } from 'three/webgpu';
import { type Boat as BoatKind, catalog } from '../catalog';
import { artOf, coloursOf, isMachine, type Look, type Looks, lookOf } from '../catalog/looks';
import { endLook } from '../edge/broken';
import { EdgeScene } from '../edge/edge';
import { edgeLook, KOSCHMIEDER } from '../edge/mist';
import { closedIn, EndSlabs, type EndStage, endStage, risen } from '../edge/taken';
import { STEPS_PER_SECOND } from '../game/clock';
import type { DrawnBoat } from '../game/fleet';
import { eachHull, type HullAt, hullRoom } from '../game/hullpose';
import type { Land } from '../land/land';
import type { BoatAt } from '../life/birds';
import { type GullSource, LifeDraw, type LifeFrame, type SurfaceAt } from '../life/draw';
import type { Aboard } from '../life/perch';
import { LifeStore } from '../life/store';
import { HULL_REACH, HULLS, hullShape, hulls } from '../ocean/hulls';
import { foamAt, KNOT, newFoamLook, SPRAY, transomFrom } from '../ocean/look';
import { Ocean } from '../ocean/ocean';
import { rainShare } from '../ocean/water';
import { type BoatPose, newPose } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { writeSkyParams } from '../predict/params.gen';
import { BODY, type Physics, SKY, VISIBILITY } from '../predict/physics';
import { type BoatWind, newBoatWind } from '../predict/weather';
import { SkyTime } from '../sky/skytime';
import starsUrl from '../sky/stars.bin?url';
import { SkyWeather } from '../sky/weather';
import { Birds } from './birds';
import { Boat, lampsLit, lazyArtUrl, type SailorLook } from './boat';
import { CAMERA_PRESETS, type CameraView, ChaseCamera, lookSizeOf, sizeOf } from './camera';
import { type RaceFrame, RaceMarks } from './committee';
import { FloatingOrigin, type ScenePoint } from './coords';
import { glowDark } from './daylight';
import { DirtyAir } from './dirtyair';
import { type FlagSeen, Flags } from './flags';
import { FleetViews, PERSON_DEFAULT } from './fleet';
import { AIR_REACH, airLook, depthTo, heldRain, setAirSources } from './fog';
import { FreeCamera } from './freecam';
import { GustRings } from './gustring';
import { type BoatLantern, Lanterns, lanternLit, TOWN_LANTERNS } from './lanterns';
import { Lightning } from './lightning';
import { Lighthouses } from './lights';
import { domeCentre, domeDrop } from './materials';
import { Overlays } from './overlays';
import { cockadeOf, PrizesAfloat } from './prizes';
import {
  Adaptive,
  type FrameWindow,
  pixelRatioOf,
  type Rung,
  remember,
  rungName,
  SLOW,
  type Store,
  startQuality,
  TIERS,
  type Tier,
  type TierName,
} from './quality';
import { type Gfx, type Wanted, wantsCompat } from './renderer';
import { RightOfWay, type Seen } from './rightofway';
import { bridgeCrew } from './sailors/bridgecrew';
import { bridgeBoat, namesBridgeClips } from './sailors/bridgedeck';
import { namesCatClips } from './sailors/cat';
import { CrewDeck, type CrewShown, helmLook, modelDeck, STEPPED, tillerOf } from './sailors/crew';
import { type CrewPlan, crewPlan, type SailorNow } from './sailors/crewrules';
import { FleetCrews, kindCrew } from './sailors/fleetcrews';
import { catOf } from './sailors/onboat';
import { company } from './sailors/ship';
import { shipPlan } from './sailors/shiprules';
import { hullSolid } from './sailors/solid';
import { namesYachtClips, yachtBoat } from './sailors/yacht';
import { Shadows } from './shadows';
import { StormCones } from './signals';
import { look, Sky, toLinear } from './sky';
import { type Chimney, Smoke, smokes } from './smoke';
import {
  type CrestSample,
  SprayDrops,
  type SpraySource,
  SprayView,
  type SprayWeather,
} from './spray';
import { Stage } from './stage';
import { FEW_STARS, Stars } from './stars';
import { type FrameStats, Stats, WINDOW } from './stats';
import { Swimmers } from './swimmers';
import { Wrecks } from './wrecks';

/** The staged end's timings, from the catalog. */
const END_LOOK = catalog.world.edge.end;
/** How thick the mist over the screen is as it closes in fully, before the end's own veil. */
const MIST_VEIL = 0.6;
/** A tick of world time, µs. */
const TICK_US = 1e6 / STEPS_PER_SECOND;
/** How high over the sea a mark's tag stands, m: over its spar's flag. */
const MARK_TAG_HEIGHT = 8;

/** For this long after the scene starts, the windows adaptive quality judges are short: the first seconds are the benchmark. */
const BENCHMARK = 6000;
const BENCHMARK_WINDOW = 500;
/**
 * A slow window probes the display again if the last probe is older than
 * this, in milliseconds, and than two windows more: so the two windows after
 * a probe are always judged, however long a slow machine's windows are.
 */
const PROBE_AFTER = 10_000;

/** What the scene is told when it is made. */
export interface SceneOptions {
  /** The page's query: ?tier and ?compat. */
  query: URLSearchParams;
  /** Where the quality a device settled on is remembered, or null. */
  store: Store | null;
  /** The player's choice of detail: automatic, or low to save battery. */
  detail: 'auto' | 'low';
}

export { CAMERA_PRESETS, type CameraView };

/** What draws the other boats: their poses this frame, drawn[0 … count). */
export interface FleetSource {
  readonly drawn: readonly DrawnBoat[];
  readonly count: number;
}

/** A look code's look as a sailor is drawn in it: the default person's for a code that names none. */
export function sailorLookOf(cat: Looks, code: number): SailorLook {
  const l = lookOf(cat, code) ?? (lookOf(cat, PERSON_DEFAULT) as Look);
  return { art: artOf(cat, l), colours: coloursOf(cat, l), machine: isMachine(l) };
}

/** How near a tap must be to a boat's hull or sail to pick it, CSS pixels: a finger's width. */
export const BOAT_TAP = 44;
/** The height of a boat's sail's middle a tap is measured to, m. */
const SAIL_TAP_HEIGHT = 3;

/** No boats: the fleet before the game is online. */
const NO_BOATS: readonly DrawnBoat[] = [];
/** A hull sits at most this much deeper or higher than at rest for its wake's waves, metres. */
const SINK_MOST = 0.08;

/**
 * What can cover the sea, drawn by the same renderer in its place while it
 * is open; brought up to date without one on a page that draws nothing.
 */
export interface Cover {
  readonly open: boolean;
  draw(renderer: WebGPURenderer | null, dt: number, now: number): void;
}

export class SeaScene {
  readonly stage: Stage;
  readonly origin = new FloatingOrigin();
  readonly ocean: Ocean;
  readonly sky: Sky;
  /** The weather in the sky: clouds, sheets and rain. */
  readonly weather: SkyWeather;
  /** The edge of the world: the mist band, the lip and the falls. */
  readonly edge: EdgeScene;
  /** The screen's fade to the mist, going over the lip. */
  readonly fade: HTMLDivElement;
  readonly stats = new Stats();
  readonly camera = new ChaseCamera();
  /** The free camera: while it flies, the scene follows it, not the boat. */
  readonly freeCam = new FreeCamera();
  /** The own boat's kind: its index among the catalog's boats. */
  kindIndex = 0;
  /** The catalog's sea: the spectrum both bands of waves are drawn from. */
  readonly catalogSea = catalog.weather.sea;
  readonly overlays: Overlays;
  /** The rings round the gusts heading for the boat: part of the wind overlay. */
  readonly gustRings = new GustRings(catalog.weather.ring);
  /** The wedges of dirty air behind the boats near: part of the wind overlay. */
  readonly dirtyAir = new DirtyAir(
    catalog.encounters.shadow,
    catalog.encounters.overlay.wedgeDeficit,
    catalog.encounters.overlay.wedges,
  );
  /** The beginners' right-of-way overlay. */
  readonly rightOfWay = new RightOfWay(catalog.boats[0], catalog.encounters.overlay);
  readonly boatScene: ScenePoint = { x: 0, y: 0, z: 0 };
  /** What the scene follows, in the world and the scene: the boat, or the point beneath the free camera. */
  readonly focus = { east: 0, north: 0 };
  readonly focusScene: ScenePoint = { x: 0, y: 0, z: 0 };
  boat: Boat | null = null;
  /** The other boats, drawn many at once, a view for each kind. */
  readonly fleet = new FleetViews(catalog.boats, catalog);
  /** The people aboard the boat in view besides its sailor at the helm, at their stations. */
  readonly crew = new CrewDeck((code) => sailorLookOf(catalog, code));
  /** The other boats' crews. */
  readonly crews = new FleetCrews(catalog.boats, (code) => sailorLookOf(catalog, code));
  /** Where the other boats' poses come from: the game's fleet online, or a test's. */
  fleetSource: FleetSource | null = null;
  /** The world's land, once there is a world whose land may be drawn. */
  land: Land | null = null;
  readonly shadows: Shadows;
  readonly spray = new SprayDrops(0);
  readonly sprayView = new SprayView();
  /** Whether the spray is hidden (the tests). */
  sprayHidden = false;
  readonly stars = new Stars();
  /** The flashes of the weather's squalls and storms, their clouds lit and their bolts. */
  readonly lightning = new Lightning();
  readonly lanterns = new Lanterns();
  /** The towns' flags and chimney smoke, each showing the true wind where it is. */
  readonly flags = new Flags(catalog.world.towns.flags);
  /** The storm cones on the harbourmasters' houses. */
  readonly cones = new StormCones();
  /**
   * The gale warning in force, as the cones show it: whether its gale
   * first blows from the north, the cone point up; null for none.
   */
  galeUp: boolean | null = null;
  readonly smoke = new Smoke(catalog.world.towns.smoke);
  /** The lighthouses: their towers, lights and looms. */
  readonly lighthouses = new Lighthouses(
    catalog.world.lights,
    catalog.world.places.kinds.findIndex((k) => k.site === 'light'),
  );
  /** Every bird drawn, one draw: the colonies', the sea's life's and the towns' gulls. */
  readonly birds = new Birds();
  /** The sea's life the page has been told of, and how it is drawn. */
  readonly life = new LifeStore();
  readonly lifeDraw = new LifeDraw(catalog.life, catalog.world.towns.buildings);
  /** Every animal in the water drawn, one draw. */
  readonly swimmers = new Swimmers();
  /** Called with each frame's life before it is drawn: the sandbox's scenes keep their grounds of fish by it. */
  onLife: ((f: LifeFrame) => void) | null = null;
  /** The wrecks, stranded and sunk. */
  readonly wrecks = new Wrecks(
    catalog.world.places.rigs,
    catalog.world.places.ages,
    catalog.world.places.kinds.findIndex((k) => k.site === 'wreck'),
    catalog.world.look.attenuation,
  );
  /** The race committee's things in the sea: the courses laid, the world's beacons, the guns' smoke. */
  readonly race = new RaceMarks(
    catalog.world.committee,
    catalog.world.towns.flags,
    catalog.world.towns.smoke,
    catalog.world.places.kinds.findIndex((k) => k.site === 'beacon'),
  );
  /** What every boat flies for its skipper's races, the own boat's too: one draw for their flags, one for their spoons. */
  readonly prizes = new PrizesAfloat(catalog.world.committee, catalog.world.towns.flags);
  /** Sky time, once the scene knows the world's epoch; and the module that says where everything stands. */
  skyTime: SkyTime | null = null;
  skyPhysics: Physics | null = null;
  /** The module's sky record at the boat, as last drawn, and the sky time it is for. */
  readonly skyRecord = new Float64Array(SKY.size);
  skyAt = 0;
  /** Draws the stars and the lanterns; the tests turn them off to see the rest. */
  drawSky = true;
  /** Holds the sky as it was last drawn, wherever the boat goes (the tests). */
  holdSky = false;

  /** What to draw: the boat between its last two steps, the latest step's Out, the wind. */
  readonly pose: BoatPose = newPose();
  out: Float64Array = new Float64Array(SIZES.out);
  wind: Readonly<BoatWind> = newBoatWind();
  /** The sea under the boat: the significant height of its waves, in metres, and its whitecaps, 0 to 1. */
  readonly sea = { height: 0, whitecaps: 0 };
  /** World time, seconds, and how much it moved since the last frame; and in ticks, for the sea. */
  time = 0;
  timeStep = 0;
  ticks = 0;

  usePass = true;
  /** Adaptive quality and its ladder, once the renderer is known. */
  quality: Adaptive | null = null;
  /** The tier the ladder starts from. */
  top: TierName = 'low';
  /** The player's choice of detail. */
  detail: 'auto' | 'low';
  /** The last window of frames adaptive quality judged (the panel, the tests). */
  lastWindow: FrameWindow | null = null;
  /** A window's length for adaptive quality that overrides the scene's own, ms (the tests). */
  windowMs: number | null = null;
  /** Called when the tier or the render scale in use changes: what the server is told. */
  onQuality: ((tier: number, scale: number) => void) | null = null;
  /** Called at the start of each drawn frame, with the real time since the last one (s) and now (ms). */
  tick: ((dt: number, now: number) => void) | null = null;
  /** What covers the sea while it is open, drawn in its place: the chart. */
  cover: Cover | null = null;
  /** Called after each frame is placed (the panel's statistics, the tests). */
  onFrame: (() => void) | null = null;
  /** A tag over a point of the sea, a race's next mark's number, while there is one; placed each frame where the camera sees it. */
  markTagOf: (() => { east: number; north: number; text: string } | null) | null = null;
  #markTag: HTMLElement | null = null;
  readonly #tagAt = new Vector3();
  /** Called after each frame is drawn, with the main thread's work on it, ms. */
  onDrawn: ((work: number) => void) | null = null;
  /** Whether the camera rests behind the boat, at its resting view and distance. */
  readonly resting = signal(true);
  /** The clear view: the screen bare, and with it the overlays on the sea. */
  clearView = false;
  /** A page under test: it draws only what its tests ask for, until it is thawed. */
  readonly underTest: boolean;
  /** The seconds left to the world's end by the world clock, Infinity for none known: the staged end. */
  endIn: (() => number) | null = null;
  /** The staged end at this frame. */
  endStage: EndStage = endStage(END_LOOK, Number.POSITIVE_INFINITY);
  /** The near sea's slabs at the world's end. */
  readonly endSlabs = new EndSlabs();

  readonly #target = new Vector3();
  readonly #v = new Vector3();
  /** The other boats nearest the player's, by their place among those drawn, and how far each is. */
  readonly #near = new Int32Array(HULLS);
  readonly #nearDist = new Float64Array(HULLS);
  readonly #query: URLSearchParams;
  readonly #store: Store | null;
  /** The current at the boat, as the module gives it. */
  readonly #current: number[] = [0, 0];
  /** The fade going over the lip, and the world's end's veil, 0 to 1; whether its words show. */
  #fadeOver = 0;
  #veil = 0;
  #veilWords = false;
  #words = false;
  /** The sky's clear visual range before the end's mist, and what the mist made of it last. */
  #clearRange = 6000;
  #mistedRange = Number.NaN;
  /** When the new world began to rise out of the mist, ms by the frames' clock; NaN once risen. */
  #risingFrom = Number.NaN;
  /** A rising asked for, to begin at the next frame, so many seconds in; NaN for none. */
  #riseIn = Number.NaN;
  /** The ground's height at a point, as the land holds it: what has no sea to break at the end. */
  readonly #groundAt = (east: number, north: number): number | null =>
    this.land?.heightAt(east, north) ?? null;
  #started = -1;
  #probed = Number.NEGATIVE_INFINITY;
  /** Counts the changes of quality asked for: one that takes long may be overtaken. */
  #applying = 0;

  constructor(
    container: HTMLElement,
    backend: Wanted,
    options: SceneOptions = { query: new URLSearchParams(), store: null, detail: 'auto' },
  ) {
    this.#query = options.query;
    this.#store = options.store;
    this.detail = options.detail;
    // A beach cat's crew on her wire: the fleet draws it to them.
    this.fleet.crewHook = (slot, out) => this.crews.hook(slot, out);
    this.stage = new Stage(container, backend, {
      frame: (gfx, info) => {
        const cover = this.cover;
        if (cover?.open === true) {
          // The chart covers the screen: the boat sails on, the sea is
          // not drawn.
          this.stats.gap();
          this.tick?.(info.dt, info.now);
          cover.draw(gfx?.renderer ?? null, info.dt, info.now);
          return false;
        }
        this.#frame(gfx, info.dt, info.now);
        return undefined;
      },
      drawn: (gfx, work) => {
        this.stats.drawn(gfx, work);
        this.onDrawn?.(work);
      },
      attached: (gfx) => this.#attached(gfx),
      resumed: () => {
        // Hidden, nothing was drawn: the frames either side say nothing.
        const now = performance.now();
        this.stats.restart(now);
        this.quality?.quiet(now);
      },
    });
    this.stage.compat = wantsCompat(options.query);
    // Nothing is drawn until the world is ready; and a page under test
    // draws what its tests ask for, until it is thawed.
    this.underTest = options.query.has('test');
    this.stage.loopDraws = false;
    this.stats.gpuTiming = true;
    this.stats.onWindow = (now, st) => this.#window(now, st);
    const scene = this.stage.scene;
    this.sky = new Sky(scene);
    this.weather = new SkyWeather(scene, catalog.weather.clouds);
    scene.add(this.lightning.mesh);
    // A star behind the sheets is not tapped.
    this.stars.hidden = (dir) => {
      const c = this.stage.camera.position;
      const o = this.origin.world;
      return this.weather.sheets.hides(dir, c.y, c.x + o.x, -c.z + o.y);
    };
    this.shadows = new Shadows(this.sky.light);
    this.ocean = new Ocean(scene);
    this.edge = new EdgeScene(scene, this.ocean.uniforms, {
      radius: catalog.world.disk.radius,
      mist: catalog.world.disk.mist,
      edge: catalog.world.edge,
      drainAt: catalog.weather.current.drainAt,
      drain: catalog.weather.current.drain,
    });
    this.edge.on = this.#query.get('edge') !== 'off';
    this.freeCam.lip = catalog.world.disk.radius;
    // The chase camera's arm reads the land in the world: the origin's offset.
    this.camera.origin = this.origin.world;
    this.fade = document.createElement('div');
    this.fade.className = 'edge-fade';
    const words = document.createElement('p');
    words.textContent = 'The falls take the world';
    this.fade.append(words);
    container.append(this.fade);
    scene.add(this.endSlabs.mesh);
    scene.add(this.sprayView.mesh);
    this.overlays = new Overlays(this.kind);
    // A kind's boats, first seen, are compiled off the frame.
    this.fleet.onView = (v) => {
      void this.stage.compile(v.root).catch(() => undefined);
      const nodes = v.parts?.nodes;
      this.#kindParts(v.index, (name) => nodes?.get(name) ?? null, v.parts?.hullData);
      // Its boats' crews drawn by its model's deck and stations.
      if (v.parts !== null) {
        this.crews.useKind(v.index, kindCrew(v.kind, v.parts));
      }
    };
    this.fleet.root.add(this.crews.group);
    scene.add(this.overlays.world);
    scene.add(this.gustRings.group);
    scene.add(this.dirtyAir.group, this.rightOfWay.group);
    scene.add(this.fleet.root);
    scene.add(this.stars.mesh, this.lanterns.mesh);
    scene.add(this.flags.mesh, this.smoke.mesh, this.cones.mesh);
    scene.add(this.lighthouses.towers, this.lighthouses.glows);
    scene.add(this.wrecks.root);
    scene.add(this.race.root);
    scene.add(this.prizes.root);
    this.fleet.prizes = this.prizes;
    scene.add(this.birds.mesh, this.swimmers.mesh);
    this.wrecks.depthAt = (east, north) => {
      const h = this.land?.heightAt(east, north) ?? null;
      return h === null ? null : -h;
    };
    const label = document.createElement('span');
    label.className = 'star-label';
    container.append(label);
    this.stars.attachLabel(label);
    // Solid things fade toward the horizon's colour with distance, keeping
    // exp(−3.912 d / V) of their contrast at d metres: Koschmieder's law, V
    // the visual range at a 2% threshold; and toward the mist's through the
    // band at the edge of the world and the weather's fog and rain, by
    // their optical depth along the ray. The sea has its own blend to the
    // sky at its edge.
    const clear = length(positionView).mul(KOSCHMIEDER).div(look.visualRange);
    const mist = depthTo(positionWorld);
    const tau = clear.add(mist);
    scene.fogNode = fog(
      mix(toLinear(look.skyHorizon), toLinear(edgeLook.colour), mist.div(max(tau, 1e-6))),
      float(1).sub(exp(tau.negate())),
    );
  }

  async start(): Promise<void> {
    const table = fetch(starsUrl).then((r) => {
      if (!r.ok) {
        throw new Error(`the stars' table: ${r.url} answered ${r.status}`);
      }
      return r.arrayBuffer();
    });
    await this.stage.start();
    this.placeCamera(CAMERA_PRESETS.chase as CameraView);
    const [, stars] = await Promise.all([this.loadBoat(), table]);
    // The boat's, the sea's and the sky's shaders made while the page is
    // covered, so the first frame shown does not wait for them.
    void this.stage.compile(this.stage.scene).catch(() => undefined);
    this.stars.load(stars, catalog.sky.stars);
    // A device in WebGPU's compatibility mode draws the brighter stars only.
    if (this.stage.gfx?.compat === true) {
      this.stars.setCount(this.stars.brighterThan(FEW_STARS));
    }
  }

  /**
   * Lets the sky follow the rule: the physics module to ask, and the world's
   * epoch, in microseconds of UTC since 1970, from which with world time it
   * tells sky time. Called again with another epoch, the sky moves to it.
   */
  useSky(physics: Physics, epochUs: number): void {
    if (this.skyPhysics !== physics) {
      writeSkyParams(physics.skyParams, catalog.sky);
      physics.prepareSky();
      this.skyPhysics = physics;
    }
    if (this.skyTime === null) {
      this.skyTime = new SkyTime((e, w) => physics.skyTime(e, w), epochUs);
    } else {
      this.skyTime.epochUs = epochUs;
    }
  }

  /** The sky drawn now at a place: a view of the module's record, read at once. */
  skyFrom(east: number, north: number): Float64Array | null {
    return this.skyPhysics?.skyAt(this.skyAt, east, north) ?? null;
  }

  /**
   * A tap on a boat in view: the boat drawn nearest (x, y) CSS pixels by
   * its sail, within reach pixels of it, as onBoatTap takes it. True if it
   * took the tap.
   */
  onBoatTap: ((east: number, north: number) => boolean) | null = null;

  /** The other boat drawn whose sail is nearest (x, y) CSS pixels, within reach of it: where it is; null for none. */
  boatAt(x: number, y: number, reach = BOAT_TAP): { east: number; north: number } | null {
    const fs = this.fleetSource;
    const canvas = this.stage.gfx?.canvas;
    if (fs === null || canvas === undefined) {
      return null;
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const o = this.origin.world;
    const v = this.#tagAt;
    let best: DrawnBoat | null = null;
    let d = reach;
    for (let i = 0; i < fs.count; i++) {
      const b = fs.drawn[i] as DrawnBoat;
      if (b.opacity < 0.5) {
        continue;
      }
      // Its hull and its sail's middle: a tap on either is on the boat.
      for (const up of [0.5, SAIL_TAP_HEIGHT]) {
        v.set(b.east - o.x, up + b.heave, -(b.north - o.y)).project(this.stage.camera);
        if (v.z < -1 || v.z > 1) {
          continue;
        }
        const dist = Math.hypot(((v.x + 1) / 2) * w - x, ((1 - v.y) / 2) * h - y);
        if (dist < d) {
          d = dist;
          best = b;
        }
      }
    }
    return best === null ? null : { east: best.east, north: best.north };
  }

  /** A tap on the open sea at (x, y) CSS pixels: a boat there taken by onBoatTap, or a named star there shows its name. */
  tap(x: number, y: number, now: number): string | null {
    const boat = this.onBoatTap === null ? null : this.boatAt(x, y);
    if (boat !== null && this.onBoatTap?.(boat.east, boat.north) === true) {
      return null;
    }
    const canvas = this.stage.gfx?.canvas;
    if (canvas === undefined || !this.drawSky) {
      return null;
    }
    return (
      this.stars.tap(x, y, this.stage.camera, canvas.clientWidth, canvas.clientHeight, now)?.name ??
      null
    );
  }

  /**
   * The player's own sailor's look, a look code: the boat's sailor and the
   * fleet's first look are loaded in it once it is known, and not before,
   * so that the first download carries only the player's own look. Later
   * calls draw the boat's sailor in the look given (showLook), unless once.
   */
  sailAs(code: number, once = false): void {
    if (this.#ownLook === null) {
      this.#ownLook = code;
      this.#lookKnown();
    } else if (!once) {
      void this.showLook(code);
    }
  }

  /**
   * Draws the sailor of the boat in view in a look: the player's own, or the
   * one watched; while others are aboard, the sailor at the helm is whoever
   * holds the controls, in their look (showCrew).
   */
  showLook(code: number): Promise<void> {
    this.#lookShown = code;
    return this.#drawHelm();
  }

  /**
   * Who is aboard the boat in view: whoever holds the controls drawn at the
   * helm, as its one sailor is, the others at their stations; null for
   * nobody but the one sailor.
   */
  showCrew(crew: CrewShown | null): Promise<void> {
    this.#crewShown = crew;
    this.crew.set(crew);
    return this.#drawHelm();
  }

  /** The look the sailor at the helm is drawn in: whoever holds the controls', else the look last asked for. */
  #helmCode(): number {
    const crew = this.#crewShown;
    // Aboard a ship, whoever is at the wheel until relieved.
    const wheel = this.crew.wheelSeat;
    const atWheel =
      crew === null || wheel === null
        ? null
        : (crew.people.find((p) => p.seat === wheel)?.look ?? null);
    return (
      atWheel ??
      (crew === null ? null : helmLook(crew)) ??
      this.#lookShown ??
      this.#ownLook ??
      PERSON_DEFAULT
    );
  }

  /** The ship's moment, as her company's rules need it: filled each frame. */
  readonly #shipMoment = { yards: 0, foreYards: 0, reef: 0, heel: 0, wind: 0, time: 0 };

  /** The seat drawn at the wheel when the helm was last drawn: a relief taking the spokes draws it again. */
  #wheelDrawn: number | null = null;

  /** Whether the sailor at the helm is drawn in the look it is to be: whoever holds the controls'. */
  get helmDrawn(): boolean {
    return this.boat?.drawnLook()?.model === sailorLookOf(catalog, this.#helmCode()).art.model;
  }

  #drawHelm(): Promise<void> {
    this.#wearHelm();
    if (this.#crewShown === null && this.#lookShown === null && this.#ownLook === null) {
      return Promise.resolve();
    }
    // The sail's mark is the skipper's: a machine sailor's boat carries it.
    const crew = this.#crewShown;
    const skipper = crew?.people.find((p) => p.seat === 0);
    const helm = sailorLookOf(catalog, this.#helmCode());
    const mark = skipper === undefined ? helm.machine : sailorLookOf(catalog, skipper.look).machine;
    return this.boat?.setLook(helm, mark) ?? Promise.resolve();
  }

  /** The look the boat in view's sailor was last asked to be drawn in; null for the player's own. */
  #lookShown: number | null = null;
  /** Who is aboard the boat in view, as last told; null for nobody but its sailor. */
  #crewShown: CrewShown | null = null;
  /** The boat's sailor as her crew follow them, and how she lies, each frame. */
  readonly #sailorNow: SailorNow = { mode: 0, heel: 0, trim: 0, offset: 0, net: null };
  readonly #lie = { pitch: 0, heave: 0, aft: 0 };

  /**
   * The sailors seated, the own boat's and the fleet's first look, once the
   * player's look is known; the boat sails without until then.
   */
  sailorsLoaded: Promise<void> = Promise.resolve();
  /** Whether the own boat's sailor is seated. */
  sailorReady = false;

  async #loadSailors(boat: Boat): Promise<void> {
    const renderer = this.stage.renderer;
    if (renderer === null) {
      // A page that draws nothing seats no sailor.
      this.sailorReady = true;
      return;
    }
    await this.#lookAsked;
    const look = sailorLookOf(catalog, this.#ownLook ?? PERSON_DEFAULT);
    await Promise.all([
      // At the helm, whoever holds the controls, if others are aboard.
      boat.loadSailor(sailorLookOf(catalog, this.#helmCode()), renderer, 1),
      this.fleet.loadSailors(catalog, look, renderer, lazyArtUrl),
    ]);
    if (this.#crewShown !== null) {
      await this.#drawHelm();
    }
    const looks = this.fleet.looks;
    if (looks !== null) {
      this.crew.useLooks(looks, Math.max(...catalog.boats.map((b) => b.stations.length)));
      this.crews.useLooks(looks);
    }
    Shadows.cast(boat.model, this.shadows.on, this.shadows.lit);
    // A change of kind meanwhile seats its own boat's sailor.
    if (this.#loadingKind < 0 && this.boat === boat) {
      this.sailorReady = true;
    }
  }

  #ownLook: number | null = null;
  #lookKnown: () => void = () => {};
  readonly #lookAsked = new Promise<void>((resolve) => {
    this.#lookKnown = resolve;
  });

  /** The own boat's kind. */
  get kind(): BoatKind {
    return catalog.boats[this.kindIndex] ?? catalog.boats[0];
  }

  /** The own boat's model for each kind it has been, kept for a change back. */
  readonly #boats = new Map<number, Boat>();
  /** The kind being loaded, the latest asked for. */
  #loadingKind = -1;

  /**
   * The boat in view's own look: a boat look code (negative for none told)
   * and its name, drawn on every kind the own boat has been, and on each
   * it becomes.
   */
  setBoatLook(look: number, name: string): void {
    this.#boatLook = { look, name };
    for (const b of this.#boats.values()) {
      b.setBoatLook(look, name);
    }
  }

  #boatLook = { look: -1, name: '' };

  /**
   * What the boat in view, the own or the one watched, flies for its
   * skipper's races: a prize code (render/prizes.ts), its race number
   * while it races (on its sail), on every kind the own boat has been.
   */
  setPrizes(code: number, number: number): void {
    this.#prizes = { code: code >>> 0, number };
    for (const b of this.#boats.values()) {
      b.setRaceNumber(number);
    }
    this.#wearHelm();
  }

  /**
   * The winner's cockade on the sailor drawn at the helm, if they wear it:
   * the skipper's by the boat's prizes; whoever of the crew holds the
   * controls (or the wheel), by their own.
   */
  #wearHelm(): void {
    const crew = this.#crewShown;
    const seat = crew === null ? 0 : (this.crew.wheelSeat ?? crew.holder);
    const at = crew?.people.find((p) => p.seat === seat);
    const on = at?.cockade ?? (seat === 0 && cockadeOf(this.#prizes.code));
    for (const b of this.#boats.values()) {
      b.wearCockade(on);
    }
  }

  #prizes = { code: 0, number: 0 };

  /** The own boat's prizes, as setPrizes was last told. */
  get ownPrizes(): { code: number; number: number } {
    return this.#prizes;
  }

  /**
   * Loads the boat, and its sailor once the player's look is known
   * (sailAs). Its sails carry its kind's insignia.
   */
  async loadBoat(): Promise<void> {
    const [boat] = await Promise.all([this.#boatOf(this.kindIndex), this.fleet.load()]);
    this.sailorsLoaded = this.#loadSailors(boat).catch((e: unknown) => {
      console.error('the sailors did not load', e);
    });
    this.#show(boat);
  }

  /** A kind's own boat: loaded the first time it is asked for. */
  async #boatOf(kind: number): Promise<Boat> {
    const had = this.#boats.get(kind);
    if (had !== undefined) {
      return had;
    }
    const k = catalog.boats[kind] ?? catalog.boats[0];
    const boat = new Boat(k, catalog);
    await boat.load(k.name.slice(0, 1));
    boat.setBoatLook(this.#boatLook.look, this.#boatLook.name);
    boat.setRaceNumber(this.#prizes.number);
    this.#boats.set(kind, boat);
    this.#wearHelm();
    return boat;
  }

  /**
   * The own boat becomes one of another kind: its model, its sailor, the
   * overlays, lanterns, hull and wake, the camera and the shadows, all of
   * the kind's. Its sailor is seated again, so the world under the cover
   * waits for it (sailorReady). Resolves once it is drawn.
   */
  async useKind(kind: number): Promise<void> {
    if (catalog.boats[kind] === undefined) {
      return;
    }
    if (kind === this.kindIndex && this.boat !== null && this.#loadingKind < 0) {
      return;
    }
    this.kindIndex = kind;
    this.#loadingKind = kind;
    if (this.boat === null) {
      // Not started yet: start() loads this kind.
      this.#loadingKind = -1;
      return;
    }
    this.sailorReady = false;
    const boat = await this.#boatOf(kind);
    if (this.#loadingKind !== kind) {
      // Another kind was asked for meanwhile.
      return;
    }
    this.#loadingKind = -1;
    const renderer = this.stage.renderer;
    if (boat.sailor === null && renderer !== null) {
      await this.#lookAsked;
      await boat.loadSailor(sailorLookOf(catalog, this.#helmCode()), renderer, 1);
    }
    if (this.kindIndex !== kind) {
      return;
    }
    this.#show(boat);
    this.sailorReady = true;
  }

  /** Puts a boat on the sea as the own one, and sizes everything to it. */
  #show(boat: Boat): void {
    const kind = boat.kind;
    const was = this.boat;
    if (was !== null && was !== boat) {
      this.stage.scene.remove(was.root);
    }
    boat.model.add(this.overlays.onBoat);
    this.crew.aboard(boat.model, this.#crewPlan(boat));
    Shadows.cast(boat.model, this.shadows.on, this.shadows.lit);
    this.overlays.setKind(kind);
    this.rightOfWay.setKind(kind);
    // Its lights at their nodes' places in the model, wherever they hang.
    this.#kindParts(this.kindIndex, (name) => boat.nodeAt(name), boat.parts.get('hull')?.userData);
    // The camera and the shadows' box sized to the boat.
    const size = sizeOf(kind, catalog.boats[0]);
    this.camera.size = size;
    this.camera.lookSize = lookSizeOf(kind, catalog.boats[0]);
    this.shadows.scale = size;
    this.boat = boat;
    this.stage.scene.add(boat.root);
    if (was !== null && was !== boat) {
      void this.#apply(false);
    }
  }

  /** A boat's crew's plan: its kind's stations, its deck (its model's hull solid) and its boom. */
  #crewPlan(boat: Boat): CrewPlan {
    const kind = boat.kind;
    const solid = hullSolid(boat.parts.get('hull')?.userData, boat.nodeAt('board-root'), {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    const model = boat.model.children[0];
    const plan = crewPlan(
      kind.stations,
      solid,
      boat.nodeAt('boom'),
      kind.physics.rig.foot,
      model === undefined ? null : modelDeck(model, namesYachtClips(kind.art) ? STEPPED : []),
      model === undefined ? null : tillerOf(model),
    );
    // A ship: her company's places and ways, which her model marks; a
    // beach cat, her people's places; a cruising yacht, her deck.
    plan.ship = shipPlan(kind.stations, company(boat.parts));
    plan.cat = namesCatClips(kind.art)
      ? catOf(boat.model, boat.parts, kind.physics.rig.foot)
      : null;
    plan.yacht = namesYachtClips(kind.art) ? yachtBoat(boat.parts) : null;
    plan.bridge = namesBridgeClips(kind.art) ? bridgeCrew(bridgeBoat(boat.parts)) : null;
    plan.cog = kind.physics.hull.centreOfGravity;
    return plan;
  }

  /**
   * A kind's parts the sea and the lanterns place by: its lanterns at its
   * lights' nodes, its hull for the sea and the wake. Each is told once.
   */
  #kindParts(kind: number, node: (name: string) => Vector3 | null, hullData: unknown): void {
    const k = catalog.boats[kind];
    if (k === undefined) {
      return;
    }
    const cog = k.physics.hull.centreOfGravity;
    if (!this.lanterns.has(kind)) {
      const lanterns: BoatLantern[] = [];
      for (const light of k.lights) {
        const at = node(light);
        if (at !== null) {
          lanterns.push({ at: at.clone(), lights: [light] });
        }
      }
      if (lanterns.length > 0) {
        this.lanterns.setKind(kind, lanterns, cog);
      }
    }
    const shape = hullShape(hullData);
    if (shape !== null && !hulls.has(kind)) {
      hulls.setShape(shape, cog, kind);
      const s = shape.stations;
      this.ocean.wakes.setHull(
        {
          aft: s[0]?.[0] ?? 0,
          fore: s[s.length - 1]?.[0] ?? 0,
          halfBeam: Math.max(...s.map((st) => st[1] ?? 0)),
          transomFrom: transomFrom(k.physics.hull.waterlineLength),
        },
        kind,
      );
      this.ocean.wakeWaves.setShape(shape, kind);
    }
  }

  /** Draws a world's land, as the land is handed. */
  useLand(land: Land): void {
    if (this.land !== null) {
      this.stage.scene.remove(this.land.group);
    }
    this.land = land;
    this.stage.scene.add(land.group);
    // Both cameras keep out of the land's solids and the lighthouses' towers.
    land.solids.towers = this.lighthouses;
    this.camera.solids = land.solids;
    this.freeCam.solids = land.solids;
    this.#lands++;
  }

  setUsePass(on: boolean): void {
    this.usePass = on;
    this.ocean.choose(on, this.stage.gfx?.floatTargets ?? true);
  }

  /** Puts the camera at a view behind the boat as it is now; the view becomes its resting one. */
  placeCamera(v: CameraView): void {
    this.camera.place(v, this.pose.heading, this.pose.heave, this.#seaUnderBoat());
    this.#updateBoatScene();
    this.#placeCamera();
  }

  /**
   * The first view of a boat just set down: the view past it at the
   * harbour's mouth where it opens on one, the camera swung to it at once;
   * otherwise behind it, resting.
   */
  placeFirstView(): void {
    if (this.camera.opening) {
      this.camera.settle(this.pose.heading, this.pose.heave, this.#seaUnderBoat());
      this.#updateBoatScene();
      this.#placeCamera();
    } else {
      this.placeCamera(this.camera.rest);
    }
  }

  /** Whether the frame loop is to draw once the world is ready: not on a page under test, nor one without a renderer. */
  get drawsWhenReady(): boolean {
    return !this.underTest && this.stage.wanted !== 'none';
  }

  /** Holds the camera where it is, looking at the boat wherever it goes. */
  holdCamera(): void {
    const p = this.stage.camera.position;
    this.camera.held = { x: p.x, y: p.y, z: p.z };
  }

  /** Lets the camera follow the boat again, behind it as it rests. */
  releaseCamera(): void {
    this.camera.held = null;
    this.placeCamera(this.camera.rest);
  }

  /**
   * Starts the free camera from where the camera is and the way it looks;
   * the scene follows it from the next frame.
   */
  flyFree(): void {
    const cam = this.stage.camera;
    const p = cam.position;
    const o = this.origin.world;
    const e = cam.matrixWorld.elements;
    // The camera looks down its −z axis.
    const dy = -(e[9] ?? 0);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
    this.freeCam.enter(p.x + o.x, -p.z + o.y, p.y, this.lookBearing(), pitch);
  }

  /** Brings the camera back to the boat, behind it at once. */
  landFree(): void {
    if (!this.freeCam.on) {
      return;
    }
    this.freeCam.leave();
    this.camera.held = null;
    this.placeCamera(this.camera.rest);
  }

  /** Where the camera looks, as a bearing: radians clockwise from north. */
  lookBearing(): number {
    const e = this.stage.camera.matrixWorld.elements;
    // The camera looks down its −z axis: east is the scene's x, north its −z.
    return Math.atan2(-(e[8] ?? 0), e[10] ?? 1);
  }

  /** Fades the screen to the mist's colour by this much, 0 to 1: going over the lip. */
  setFade(amount: number): void {
    this.#fadeOver = amount;
    this.#applyFade();
  }

  /** The fade: going over the lip, or the world's end's veil, whichever is more. */
  #applyFade(): void {
    const amount = Math.max(this.#fadeOver, this.#veil);
    const words = this.#words;
    if (words !== this.#veilWords) {
      this.#veilWords = words;
      this.fade.classList.toggle('world-end', words);
    }
    const f = this.fade;
    if (amount <= 0) {
      if (f.style.opacity !== '0') {
        f.style.opacity = '0';
      }
      return;
    }
    const c = edgeLook.colour.value as Color;
    f.style.backgroundColor = `rgb(${Math.round(255 * c.r)}, ${Math.round(255 * c.g)}, ${Math.round(255 * c.b)})`;
    f.style.opacity = String(Math.min(amount, 1));
  }

  /** A new world, after the end: it rises out of the mist from the next frame, already since seconds in. */
  rise(since = 0): void {
    this.#riseIn = since;
  }

  /**
   * The world's end, staged by the time left: the mist closing in, the near
   * sea breaking away about the boat, the screen fading to the mist; and a
   * new world rising out of it.
   */
  #stageEnd(now: number): void {
    const left = this.endIn?.() ?? Number.POSITIVE_INFINITY;
    const st = endStage(END_LOOK, left);
    this.endStage = st;
    const cut = Number.isFinite(st.cut);
    endLook.on.value = cut ? 1 : 0;
    endLook.cut.value = cut ? st.cut : 1e9;
    // The far sea goes first, with the edge of the near sea.
    this.ocean.far.mesh.visible = !cut;
    (endLook.centre.value as Vector2).set(this.pose.east, this.pose.north);
    let mist = st.mist;
    let veil = st.veil;
    if (!Number.isNaN(this.#riseIn)) {
      this.#risingFrom = now - this.#riseIn * 1000;
      this.#riseIn = Number.NaN;
    }
    if (!Number.isNaN(this.#risingFrom)) {
      const r = risen(END_LOOK, (now - this.#risingFrom) / 1000);
      mist = Math.max(mist, 1 - r);
      veil = Math.max(veil, 1 - r);
      if (r >= 1) {
        this.#risingFrom = Number.NaN;
      }
    }
    // The sky sets the clear air's range each frame it is read; held, it
    // keeps the last, which the mist must not close again.
    const range = look.visualRange.value as number;
    if (range !== this.#mistedRange) {
      this.#clearRange = range;
    }
    this.#mistedRange = closedIn(this.#clearRange, mist);
    look.visualRange.value = this.#mistedRange;
    this.endSlabs.frame(END_LOOK, left, this.pose.east, this.pose.north, this.#groundAt);
    // The mist over everything, the sea too, thickening as it closes in;
    // the screen the mist itself, with its words, at the end and as the
    // new world rises.
    const words = veil > 0;
    veil = Math.max(veil, MIST_VEIL * mist);
    if (veil !== this.#veil || words !== this.#words) {
      this.#veil = veil;
      this.#words = words;
      this.#applyFade();
    }
  }

  #attached(gfx: Gfx): void {
    this.shadows.attached(gfx.renderer);
    this.ocean.detail.attached();
    this.ocean.compute = gfx.backend === 'webgpu';
    this.ocean.wakeWaves.clear();
    this.ocean.choose(this.usePass, gfx.floatTargets);
    this.boat?.attached(gfx);
    const now = performance.now();
    if (this.quality === null) {
      this.#start(gfx);
    } else {
      // A new renderer after a loss: its first frames compile everything again.
      this.quality.quiet(now);
      this.stats.restart(now);
    }
    this.#started = -1;
    void this.#apply(false);
  }

  /** Makes the ladder for this renderer and the player's choice, and starts where the device settled. */
  #start(gfx: Gfx): void {
    const start = startQuality(gfx.backend, gfx.compat, this.#query, this.detail, this.#store);
    this.top = start.top;
    this.quality = new Adaptive(start.ladder, start.index);
    this.quality.enabled = start.adaptive;
    this.stage.ratio = (dpr) => pixelRatioOf(this.rung, dpr);
  }

  /** The rung in use. */
  get rung(): Rung {
    const q = this.quality;
    return q === null
      ? { tier: 'low', scale: 1, shadows: false, detail: { kind: 'none' } }
      : q.rung;
  }

  /** The tier in use. */
  get tier(): Tier {
    return TIERS[this.rung.tier];
  }

  /** The player's choice of detail, from the menu: the ladder starts over from it. */
  setDetail(detail: 'auto' | 'low'): void {
    if (detail === this.detail) {
      return;
    }
    this.detail = detail;
    const g = this.stage.gfx;
    if (g !== null && this.quality !== null) {
      const was = this.quality;
      this.#start(g);
      this.quality.log.push(...was.log);
      void this.#apply(true);
    }
  }

  /** Moves to a rung of the ladder by hand (the developer panel, the tests). */
  setRung(index: number, why = 'set'): Promise<void> {
    this.quality?.set(performance.now(), index, why);
    return this.#apply(true);
  }

  /**
   * Brings the scene to the rung in use: the render scale, the sea's look,
   * the foam map. A change of the sea's shaders is compiled before it is
   * drawn when ahead is set, and adaptive quality judges nothing until it
   * is in and a second has passed.
   */
  async #apply(ahead: boolean): Promise<void> {
    const q = this.quality;
    if (q === null) {
      return;
    }
    const change = ++this.#applying;
    const rung = q.rung;
    const tier = TIERS[rung.tier];
    q.quiet(performance.now(), Number.POSITIVE_INFINITY);
    this.stage.resize();
    const sh = this.shadows;
    sh.set(
      tier,
      rung.shadows,
      q.ladder.some((r) => TIERS[r.tier].shadowMap > 0),
    );
    if (this.boat !== null) {
      Shadows.cast(this.boat.model, sh.on, sh.lit);
    }
    // The other boats receive on every rung the light casts, so that their
    // shaders never change; they cast only where the tier has them do so.
    this.fleet.castShadows(sh.fleet, sh.lit);
    // The light's casting changes every lit material's shader: compiled off
    // the frame first, and swapped in once ready. The compiler reads the
    // light as it is when called, so the light is changed for that call and
    // put back until the shaders are in.
    let lit: Promise<void> = Promise.resolve();
    const was = sh.light.castShadow;
    if (sh.lit !== was) {
      sh.light.castShadow = sh.lit;
      if (ahead) {
        const casters = [this.boat?.root, this.fleet.root].filter((o) => o !== undefined);
        lit = Promise.all(casters.map((o) => this.stage.compile(o))).then(() => undefined);
        sh.light.castShadow = was;
      }
    }
    this.spray.capacity = tier.spray;
    // The low tier draws only what of the animals breaks the surface.
    this.swimmers.setTint(tier.name !== 'low');
    this.weather.setCapacity(tier.puffs, tier.streaks);
    this.onQuality?.(tier.number, this.stage.pixelRatio());
    await Promise.all([
      lit,
      this.ocean.setQuality(
        {
          detail: rung.detail,
          anisotropy: tier.anisotropy,
          foamMap: tier.foamMap,
          wakeWaves: tier.wakeWaves,
        },
        ahead ? (o) => this.stage.compile(o) : null,
        this.stage.gfx?.renderer ?? null,
      ),
    ]);
    if (change === this.#applying) {
      sh.light.castShadow = sh.lit;
    }
    if (change === this.#applying) {
      const now = performance.now();
      q.unquiet(now);
      this.stats.restart(now);
    }
  }

  /** A window of frames closed: adaptive quality judges it, and the scene takes the step it asks for. */
  #window(now: number, st: FrameStats): void {
    const q = this.quality;
    const cap = this.stage.cap;
    if (q === null || !q.enabled) {
      return;
    }
    const w: FrameWindow = {
      frames: st.frames,
      p90: st.p90,
      interval: cap.interval,
      gpu: st.gpu,
      work: st.workMedian,
    };
    this.lastWindow = w;
    // A page called for a frame every 33 ms is slow, or its display is: the
    // display is measured again before the window is believed.
    if (
      w.interval > 0 &&
      w.p90 > SLOW * w.interval &&
      q.index < q.ladder.length - 1 &&
      now - cap.probed > PROBE_AFTER + 2 * this.stats.window
    ) {
      cap.probe();
      return;
    }
    if (q.window(now, w) !== null) {
      remember(this.#store, this.top, q.index);
      void this.#apply(true);
    }
  }

  /** The steps adaptive quality took, in words, the latest last. */
  qualityLog(): string[] {
    const q = this.quality;
    if (q === null) {
      return [];
    }
    return q.log.map(
      (s) => `${(s.at / 1000).toFixed(1)} s  ${s.why}: ${rungName(q.ladder[s.to] as Rung)}`,
    );
  }

  /**
   * Tells the sea which hulls to keep out of: the player's own, and the
   * nearest others within reach that have faded in; and every boat drawn
   * to the wakes: the wake's waves it pushes on, and the foam map's track
   * and white water, by its speed through the water.
   */
  #placeHulls(): void {
    const p = this.pose;
    const bs = this.boatScene;
    const speed = this.out[RECORDS.out.speedThroughWater] ?? 0;
    const own = this.kindIndex;
    hulls.begin();
    hulls.add(bs.x, bs.y + p.heave, bs.z, p.heading, p.heel, p.pitch, own);
    const ocean = this.ocean;
    // The current at the boat, in which the wakes drift.
    const physics = ocean.source?.physics ?? null;
    const current = ocean.current;
    if (physics !== null) {
      physics.current(p.east, p.north, this.#current);
      current.east = this.#current[0] ?? 0;
      current.north = this.#current[1] ?? 0;
    } else {
      current.east = 0;
      current.north = 0;
    }
    ocean.heading = p.heading;
    const wakes = ocean.wakes;
    const waves = ocean.wakeWaves;
    wakes.begin();
    waves.begin();
    // The hull deeper than at rest where the sea under it stands above it:
    // a boat that bobs makes rings. Each of a boat's hulls makes its own
    // wake, and one lifted clear of the water none.
    const sink = Math.min(Math.max(this.#seaUnderBoat() - p.heave, -SINK_MOST), SINK_MOST);
    const room = this.#hullRoom;
    const kinds = catalog.boats;
    const ownHull = this.kind.physics;
    for (
      let h = eachHull(ownHull.hulls.hullSpacing, p.east, p.north, p.heading, p.heel, room);
      h-- > 0;
    ) {
      const at = room[h] as HullAt;
      if (at.lift < ownHull.hull.hullDraught) {
        wakes.add(at.east, at.north, p.heading, speed, own);
        waves.add(at.east, at.north, p.heading, sink - at.lift, own);
      }
    }
    const fs = this.fleetSource;
    if (fs === null) {
      this.#stampLife();
      return;
    }
    // Every boat drawn makes a wake; the map and the waves keep those within
    // their squares. A boat's drawn speed is over the ground: through the
    // water it is that less the current.
    for (let i = 0; i < fs.count; i++) {
      const b = fs.drawn[i] as DrawnBoat;
      if (b.opacity >= 0.5) {
        const ve = b.speed * Math.sin(b.heading) - current.east;
        const vn = b.speed * Math.cos(b.heading) - current.north;
        const k = (kinds[b.kind] ?? this.kind).physics;
        for (
          let h = eachHull(k.hulls.hullSpacing, b.east, b.north, b.heading, b.heel, room);
          h-- > 0;
        ) {
          const at = room[h] as HullAt;
          if (at.lift < k.hull.hullDraught) {
            wakes.add(at.east, at.north, b.heading, Math.hypot(ve, vn), b.kind);
            waves.add(at.east, at.north, b.heading, -at.lift, b.kind);
          }
        }
      }
    }
    // The sea's life's after the boats', in what room is left.
    this.#stampLife();
    // The nearest, kept in order of distance as they are found.
    const near = this.#near;
    const dist = this.#nearDist;
    let n = 0;
    for (let i = 0; i < fs.count; i++) {
      const b = fs.drawn[i] as DrawnBoat;
      const d = Math.hypot(b.east - p.east, b.north - p.north);
      if (d > HULL_REACH || b.opacity < 0.5) {
        continue;
      }
      let k = Math.min(n, HULLS - 2);
      if (n === HULLS - 1 && d >= (dist[k] ?? 0)) {
        continue;
      }
      for (; k > 0 && (dist[k - 1] ?? 0) > d; k--) {
        near[k] = near[k - 1] ?? 0;
        dist[k] = dist[k - 1] ?? 0;
      }
      near[k] = i;
      dist[k] = d;
      n = Math.min(n + 1, HULLS - 1);
    }
    const o = this.origin.world;
    for (let k = 0; k < n; k++) {
      const b = fs.drawn[near[k] ?? 0] as DrawnBoat;
      hulls.add(b.east - o.x, b.heave, -(b.north - o.y), b.heading, b.heel, b.pitch, b.kind);
    }
  }

  /** The sea's height under the boat, by the latest step. */
  #seaUnderBoat(): number {
    return this.out[RECORDS.out.waveHeight] ?? 0;
  }

  #updateBoatScene(): void {
    const p = this.pose;
    const f = this.focus;
    const free = this.freeCam;
    f.east = free.on ? free.east : p.east;
    f.north = free.on ? free.north : p.north;
    this.origin.follow(f.east, f.north);
    this.origin.toScene(p.east, p.north, 0, this.boatScene);
    this.origin.toScene(f.east, f.north, 0, this.focusScene);
  }

  #placeCamera(): void {
    const bs = this.boatScene;
    const camera = this.stage.camera;
    if (this.freeCam.on) {
      const o = this.origin.world;
      camera.up.set(0, 1, 0);
      this.freeCam.place(o.x, o.y, camera.position, this.#target);
    } else {
      this.camera.place3(bs.x, bs.y, bs.z, camera.position, this.#target, camera.up);
    }
    camera.lookAt(this.#target);
    // The scene pass reads the camera's matrices before the render updates
    // them; without this the picture would lag the camera by a frame.
    camera.updateMatrixWorld();
  }

  /** The clouds, the sheets and the rain for the frame, from the module's weather; and what they do to the light. */
  #skyWeather(camera: Vector3): void {
    const source = this.ocean.source;
    const o = this.origin.world;
    const w = this.weather;
    const speed = this.wind.meanSpeed;
    w.frame(source?.weather === true ? source.physics : null, {
      tick: this.ticks,
      seconds: this.ticks / STEPS_PER_SECOND,
      dt: this.timeStep,
      camera,
      cameraEast: camera.x + o.x,
      cameraNorth: -camera.z + o.y,
      originEast: o.x,
      originNorth: o.y,
      sunHeight: this.sky.now.sunHeight,
      windEast: -speed * Math.sin(this.wind.meanFrom),
      windNorth: -speed * Math.cos(this.wind.meanFrom),
    });
    this.sky.overcast = w.overcast;
    // The water's rain: the grid's, and the camera's on the far sea.
    const water = this.ocean.gusts.water;
    water.heldRain = w.heldRain;
    water.rainFar.value = rainShare(w.rain);
    const physics = source?.weather === true ? source.physics : null;
    this.#air(physics, camera, w.heldRain);
    // The flashes: each slot's from the module, the cloud a flash lights
    // and its bolt; more of the flash's light by night.
    const sun = this.sky.now.sunHeight;
    this.lightning.frame(physics, {
      tick: this.ticks,
      seconds: this.ticks / STEPS_PER_SECOND,
      camera,
      origin: o,
      night: Math.min(Math.max(-sun / (6 * (Math.PI / 180)) + 0.5, 0), 1),
      on: this.drawSky && w.shown,
    });
    const c = this.lightning.cloud;
    (w.clouds.flash.value as Vector4).set(c.x, c.y, c.z, c.strength);
  }

  /**
   * The weather's fog and rain along each ray: the module's sources of
   * extinction near the camera into the materials' uniforms, a rain held
   * at the camera as one that is the same everywhere; and the visibility at
   * the camera, which the sea's horizon blend is held within.
   */
  #air(physics: Physics | null, camera: Vector3, held: number | null): void {
    const o = this.origin.world;
    const east = camera.x + o.x;
    const north = -camera.z + o.y;
    airLook.seconds.value = this.ticks / STEPS_PER_SECOND;
    if (physics === null) {
      airLook.count.value = 0;
      this.sky.cameraRange = Number.POSITIVE_INFINITY;
      return;
    }
    physics.windDrawAt(this.ticks);
    setAirSources(physics.airSources(east, north, AIR_REACH).records, RECORDS.airSource);
    let range = physics.visibilityAt(east, north);
    if (held !== null && held > 0.05) {
      const v = physics.rainVisibility(held, 0);
      heldRain(KOSCHMIEDER / v, catalog.weather.clouds.low);
      range = 1 / (1 / range + 1 / v);
    }
    this.sky.cameraRange = range;
  }

  /** Asks the module for the sky at the boat at the frame's time, and lights the scene by it. */
  #readSky(): void {
    const physics = this.skyPhysics;
    const time = this.skyTime;
    if (physics === null || time === null || this.holdSky) {
      return;
    }
    this.skyAt = time.frame(this.ticks);
    this.skyRecord.set(physics.skyAt(this.skyAt, this.focus.east, this.focus.north));
    this.sky.read(this.skyRecord);
    this.stars.turn(this.skyRecord, SKY.stars);
  }

  /**
   * How dark the sky is for glowing water to show, 0 to 1 (glowDark), by
   * the sky as last read at the focus: the sun's and the moon's true
   * heights and the moon's lit share. The moon's light at the most for it
   * to show is the limit (the catalog's glow.moon). 0 while the sky is not
   * drawn (the tests). Allocates nothing.
   */
  skyDark(limit: number): number {
    if (!this.drawSky) {
      return 0;
    }
    const n = this.sky.now;
    return glowDark(n.sunHeight, n.moonHeight, n.lit, limit);
  }

  /** The lanterns of the player's boat and of the others, each lit by the sun at its own boat. */
  #drawLanterns(height: number, camera: Vector3): void {
    const l = this.lanterns;
    l.begin();
    const sun = SKY.sun + BODY.altitude;
    const p = this.pose;
    const bs = this.boatScene;
    const own = this.sky.now.sunHeight;
    // The cabins' lamps, as the lanterns are lit: every gallery by the sun here.
    lampsLit.value = this.drawSky ? lanternLit(own) : 0;
    if (this.drawSky && this.boat?.root.visible) {
      l.add(p, bs.x, bs.z, camera, lanternLit(own), this.kindIndex);
    }
    const fs = this.fleetSource;
    const o = this.origin.world;
    for (let i = 0; this.drawSky && fs !== null && i < fs.count; i++) {
      const b = fs.drawn[i] as DrawnBoat;
      if (b.opacity <= 0) {
        continue;
      }
      const at = this.skyFrom(b.east, b.north);
      const height = at === null ? own : (at[sun] ?? 0);
      l.add(b, b.east - o.x, -(b.north - o.y), camera, lanternLit(height) * b.opacity, b.kind);
    }
    // The lanterns ashore, the nearest, lit by the sun at the camera.
    const land = this.land;
    if (land !== null && this.drawSky) {
      const lit = lanternLit(own);
      const ce = camera.x + o.x;
      const cn = -camera.z + o.y;
      const ashore = land.towns
        .features()
        .lanterns.map((t) => ({ t, d: Math.hypot(t.east - ce, t.north - cn) }))
        .filter((x) => x.d < 1500)
        .sort((a, b) => a.d - b.d)
        .slice(0, TOWN_LANTERNS);
      for (const { t } of ashore) {
        l.addAshore(t.east - o.x, t.top, -(t.north - o.y), lit);
      }
    }
    // The race committee's lanterns: the marks' and the committee boats' riding lights.
    const race = this.race;
    for (let i = 0; this.drawSky && i < race.lanternCount; i++) {
      const r = race.lanterns;
      l.addAshore(r[3 * i] ?? 0, r[3 * i + 1] ?? 0, r[3 * i + 2] ?? 0, lanternLit(own));
    }
    l.commit(this.stage.camera.fov, height);
  }

  /**
   * The towns: their buildings near and far, their lamps lit by the sun at
   * the camera; their flags and their chimneys' smoke in the true wind
   * where each is, asked of the physics module every few frames.
   */
  #drawTowns(camera: Vector3, now: number): void {
    const land = this.land;
    const o = this.origin.world;
    if (land === null) {
      this.flags.frame([], o, 0);
      this.smoke.frame([], o, 0, 1);
      this.cones.frame([], o, null);
      return;
    }
    const cameraEast = camera.x + o.x;
    const cameraNorth = -camera.z + o.y;
    const night = this.drawSky ? lanternLit(this.sky.now.sunHeight) : 0;
    land.towns.frame({ origin: o, cameraEast, cameraNorth, night, cameraHeight: camera.y });
    const wind = this.#windAt(cameraEast, cameraNorth, now);
    land.flora.frame({
      origin: o,
      cameraEast,
      cameraNorth,
      cameraHeight: camera.y,
      rung: ['high', 'medium', 'low'].indexOf(this.rung.tier),
      time: this.ticks / STEPS_PER_SECOND,
      windSpeed: wind.speed,
      windFrom: wind.from,
    });
    land.features.frame({
      origin: o,
      cameraEast,
      cameraNorth,
      cameraHeight: camera.y,
      time: this.ticks / STEPS_PER_SECOND,
      light: 0.25 + 0.75 * (1 - night),
      night: night > 0.5,
      seaHeight: this.sea.height,
      windSpeed: wind.speed,
      windFrom: wind.from,
      birds: this.birds,
    });
    const features = land.towns.features();
    const time = this.ticks / STEPS_PER_SECOND;
    const smoke = catalog.world.towns.smoke;
    const flags: FlagSeen[] = [];
    const chimneys: Chimney[] = [];
    const near = (p: { east: number; north: number }, reach: number): boolean =>
      Math.hypot(p.east - cameraEast, p.north - cameraNorth) <= reach;
    for (const f of features.flags) {
      if (near(f, 2000)) {
        flags.push({ ...f, ...this.#windAt(f.east, f.north, now) });
      }
    }
    for (const c of features.chimneys) {
      if (near(c, smoke.reach) && smokes(c.seed, night > 0.5, smoke)) {
        chimneys.push({ ...c, ...this.#windAt(c.east, c.north, now) });
      }
    }
    this.flags.frame(flags, o, time);
    this.cones.frame(
      features.flags.filter((f) => f.harbour && near(f, 2000)),
      o,
      this.galeUp,
    );
    this.smoke.frame(chimneys, o, time, 0.25 + 0.75 * (1 - night));
  }

  /** The race committee's frame, reused, and the time its winds are asked at. */
  #raceNow = 0;
  readonly #raceFrame: RaceFrame = {
    origin: { x: 0, y: 0 },
    cameraEast: 0,
    cameraNorth: 0,
    time: 0,
    lit: 0,
    light: 1,
    windAt: (east, north) => this.#windAt(east, north, this.#raceNow),
    surface: null,
  };

  /** The race committee's things near the camera: boats, buoys, marks, beacons, flags and smoke. */
  #drawRace(camera: Vector3, now: number, night: number): void {
    const o = this.origin.world;
    const f = this.#raceFrame;
    this.#raceNow = now;
    f.origin = o;
    f.cameraEast = camera.x + o.x;
    f.cameraNorth = -camera.z + o.y;
    f.time = this.ticks / STEPS_PER_SECOND;
    f.lit = night;
    f.light = 0.25 + 0.75 * (1 - night);
    f.surface = this.ocean.source === null ? null : this.#surface;
    this.race.frame(f);
  }

  /** The lands used, so the towns' gulls are found again in a new one. */
  #lands = 0;
  /** The towns' buildings as the gulls' wheels are found from them. */
  readonly #gullSource: GullSource = {
    version: 0,
    buildings: () => this.land?.towns.buildings() ?? [],
  };
  /** The own boat as the life with it reads it, and the life's frame, reused. */
  readonly #lifeOwn: BoatAt = { east: 0, north: 0, heading: 0, speed: 0 };
  readonly #lifeFrame: LifeFrame = {
    ticks: 0,
    cameraEast: 0,
    cameraNorth: 0,
    cameraUp: 0,
    seaHeight: 0,
    low: false,
    night: false,
    own: null,
    fleet: NO_BOATS,
    count: 0,
    bowOf: (kind) => (catalog.boats[kind] ?? this.kind).physics.hull.waterlineLength / 2,
    aboardOf: (kind) => this.#aboardOf(kind),
    windFrom: 0,
    skyDark: (moon) => this.skyDark(moon),
    ownKind: 0,
    dt: 0,
  };
  /** Each boat kind's perch, deck and centre of gravity, by its index, made once. */
  readonly #aboard: (Aboard | undefined)[] = catalog.boats.map((b) => ({
    perch: b.perch,
    deck: b.deck,
    cog: b.physics.hull.centreOfGravity,
  }));
  #aboardOf(kind: number): Aboard | undefined {
    return this.#aboard[kind];
  }

  /** The life's frame at the camera now: the boats a group may be with, the sea, the tier. */
  lifeFrame(camera: Vector3, night: boolean): LifeFrame {
    const o = this.origin.world;
    const f = this.#lifeFrame;
    f.ticks = this.ticks;
    f.cameraEast = camera.x + o.x;
    f.cameraNorth = -camera.z + o.y;
    f.cameraUp = camera.y;
    f.seaHeight = this.sea.height;
    f.low = this.rung.tier === 'low';
    f.night = night;
    const own = this.#lifeOwn;
    own.east = this.pose.east;
    own.north = this.pose.north;
    own.heading = this.pose.heading;
    own.heave = this.pose.heave;
    own.heel = this.pose.heel;
    own.pitch = this.pose.pitch;
    f.windFrom = this.wind.meanFrom;
    own.speed = this.out[RECORDS.out.speedOverGround] ?? 0;
    f.own = this.boat === null ? null : own;
    f.fleet = this.fleetSource?.drawn ?? NO_BOATS;
    f.count = this.fleetSource?.count ?? 0;
    f.ownKind = this.kindIndex;
    f.dt = this.timeStep;
    return f;
  }

  /** The sea's surface under the animals in the water, from the module's sea now. */
  readonly #surface: SurfaceAt = (points, count, out) => {
    const src = this.ocean.source;
    const slot = this.ocean.slot;
    if (src === null || slot < 0) {
      out.fill(0, 0, count);
      return;
    }
    src.physics.seaDrawAt(this.ticks);
    const sea = src.physics.seaSample(slot, points.subarray(0, 2 * count));
    for (let i = 0; i < count; i++) {
      out[i] = sea[i * 4] ?? 0;
    }
  };
  readonly #sunAt = new Vector3();

  /** The sea's life near, and the towns' gulls by day, into the birds' draw. */
  #drawLife(camera: Vector3, night: boolean): void {
    const land = this.land;
    const towns = land === null ? null : this.#gullSource;
    if (land !== null) {
      this.#gullSource.version = this.#lands * 1e9 + land.towns.features().version;
    }
    const light = this.sky.light;
    const sun = this.#sunAt.copy(light.position).sub(light.target.position);
    if (sun.lengthSq() > 0) {
      this.swimmers.sun.value.copy(sun.normalize());
    }
    this.swimmers.begin(this.origin.world, this.ticks / STEPS_PER_SECOND, this.birds.light.value);
    const f = this.lifeFrame(camera, night);
    this.onLife?.(f);
    this.lifeDraw.frame(this.life, f, this.birds, towns, this.swimmers, this.#surface);
    this.swimmers.end();
    // Glowing water about the camera: the wake's white water, the track and
    // the bow's spray drawn as its light.
    const g = this.lifeDraw.glow;
    this.ocean.setGlow(g.r, g.g, g.b, g.strength);
    this.sprayView.setGlow(g.r, g.g, g.b, g.strength);
  }

  /** The sea's life's splashes thrown as spray, and flecks over the boils of bait. */
  #sprayLife(dt: number): void {
    const d = this.lifeDraw;
    const share = this.rung.tier === 'low' ? 0.5 : 1;
    for (let i = 0; i < d.splashCount; i++) {
      const s = d.splashes[i];
      if (s === undefined) {
        continue;
      }
      if (s.size > 1) {
        // A whale's: a wall of white water thrown up as it falls back.
        this.spray.blow(s.east, s.north, 0, 2.5 * s.size, 2.2 * s.size, 0, 0, 0, share);
      } else {
        this.spray.splash(s.east, s.north, 0, s.size);
      }
    }
    for (let i = 0; i < d.blowCount; i++) {
      const b = d.blows[i];
      if (b !== undefined) {
        this.spray.blow(
          b.east,
          b.north,
          b.sea,
          b.height,
          b.width,
          b.heading,
          b.lean,
          b.left,
          share,
        );
      }
    }
    for (let i = 0; i < d.boilCount; i++) {
      const b = d.boils[i];
      if (b === undefined) {
        continue;
      }
      // Small fish breaking the surface, driven up from below.
      let owed = dt * 20 * b.strength;
      while (owed > 0) {
        this.#boilSeed = (Math.imul(this.#boilSeed, 1103515245) + 12345) >>> 0;
        if (owed < 1 && this.#boilSeed / 4294967296 > owed) {
          break;
        }
        owed -= 1;
        const a = ((this.#boilSeed >>> 4) / 268435456) * 2 * Math.PI;
        const r = b.reach * Math.sqrt(((this.#boilSeed >>> 8) & 0xffff) / 65536);
        this.spray.splash(b.east + Math.sin(a) * r, b.north + Math.cos(a) * r, 0, 0.35);
      }
    }
  }

  /** The splashes and boils of the sea's life on the foam map: white water where something broke the water. */
  #stampLife(): void {
    const d = this.lifeDraw;
    const wakes = this.ocean.wakes;
    for (let i = 0; i < d.splashCount; i++) {
      const s = d.splashes[i];
      if (s !== undefined) {
        wakes.spot(s.east, s.north, 0.5 + 1.5 * s.size, 0.9, s.size <= 1);
      }
    }
    for (let i = 0; i < d.printCount; i++) {
      const p = d.prints[i];
      if (p !== undefined) {
        wakes.print(p.east, p.north, p.size, 0.8);
      }
    }
    // Glowing water lit where the animals swimming through it disturb it.
    for (let i = 0; i < d.trailCount; i++) {
      const p = d.trails[i];
      if (p !== undefined) {
        wakes.spot(p.east, p.north, 0.6 + 0.6 * p.size, 0.35 * p.size);
      }
    }
    for (let i = 0; i < d.boilCount; i++) {
      const b = d.boils[i];
      if (b === undefined) {
        continue;
      }
      // The water boiling at the flock's edge: white here and there across it.
      for (let k = 0; k < 5; k++) {
        this.#boilSeed = (Math.imul(this.#boilSeed, 1103515245) + 12345) >>> 0;
        const a = (this.#boilSeed / 4294967296) * 2 * Math.PI;
        const r = b.reach * Math.sqrt(((this.#boilSeed >>> 8) & 0xffff) / 65536);
        const size = 2 + (3 * ((this.#boilSeed >>> 3) & 7)) / 7;
        wakes.spot(b.east + Math.sin(a) * r, b.north + Math.cos(a) * r, size, 0.5 * b.strength);
      }
    }
  }
  #boilSeed = 7;

  /** The winds asked of the module about the towns, by place, and when. */
  readonly #townWinds = new Map<string, { speed: number; from: number; asked: number }>();

  /** The true wind at a place ashore, m/s and from: asked again a few times a second, else the boat's. */
  #windAt(east: number, north: number, now: number): { speed: number; from: number } {
    const key = `${Math.round(east)},${Math.round(north)}`;
    const held = this.#townWinds.get(key);
    if (held !== undefined && now - held.asked < 300) {
      return held;
    }
    const source = this.ocean.source;
    const physics = source?.weather === true ? source.physics : null;
    let speed = this.wind.speed;
    let from = this.wind.from;
    if (physics !== null) {
      physics.windDrawAt(this.ticks);
      const r = physics.windPoint(east, north);
      speed = r[RECORDS.wind.speed] ?? speed;
      from = r[RECORDS.wind.from] ?? from;
    }
    const w = { speed, from, asked: now };
    if (this.#townWinds.size > 512) {
      this.#townWinds.clear();
    }
    this.#townWinds.set(key, w);
    return w;
  }

  /** The air the lights are seen through: the module's, made once. */
  readonly #lightsAir = {
    physics: null as Physics | null,
    depth(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number): number {
      return this.physics?.opticalDepth(x0, y0, h0, x1, y1, h1) ?? 0;
    },
    poor(east: number, north: number): boolean {
      const p = this.physics;
      return p !== null && p.visibilityWord(p.visibilityAt(east, north)) >= VISIBILITY.poor;
    },
    fog(east: number, north: number, h: number): number {
      return this.physics?.airAt(east, north, h)[1] ?? 0;
    },
    extinction(east: number, north: number, h: number): number {
      const a = this.physics?.airAt(east, north, h);
      return a === undefined ? 0 : (a[0] ?? 0) + (a[1] ?? 0) + (a[2] ?? 0) + (a[3] ?? 0);
    },
  };

  /** The lighthouses' towers and lights, each light lit by the sun at its lighthouse or by fog. */
  #drawLights(height: number, camera: Vector3, now: number): void {
    const sun = SKY.sun + BODY.altitude;
    const own = this.sky.now.sunHeight;
    const source = this.ocean.source;
    const physics = source?.weather === true ? source.physics : null;
    physics?.windDrawAt(this.ticks);
    this.#lightsAir.physics = physics;
    this.lighthouses.frame({
      air: physics === null ? null : this.#lightsAir,
      origin: this.origin.world,
      camera,
      worldUs: Math.floor(this.ticks * TICK_US),
      now,
      sunAt: (east, north) => {
        const at = this.skyFrom(east, north);
        return at === null ? own : (at[sun] ?? own);
      },
      mist: this.edge.mist,
      dome: [this.focusScene.x, this.focusScene.z],
      fovY: this.stage.camera.fov,
      height,
      on: this.drawSky,
    });
  }

  /**
   * A frame: the scene brought to the frame's time, and with gfx what is
   * drawn with the renderer before the scene's render. Without, the frame
   * is not drawn: the update runs alone.
   */
  #frame(gfx: Gfx | null, dt: number, now: number): void {
    const cap = this.stage.cap;
    if (cap.probed !== this.#probed) {
      // The display was probed: nothing was drawn meanwhile, on purpose.
      this.#probed = cap.probed;
      this.stats.gap();
    }
    if (this.#started < 0) {
      this.#started = now;
    }
    this.stats.window =
      this.windowMs ?? (now - this.#started < BENCHMARK ? BENCHMARK_WINDOW : WINDOW);
    if (gfx === null) {
      // Not drawn: the frames either side of it say nothing of the GPU.
      this.stats.gap();
    } else {
      this.stats.frame(now, gfx);
    }
    // The picture's size on the page, in CSS pixels.
    const view =
      gfx === null
        ? this.stage.size()
        : { width: gfx.canvas.clientWidth, height: gfx.canvas.clientHeight };
    this.tick?.(dt, now);
    this.freeCam.update(dt);
    this.#updateBoatScene();
    const bs = this.boatScene;
    const fs0 = this.focusScene;
    // The dome bends about the focus: the viewer, wherever the boat is.
    domeCentre.value.set(fs0.x, fs0.z);

    this.camera.update(
      dt,
      this.pose.heading,
      now,
      this.pose.heave,
      this.#seaUnderBoat(),
      this.pose.pitch,
      this.pose.heel,
      this.sea.height,
    );
    this.#placeCamera();
    const camera = this.stage.camera;
    const resting = !this.freeCam.on && this.camera.resting;
    if (resting !== this.resting.peek()) {
      this.resting.value = resting;
    }

    this.#placeHulls();
    const focus = this.focus;
    this.land?.frame(
      focus.east,
      focus.north,
      camera,
      this.origin,
      this.wind.meanFrom,
      now,
      this.pose.east,
      this.pose.north,
    );
    this.ocean.update(gfx?.renderer ?? null, this.origin, {
      tick: this.ticks,
      dt: this.timeStep,
      boatEast: focus.east,
      boatNorth: focus.north,
      cameraHeight: camera.position.y,
    });
    this.#skyWeather(camera.position);
    this.#readSky();
    this.#stageEnd(now);
    this.sky.follow(camera.position, this.#v.set(fs0.x, fs0.y, fs0.z));
    const eye = this.origin.world;
    this.edge.frame(this.origin, camera.position.x + eye.x, -camera.position.z + eye.y, this.time);
    this.boat?.draw(bs, this.pose, this.out, this.time, this.timeStep);
    // The sailor drawn close when the camera is near it.
    this.boat?.sailor?.near(camera.position.distanceTo(this.#v.set(bs.x, bs.y + 0.8, bs.z)));
    // The crew to windward of the boom, crossing in a tack or a gybe,
    // leaning out as the helm hikes; the helm not drawn while it walks
    // to or from the tiller in a change of hands.
    const helm = this.boat?.sailor ?? null;
    const sm = this.#shipMoment;
    sm.yards = this.pose.yardsTurn;
    sm.foreYards = this.pose.foreYardsTurn;
    sm.reef = this.pose.reef;
    sm.heel = this.pose.heel;
    sm.wind = this.wind.meanSpeed;
    sm.time = this.ticks / STEPS_PER_SECOND;
    const sn = this.#sailorNow;
    sn.mode = this.pose.sailorMode;
    sn.heel = this.pose.heel;
    sn.trim = this.out[RECORDS.out.trim] ?? 0;
    sn.offset = this.pose.sailor;
    sn.net = helm?.runtime.netAt ?? null;
    const lie = this.#lie;
    lie.pitch = this.pose.pitch;
    lie.heave = this.pose.heave;
    lie.aft = this.pose.sailorAft;
    this.crew.sail(
      {
        dt: this.timeStep,
        boom: this.pose.boom,
        windOffBow: this.wind.meanFrom - this.pose.heading,
        depth: helm?.runtime.depth ?? 0,
        ship: this.#shipMoment,
        apparent: this.out[RECORDS.out.apparentWindSpeed] ?? 0,
        sailor: sn,
      },
      this.pose.heel,
      lie,
    );
    if (helm !== null) {
      helm.away = this.crew.helmAway;
      helm.wayHeld = this.crew.helmHeld;
    }
    if (this.crew.wheelSeat !== this.#wheelDrawn) {
      // A relief has taken the spokes: the wheel drawn in their look.
      this.#wheelDrawn = this.crew.wheelSeat;
      void this.#drawHelm();
    }
    this.crew.frame(camera.position, this.timeStep);
    const fs = this.fleetSource;
    // The other boats' crews, before the fleet: whose helm walks with them.
    this.crews.windFrom = this.wind.meanFrom;
    this.crews.windSpeed = this.wind.meanSpeed;
    this.crews.time = this.ticks / STEPS_PER_SECOND;
    this.crews.frame(fs?.drawn ?? [], fs?.count ?? 0, this.origin, camera.position, this.timeStep);
    this.prizes.begin();
    if (this.fleet.loaded) {
      this.fleet.windFrom = this.wind.meanFrom;
      this.fleet.windSpeed = this.wind.meanSpeed;
      this.fleet.draw(
        fs?.drawn ?? [],
        fs?.count ?? 0,
        this.origin,
        camera.position,
        this.time,
        this.timeStep,
      );
    }
    this.#ownPrizesDrawn();
    this.prizes.end(this.origin.world, this.ticks / STEPS_PER_SECOND);
    const night = this.drawSky ? lanternLit(this.sky.now.sunHeight) : 0;
    this.birds.begin(this.origin.world, this.ticks / STEPS_PER_SECOND, 0.25 + 0.75 * (1 - night));
    this.#drawTowns(camera.position, now);
    this.#drawLife(camera.position, night > 0.5);
    this.birds.end();
    this.#drawRace(camera.position, now, night);
    this.#drawLanterns(view.height, camera.position);
    this.#drawLights(view.height, camera.position, now);
    this.wrecks.frame(this.origin);
    if (gfx !== null) {
      this.stars.resize(gfx.canvas.width, gfx.canvas.height);
    }
    this.stars.mesh.visible = this.drawSky && this.stars.total > 0;
    this.stars.placeLabel(camera, view.width, view.height, now);
    const o = this.overlays;
    const rings = this.gustRings;
    // The free camera's picture has no overlays, nor the clear view: the
    // interface is hidden.
    const free = this.freeCam.on || this.clearView;
    o.world.visible = !free;
    this.dirtyAir.group.visible = !free;
    this.rightOfWay.group.visible = !free;
    rings.on = o.wind && !free;
    const source = this.ocean.source;
    const speed = this.out[RECORDS.out.speedOverGround] ?? 0;
    const course = this.out[RECORDS.out.courseOverGround] ?? 0;
    const boatAt = this.#ringBoat;
    boatAt.east = this.pose.east;
    boatAt.north = this.pose.north;
    boatAt.velEast = speed * Math.sin(course);
    boatAt.velNorth = speed * Math.cos(course);
    boatAt.windFrom = this.wind.meanFrom;
    rings.update(
      source?.weather === true ? source.physics : null,
      this.ticks,
      this.timeStep,
      boatAt,
      this.origin.world.x,
      this.origin.world.y,
    );
    const own = this.#own;
    own.east = this.pose.east;
    own.north = this.pose.north;
    own.heading = this.pose.heading;
    own.heel = this.pose.heel;
    own.boom = this.pose.boom;
    own.mode = this.pose.sailorMode;
    own.vEast = boatAt.velEast;
    own.vNorth = boatAt.velNorth;
    own.kind = this.kindIndex;
    const drawn = this.fleetSource?.drawn ?? NO_BOATS;
    const count = this.fleetSource?.count ?? 0;
    const physics = source?.physics ?? null;
    const ow = this.origin.world;
    this.dirtyAir.set(o.wind);
    this.dirtyAir.update(physics, this.ticks, own, drawn, count, ow.x, ow.y);
    const row = this.rightOfWay;
    row.update(physics, now, this.ticks, own, drawn, count, ow.x, ow.y, camera);
    if (row.on) {
      row.group.updateMatrixWorld();
      row.placeLabels(camera, view.width, view.height);
    }
    if ((o.wind || o.forces) && !free) {
      o.update(bs.x, bs.z, this.pose, this.wind, this.out);
      // The overlays ride the boat: their world matrices must be current to place their labels.
      this.boat?.root.updateMatrixWorld();
      o.world.updateMatrixWorld();
      o.placeLabels(camera, view.width, view.height);
    }
    this.#placeMarkTag(camera, view.width, view.height);
    this.#spray();
    this.onFrame?.();
  }

  /** The own boat's prizes, placed as its model is drawn, in the wind it feels. */
  #ownPrizesDrawn(): void {
    const b = this.boat;
    const rig = b?.prizeRig ?? null;
    if (b === null || rig === null || this.#prizes.code === 0 || !b.root.visible) {
      return;
    }
    b.model.updateWorldMatrix(true, false);
    const angle = this.out[RECORDS.out.apparentWindAngle] ?? 0;
    const w = this.#ownWind;
    w.speed = this.out[RECORDS.out.apparentWindSpeed] ?? 0;
    w.from = this.pose.heading + angle;
    this.prizes.add(
      this.#prizes.code,
      rig,
      this.#placeOwn,
      w,
      0.37,
      this.ticks / STEPS_PER_SECOND,
      this.origin.world,
    );
  }

  readonly #ownWind = { from: 0, speed: 0 };
  readonly #placeOwn = (p: Vector3, out: Vector3): Vector3 =>
    this.boat === null ? out.copy(p) : this.boat.model.localToWorld(out.copy(p));

  /** The next mark's tag, over its spar, when the camera sees it; nothing when not. */
  #placeMarkTag(camera: Camera, width: number, height: number): void {
    const el = this.#markTag;
    if (el === null) {
      return;
    }
    const t = this.markTagOf?.() ?? null;
    if (t === null) {
      el.hidden = true;
      return;
    }
    const ow = this.origin.world;
    const d = Math.hypot(t.east - this.pose.east, t.north - this.pose.north);
    // Over the spar's top, dropped by the dome as the sea is.
    const v = this.#tagAt
      .set(t.east - ow.x, MARK_TAG_HEIGHT - domeDrop(d), -(t.north - ow.y))
      .project(camera);
    const on = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
    el.hidden = !on;
    if (on) {
      el.textContent = t.text;
      el.style.transform = `translate(${(((v.x + 1) / 2) * width).toFixed(1)}px, ${(((1 - v.y) / 2) * height).toFixed(1)}px)`;
    }
  }

  /** The player's boat as the dirty air and the right-of-way overlay want it. */
  readonly #own: Seen = {
    east: 0,
    north: 0,
    heading: 0,
    heel: 0,
    boom: 0,
    mode: 0,
    vEast: 0,
    vNorth: 0,
  };

  /** Puts the overlays' labels in a layer of the page over the scene. */
  attachLabels(layer: HTMLElement | null): void {
    this.overlays.attachLabels(layer);
    this.rightOfWay.attachLabels(layer);
    this.#markTag?.remove();
    this.#markTag = null;
    if (layer !== null) {
      const el = document.createElement('span');
      el.className = 'mark-tag';
      el.dataset.readout = 'mark-tag';
      el.hidden = true;
      layer.append(el);
      this.#markTag = el;
    }
  }

  /** The boat as the gust rings want it: where, how it moves, and where the mean wind comes from. */
  readonly #ringBoat = { east: 0, north: 0, velEast: 0, velNorth: 0, windFrom: 0 };

  /** Room for a boat's hulls, for its wakes and its bows. */
  readonly #hullRoom = hullRoom();
  /** The spray's sources this frame: the player's bow, and the nearest others' on the tiers that have them. */
  readonly #sources: SpraySource[] = Array.from({ length: 4 }, () => ({
    east: 0,
    north: 0,
    height: 0,
    sea: 0,
    heading: 0,
    speed: 0,
  }));
  readonly #crests: CrestSample[] = Array.from({ length: 16 }, () => ({
    east: 0,
    north: 0,
    height: 0,
    crest: 0,
  }));
  readonly #points = new Float64Array(2 * (4 + 16));
  readonly #weather: SprayWeather = {
    speed: 0,
    east: 0,
    north: -1,
    whitecaps: 0,
    hs: 0,
    crestRate: 0,
    spindrift: 0,
  };
  /** The foam's look at the wind the boat feels, for the spray off the crests. */
  readonly #sprayLook = newFoamLook();
  #crestSeed = 1;

  /** Steps the spray: the bows and, in a gale, the crests about the camera. */
  #spray(): void {
    const src = this.ocean.source;
    const slot = this.ocean.slot;
    const dt = this.timeStep;
    const tier = this.tier;
    const sources = this.#sources;
    const pts = this.#points;
    const p = this.pose;
    // The player's bow, and the nearest others' within reach, each at its own
    // waterline's forward end.
    let n = 0;
    const bow = (
      east: number,
      north: number,
      heading: number,
      heave: number,
      pitch: number,
      heel: number,
      speed: number,
      kind: number,
    ) => {
      const k = (catalog.boats[kind] ?? this.kind).physics;
      const half = k.hull.waterlineLength / 2;
      // Each hull's bow, but one lifted clear of the water.
      const room = this.#hullRoom;
      for (let h = eachHull(k.hulls.hullSpacing, east, north, heading, heel, room); h-- > 0; ) {
        const at = room[h] as HullAt;
        if (at.lift >= k.hull.hullDraught || n >= sources.length) {
          continue;
        }
        const s = sources[n] as SpraySource;
        s.east = at.east + Math.sin(heading) * half;
        s.north = at.north + Math.cos(heading) * half;
        s.height = heave + Math.sin(pitch) * half;
        s.heading = heading;
        s.speed = speed;
        pts[n * 2] = s.east;
        pts[n * 2 + 1] = s.north;
        n++;
      }
    };
    bow(
      p.east,
      p.north,
      p.heading,
      p.heave,
      p.pitch,
      p.heel,
      this.out[RECORDS.out.speedThroughWater] ?? 0,
      this.kindIndex,
    );
    const fs = this.fleetSource;
    if (fs !== null) {
      for (let k = 0; k < tier.sprayBoats && k < HULLS - 1; k++) {
        const i = this.#near[k] ?? -1;
        const b = i >= 0 && i < fs.count ? fs.drawn[i] : undefined;
        if (b === undefined || (this.#nearDist[k] ?? Infinity) > HULL_REACH) {
          break;
        }
        bow(b.east, b.north, b.heading, b.heave, b.pitch, b.heel, b.speed, b.kind);
      }
    }
    const wind = this.wind;
    const knots = wind.speed / KNOT;
    const look = foamAt(knots, this.#sprayLook);
    const crests =
      tier.sprayCrests && (look.spray > 0 || look.spindrift > 0) ? this.#crests.length : 0;
    // Places about the camera, scattered afresh each frame.
    const cam = this.stage.camera.position;
    const o = this.origin.world;
    for (let c = 0; c < crests; c++) {
      this.#crestSeed = (Math.imul(this.#crestSeed, 1103515245) + 12345) >>> 0;
      const a = (this.#crestSeed / 4294967296) * 2 * Math.PI;
      const r = SPRAY.crestReach * Math.sqrt(((this.#crestSeed >>> 8) & 0xffff) / 65536);
      pts[(n + c) * 2] = cam.x + o.x + Math.cos(a) * r;
      pts[(n + c) * 2 + 1] = -cam.z + o.y + Math.sin(a) * r;
    }
    if (src === null || slot < 0) {
      this.sea.height = 0;
      this.sea.whitecaps = 0;
    }
    if (src !== null && slot >= 0 && dt > 0) {
      src.physics.seaDrawAt(this.ticks);
      const sea = src.physics.seaSample(slot, pts.subarray(0, 2 * (n + crests)));
      // The first point is the player's bow.
      this.sea.height = sea[3] ?? 0;
      this.sea.whitecaps = this.ocean.under.foam.whitecaps;
      for (let k = 0; k < n; k++) {
        (sources[k] as SpraySource).sea = sea[k * 4] ?? 0;
      }
      for (let c = 0; c < crests; c++) {
        const at = (n + c) * 4;
        const cr = this.#crests[c] as CrestSample;
        cr.east = pts[(n + c) * 2] ?? 0;
        cr.north = pts[(n + c) * 2 + 1] ?? 0;
        cr.height = sea[at] ?? 0;
        cr.crest = (sea[at] ?? 0) / Math.max((sea[at + 3] ?? 0) / 2, 0.03);
      }
      const w = this.#weather;
      w.speed = wind.speed;
      w.east = -Math.sin(wind.from);
      w.north = -Math.cos(wind.from);
      w.whitecaps = this.ocean.under.foam.whitecaps;
      w.hs = sea[3] ?? 0;
      w.crestRate = look.spray;
      w.spindrift = look.spindrift;
      this.spray.step(dt, sources, w, this.#crests, n, crests);
      this.#sprayLife(dt);
    }
    this.sprayView.draw(this.spray, this.origin);
    if (this.sprayHidden) {
      this.sprayView.mesh.visible = false;
    }
  }
}

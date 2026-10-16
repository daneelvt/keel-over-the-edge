// SPDX-License-Identifier: AGPL-3.0-only

// The scene at sea: an open sea under the sky of the hour, the player's
// boat on it as the physics sails it, the other boats in view with their
// lanterns, the stars, the chase camera, and the beginners' overlays. Each
// drawn frame, whatever drives the boat (the game's tick) first sets the
// pose to draw, the latest step's Out and world time; the scene then
// follows the boat with the floating origin, the tile field and the camera,
// asks the physics module where the sun, the moon and the stars stand from
// the boat at that time, lights everything by the hour, and draws it.

import { Vector3 } from 'three';
import {
  cameraPosition,
  exp,
  float,
  fog,
  length,
  max,
  mix,
  positionView,
  positionWorld,
} from 'three/tsl';
import { catalog } from '../catalog';
import { EdgeScene } from '../edge/edge';
import { edgeLook, KOSCHMIEDER, mistBetween } from '../edge/mist';
import type { DrawnBoat } from '../game/fleet';
import type { Land } from '../land/land';
import { HULL_REACH, HULLS, type HullShape, hulls } from '../ocean/hulls';
import { beaufort, KNOT, SPRAY } from '../ocean/look';
import { Ocean } from '../ocean/ocean';
import { type BoatPose, newPose } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { writeSkyParams } from '../predict/params.gen';
import { BODY, type Physics, SKY } from '../predict/physics';
import { type BoatWind, newBoatWind } from '../predict/weather';
import { SkyTime } from '../sky/skytime';
import starsUrl from '../sky/stars.bin?url';
import { Boat } from './boat';
import { CAMERA_PRESETS, type CameraView, ChaseCamera } from './camera';
import { FloatingOrigin, type ScenePoint } from './coords';
import { DirtyAir } from './dirtyair';
import { FleetView } from './fleet';
import { GustRings } from './gustring';
import { Lanterns, lanternLit } from './lanterns';
import { domeCentre } from './materials';
import { Overlays } from './overlays';
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
import { type Backend, type Gfx, wantsCompat } from './renderer';
import { RightOfWay, type Seen } from './rightofway';
import { Shadows } from './shadows';
import { look, Sky, toLinear } from './sky';
import { type CrestSample, SprayDrops, type SpraySource, SprayView } from './spray';
import { Stage } from './stage';
import { FEW_STARS, Stars } from './stars';
import { type FrameStats, Stats, WINDOW } from './stats';

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

/** No boats: the fleet before the game is online. */
const NO_BOATS: readonly DrawnBoat[] = [];

export class SeaScene {
  readonly stage: Stage;
  readonly origin = new FloatingOrigin();
  readonly ocean: Ocean;
  readonly sky: Sky;
  /** The edge of the world: the mist band, the lip and the falls. */
  readonly edge: EdgeScene;
  readonly stats = new Stats();
  readonly camera = new ChaseCamera();
  /** The catalog's first boat, the one a new sailor starts in. */
  readonly kind = catalog.boats[0];
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
  readonly rightOfWay = new RightOfWay(this.kind, catalog.encounters.overlay);
  readonly boatScene: ScenePoint = { x: 0, y: 0, z: 0 };
  boat: Boat | null = null;
  /** The other boats, drawn many at once. */
  readonly fleet = new FleetView(this.kind);
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
  readonly lanterns = new Lanterns();
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
  /** Called after each frame is placed (the panel's statistics, the tests). */
  onFrame: (() => void) | null = null;

  readonly #target = new Vector3();
  readonly #v = new Vector3();
  /** The other boats nearest the player's, by their place among those drawn, and how far each is. */
  readonly #near = new Int32Array(HULLS);
  readonly #nearDist = new Float64Array(HULLS);
  readonly #query: URLSearchParams;
  readonly #store: Store | null;
  /** The hull every boat has, for now: where its stern is and how wide it is, for the wakes. */
  #aft = 0;
  #halfBeam = 0.5;
  #started = -1;
  #probed = Number.NEGATIVE_INFINITY;
  /** Counts the changes of quality asked for: one that takes long may be overtaken. */
  #applying = 0;

  constructor(
    container: HTMLElement,
    backend: Backend,
    options: SceneOptions = { query: new URLSearchParams(), store: null, detail: 'auto' },
  ) {
    this.#query = options.query;
    this.#store = options.store;
    this.detail = options.detail;
    this.stage = new Stage(container, backend, {
      frame: (gfx, info) => this.#frame(gfx, info.dt, info.now),
      drawn: (gfx, work) => this.stats.drawn(gfx, work),
      attached: (gfx) => this.#attached(gfx),
      resumed: () => {
        // Hidden, nothing was drawn: the frames either side say nothing.
        const now = performance.now();
        this.stats.restart(now);
        this.quality?.quiet(now);
      },
    });
    this.stage.compat = wantsCompat(options.query);
    this.stats.gpuTiming = true;
    this.stats.onWindow = (now, st) => this.#window(now, st);
    const scene = this.stage.scene;
    this.sky = new Sky(scene);
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
    scene.add(this.sprayView.mesh);
    this.overlays = new Overlays(this.kind);
    scene.add(this.overlays.world);
    scene.add(this.gustRings.group);
    scene.add(this.dirtyAir.group, this.rightOfWay.group);
    scene.add(this.fleet.root);
    scene.add(this.stars.mesh, this.lanterns.mesh);
    const label = document.createElement('span');
    label.className = 'star-label';
    container.append(label);
    this.stars.attachLabel(label);
    // Solid things fade toward the horizon's colour with distance, keeping
    // exp(−3.912 d / V) of their contrast at d metres: Koschmieder's law, V
    // the visual range at a 2% threshold; and toward the mist's through the
    // band at the edge of the world, by the mist along the ray. The sea has
    // its own blend to the sky at its edge.
    const clear = length(positionView).mul(KOSCHMIEDER).div(look.visualRange);
    const mist = mistBetween(cameraPosition, positionWorld);
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

  /** A tap on the open sea at (x, y) CSS pixels: a named star there shows its name. */
  tap(x: number, y: number, now: number): string | null {
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
    Shadows.cast(boat.model, this.shadows.on, this.shadows.lit);
    const light = this.kind.lights[0];
    const lantern = light === undefined ? undefined : boat.parts.get(light);
    if (lantern !== undefined) {
      this.lanterns.setLantern(
        lantern.position,
        this.kind.physics.hull.centreOfGravity,
        this.kind.lights,
      );
    }
    if (boat.hullShape !== null) {
      // Every boat is of this kind, for now: one hull's volume serves them all.
      hulls.setShape(boat.hullShape, this.kind.physics.hull.centreOfGravity);
      this.#hull(boat.hullShape);
    }
    this.boat = boat;
    this.stage.scene.add(boat.root);
  }

  /** Draws a world's land, as the land is handed. */
  useLand(land: Land): void {
    if (this.land !== null) {
      this.stage.scene.remove(this.land.group);
    }
    this.land = land;
    this.stage.scene.add(land.group);
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

  #hull(shape: HullShape): void {
    this.#aft = shape.stations[0]?.[0] ?? 0;
    this.#halfBeam = Math.max(...shape.stations.map((s) => s[1] ?? 0));
  }

  #attached(gfx: Gfx): void {
    this.shadows.attached(gfx.renderer);
    this.ocean.detail.attached();
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
    Shadows.cast(this.fleet.near.group, sh.fleet, sh.lit);
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
    this.onQuality?.(tier.number, this.stage.pixelRatio());
    await Promise.all([
      lit,
      this.ocean.setQuality(
        { detail: rung.detail, anisotropy: tier.anisotropy, foamMap: tier.foamMap },
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
   * nearest others within reach that have faded in.
   */
  #placeHulls(): void {
    const p = this.pose;
    const bs = this.boatScene;
    const speed = this.out[RECORDS.out.speedThroughWater] ?? 0;
    hulls.begin();
    hulls.add(bs.x, bs.y + p.heave, bs.z, p.heading, p.heel, p.pitch, speed);
    const wakes = this.ocean.wakes;
    wakes.begin();
    wakes.add(p.east, p.north, p.heading, speed, this.#aft, this.#halfBeam);
    const fs = this.fleetSource;
    if (fs === null) {
      return;
    }
    // Every boat drawn lays a wake; the map keeps those within its square.
    for (let i = 0; i < fs.count; i++) {
      const b = fs.drawn[i] as DrawnBoat;
      if (b.opacity >= 0.5) {
        wakes.add(b.east, b.north, b.heading, b.speed, this.#aft, this.#halfBeam);
      }
    }
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
      hulls.add(b.east - o.x, b.heave, -(b.north - o.y), b.heading, b.heel, b.pitch, b.speed);
    }
  }

  /** The sea's height under the boat, by the latest step. */
  #seaUnderBoat(): number {
    return this.out[RECORDS.out.waveHeight] ?? 0;
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

  /** Asks the module for the sky at the boat at the frame's time, and lights the scene by it. */
  #readSky(): void {
    const physics = this.skyPhysics;
    const time = this.skyTime;
    if (physics === null || time === null || this.holdSky) {
      return;
    }
    this.skyAt = time.frame(this.ticks);
    this.skyRecord.set(physics.skyAt(this.skyAt, this.pose.east, this.pose.north));
    this.sky.read(this.skyRecord);
    this.stars.turn(this.skyRecord, SKY.stars);
  }

  /** The lanterns of the player's boat and of the others, each lit by the sun at its own boat. */
  #drawLanterns(gfx: Gfx, camera: Vector3): void {
    const l = this.lanterns;
    l.begin();
    const sun = SKY.sun + BODY.altitude;
    const p = this.pose;
    const bs = this.boatScene;
    const own = this.sky.now.sunHeight;
    if (this.drawSky && this.boat?.root.visible) {
      l.add(p, bs.x, bs.z, camera, lanternLit(own));
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
      l.add(b, b.east - o.x, -(b.north - o.y), camera, lanternLit(height) * b.opacity);
    }
    l.commit(this.stage.camera.fov, gfx.canvas.clientHeight);
  }

  #frame(gfx: Gfx, dt: number, now: number): void {
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
    this.stats.frame(now, gfx);
    this.tick?.(dt, now);
    this.#updateBoatScene();
    const bs = this.boatScene;
    domeCentre.value.set(bs.x, bs.z);

    this.camera.update(dt, this.pose.heading, now, this.pose.heave, this.#seaUnderBoat());
    this.#placeCamera();
    const camera = this.stage.camera;

    this.#placeHulls();
    this.land?.frame(this.pose.east, this.pose.north, camera, this.origin, this.wind.meanFrom, now);
    this.ocean.update(gfx.renderer, this.origin, {
      tick: this.ticks,
      dt: this.timeStep,
      boatEast: this.pose.east,
      boatNorth: this.pose.north,
      cameraHeight: camera.position.y,
    });
    this.#readSky();
    this.sky.follow(camera.position, this.#v.set(bs.x, bs.y, bs.z));
    const eye = this.origin.world;
    this.edge.frame(this.origin, camera.position.x + eye.x, -camera.position.z + eye.y, this.time);
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
    this.#drawLanterns(gfx, camera.position);
    const canvas = gfx.canvas;
    this.stars.resize(canvas.width, canvas.height);
    this.stars.mesh.visible = this.drawSky && this.stars.total > 0;
    this.stars.placeLabel(camera, canvas.clientWidth, canvas.clientHeight, now);
    const o = this.overlays;
    const rings = this.gustRings;
    rings.on = o.wind;
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
      row.placeLabels(camera, gfx.canvas.clientWidth, gfx.canvas.clientHeight);
    }
    if (o.wind || o.forces) {
      o.update(bs.x, bs.z, this.pose, this.wind, this.out);
      // The overlays ride the boat: their world matrices must be current to place their labels.
      this.boat?.root.updateMatrixWorld();
      o.world.updateMatrixWorld();
      const size = gfx.canvas;
      o.placeLabels(camera, size.clientWidth, size.clientHeight);
    }
    this.#spray();
    this.onFrame?.();
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
  }

  /** The boat as the gust rings want it: where, how it moves, and where the mean wind comes from. */
  readonly #ringBoat = { east: 0, north: 0, velEast: 0, velNorth: 0, windFrom: 0 };

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
  readonly #weather = { speed: 0, east: 0, north: -1, whitecaps: 0 };
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
    const half = this.kind.physics.hull.waterlineLength / 2;
    // The player's bow, and the nearest others' within reach.
    let n = 0;
    const bow = (
      east: number,
      north: number,
      heading: number,
      heave: number,
      pitch: number,
      speed: number,
    ) => {
      const s = sources[n] as SpraySource;
      s.east = east + Math.sin(heading) * half;
      s.north = north + Math.cos(heading) * half;
      s.height = heave + Math.sin(pitch) * half;
      s.heading = heading;
      s.speed = speed;
      pts[n * 2] = s.east;
      pts[n * 2 + 1] = s.north;
      n++;
    };
    bow(p.east, p.north, p.heading, p.heave, p.pitch, this.out[RECORDS.out.speedThroughWater] ?? 0);
    const fs = this.fleetSource;
    if (fs !== null) {
      for (let k = 0; k < tier.sprayBoats && k < HULLS - 1; k++) {
        const i = this.#near[k] ?? -1;
        const b = i >= 0 && i < fs.count ? fs.drawn[i] : undefined;
        if (b === undefined || (this.#nearDist[k] ?? Infinity) > HULL_REACH) {
          break;
        }
        bow(b.east, b.north, b.heading, b.heave, b.pitch, b.speed);
      }
    }
    const wind = this.wind;
    const knots = wind.speed / KNOT;
    const crests =
      tier.sprayCrests && beaufort(knots) >= SPRAY.crestForce ? this.#crests.length : 0;
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
      this.spray.step(dt, sources, w, this.#crests, n, crests);
    }
    this.sprayView.draw(this.spray, this.origin);
    if (this.sprayHidden) {
      this.sprayView.mesh.visible = false;
    }
  }
}

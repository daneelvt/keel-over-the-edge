// SPDX-License-Identifier: AGPL-3.0-only

// The hooks the browser tests drive, on window.keel with ?test. Loaded only
// when asked for. They read back what the GPU computed (each tile's plane,
// and, through a probe material, each fragment's tile and scene position)
// and compare it with the sea the physics module gives, which is the
// server's own code; and they sail the
// boat: set its state, wind and controls, step it, script its controls,
// and read back what the screen shows. They set the sky's hour, and find
// where the GPU draws each named star beside where the module's rule puts
// it.

import { signal } from '@preact/signals';
import {
  Color,
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  RenderTarget,
  RGBAFormat,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import {
  Fn,
  float,
  floor,
  instanceIndex,
  ivec2,
  output,
  positionGeometry,
  positionWorld,
  screenCoordinate,
  select,
  textureLoad,
  uniform,
  varying,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { FullScreen } from '../boot/fullscreen';
import type { Revealed } from '../boot/gate';
import { harbourWater } from '../boot/harbour';
import { catalog } from '../catalog';
import type { ChartMode } from '../chart/chart';
import type { ChartParts } from '../chart/make';
import { placeWords, pointsOf, warningInForce } from '../chart/placeweather';
import { formatPosition } from '../chart/position';
import { type Layer, momentOf } from '../chart/weather';
import { STEPS_PER_SECOND } from '../game/clock';
import type { BoatDriver } from '../game/driver';
import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import type { Game } from '../game/game';
import { hullLift } from '../game/hullpose';
import { PILOT_WIND } from '../input/pilot';
import type { LifeBird } from '../life/draw';
import type { GullTown } from '../life/gulls';
import { nowUs, worldUs } from '../net/clock';
import type { BumpTold, ChartEntry, ChartSubject, KnockStateTold, LifeSeen } from '../net/messages';
import type { Online } from '../net/online';
import type { Cascade } from '../ocean/detail';
import { FieldMaker, newFields } from '../ocean/field';
import { foamOn } from '../ocean/foam';
import { gustAt } from '../ocean/gusts';
import { hexAt, hexCentre, NEIGHBOURS, TILE_APOTHEM, TILE_RADIUS, tileHash } from '../ocean/hex';
import { HULL_FILL, hulls, insideHull, toHullFrame } from '../ocean/hulls';
import { type FoamLook, WAKE, WAKE_WAVES } from '../ocean/look';
import {
  detailOn,
  farLook,
  type Probe,
  tileHashNode,
  tileIdentity,
  tileLook,
} from '../ocean/seamaterial';
import { groundWindow, leeTexture, shelterTexture, shore, waveLeeAt } from '../ocean/shore';
import { GROUND_ROW, GUST_ROW, PASS_WIDTH } from '../ocean/tilepass';
import { SKIRT_DEPTH } from '../ocean/tiles';
import { wakeDamping } from '../ocean/wakewaves';
import { WakeWavesReference } from '../ocean/wakewavescpu';
import { boatBandAt } from '../ocean/wave';
import { type RecordValues, spellOf, steer, toHex } from '../predict/golden';
import { GROUND, RECORDS, SEA, WEATHER } from '../predict/layout.gen';
import { BODY, SKY, WIND_VALUE, WIND_VALUES } from '../predict/physics';
import type { Predictor } from '../predict/predictor';
import { heldSpell, placedRecord } from '../predict/weather';
import { lookPalette } from '../render/boatlook';
import { LEAN_STRIDE, MACHINE_DEFAULT, PERSON_DEFAULT } from '../render/fleet';
import { airLook } from '../render/fog';
import { flashNear } from '../render/lightning';
import {
  checkChartScene,
  checkScene,
  DOME_RADIUS,
  domeCentre,
  domeDrop,
  seaMaterial,
} from '../render/materials';
import { rungName, TIERS } from '../render/quality';
import { CREW_MOST } from '../render/sailors/fleetcrews';
import { type ShipMember, ShipRules } from '../render/sailors/shiprules';
import { CAMERA_PRESETS, type CameraView, type SeaScene } from '../render/scene';
import { look } from '../render/sky';
import { sandboxCrew } from '../sandbox/crewscene';
import type { SandboxForecast } from '../sandbox/forecast';
import { aboardScene, lifeScene, raiseScene } from '../sandbox/lifescene';
import { KNOT, type Sandbox, SEA_STATES } from '../sandbox/sandbox';
import { startWakeScene, type WakeSceneName, wakeSceneHost } from '../sandbox/wakescenes';
import { hourAt, moonAgeAt, skyPeriods } from '../sky/skytime';
import type { Barometer } from '../ui/barometer';
import type { ShipsClock } from '../ui/clock';
import type { Countdown } from '../ui/countdown';
import type { DeckView } from '../ui/decklazy';
import { downwindLine, type SailState } from '../ui/model';
import type { Settings } from '../ui/settings';
import type { StatementsView } from '../ui/statementlazy';
import type { WatchView } from '../ui/watchlazy';
import {
  cellHex,
  chunkCorner,
  drawnHeight,
  hexCentre as landHexCentre,
} from '../workers/mesh/build';
import { type DeckSceneName, deckScene } from './deckscenes';
import { setSky } from './skypanel';

export interface Info {
  backend: string;
  compat: boolean;
  /** The device's limits the scene is built to: invocations a workgroup, storage textures in the vertex stage. */
  workgroup: number;
  vertexStorageTextures: number;
  /** The tier in use, the rung of the ladder, and the ladder's rungs in words. */
  tier: string;
  rung: number;
  rungs: string[];
  adaptive: boolean;
  /** How the detail band is made. */
  detail: string;
  dispatches: number;
  /** Drops of spray in the air. */
  spray: number;
  floatTargets: boolean;
  usePass: boolean;
  recoveries: number;
  lastLoss: string;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  tiles: number;
  origin: { east: number; north: number };
  centre: { q: number; r: number };
}

export interface Rigidity {
  /** Tiles fitted (those with at least 30 fragments in view). */
  tiles: number;
  /** Pixels with no tile, and pixels showing a skirt, from straight above. */
  empty: number;
  skirts: number;
  /** Fragments outside their tile's hexagon by more than a pixel and a half. */
  outside: number;
  /** Largest distance of a fragment from its tile's fitted plane, in metres. */
  worstResidual: number;
  /** Largest difference of a fitted plane from the reference: height at the centre, and slope. */
  worstHeight: number;
  worstSlope: number;
}

/** Reads a float target back, top row first on both back ends. */
async function readTarget(
  renderer: WebGPURenderer,
  target: RenderTarget,
  width: number,
  height: number,
  webgl: boolean,
): Promise<Float32Array> {
  const raw = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    width,
    height,
  )) as Float32Array;
  if (!webgl) {
    return raw.slice(0, width * height * 4);
  }
  // WebGL reads rows from the bottom; three.js flips y elsewhere to follow WebGPU.
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  }
  return out;
}

/** How many of a canvas's pixels are painted, of every fourth row and column. */
function inkedOf(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return 0;
  }
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let y = 0; y < canvas.height; y += 4) {
    for (let x = 0; x < canvas.width; x += 4) {
      if ((d[(y * canvas.width + x) * 4 + 3] ?? 0) > 0) {
        n++;
      }
    }
  }
  return n;
}

/** Solves a 3 × 3 system, row-major, by Cramer's rule. */
function solve3(a: number[], b: number[]): [number, number, number] {
  const det = (m: number[]): number => {
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return m0 * (m4 * m8 - m5 * m7) - m1 * (m3 * m8 - m5 * m6) + m2 * (m3 * m7 - m4 * m6);
  };
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [b0, b1, b2] = b as [number, number, number];
  const d = det(a);
  return [
    det([b0, a1, a2, b1, a4, a5, b2, a7, a8]) / d,
    det([a0, b0, a2, a3, b1, a5, a6, b2, a8]) / d,
    det([a0, a1, b0, a3, a4, b1, a6, a7, b2]) / d,
  ];
}

/** What the boat is sailed by: the offline sandbox, or the game online. */
export type Sailing = (
  | { sandbox: Sandbox; online?: undefined; predictor?: undefined }
  | { sandbox?: undefined; online: Online; predictor: Predictor }
) & {
  chart?: ChartParts;
  forecast?: SandboxForecast;
  barometer?: Barometer;
  readBarometer?: () => void;
  /** The ship's clock, and its reading now, as its timer does. */
  clock?: ShipsClock;
  readClock?: () => void;
  /** The countdown to the world's end, which the sandbox's tests set. */
  countdown?: Countdown;
  /** The full screen's switch and key. */
  fullScreen?: FullScreen;
  /** The sandbox's screen drawn again, with a watch's parts or without, and sailing together's. */
  remount?: (
    watch: WatchView | null,
    deck?: DeckView | null,
    statements?: StatementsView | null,
  ) => void;
  /** What the page did from the tap to the world's reveal; null before it. */
  revealed?: () => Revealed | null;
};

/** Puts the hooks on globalThis.keel. */
export function exposeHooks(world: SeaScene, game: Game, sailing: Sailing): void {
  // Pages under test hold their quality, so that a slow test machine draws
  // what the test asks for; the tests of adaptive quality turn it on.
  if (world.quality !== null) {
    world.quality.enabled = false;
  }
  (globalThis as unknown as { keel: KeelHooks }).keel = makeHooks(world, game, sailing);
}

export type KeelHooks = ReturnType<typeof makeHooks>;

export function makeHooks(world: SeaScene, game: Game, sailing: Sailing) {
  const stage = world.stage;
  const driver: BoatDriver = sailing.sandbox ?? sailing.predictor;
  // The sea's frames, counted: the chart drawn in its place draws none.
  let seaFrames = 0;
  const before = world.onFrame;
  world.onFrame = () => {
    before?.();
    seaFrames++;
  };
  // The sea's life raised by hand, counted: each its own id and seed.
  let lifeRaised = 0;
  // What the screen of the latest scene of sailing together asked of it.
  let deckCalls: string[] = [];
  // Every notice shown, in order, for tests that look after it has gone.
  const noticesShown: string[] = [];
  sailing.chart?.notices.shown.subscribe((s) => {
    if (s !== null && noticesShown.at(-1) !== s.text) {
      noticesShown.push(s.text);
    }
  });
  const chartParts = (): ChartParts => {
    if (sailing.chart === undefined) {
      throw new Error('no chart');
    }
    return sailing.chart;
  };
  const offline = (): Sandbox => {
    if (sailing.sandbox === undefined) {
      throw new Error('the offline sandbox only: the boat is sailed online');
    }
    return sailing.sandbox;
  };
  const gfx = () => {
    if (stage.gfx === null) {
      throw new Error('no renderer');
    }
    return stage.gfx;
  };
  const webgl = (): boolean => gfx().backend === 'webgl2';

  /**
   * The sea the physics module gives at scene points (x and z of each, in
   * turn) at the time drawn: for each its height, its slope along the
   * scene's x and z, and the sea's significant height. The module is the
   * server's code, so these are the server's numbers.
   */
  /** The module's gust field at scene points, at the time of the last frame. */
  const moduleGusts = (points: ArrayLike<number>): number[] => {
    const n = points.length >> 1;
    const physics = driver.physics;
    if (physics === undefined) {
      return new Array<number>(n).fill(0);
    }
    const o = world.origin.world;
    const at = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      at[i * 2] = o.x + (points[i * 2] ?? 0);
      at[i * 2 + 1] = o.y - (points[i * 2 + 1] ?? 0);
    }
    physics.windDrawAt(world.ticks);
    const values = physics.windSample(at, new Float64Array(n * WIND_VALUES));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(values[i * WIND_VALUES + WIND_VALUE.gust] ?? 0);
    }
    return out;
  };

  const moduleSea = (points: ArrayLike<number>): Float64Array => {
    const n = points.length >> 1;
    const out = new Float64Array(n * 4);
    const slot = world.ocean.slot;
    const physics = driver.physics;
    if (slot < 0 || physics === undefined) {
      return out;
    }
    const o = world.origin.world;
    const at = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      at[i * 2] = o.x + (points[i * 2] ?? 0);
      at[i * 2 + 1] = o.y - (points[i * 2 + 1] ?? 0);
    }
    physics.seaDrawAt(world.ticks);
    const sea = physics.seaSample(slot, at);
    for (let i = 0; i < n; i++) {
      out[i * 4] = sea[i * 4] ?? 0;
      out[i * 4 + 1] = sea[i * 4 + 1] ?? 0;
      // The scene's z runs south.
      out[i * 4 + 2] = -(sea[i * 4 + 2] ?? 0);
      out[i * 4 + 3] = sea[i * 4 + 3] ?? 0;
    }
    return out;
  };

  /** The boat lies on the sea drawn, when time stands still and no step puts it there. */
  const floatBoat = (): void => {
    if (game.frozen && sailing.sandbox !== undefined) {
      sailing.sandbox.floatAt(game.clock.steps + game.clock.alpha);
    }
  };

  /** Tile i's centre in the scene, as float32 holds it on the GPU. */
  const tileCentre = (i: number): [number, number] => {
    const field = world.ocean.field;
    const centre = world.ocean.passTiles.centre.value;
    return [
      Math.fround(Math.fround(centre.x) + Math.fround(field.offset[i * 2] ?? 0)),
      Math.fround(Math.fround(centre.y) + Math.fround(-(field.offset[i * 2 + 1] ?? 0))),
    ];
  };

  /** The planes the tile pass should hold: the module's sea at each tile's centre, on the dome. */
  const referencePlanes = (): Float64Array => {
    const field = world.ocean.field;
    const bs = world.boatScene;
    const centres = new Float64Array(field.count * 2);
    for (let i = 0; i < field.count; i++) {
      centres.set(tileCentre(i), i * 2);
    }
    const sea = moduleSea(centres);
    const out = new Float64Array(field.count * 4);
    for (let i = 0; i < field.count; i++) {
      const dx = (centres[i * 2] ?? 0) - bs.x;
      const dz = (centres[i * 2 + 1] ?? 0) - bs.z;
      const h = sea[i * 4] ?? 0;
      out[i * 4] = h - domeDrop(Math.hypot(dx, dz));
      out[i * 4 + 1] = (sea[i * 4 + 1] ?? 0) - dx / DOME_RADIUS;
      out[i * 4 + 2] = (sea[i * 4 + 2] ?? 0) - dz / DOME_RADIUS;
      out[i * 4 + 3] = h;
    }
    return out;
  };

  /** Fits each tile's top fragments with a plane and checks it against the reference. */
  const analyse = (px: Float32Array, size: number, pixel: number): Rigidity => {
    const field = world.ocean.field;
    const o = world.origin.world;
    const ref = referencePlanes();
    const sums = new Map<number, number[]>();
    const hex = { q: 0, r: 0 };
    const c = { x: 0, y: 0 };
    let empty = 0;
    let skirts = 0;
    let outside = 0;
    for (let p = 0; p < size * size; p++) {
      const code = Math.round(px[p * 4 + 3] ?? 0) - 1;
      if (code < 0) {
        empty++;
        continue;
      }
      if (code % 2 === 1) {
        skirts++;
        continue;
      }
      const tile = code / 2;
      const x = px[p * 4] ?? 0;
      const y = px[p * 4 + 1] ?? 0;
      const z = px[p * 4 + 2] ?? 0;
      // The fragment's own tile, from its world position.
      hexAt(x + o.x, -z + o.y, hex);
      const q = (field.hex[tile * 2] ?? 0) + world.origin.centre.q;
      const r = (field.hex[tile * 2 + 1] ?? 0) + world.origin.centre.r;
      if (hex.q !== q || hex.r !== r) {
        // Allowed only within a pixel and a half of the tile's edge.
        hexCentre(q, r, c);
        const ex = Math.abs(x + o.x - c.x);
        const ey = Math.abs(-z + o.y - c.y);
        if (Math.max(ey, ex * (Math.sqrt(3) / 2) + ey / 2) < TILE_APOTHEM - 1.5 * pixel) {
          outside++;
        }
      }
      // Sums for the least squares of y = a + b·ex + c·ez about the tile's centre.
      const [cx, cz] = tileCentre(tile);
      const ex = x - cx;
      const ez = z - cz;
      let s = sums.get(tile);
      if (s === undefined) {
        s = new Array(9).fill(0);
        sums.set(tile, s);
      }
      const add = [1, ex, ez, ex * ex, ex * ez, ez * ez, y, ex * y, ez * y];
      for (let k = 0; k < 9; k++) {
        s[k] = (s[k] ?? 0) + (add[k] ?? 0);
      }
    }
    const planes = new Map<number, [number, number, number]>();
    let worstHeight = 0;
    let worstSlope = 0;
    for (const [tile, s] of sums) {
      const [n, sx, sz, sxx, sxz, szz, sy, sxy, szy] = s as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      if (n < 30) {
        continue;
      }
      const p = solve3([n, sx, sz, sx, sxx, sxz, sz, sxz, szz], [sy, sxy, szy]);
      planes.set(tile, p);
      worstHeight = Math.max(worstHeight, Math.abs(p[0] - (ref[tile * 4] ?? 0)));
      worstSlope = Math.max(
        worstSlope,
        Math.abs(p[1] - (ref[tile * 4 + 1] ?? 0)),
        Math.abs(p[2] - (ref[tile * 4 + 2] ?? 0)),
      );
    }
    let worstResidual = 0;
    for (let p = 0; p < size * size; p++) {
      const code = Math.round(px[p * 4 + 3] ?? 0) - 1;
      const plane = planes.get(code / 2);
      if (code < 0 || code % 2 === 1 || plane === undefined) {
        continue;
      }
      const [cx, cz] = tileCentre(code / 2);
      const fit =
        plane[0] + plane[1] * ((px[p * 4] ?? 0) - cx) + plane[2] * ((px[p * 4 + 2] ?? 0) - cz);
      worstResidual = Math.max(worstResidual, Math.abs((px[p * 4 + 1] ?? 0) - fit));
    }
    return { tiles: planes.size, empty, skirts, outside, worstResidual, worstHeight, worstSlope };
  };

  /**
   * Renders the tiles in use from straight above, centred on the scene
   * point (x, z), with a probe material: each pixel holds its fragment's
   * scene position and, in alpha, one more than twice its tile's instance
   * index, plus one on a skirt; 0 where no tile is drawn.
   */
  const probe = async (
    x: number,
    z: number,
    size: number,
    span: number,
    cut = false,
    look: Probe | 'colour' | null = null,
  ): Promise<Float32Array> => {
    const g = gfx();
    const tiles = world.ocean.tiles;
    const m = seaMaterial('sea-tile');
    m.positionNode = tiles.position;
    const id = varying(
      float(instanceIndex)
        .mul(2)
        .add(tiles.varyings.side.lessThan(-0.5).select(float(2), float(1))),
    );
    if (look === 'colour') {
      // The sea as it is drawn, in linear light.
      m.fragmentNode = tileLook(tiles.varyings, world.ocean.parts);
    } else if (look !== null) {
      // The look's own numbers for each fragment, in place of its colour.
      m.fragmentNode = tileLook(tiles.varyings, world.ocean.parts, look);
    } else {
      // With cut, the sea is left out of the hulls as it is on screen.
      m.fragmentNode = cut
        ? (Fn(() => {
            hulls.cut(positionWorld, tiles.varyings.nearHull);
            return vec4(positionWorld, id);
          })() as unknown as Node<'vec4'>)
        : vec4(positionWorld, id);
    }
    const scene = new Scene();
    const mesh = new Mesh(tiles.geometry, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    // Low enough that the look draws what it draws near the eye.
    const cam = new OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 60);
    cam.position.set(x, 30, z);
    cam.up.set(0, 0, -1);
    cam.lookAt(x, 0, z);
    cam.updateMatrixWorld();
    const target = new RenderTarget(size, size, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    });
    const r = g.renderer;
    const before = r.getRenderTarget();
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(before);
    const px = await readTarget(r, target, size, size, g.backend === 'webgl2');
    target.dispose();
    m.dispose();
    return px;
  };

  /** What stops the wake scene running, if one is. */
  let stopWakeScene: (() => void) | null = null;
  const hooks = {
    world,

    /**
     * What the scene is drawing with; backend is empty while a lost renderer
     * is rebuilt, and none on a page that draws nothing (?draw=off).
     */
    info(): Info {
      const g = stage.gfx;
      return {
        backend: stage.wanted === 'none' ? 'none' : (g?.backend ?? ''),
        compat: g?.compat ?? false,
        workgroup: g?.workgroup ?? 0,
        vertexStorageTextures: g?.vertexStorageTextures ?? 0,
        tier: world.rung.tier,
        rung: world.quality?.index ?? -1,
        rungs: (world.quality?.ladder ?? []).map(rungName),
        adaptive: world.quality?.enabled ?? false,
        detail: world.ocean.detail.state.kind,
        dispatches: world.stats.last.dispatches,
        spray: world.spray.count,
        floatTargets: g?.floatTargets ?? false,
        usePass: world.ocean.tiles === world.ocean.passTiles,
        recoveries: stage.recoveries,
        lastLoss: stage.lastLoss,
        pixelRatio: stage.pixelRatio(),
        drawCalls: world.stats.last.drawCalls,
        triangles: world.stats.last.triangles,
        tiles: world.ocean.field.count,
        origin: { east: world.origin.world.x, north: world.origin.world.y },
        centre: { q: world.origin.centre.q, r: world.origin.centre.r },
      };
    },

    game,
    sandbox: sailing.sandbox ?? null,

    /** Holds world time at t and stops the frame loop; frames are then drawn by render(). */
    freeze(t: number): void {
      game.freeze(t);
      stage.freeze(true);
      floatBoat();
    },

    /** Holds world time at a tick, however late in the world's life. */
    freezeTick(tick: number): void {
      game.freeze(0);
      game.clock.steps = tick;
      game.settle();
      stage.freeze(true);
      floatBoat();
    },

    /** Lets world time run and the frame loop draw again, as a page not under test does. */
    thaw(): void {
      game.thaw();
      stage.loopDraws = true;
      stage.freeze(false);
    },

    /**
     * Stops drawing, or draws again, as a hidden tab and a shown one do:
     * the boat sails on at the server, and world time runs. On CI's one
     * software GPU a page drawing the sea slows another's start to most of
     * a minute.
     */
    hold(on: boolean): void {
      stage.freeze(on);
      if (!on) {
        stage.resumed();
      }
    },

    /**
     * The picture a link is shared with, made of the next frame as the
     * player's tap makes it, naming name: its size, its type and weight,
     * and of the view above its strip, the share of pixels lit and the
     * spread of their brightness (a cleared canvas is black and even);
     * null if no frame came.
     */
    async picture(name: string): Promise<{
      width: number;
      height: number;
      bytes: number;
      type: string;
      lit: number;
      spread: number;
    } | null> {
      const m = await import('../ui/snapshot');
      const blob = await m.picture(() => stage.capture(), name);
      if (blob === null) {
        return null;
      }
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height - m.STRIP).data;
      let lit = 0;
      let n = 0;
      let low = 255;
      let high = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        const l = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
        n++;
        if (l > 12) {
          lit++;
        }
        low = Math.min(low, l);
        high = Math.max(high, l);
      }
      return {
        width: bmp.width,
        height: bmp.height,
        bytes: blob.size,
        type: blob.type,
        lit: n === 0 ? 0 : lit / n,
        spread: high - low,
      };
    },

    /** Draws one frame now, with the screen's words up to date; on a page that draws nothing, updates it. */
    render(): void {
      game.hud.flush();
      stage.renderOnce(performance.now());
    },

    /**
     * The sandbox's sea at once: the one the wind of calm, breeze, fresh or
     * gale raises, from the north; or flat water, whatever the wind.
     */
    setSea(name: string): void {
      const s = offline();
      const knots = SEA_STATES[name];
      s.sea.options.flat = knots === undefined;
      if (knots !== undefined) {
        s.steadyNow(knots * KNOT, 0);
      }
      s.settleSea();
      floatBoat();
    },

    /**
     * Puts a sea of the developer's own in the sandbox, in place of the
     * wind's: a window of areas, each with its inputs in whole steps, as a
     * scenario has them: a swell from the fourth, and with eight an area's
     * current, else the module's. It stays until the boat is next stepped
     * or placed.
     */
    setSeaWindow(col: number, row: number, size: number, areas: number[][]): void {
      const s = offline();
      s.seas.reset();
      s.seas.receive(
        {
          tick: 0,
          col,
          row,
          size,
          speed: areas.map((a) => a[0] ?? 0),
          from: areas.map((a) => a[1] ?? 0),
          fetch: areas.map((a) => a[2] ?? 0),
          swellHeight: areas.map((a) => a[3] ?? 0),
          swellPeriod: areas.map((a) => a[4] ?? 0),
          swellFrom: areas.map((a) => a[5] ?? 0),
        },
        areas.every((a) => a.length >= 8)
          ? { east: areas.map((a) => a[6] ?? 0), north: areas.map((a) => a[7] ?? 0) }
          : null,
      );
      floatBoat();
    },

    /**
     * A swell of the developer's own in every area of the sandbox's sea,
     * its height in m, period in s and the degrees it comes from; null goes
     * back to the storms'. The sea takes it at once.
     */
    setSwell(height: number | null, period = 6, from = 270): void {
      const s = offline();
      s.sea.options.swell =
        height === null
          ? null
          : { height, period, from: (((from % 360) + 360) % 360) * (Math.PI / 180) };
      s.settleSea();
      floatBoat();
    },

    /** The sea drawn: the significant height and the waves summed of the window's first area. */
    sea(): { slot: number; hs: number; waves: number; blended: boolean } {
      const b = world.ocean.band;
      return { slot: world.ocean.slot, hs: b.hs[0] ?? 0, waves: b.count, blended: b.blended };
    },

    /**
     * The boat band the GPU computes at scene points (x and z of each, in
     * turn), beside the physics module's: for each point its height, its
     * slope along x and z, and the sea's significant height.
     */
    async band(points: number[]): Promise<{ gpu: number[]; module: number[] }> {
      const n = points.length >> 1;
      const width = 64;
      const height = Math.max(1, Math.ceil(n / width));
      const at = new Float32Array(width * height * 4);
      for (let i = 0; i < n; i++) {
        at[i * 4] = points[i * 2] ?? 0;
        at[i * 4 + 1] = points[i * 2 + 1] ?? 0;
      }
      const input = new DataTexture(at, width, height, RGBAFormat, FloatType);
      input.needsUpdate = true;
      const m = new MeshBasicNodeMaterial();
      const p = textureLoad(input, ivec2(floor(screenCoordinate))).xy as unknown as Node<'vec2'>;
      m.fragmentNode = boatBandAt(world.ocean.uniforms)(p);
      const target = new RenderTarget(width, height, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, width, height, webgl());
      target.dispose();
      input.dispose();
      m.dispose();
      // As float32 holds the points on the GPU.
      const held = points.map(Math.fround);
      return { gpu: Array.from(got.subarray(0, n * 4)), module: Array.from(moduleSea(held)) };
    },
    /**
     * The share of the boat band the land's lee leaves, as the GPU reads it
     * from its texture at scene points (x and z of each, in turn), beside
     * the module's at the same points as float32 holds them.
     */
    async waveLee(points: number[]): Promise<{ gpu: number[]; module: number[]; fills: number }> {
      const n = points.length >> 1;
      const width = 64;
      const height = Math.max(1, Math.ceil(n / width));
      const at = new Float32Array(width * height * 4);
      for (let i = 0; i < n; i++) {
        at[i * 4] = points[i * 2] ?? 0;
        at[i * 4 + 1] = points[i * 2 + 1] ?? 0;
      }
      const input = new DataTexture(at, width, height, RGBAFormat, FloatType);
      input.needsUpdate = true;
      const m = new MeshBasicNodeMaterial();
      const p = textureLoad(input, ivec2(floor(screenCoordinate))).xy as unknown as Node<'vec2'>;
      const pass = world.ocean.pass;
      m.fragmentNode = vec4(waveLeeAt(p, pass.centre, pass.centreHex), 0, 0, 1);
      const target = new RenderTarget(width, height, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, width, height, webgl());
      target.dispose();
      input.dispose();
      m.dispose();
      const gpu: number[] = [];
      const module: number[] = [];
      const o = world.origin.world;
      const slot = world.ocean.slot;
      for (let i = 0; i < n; i++) {
        gpu.push(got[i * 4] ?? Number.NaN);
        const x = o.x + Math.fround(points[i * 2] ?? 0);
        const y = o.y - Math.fround(points[i * 2 + 1] ?? 0);
        module.push(
          slot >= 0 && driver.physics !== undefined ? driver.physics.leeAt(slot, x, y) : 1,
        );
      }
      return { gpu, module, fills: leeTexture.fills };
    },
    setPass(on: boolean): void {
      world.setUsePass(on);
    },
    setAntialias(a: 'fxaa' | 'smaa' | 'none'): void {
      stage.setAntialias(a);
    },
    /** Turns each tile's tint and shimmer offset on or off. */
    setIdentity(on: boolean): void {
      tileIdentity.value = on ? 1 : 0;
    },
    /** Puts the boat at a world position, keeping its heading. */
    placeBoat(east: number, north: number, heading?: number): void {
      offline().place(east, north, heading ?? driver.states.current[RECORDS.state.heading] ?? 0);
      floatBoat();
    },
    /**
     * The edge as the page has it: whether it is drawn, the boat's fall
     * (the tick it went over, the starts again), the line the screen shows,
     * the fade, whether the camera is held, the autopilot and the helm, and
     * the falls drawn.
     */
    edge() {
      const counts = world.edge.falls.counts;
      return {
        on: world.edge.on,
        over: driver.over ?? 0,
        restarts: driver.restarts ?? 0,
        notice: game.hud.bump.value,
        fade: Number(world.fade.style.opacity === '' ? 0 : world.fade.style.opacity),
        held: world.camera.held !== null,
        pilot: game.pilot.on,
        helm: game.helm.target,
        slabs: counts.slabs,
        curtain: counts.curtainTriangles,
      };
    },
    /** Shows or hides the falls' parts, for looking at each alone. */
    showFalls(curtain: boolean, slabs: boolean): void {
      world.edge.falls.show.curtain = curtain;
      world.edge.falls.show.slabs = slabs;
    },
    /** Puts the origin on tile (q, r), as if the boat had come from there. */
    setOrigin(q: number, r: number): void {
      world.origin.moveTo({ q, r });
    },
    /**
     * The sailor on the boat in view, as last drawn: its side deck, whether
     * it is crossing, the level drawn (deck or close), whether the aft hand
     * holds the tiller extension and how far from its hinge, where the
     * figure stands in the boat model, and whether it is a machine (and its
     * lamps' strength).
     */
    sailor() {
      const s = world.boat?.sailor ?? null;
      if (s === null) {
        return null;
      }
      const rt = s.runtime;
      return {
        side: rt.side,
        crossing: rt.crossing,
        close: !s.figure.visible,
        tiller: rt.hands.tiller,
        sheet: rt.hands.sheet,
        hold: rt.hands.tillerAt.distanceTo(s.runtime.boat.hinge),
        extension: s.runtime.boat.extension,
        at: rt.place.at.toArray(),
        machine: world.boat?.machineAboard ?? false,
        glow: rt.glow,
      };
    },
    /**
     * Makes the boat in view a machine sailor's, or not, as watching one
     * does: its machine aboard (once loaded) and the mark on its sail.
     * Resolves once the machine is aboard.
     */
    async machineAboard(on: boolean): Promise<void> {
      await world.showLook(on ? MACHINE_DEFAULT : PERSON_DEFAULT);
    },
    /**
     * Draws the boat in view's sailor in a look, by its code, as the server
     * tells it; resolves once it is drawn.
     */
    async lookAboard(code: number): Promise<void> {
      await world.showLook(code);
    },
    /** The boat in view's sailor's look as drawn: its art's deck level and whether it is a machine; null for none. */
    lookDrawn(): { model: string; machine: boolean } | null {
      const b = world.boat;
      return b === null ? null : b.drawnLook();
    },
    /** Puts the camera at a preset, by name, or at a view of its own. */
    camera(name: string | CameraView): void {
      const p = typeof name === 'string' ? CAMERA_PRESETS[name] : name;
      if (p === undefined) {
        throw new Error(`no camera preset ${name}`);
      }
      world.placeCamera(p);
    },

    /** Every material the factory did not make, or made without the bend; with plant, after planting a plain one. */
    checkScene(plant = false): string[] {
      if (!plant) {
        return checkScene(stage.scene);
      }
      const planted = new Mesh(undefined, new MeshBasicMaterial());
      planted.name = 'planted';
      stage.scene.add(planted);
      try {
        return checkScene(stage.scene);
      } finally {
        stage.scene.remove(planted);
      }
    },

    /** Loses the GPU device (WebGPU) or the WebGL context. */
    loseDevice(): void {
      const g = gfx();
      const backend = g.renderer.backend as unknown as {
        device?: GPUDevice;
        gl?: WebGL2RenderingContext;
      };
      if (g.backend === 'webgpu') {
        backend.device?.destroy();
      } else {
        backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },

    /** The tile pass's output for the last frame, beside the reference: per tile [H, ∂H/∂x, ∂H/∂z, h]. */
    async planes(): Promise<{ gpu: number[]; cpu: number[]; count: number }> {
      const ocean = world.ocean;
      const count = ocean.field.count;
      const gpu = await readTarget(
        gfx().renderer,
        ocean.pass.target,
        PASS_WIDTH,
        ocean.pass.target.height,
        webgl(),
      );
      return {
        gpu: Array.from(gpu.subarray(0, count * 4)),
        cpu: Array.from(referencePlanes()),
        count,
      };
    },

    /**
     * Makes spells the sandbox's spells of weather, each by its fields'
     * names, as a file of Go's has them. They stay until the weather is
     * next set.
     */
    setSpells(spells: RecordValues[]): void {
      offline().weather.set(spells.map(spellOf));
    },

    /**
     * The gust rings as they are drawn: where each is in the world, how
     * wide and how much of it shows; and the gust factor at its middle now.
     */
    gustRings(): { east: number; north: number; radius: number; shown: number; factor: number }[] {
      const physics = driver.physics;
      return world.gustRings.rings.map((r) => {
        let factor = 1;
        if (physics !== undefined) {
          physics.windDrawAt(world.ticks);
          factor = physics.windPoint(r.east, r.north)[RECORDS.wind.factor] ?? 1;
        }
        return { ...r, factor };
      });
    },

    /** Draws the gusts on the tiles, or the water without them. */
    showGusts(on: boolean): void {
      world.ocean.gusts.shown = on ? 1 : 0;
    },

    /**
     * The gust field the GPU computes at scene points (x and z of each, in
     * turn), beside the physics module's, at the time of the last frame.
     */
    async gusts(points: number[]): Promise<{ gpu: number[]; module: number[] }> {
      const n = points.length >> 1;
      const width = 64;
      const height = Math.max(1, Math.ceil(n / width));
      const at = new Float32Array(width * height * 4);
      for (let i = 0; i < n; i++) {
        at[i * 4] = points[i * 2] ?? 0;
        at[i * 4 + 1] = points[i * 2 + 1] ?? 0;
      }
      const input = new DataTexture(at, width, height, RGBAFormat, FloatType);
      input.needsUpdate = true;
      const m = new MeshBasicNodeMaterial();
      const p = textureLoad(input, ivec2(floor(screenCoordinate))).xy as unknown as Node<'vec2'>;
      m.fragmentNode = vec4(gustAt(world.ocean.gusts)(p), 0, 0, 1);
      const target = new RenderTarget(width, height, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, width, height, webgl());
      target.dispose();
      input.dispose();
      m.dispose();
      const gpu: number[] = [];
      for (let i = 0; i < n; i++) {
        gpu.push(got[i * 4] ?? Number.NaN);
      }
      // As float32 holds the points on the GPU.
      return { gpu, module: moduleGusts(points.map(Math.fround)) };
    },

    /**
     * The gust field at each tile's centre as the tile pass wrote it for
     * the last frame, beside the physics module's.
     */
    async tileGusts(): Promise<{ gpu: number[]; module: number[]; count: number }> {
      const ocean = world.ocean;
      const count = ocean.field.count;
      const all = await readTarget(
        gfx().renderer,
        ocean.pass.target,
        PASS_WIDTH,
        ocean.pass.target.height,
        webgl(),
      );
      const centre = ocean.tiles.centre.value;
      const gpu: number[] = [];
      const points: number[] = [];
      for (let i = 0; i < count; i++) {
        gpu.push(all[(GUST_ROW * PASS_WIDTH + i) * 4] ?? Number.NaN);
        points.push(
          centre.x + (ocean.field.offset[i * 2] ?? 0),
          centre.y - (ocean.field.offset[i * 2 + 1] ?? 0),
        );
      }
      return { gpu, module: moduleGusts(points), count };
    },

    /** The largest step between neighbouring tiles at their shared corners, from the pass's planes. */
    async steps(): Promise<{ largest: number; skirt: number }> {
      const field = world.ocean.field;
      const gpu = await readTarget(
        gfx().renderer,
        world.ocean.pass.target,
        PASS_WIDTH,
        world.ocean.pass.target.height,
        webgl(),
      );
      const index = new Map<string, number>();
      for (let i = 0; i < field.count; i++) {
        index.set(`${field.hex[i * 2]},${field.hex[i * 2 + 1]}`, i);
      }
      const height = (i: number, ex: number, ez: number): number =>
        (gpu[i * 4] ?? 0) + (gpu[i * 4 + 1] ?? 0) * ex + (gpu[i * 4 + 2] ?? 0) * ez;
      const at = { x: 0, y: 0 };
      const half = Math.PI / 6;
      let largest = 0;
      for (let i = 0; i < field.count; i++) {
        const q = field.hex[i * 2] ?? 0;
        const r = field.hex[i * 2 + 1] ?? 0;
        for (const n of NEIGHBOURS) {
          const j = index.get(`${q + n.q},${r + n.r}`);
          if (j === undefined) {
            continue;
          }
          // From tile i's centre to tile j's, in the scene's x and z.
          hexCentre(n.q, n.r, at);
          const dx = at.x;
          const dz = -at.y;
          const d = Math.hypot(dx, dz);
          // The shared edge's ends: the corners 30° either side of the line between centres.
          for (const s of [-1, 1]) {
            const ux = dx / d;
            const uz = dz / d;
            const ex = (ux * Math.cos(half) - s * uz * Math.sin(half)) * TILE_RADIUS;
            const ez = (uz * Math.cos(half) + s * ux * Math.sin(half)) * TILE_RADIUS;
            largest = Math.max(largest, Math.abs(height(i, ex, ez) - height(j, ex - dx, ez - dz)));
          }
        }
      }
      return { largest, skirt: SKIRT_DEPTH };
    },

    /**
     * Draws the tiles from straight above with a probe material that writes
     * each fragment's scene position and tile, then checks every tile in
     * view: its top fragments lie on one plane; that plane matches the
     * reference; each fragment lies in its own tile's hexagon; and every
     * pixel shows a tile's top, never a gap or a skirt.
     */
    async rigidity(size = 512, span = 48): Promise<Rigidity> {
      const bs = world.boatScene;
      return analyse(await probe(bs.x, bs.z, size, span), size, span / size);
    },

    /**
     * The tiles seen from straight above over a square of the world centred
     * on (east, north): each pixel's tile (q, r) and world position, or
     * nothing where no tile is drawn.
     */
    async tileMap(
      east: number,
      north: number,
      size = 128,
      span = 40,
    ): Promise<{ q: number[]; r: number[]; east: number[]; north: number[] }> {
      const o = world.origin;
      const px = await probe(east - o.world.x, -(north - o.world.y), size, span);
      const field = world.ocean.field;
      const out = {
        q: [] as number[],
        r: [] as number[],
        east: [] as number[],
        north: [] as number[],
      };
      for (let p = 0; p < size * size; p++) {
        const code = Math.round(px[p * 4 + 3] ?? 0) - 1;
        const tile = Math.floor(code / 2);
        const ok = code >= 0;
        out.q.push(ok ? (field.hex[tile * 2] ?? 0) + o.centre.q : Number.NaN);
        out.r.push(ok ? (field.hex[tile * 2 + 1] ?? 0) + o.centre.r : Number.NaN);
        out.east.push(ok ? (px[p * 4] ?? 0) + o.world.x : Number.NaN);
        out.north.push(ok ? -(px[p * 4 + 2] ?? 0) + o.world.y : Number.NaN);
      }
      return out;
    },

    /**
     * Draws a frame in an animation frame, as the game's loop does, and
     * resolves once it is on screen, for a screenshot. (A WebGPU or WebGL
     * canvas is cleared once presented, so the page cannot read its own
     * pictures back; the tests take screenshots instead.) It waits for the
     * GPU to finish what it was given: on a software GPU the shaders a
     * scene first draws compile there for seconds after the page has
     * moved on, and a screenshot would wait for them.
     */
    async show(): Promise<void> {
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          stage.renderOnce(performance.now());
          r();
        }),
      );
      const backend = stage.gfx?.renderer.backend as
        | { device?: GPUDevice; gl?: WebGL2RenderingContext }
        | undefined;
      if (backend?.device !== undefined) {
        await backend.device.queue.onSubmittedWorkDone();
      } else if (backend?.gl !== undefined) {
        // Chrome's finish() does not wait; a fence, polled between tasks, does.
        const gl = backend.gl;
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        while (fence !== null && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
          await new Promise((r) => setTimeout(r, 20));
        }
        gl.deleteSync(fence);
      }
      await frame();
      await frame();
    },

    /**
     * How far the GPU's planes may stand from the float64 reference: WGSL
     * promises sin and cos only to 2⁻¹¹ absolute (WebGPU Shading Language,
     * 15.7.4), so each wave may be off by its amplitude (height) or its
     * amplitude times k (slope) times that, plus float32's rounding.
     */
    tolerance(): { height: number; slope: number } {
      let a = 0;
      let ak = 0;
      const physics = driver.physics;
      const slot = world.ocean.slot;
      if (physics !== undefined && slot >= 0) {
        // The highest of the window's areas: a blend is never above it.
        const amp = physics.seaAmplitudes(slot);
        const k = physics.records.components.subarray(
          RECORDS.components.k,
          RECORDS.components.k + SEA.components,
        );
        for (let area = 0; area < SEA.window * SEA.window; area++) {
          let sum = 0;
          let steep = 0;
          for (let i = 0; i < SEA.components; i++) {
            const v = amp[area * SEA.components + i] ?? 0;
            sum += v;
            steep += v * (k[i] ?? 0);
          }
          a = Math.max(a, sum);
          ak = Math.max(ak, steep);
        }
      }
      return { height: a * 2 ** -11 + 2e-5, slope: ak * 2 ** -11 + 2e-6 };
    },

    /**
     * Resolves when the boat's model and its sailors have loaded (the own
     * boat's, and the fleet's first look). The low tier's loops are made
     * whole at once, unless told to leave them to the frames.
     */
    async ready(finish = true): Promise<void> {
      while (world.boat === null) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await world.sailorsLoaded;
      if (finish) {
        world.ocean.detail.finishBake();
      }
    },

    /** The GPU's tile hash against tileHash, for tiles sampled across the disk. */
    async hashes(): Promise<{ checked: number; differ: string[] }> {
      const n = 64;
      const pairs = new Float32Array(n * n * 4);
      const want: number[] = [];
      let seed = 12345;
      const rand = (): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < n * n; i++) {
        const q = Math.round((rand() * 2 - 1) * 2406);
        const r = Math.round((rand() * 2 - 1) * 2406);
        pairs[i * 4] = q;
        pairs[i * 4 + 1] = r;
        want.push(tileHash(q, r));
      }
      const input = new DataTexture(pairs, n, n, RGBAFormat, FloatType);
      input.needsUpdate = true;
      const m = new MeshBasicNodeMaterial();
      const qr = textureLoad(input, ivec2(floor(screenCoordinate))).xy;
      m.fragmentNode = vec4(float(tileHashNode(qr)), qr, 1);
      const target = new RenderTarget(n, n, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, n, n, webgl());
      target.dispose();
      const differ: string[] = [];
      for (let i = 0; i < n * n; i++) {
        if (got[i * 4] !== want[i]) {
          differ.push(`(${pairs[i * 4]}, ${pairs[i * 4 + 1]}): GPU ${got[i * 4]}, CPU ${want[i]}`);
        }
      }
      return { checked: n * n, differ: differ.slice(0, 10) };
    },

    /** The boat's state and Out by name, the controls, and what the screen shows. */
    boat() {
      const named = <R extends Record<string, number>>(record: R, v: Float64Array) =>
        Object.fromEntries(Object.entries(record).map(([k, i]) => [k, v[i] ?? 0])) as {
          [K in keyof R]: number;
        };
      // The boat drawn: the own, or one watched.
      const drawn = game.driver ?? driver;
      return {
        state: named(RECORDS.state, drawn.states.current),
        out: named(RECORDS.out, drawn.out),
        helm: game.helm.target,
        sheet: game.sheet.target,
        steps: game.clock.steps,
        wind: { ...drawn.wind },
        pilot: {
          mode: game.pilot.mode,
          target: game.pilot.target,
          order: game.pilot.order,
          way: game.pilot.way,
          degrees: game.pilot.degrees,
          text: game.hud.pilot.value,
        },
      };
    },

    /** The state's fields in hexadecimal, as the golden tests write them. */
    stateBits(): Record<string, string> {
      return Object.fromEntries(
        Object.entries(RECORDS.state).map(([k, i]) => [k, toHex(driver.states.current[i] ?? 0)]),
      );
    },

    /** Back to the start, at rest, steering by hand. */
    reset(): void {
      offline().reset();
      game.pilot.off();
      floatBoat();
    },
    /**
     * Everything a test may have changed of the look put back as a page
     * opens with it, the sea that of the named state (or the start's wind),
     * so that one page serves several tests: the fleet, the parts, the fold,
     * the spray, the quality and its timing, the wakes and the foam.
     */
    async resetLook(sea: string | null): Promise<void> {
      world.fleetSource = null;
      world.ocean.detail.fold = null;
      detailOn.value = 1;
      foamOn.value = 1;
      world.ocean.drawWakes = true;
      world.ocean.gusts.shown = 1;
      world.sprayHidden = false;
      tileIdentity.value = 1;
      if (world.boat !== null) {
        world.boat.root.visible = true;
      }
      game.beforeStep = null;
      game.pilot.off();
      game.helm.target = 0;
      game.sheet.target = 0.5;
      world.windowMs = null;
      if (world.quality !== null) {
        world.quality.enabled = false;
      }
      const s = offline();
      s.sea.options.flat = false;
      s.sea.options.fetch = null;
      s.sea.options.split = null;
      s.sea.options.swell = s.startSwell;
      const knots = sea === null ? undefined : SEA_STATES[sea];
      if (knots !== undefined) {
        s.steadyNow(knots * KNOT, 0);
      } else {
        s.steadyNow(s.start.wind.speed, s.start.wind.from);
      }
      await world.setRung(0, 'test');
      world.ocean.detail.finishBake();
      stopWakeScene?.();
      stopWakeScene = null;
      world.ocean.wakes.clear();
      world.ocean.wakeWaves.clear();
      world.ocean.wakeWaves.gain.value = WAKE_WAVES.gain;
      world.ocean.detail.clearFoam();
      world.spray.reset(1);
    },
    setState(values: Record<string, number>): void {
      offline().setState(values);
      floatBoat();
    },
    /** Asks for the main reefed to a level, 0 … 2, as the Reef key does. */
    setReef(level: number): void {
      game.setReef(level);
    },
    /**
     * Sails another of the catalog's boats, by its id or its place among
     * them, from the start: the sandbox steps it and the scene draws it.
     * Resolves once it is drawn.
     */
    async useBoat(id: string | number): Promise<void> {
      const kind =
        typeof id === 'number'
          ? catalog.boats[id] === undefined
            ? -1
            : id
          : catalog.boats.findIndex((b) => b.id === id);
      if (kind < 0) {
        throw new Error(`the catalog has no boat ${id}`);
      }
      offline().setKind(kind);
      game.setReef(0);
      await game.useKind(kind);
      floatBoat();
    },
    /** The sandbox's wind, steady and at once, in knots and the degrees it comes from. */
    setWind(knots: number, from: number): void {
      offline().steadyNow(knots * KNOT, (from * Math.PI) / 180);
    },
    /**
     * The sandbox's weather, as a server's developer sets it, from the
     * second after the next step's: a regime's id, or steady.
     */
    setWeather(id: string): void {
      offline().setWeather(id);
    },
    /** Draws the weather in the sky, or none of it: no clouds, sheets or rain. */
    showWeather(on: boolean): void {
      world.weather.shown = on;
    },
    /** Holds the rain at the camera, mm an hour, or null to give it back to the weather. */
    setRain(rate: number | null): void {
      world.weather.heldRain = rate;
    },
    /**
     * The weather in the sky as last drawn: the heaped clouds and the
     * cumulus laid out (each its form, its slot among the heaped or −1,
     * its centre, top and puffs), the puffs and streaks drawn, the rain and
     * the overcast at the camera, and the sheets' cover overhead.
     */
    clouds() {
      const w = world.weather;
      const o = world.origin.world;
      const cam = world.stage.camera.position;
      const east = cam.x + o.x;
      const north = -cam.z + o.y;
      return {
        clouds: w.clouds.shown.map((c) => ({ ...c })),
        puffs: w.clouds.count,
        heapedPuffs: w.clouds.heaped,
        curtains: w.curtains.count,
        streaks: w.streaks.count,
        rain: w.rain,
        overcast: w.overcast,
        sheets: [0, 1, 2].map((l) => w.sheets.coverAt(l, east, north)),
        visualRange: look.visualRange.value as number,
        light: world.sky.light.intensity,
        far: world.stage.camera.far,
        drawn: w.clouds.mesh.visible && w.clouds.count > 0,
      };
    },
    /**
     * The air at the camera as last drawn: the visibility there, m, its
     * word, the extinction by what makes it (clear air, fog, rain, mist),
     * the sources of extinction the GPU sums, the overcast the fog and rain
     * overhead make, and the sea's horizon's reach.
     */
    visibility() {
      const source = world.ocean.source;
      const physics = source?.weather === true ? source.physics : null;
      const o = world.origin.world;
      const cam = world.stage.camera.position;
      const east = cam.x + o.x;
      const north = -cam.z + o.y;
      if (physics === null) {
        return null;
      }
      physics.windDrawAt(world.ticks);
      const v = physics.visibilityAt(east, north);
      const air = [...physics.airAt(east, north, Math.max(cam.y, 0.5))];
      return {
        visibility: v,
        word: ['good', 'moderate', 'poor', 'very poor'][physics.visibilityWord(v)] ?? 'good',
        air,
        sources: airLook.count.value as number,
        fogOvercast: world.weather.fogOvercast,
        overcast: world.weather.overcast,
        cameraRange: world.sky.cameraRange,
        hazeFar: look.hazeFar.value as number,
      };
    },
    /** The optical depth along a line, as the module gives it at the frame's time. */
    opticalDepth(
      x0: number,
      y0: number,
      h0: number,
      x1: number,
      y1: number,
      h1: number,
    ): number | null {
      const source = world.ocean.source;
      const physics = source?.weather === true ? source.physics : null;
      if (physics === null) {
        return null;
      }
      physics.windDrawAt(world.ticks);
      return physics.opticalDepth(x0, y0, h0, x1, y1, h1);
    },
    /** Holds a fog bank on the boat of a core of so many metres of visibility, or none with null. */
    setFog(core: number | null): void {
      offline().holdFog(core);
    },
    /**
     * The flashes of the last minute as the page holds them, the pulses it
     * drew, world seconds, the bolts' segments drawn and how brightly a
     * flash lights its cloud now.
     */
    flashes() {
      const l = world.lightning;
      return {
        flashes: l.flashes.map((f) => ({ ...f, strokes: [...f.strokes] })),
        pulses: [...l.pulses],
        segments: l.segments,
        cloud: l.cloud.strength,
        seconds: world.ticks / 30,
      };
    },
    /** The nearest heaped cloud flashes to the sea seconds from now: the sandbox's own flash. */
    flashIn(seconds: number): void {
      const p = world.pose;
      world.lightning.force(flashNear(world.weather.heaped, p.east, p.north, world.ticks, seconds));
    },
    /**
     * The lights near as the page holds them, each with its fog signal: its
     * notation, how far and where it lies from the boat, its blasts' delay,
     * s, and whether the visibility at it is under the catalog's sounding.
     */
    fogSignals() {
      const source = world.ocean.source;
      const physics = source?.weather === true ? source.physics : null;
      physics?.windDrawAt(world.ticks);
      const p = world.pose;
      const rule = catalog.world.lights.fogSignal;
      return [...world.lighthouses.lights.values()].map((l) => {
        const d = Math.hypot(l.east - p.east, l.north - p.north);
        const v = physics?.visibilityAt(l.east, l.north) ?? Number.POSITIVE_INFINITY;
        return {
          light: l.number,
          signal: l.fogSignal,
          notation: catalog.world.lights.fogSignals[l.fogSignal]?.notation ?? '',
          distance: d,
          bearing: ((Math.atan2(l.east - p.east, l.north - p.north) * 180) / Math.PI + 360) % 360,
          delay: d / catalog.weather.thunder.speed,
          visibility: v,
          sounding: v < rule.sounds * 1852,
          heard: d <= rule.heard * 1852,
        };
      });
    },
    /** Where the sun is on the canvas, CSS pixels, and whether it is in front of the camera. */
    sunOnScreen(): { x: number; y: number; front: boolean } | null {
      const canvas = stage.gfx?.canvas;
      if (canvas === undefined) {
        return null;
      }
      const at = world.stars.screen(
        (look.sun.value as Vector3).clone(),
        stage.camera,
        canvas.clientWidth,
        canvas.clientHeight,
        new Vector3(),
      );
      return { x: at.x, y: at.y, front: at.z < 1 };
    },
    /** The autopilot as its keys work it: on at the boat's angle to the wind, about in a tack or a wear (gybe), or off. */
    autopilot(order: 'wind' | 'tack' | 'gybe' | 'off'): void {
      if (order === 'wind') {
        game.engagePilot(PILOT_WIND);
      } else if (order === 'tack') {
        game.pilotTack();
      } else if (order === 'gybe') {
        game.pilotGybe();
      } else {
        game.takeHelm();
      }
    },
    /** Sets the helm's and the sheet's targets, as the player's thumbs would. */
    setControls(helm: number, sheet: number): void {
      game.helm.target = helm;
      game.sheet.target = sheet;
    },
    /** Steps the boat n times through the game's own step, with its controls (and script). */
    advance(n: number): void {
      for (let i = 0; i < n; i++) {
        game.stepOnce();
      }
      game.settle();
    },
    /**
     * Sails on with time held: frames times, steps steps and then draws a
     * frame, so that what moves with world time (the wakes, the spray) sees
     * steps / 30 s pass each frame, however slowly the machine draws.
     */
    sailFrames(frames: number, steps = 2): void {
      for (let i = 0; i < frames; i++) {
        for (let j = 0; j < steps; j++) {
          game.stepOnce();
        }
        stage.renderOnce(performance.now());
      }
    },
    /**
     * Scripts the controls before every step: 'steer' holds a heading in
     * radians as the golden scenarios do; 'wiggle' moves both controls to
     * and fro; null stops.
     */
    script(kind: 'steer' | 'wiggle' | null, heading = 0): void {
      if (kind === 'steer') {
        game.beforeStep = () => {
          game.helm.target = steer(heading, driver.states.current);
        };
      } else if (kind === 'wiggle') {
        let n = 0;
        game.beforeStep = () => {
          n++;
          game.helm.target = 0.6 * Math.sin(n / 40);
          game.sheet.target = 0.4 + 0.3 * Math.sin(n / 90);
        };
      } else {
        game.beforeStep = null;
      }
    },
    /** Plays a bump as if the server had told of it now: the knock, the shake, the verdict's line. */
    bump(b: BumpTold): void {
      game.bump(b, performance.now());
    },

    /**
     * What the encounters show: the right-of-way overlay's marks and their
     * labels on the page, the tack and the bump's line under the readout,
     * the camera's shake, the knocks played, and the dirty air's wedges,
     * each with the axis of its wake and its boat's view slot (−1 the
     * player's).
     */
    encounters() {
      const labels = [...document.querySelectorAll<HTMLElement>('.right-of-way-label')]
        .filter((el) => !el.hidden)
        .map((el) => el.textContent ?? '');
      const dirt = world.dirtyAir;
      return {
        marks: world.rightOfWay.shown.map((m) => ({ ...m })),
        labels,
        tack: game.hud.tack.value,
        bump: game.hud.bump.value,
        shake: world.camera.shakeSize,
        knocks: game.sound.knocks,
        bumps: game.bumps,
        wedges: dirt.drawn,
        axes: dirt.axes.slice(0, dirt.drawn).map((a) => ({ ...a })),
      };
    },

    /** Draws only every n-th animation frame; null for the measured cap. */
    capFrames(n: number | null): void {
      stage.cap.forced = n;
    },
    settings(change: Partial<Settings>): void {
      game.settings.set(change);
    },
    /**
     * The sandbox's screen as it is while a boat is watched (the plate at
     * its foot, nothing that steers), that sailor's, a machine sailor's
     * with the cog, the list of sailors to watch open over it if asked;
     * null as it is while sailing.
     */
    watchPlate(sailor: string | null, machine = true, list = false, mine = false): void {
      sailing.remount?.(
        sailor === null
          ? null
          : {
              watching: signal({ sailor, machine, mine, look: -1 }),
              spectating: signal(true),
              status: signal('sailing'),
              ended: signal(null),
              place: signal(null),
              boatPlace: signal(null),
              watchers: signal(0),
              list: signal(list),
              watch: () => {},
              sail: () => {},
              unwatch: () => {},
              comeAboard: () => {},
            },
      );
    },
    /**
     * The sandbox's screen as it is in a scene of sailing together (see
     * deckscenes.ts), the sailor named in it, and a knock's state; null as
     * it is while sailing alone. What the screen asks of it is kept, for
     * deckCalls.
     */
    deckScene(name: DeckSceneName | null, sailor?: string, state?: KnockStateTold): void {
      if (name === null) {
        deckCalls = [];
        sailing.remount?.(null, null);
        return;
      }
      const scene = deckScene(name, sailor, state);
      deckCalls = scene.calls;
      sailing.remount?.(scene.watch, scene.deck, scene.statements);
    },
    /** What the screen of the latest deckScene asked of it, in order. */
    deckCalls(): string[] {
      return [...deckCalls];
    },
    /**
     * The question asked before the own boat leaves the water to watch, in
     * its window over the screen at sea, as the list shows it; false takes
     * it away. Resolves once it is drawn.
     */
    async leaveQuestion(on: boolean): Promise<void> {
      document.querySelector('.hud.leave-test')?.remove();
      if (!on) {
        return;
      }
      const [{ h, render }, { LeaveWindow }] = await Promise.all([
        import('preact'),
        import('../ui/watch'),
      ]);
      const host = document.createElement('div');
      host.className = 'hud leave-test';
      document.body.append(host);
      const gone = () => host.remove();
      render(h(LeaveWindow, { className: 'panel watch-list', leave: gone, stay: gone }), host);
    },
    /** What the page did from the tap to the world's reveal; null before it, or in the sandbox. */
    revealed(): Revealed | null {
      return sailing.revealed?.() ?? null;
    },
    /** Whether the cover is over the page: shown, and not lifting. */
    covered(): boolean {
      const c = document.getElementById('cover');
      return c !== null && !c.hidden && !c.classList.contains('lifting');
    },
    /** Shows or puts away the key that brings the full screen back, as after the phone was away. */
    fullScreenKey(shown: boolean): void {
      if (sailing.fullScreen !== undefined) {
        sailing.fullScreen.key.value = shown;
      }
    },
    /**
     * Holds the case's readouts at the shortest or the longest they say, or
     * lets them follow the boat again (null).
     */
    readouts(at: 'shortest' | 'longest' | null): void {
      const h = game.hud;
      h.held = at !== null;
      if (at === null) {
        h.flush();
        return;
      }
      const long = at === 'longest';
      h.speed.value = long ? '18.8' : '0.0';
      h.heading.value = long ? '338° NNW' : '000° N';
      h.figures.value = long ? '338°' : '000°';
      h.wind.value = long ? 'WNW 88 kn · F12' : 'N 0 kn · F0';
      h.pilot.value = long ? 'Wind 135° P' : '';
      h.tack.value = long ? 'Starboard tack' : '';
      // The longest a reef is said in, reefed, or a downwind sail going
      // up, set or coming in.
      const c = h.controls.value;
      const lines = [
        ...(c?.reef ?? []).slice(1),
        ...[
          [0, 1],
          [1, 1],
          [0.5, 0],
        ].map(([hoist, target]) => downwindLine(c, hoist ?? 0, target ?? 0)),
      ];
      h.reefed.value = long ? lines.reduce((a, b) => (b.length > a.length ? b : a), '') : '';
    },
    /**
     * Holds the sheet's legend at what the sail is doing, '' for nothing,
     * the readouts held with it, and with kite the downwind sail set; null
     * lets them all follow the boat again.
     */
    sail(state: SailState | null, kite = false): void {
      const h = game.hud;
      h.held = state !== null;
      h.sail.value = state ?? '';
      h.kite.value = kite;
      if (state === null) {
        h.flush();
      }
    },
    /** The audio context's state: 'none' before the first gesture. */
    soundState(): string {
      return game.sound.state;
    },

    /**
     * The world's end as this page sees it: the world of the latest
     * Welcome, its end, ms of UTC, the world clock's now as UTC, the
     * countdown the pocket chart shows, and the staged end at the last frame.
     */
    ending() {
      const o = sailing.online;
      if (o === undefined) {
        throw new Error('the boat is sailed offline');
      }
      const s = world.endStage;
      return {
        world: o.world,
        ends: o.endsMs,
        now: o.utcMs(),
        falls: document.querySelector('[data-readout="falls"]')?.textContent ?? '',
        stage: {
          sound: s.sound,
          mist: s.mist,
          cut: Number.isFinite(s.cut) ? s.cut : -1,
          veil: s.veil,
        },
      };
    },

    /** Counts prediction's snapshots and corrections afresh: a boat put elsewhere first is not one. */
    countAfresh(): void {
      const p = sailing.predictor;
      if (p === undefined) {
        throw new Error('the boat is sailed offline');
      }
      for (const k of Object.keys(p.counts) as (keyof typeof p.counts)[]) {
        p.counts[k] = 0;
      }
      p.sizes.length = 0;
    },

    /** The game connection: where it stands and what prediction has seen. */
    net() {
      const o = sailing.online;
      const p = sailing.predictor;
      if (o === undefined || p === undefined) {
        throw new Error('the boat is sailed offline');
      }
      return {
        status: o.status.value,
        notice: o.notice.value?.text ?? null,
        boat: o.boat,
        tick: p.tick,
        m: o.ahead.m,
        rtt: o.rtt.value,
        look: o.look.value,
        counts: { ...p.counts },
        p95: p.p95(),
        traffic: { ...o.traffic },
        tools: o.tools.value,
        stays: p.stays,
      };
    },
    /**
     * Watching another sailor's boat: whose, whether the boat drawn is not
     * the own, where the connection stands, why the last watch ended, the
     * place in the spectators' queue, how many watch the own boat, the
     * Inputs sent that carried controls (the worker's count, as its last
     * traffic said), and the boat drawn as the page draws it.
     */
    watch() {
      const o = sailing.online;
      if (o === undefined) {
        throw new Error('the boat is sailed offline');
      }
      const s = o.driver.states.current;
      return {
        watching: o.watching.value,
        spectating: o.spectating.value,
        status: o.status.value,
        ended: o.ended.value,
        place: o.watchPlace.value,
        watchers: o.watchers.value,
        controls: o.traffic.controls,
        east: s[RECORDS.state.x] ?? 0,
        north: s[RECORDS.state.y] ?? 0,
        ticks: world.ticks,
      };
    },
    /**
     * Sailing together: whose boat the connection is aboard, who is aboard
     * the boat in view and who holds its controls, the knocks waiting on
     * the own boat, how the own knock stands, the controls offered, and
     * whether the connection holds the controls; with the controls held
     * in force, as the screen shows them.
     */
    deck() {
      const o = sailing.online;
      if (o === undefined) {
        throw new Error('the boat is sailed offline');
      }
      return {
        aboard: o.aboard.value,
        crew: o.crew.value,
        knocks: o.knocks.value,
        knocking: o.knocking.value,
        handed: o.handed.value,
        holding: o.holding.value,
        spectating: o.spectating.value,
        boat: o.boat,
        controls: o.traffic.controls,
      };
    },
    /** Asks to watch a sailor's boat, as the list does. */
    watchSailor(name: string): void {
      sailing.online?.watch(name);
    },
    /** Asks for a boat, as Sail does. */
    sailAgain(): void {
      sailing.online?.sail();
    },
    /**
     * The land: the chunks handed and held, which are drawn this frame,
     * their highest land, the module's slots, and the worker's counts.
     */
    /**
     * The lighthouses and wrecks as the page has them: the lighthouses' and
     * wrecks' places known, the lights in range, and how many towers, glows
     * (glows, looms and beams), wrecks and sunk wrecks' shadows are drawn,
     * with each glow drawn's mode and strength.
     */
    lights() {
      const l = world.lighthouses;
      const place = l.place.array as Float32Array;
      const shows = l.shows.array as Float32Array;
      const glows = [];
      for (let i = 0; i < l.count; i++) {
        glows.push({
          x: place[i * 4] ?? 0,
          y: place[i * 4 + 1] ?? 0,
          z: place[i * 4 + 2] ?? 0,
          mode: ['glow', 'loom', 'beam'][place[i * 4 + 3] ?? 0] ?? '',
          strength: shows[i * 4 + 3] ?? 0,
        });
      }
      return {
        sites: [...l.sites.values()],
        lights: [...l.lights.values()].map(
          ({ number, east, north, focal, character, phase, range }) => ({
            number,
            east,
            north,
            focal,
            character,
            phase,
            range,
          }),
        ),
        towers: l.towers.count,
        glows,
        wrecks: [...world.wrecks.known.values()],
        wreckVertices: world.wrecks.mesh.geometry.getAttribute('position')?.count ?? 0,
        shadowVertices: world.wrecks.shadows.geometry.getAttribute('position')?.count ?? 0,
        worldUs: Math.floor((world.ticks * 1e6) / STEPS_PER_SECOND),
      };
    },
    land() {
      const l = world.land;
      if (l === null) {
        return null;
      }
      const handed = l.handed.sort((a, b) => a - b);
      return {
        handed,
        grids: [...l.grids.keys()].sort((a, b) => a - b),
        drawn: handed.filter((n) => l.drawn(n)),
        highest: Object.fromEntries(handed.map((n) => [n, l.highestOf(n)])),
        slots: l.slots?.chunks ?? null,
        stats: { ...l.stats },
        window: { col: groundWindow.col, row: groundWindow.row, fills: groundWindow.fills },
        lee: { a0: shelterTexture.a0, b0: shelterTexture.b0, fills: shelterTexture.fills },
        shore: shore.on.value,
        // Every chunk handed within 1.5 km of the boat had.
        ready: l.ready(
          driver.states.current[RECORDS.state.x] ?? 0,
          driver.states.current[RECORDS.state.y] ?? 0,
          catalog.world.look.keepGrids,
        ),
      };
    },
    /** The plants drawn: near and far, draws and triangles, the plants held; whether their models are loaded, and the wind they sway in. */
    flora() {
      const f = world.land?.flora;
      if (f === undefined) {
        return null;
      }
      const sample = [];
      for (const p of f.plants()) {
        if (sample.length >= 4) {
          break;
        }
        sample.push(Array.from(p.chunk.slice(p.at, p.at + 8)));
      }
      return { ...f.stats, loaded: f.loaded, speed: f.speed.value, sample };
    },
    /** The features drawn: their parts held, the falls, spouts, vents and birds, the spray's puffs and the steam's, and the draws. */
    features() {
      const f = world.land?.features;
      if (f === undefined) {
        return null;
      }
      return { ...f.stats, steam: f.steam.count };
    },
    /**
     * The sea's life held, the birds of it drawn last frame and the towns'
     * gulls; and every bird in the birds' one draw, colonies' too, with its
     * draws (0 or 1).
     */
    life(): {
      records: LifeSeen[];
      birds: number;
      gulls: number;
      drawn: number;
      draws: number;
      towns: GullTown[];
      swimmers: number;
      swimDraws: number;
      swimLoaded: boolean;
      swimTriangles: number;
      tinted: boolean;
      splashes: number;
      boils: number;
    } {
      const s = world.lifeDraw.stats;
      const w = world.swimmers.stats;
      return {
        towns: world.lifeDraw.towns.map((t) => ({ ...t })),
        records: [...world.life.values()],
        birds: s.birds,
        gulls: s.gulls,
        drawn: world.birds.stats.birds,
        draws: world.birds.stats.draws,
        swimmers: w.swimmers,
        swimDraws: w.draws,
        swimLoaded: w.loaded,
        swimTriangles: w.triangles,
        tinted: world.swimmers.tinted,
        splashes: world.lifeDraw.splashCount,
        boils: world.lifeDraw.boilCount,
      };
    },
    /**
     * The birds of the sea's life within reach of the camera at a tick, now
     * by default, each one's group, number and place, found as the frame
     * finds them: two pages compared at one tick see the same birds.
     */
    lifeBirds(tick?: number): LifeBird[] {
      const f = world.lifeFrame(stage.camera.position, false);
      return world.lifeDraw.birdsAt(world.life, f, tick ?? world.ticks);
    },
    /** The boat a group of the sea's life is with, as this page draws it now; null for none or one not drawn. */
    lifeWith(id: string): { east: number; north: number; heading: number } | null {
      const e = world.life.get(id);
      if (e === undefined) {
        return null;
      }
      const p = world.lifeDraw.pose(e, world.lifeFrame(stage.camera.position, false));
      return p === null || p === undefined
        ? null
        : { east: p.east, north: p.north, heading: p.heading };
    },
    /**
     * The animals of the sea's life in the water within reach of the camera
     * at a tick, now by default, each one's group, number and place, up from
     * the water's surface: two pages compared at one tick see the same.
     */
    lifeSwimmers(tick?: number): LifeBird[] {
      const f = world.lifeFrame(stage.camera.position, false);
      return world.lifeDraw.swimmersAt(world.life, f, tick ?? world.ticks);
    },
    /**
     * Raises a group of a kind, by its id, by the boat now: its middle
     * east and north of the boat by so many m (200 m ahead by default)
     * at once, as ?life raises one 40 s after the load; free, a kind that
     * follows or rides boats passes by as if there were none. Its record,
     * or null for a kind not in the catalog.
     */
    raiseLife(kindId: string, eastOff?: number, northOff?: number, free = false): LifeSeen | null {
      const kind = catalog.life.kinds.findIndex((k) => k.id === kindId);
      const offset =
        eastOff === undefined && northOff === undefined
          ? undefined
          : { east: eastOff ?? 0, north: northOff ?? 0 };
      const e = lifeScene(
        catalog.life,
        kind,
        world.ticks,
        world.pose,
        ++lifeRaised,
        0,
        offset,
        free,
      );
      if (e !== null) {
        raiseScene(world, e, catalog.life);
      }
      return e;
    },
    /** Lands a fish of the catalog's that come aboard lit boats on the own boat's deck, now. */
    raiseAboard(): LifeSeen | null {
      const e = aboardScene(catalog.life, world.ticks, ++lifeRaised, 0);
      if (e !== null) {
        world.life.set([e], []);
      }
      return e;
    },
    /** The glow of the water drawn about the camera now: its colour and strength; the blows, footprints and trails of the last frame. */
    lifeGlow() {
      const d = world.lifeDraw;
      return {
        ...d.glow,
        blows: d.blowCount,
        prints: d.printCount,
        trails: d.trailCount,
        heard: d.heardCount,
      };
    },
    /** The towns drawn: their buildings near and far, props, draws and triangles; the buildings held. */
    towns() {
      const t = world.land?.towns;
      if (t === undefined) {
        return null;
      }
      const f = t.features();
      return {
        ...t.stats,
        held: [...t.buildings()].length,
        flags: world.flags.count,
        puffs: world.smoke.count,
        chimneys: f.chimneys.length,
        lanterns: f.lanterns.length,
        lanternsLit: world.lanterns.count,
        // The first puffs' places, as the smoke drew them last.
        puff: Array.from((world.smoke.place.array as Float32Array).slice(0, 12)),
      };
    },
    /**
     * Each tile's ground as the tile pass wrote it for the last frame: the
     * water's depth, the waves' cap f, whether it is land; beside the
     * module's f at the tile's centre, by the ground it holds.
     */
    async tileGround(): Promise<{
      depth: number[];
      gpu: number[];
      land: number[];
      module: number[];
      count: number;
    }> {
      const ocean = world.ocean;
      const count = ocean.field.count;
      const all = await readTarget(
        gfx().renderer,
        ocean.pass.target,
        PASS_WIDTH,
        ocean.pass.target.height,
        webgl(),
      );
      const centre = ocean.tiles.centre.value;
      const o = world.origin.world;
      const depth: number[] = [];
      const gpu: number[] = [];
      const land: number[] = [];
      const points: number[] = [];
      for (let i = 0; i < count; i++) {
        const t = (GROUND_ROW * PASS_WIDTH + i) * 4;
        depth.push(all[t] ?? Number.NaN);
        gpu.push(all[t + 1] ?? Number.NaN);
        land.push(all[t + 2] ?? Number.NaN);
        // The tile's centre in the world, as float32 holds it on the GPU.
        points.push(
          o.x + Math.fround(centre.x + (ocean.field.offset[i * 2] ?? 0)),
          o.y - Math.fround(centre.y - (ocean.field.offset[i * 2 + 1] ?? 0)),
        );
      }
      const physics = driver.physics;
      const module = new Float64Array(count).fill(Number.NaN);
      if (physics !== undefined && ocean.slot >= 0) {
        physics.seaDrawAt(world.ticks);
        physics.seaFactor(ocean.slot, points, module);
      }
      return { depth, gpu, land, module: Array.from(module), count };
    },

    /**
     * The free camera: F's toggle (fly), or put flying at a point looking
     * a way (bearing and pitch in degrees), or back on the boat (land);
     * and its state, the scene's focus, the dome's centre, the tile
     * field's centre, whether the screen is hidden and whether it is
     * offered.
     */
    fly(at?: {
      east: number;
      north: number;
      height: number;
      bearing?: number;
      pitch?: number;
    }): void {
      game.fly();
      const c = world.freeCam;
      if (at !== undefined && c.on) {
        c.enter(
          at.east,
          at.north,
          at.height,
          ((at.bearing ?? 0) * Math.PI) / 180,
          ((at.pitch ?? -20) * Math.PI) / 180,
        );
      }
    },
    flyKey(code: string, down: boolean): void {
      document.dispatchEvent(
        new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }),
      );
    },
    landCamera(): void {
      game.land();
    },
    /** Sends a Roam whatever the flag, as a modified client could. */
    roamAnyway(east: number, north: number, height: number): void {
      sailing.online?.roam(true, east, north, height);
    },
    freeCam() {
      const c = world.freeCam;
      const o = world.origin.world;
      const field = hexCentre(world.origin.centre.q, world.origin.centre.r, { x: 0, y: 0 });
      return {
        on: c.on,
        can: game.canFly(),
        flying: game.flying.value,
        east: c.east,
        north: c.north,
        height: c.height,
        focus: { ...world.focus },
        dome: { east: domeCentre.value.x + o.x, north: -domeCentre.value.y + o.y },
        tiles: { east: field.x, north: field.y },
        hud: document.querySelector('.hud .case') !== null,
        back: document.querySelector('.fly-back.shown') !== null,
        stays: (driver as { stays?: boolean }).stays ?? false,
      };
    },

    /**
     * The chase camera's arm: where its eye and the point it looks at are in
     * the world (m east, north and up), how far along its line the arm
     * holds it (∞ while the line is clear to the view) and the elevation it
     * has lifted it to (−∞ for none); and the player's view.
     */
    arm() {
      const c = stage.camera.position;
      const o = world.origin.world;
      const cam = world.camera;
      // The look point: the camera's look height above the boat and its followed heave.
      const bs = world.boatScene;
      const look = {
        east: bs.x + o.x,
        north: -bs.z + o.y,
        up: bs.y + cam.lift + world.camera.lookHeight,
      };
      return {
        eye: { east: c.x + o.x, north: -c.z + o.y, up: c.y },
        look,
        reach: cam.armReach,
        rise: cam.armRise,
        view: { ...cam.view },
      };
    },

    /** Whether the cameras keep out of the land's solids: off, they stand as their views put them. */
    cameraSolids(on: boolean): void {
      const solids = on ? (world.land?.solids ?? null) : null;
      world.camera.solids = solids;
      world.freeCam.solids = solids;
    },

    /**
     * The land's solids as the grids hold them within reach of (east,
     * north), for a test's own lookup: each hexagon of land's centre and
     * elevation (decimetres), each roof's centre, underside and top, each
     * building's middle, heading, frontage, depth, level and top, each
     * lighthouse tower's site; and the terrace.
     */
    solidsNear(east: number, north: number, reach: number) {
      const hexes: number[] = [];
      const roofs: number[] = [];
      const buildings: number[] = [];
      const towers: number[] = [];
      for (const [n, g] of world.land?.grids ?? []) {
        const [c0, j0] = chunkCorner(n);
        const e = g.elevation;
        if (e !== null) {
          for (let i = 0; i < e.length; i++) {
            if ((e[i] ?? 0) <= 0) {
              continue;
            }
            const [q, r] = cellHex(
              c0 + Math.floor(i / GROUND.chunkRows),
              j0 + (i % GROUND.chunkRows),
            );
            const [he, hn] = landHexCentre(q, r);
            if (Math.hypot(he - east, hn - north) <= reach) {
              hexes.push(he, hn, e[i] ?? 0);
            }
          }
        }
        for (const f of g.features?.roofs ?? []) {
          const [q, r] = cellHex(f.column, f.row);
          const [he, hn] = landHexCentre(q, r);
          if (Math.hypot(he - east, hn - north) <= reach) {
            roofs.push(he, hn, f.under, f.top);
          }
        }
        for (const b of g.town?.buildings ?? []) {
          if (Math.hypot(b.east - east, b.north - north) <= reach) {
            buildings.push(b.east, b.north, b.heading, b.frontage, b.depth, b.level, b.top);
          }
        }
      }
      for (const p of world.lighthouses.sites.values()) {
        if (p.tower > 0 && Math.hypot(p.east - east, p.north - north) <= reach) {
          towers.push(p.east, p.north, p.ground, p.tower);
        }
      }
      return { hexes, roofs, buildings, towers, terrace: catalog.world.look.terrace };
    },

    /** Where the camera's eye is: m east and north in the world, and m above the sea. */
    eye(): { east: number; north: number; height: number } {
      const c = stage.camera.position;
      const o = world.origin.world;
      return { east: c.x + o.x, north: -c.z + o.y, height: c.y };
    },

    /**
     * The highest land held, as drawn, and where: m east and north, m high;
     * or the highest within reach of (east, north), if given.
     */
    landSummit(
      within: { east: number; north: number; reach: number } | null = null,
    ): { east: number; north: number; height: number } | null {
      const l = world.land;
      if (l === null) {
        return null;
      }
      let best: { east: number; north: number; height: number } | null = null;
      for (const [n, g] of l.grids) {
        const e = g.elevation;
        if (e === null) {
          continue;
        }
        const [c0, j0] = chunkCorner(n);
        for (let i = 0; i < e.length; i++) {
          const h = drawnHeight(e[i] ?? 0, catalog.world.look.terrace);
          if ((e[i] ?? 0) > 0 && (best === null || h > best.height)) {
            const [q, r] = cellHex(c0 + Math.floor(i / 264), j0 + (i % 264));
            const [east, north] = landHexCentre(q, r);
            if (
              within === null ||
              Math.hypot(east - within.east, north - within.north) <= within.reach
            ) {
              best = { east, north, height: h };
            }
          }
        }
      }
      return best;
    },

    /** The boat and the ground: the line the sailor's panel shows, the bump's line, how it last met the ground, how often, and the pushes off. */
    aground() {
      return {
        sailor: game.hud.sailor.value,
        line: game.hud.bump.value,
        sound: game.lastGround,
        groundings: game.groundings,
        pushes: driver.pushes ?? 0,
        out: driver.out[RECORDS.out.aground] ?? 0,
      };
    },

    /**
     * Draws the land higher than above, in metres, within reach of (east,
     * north), in one flat colour, magenta, unlit and unhazed, and the rest
     * as it looks; or, with null, all of it as it looks (the pictures that
     * find land).
     */
    landFlat(
      above: number | null,
      near: { east: number; north: number; reach: number } | null = null,
    ): void {
      const m = world.land?.material;
      if (m === undefined) {
        return;
      }
      if (above === null) {
        m.outputNode = null;
        world.onFrame = null;
      } else {
        // Where the place is in the scene, kept up with the floating origin.
        const at = uniform(new Vector2(0, 0));
        const reach = near?.reach ?? 1e9;
        world.onFrame = () => {
          const o = world.origin.world;
          at.value.set((near?.east ?? 0) - o.x, -((near?.north ?? 0) - o.y));
        };
        world.onFrame();
        const inside = positionWorld.xz.sub(at).length().lessThan(reach);
        m.outputNode = select(
          positionGeometry.y.greaterThan(above).and(inside),
          vec4(1, 0, 1, 1),
          output,
        );
      }
      m.needsUpdate = true;
    },

    /** Takes the boat back from another device. */
    takeOver(): void {
      sailing.online?.takeOver();
    },

    /**
     * Draws boats in the fleet as given, from now on; null stops. Fields
     * left out are 0, but opacity 1 (the sandbox's pictures).
     */
    setFleet(boats: Partial<DrawnBoat>[] | null): void {
      if (boats === null) {
        world.fleetSource = null;
        return;
      }
      const drawn = boats.map((b, i) => ({ ...newDrawnBoat(), slot: i, opacity: 1, ...b }));
      // Each lies on the sea drawn, unless told how it lies.
      const physics = driver.physics;
      const slot = world.ocean.source?.seas.slotAt(Math.floor(world.ticks) + 1) ?? -1;
      if (physics !== undefined && slot >= 0) {
        physics.seaDrawAt(game.clock.steps + game.clock.alpha);
        drawn.forEach((d, i) => {
          // Each on the sea under its own kind's waterline.
          const hull = (catalog.boats[d.kind] ?? world.kind).physics.hull;
          const w = physics.waveUnder(
            slot,
            d.east,
            d.north,
            d.heading,
            hull.waterlineLength,
            hull.waterlineBeam,
          );
          d.heave = boats[i]?.heave ?? w[RECORDS.wave.height] ?? 0;
          d.pitch = boats[i]?.pitch ?? w[RECORDS.wave.ahead] ?? 0;
        });
      }
      // A boat of two hulls heeled about her lee hull, as float.ts has it.
      for (const d of drawn) {
        d.heave += hullLift(
          (catalog.boats[d.kind] ?? world.kind).physics.hulls.hullSpacing,
          d.heel,
        );
      }
      world.fleetSource = { drawn, count: drawn.length };
      // Boats put somewhere at once: their sailors met afresh.
      world.fleet.forgetSailors();
    },

    /** Changes a boat of the fleet setFleet gave, where it is: its sailors and crew go on as they were. */
    moveFleet(i: number, b: Partial<DrawnBoat>): void {
      const d = world.fleetSource?.drawn[i];
      if (d !== undefined) {
        Object.assign(d, b);
      }
    },

    /**
     * Resolves once every kind and every look a boat of the fleet has been
     * drawn with has loaded (or failed).
     */
    async fleetLoaded(): Promise<void> {
      const busy = () =>
        world.fleet.loading ||
        (world.fleet.looks?.looks.some(
          (l) =>
            l.state === 'loading' ||
            l.clipsState === 'loading' ||
            l.wheelState === 'loading' ||
            l.trapezeState === 'loading' ||
            l.catState === 'loading' ||
            l.cruiserState === 'loading' ||
            l.bridgeState === 'loading',
        ) ??
          false);
      while (busy()) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },

    /**
     * Puts n people aboard the boat in view as the sandbox's ?crew does (the
     * second at the helm, or the seat holder holds the controls), or none
     * but its sailor for 0.
     */
    showCrew(n: number, holder?: number): Promise<void> {
      if (n <= 0) {
        return world.showCrew(null);
      }
      const crew = sandboxCrew(Math.min(n, world.kind.capacity), catalog);
      return world.showCrew(holder === undefined ? crew : { ...crew, holder });
    },

    /**
     * The people aboard drawn besides the one at the helm: how many, at
     * which level, their figures' triangles, whether all are drawn in their
     * own looks, the helm's look, and where each one's head is on screen
     * (CSS pixels, with the dome's drop).
     */
    /** Aboard a ship: everyone walks at once to the next one's place (showCrew sends them back). */
    shipShuffle(): void {
      const rules = world.crew.rules;
      if (rules instanceof ShipRules) {
        rules.shuffle();
      }
    },
    crew(): {
      aboard: number;
      ready: boolean;
      near: number;
      far: number;
      nearTriangles: number;
      farTriangles: number;
      helm: string | null;
      /** The side deck the helm sits on, + starboard, − port, or crosses from. */
      helmSide: number;
      /** The crew's windward side (away from the boom), + starboard; whether its last change was a tack; how often it has changed. */
      side: number;
      tack: boolean;
      changes: number;
      /** Whether the helm is away from the tiller, walking to or from it as the controls change hands, and drawn. */
      helmAway: boolean;
      helmShown: boolean;
      /** Aboard a beach cat: where the helm crossing her net is across it (null if not), and whether the crew crossing holds them. */
      helmNet: number | null;
      helmHeld: boolean;
      /** Aboard a beach cat: each side's crew's wire drawn to whoever hangs on it (starboard, port). */
      crewWires: [boolean, boolean];
      /** At a cruising yacht's wheels: the wheel the helm stands at (+ starboard), how far sat by it (0 to 1), and whether walking between them. */
      helmWheel: number;
      helmSeat: number;
      helmWalking: boolean;
      /** Everyone under the crew's rules: seat, station (-1 the helm), side, how far they lean, and what they are doing (seconds into it, from which station). */
      members: {
        seat: number;
        station: number;
        side: number;
        lean: number;
        moving: string | null;
        from: number;
        t: number;
        /** After a capsize: in the water, righting her or climbing back, and whether thrown off over her bows; null aboard. */
        wet: string | null;
        thrown: boolean;
        /** Across a beach cat's net: where across it, and how far on hands and knees; null if not. */
        net: number | null;
        crawl: number;
        /** Aboard a ship: whether gone (on a ladder or aloft), seconds waited on a walk, and whether sat (1) or stood (0) at a hatch. */
        gone?: boolean;
        waited?: number;
        sat?: number;
        /** Aboard a ship, their work: hauling ('haul') or aloft ('aloft'), going to it, at it or back; the brace's index and side, how hard they haul; the yard's index. */
        work?: {
          kind: string;
          phase: string;
          brace: number;
          side: number;
          pull: number;
          yard: number;
        } | null;
      }[];
      /** Aboard a ship: whose seat is drawn at the wheel, and whether those on a hatch stand for the weather. */
      wheel: number | null;
      standing: boolean;
      /** Aboard a ship: the hands at the braces (which group's, which side's, coiling down), the band of yards her topmen are aloft for (0 none), and her braces' lines drawn. */
      gang: { group: string; side: number; coil: number } | null;
      aloftBand: number;
      braces: number;
      heads: {
        x: number;
        y: number;
        near: boolean;
        station: number;
        across: number;
        moving: boolean;
        /** The seat, and the clip last posed in (the first of two blended). */
        seat: number;
        clip: string | null;
        /** Where the head is in the boat's model. */
        model: [number, number, number];
      }[];
    } {
      const c = world.crew;
      const canvas = stage.gfx?.canvas;
      const bs = world.boatScene;
      const rules = c.rules;
      const sailor = world.boat?.sailor ?? null;
      return {
        aboard: c.count,
        ready: c.ready,
        ...c.drawn,
        helm: world.boat?.drawnLook()?.model ?? null,
        helmSide: sailor?.runtime.crossFrom ?? 0,
        side: rules?.side.side ?? 0,
        tack: rules?.side.tack ?? true,
        changes: rules?.side.changes ?? 0,
        helmAway: c.helmAway,
        helmShown: sailor?.shown === true && !sailor.away,
        helmNet: sailor?.runtime.netAt ?? null,
        helmHeld: c.helmHeld,
        crewWires: c.wiresDrawn,
        helmWheel: sailor?.runtime.windward ?? 0,
        helmSeat: sailor?.runtime.seat ?? 0,
        helmWalking: sailor?.runtime.walking ?? false,
        members: (rules?.members ?? []).map((m) => {
          const ship = 'ship' in m ? (m as ShipMember).ship : null;
          return {
            seat: m.seat,
            station: m.station,
            side: m.side,
            lean: m.lean,
            moving: m.moving?.kind ?? null,
            from: m.moving?.from.station ?? m.station,
            t: m.moving?.t ?? 0,
            wet: m.wet?.phase ?? null,
            thrown: m.wet?.thrown ?? false,
            net: m.moving?.net?.x ?? null,
            crawl: m.moving?.net?.crawl ?? 0,
            ...(ship === null
              ? {}
              : {
                  gone: ship.gone,
                  waited: ship.waited,
                  sat: ship.sat,
                  work:
                    ship.work === null
                      ? null
                      : {
                          kind: ship.work.kind,
                          phase: ship.work.phase,
                          brace: ship.work.haul?.brace ?? -1,
                          side: ship.work.haul?.side ?? 0,
                          pull: ship.work.pull,
                          yard: ship.work.yard?.yard ?? -1,
                        },
                }),
          };
        }),
        wheel: c.wheelSeat,
        standing: rules instanceof ShipRules ? rules.standing : false,
        gang: rules instanceof ShipRules && rules.gang !== null ? { ...rules.gang } : null,
        aloftBand: rules instanceof ShipRules ? rules.aloftBand : 0,
        braces:
          c.braces?.mesh.geometry.drawRange.count === undefined
            ? 0
            : c.braces.mesh.geometry.drawRange.count / 2,
        heads: c.heads().map((h) => {
          const p = h.at;
          p.y -= domeDrop(Math.hypot(p.x - bs.x, p.z - bs.z));
          p.project(stage.camera);
          return {
            x: ((p.x + 1) / 2) * (canvas?.clientWidth ?? 0),
            y: ((1 - p.y) / 2) * (canvas?.clientHeight ?? 0),
            near: h.near,
            station: h.station,
            across: h.across,
            moving: h.moving,
            seat: h.seat,
            clip: h.clip,
            model: h.model,
          };
        }),
      };
    },

    /**
     * Draws n frames one after another, each waited for on the GPU before
     * the next (no animation frames between), and returns the milliseconds
     * a frame took: its main thread's work and its GPU's, end to end.
     */
    async frameCost(n: number): Promise<number> {
      const backend = stage.gfx?.renderer.backend as
        | { device?: GPUDevice; gl?: WebGL2RenderingContext }
        | undefined;
      const pixel = new Uint8Array(4);
      const done = async (): Promise<void> => {
        if (backend?.device !== undefined) {
          await backend.device.queue.onSubmittedWorkDone();
        } else if (backend?.gl !== undefined) {
          // Reading a pixel back waits for everything drawn before it.
          const gl = backend.gl;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        }
      };
      stage.renderOnce(performance.now());
      await done();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        stage.renderOnce(performance.now());
        await done();
      }
      return (performance.now() - t0) / n;
    },

    /** Resolves once everyone aboard is drawn in their own look, the helm's too, drawing frames meanwhile. */
    /**
     * A crew for a boat of the fleet (setFleet's crew), as the sandbox makes
     * one: n aboard in looks drawn from seed, the seat holder holding the
     * controls; and the look its helm is drawn in.
     */
    fleetCrew(
      n: number,
      holder = 0,
      seed = 1,
    ): { crew: { people: { seat: number; look: number }[]; holder: number }; look: number } {
      const crew = sandboxCrew(n, catalog, 0x5eed + seed);
      const people = crew.people.map((p) => ({ seat: p.seat, look: p.look }));
      return { crew: { people, holder }, look: people[holder]?.look ?? -1 };
    },

    /**
     * The other boats' crews: each crewed boat in view by its view slot,
     * whether its crew is drawn and at which level, its helm away, its
     * crew's side, everyone under the rules, and where each head drawn is
     * on screen (CSS pixels, with the dome's drop); how many are drawn at
     * each level, and the posing's cost since last asked.
     */
    fleetCrews(): {
      boats: {
        slot: number;
        drawn: boolean;
        near: boolean;
        helmAway: boolean;
        side: number;
        tack: boolean;
        members: {
          seat: number;
          station: number;
          side: number;
          moving: string | null;
          from: number;
          t: number;
          work: { kind: string; phase: string } | null;
          lean: number;
          wet: string | null;
        }[];
        heads: { x: number; y: number; up: number }[];
        hooked: number;
      }[];
      drawn: { near: number; far: number };
      stats: { frames: number; posed: number; ms: number };
    } {
      const canvas = stage.gfx?.canvas;
      const bs = world.boatScene;
      const c = world.crews;
      const stats = c.stats;
      c.stats = { frames: 0, posed: 0, ms: 0 };
      return {
        boats: c.boats().map((b) => ({
          ...b,
          heads: b.heads.map((p) => {
            const up = p.y;
            p.y -= domeDrop(Math.hypot(p.x - bs.x, p.z - bs.z));
            p.project(stage.camera);
            return {
              x: ((p.x + 1) / 2) * (canvas?.clientWidth ?? 0),
              y: ((1 - p.y) / 2) * (canvas?.clientHeight ?? 0),
              /** How high over the sea, m. */
              up,
            };
          }),
        })),
        drawn: c.drawn,
        stats,
      };
    },

    /** Resolves once every crew of the fleet drawn is drawn in its own looks. */
    async fleetCrewsReady(): Promise<void> {
      for (;;) {
        stage.renderOnce(performance.now());
        if (world.crews.ready && !world.fleet.loading) {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },

    /** The most people drawn on other boats; null for the game's own cap. */
    fleetCrewMost(most: number | null): void {
      world.crews.most = most ?? CREW_MOST;
    },

    async crewReady(): Promise<void> {
      const c = world.crew;
      for (;;) {
        stage.renderOnce(performance.now());
        if (c.ready && world.helmDrawn) {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },

    /** Seats the sailor in view afresh at the boat's pose, as the fleet meets a boat's. */
    settleSailor(): void {
      world.boat?.sailor?.runtime.reset();
      world.boat?.settle();
    },

    /**
     * Looks straight down on a hull, the player's own or the other boat
     * numbered `other` among those drawn, at the sea as it is drawn about
     * it, and counts: sea drawn inside the hull; holes in the sea outside
     * it; the sea drawn within 5 cm outside its waterline; and the pixels
     * the hull's volume leaves out. The last frame drawn placed the hulls.
     */
    async hull(
      other = -1,
      size = 256,
      span = 8,
    ): Promise<{ inside: number; holes: number; beside: number; left: number; sea: number }> {
      const shape = world.boat?.hullShape;
      if (shape === null || shape === undefined) {
        throw new Error('the hull has no volume');
      }
      const cog = world.kind.physics.hull.centreOfGravity;
      const o = world.origin.world;
      const b = other >= 0 ? world.fleetSource?.drawn[other] : undefined;
      const at =
        b !== undefined
          ? { x: b.east - o.x, y: b.heave, z: -(b.north - o.y), ...b }
          : { x: world.boatScene.x, y: world.pose.heave, z: world.boatScene.z, ...world.pose };
      const px = await probe(at.x, at.z, size, span, true);
      // Where no sea is drawn, the sea that was left out: its tile's plane.
      const field = world.ocean.field;
      const planes = referencePlanes();
      const tiles = new Map<string, number>();
      for (let i = 0; i < field.count; i++) {
        tiles.set(`${field.hex[i * 2]},${field.hex[i * 2 + 1]}`, i);
      }
      const hex = { q: 0, r: 0 };
      const dome = world.boatScene;
      const level = (x: number, y: number, z: number): number =>
        y + domeDrop(Math.hypot(x - dome.x, z - dome.z));
      // Whether a point of the scene, on a flat world, is in the hull widened to fill.
      const within = (x: number, y: number, z: number, fill: number): boolean => {
        const m = toHullFrame(
          { x: x - at.x, y: y - (at.y + cog), z: z - at.z },
          at.heading,
          at.pitch,
          at.heel,
        );
        return insideHull(shape, m.x, m.y + cog, m.z, fill);
      };
      const widest = Math.max(...shape.stations.map((s) => s[1] ?? 0));
      const pixel = span / size;
      const count = { inside: 0, holes: 0, beside: 0, left: 0, sea: 0 };
      for (let p = 0; p < size * size; p++) {
        if (Math.round(px[p * 4 + 3] ?? 0) > 0) {
          count.sea++;
          const x = px[p * 4] ?? 0;
          const z = px[p * 4 + 2] ?? 0;
          const y = level(x, px[p * 4 + 1] ?? 0, z);
          // A hair inside the volume's edge: float32 puts a fragment on it either way.
          if (within(x, y, z, HULL_FILL - 0.01)) {
            count.inside++;
          }
          if (within(x, y, z, 1 + 0.05 / widest) && !within(x, y, z, 1)) {
            count.beside++;
          }
          continue;
        }
        count.left++;
        // The pixel's centre in the scene: x east, z south, rows from the north.
        const x = at.x - span / 2 + ((p % size) + 0.5) * pixel;
        const z = at.z - span / 2 + (Math.floor(p / size) + 0.5) * pixel;
        hexAt(x + o.x, -z + o.y, hex);
        const tile = tiles.get(`${hex.q - world.origin.centre.q},${hex.r - world.origin.centre.r}`);
        if (tile === undefined) {
          count.holes++;
          continue;
        }
        const [cx, cz] = tileCentre(tile);
        // Within a pixel or two of its tile's edge the fragment left out may
        // have been the next tile's, a step higher or lower: not judged.
        const ex = Math.abs(x - cx);
        const ez = Math.abs(z - cz);
        if (Math.max(ez, ex * (Math.sqrt(3) / 2) + ez / 2) > TILE_APOTHEM - 2 * pixel) {
          continue;
        }
        const bent =
          (planes[tile * 4] ?? 0) +
          (planes[tile * 4 + 1] ?? 0) * (x - cx) +
          (planes[tile * 4 + 2] ?? 0) * (z - cz);
        // In the hull, give or take a centimetre at its ends and its bottom,
        // where float32 puts a fragment on the volume's edge either way.
        const y = level(x, bent, z);
        const fill = HULL_FILL + 0.03;
        if (
          !within(x, y, z, fill) &&
          !within(x, y + 0.015, z, fill) &&
          !within(x + 0.015, y, z + 0.015, fill) &&
          !within(x - 0.015, y, z - 0.015, fill) &&
          !within(x + 0.015, y, z - 0.015, fill) &&
          !within(x - 0.015, y, z + 0.015, fill)
        ) {
          count.holes++;
        }
      }
      return count;
    },
    /** Hides or shows the own boat's telltales and pennant, which the fleet does not draw. */
    hideSmallParts(on: boolean): void {
      for (const name of ['telltales', 'pennant']) {
        const part = world.boat?.parts.get(name);
        if (part !== undefined) {
          part.visible = !on;
        }
      }
    },
    /** Fleet materials that would sort or fade otherwise than dithered: none, if all is well. */
    fleetMaterials(): string[] {
      const problems: string[] = [];
      for (const level of world.fleet.levels()) {
        for (const m of level.meshes) {
          const material = m.material as { name: string; alphaHash: boolean; transparent: boolean };
          if (!material.alphaHash || material.transparent) {
            problems.push(`${material.name}: not dithered, or transparent`);
          }
        }
      }
      return problems;
    },
    /** Shows or hides the player's own boat. */
    showOwnBoat(on: boolean): void {
      if (world.boat !== null) {
        world.boat.root.visible = on;
      }
    },
    /** The fleet's draw calls and triangles as last drawn, and its boats by level. */
    fleetBudget() {
      return {
        ...world.fleet.budget(),
        ...world.fleet.counts(),
        ...world.fleet.figures(),
        sailorDraws: world.fleet.sailorDraws(),
      };
    },
    /**
     * The boat in view takes its own look, a boat look code (negative for
     * none told: the first paint and cloth, no number), and its name, as
     * the server tells them. The fleet's boats take theirs by setFleet's
     * boatLook and name.
     */
    setBoatLook(look: number, name = ''): void {
      world.setBoatLook(look, name);
    },
    /**
     * The boats' own looks as drawn: the own boat's, from its shaders'
     * uniforms, and each fleet boat's by kind, level and instance, from its
     * instance values: the paint's and cloth's places, the sail number and
     * the name's row (−1 for none); with the colours (sRGB) the palette
     * draws them in, and the names lettered and how often a row was.
     */
    boatLooksDrawn() {
      const palette = lookPalette(catalog);
      const hex = (list: number, i: number): string => {
        const v = palette.values[list * 16 + i];
        return v === undefined ? '' : `#${new Color(v.x, v.y, v.z).getHexString()}`;
      };
      const colours = (paint: number, cloth: number) => ({
        hull: hex(0, paint),
        grain: (palette.values[paint]?.w ?? 0) === 1,
        sail: hex(1, cloth),
        band: (palette.values[16 + cloth]?.w ?? 0) === 1 ? hex(2, cloth) : null,
        ink: hex(3, cloth),
      });
      const own = world.boat?.drawnBoatLook() ?? null;
      const fleet: {
        kind: number;
        level: string;
        paint: number;
        cloth: number;
        number: number;
        row: number;
        colours: ReturnType<typeof colours>;
      }[] = [];
      for (const v of world.fleet.views) {
        if (v?.loaded !== true) {
          continue;
        }
        for (const level of [v.near, v.far]) {
          const a = level.lean.array as Float32Array;
          for (let n = 0; n < level.count; n++) {
            const o = n * LEAN_STRIDE + 4;
            const paint = a[o] ?? 0;
            const cloth = a[o + 1] ?? 0;
            fleet.push({
              kind: v.index,
              level: level.name,
              paint,
              cloth,
              number: a[o + 2] ?? 0,
              row: a[o + 3] ?? -1,
              colours: colours(paint, cloth),
            });
          }
        }
      }
      const names = world.fleet.names;
      return {
        own: own === null ? null : { ...own, colours: colours(own.paint, own.cloth) },
        fleet,
        names: names === null ? null : { rows: [...names.rows.names], drawn: names.drawn },
      };
    },
    /**
     * The fleet's work since last asked: frames drawn, the milliseconds its
     * update took (the near sailors' runs included), and how many runs.
     */
    fleetWork() {
      return world.fleet.work();
    },
    /** The other boats as the page draws them online, with the fleet's numbers. */
    fleet() {
      const o = sailing.online;
      if (o === undefined) {
        throw new Error('the boat is sailed offline');
      }
      const f = o.fleet;
      return {
        stats: { ...f.stats },
        nearTick: f.near.tick,
        farTick: f.far.tick,
        boats: f.drawn.slice(0, f.count).map((b) => ({ ...b })),
      };
    },
    /**
     * Watches the other boats for ms of real time online: how many frames drew a
     * near boat held or carried on past its data, the largest step a boat
     * took between two frames, and the jumps: steps longer than half a
     * metre beyond what 6 m/s, more than a dinghy sails, covers in the
     * time the boat's render tick moved (a correction drawn at once rather
     * than eased; on a slow page the render tick itself may leap). Held frames come in
     * spells; a spell in which no snapshot came for over 900 ms is a
     * retransmission timeout's (the probe lost too: RFC 6298), longer than
     * any delay covers, and counted apart.
     */
    fleetWatch(ms: number): Promise<{
      frames: number;
      nearFrames: number;
      held: number;
      extrapolated: number;
      largestStep: number;
      jumps: number;
      nearDelay: number;
      farDelay: number;
      holds: { past: number; since: number; delay: number }[];
      timeoutHeld: number;
      spells: number[];
    }> {
      const o = sailing.online;
      if (o === undefined) {
        throw new Error('the boat is sailed offline');
      }
      const f = o.fleet;
      const last = new Map<number, { east: number; north: number; tick: number }>();
      const r = {
        frames: 0,
        nearFrames: 0,
        held: 0,
        extrapolated: 0,
        largestStep: 0,
        jumps: 0,
        nearDelay: 0,
        farDelay: 0,
        holds: [] as { past: number; since: number; delay: number }[],
        timeoutHeld: 0,
        spells: [] as number[],
      };
      // The spell of held frames running, and the longest wait for a
      // snapshot in it, ms.
      let spell = 0;
      let longest = 0;
      const end = performance.now() + ms;
      return new Promise((resolve) => {
        const prev = world.onFrame;
        world.onFrame = () => {
          prev?.();
          r.frames++;
          const done = performance.now() >= end;
          let near = false;
          let held = false;
          let carried = false;
          const seen = new Set<number>();
          for (let i = 0; i < f.count; i++) {
            const b = f.drawn[i] as DrawnBoat;
            if (b.slot < 0 || b.far > 0.5) {
              continue;
            }
            near = true;
            if (b.motion === 2 && r.holds.length < 40) {
              r.holds.push({
                past: b.tick - b.newest,
                since: (worldUs(o.clock, nowUs()) - f.arrived) / 1000,
                delay: f.stats.nearDelay,
              });
            }
            held ||= b.motion === 2;
            carried ||= b.motion === 1;
            seen.add(b.slot);
            const l = last.get(b.slot);
            if (l !== undefined) {
              const step = Math.hypot(b.east - l.east, b.north - l.north);
              r.largestStep = Math.max(r.largestStep, step);
              if (step > 0.5 + (6 * Math.abs(b.tick - l.tick)) / 30) {
                r.jumps++;
              }
            }
            last.set(b.slot, { east: b.east, north: b.north, tick: b.tick });
          }
          for (const slot of last.keys()) {
            if (!seen.has(slot)) {
              last.delete(slot);
            }
          }
          r.nearFrames += near ? 1 : 0;
          r.held += held ? 1 : 0;
          if (held) {
            spell++;
            longest = Math.max(longest, (worldUs(o.clock, nowUs()) - f.arrived) / 1000);
          }
          if (spell > 0 && (!held || done)) {
            if (longest > 900) {
              r.timeoutHeld += spell;
            }
            r.spells.push(spell);
            spell = 0;
            longest = 0;
          }
          r.extrapolated += carried ? 1 : 0;
          r.nearDelay = Math.max(r.nearDelay, f.stats.nearDelay);
          r.farDelay = Math.max(r.farDelay, f.stats.farDelay);
          if (done) {
            world.onFrame = prev;
            resolve(r);
          }
        };
      });
    },
    /** The player's own boat as the server had it at tick, from the last snapshots, or null. */
    ownAt(tick: number): { east: number; north: number; heading: number } | null {
      return sailing.online?.ownAt(tick) ?? null;
    },

    /** Shows or hides the spray. */
    showSpray(on: boolean): void {
      world.sprayView.mesh.visible = on;
      world.sprayHidden = !on;
    },
    /** Moves to a rung of the ladder; resolves once its look is drawn. */
    async setRung(index: number): Promise<void> {
      await world.setRung(index, 'test');
      world.ocean.detail.finishBake();
    },
    /** Adaptive quality on or off, and what it has done. */
    adapt(on: boolean): void {
      if (world.quality !== null) {
        world.quality.enabled = on;
      }
    },
    qualityLog(): string[] {
      return world.qualityLog();
    },
    /** The last window of frames adaptive quality judged. */
    lastWindow() {
      return world.lastWindow === null ? null : { ...world.lastWindow };
    },
    /** Adaptive quality's windows and its wait before a step up, ms; null for the scene's own. */
    qualityTiming(window: number | null, wait: number | null): void {
      world.windowMs = window;
      const q = world.quality;
      if (q !== null && wait !== null) {
        q.base = wait;
        q.wait = wait;
      }
    },
    /** Makes every drawn frame take at least ms of the main thread's time; 0 stops. */
    slowFrames(ms: number): void {
      const prev = world.onFrame as ((() => void) & { base?: (() => void) | null }) | null;
      // The frame's own callback, under any slowing put on it before.
      const base = prev !== null && 'base' in prev ? (prev.base ?? null) : prev;
      if (ms <= 0) {
        world.onFrame = base;
        return;
      }
      world.onFrame = Object.assign(
        () => {
          base?.();
          const until = performance.now() + ms;
          while (performance.now() < until) {
            // Busy, as a slow phone is.
          }
        },
        { base },
      );
    },
    /**
     * The bytes the GPU holds for the look's textures on the rung in use, as
     * three.js counts them once it has made them: the detail band's, the
     * foam map's, the wake's waves', the shadow map's (its depth and its colour target) and the
     * pattern's; and every texture's, the whole scene's.
     */
    textureBytes(): {
      detail: number;
      foamMap: number;
      wakeWaves: number;
      shadowMap: number;
      pattern: number;
      all: number;
    } {
      const info = gfx().renderer.info as unknown as {
        memoryMap: WeakMap<object, number>;
        memory: { texturesSize: number };
      };
      const size = (t: object | null | undefined): number =>
        t === null || t === undefined ? 0 : (info.memoryMap.get(t) ?? 0);
      const sum = (ts: (object | null | undefined)[]): number =>
        ts.reduce<number>((a, t) => a + size(t), 0);
      const ocean = world.ocean;
      const map = world.shadows.light.shadow.map;
      return {
        detail: sum(ocean.detail.textures),
        foamMap: sum(ocean.wakes.targets.map((t) => t.texture)),
        wakeWaves: sum(ocean.wakeWaves.textures),
        shadowMap: world.shadows.light.castShadow ? sum([map?.texture, map?.depthTexture]) : 0,
        pattern: size(ocean.pattern),
        all: info.memory.texturesSize,
      };
    },
    /** The tier's values in use. */
    tier() {
      return { ...TIERS[world.rung.tier], shadows: world.rung.shadows };
    },
    /** Draws the detail band, the foam, the wakes and a ship's braces, or not. */
    setParts(parts: { detail?: boolean; foam?: boolean; wakes?: boolean; braces?: boolean }): void {
      if (parts.braces !== undefined && world.crew.braces !== null) {
        // A ship's braces, which the fleet does not draw.
        world.crew.braces.mesh.visible = parts.braces;
      }
      if (parts.detail !== undefined) {
        detailOn.value = parts.detail ? 1 : 0;
      }
      if (parts.foam !== undefined) {
        foamOn.value = parts.foam ? 1 : 0;
      }
      if (parts.wakes !== undefined) {
        world.ocean.drawWakes = parts.wakes;
      }
    },
    /** How the detail band is made, and how the low tier's loops were. */
    detail() {
      return world.ocean.detail.state;
    },
    /**
     * In place of the foam under the boat: where the detail band folds, and
     * how long its foam lasts. Null for the sea's own.
     */
    setFold(fold: Partial<FoamLook> | null): void {
      const under = world.ocean.under.foam;
      world.ocean.detail.fold = fold === null ? null : { ...under, ...fold };
    },
    /**
     * Runs the detail band from clear water for a while up to the time
     * drawn, so that its foam is what it would be by then. For pictures of a
     * frozen time: the foam is the one thing the band remembers.
     */
    settleFoam(seconds = 8, rate = 4): void {
      const ocean = world.ocean;
      const f = ocean.frame;
      const end = f.time;
      ocean.detail.clearFoam();
      const steps = Math.round(seconds * rate);
      for (let i = steps; i >= 0; i--) {
        ocean.detail.update(gfx().renderer, { ...f, time: end - i / rate, dt: 1 / rate });
      }
    },
    /** Runs the foam map on for seconds of world time, in steps, with no boat stamping it. */
    runWakes(seconds: number, rate = 15): void {
      const ocean = world.ocean;
      const f = ocean.frame;
      for (let i = 0; i < Math.round(seconds * rate); i++) {
        ocean.wakes.begin();
        ocean.wakes.update(gfx().renderer, { ...f, dt: 1 / rate, currentEast: 0, currentNorth: 0 });
      }
    },
    /** Runs the detail band on for seconds of world time, in steps, from the time drawn. */
    runDetail(seconds: number, rate = 15): void {
      const ocean = world.ocean;
      const f = ocean.frame;
      const steps = Math.round(seconds * rate);
      for (let i = 1; i <= steps; i++) {
        ocean.detail.update(gfx().renderer, { ...f, time: f.time + i / rate, dt: 1 / rate });
      }
    },
    /**
     * A patch of the transform as the GPU last made it, beside the same
     * fields made on the CPU in float64 for the same sea and time: for each
     * texel, the slope east and north, the foam and the height (the GPU's),
     * and the slope east and north, the convergence and the height (the
     * CPU's).
     */
    async detailFields(which = 0): Promise<{
      size: number;
      gpu: number[];
      cpu: number[];
      /** The band's variance by the spectrum, m². */
      variance: number;
    }> {
      const patches = world.ocean.detail.patches;
      const c: Cascade | null | undefined = which === 0 ? patches?.first : patches?.second;
      if (c === null || c === undefined) {
        throw new Error('no such patch of the transform');
      }
      const n = c.patch.size;
      const m = new MeshBasicNodeMaterial();
      m.fragmentNode = textureLoad(c.out[c.current] as never, ivec2(floor(screenCoordinate)));
      const target = new RenderTarget(n, n, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, n, n, webgl());
      target.dispose();
      m.dispose();
      const maker = new FieldMaker(c.patch);
      maker.set(world.catalogSea, c.inputs);
      const f = maker.at(world.ocean.frame.time, newFields(n));
      const cpu = new Array<number>(n * n * 4);
      for (let i = 0; i < n * n; i++) {
        cpu[i * 4] = f.east[i] ?? 0;
        cpu[i * 4 + 1] = f.north[i] ?? 0;
        cpu[i * 4 + 2] = f.convergence[i] ?? 0;
        cpu[i * 4 + 3] = f.height[i] ?? 0;
      }
      return { size: n, gpu: Array.from(got), cpu, variance: c.inputs.variance };
    },
    /**
     * The tiles seen from straight above the boat, each pixel's numbers of
     * the look: its tile and whether it is a top (as tileMap), and what the
     * probes of the sea's material give (seamaterial.ts).
     */
    async surface(
      size = 256,
      span = 32,
      at: { east: number; north: number } | null = null,
    ): Promise<{
      tile: number[];
      detail: number[];
      foam: number[];
      crest: number[];
      wake: number[];
    }> {
      const o = world.origin.world;
      const bs = at === null ? world.boatScene : { x: at.east - o.x, y: 0, z: -(at.north - o.y) };
      const ids = await probe(bs.x, bs.z, size, span, true);
      const tile: number[] = [];
      for (let p = 0; p < size * size; p++) {
        const code = Math.round(ids[p * 4 + 3] ?? 0) - 1;
        tile.push(code < 0 || code % 2 === 1 ? -1 : code / 2);
      }
      return {
        tile,
        detail: Array.from(await probe(bs.x, bs.z, size, span, false, 'detail')),
        foam: Array.from(await probe(bs.x, bs.z, size, span, false, 'foam')),
        crest: Array.from(await probe(bs.x, bs.z, size, span, false, 'crest')),
        wake: Array.from(await probe(bs.x, bs.z, size, span, false, 'wake')),
      };
    },
    /**
     * The tiles about the boat seen from straight above, over a square of
     * span metres: for each pixel the gust on its tile as it shows, and the
     * water's brightness there with the gusts drawn and without them (0
     * where no tile's top is drawn).
     */
    async gustSurface(
      size = 192,
      span = 160,
    ): Promise<{ gust: number[]; shown: number[]; hidden: number[] }> {
      const bs = world.boatScene;
      const ids = await probe(bs.x, bs.z, size, span);
      const brightness = async (): Promise<number[]> => {
        const px = await probe(bs.x, bs.z, size, span, false, 'colour');
        const out: number[] = [];
        for (let p = 0; p < size * size; p++) {
          const code = Math.round(ids[p * 4 + 3] ?? 0) - 1;
          const top = code >= 0 && code % 2 === 0;
          out.push(
            top
              ? 0.2126 * (px[p * 4] ?? 0) +
                  0.7152 * (px[p * 4 + 1] ?? 0) +
                  0.0722 * (px[p * 4 + 2] ?? 0)
              : 0,
          );
        }
        return out;
      };
      const was = world.ocean.gusts.shown;
      world.ocean.gusts.shown = 1;
      hooks.render();
      const gust = Array.from(await probe(bs.x, bs.z, size, span, false, 'gust')).filter(
        (_, i) => i % 4 === 0,
      );
      const shown = await brightness();
      world.ocean.gusts.shown = 0;
      hooks.render();
      const hidden = await brightness();
      world.ocean.gusts.shown = was;
      hooks.render();
      return { gust, shown, hidden };
    },
    /** The far sea's detail at points of a ring beyond the tiles: the slope it adds along x and z, seen from above. */
    async farSurface(size = 128, span = 60, out = 220): Promise<number[]> {
      const g = gfx();
      const far = world.ocean.far;
      const m = seaMaterial('sea-far');
      m.positionNode = far.position;
      m.fragmentNode = farLook(far, world.ocean.parts, true);
      const scene = new Scene();
      const mesh = new Mesh(far.mesh.geometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
      const bs = world.boatScene;
      const cam = new OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 400);
      cam.position.set(bs.x + out, 200, bs.z);
      cam.up.set(0, 0, -1);
      cam.lookAt(bs.x + out, 0, bs.z);
      cam.updateMatrixWorld();
      const target = new RenderTarget(size, size, {
        type: FloatType,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        generateMipmaps: false,
      });
      const r = g.renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, cam);
      r.setRenderTarget(before);
      const px = await readTarget(r, target, size, size, g.backend === 'webgl2');
      target.dispose();
      m.dispose();
      return Array.from(px);
    },
    /**
     * The foam map: its side in texels, its centre in the world, the side of
     * a texel in metres, and its texels from the south-west, 0 to 255: the
     * white water (data) and the track's churn (churn).
     */
    async wakes(): Promise<{
      size: number;
      east: number;
      north: number;
      texel: number;
      data: number[];
      churn: number[];
    }> {
      const w = world.ocean.wakes;
      // Copied into a float target first: WebGL reads an 8-bit target back
      // only where the driver says it can.
      const n = w.size;
      const m = new MeshBasicNodeMaterial();
      const texel = textureLoad(w.texture as never, ivec2(floor(screenCoordinate)));
      m.fragmentNode = vec4(texel.x, texel.y, 0, 1);
      const target = new RenderTarget(n, n, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: false,
      });
      const r = gfx().renderer;
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      new QuadMesh(m).render(r);
      r.setRenderTarget(before);
      const got = await readTarget(r, target, n, n, webgl());
      target.dispose();
      m.dispose();
      // readTarget gives the copy's rows top first, which are the map's from the south.
      const data: number[] = new Array(n * n);
      const churn: number[] = new Array(n * n);
      for (let i = 0; i < n * n; i++) {
        data[i] = Math.round(255 * (got[i * 4] ?? 0));
        churn[i] = Math.round(255 * (got[i * 4 + 1] ?? 0));
      }
      return {
        size: w.size,
        east: w.centre.east,
        north: w.centre.north,
        texel: WAKE.span / w.size,
        data,
        churn,
      };
    },
    /**
     * The wake's waves as they were last made: the square's side in texels
     * and metres, its centre in the world, and for each texel from the
     * south-west the slope east and north, the convergence and the height,
     * as linear theory has them (without the look's gain).
     */
    async wakeWaves(): Promise<{
      kind: string;
      size: number;
      span: number;
      east: number;
      north: number;
      data: number[];
    }> {
      const ww = world.ocean.wakeWaves;
      const k = ww.kind;
      if (k === null) {
        throw new Error('no wake waves');
      }
      const n = k.size;
      const data: number[] = new Array(n * n * 4);
      const ref = ww.reference;
      if (ref !== null) {
        for (let i = 0; i < n * n; i++) {
          data[i * 4] = ref.east[i] ?? 0;
          data[i * 4 + 1] = ref.north[i] ?? 0;
          data[i * 4 + 2] = ref.convergence[i] ?? 0;
          data[i * 4 + 3] = ref.h[i] ?? 0;
        }
      } else {
        const t = ww.transformed;
        if (t === null) {
          throw new Error('no wake waves');
        }
        const m = new MeshBasicNodeMaterial();
        m.fragmentNode = textureLoad(t.out as never, ivec2(floor(screenCoordinate)));
        const target = new RenderTarget(n, n, {
          type: FloatType,
          format: RGBAFormat,
          depthBuffer: false,
        });
        const r = gfx().renderer;
        const before = r.getRenderTarget();
        r.setRenderTarget(target);
        new QuadMesh(m).render(r);
        r.setRenderTarget(before);
        const got = await readTarget(r, target, n, n, webgl());
        target.dispose();
        m.dispose();
        for (let i = 0; i < n * n * 4; i++) {
          data[i] = got[i] ?? 0;
        }
      }
      return {
        kind: k.kind,
        size: n,
        span: k.span,
        east: ww.centre.east,
        north: ww.centre.north,
        data,
      };
    },
    /**
     * The wake's waves run on the GPU beside the reference on the CPU, in
     * float64, from still water for so many steps of 1/30 s, a hull sailing
     * at 2 m/s across the square: the root mean square of each, and of
     * their difference, for the height and the slope east, away from the
     * hull (where the pressure's half floats would count); and the largest
     * difference of height. Null where the waves are the CPU's already.
     */
    async wakeWavesAgainstCPU(steps: number): Promise<{
      height: [number, number];
      slope: [number, number];
      worst: number;
    } | null> {
      const ww = world.ocean.wakeWaves;
      const k = ww.kind;
      if (k === null || k.kind !== 'fft' || world.boat?.hullShape === undefined) {
        return null;
      }
      const shape = world.boat.hullShape;
      if (shape === null) {
        return null;
      }
      const n = k.size;
      const ref = new WakeWavesReference(n, k.span, wakeDamping());
      const heading = 0.3;
      const speed = 2;
      hooks.runWakeWaves(steps / 30, [{ east: 0, north: 0, heading, speed }]);
      const texel = k.span / n;
      let east = 0;
      let north = 0;
      for (let i = 0; i <= steps; i++) {
        const dt = i === 0 ? 0 : 1 / 30;
        east += speed * Math.sin(heading) * dt;
        north += speed * Math.cos(heading) * dt;
        const back = WAKE_WAVES.astern * k.span;
        const ce = Math.round((east - Math.sin(heading) * back) / texel) * texel;
        const cn = Math.round((north - Math.cos(heading) * back) / texel) * texel;
        ref.press(shape, [{ east, north, heading, sink: 0 }], ce, cn);
        ref.step(dt, ce, cn);
      }
      const got = (await hooks.wakeWaves()).data;
      let hh = 0;
      let dh = 0;
      let ss = 0;
      let ds = 0;
      let worst = 0;
      let count = 0;
      for (let i = 0; i < n * n; i++) {
        const at = ref.at(i % n, Math.floor(i / n));
        const near = Math.hypot(at.east - east, at.north - north);
        if (near < 3) {
          continue;
        }
        const h = ref.h[i] ?? 0;
        const e = ref.east[i] ?? 0;
        hh += h * h;
        ss += e * e;
        dh += ((got[i * 4 + 3] ?? 0) - h) ** 2;
        ds += ((got[i * 4] ?? 0) - e) ** 2;
        worst = Math.max(worst, Math.abs((got[i * 4 + 3] ?? 0) - h));
        count++;
      }
      return {
        height: [Math.sqrt(hh / count), Math.sqrt(dh / count)],
        slope: [Math.sqrt(ss / count), Math.sqrt(ds / count)],
        worst,
      };
    },
    /**
     * Runs the foam map on alone for seconds of world time at rate steps a
     * second, with hulls of the boat's kind moving as given (east, north,
     * heading and speed through the water each, stamping until stopAt
     * seconds), in a current, the map following the first; the scene's own
     * hulls are let be. Returns where each ended.
     */
    runTrack(
      seconds: number,
      boats: { east: number; north: number; heading: number; speed: number; stopAt?: number }[],
      current: { east: number; north: number } = { east: 0, north: 0 },
      rate = 15,
    ): { east: number; north: number }[] {
      const ocean = world.ocean;
      const map = ocean.wakes;
      const o = world.origin.world;
      const at = boats.map((b) => ({ ...b }));
      const steps = Math.round(seconds * rate);
      for (let i = 1; i <= steps; i++) {
        const dt = 1 / rate;
        const t = i * dt;
        map.begin();
        for (const b of at) {
          // Through the water at its speed, and with the water over the ground.
          b.east += (b.speed * Math.sin(b.heading) + current.east) * dt;
          b.north += (b.speed * Math.cos(b.heading) + current.north) * dt;
          if (b.stopAt === undefined || t < b.stopAt) {
            map.add(b.east, b.north, b.heading, b.speed);
          }
        }
        const first = at[0] ?? { east: 0, north: 0 };
        map.update(gfx().renderer, {
          originEast: o.x,
          originNorth: o.y,
          boatEast: first.east,
          boatNorth: first.north,
          dt,
          currentEast: current.east,
          currentNorth: current.north,
        });
      }
      return at.map((b) => ({ east: b.east, north: b.north }));
    },
    /**
     * Starts one of the sandbox's wake scenes (?sandbox&wake=…) in a sea,
     * the boat steered from now on; null stops the one running.
     */
    wakeScene(name: WakeSceneName | null, sea = 'breeze'): void {
      stopWakeScene?.();
      stopWakeScene = null;
      if (name !== null) {
        stopWakeScene = startWakeScene(wakeSceneHost(game, offline(), world), name, sea);
      }
    },
    /**
     * Runs the wake's waves on alone for seconds of world time at rate steps
     * a second, from still water, with hulls of the boat's kind moving as
     * given (east, north, heading and speed through the water each), the
     * square following the first; the scene's own hulls are let be. Returns
     * where the first one ended.
     */
    runWakeWaves(
      seconds: number,
      boats: {
        east: number;
        north: number;
        heading: number;
        speed: number;
        turn?: number;
        turnFrom?: number;
        stopAt?: number;
      }[],
      rate = 30,
      current: { east: number; north: number } = { east: 0, north: 0 },
    ): { east: number; north: number; heading: number }[] {
      const ocean = world.ocean;
      const ww = ocean.wakeWaves;
      const o = world.origin.world;
      const at = boats.map((b) => ({ ...b }));
      ww.clear();
      const steps = Math.round(seconds * rate);
      for (let i = 0; i <= steps; i++) {
        const dt = i === 0 ? 0 : 1 / rate;
        ww.begin();
        for (const b of at) {
          if (i > 0) {
            const speed = b.stopAt !== undefined && i / rate > b.stopAt ? 0 : b.speed;
            const turning = speed > 0 && i / rate > (b.turnFrom ?? 0);
            b.heading += (turning ? (b.turn ?? 0) : 0) * dt;
            b.east += (speed * Math.sin(b.heading) + current.east) * dt;
            b.north += (speed * Math.cos(b.heading) + current.north) * dt;
          }
          ww.add(b.east, b.north, b.heading, 0);
        }
        const first = at[0] ?? { east: 0, north: 0, heading: 0 };
        ww.update(gfx().renderer, {
          originEast: o.x,
          originNorth: o.y,
          boatEast: first.east,
          boatNorth: first.north,
          heading: first.heading,
          dt,
          currentEast: current.east,
          currentNorth: current.north,
        });
      }
      return at.map((b) => ({ east: b.east, north: b.north, heading: b.heading }));
    },
    /**
     * Draws the sky at an hour of the day at the centre of the disk (0 to
     * 24, noon at 12) and, if given, a moon's age (0 new, 0.5 full), from
     * the world time drawn on; then a frame.
     */
    setSky(hour: number, moon: number | null = null): void {
      if (world.skyTime === null) {
        throw new Error('the sky does not follow the rule yet');
      }
      setSky(world.skyTime, { hour, moon }, world.ticks);
      hooks.render();
    },

    /**
     * Stages the world's end as it is seconds before it (negative: after),
     * or as nothing with null; or, with rising, the new world risen that
     * many seconds after its Welcome. Then a frame.
     */
    worldEnd(
      seconds: number | null,
      rising: number | null = null,
    ): {
      sound: number;
      mist: number;
      cut: number | null;
      veil: number;
      slabs: number;
    } {
      world.endIn = seconds === null ? null : () => seconds;
      if (rising !== null) {
        world.rise(rising);
      }
      hooks.render();
      const s = world.endStage;
      return {
        sound: s.sound,
        mist: s.mist,
        cut: Number.isFinite(s.cut) ? s.cut : null,
        veil: s.veil,
        slabs: world.endSlabs.count,
      };
    },

    /** The sky as last drawn: by the rule at the boat, and as the light's table reads it. */
    sky() {
      const r = world.skyRecord;
      const p = skyPeriods(catalog.sky);
      const deg = 180 / Math.PI;
      const v = world.sky.values;
      return {
        t: world.skyAt,
        hour: hourAt(world.skyAt, p),
        moonAge: moonAgeAt(world.skyAt, p),
        sun: {
          height: (r[SKY.sun + BODY.altitude] ?? 0) * deg,
          bearing: (r[SKY.sun + BODY.bearing] ?? 0) * deg,
        },
        moon: {
          height: (r[SKY.moon + BODY.altitude] ?? 0) * deg,
          bearing: (r[SKY.moon + BODY.bearing] ?? 0) * deg,
          lit: r[SKY.lit] ?? 0,
        },
        main: world.sky.main.body,
        mainStrength: world.sky.main.strength,
        starLimit: v.starLimit,
        lanterns: v.lanterns,
        starsDrawn: world.stars.count,
        lanternsDrawn: world.lanterns.count,
        starsVisible: world.stars.mesh.visible,
      };
    },

    /** The named stars, by the rule: each one's height and bearing from the boat now, degrees. */
    namedStars() {
      const physics = world.skyPhysics;
      if (physics === null) {
        return [];
      }
      const deg = 180 / Math.PI;
      return catalog.sky.stars.map((s) => {
        const b = physics.skyStar(
          world.skyAt,
          world.pose.east,
          world.pose.north,
          s.rightAscension,
          s.declination,
        );
        return {
          name: s.name,
          magnitude: s.magnitude,
          height: (b[BODY.altitude] ?? 0) * deg,
          bearing: (b[BODY.bearing] ?? 0) * deg,
        };
      });
    },

    /**
     * Where the GPU draws a named star against where the module's rule and
     * the camera put it: a camera at the scene camera's place, 8° across,
     * looks along the rule's direction to the star; the stars alone are
     * drawn, that one only, and the centre of its light is found. Returns
     * the angle between the two, in degrees, or null if nothing was drawn.
     * It is the sky of the last frame drawn: setSky draws one.
     */
    async starOffset(name: string, size = 160): Promise<number | null> {
      const physics = world.skyPhysics;
      const named = world.stars.named.find((n) => n.name === name);
      const star = catalog.sky.stars.find((s) => s.name === name);
      if (physics === null || named === undefined || star === undefined) {
        throw new Error(`no star ${name}, or no sky`);
      }
      const b = physics.skyStar(
        world.skyAt,
        world.pose.east,
        world.pose.north,
        star.rightAscension,
        star.declination,
      );
      const dir = new Vector3(b[BODY.east] ?? 0, b[BODY.up] ?? 0, -(b[BODY.north] ?? 0));
      const fov = 8;
      const cam = new PerspectiveCamera(fov, 1, 0.2, 4000);
      cam.position.copy(stage.camera.position);
      if (Math.abs(dir.y) > 0.99) {
        cam.up.set(0, 0, -1);
      }
      cam.lookAt(cam.position.clone().add(dir));
      cam.updateMatrixWorld();
      const g = gfx();
      const r = g.renderer;
      const stars = world.stars;
      const scene = new Scene();
      const parent = stars.mesh.parent;
      const visible = stars.mesh.visible;
      scene.add(stars.mesh);
      stars.mesh.visible = true;
      stars.setSolo(named.index);
      stars.resize(size, size);
      const target = new RenderTarget(size, size, {
        type: FloatType,
        format: RGBAFormat,
        depthBuffer: true,
      });
      const before = r.getRenderTarget();
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, cam);
      r.setRenderTarget(before);
      stars.setSolo(-1);
      stars.mesh.visible = visible;
      parent?.add(stars.mesh);
      const px = await readTarget(r, target, size, size, webgl());
      target.dispose();
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = px[(y * size + x) * 4] ?? 0;
          sum += v;
          sx += v * (x + 0.5);
          sy += v * (y + 0.5);
        }
      }
      if (sum <= 0) {
        return null;
      }
      const perPixel = (2 * Math.tan(((fov / 2) * Math.PI) / 180)) / size;
      const off = Math.hypot(sx / sum - size / 2, sy / sum - size / 2) * perPixel;
      return (Math.atan(off) * 180) / Math.PI;
    },

    /**
     * Where a named star is on the screen now, CSS pixels, by the rule and
     * the camera; whether it is in front of the camera, and shows.
     */
    starOnScreen(name: string): { x: number; y: number; front: boolean; shows: boolean } | null {
      const named = world.stars.named.find((n) => n.name === name);
      const canvas = stage.gfx?.canvas;
      if (named === undefined || canvas === undefined) {
        return null;
      }
      const dir = world.stars.direction(named, new Vector3());
      const at = world.stars.screen(
        dir,
        stage.camera,
        canvas.clientWidth,
        canvas.clientHeight,
        new Vector3(),
      );
      return {
        x: at.x,
        y: at.y,
        front: at.z < 1,
        shows: world.stars.shows(named, dir) && at.z < 1,
      };
    },

    /** The name a tap at (x, y) on the canvas showed, if any, and the label on screen. */
    tapSky(x: number, y: number): { name: string | null; label: string | null } {
      const name = world.tap(x, y, performance.now());
      hooks.render();
      const el = document.querySelector<HTMLElement>('.star-label');
      return { name, label: el !== null && !el.hidden ? el.textContent : null };
    },

    /** Drags the camera by dx, dy CSS pixels, as a finger on the open sea would; then a frame. */
    dragCamera(dx: number, dy: number): { elevation: number; tilt: number; looksUp: boolean } {
      world.camera.drag(dx, dy, performance.now());
      hooks.render();
      return {
        elevation: world.camera.view.elevation,
        tilt: world.camera.tilt,
        looksUp: world.camera.looksUp,
      };
    },

    /** Holds the sky as it was last drawn, wherever the boat goes, or lets it follow the rule again. */
    holdSky(on: boolean): void {
      world.holdSky = on;
    },

    /** Draws the stars and lanterns, or not. */
    drawSky(on: boolean): void {
      world.drawSky = on;
    },

    /** Where the lantern drawn i-th is on screen, CSS pixels, and the bearing it is seen from. */
    lanternOnScreen(i: number): { x: number; y: number; bearing: number } | null {
      const l = world.lanterns;
      const canvas = stage.gfx?.canvas;
      if (i >= l.count || canvas === undefined) {
        return null;
      }
      const a = l.place.array as Float32Array;
      const p = new Vector3(a[i * 4] ?? 0, a[i * 4 + 1] ?? 0, a[i * 4 + 2] ?? 0);
      const bs = world.boatScene;
      p.y -= domeDrop(Math.hypot(p.x - bs.x, p.z - bs.z));
      p.project(stage.camera);
      return {
        x: ((p.x + 1) / 2) * canvas.clientWidth,
        y: ((1 - p.y) / 2) * canvas.clientHeight,
        bearing: a[i * 4 + 3] ?? 0,
      };
    },

    /** Where a point of the world (east, north, height above the sea, m) is on screen, CSS pixels, with the dome's drop. */
    worldOnScreen(east: number, north: number, height: number): { x: number; y: number } | null {
      const canvas = stage.gfx?.canvas;
      if (canvas === undefined) {
        return null;
      }
      const o = world.origin.world;
      const p = new Vector3(east - o.x, height, -(north - o.y));
      const fs = world.focusScene;
      p.y -= domeDrop(Math.hypot(p.x - fs.x, p.z - fs.z));
      p.project(stage.camera);
      return { x: ((p.x + 1) / 2) * canvas.clientWidth, y: ((1 - p.y) / 2) * canvas.clientHeight };
    },

    /**
     * The boat's parts on screen, CSS pixels: each part as drawn (the hull,
     * the mast, the sail, the sailor…), the box of its points above the
     * water through the camera, with the dome's drop.
     */
    boatBox(): { name: string; left: number; top: number; right: number; bottom: number }[] {
      const canvas = stage.gfx?.canvas;
      const boat = world.boat;
      if (canvas === undefined || boat === null) {
        return [];
      }
      boat.root.updateWorldMatrix(true, true);
      const fs = world.focusScene;
      const out: { name: string; left: number; top: number; right: number; bottom: number }[] = [];
      boat.root.traverse((o) => {
        if (!(o instanceof Mesh) || !o.visible) {
          return;
        }
        const pos = o.geometry.getAttribute('position');
        if (pos === undefined) {
          return;
        }
        const r = {
          name: o.name,
          left: Infinity,
          top: Infinity,
          right: -Infinity,
          bottom: -Infinity,
        };
        const p = new Vector3();
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (p.y < 0) {
            continue;
          }
          p.y -= domeDrop(Math.hypot(p.x - fs.x, p.z - fs.z));
          p.project(stage.camera);
          const x = ((p.x + 1) / 2) * canvas.clientWidth;
          const y = ((1 - p.y) / 2) * canvas.clientHeight;
          r.left = Math.min(r.left, x);
          r.right = Math.max(r.right, x);
          r.top = Math.min(r.top, y);
          r.bottom = Math.max(r.bottom, y);
        }
        if (r.left <= r.right) {
          out.push(r);
        }
      });
      return out;
    },

    /** Sets the world's end the sandbox's countdown shows, ms of UTC; and its epoch and closing. */
    setWorldEnd(end: { ends: number; epoch: number; closing: number }): void {
      const c = sailing.countdown;
      if (c === undefined) {
        throw new Error('no countdown');
      }
      c.setEnd({ world: 'sandbox', zone: '', ...end });
    },

    /** Opens the chart, its list or the news; null closes it. */
    openChart(mode: ChartMode | null): void {
      chartParts().chart.show(mode);
    },

    /** Where a charted subject lies on the chart's screen, CSS pixels. */
    chartPoint(subject: ChartSubject, number: number): { x: number; y: number } | null {
      const c = chartParts().chart;
      const e = c.store.get(subject, number);
      return e === undefined ? null : c.view.screenOf(e.east, e.north);
    },

    /** How many frames have drawn the sea, and where the boat is. */
    seaFrames(): number {
      return seaFrames;
    },
    boatAt(): { east: number; north: number } {
      return { east: world.pose.east, north: world.pose.north };
    },

    /** Opens the chart at a subject, its box open. */
    chartAt(subject: ChartSubject, number: number): boolean {
      const c = chartParts().chart;
      const e = c.store.get(subject, number);
      if (e === undefined) {
        return false;
      }
      c.showAt(e);
      return true;
    },

    /** Looks at the whole chart. */
    fitChart(): void {
      chartParts().chart.view.fit();
    },

    /** The entry a tap at (x, y) CSS pixels on the chart picks, and opens its box. */
    pickChart(x: number, y: number): string | null {
      const c = chartParts().chart;
      const e = c.view.pick(x, y);
      c.picked.value = e;
      return e === null ? null : c.store.title(e);
    },

    /** Gives the chart entries, as the server would: whole, or charted since. */
    chartReceive(entries: ChartEntry[], whole: boolean): void {
      chartParts().chart.store.receive(entries, whole);
    },

    /** What the chart holds and how it was last drawn. */
    chartInfo() {
      const c = chartParts().chart;
      const v = c.view;
      const labels = [...document.querySelectorAll<HTMLElement>('.chart-label')];
      return {
        open: c.open.value,
        mode: c.mode.value,
        size: c.store.size,
        titles: c.store.entries.map((e) => c.store.title(e)),
        mine: c.store.entries.filter((e) => c.store.mine(e)).map((e) => c.store.title(e)),
        credits: c.store.entries.map((e) => [c.store.title(e), e.by] as [string, string]),
        models: v.modelsHad,
        draws: v.draws,
        ...v.size(),
        problems: checkChartScene(v.scene),
        labels: labels
          .filter((l) => !l.hidden)
          .map((l) => ({
            text: l.querySelector('.chart-name')?.textContent ?? '',
            italic: getComputedStyle(l.querySelector('.chart-name') ?? l).fontStyle === 'italic',
            kind: l.className,
          })),
        picked: c.picked.value === null ? null : c.store.title(c.picked.value),
      };
    },

    /** The forecast held: the latest issue, its steps and systems, its gale warning, and what is kept. */
    forecast() {
      const f = chartParts().sea.forecasting;
      if (f === null) {
        return null;
      }
      const latest = f.forecasts.latest;
      const H = RECORDS.forecastHead;
      return {
        issue: latest === null ? null : (latest.head[H.issue] ?? 0),
        steps: latest === null ? 0 : (latest.head[H.steps] ?? 0),
        until: latest === null ? null : (latest.head[H.until] ?? 0),
        systems: latest?.systems.length ?? 0,
        gale: latest?.gale ?? null,
        warning: warningInForce(f, chartParts().chart.store),
        truth: f.forecasts.truth.map((k) => k.tick),
        tick: f.tick(),
        version: f.forecasts.version,
      };
    },

    /** Puts the boat on the water in Port Royal's harbour, where the board is: the sandbox only. */
    toHarbour(): boolean {
      const at = harbourWater(world);
      if (at === null) {
        return false;
      }
      offline().place(at.east, at.north, 0);
      floatBoat();
      return true;
    },

    /** The harbourmaster's board: whether its button shows, and its words if it is open. */
    board() {
      const button = document.querySelector('[data-pusher=board]');
      const board = document.querySelector<HTMLElement>('.board');
      return { button: button !== null, text: board?.innerText ?? null };
    },

    /** A storm to bring a gale to the boat minutes on, and the forecast issued again: the sandbox only. */
    galeIn(minutes: number): void {
      const s = offline();
      const st = s.physics.records.state;
      s.meetGale(st[RECORDS.state.x] ?? 0, st[RECORDS.state.y] ?? 0, minutes);
      sailing.forecast?.again();
    },

    /**
     * Every kind of system on the disk at once, each at its strongest now
     * in a place of its own, and a warm front and a cold front crossing it,
     * in a held spell of the first fair regime; the forecast issued again:
     * the chart's every symbol at once. The sandbox only.
     */
    everyKind(): void {
      const s = offline();
      const c = catalog.weather;
      const physics = s.physics;
      const now = s.tick;
      const minute = 60 * 30;
      const fair = Math.max(
        0,
        c.regimes.findIndex((r) => !r.frontal),
      );
      const frontal = Math.max(
        0,
        c.regimes.findIndex((r) => r.frontal),
      );
      const P = RECORDS.spell;
      const base = heldSpell(physics, c, fair, now - 240 * minute);
      // The systems placed here blow whatever the spell.
      base[P.still] = 0;
      const reach = physics.frontReach();
      // A front's line lies at line m along the way it moves now, crossing
      // the disk in change ticks.
      const front = (from: number, toward: number, line: number, warm: boolean) => {
        const spell = heldSpell(physics, c, frontal, 0);
        const change = 120 * minute;
        const begin = Math.round(now - ((line + reach) / (2 * reach)) * change);
        spell[P.begin] = begin;
        spell[P.start] = begin;
        spell[P.change] = change;
        spell[P.front] = 1;
        spell[P.warm] = warm ? 1 : 0;
        spell[P.from] = Math.round((from / 360) * WEATHER.turnSteps);
        spell[P.toward] = Math.round((toward / 360) * WEATHER.turnSteps);
        spell[P.still] = 0;
        return spell;
      };
      const warm = front(250, 80, 2800, true);
      const cold = front(290, 100, -3000, false);
      // The later to begin is the one the wind takes; both are drawn.
      const spells = [base, warm, cold].sort((a, b) => (a[P.begin] ?? 0) - (b[P.begin] ?? 0));
      // Each kind's place, by its symbol, kept apart on the disk.
      const places: Record<string, [number, number]> = {
        spiral: [-4300, 3500],
        low: [4100, -3700],
        'dash-dot': [-3300, -3600],
        dashed: [1600, 4800],
        cell: [1400, -700],
        heap: [-900, 1300],
        bank: [-1500, -1200],
        calm: [3600, 1300],
      };
      const records = c.systems.map((k, kind) => {
        const [east, north] = places[k.symbol] ?? [0, 0];
        return placedRecord(c, kind, east, north, now - 20 * minute, now, base);
      });
      physics.setRecords(records);
      s.systems = records.length;
      s.weather.set(spells);
      sailing.forecast?.again();
    },

    /**
     * A storm at its strongest now on the disk's rim, east of the centre,
     * its ring reaching past the world's edge; the forecast issued again.
     * The sandbox only.
     */
    stormAtRim(): void {
      const s = offline();
      const c = catalog.weather;
      const physics = s.physics;
      const now = s.tick;
      const minute = 60 * 30;
      const fair = Math.max(
        0,
        c.regimes.findIndex((r) => !r.frontal),
      );
      const base = heldSpell(physics, c, fair, now - 240 * minute);
      base[RECORDS.spell.still] = 0;
      const kind = Math.max(
        0,
        c.systems.findIndex((k) => k.symbol === 'spiral'),
      );
      const lip = catalog.world.disk.radius;
      physics.setRecords([placedRecord(c, kind, lip * 0.97, 0, now - 20 * minute, now, base)]);
      s.systems = 1;
      s.weather.set([base]);
      sailing.forecast?.again();
    },

    /** Ticks the sandbox's forecast and reads the barometer now, as their timers do: the sandbox only. */
    weatherNow(): void {
      sailing.forecast?.tick();
      sailing.readBarometer?.();
    },

    /** Issues the sandbox's forecast again now, as the weather is: the sandbox only. */
    issueForecast(): void {
      if (sailing.forecast === undefined) {
        throw new Error('the sandbox only');
      }
      sailing.forecast.again();
    },

    /** The chart's slider to minutes ahead, by the forecast. */
    chartTime(minutes: number): void {
      const c = chartParts().chart;
      c.playing.value = false;
      c.minutes.value = Math.round(minutes);
    },

    /** The chart's slider: its minutes and whether Play runs it. */
    chartSlider() {
      const c = chartParts().chart;
      return { minutes: c.minutes.value, playing: c.playing.value };
    },

    /** Where a point of the water lies on the chart's screen, CSS pixels; null off it. */
    chartScreenOf(east: number, north: number): { x: number; y: number } | null {
      return chartParts().chart.view.screenOf(east, north);
    },

    /** The boat's arrow on the chart: its nose and tail on the screen, CSS pixels, and its scale. */
    chartArrow() {
      return chartParts().chart.view.arrowEnds();
    },

    /** Zooms the chart by a factor about what it looks at: under 1 nearer. */
    zoomChart(f: number): void {
      chartParts().chart.view.zoom(f);
    },

    /** Looks at the boat on the chart from distance m. */
    chartFromBoat(distance: number): void {
      const v = chartParts().chart.view;
      v.lookAt(world.pose.east, world.pose.north, distance);
    },

    /** The weather system or front whose box is open, or null. */
    chartTapped() {
      return chartParts().chart.tapped.value;
    },

    /** The course last steered for a system from its box, or null. */
    chartSteered() {
      return chartParts().chart.steered.value;
    },

    /** The chart's weather's layers, those given switched as given. */
    chartLayers(layers: Partial<Record<Layer, boolean>>): void {
      const c = chartParts().chart;
      c.layers.value = { ...c.layers.value, ...layers };
    },

    /** What the chart's weather last painted: its moment, what it drew and how long it took. */
    chartWeather() {
      const w = chartParts().weather;
      const s = w?.scene ?? null;
      return {
        paints: w?.paints ?? 0,
        took: w?.took ?? null,
        moment:
          s === null
            ? null
            : { kind: s.moment.kind, minutes: s.moment.minutes, tick: s.moment.tick },
        systems:
          s?.systems.map((x) => ({
            slot: x.slot,
            seed: x.seed,
            draw: x.draw,
            name: x.name,
            east: x.east,
            north: x.north,
            heading: x.heading,
            speed: x.speed,
            size: x.size,
            length: x.length,
            ring: x.ring,
            strength: x.strength,
            wind: x.wind,
            gust: x.gust,
            ahead: x.ahead,
            gone: x.gone,
          })) ?? [],
        fronts: s?.fronts.length ?? 0,
        gale: s?.gale === null || s?.gale === undefined ? 0 : s.gale.on.reduce((a, b) => a + b, 0),
        rain: s === null ? 0 : s.grid.rain.reduce((a, b) => a + (b >= 0.1 ? 1 : 0), 0),
        fog: s === null ? 0 : s.grid.fog.reduce((a, b) => a + (b < 1852 ? 1 : 0), 0),
        inked: w === null ? 0 : inkedOf(w.canvas),
      };
    },

    /** A charted place's weather by its name, at the slider's time: its box's lines, outlook and warning. */
    async placeWeather(name: string) {
      const c = chartParts();
      const f = c.sea.forecasting;
      const e = c.chart.store.entries.find((x) => x.name === name);
      if (f === null || e === undefined) {
        return null;
      }
      const m = momentOf(c.chart.minutes.value, f);
      return placeWords(f, m, pointsOf(e), c.chart.store);
    },

    /** The barometer: its words, its reading and its set hand's, hPa, and its hands' angles. */
    barometer() {
      const b = sailing.barometer;
      if (b === undefined) {
        return null;
      }
      return {
        words: b.words.value,
        now: b.now,
        set: b.set,
        hand: b.hand.el?.style.transform ?? '',
        setHand: b.setHand.el?.style.transform ?? '',
      };
    },

    /** The ship's clock, read now: its hour, its words, and its hands' and disc's turns as drawn. */
    clock() {
      const c = sailing.clock;
      if (c === undefined) {
        return null;
      }
      sailing.readClock?.();
      const drawn = (part: 'hour' | 'minute' | 'disc') =>
        document.querySelector(`#case-clock [data-hand=${part}]`)?.getAttribute('transform') ??
        null;
      return {
        hour: c.hour,
        words: c.words.value,
        sun: c.sun.value,
        hand: drawn('hour'),
        minuteHand: drawn('minute'),
        disc: drawn('disc'),
      };
    },

    /** Holds a change on the barometer, hPa a quarter of an hour, from now; null lets it go. */
    holdBarometer(rate: number | null): void {
      const b = sailing.barometer;
      if (b !== undefined) {
        b.hold(rate, world.ticks);
      }
    },

    /** A point's position as the chart writes it. */
    position(east: number, north: number): string {
      return formatPosition(east, north);
    },

    /** The notice shown and how many wait; raises one, for the tests of the notices. */
    notices() {
      const n = chartParts().notices;
      const s = n.shown.value;
      return {
        text: s?.text ?? null,
        level: s?.kind.level ?? null,
        waiting: n.waiting,
        off: [...n.off.value],
      };
    },
    noticesShown(): string[] {
      return [...noticesShown];
    },
    raiseNotice(on: string, fill: Record<string, string>): void {
      chartParts().notices.raise(on, fill, performance.now());
    },

    /** Resolves after n frames of the frame loop. */
    frames(n: number): Promise<void> {
      return new Promise((resolve) => {
        let left = n;
        const prev = world.onFrame;
        world.onFrame = () => {
          prev?.();
          left--;
          if (left <= 0) {
            world.onFrame = prev;
            resolve();
          }
        };
      });
    },
  };

  return hooks;
}

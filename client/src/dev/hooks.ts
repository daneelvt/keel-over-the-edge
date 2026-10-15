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

import {
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
  Vector3,
} from 'three';
import {
  Fn,
  float,
  floor,
  instanceIndex,
  ivec2,
  positionWorld,
  screenCoordinate,
  textureLoad,
  varying,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { catalog } from '../catalog';
import type { BoatDriver } from '../game/driver';
import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import type { Game } from '../game/game';
import { nowUs, worldUs } from '../net/clock';
import type { BumpTold } from '../net/messages';
import type { Online } from '../net/online';
import type { Cascade } from '../ocean/detail';
import { FieldMaker, newFields } from '../ocean/field';
import { foamOn } from '../ocean/foam';
import { gustAt } from '../ocean/gusts';
import { hexAt, hexCentre, NEIGHBOURS, TILE_APOTHEM, TILE_RADIUS, tileHash } from '../ocean/hex';
import { HULL_FILL, hulls, insideHull, toHullFrame } from '../ocean/hulls';
import { type FoamLook, WAKE } from '../ocean/look';
import {
  detailOn,
  farLook,
  type Probe,
  tileHashNode,
  tileIdentity,
  tileLook,
} from '../ocean/seamaterial';
import { GUST_ROW, PASS_WIDTH } from '../ocean/tilepass';
import { SKIRT_DEPTH } from '../ocean/tiles';
import { boatBandAt } from '../ocean/wave';
import { type RecordValues, spellOf, steer, toHex } from '../predict/golden';
import { RECORDS, SEA } from '../predict/layout.gen';
import { BODY, SKY, WIND_VALUE, WIND_VALUES } from '../predict/physics';
import type { Predictor } from '../predict/predictor';
import { checkScene, DOME_RADIUS, domeDrop, seaMaterial } from '../render/materials';
import { rungName, TIERS } from '../render/quality';
import { CAMERA_PRESETS, type SeaScene } from '../render/scene';
import { KNOT, type Sandbox, SEA_STATES } from '../sandbox/sandbox';
import { hourAt, moonAgeAt, skyPeriods } from '../sky/skytime';
import type { Settings } from '../ui/settings';
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
export type Sailing =
  | { sandbox: Sandbox; online?: undefined; predictor?: undefined }
  | { sandbox?: undefined; online: Online; predictor: Predictor };

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

  const hooks = {
    world,

    /** What the scene is drawing with; backend is empty while a lost renderer is rebuilt. */
    info(): Info {
      const g = stage.gfx;
      return {
        backend: g?.backend ?? '',
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

    thaw(): void {
      game.thaw();
      stage.freeze(false);
    },

    /** Draws one frame now, with the screen's words up to date. */
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
     * scenario has them. It stays until the boat is next stepped or placed.
     */
    setSeaWindow(col: number, row: number, size: number, areas: number[][]): void {
      const s = offline();
      s.seas.reset();
      s.seas.receive({
        tick: 0,
        col,
        row,
        size,
        speed: areas.map((a) => a[0] ?? 0),
        from: areas.map((a) => a[1] ?? 0),
        fetch: areas.map((a) => a[2] ?? 0),
      });
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
    placeBoat(east: number, north: number): void {
      offline().place(east, north, driver.states.current[RECORDS.state.heading] ?? 0);
      floatBoat();
    },
    /** Puts the origin on tile (q, r), as if the boat had come from there. */
    setOrigin(q: number, r: number): void {
      world.origin.moveTo({ q, r });
    },
    camera(name: string): void {
      const p = CAMERA_PRESETS[name];
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
     * pictures back; the tests take screenshots instead.)
     */
    async show(): Promise<void> {
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          stage.renderOnce(performance.now());
          r();
        }),
      );
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
     * Resolves when the boat's model has loaded. The low tier's loops are
     * made whole at once, unless told to leave them to the frames.
     */
    async ready(finish = true): Promise<void> {
      while (world.boat === null) {
        await new Promise((r) => setTimeout(r, 50));
      }
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
      return {
        state: named(RECORDS.state, driver.states.current),
        out: named(RECORDS.out, driver.out),
        helm: game.helm.target,
        sheet: game.sheet.target,
        steps: game.clock.steps,
        wind: { ...driver.wind },
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
      const knots = sea === null ? undefined : SEA_STATES[sea];
      if (knots !== undefined) {
        s.steadyNow(knots * KNOT, 0);
      } else {
        s.steadyNow(s.start.wind.speed, s.start.wind.from);
      }
      await world.setRung(0, 'test');
      world.ocean.detail.finishBake();
      world.ocean.wakes.clear();
      world.ocean.detail.clearFoam();
      world.spray.reset(1);
    },
    setState(values: Record<string, number>): void {
      offline().setState(values);
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
    /** The audio context's state: 'none' before the first gesture. */
    soundState(): string {
      return game.sound.state;
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
        counts: { ...p.counts },
        p95: p.p95(),
        traffic: { ...o.traffic },
      };
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
      const hull = world.kind.physics.hull;
      if (physics !== undefined && slot >= 0) {
        physics.seaDrawAt(game.clock.steps + game.clock.alpha);
        drawn.forEach((d, i) => {
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
      world.fleetSource = { drawn, count: drawn.length };
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
      for (const level of [world.fleet.near, world.fleet.far]) {
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
        near: world.fleet.near.count,
        far: world.fleet.far.count,
        nearMeshes: world.fleet.near.meshes.length,
        farMeshes: world.fleet.far.meshes.length,
      };
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
     * foam map's, the shadow map's (its depth and its colour target) and the
     * pattern's; and every texture's, the whole scene's.
     */
    textureBytes(): {
      detail: number;
      foamMap: number;
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
        shadowMap: world.shadows.light.castShadow ? sum([map?.texture, map?.depthTexture]) : 0,
        pattern: size(ocean.pattern),
        all: info.memory.texturesSize,
      };
    },
    /** The tier's values in use. */
    tier() {
      return { ...TIERS[world.rung.tier], shadows: world.rung.shadows };
    },
    /** Draws the detail band, the foam, or neither. */
    setParts(parts: { detail?: boolean; foam?: boolean; wakes?: boolean }): void {
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
        ocean.wakes.update(gfx().renderer, { ...f, dt: 1 / rate });
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
      m.fragmentNode = farLook(far.plane, far.area, far.nearHull, world.ocean.parts, true);
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
    /** The foam map: its side in texels, its centre in the world, the side of a texel in metres, and its texels from the south-west, 0 to 255. */
    async wakes(): Promise<{
      size: number;
      east: number;
      north: number;
      texel: number;
      data: number[];
    }> {
      const w = world.ocean.wakes;
      // Copied into a float target first: WebGL reads an 8-bit red target
      // back only where the driver says it can.
      const n = w.size;
      const m = new MeshBasicNodeMaterial();
      const texel = textureLoad(w.texture as never, ivec2(floor(screenCoordinate)));
      m.fragmentNode = vec4(texel.x, 0, 0, 1);
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
      for (let i = 0; i < n * n; i++) {
        data[i] = Math.round(255 * (got[i * 4] ?? 0));
      }
      return {
        size: w.size,
        east: w.centre.east,
        north: w.centre.north,
        texel: WAKE.span / w.size,
        data,
      };
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

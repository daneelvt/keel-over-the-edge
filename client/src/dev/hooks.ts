// SPDX-License-Identifier: AGPL-3.0-only

// The hooks the browser tests drive, on window.keel with ?test. Loaded only
// when asked for. They read back what the GPU computed (each tile's plane,
// and, through a probe material, each fragment's tile and scene position)
// and compare it with the same sums done in float64 here; and they sail the
// boat: set its state, wind and controls, step it, script its controls,
// and read back what the screen shows.

import {
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  RenderTarget,
  RGBAFormat,
  Scene,
} from 'three';
import {
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
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { BoatDriver } from '../game/driver';
import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import type { Game } from '../game/game';
import type { Online } from '../net/online';
import { hexAt, hexCentre, NEIGHBOURS, TILE_APOTHEM, TILE_RADIUS, tileHash } from '../ocean/hex';
import { tileHashNode, tileIdentity } from '../ocean/seamaterial';
import { PASS_HEIGHT, PASS_WIDTH } from '../ocean/tilepass';
import { SKIRT_DEPTH } from '../ocean/tiles';
import { steer, toHex } from '../predict/golden';
import { RECORDS } from '../predict/layout.gen';
import type { Predictor } from '../predict/predictor';
import { checkScene, DOME_RADIUS, domeDrop, seaMaterial } from '../render/materials';
import { CAMERA_PRESETS, type SeaScene } from '../render/scene';
import { KNOT, type Sandbox } from '../sandbox/sandbox';
import type { Settings } from '../ui/settings';

export interface Info {
  backend: string;
  compat: boolean;
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
  (globalThis as unknown as { keel: KeelHooks }).keel = makeHooks(world, game, sailing);
}

export type KeelHooks = ReturnType<typeof makeHooks>;

function makeHooks(world: SeaScene, game: Game, sailing: Sailing) {
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
  const sample = new Float64Array(3);

  /** Tile i's centre in the scene, as float32 holds it on the GPU. */
  const tileCentre = (i: number): [number, number] => {
    const field = world.ocean.field;
    const centre = world.ocean.passTiles.centre.value;
    return [
      Math.fround(Math.fround(centre.x) + Math.fround(field.offset[i * 2] ?? 0)),
      Math.fround(Math.fround(centre.y) + Math.fround(-(field.offset[i * 2 + 1] ?? 0))),
    ];
  };

  /** The planes the tile pass should hold, computed in float64 from the same inputs. */
  const referencePlanes = (): Float64Array => {
    const field = world.ocean.field;
    const bs = world.boatScene;
    const out = new Float64Array(field.count * 4);
    for (let i = 0; i < field.count; i++) {
      const [cx, cz] = tileCentre(i);
      world.ocean.band.sample(cx, cz, sample);
      const dx = cx - bs.x;
      const dz = cz - bs.z;
      out[i * 4] = (sample[0] ?? 0) - domeDrop(Math.hypot(dx, dz));
      out[i * 4 + 1] = (sample[1] ?? 0) - dx / DOME_RADIUS;
      out[i * 4 + 2] = (sample[2] ?? 0) - dz / DOME_RADIUS;
      out[i * 4 + 3] = sample[0] ?? 0;
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
  const probe = async (x: number, z: number, size: number, span: number): Promise<Float32Array> => {
    const g = gfx();
    const tiles = world.ocean.tiles;
    const m = seaMaterial('sea-tile');
    m.positionNode = tiles.position;
    const id = varying(
      float(instanceIndex)
        .mul(2)
        .add(tiles.varyings.side.lessThan(-0.5).select(float(2), float(1))),
    );
    m.fragmentNode = vec4(positionWorld, id);
    const scene = new Scene();
    const mesh = new Mesh(tiles.geometry, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const cam = new OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 400);
    cam.position.set(x, 200, z);
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

    setSea(name: string): void {
      world.setTestSea(name);
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
        PASS_HEIGHT,
        webgl(),
      );
      return {
        gpu: Array.from(gpu.subarray(0, count * 4)),
        cpu: Array.from(referencePlanes()),
        count,
      };
    },

    /** The largest step between neighbouring tiles at their shared corners, from the pass's planes. */
    async steps(): Promise<{ largest: number; skirt: number }> {
      const field = world.ocean.field;
      const gpu = await readTarget(
        gfx().renderer,
        world.ocean.pass.target,
        PASS_WIDTH,
        PASS_HEIGHT,
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
      for (const w of world.ocean.band.waves) {
        a += Math.abs(w.w);
        ak += Math.abs(w.w * w.z);
      }
      return { height: a * 2 ** -11 + 2e-5, slope: ak * 2 ** -11 + 2e-6 };
    },

    /** Resolves when the boat's model has loaded. */
    async ready(): Promise<void> {
      while (world.boat === null) {
        await new Promise((r) => setTimeout(r, 50));
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
      };
    },

    /** The state's fields in hexadecimal, as the golden tests write them. */
    stateBits(): Record<string, string> {
      return Object.fromEntries(
        Object.entries(RECORDS.state).map(([k, i]) => [k, toHex(driver.states.current[i] ?? 0)]),
      );
    },

    /** Back to the start, at rest. */
    reset(): void {
      offline().reset();
    },
    setState(values: Record<string, number>): void {
      offline().setState(values);
    },
    /** The sandbox's wind, in knots and the degrees it comes from. */
    setWind(knots: number, from: number): void {
      offline().setWind(knots * KNOT, (from * Math.PI) / 180);
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
      world.fleetSource = { drawn, count: drawn.length };
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
    /** The player's own boat as predicted for tick, if still kept: its position and heading. */
    ownAt(tick: number): { east: number; north: number; heading: number } | null {
      const st = sailing.predictor?.stateAt(tick) ?? null;
      if (st === null) {
        return null;
      }
      return {
        east: st[RECORDS.state.x] ?? 0,
        north: st[RECORDS.state.y] ?? 0,
        heading: st[RECORDS.state.heading] ?? 0,
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

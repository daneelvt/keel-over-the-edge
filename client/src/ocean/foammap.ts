// SPDX-License-Identifier: AGPL-3.0-only

// The foam map: what every boat near the player's leaves on the water, kept
// in one small texture that follows the boat. It is a square of the sea seen
// from above, centred on the boat to the nearest texel, with two channels:
//
//   red    white water: born where the wake's waves fold (wakewaves.ts),
//          the bow's wave among them, and behind a transom driven past hull
//          speed; it spreads a little and fades in seconds
//   green  the track: the churned water a hull leaves along its whole
//          waterline, as strong as its speed through the water; it widens
//          as it fades, over tens of seconds, the lane a wake leaves behind
//          a boat, smooth and bubbly (Glessmer, "Turbulent wake", 2019)
//
// Each frame one pass makes the new map from the last: what was there,
// moved by however many texels the square moved and the water drifted,
// faded, spread into its neighbours, with the white water the wake's waves
// make where they fold; then every boat in the square is stamped, its track
// along its waterline and its transom's white water. Two targets take
// turns. The sea's material reads the map with one lookup, whatever the
// number of boats.
//
// A wake is drawing, not state: a boat that sails into the square has none
// behind it yet, and no two players' maps are the same.
//
// The targets hold 8 bits. At 60 frames a second a track fades by a
// twelfth of a percent a frame, less than half a step of 8 bits, so rounded
// to the nearest step it would never fade at all. The pass rounds it up or
// down at random instead, in proportion to the remainder, so the map fades
// at the right rate on average (a dither).

import {
  AddEquation,
  ClampToEdgeWrapping,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NoBlending,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  RGFormat,
  Scene,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
} from 'three';
import {
  abs,
  attribute,
  clamp,
  cos,
  dot,
  Fn,
  float,
  floor,
  fract,
  max,
  min,
  positionGeometry,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial, type Node, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { WAKE } from './look';

/** The most boats stamped in a frame: a full view and the player's own. */
export const STAMPS = 80;

function target(size: number): RenderTarget {
  const t = new RenderTarget(size, size, {
    format: RGFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
  });
  t.texture.name = 'foam map';
  return t;
}

/** What a frame gives the foam map. */
export interface FoamFrame {
  /** The floating origin, and the boat, in the world: metres east and north. */
  originEast: number;
  originNorth: number;
  boatEast: number;
  boatNorth: number;
  /** World time since the last frame, in seconds. */
  dt: number;
  /** The current at the boat, m/s east and north: what is on the water drifts with it. */
  currentEast: number;
  currentNorth: number;
}

/**
 * Where the wake's waves fold, for the map's pass: given the place of a
 * texel of the map in the world (east and north of the floating origin),
 * how far the waves' Jacobian falls below the threshold, 0 and up.
 */
export type FoldAt = (east: Node<'float'>, north: Node<'float'>) => Node<'float'>;

/**
 * A kind's hull, for the stamps: its waterline's ends aft and forward of
 * the origin (z aft), its half-beam, and the speed through the water past
 * which white water breaks behind its transom (look.ts's transomFrom).
 */
export interface StampHull {
  aft: number;
  fore: number;
  halfBeam: number;
  transomFrom: number;
}

/** How far a hull's stamp's square reaches from its middle, metres. */
function stampReach(h: StampHull): number {
  return Math.max(h.halfBeam + 0.5, (h.aft - h.fore + WAKE_TAIL) / 2 + 0.5);
}

export class FoamMap {
  /** Texels a side. */
  size: number;
  /** The square's centre in the world, on the texels' grid. */
  readonly centre = { east: 0, north: 0 };
  /** Which target holds the map. */
  current = 0;
  targets: [RenderTarget, RenderTarget];

  /** The floating origin's place in the map, as texture coordinates. */
  readonly #origin = uniform(new Vector2(0.5, 0.5));
  /** How far the square moved, as texture coordinates. */
  readonly #shift = uniform(new Vector2());
  /** How much of the white water and of the track a frame keeps, and how much of each goes to each neighbour. */
  readonly #fade = uniform(new Vector4(1, 1, 0, 0));
  /** A number that changes every frame, the white water the folding wake's waves give a frame, and 1 for a map just made. */
  readonly #frameInfo = uniform(new Vector4());
  /** The square's centre less the floating origin, metres east and north. */
  readonly #centreAt = uniform(new Vector2());
  readonly #texel = uniform(1 / 512);
  readonly #samplers: { value: Texture }[] = [];
  readonly #quad: QuadMesh;
  readonly #before: { value: Texture };
  readonly #stamps: Mesh;
  readonly #stampData: Float32Array;
  readonly #stampAttr: InstancedBufferAttribute;
  /** Each stamp's hull: its waterline's aft and forward ends (z aft), its half-beam, and where its transom breaks. */
  readonly #stampHulls: Float32Array;
  readonly #stampHullAttr: InstancedBufferAttribute;
  /** Each kind's hull, by its index; the first kind's stands for a kind not yet known. */
  readonly #hulls: StampHull[] = [];
  /** How far the longest hull's stamp reaches. */
  #reach = 4;
  /** The time a frame stamps, s. */
  readonly #dt = uniform(0);
  readonly #scene = new Scene();
  readonly #camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
  /** The drift not yet a whole texel, metres east and north. */
  readonly #drift = { east: 0, north: 0 };
  #count = 0;
  #placed = false;
  #frame = 0;

  constructor(size: number, fold: FoldAt | null = null) {
    this.size = size;
    this.targets = [target(size), target(size)];
    this.#texel.value = 1 / size;

    // The pass: last frame's map, moved, spread, faded and dithered, with
    // the white water of the wake's folding waves.
    const fade = this.#fade as unknown as Node<'vec4'>;
    const info = this.#frameInfo as unknown as Node<'vec4'>;
    const texel = this.#texel as unknown as Node<'float'>;
    const before = texture(this.targets[0].texture, uv());
    this.#before = before as unknown as { value: Texture };
    const material = new MeshBasicNodeMaterial();
    material.blending = NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.fragmentNode = Fn(() => {
      const at = uv().add(this.#shift);
      const tap = (dx: number, dy: number): Node<'vec2'> =>
        before.sample(at.add(vec2(dx, dy).mul(texel))).xy as unknown as Node<'vec2'>;
      const here = tap(0, 0);
      const around = tap(1, 0).add(tap(-1, 0)).add(tap(0, 1)).add(tap(0, -1));
      const spread = fade.zw;
      const kept = here
        .mul(float(1).sub(spread.mul(4)))
        .add(around.mul(spread))
        .mul(fade.xy)
        .toVar();
      if (fold !== null) {
        // The texel's place, east and north of the floating origin.
        const p = this.#centreAt.add(uv().sub(0.5).mul(WAKE.span));
        kept.x.addAssign(clamp(fold(p.x, p.y), 0, 1).mul(info.y));
      }
      // Nothing comes in from beyond the square, and its rim is kept clear,
      // so the sea beyond reads no foam.
      const inside = at
        .greaterThan(texel.mul(1.5))
        .all()
        .and(at.lessThan(float(1).sub(texel.mul(1.5))).all())
        .and(uv().greaterThan(texel.mul(1.5)).all())
        .and(
          uv()
            .lessThan(float(1).sub(texel.mul(1.5)))
            .all(),
        )
        .and(info.w.lessThan(0.5));
      // Up or down to a whole step of 8 bits, at random by the remainder.
      const noise = fract(
        sin(dot(floor(screenCoordinate.xy).add(info.x), vec2(12.9898, 78.233))).mul(43758.5453),
      );
      // (A value already on a step stays on it.)
      const steps = floor(min(kept, 1).mul(255).add(noise.mul(0.996)).add(0.002)).mul(1 / 255);
      return vec4(inside.select(steps, vec2(0)), 0, 1);
    })() as unknown as Node<'vec4'>;
    this.#quad = new QuadMesh(material);

    // The stamps: each hull's track along its waterline, and the white
    // water behind its transom, added to the map.
    const g = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(2, 2);
    g.setAttribute('position', plane.getAttribute('position'));
    g.setIndex(plane.getIndex());
    this.#stampData = new Float32Array(STAMPS * 4);
    this.#stampAttr = new InstancedBufferAttribute(this.#stampData, 4);
    this.#stampAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('stamp', this.#stampAttr);
    this.#stampHulls = new Float32Array(STAMPS * 4);
    this.#stampHullAttr = new InstancedBufferAttribute(this.#stampHulls, 4);
    this.#stampHullAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('hull', this.#stampHullAttr);
    g.instanceCount = 0;
    this.#stamps = new Mesh(g, this.#stampMaterial());
    this.#stamps.frustumCulled = false;
    this.#scene.add(this.#stamps);
    this.#camera.position.set(0, 0, 0);
    this.#camera.updateMatrixWorld();
  }

  /**
   * A hull's stamp: a square about its middle, in its own frame (x to
   * starboard, z aft), laying the track over its waterline and white water
   * behind its transom. The stamp's instance is its place in the square
   * (in half squares), its heading, and its speed through the water.
   */
  #stampMaterial(): MeshBasicNodeMaterial {
    const stamp = attribute<'vec4'>('stamp', 'vec4');
    const own = attribute<'vec4'>('hull', 'vec4');
    const sm = new MeshBasicNodeMaterial();
    // Added to what is there, one for one: the target has no alpha to weigh by.
    sm.blending = CustomBlending;
    sm.blendEquation = AddEquation;
    sm.blendSrc = OneFactor;
    sm.blendDst = OneFactor;
    sm.blendSrcAlpha = OneFactor;
    sm.blendDstAlpha = OneFactor;
    sm.transparent = true;
    sm.depthTest = false;
    sm.depthWrite = false;
    // The square's corners in the hull's frame: x to starboard, forward
    // along y; its middle half way along the waterline and the transom's tail.
    const reach = max(own.z.add(0.5), own.x.sub(own.y).add(WAKE_TAIL).mul(0.5).add(0.5));
    const middle = own.x.add(own.y).add(WAKE_TAIL).mul(0.5);
    const local = vec2(positionGeometry.x.mul(reach), positionGeometry.y.mul(reach).sub(middle));
    const hull = varying(own);
    const c = cos(stamp.z);
    const s = sin(stamp.z);
    const east = local.x.mul(c).add(local.y.mul(s));
    const north = local.y.mul(c).sub(local.x.mul(s));
    const half = 2 / WAKE.span;
    sm.positionNode = vec3(stamp.x.add(east.mul(half)), stamp.y.add(north.mul(half)), -1);
    // x to starboard, z aft.
    const at = varying(vec2(local.x, local.y.negate()));
    const speed = varying(stamp.w);
    const spotRing = varying(stamp.z);
    const dt = this.#dt as unknown as Node<'float'>;
    sm.fragmentNode = Fn(() => {
      const aft = hull.x;
      const fore = hull.y;
      const beam = hull.z;
      const length = aft.sub(fore);
      const along = at.y.sub(fore).div(length);
      const across = abs(at.x).div(beam);
      // The track: the waterline's plan, as an ellipse, softened at its edge.
      const e = along.mul(2).sub(1);
      const plan = float(1).sub(e.mul(e).add(across.mul(across)));
      const footprint = smoothstep(0, 0.35, plan);
      // As strong a frame as lays the churn's full measure along the track
      // whatever the frame rate: the distance sailed over the waterline.
      const pass = min(speed.mul(dt).div(length), 1);
      const churn = footprint
        .mul(min(speed.div(WAKE.churnSpeed), 1))
        .mul(pass)
        .mul(WAKE.churnLaid);
      // White water behind the transom past hull speed: a tongue the beam's
      // width, from the transom to WAKE_TAIL astern of it.
      const behind = at.y.sub(aft);
      const tongue = smoothstep(-0.2, 0.2, behind)
        .mul(float(1).sub(smoothstep(WAKE_TAIL * 0.4, WAKE_TAIL, behind)))
        .mul(float(1).sub(smoothstep(0.5, 1, across)));
      const from = hull.w;
      const driven = clamp(speed.sub(from).div(from.mul(WAKE.transomFull)), 0, 1);
      const white = tongue.mul(driven).mul(min(speed.mul(dt).div(WAKE_TAIL), 1));
      // A spot (its hull's last word below nought): white water laid at
      // once about its middle, a disc or a ring, as much as its speed says,
      // where something broke the water; or a smooth patch, the track's
      // alone with no white water, where a whale's fluke stroke near the
      // surface smoothed it (Levy and others 2011).
      const d = dot(at, at).sqrt().div(beam);
      const disc = float(1).sub(smoothstep(0.4, 1, d));
      const ring = smoothstep(0.45, 0.75, d).mul(float(1).sub(smoothstep(0.8, 1, d)));
      const smooth = spotRing.greaterThan(1.5);
      const spot = select(spotRing.greaterThan(0.5).and(smooth.not()), ring, disc).mul(speed);
      const isSpot = hull.w.lessThan(0);
      return vec4(
        max(select(isSpot, select(smooth, float(0), spot), white), 0),
        max(select(isSpot, select(smooth, spot, spot.mul(0.5)), churn), 0),
        0,
        1,
      );
    })() as unknown as Node<'vec4'>;
    return sm;
  }

  /** A kind's hull, by the kind's index: each boat stamps its own. */
  setHull(hull: StampHull, kind = 0): void {
    this.#hulls[kind] = { ...hull };
    this.#reach = Math.max(this.#reach, stampReach(hull));
  }

  /** Whether a kind's hull is known. */
  has(kind: number): boolean {
    return this.#hulls[kind] !== undefined;
  }

  /** The map as the sea's material reads it at the scene point p (x, z): the white water and the track, 0 to 1 each. */
  sample(p: Node<'vec2'>): Node<'vec2'> {
    const at = this.#origin.add(vec2(p.x, p.y.negate()).mul(1 / WAKE.span));
    const node = texture(this.targets[0].texture, at);
    this.#samplers.push(node as unknown as { value: Texture });
    return node.xy as unknown as Node<'vec2'>;
  }

  /** How many nodes read the map: a mark for forget. */
  get readers(): number {
    return this.#samplers.length;
  }

  /** Lets go of the first n nodes that read the map: their materials are gone. */
  forget(n: number): void {
    this.#samplers.splice(0, n);
  }

  /** The map's texture now. */
  get texture(): Texture {
    return (this.targets[this.current] as RenderTarget).texture;
  }

  /** Another size: the wakes are lost. */
  setSize(size: number): void {
    if (size === this.size) {
      return;
    }
    this.size = size;
    this.#texel.value = 1 / size;
    for (const t of this.targets) {
      t.setSize(size, size);
    }
    this.#placed = false;
  }

  /** Forgets every wake. */
  clear(): void {
    this.#placed = false;
  }

  /** Starts a frame's boats. */
  begin(): void {
    this.#count = 0;
  }

  /**
   * A boat in the world, heading clockwise from north, sailing at speed m/s
   * through the water. It is stamped if it lies in the square.
   */
  add(east: number, north: number, heading: number, speed: number, kind = 0): void {
    const h = this.#hulls[kind] ?? this.#hulls[0];
    if (this.#count >= STAMPS || !(speed > 0) || h === undefined) {
      return;
    }
    const at = this.#count * 4;
    this.#stampData[at] = east;
    this.#stampData[at + 1] = north;
    this.#stampData[at + 2] = heading;
    this.#stampData[at + 3] = speed;
    const hulls = this.#stampHulls;
    hulls[at] = h.aft;
    hulls[at + 1] = h.fore;
    hulls[at + 2] = h.halfBeam;
    hulls[at + 3] = h.transomFrom;
    this.#count++;
  }

  /**
   * A spot of white water at a place in the world, radius m across its
   * middle, white 0 to 1 laid at once: a disc, or a ring where something
   * broke the water. It is stamped if it lies in the square and there is
   * room after the boats.
   */
  spot(east: number, north: number, radius: number, white: number, ring = false): void {
    if (this.#count >= STAMPS || !(white > 0) || !(radius > 0)) {
      return;
    }
    const at = this.#count * 4;
    this.#stampData[at] = east;
    this.#stampData[at + 1] = north;
    this.#stampData[at + 2] = ring ? 1 : 0;
    this.#stampData[at + 3] = white;
    const hulls = this.#stampHulls;
    hulls[at] = radius;
    hulls[at + 1] = -radius;
    hulls[at + 2] = radius;
    hulls[at + 3] = -1;
    this.#reach = Math.max(this.#reach, radius + WAKE_TAIL);
    this.#count++;
  }

  /**
   * A smooth patch at a place in the world, radius m across: the track's
   * smooth water laid at strength 0 to 1, with no white water, fading as a
   * track does; a whale's footprint after a fluke stroke near the surface.
   */
  print(east: number, north: number, radius: number, strength: number): void {
    if (this.#count >= STAMPS || !(strength > 0) || !(radius > 0)) {
      return;
    }
    this.spot(east, north, radius, strength);
    this.#stampData[(this.#count - 1) * 4 + 2] = 2;
  }

  /** Brings the map to a frame: the pass, then the stamps. */
  update(renderer: WebGPURenderer, f: FoamFrame): void {
    const texel = WAKE.span / this.size;
    const east = Math.round(f.boatEast / texel) * texel;
    const north = Math.round(f.boatNorth / texel) * texel;
    if (f.dt > 1) {
      // A page hidden and shown again: what was there is long gone.
      this.#placed = false;
    }
    const fresh = !this.#placed;
    const moving = f.dt > 0;
    let de = fresh ? 0 : east - this.centre.east;
    let dn = fresh ? 0 : north - this.centre.north;
    if (fresh) {
      this.#drift.east = 0;
      this.#drift.north = 0;
    } else if (moving) {
      // The water drifts: what is on it moves over the ground with it.
      this.#drift.east += f.currentEast * f.dt;
      this.#drift.north += f.currentNorth * f.dt;
      const we = Math.trunc(this.#drift.east / texel);
      const wn = Math.trunc(this.#drift.north / texel);
      this.#drift.east -= we * texel;
      this.#drift.north -= wn * texel;
      de -= we * texel;
      dn -= wn * texel;
    }
    this.centre.east = east;
    this.centre.north = north;
    this.#origin.value.set(
      (f.originEast - east) / WAKE.span + 0.5,
      (f.originNorth - north) / WAKE.span + 0.5,
    );
    this.#centreAt.value.set(east - f.originEast, north - f.originNorth);
    if (!fresh && !moving && de === 0 && dn === 0) {
      // Time stands still and so does the square: the map is as it was.
      return;
    }
    this.#placed = true;
    this.#frame = (this.#frame + 1) % 1024;
    this.#shift.value.set(de / WAKE.span, dn / WAKE.span);
    const spread = (rate: number): number =>
      moving ? Math.min((rate * f.dt) / (texel * texel), 0.2) : 0;
    this.#fade.value.set(
      moving ? Math.exp(-f.dt / WAKE.decay) : 1,
      moving ? Math.exp(-f.dt / WAKE.churnDecay) : 1,
      spread(WAKE.spread),
      spread(WAKE.churnSpread),
    );
    // A map just made or resized starts clear.
    this.#frameInfo.value.set(this.#frame, moving ? WAKE.foldBirth * f.dt : 0, 0, fresh ? 1 : 0);
    this.#dt.value = moving ? f.dt : 0;
    const from = this.targets[this.current] as RenderTarget;
    const into = this.targets[1 - this.current] as RenderTarget;
    this.#before.value = from.texture;

    // Each stamp in the square's own coordinates, in half squares.
    const half = WAKE.span / 2;
    const data = this.#stampData;
    const reach = this.#reach / half;
    let n = 0;
    for (let i = 0; i < this.#count; i++) {
      const x = ((data[i * 4] as number) - east) / half;
      const y = ((data[i * 4 + 1] as number) - north) / half;
      if (Math.abs(x) > 1 + reach || Math.abs(y) > 1 + reach || !moving || fresh) {
        continue;
      }
      data[n * 4] = x;
      data[n * 4 + 1] = y;
      data[n * 4 + 2] = data[i * 4 + 2] as number;
      data[n * 4 + 3] = data[i * 4 + 3] as number;
      const hulls = this.#stampHulls;
      for (let k = 0; k < 4; k++) {
        hulls[n * 4 + k] = hulls[i * 4 + k] as number;
      }
      n++;
    }
    (this.#stamps.geometry as InstancedBufferGeometry).instanceCount = n;
    this.#stampAttr.needsUpdate = true;
    this.#stampHullAttr.needsUpdate = true;

    const before = renderer.getRenderTarget();
    const cleared = renderer.autoClear;
    renderer.setRenderTarget(into);
    this.#quad.render(renderer);
    if (n > 0) {
      renderer.autoClear = false;
      renderer.render(this.#scene, this.#camera);
      renderer.autoClear = cleared;
    }
    renderer.setRenderTarget(before);
    this.current = 1 - this.current;
    for (const s of this.#samplers) {
      s.value = into.texture;
    }
  }

  dispose(): void {
    for (const t of this.targets) {
      t.dispose();
    }
  }
}

/** The white water behind a transom reaches this far astern of it, metres. */
const WAKE_TAIL = 2;

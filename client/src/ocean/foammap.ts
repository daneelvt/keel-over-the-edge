// SPDX-License-Identifier: AGPL-3.0-only

// The foam map: the wakes of every boat near the player's, kept in one small
// texture that follows the boat. It is a square of the sea seen from above,
// centred on the boat to the nearest texel. Each frame one pass makes the
// new map from the last: what was there, moved by however many texels the
// square moved, faded, and spread a little into its neighbours; then every
// boat in the square is stamped under its stern, harder the faster it
// sails. Two targets take turns. The sea's material reads the map with one
// lookup, whatever the number of boats.
//
// A wake is drawing, not state: a boat that sails into the square has none
// behind it yet, and no two players' maps are the same.
//
// The targets hold 8 bits. At 60 frames a second a wake fades by a quarter
// of a percent a frame, less than half a step of 8 bits, so rounded to the
// nearest step it would never fade at all. The pass rounds it up or down at
// random instead, in proportion to the remainder, so the map fades at the
// right rate on average (a dither).

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
  RedFormat,
  RenderTarget,
  Scene,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
} from 'three';
import {
  attribute,
  dot,
  Fn,
  float,
  floor,
  fract,
  positionGeometry,
  screenCoordinate,
  sin,
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
/** A stamp's radius is this many of the hull's half-beams, and no less than a texel and a half. */
const STAMP_BEAMS = 1.1;

function target(size: number): RenderTarget {
  const t = new RenderTarget(size, size, {
    format: RedFormat,
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
  /** How far the square moved, as texture coordinates; how much of the foam a frame keeps; how much goes to each neighbour; and a number that changes every frame. */
  readonly #shift = uniform(new Vector2());
  readonly #fade = uniform(new Vector4(1, 0, 0, 0));
  readonly #texel = uniform(1 / 512);
  readonly #samplers: { value: Texture }[] = [];
  readonly #quad: QuadMesh;
  readonly #before: { value: Texture };
  readonly #stamps: Mesh;
  readonly #stampData: Float32Array;
  readonly #stampAttr: InstancedBufferAttribute;
  readonly #scene = new Scene();
  readonly #camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
  #count = 0;
  #placed = false;
  #frame = 0;

  constructor(size: number) {
    this.size = size;
    this.targets = [target(size), target(size)];
    this.#texel.value = 1 / size;

    // The pass: last frame's map, moved, spread, faded and dithered.
    const fade = this.#fade as unknown as Node<'vec4'>;
    const texel = this.#texel as unknown as Node<'float'>;
    const before = texture(this.targets[0].texture, uv());
    this.#before = before as unknown as { value: Texture };
    const material = new MeshBasicNodeMaterial();
    material.blending = NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.fragmentNode = Fn(() => {
      const at = uv().add(this.#shift);
      const tap = (dx: number, dy: number): Node<'float'> =>
        before.sample(at.add(vec2(dx, dy).mul(texel))).r as unknown as Node<'float'>;
      const here = tap(0, 0);
      const around = tap(1, 0).add(tap(-1, 0)).add(tap(0, 1)).add(tap(0, -1));
      const kept = here
        .mul(float(1).sub(fade.y.mul(4)))
        .add(around.mul(fade.y))
        .mul(fade.x);
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
        );
      // Up or down to a whole step of 8 bits, at random by the remainder.
      const noise = fract(
        sin(dot(floor(screenCoordinate.xy).add(fade.z), vec2(12.9898, 78.233))).mul(43758.5453),
      );
      // (A value already on a step stays on it.)
      const steps = floor(kept.mul(255).add(noise.mul(0.996)).add(0.002)).mul(1 / 255);
      return vec4(inside.select(steps, 0), 0, 0, 1);
    })() as unknown as Node<'vec4'>;
    this.#quad = new QuadMesh(material);

    // The stamps: a soft disc under each boat's stern, added to the map.
    const g = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(2, 2);
    g.setAttribute('position', plane.getAttribute('position'));
    g.setIndex(plane.getIndex());
    this.#stampData = new Float32Array(STAMPS * 4);
    this.#stampAttr = new InstancedBufferAttribute(this.#stampData, 4);
    this.#stampAttr.setUsage(DynamicDrawUsage);
    g.setAttribute('stamp', this.#stampAttr);
    g.instanceCount = 0;
    const stamp = attribute<'vec4'>('stamp', 'vec4');
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
    // The stamp's place in the map, east and north of its centre in half
    // squares; the camera looks down on the square with north up.
    sm.positionNode = vec3(
      stamp.x.add(positionGeometry.x.mul(stamp.z)),
      stamp.y.add(positionGeometry.y.mul(stamp.z)),
      -1,
    );
    const corner = varying(positionGeometry.xy);
    const strength = varying(stamp.w);
    sm.fragmentNode = Fn(() => {
      const r2 = dot(corner, corner);
      // A bell, nothing at the stamp's edge.
      const bell = float(1).sub(r2).max(0);
      const v = bell.mul(bell).mul(strength);
      return vec4(v, v, v, 1);
    })() as unknown as Node<'vec4'>;
    this.#stamps = new Mesh(g, sm);
    this.#stamps.frustumCulled = false;
    this.#scene.add(this.#stamps);
    this.#camera.position.set(0, 0, 0);
    this.#camera.updateMatrixWorld();
  }

  /** The map as the sea's material reads it: the foam at the scene point p (x, z), 0 to 1. */
  sample(p: Node<'vec2'>): Node<'float'> {
    const at = this.#origin.add(vec2(p.x, p.y.negate()).mul(1 / WAKE.span));
    const node = texture(this.targets[0].texture, at);
    this.#samplers.push(node as unknown as { value: Texture });
    return node.r as unknown as Node<'float'>;
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
   * A boat in the world, heading clockwise from north, sailing at speed
   * m/s, whose stern is `aft` metres behind its origin and whose hull is
   * 2 × halfBeam wide. It is stamped if it lies in the square.
   */
  add(
    east: number,
    north: number,
    heading: number,
    speed: number,
    aft: number,
    halfBeam: number,
  ): void {
    if (this.#count >= STAMPS || !(speed > 0)) {
      return;
    }
    const at = this.#count * 4;
    this.#stampData[at] = east - Math.sin(heading) * aft;
    this.#stampData[at + 1] = north - Math.cos(heading) * aft;
    this.#stampData[at + 2] = halfBeam;
    this.#stampData[at + 3] = speed;
    this.#count++;
  }

  /** Brings the map to a frame: the pass, then the stamps. */
  update(renderer: WebGPURenderer, f: FoamFrame): void {
    const texel = WAKE.span / this.size;
    const east = Math.round(f.boatEast / texel) * texel;
    const north = Math.round(f.boatNorth / texel) * texel;
    const fresh = !this.#placed;
    const de = fresh ? 0 : east - this.centre.east;
    const dn = fresh ? 0 : north - this.centre.north;
    this.centre.east = east;
    this.centre.north = north;
    this.#origin.value.set(
      (f.originEast - east) / WAKE.span + 0.5,
      (f.originNorth - north) / WAKE.span + 0.5,
    );
    const moving = f.dt > 0;
    if (!fresh && !moving && de === 0 && dn === 0) {
      // Time stands still and so does the square: the map is as it was.
      return;
    }
    this.#placed = true;
    this.#frame = (this.#frame + 1) % 1024;
    this.#shift.value.set(de / WAKE.span, dn / WAKE.span);
    this.#fade.value.set(
      // A map just made or resized starts clear.
      fresh ? 0 : moving ? Math.exp(-f.dt / WAKE.decay) : 1,
      moving ? Math.min((WAKE.spread * f.dt) / (texel * texel), 0.2) : 0,
      this.#frame,
      0,
    );
    const from = this.targets[this.current] as RenderTarget;
    const into = this.targets[1 - this.current] as RenderTarget;
    this.#before.value = from.texture;

    // Each stamp in the square's own coordinates, and as strong as lays a
    // full wake along the track whatever the frame rate: the distance sailed
    // this frame over the stamp's width.
    const half = WAKE.span / 2;
    const data = this.#stampData;
    let n = 0;
    for (let i = 0; i < this.#count; i++) {
      const x = ((data[i * 4] as number) - east) / half;
      const y = ((data[i * 4 + 1] as number) - north) / half;
      const speed = data[i * 4 + 3] as number;
      const radius = Math.max(STAMP_BEAMS * (data[i * 4 + 2] as number), 1.5 * texel);
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || !moving) {
        continue;
      }
      const laid = Math.min(speed / WAKE.fullSpeed, 1) * Math.min((speed * f.dt) / radius, 1);
      data[n * 4] = x;
      data[n * 4 + 1] = y;
      data[n * 4 + 2] = radius / half;
      data[n * 4 + 3] = laid;
      n++;
    }
    (this.#stamps.geometry as InstancedBufferGeometry).instanceCount = n;
    this.#stampAttr.needsUpdate = true;

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

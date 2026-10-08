// SPDX-License-Identifier: AGPL-3.0-only

// The beginners' overlays, each switched on in the menu. They teach without
// making the physics easier.
//
//   Wind: an arrow on the water a few metres upwind of the boat for the true
//   wind, and a slimmer, fletched arrow above the masthead for the apparent
//   wind, the wind the moving boat feels.
//   Sail forces: arrows at the sail's centre of effort for the drive (ahead)
//   and the side force (across); the screen adds a clinometer for the heel.
//
// Each arrow has its own shape and a label, never colour alone. Their
// lengths are in proportion to the wind's speed or the force. They are
// meshes from the material factory, with the dome's bend, and their labels
// are page elements placed over the scene each frame.

import { BoxGeometry, type Camera, ConeGeometry, Group, Mesh, Vector3 } from 'three';
import type { Boat as BoatKind } from '../catalog';
import type { Wind } from '../game/driver';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import { headingToRotationY } from './coords';
import { basicMaterial } from './materials';

/** Metres of arrow per m/s of wind, and per newton of force (starting scales). */
export const WIND_SCALE = 0.45;
export const FORCE_SCALE = 0.012;
/** The true wind's arrow lies this far upwind of the boat, in metres. */
export const UPWIND = 7;
/** No arrow is drawn shorter than this, or longer than MAX_LENGTH, in metres. */
const MIN_LENGTH = 0.05;
const MAX_LENGTH = 9;

export type ArrowShape = 'broad' | 'fletched' | 'pointed' | 'blunt';

/**
 * An arrow along its local −z (as a boat's bow points), its tail at its
 * origin. Its length is set by stretching the shaft and moving the head.
 */
export class Arrow {
  readonly group = new Group();
  readonly #shaft: Mesh;
  readonly #head: Mesh;
  length = 1;

  constructor(name: string, shape: ArrowShape, colour: number) {
    this.group.name = name;
    const wide = shape === 'broad' ? 0.3 : shape === 'fletched' ? 0.07 : 0.12;
    const shaft = new BoxGeometry(wide, wide * 0.4, 1);
    shaft.translate(0, 0, -0.5);
    const m = basicMaterial({ color: colour });
    m.name = `${name} arrow`;
    this.#shaft = new Mesh(shaft, m);
    let head: ConeGeometry | BoxGeometry;
    if (shape === 'blunt') {
      // A bar across the tip: the side force pushes.
      head = new BoxGeometry(0.5, 0.12, 0.12);
    } else {
      head = new ConeGeometry(shape === 'broad' ? 0.55 : 0.25, shape === 'broad' ? 0.9 : 0.45, 12);
      head.rotateX(-Math.PI / 2);
      head.translate(0, 0, shape === 'broad' ? -0.45 : -0.22);
    }
    this.#head = new Mesh(head, m);
    this.group.add(this.#shaft, this.#head);
    if (shape === 'fletched') {
      // Feathers at the tail, so the apparent wind's arrow reads apart from the true wind's.
      const f = new BoxGeometry(0.5, 0.03, 0.3);
      f.translate(0, 0, -0.15);
      this.group.add(new Mesh(f, m));
    }
    this.setLength(1);
  }

  setLength(l: number): void {
    const len = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, l));
    this.length = len;
    this.#shaft.scale.z = len;
    this.#head.position.z = -len;
  }
}

/** The arrow's turn about the vertical for a direction of travel, radians clockwise from north (or off the bow). */
export function arrowRotation(toward: number): number {
  return headingToRotationY(toward);
}

/** Where the true wind blows toward, radians clockwise from north. */
export function windToward(from: number): number {
  return from + Math.PI;
}

interface Label {
  el: HTMLElement;
  arrow: Arrow;
}

export class Overlays {
  /** In the scene, placed upwind of the boat each frame. */
  readonly world = new Group();
  /** Rides with the heeled boat. */
  readonly onBoat = new Group();
  readonly trueWind = new Arrow('true wind', 'broad', 0xf2f4f5);
  readonly apparentWind = new Arrow('apparent wind', 'fletched', 0xf3c969);
  readonly drive = new Arrow('drive', 'pointed', 0x5fd38a);
  readonly side = new Arrow('side force', 'blunt', 0xe9837a);
  wind = false;
  forces = false;

  readonly #labels: Label[] = [];
  readonly #v = new Vector3();
  readonly #masthead: number;
  readonly #mastZ: number;
  readonly #effort: number;
  readonly #foot: number;

  constructor(kind: BoatKind) {
    const { rig } = kind.physics;
    this.#masthead = rig.boomHeight + rig.luff;
    this.#mastZ = -rig.mastPosition;
    this.#effort = rig.boomHeight + 0.5 * (rig.footStrip + rig.headStrip) * rig.luff;
    this.#foot = rig.foot;
    this.world.name = 'overlays';
    this.onBoat.name = 'overlays on the boat';
    this.world.add(this.trueWind.group);
    this.onBoat.add(this.apparentWind.group, this.drive.group, this.side.group);
    this.#show();
  }

  /** Puts the labels in a layer of the page over the scene; null takes them out. */
  attachLabels(layer: HTMLElement | null): void {
    if (this.#labels.length === 0) {
      const add = (text: string, arrow: Arrow): void => {
        const el = document.createElement('span');
        el.className = 'overlay-label';
        el.textContent = text;
        this.#labels.push({ el, arrow });
      };
      add('True wind', this.trueWind);
      add('Apparent wind', this.apparentWind);
      add('Drive', this.drive);
      add('Side force', this.side);
    }
    for (const l of this.#labels) {
      if (layer === null) {
        l.el.remove();
      } else if (l.el.parentElement !== layer) {
        layer.append(l.el);
      }
    }
    this.#show();
  }

  set(wind: boolean, forces: boolean): void {
    this.wind = wind;
    this.forces = forces;
    this.#show();
  }

  /**
   * Places the arrows for the boat at scene point (x, z) in its pose, the
   * true wind and the latest step's Out. onBoat must be a child of the
   * boat's heeled model frame.
   */
  update(x: number, z: number, pose: BoatPose, wind: Wind, out: Float64Array): void {
    if (this.wind) {
      const toward = windToward(wind.from);
      const t = this.trueWind.group;
      // Upwind of the boat, its tip toward the boat.
      const len = wind.speed * WIND_SCALE;
      t.position.set(
        x + Math.sin(wind.from) * (UPWIND + len),
        0.25,
        z - Math.cos(wind.from) * (UPWIND + len),
      );
      t.rotation.set(0, arrowRotation(toward), 0);
      this.trueWind.setLength(len);

      const aws = out[RECORDS.out.apparentWindSpeed] ?? 0;
      const awa = out[RECORDS.out.apparentWindAngle] ?? 0;
      const alen = aws * WIND_SCALE;
      const a = this.apparentWind.group;
      // Centred over the masthead, blowing the way the wind across the boat blows.
      const along = windToward(awa);
      a.position.set(
        (-Math.sin(along) * alen) / 2,
        this.#masthead + 0.9,
        this.#mastZ + (Math.cos(along) * alen) / 2,
      );
      a.rotation.set(0, arrowRotation(along), 0);
      this.apparentWind.setLength(alen);
    }
    if (this.forces) {
      // The centre of effort, out along the boom with the sail.
      const ce = 0.35 * this.#foot;
      const cx = Math.sin(pose.boom) * ce;
      const cz = this.#mastZ + Math.cos(pose.boom) * ce;
      const drive = out[RECORDS.out.drive] ?? 0;
      const side = out[RECORDS.out.sideForce] ?? 0;
      const d = this.drive.group;
      d.position.set(cx, this.#effort, cz);
      d.rotation.set(0, drive >= 0 ? 0 : Math.PI, 0);
      this.drive.setLength(Math.abs(drive) * FORCE_SCALE);
      const s = this.side.group;
      s.position.set(cx, this.#effort, cz);
      // Ahead is −z; to starboard (+x) is a quarter turn clockwise.
      s.rotation.set(0, arrowRotation(side >= 0 ? Math.PI / 2 : -Math.PI / 2), 0);
      this.side.setLength(Math.abs(side) * FORCE_SCALE);
    }
  }

  /** Puts each shown label over the middle of its arrow, on a page of this size. */
  placeLabels(camera: Camera, width: number, height: number): void {
    for (const l of this.#labels) {
      if (l.el.hidden) {
        continue;
      }
      const v = this.#v.set(0, 0, -0.5 * l.arrow.length);
      l.arrow.group.localToWorld(v);
      v.project(camera);
      const off = v.z > 1 || v.z < -1;
      l.el.style.display = off ? 'none' : '';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px)`;
    }
  }

  #show(): void {
    this.trueWind.group.visible = this.wind;
    this.apparentWind.group.visible = this.wind;
    this.drive.group.visible = this.forces;
    this.side.group.visible = this.forces;
    for (const l of this.#labels) {
      l.el.hidden = !l.arrow.group.visible;
    }
  }
}

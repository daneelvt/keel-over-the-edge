// SPDX-License-Identifier: AGPL-3.0-only

// Every kind of two hulls' people (a beach cat's), posed from the committed
// files as the game poses them: the helm by the sailor's runtime on her own
// clips, the crew by the crew's rules and bodies. Nothing through anything
// (her hulls, beams, net, mast, boom, mainsheet and wires) and nobody
// through anybody: sat on her windward hull and out on the wire on both
// tacks, the boom anywhere it lies; across her net in a tack and a gybe, in
// their order, each way across; changing places at a handover; and in the
// water, righting her and climbing back after a capsize.

import { readFileSync } from 'node:fs';
import { type AnimationClip, Matrix3, Matrix4, Mesh, type Object3D, Texture, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { CLIMBING, IN_WATER, ON_BOARD, SAILING } from '../sailor';
import { catClips, catFloor } from './cat';
import { Clip } from './clips';
import { modelDeck, tillerOf } from './crew';
import { CrewBody, stance } from './crewbody';
import type { PoseInput } from './crewpose';
import { poseMember } from './crewpose';
import {
  type CrewMember,
  CrewRules,
  crewPlan,
  duckFor,
  duckStep,
  type SailorNow,
} from './crewrules';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames, catOf } from './onboat';
import { railClips } from './rail';
import { seating } from './restage';
import { Rig } from './rig';
import { type SailorBoat, type SailorMoment, SailorRuntime } from './runtime';
import { hullSolid, inside } from './solid';
import { trapezeClips, trapezeOf } from './trapeze';

const ART = new URL('../../../../art/', import.meta.url);
(globalThis as { self?: unknown }).self ??= globalThis;

async function load(path: string): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buf = readFileSync(new URL(path, ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const blank = {
    load: (_url: string, onLoad: (t: Texture) => void) => onLoad(new Texture()),
    detectSupport: () => blank,
  };
  loader.setKTX2Loader(blank as unknown as KTX2Loader);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return loader.parseAsync(ab, '');
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

const DEG = Math.PI / 180;
/** The body's capsules: a bone to the next down its chain, and a radius. */
const CAPSULES: [string, string, number][] = [
  ['pelvis', 'spine_02', 0.08],
  ['spine_02', 'neck_01', 0.09],
  ['neck_01', 'head', 0.05],
  ['upperarm_l', 'lowerarm_l', 0.04],
  ['lowerarm_l', 'hand_l', 0.035],
  ['upperarm_r', 'lowerarm_r', 0.04],
  ['lowerarm_r', 'hand_r', 0.035],
  ['thigh_l', 'calf_l', 0.055],
  ['calf_l', 'foot_l', 0.045],
  ['foot_l', 'ball_l', 0.02],
  ['thigh_r', 'calf_r', 0.055],
  ['calf_r', 'foot_r', 0.045],
  ['foot_r', 'ball_r', 0.02],
];
/** The head, a ball this far over its joint up the neck, of this radius. */
const HEAD_UP = 0.1;
const HEAD_R = 0.11;

/** The nearest two segments come, a–b and c–d. */
function segments(a: Vector3, b: Vector3, c: Vector3, d: Vector3): number {
  const u = new Vector3().subVectors(b, a);
  const v = new Vector3().subVectors(d, c);
  const w = new Vector3().subVectors(a, c);
  const aa = u.dot(u);
  const bb = u.dot(v);
  const cc = v.dot(v);
  const dd = u.dot(w);
  const ee = v.dot(w);
  const den = aa * cc - bb * bb;
  let s = den > 1e-12 ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / den)) : 0;
  let t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  s = aa > 1e-12 ? Math.max(0, Math.min(1, (bb * t - dd) / aa)) : 0;
  t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  return new Vector3()
    .copy(a)
    .addScaledVector(u, s)
    .sub(new Vector3().copy(c).addScaledVector(v, t))
    .length();
}

/** A posed person as capsules in the boat's model: each bone's line and radius, and the head's ball. */
type Caps = [Vector3, Vector3, number, string][];

function capsOf(rig: Rig, root: Matrix4): Caps {
  const pos = (bone: string): Vector3 =>
    rig.position(rig.bone(bone), new Vector3()).applyMatrix4(root);
  const out: Caps = CAPSULES.map(([f, t, r]) => [pos(f), pos(t), r, f]);
  const neck = pos('neck_01');
  const head = pos('head');
  const centre = head.clone().addScaledVector(head.clone().sub(neck).normalize(), HEAD_UP);
  out.push([centre, centre, HEAD_R, 'head']);
  return out;
}

/** How near two people come, beyond their radii: negative, through each other. */
function apart(a: Caps, b: Caps): number {
  let least = Number.POSITIVE_INFINITY;
  for (const [p, q, r, n] of a) {
    for (const [s, t, u, o] of b) {
      const d = segments(p, q, s, t) - r - u;
      if (d < least) {
        least = d;
        apartParts = `${n} at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} and ${o} at ${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}`;
      }
    }
  }
  return least;
}

/** The parts the last apart() found nearest. */
let apartParts = '';

const kinds = catalog.boats.filter((b) => b.physics.hulls.hullSpacing > 0);

/**
 * How long after the boom comes over the centreline its mainsheet sweeps
 * across the boat, s: in a gybe its tackle swings over the helm's legs as
 * they get up to cross (not checked, but measured).
 */
const SWEEP = 0.6;

/** The looks posed: a woman's and the male machine, the tallest. */
const LOOKS = [
  {
    art: catalog.sailors.find((s) => s.id === 'rover')?.versions.find((v) => v.id === 'female')
      ?.art,
    machine: false,
  },
  { art: catalog.machine.versions.find((v) => v.id === 'male')?.art, machine: true },
];

describe.each(kinds.map((k) => [k.name, k] as const))('aboard the %s', (_, kind) => {
  const boat = load(kind.art.model);
  const looks = Promise.all(
    LOOKS.map(async ({ art, machine }) => {
      if (art === undefined) {
        throw new Error('no look');
      }
      const [deck, clipsFile, railFile, catFile, wireFile] = await Promise.all([
        load(art.model),
        load(art.clips),
        load(railClips(art.clips)),
        load(catClips(art.clips)),
        load(trapezeClips(art.clips)),
      ]);
      const rig = Rig.from(deck.scene, boneNames(deck.scene));
      const look = new FleetLook(0, art, machine);
      deck.scene.updateMatrixWorld(true);
      look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
      const clips = new Map<string, Clip>();
      for (const file of [clipsFile, railFile, catFile, wireFile]) {
        const places = placesOf(file.scene);
        for (const a of file.animations) {
          const place = places.get(`place-${a.name}`) ?? null;
          clips.set(
            a.name,
            Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
          );
        }
      }
      look.clips = clips;
      return { look, rig, clips, machine };
    }),
  );

  /** Her model's parts by name, her crew's plan and her sailor's boat, as the game makes them. */
  async function setUp() {
    const g = await boat;
    g.scene.updateMatrixWorld(true);
    const parts = new Map<string, Object3D>();
    g.scene.traverse((o) => {
      if (o.name !== '') {
        parts.set(o.name, o);
      }
    });
    const at = (n: string): Vector3 => (parts.get(n) as Object3D).getWorldPosition(new Vector3());
    const solid = hullSolid(parts.get('hull')?.userData, at('board-root'), {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    if (solid === null) {
      throw new Error('no solid');
    }
    const plan = crewPlan(
      kind.stations,
      solid,
      at('boom'),
      kind.physics.rig.foot,
      modelDeck(g.scene),
      tillerOf(g.scene),
    );
    plan.cat = catOf(g.scene, parts, kind.physics.rig.foot);
    plan.cog = kind.physics.hull.centreOfGravity;
    const cat = plan.cat;
    if (cat === null) {
      throw new Error('no places aboard');
    }
    const hinge = at('extension');
    const sailorBoat: SailorBoat = {
      hinge: hinge.clone(),
      hingeRest: hinge.clone(),
      extension: hinge.distanceTo(at('grip')),
      seatY: at('gunwale').y,
      seatIn: solid.cockpit.halfWidth,
      seatOut: at('gunwale').x,
      seatZ: at('sailor').z,
      cog: kind.physics.hull.centreOfGravity,
      solid,
      climbTime: kind.physics.sailor.climbTime,
      ...seating(parts, kind.physics.sailor.hikeReach),
      trapeze: trapezeOf(parts, kind.physics.sailor.hikeReach),
      cat,
    };
    return { plan, cat, solid, sailorBoat, parts, at };
  }

  /**
   * What a posed person passes through of her, by a bone's line's
   * capsule: her hulls (the platform's solid, open between them above the
   * net), her net (from above), her beams, mast, boom, mainsheet and
   * wires. The feet may stand on what they stand on.
   */
  async function obstacles() {
    const { plan, cat, solid, at } = await setUp();
    const net = cat.aboard.net;
    const front = net.fore - 0.06;
    const rear = net.aft + 0.06;
    const beamY = net.y + 0.045;
    const block = at('sheet');
    const boomEnd = (boom: number): [Vector3, Vector3] => [
      new Vector3(0, plan.boom.y, plan.boom.z),
      new Vector3(
        plan.boom.length * Math.sin(boom),
        plan.boom.y,
        plan.boom.z + plan.boom.length * Math.cos(boom),
      ),
    ];
    const t = trapezeOf((await setUp()).parts, kind.physics.sailor.hikeReach);
    const wires: [Vector3, Vector3][] =
      t === null
        ? []
        : [
            [t.hounds, t.rings[0]],
            [t.hounds, t.rings[1]],
            ...(t.crewRings === null
              ? []
              : t.crewRings.map((r): [Vector3, Vector3] => [t.hounds, r])),
          ];
    /** What a set of capsules passes through, the boom at boom (radians); hooked, the wires on the side someone hangs from are theirs. */
    const through = (caps: Caps, boom: number, hooked: number[] = [], sweep = false): string[] => {
      const bad: string[] = [];
      const [g, e] = boomEnd(boom);
      // The mainsheet from under the boom's end to its block on the rear beam.
      const sheetTop = new Vector3(
        e.x * 0.97,
        plan.boom.y - 0.07,
        plan.boom.z + (e.z - plan.boom.z) * 0.97,
      );
      for (const [a, b, r, name] of caps) {
        const feet = name.startsWith('foot') || name.startsWith('calf');
        for (let k = 0; k <= 4; k++) {
          const c = new Vector3().lerpVectors(a, b, k / 4);
          if (
            inside(solid, c.x, feet ? c.y + 0.02 : c.y, c.z) &&
            Math.abs(c.x) > solid.cockpit.halfWidth + 0.01
          ) {
            bad.push(
              `${name} in a hull at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`,
            );
            break;
          }
          if (
            Math.abs(c.x) < solid.cockpit.halfWidth &&
            c.z > net.fore &&
            c.z < net.aft &&
            c.y < net.y - (feet ? 0.03 : 0.0) &&
            c.y > net.y - 0.3
          ) {
            bad.push(
              `${name} through the net at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`,
            );
            break;
          }
        }
        for (const z of [front, rear]) {
          const d = segments(a, b, new Vector3(-1.15, beamY, z), new Vector3(1.15, beamY, z));
          if (d < r + 0.045 - (feet ? 0.03 : 0)) {
            bad.push(
              `${name} through the ${z === front ? 'front' : 'rear'} beam (${(d - r).toFixed(3)})`,
            );
          }
        }
        if (
          segments(a, b, new Vector3(0, net.y, plan.mastZ), new Vector3(0, 6, plan.mastZ)) <
          r + 0.06
        ) {
          bad.push(`${name} through the mast`);
        }
        const bd = segments(a, b, g, e) - r - 0.034;
        if (bd < 0) {
          bad.push(`${name} through the boom at ${(boom / DEG).toFixed(0)}° (${bd.toFixed(3)})`);
        }
        if (!sweep && segments(a, b, sheetTop, block) < r + 0.01) {
          bad.push(`${name} through the mainsheet at ${(boom / DEG).toFixed(0)}°`);
        }
        wires.forEach(([p, q], k) => {
          const side = q.x > 0 ? 1 : -1;
          if (hooked.includes(side * (k + 1))) {
            return;
          }
          if (segments(a, b, p, q) < r + 0.005) {
            bad.push(`${name} through a wire ${k} to ${q.x.toFixed(2)}`);
          }
        });
      }
      return bad;
    };
    return { through };
  }

  /** A helm, posed by the sailor's runtime, for a look. */
  function helmOf(l: Awaited<typeof looks>[number], sailorBoat: SailorBoat, seed: number) {
    const rig = new Rig(l.rig.names, l.rig.parent, l.rig.restPos, l.rig.restQuat);
    rig.base.copy(l.rig.base);
    const rt = new SailorRuntime(rig, l.clips, sailorBoat, seed, l.machine, false);
    const mo: SailorMoment = {
      dt: 1 / 30,
      time: 0,
      offset: 0,
      mode: SAILING,
      timer: 0,
      heel: 0,
      pitch: 0,
      heave: 0,
      windSpeed: 5,
      windAngle: 0.8,
      rollRate: 0,
      still: false,
      boom: 0,
      trim: 0,
    };
    return { rig, rt, mo, caps: () => capsOf(rig, rt.root) };
  }

  /** A crew's body and what posing them needs, for a look. */
  function crewOf(
    l: Awaited<typeof looks>[number],
    plan: ReturnType<typeof crewPlan>,
    seed: number,
  ) {
    const body = new CrewBody(l.look.deck as NonNullable<typeof l.look.deck>, seed, l.machine);
    const inp: PoseInput = {
      stations: kind.stations,
      seat: { out: 0.7, y: 0.3, z: 0.4 },
      clips: l.clips,
      time: 0,
      duck: 0,
      life: {
        dt: 1 / 30,
        heel: 0,
        upright: 0.5,
        still: false,
        floor: plan.cat == null ? null : catFloor(plan.cat),
      },
      a: stance(),
      b: stance(),
      cat: plan.cat ?? null,
      aft: 0,
      level: { heel: 0, pitch: 0, heave: 0, cog: plan.cog ?? 0, solid: plan.solid ?? null },
    };
    return { body, inp, caps: () => capsOf(body.rig, body.root) };
  }

  test('her crew’s station on a hull’s top, to windward; the helm’s sat on the same hull, aft', () => {
    const [helm, crew] = kind.stations;
    expect(helm?.pose).toBe('seated');
    expect(crew?.pose).toBe('hull');
    expect(crew?.windward).toBe(true);
    expect(Math.sign(crew?.at[0] ?? 0)).toBe(Math.sign(helm?.at[0] ?? 0));
    expect(crew?.at[2] ?? 0).toBeLessThan(helm?.at[2] ?? 0);
  });

  test('sat on her windward hull and out on the wire, both tacks, the boom anywhere to leeward: nothing through anything, nobody through anybody', async () => {
    const { plan, sailorBoat } = await setUp();
    const { through } = await obstacles();
    const ls = await looks;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    const [woman, machine] = ls as [(typeof ls)[0], (typeof ls)[0]];
    for (const [hl, cl] of [
      [woman, machine],
      [machine, woman],
    ] as const) {
      const helm = helmOf(hl, sailorBoat, 3);
      const crew = crewOf(cl, plan, 5);
      for (const side of [1, -1]) {
        // Sat in, sitting out, and on the wire; the crew sat up, and out on the wire with the helm.
        for (const [offset, lean] of [
          [0.6, 0],
          [1.15, 0],
          [2.16, 1],
        ] as const) {
          for (const t of [0, 3.3, 6.6]) {
            helm.rt.reset();
            helm.mo.offset = side * offset;
            helm.mo.time = t;
            for (let k = 0; k < 40; k++) {
              helm.rt.update(helm.mo);
            }
            const m: CrewMember = {
              seat: 1,
              look: 0,
              station: 1,
              side,
              lean,
              leanTo: lean,
              moving: null,
            };
            crew.inp.time = t;
            poseMember(crew.body, m, crew.inp);
            const hc = helm.caps();
            const cc = crew.caps();
            least = Math.min(least, apart(hc, cc));
            if (apart(hc, cc) < 0) {
              bad.push(
                `${side} ${offset} ${t}: the two ${apart(hc, cc).toFixed(3)} through each other`,
              );
            }
            for (let a = 0; a <= kind.physics.rig.boomOut * DEG + 1e-6; a += 10 * DEG) {
              const boom = -side * a;
              for (const [who, caps] of [
                ['helm', hc],
                ['crew', cc],
              ] as const) {
                for (const b of through(
                  caps,
                  boom,
                  lean > 0 ? [side * 3, side * 1] : offset > 2 ? [side * 1] : [],
                )) {
                  bad.push(`${who} ${side} ${offset} ${t}: ${b}`);
                }
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(least).toBeGreaterThan(0);
  });

  /**
   * Sails two aboard under the rules and the helm's runtime for seconds,
   * as script gives the boat at each moment, posing both ten times a
   * second: what either passes through, and how near they come.
   */
  async function sail(
    seconds: number,
    script: (t: number) => {
      boom: number;
      windOffBow: number;
      offset: number;
      mode?: number;
      heel?: number;
      trim?: number;
    },
    holder = 1,
    swap: number | null = null,
  ) {
    const { plan, sailorBoat } = await setUp();
    const { through } = await obstacles();
    const ls = await looks;
    const rules = new CrewRules(plan);
    rules.set(
      {
        people: [
          { seat: 0, look: 0 },
          { seat: 1, look: 1 },
        ],
        holder,
      },
      false,
    );
    const helms = [
      helmOf(ls[0] as Awaited<typeof looks>[number], sailorBoat, 2),
      helmOf(ls[1] as Awaited<typeof looks>[number], sailorBoat, 7),
    ];
    const crews = [
      crewOf(ls[0] as Awaited<typeof looks>[number], plan, 3),
      crewOf(ls[1] as Awaited<typeof looks>[number], plan, 9),
    ];
    // Each one's duck, as the crew's drawing has it: down as the boom comes near the head.
    const ducks = [0, 0];
    let lastBoom = script(0).boom;
    /** When the boom last came over the centreline: its sheet sweeps across the boat for SWEEP after. */
    let swept = Number.NEGATIVE_INFINITY;
    const dt = 1 / 30;
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    let leastAt = '';
    const seen = {
      wet: new Set<string>(),
      held: false,
      helmNet: false,
      /** When the crew and the helm first set off across the net, and how many changed places. */
      crewGoes: Number.POSITIVE_INFINITY,
      helmGoes: Number.POSITIVE_INFINITY,
      changed: new Set<number>(),
      /** The longest either took across, rising to sitting, s. */
      across: 0,
    };
    const began = new Map<string, number>();
    const sn: SailorNow = { mode: SAILING, heel: 0, trim: 0, offset: 0, net: null };
    for (let k = 0; k * dt <= seconds; k++) {
      const t = k * dt;
      if (swap !== null && Math.abs(t - swap) < dt / 2) {
        holder = 1 - holder;
        rules.set({
          people: [
            { seat: 0, look: 0 },
            { seat: 1, look: 1 },
          ],
          holder,
        });
      }
      const now = script(t);
      const helm = helms[holder] as (typeof helms)[number];
      helm.mo.offset = now.offset;
      helm.mo.boom = now.boom;
      helm.mo.mode = now.mode ?? SAILING;
      helm.mo.heel = now.heel ?? 0;
      helm.mo.trim = now.trim ?? 0;
      helm.mo.time = t;
      helm.mo.wayHeld = rules.helmHeld;
      seen.held ||= rules.helmHeld;
      helm.rt.update(helm.mo);
      seen.helmNet ||= helm.rt.netAt !== null;
      if (helm.rt.netAt !== null) {
        seen.helmGoes = Math.min(seen.helmGoes, t);
        began.set('helm', began.get('helm') ?? t);
      } else if (began.has('helm')) {
        seen.across = Math.max(seen.across, t - (began.get('helm') as number));
        began.delete('helm');
      }
      sn.mode = now.mode ?? SAILING;
      sn.heel = now.heel ?? 0;
      sn.trim = now.trim ?? 0;
      sn.offset = now.offset;
      sn.net = helm.rt.netAt;
      rules.step({
        dt,
        boom: now.boom,
        windOffBow: now.windOffBow,
        depth: helm.rt.depth,
        sailor: sn,
      });
      for (const m of rules.members) {
        if (m.moving?.net != null) {
          seen.crewGoes = Math.min(seen.crewGoes, t);
          began.set('crew', began.get('crew') ?? t);
        } else if (m.station > 0 && began.has('crew')) {
          seen.across = Math.max(seen.across, t - (began.get('crew') as number));
          began.delete('crew');
        }
        if (m.moving?.kind === 'change') {
          seen.changed.add(m.seat);
        }
        if (m.wet) {
          seen.wet.add(m.wet.phase);
        }
      }
      if (k % 3 !== 0) {
        continue;
      }
      const people: { who: string; caps: Caps }[] = [];
      if (!rules.helmAway) {
        people.push({
          who: `helm (${helm.rt.netAt === null ? 'sat' : 'crossing'})`,
          caps: helm.caps(),
        });
      }
      for (const m of rules.members) {
        if (m.station <= 0 && m.moving === null) {
          continue;
        }
        const c = crews[m.seat] as (typeof crews)[number];
        c.inp.time = t;
        const rate = (now.boom - lastBoom) / (3 * dt);
        ducks[m.seat] = duckStep(
          ducks[m.seat] ?? 0,
          duckFor(plan, now.boom, rate, c.body.headUp),
          3 * dt,
        );
        c.inp.duck = ducks[m.seat] ?? 0;
        c.inp.level = {
          heel: now.heel ?? 0,
          pitch: 0,
          heave: 0,
          cog: plan.cog ?? 0,
          solid: plan.solid ?? null,
        };
        poseMember(c.body, m, c.inp);
        const what = m.wet
          ? m.wet.phase
          : m.moving?.net != null
            ? 'crossing'
            : (m.moving?.kind ?? 'sat');
        people.push({ who: `crew (${what})`, caps: c.caps() });
      }
      if (Math.sign(now.boom) !== Math.sign(lastBoom) && lastBoom !== 0) {
        swept = t;
      }
      lastBoom = now.boom;
      const mode = now.mode ?? SAILING;
      for (const p of people) {
        if (mode !== SAILING && !p.who.includes('sat') && !p.who.includes('crossing')) {
          continue;
        }
        if (mode === SAILING) {
          for (const b of through(p.caps, now.boom, [1, -1, 3, -3], t - swept < SWEEP)) {
            bad.push(`${t.toFixed(1)} ${p.who}: ${b}`);
          }
        }
      }
      if (people.length === 2) {
        const d = apart(
          (people[0] as (typeof people)[0]).caps,
          (people[1] as (typeof people)[0]).caps,
        );
        if (d < least) {
          least = d;
          leastAt = `${t.toFixed(1)} ${people.map((p) => p.who).join(' and ')}: ${apartParts}`;
        }
      }
    }
    return { bad, least, leastAt, seen };
  }

  /** A tack from close-hauled on starboard (the wind over starboard, the helm and crew there) to port, over about 4 s. */
  const tack = (t: number) => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 4));
    const off = 45 * DEG - turn * 90 * DEG;
    const boom = off > 0 ? -Math.min(0.25, off * 0.6) : Math.min(0.25, -off * 0.6);
    // The helm's offset follows the boom over, a second behind.
    const over = Math.max(0, Math.min(1, (t - 4) / 1.5));
    return { boom, windOffBow: off, offset: 0.9 - 1.8 * over };
  };
  /** A gybe from a broad reach on port (the wind over port, the boom to starboard) to starboard. */
  const gybe = (t: number) => {
    const turn = Math.max(0, Math.min(1, (t - 1) / 3));
    const off = -(140 * DEG + turn * 80 * DEG);
    const wrapped = Math.atan2(Math.sin(off), Math.cos(off));
    const boom = t < 2.5 ? 1.2 : t < 3 ? 1.2 - (t - 2.5) * 4.8 : -1.2;
    const over = Math.max(0, Math.min(1, (t - 3.5) / 1.5));
    return { boom, windOffBow: wrapped, offset: -0.9 + 1.8 * over };
  };

  test('through a tack: the crew first as the wind comes ahead, the helm once they are clear; across her net, nothing through anything, nobody through anybody', async () => {
    const r = await sail(14, tack);
    expect(r.seen.held).toBe(true);
    expect(r.seen.crewGoes).toBeLessThan(r.seen.helmGoes);
    expect(r.seen.helmGoes).toBeLessThan(10);
    expect(r.seen.across).toBeLessThan(5);
    expect(r.bad).toEqual([]);
    expect(r.least).toBeGreaterThan(0);
  });

  test('through a gybe: the helm first, the crew following; across her net, nothing through anything, nobody through anybody', async () => {
    const r = await sail(14, gybe);
    expect(r.seen.helmGoes).toBeLessThan(r.seen.crewGoes);
    expect(r.seen.crewGoes).toBeLessThan(10);
    expect(r.seen.across).toBeLessThan(5);
    expect(r.bad).toEqual([]);
    expect(r.least).toBeGreaterThan(0);
  });

  test('a handover: the two pass along her windward hull, one on its top and one on the net beside it, apart', async () => {
    const r = await sail(10, () => ({ boom: -0.3, windOffBow: 0.8, offset: 0.7 }), 1, 1);
    expect([...r.seen.changed].sort()).toEqual([0, 1]);
    expect(r.bad).toEqual([]);
    expect(r.least).toBeGreaterThan(0);
  });

  test('a capsize: both in the water apart, up on her lower hull beside each other righting her, and back aboard', async () => {
    const r = await sail(16, (t) => {
      const mode =
        t < 1 ? SAILING : t < 6 ? IN_WATER : t < 11 ? ON_BOARD : t < 13 ? CLIMBING : SAILING;
      const heel = t < 1 ? 0.2 : t < 9 ? 1.45 : t < 13 ? 1.45 - (t - 9) * 0.35 : 0.05;
      return { boom: -0.3, windOffBow: 0.8, offset: mode === SAILING ? 0.7 : 0, mode, heel };
    });
    expect([...r.seen.wet].sort()).toEqual(['board', 'climb', 'water']);
    expect(r.least).toBeGreaterThan(0);
  });
});

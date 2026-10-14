// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { pilotText } from '../ui/format';
import { HelmInput } from './helm';
import { KeyInput, PILOT_BIG_STEP, PILOT_STEP } from './keys';
import {
  angleOf,
  PILOT_HEADING,
  PILOT_OFF,
  PILOT_WIND,
  type PilotActions,
  PilotInput,
  stepsOf,
  TURN_STEPS,
  WAY_GYBE,
  WAY_HOLD,
  WAY_TACK,
  wrapAngle,
} from './pilot';
import { SheetInput } from './sheet';

const DEG = Math.PI / 180;
/** One step of a target, radians. */
const STEP = (2 * Math.PI) / TURN_STEPS;

function closeTo(a: number, b: number): boolean {
  return Math.abs(wrapAngle(a - b)) <= STEP;
}

describe('the autopilot’s control', () => {
  test('engaging holds the boat’s angle to the mean wind, on its tack', () => {
    const p = new PilotInput();
    // Heading 300° in a mean wind from 345°: 45° off it, over starboard.
    p.engage(PILOT_WIND, 300 * DEG, 345 * DEG);
    expect(p.mode).toBe(PILOT_WIND);
    expect(closeTo(angleOf(p.target), 45 * DEG)).toBe(true);
    expect(p.degrees).toBe(45);
    // On port, broad reaching.
    p.off();
    p.engage(PILOT_WIND, 120 * DEG, 0);
    expect(p.degrees).toBe(-120);
    // Closer to the wind than the dial goes: held at its least, on the same side.
    p.off();
    p.least = 35 * DEG;
    p.engage(PILOT_WIND, 350 * DEG, 0);
    expect(p.degrees).toBe(35);
    expect([p.order, p.way]).toEqual([0, WAY_HOLD]);
  });

  test('heading mode holds the heading; switching keeps the order count', () => {
    const p = new PilotInput();
    p.engage(PILOT_WIND, 90 * DEG, 0);
    p.tack(0);
    p.engage(PILOT_HEADING, 270 * DEG, 0);
    expect(p.mode).toBe(PILOT_HEADING);
    expect(p.degrees).toBe(270);
    expect(p.order).toBe(1);
  });

  test('a tack or a gybe mirrors the angle and counts an order, modulo 4', () => {
    const p = new PilotInput();
    p.engage(PILOT_WIND, -45 * DEG, 0);
    expect(p.degrees).toBe(45);
    p.tack(0);
    expect([p.degrees, p.order, p.way]).toEqual([-45, 1, WAY_TACK]);
    p.gybe(0);
    expect([p.degrees, p.order, p.way]).toEqual([45, 2, WAY_GYBE]);
    p.tack(0);
    p.tack(0);
    expect(p.order).toBe(0);
    // Off, an order does nothing.
    p.off();
    p.tack(0);
    expect([p.mode, p.order]).toEqual([PILOT_OFF, 0]);
  });

  test('in heading mode a tack mirrors the heading about the mean wind', () => {
    const p = new PilotInput();
    // 045° in a wind from 000°: 45° off it on port; mirrored, 315°.
    p.engage(PILOT_HEADING, 45 * DEG, 0);
    p.tack(0);
    expect(p.degrees).toBe(315);
    // In a wind from 010°, 315° mirrors to 065°.
    p.gybe(10 * DEG);
    expect(p.degrees).toBe(65);
    expect(p.way).toBe(WAY_GYBE);
  });

  test('the target’s steps, and the dial’s limits', () => {
    const p = new PilotInput();
    p.least = 35 * DEG;
    p.engage(PILOT_HEADING, 0, 0);
    p.adjust(-1);
    expect(p.degrees).toBe(359);
    p.adjust(10);
    expect(p.degrees).toBe(9);
    // Wind mode: turning to starboard on starboard tack luffs, toward the
    // wind, and stops at the least angle; bearing away stops at dead
    // downwind, on the same side.
    p.engage(PILOT_WIND, -90 * DEG, 0);
    expect(p.degrees).toBe(90);
    p.adjust(10);
    expect(p.degrees).toBe(80);
    p.adjust(100);
    expect(p.degrees).toBe(35);
    p.adjust(-200);
    expect(Math.abs(p.degrees)).toBe(180);
    p.engage(PILOT_WIND, 90 * DEG, 0);
    expect(p.degrees).toBe(-90);
    p.adjust(-10);
    expect(p.degrees).toBe(-80);
    p.adjust(-100);
    expect(p.degrees).toBe(-35);
  });

  test('it follows the boat onto the tack it holds after it gybed by itself', () => {
    const p = new PilotInput();
    p.engage(PILOT_WIND, -165 * DEG, 0);
    expect(p.degrees).toBe(165);
    // The step held 165° on port: the heading 165° east of the wind.
    expect(p.follow(165 * DEG, 0, false)).toBe(true);
    expect(p.degrees).toBe(-165);
    expect(p.order).toBe(0);
    // Holding what it was asked: nothing changes; nor during a turn.
    expect(p.follow(165 * DEG, 0, false)).toBe(false);
    p.tack(0);
    expect(p.follow(-165 * DEG, 0, true)).toBe(false);
    // In heading mode: a heading held mirrored about the wind.
    p.engage(PILOT_HEADING, 170 * DEG, 0);
    expect(p.follow(190 * DEG, 0, false)).toBe(true);
    expect(p.degrees).toBe(190);
    // A heading reached through the wind is not followed.
    p.engage(PILOT_HEADING, 100 * DEG, 0);
    expect(p.follow(150 * DEG, 0, false)).toBe(false);
  });

  test('a target is whole steps of a turn, and back', () => {
    for (let d = -179; d <= 180; d += 7) {
      expect(closeTo(angleOf(stepsOf(d * DEG)), d * DEG)).toBe(true);
    }
    expect(stepsOf(-90 * DEG)).toBe(49152);
  });
});

/** A game's autopilot actions, recorded. */
function actions(): PilotActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    pilot: new PilotInput(),
    calls,
    togglePilot: () => calls.push('toggle'),
    engagePilot: (m) => calls.push(`engage ${m}`),
    takeHelm: () => calls.push('take'),
    pilotTack: () => calls.push('tack'),
    pilotGybe: () => calls.push('gybe'),
    pilotAdjust: (d) => calls.push(`adjust ${d}`),
    pilotMode: () => calls.push('mode'),
  };
}

describe('the autopilot’s keys and the helm', () => {
  test('P, Q, E, T and G; Shift for ten degrees', () => {
    const a = actions();
    const k = new KeyInput(new HelmInput(), new SheetInput(), a);
    k.down('KeyP');
    k.down('KeyQ');
    k.down('KeyE');
    k.down('KeyQ', true);
    k.down('KeyE', true);
    k.down('KeyT');
    k.down('KeyG');
    expect(a.calls).toEqual([
      'toggle',
      `adjust ${-PILOT_STEP}`,
      `adjust ${PILOT_STEP}`,
      `adjust ${-PILOT_BIG_STEP}`,
      `adjust ${PILOT_BIG_STEP}`,
      'tack',
      'gybe',
    ]);
  });

  test('the helm’s keys take the helm, once a press; the sheet’s do not', () => {
    const h = new HelmInput();
    let taken = 0;
    h.onTake = () => taken++;
    const k = new KeyInput(h, new SheetInput(), actions());
    k.down('ArrowLeft');
    k.down('ArrowLeft');
    k.up('ArrowLeft');
    k.down('KeyD');
    k.down('KeyC');
    k.down('KeyW');
    k.down('KeyS');
    expect(taken).toBe(3);
  });

  test('a thumb on the helm takes it where the autopilot left it, and drags from there', () => {
    const h = new HelmInput();
    // The game's onTake: the autopilot off, the helm at its last helm.
    h.onTake = () => {
      h.target = 0.4;
    };
    h.down(1, 100, 0);
    expect(h.target).toBe(0.4);
    h.move(1, 107);
    expect(h.target).toBeCloseTo(0.5, 12);
  });
});

describe('the readout', () => {
  test('says what the autopilot holds, or that it turns', () => {
    const p = new PilotInput();
    expect(pilotText(p, 0)).toBe('');
    p.engage(PILOT_WIND, -45 * DEG, 0);
    expect(pilotText(p, WAY_HOLD)).toBe('Wind 45° S');
    p.tack(0);
    expect(pilotText(p, WAY_TACK)).toBe('Tacking');
    expect(pilotText(p, WAY_HOLD)).toBe('Wind 45° P');
    expect(pilotText(p, WAY_GYBE)).toBe('Gybing');
    p.engage(PILOT_HEADING, 270 * DEG, 0);
    expect(pilotText(p, WAY_HOLD)).toBe('Heading 270°');
    p.engage(PILOT_HEADING, 5 * DEG, 0);
    expect(pilotText(p, WAY_HOLD)).toBe('Heading 005°');
  });
});

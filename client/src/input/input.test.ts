// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { DOUBLE_TAP_MS, HELM_TRAVEL, HelmInput } from './helm';
import { HELM_KEY_TIME, KeyInput, SHEET_KEY_TIME, SHEET_PAGE_STEP } from './keys';
import { MAX_REEF, ReefInput, reefLevel } from './reef';
import { SHEET_TRAVEL, SheetInput } from './sheet';

describe('the helm', () => {
  test('moves relative to where the thumb lands, left to port', () => {
    const h = new HelmInput();
    h.target = 0.2;
    expect(h.down(1, 300, 0)).toBe(true);
    // Landing never jumps it.
    h.move(1, 300);
    expect(h.target).toBe(0.2);
    h.move(1, 300 - HELM_TRAVEL / 4);
    expect(h.target).toBeCloseTo(-0.3, 12);
    h.move(1, 300 - HELM_TRAVEL);
    expect(h.target).toBe(-1);
    h.move(1, 300 + HELM_TRAVEL);
    expect(h.target).toBe(1);
    h.up(1, 1000);
    expect(h.target).toBe(1);
  });

  test('ignores a second pointer while one holds it', () => {
    const h = new HelmInput();
    h.down(1, 100, 0);
    expect(h.down(2, 500, 0)).toBe(false);
    h.move(2, 0);
    expect(h.target).toBe(0);
  });

  test('a double tap centres it', () => {
    const h = new HelmInput();
    h.target = 0.6;
    h.down(1, 100, 0);
    h.up(1, 80);
    h.down(1, 102, 80 + DOUBLE_TAP_MS - 50);
    expect(h.target).toBe(0);
    h.up(1, 400);
    // Taps further apart do not.
    h.target = 0.6;
    h.down(1, 100, 1000);
    h.up(1, 1050);
    h.down(1, 100, 1050 + DOUBLE_TAP_MS + 1);
    expect(h.target).toBe(0.6);
  });

  test('a drag is not a tap', () => {
    const h = new HelmInput();
    h.down(1, 100, 0);
    h.move(1, 140);
    h.up(1, 100);
    const kept = h.target;
    h.down(1, 140, 150);
    expect(h.target).toBe(kept);
  });

  test('stays where it is left, or with the setting returns to the centre', () => {
    const h = new HelmInput();
    h.down(1, 100, 0);
    h.move(1, 135);
    h.up(1, 500);
    expect(h.target).toBeCloseTo(0.5, 12);
    h.centreOnRelease = true;
    h.down(1, 100, 1000);
    h.move(1, 135);
    expect(h.target).toBeCloseTo(1, 12);
    h.up(1, 1500);
    expect(h.target).toBe(0);
  });
});

describe('the sheet', () => {
  test('trims at the top and eases at the bottom, relative and clamped', () => {
    const s = new SheetInput();
    expect(s.target).toBe(0.5);
    s.down(7, 400, 0);
    s.move(7, 400 - SHEET_TRAVEL / 4);
    expect(s.target).toBeCloseTo(0.25, 12);
    s.move(7, 400 - SHEET_TRAVEL);
    expect(s.target).toBe(0);
    s.move(7, 400 + SHEET_TRAVEL);
    expect(s.target).toBe(1);
    s.up(7, 100);
    expect(s.held).toBe(false);
  });

  test('helm and sheet take a thumb each at once', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    h.down(1, 100, 0);
    s.down(2, 500, 0);
    h.move(1, 135);
    s.move(2, 540);
    expect(h.target).toBeCloseTo(0.5, 12);
    expect(s.target).toBeCloseTo(0.75, 12);
  });
});

describe('the keyboard', () => {
  test('moves the helm and the sheet at their rates while held', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    const k = new KeyInput(h, s);
    expect(k.down('ArrowRight')).toBe(true);
    for (let i = 0; i < 6; i++) {
      k.update(HELM_KEY_TIME / 12);
    }
    expect(h.target).toBeCloseTo(1, 12);
    k.update(1);
    expect(h.target).toBe(1);
    k.up('ArrowRight');
    k.down('KeyA');
    k.update(HELM_KEY_TIME / 4);
    expect(h.target).toBeCloseTo(0.5, 12);
    k.up('KeyA');
    k.update(1);
    expect(h.target).toBeCloseTo(0.5, 12);
    k.down('KeyW');
    k.update(SHEET_KEY_TIME / 5);
    expect(s.target).toBeCloseTo(0.3, 12);
    k.up('KeyW');
    k.down('KeyS');
    k.update(SHEET_KEY_TIME);
    expect(s.target).toBe(1);
    expect(k.down('KeyZ')).toBe(false);
  });

  test('the sheet is taken as a thumb lands on it or a sheet key goes down, once a hold', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    let taken = 0;
    s.onTake = () => taken++;
    const k = new KeyInput(h, s);
    expect(s.down(1, 100, 0)).toBe(true);
    s.move(1, 120);
    s.up(1, 50);
    expect(taken).toBe(1);
    k.down('KeyW');
    k.down('KeyW');
    expect(taken).toBe(2);
    k.up('KeyW');
    k.down('KeyS');
    expect(taken).toBe(3);
    k.down('ArrowLeft');
    expect(taken).toBe(3);
  });

  test('C centres the helm; the release setting applies to the keys', () => {
    const h = new HelmInput();
    const k = new KeyInput(h, new SheetInput());
    h.target = -0.4;
    k.down('KeyC');
    expect(h.target).toBe(0);
    h.centreOnRelease = true;
    k.down('KeyD');
    k.update(0.1);
    expect(h.target).toBeGreaterThan(0);
    k.up('KeyD');
    expect(h.target).toBe(0);
  });

  test('on the focused sheet the arrows trim and ease it, and the helm stays', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    let helmTaken = 0;
    h.onTake = () => helmTaken++;
    const k = new KeyInput(h, s);
    // → and ↑ trim (haul in), ← and ↓ ease.
    expect(k.down('ArrowRight', false, 'sheet')).toBe(true);
    k.update(SHEET_KEY_TIME / 5);
    expect(s.target).toBeCloseTo(0.3, 12);
    expect(h.target).toBe(0);
    expect(helmTaken).toBe(0);
    k.up('ArrowRight');
    k.update(1);
    expect(s.target).toBeCloseTo(0.3, 12);
    k.down('ArrowUp', false, 'sheet');
    k.update(SHEET_KEY_TIME / 10);
    k.up('ArrowUp');
    expect(s.target).toBeCloseTo(0.2, 12);
    k.down('ArrowLeft', false, 'sheet');
    k.update(SHEET_KEY_TIME / 5);
    k.up('ArrowLeft');
    k.down('ArrowDown', false, 'sheet');
    k.update(SHEET_KEY_TIME / 10);
    k.up('ArrowDown');
    expect(s.target).toBeCloseTo(0.5, 12);
    expect(h.target).toBe(0);
    expect(helmTaken).toBe(0);
    // The letters do as anywhere: D steers.
    k.down('KeyD', false, 'sheet');
    expect(helmTaken).toBe(1);
    k.up('KeyD');
  });

  test('on the focused sheet Page Up trims and Page Down eases a tenth, kept to its range', () => {
    const s = new SheetInput();
    let taken = 0;
    s.onTake = () => taken++;
    const k = new KeyInput(new HelmInput(), s);
    expect(k.down('PageUp', false, 'sheet')).toBe(true);
    expect(s.target).toBeCloseTo(0.5 - SHEET_PAGE_STEP, 12);
    expect(taken).toBe(1);
    for (let i = 0; i < 12; i++) {
      k.down('PageDown', false, 'sheet');
    }
    expect(s.target).toBe(1);
    // Elsewhere the Page keys are not the game's.
    expect(k.down('PageUp')).toBe(false);
    expect(s.target).toBe(1);
  });

  test('on the focused helm ← and → steer, and ↑ and ↓ do nothing', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    const k = new KeyInput(h, s);
    k.down('ArrowRight', false, 'helm');
    k.update(HELM_KEY_TIME / 4);
    expect(h.target).toBeCloseTo(0.5, 12);
    k.up('ArrowRight');
    k.down('ArrowLeft', false, 'helm');
    k.update(HELM_KEY_TIME / 2);
    k.up('ArrowLeft');
    expect(h.target).toBeCloseTo(-0.5, 12);
    expect(k.down('ArrowUp', false, 'helm')).toBe(false);
    expect(s.target).toBe(0.5);
  });

  test('a key let go after the focus moved lets go of what it held', () => {
    const h = new HelmInput();
    const s = new SheetInput();
    const k = new KeyInput(h, s);
    // → went down on the sheet, trimming; the focus moved before it came up.
    k.down('ArrowRight', false, 'sheet');
    k.update(SHEET_KEY_TIME / 10);
    k.up('ArrowRight');
    k.update(1);
    expect(s.target).toBeCloseTo(0.4, 12);
    expect(h.target).toBe(0);
    // And everything held lets go as the page loses the focus.
    k.down('ArrowDown', false, 'sheet');
    k.down('ArrowLeft');
    k.release();
    k.update(1);
    expect(s.target).toBeCloseTo(0.4, 12);
    expect(h.target).toBe(0);
  });
});

describe('the reef', () => {
  test('R takes a reef more and F shakes one out, a level at a time, kept to its range', () => {
    const r = new ReefInput();
    let taken = 0;
    r.onTake = () => taken++;
    const k = new KeyInput(new HelmInput(), new SheetInput(), null, r);
    expect(r.level).toBe(0);
    expect(k.down('KeyR')).toBe(true);
    expect(r.level).toBe(1);
    k.down('KeyR');
    k.down('KeyR');
    expect(r.level).toBe(MAX_REEF);
    k.down('KeyF');
    expect(r.level).toBe(1);
    k.down('KeyF');
    k.down('KeyF');
    expect(r.level).toBe(0);
    // Shift and R shake one out too, where F flies the free camera.
    k.down('KeyR');
    k.down('KeyR', true);
    expect(r.level).toBe(0);
    expect(k.up('KeyR')).toBe(true);
    expect(taken).toBe(8);
    // Without a reef to hold, the keys are still the game's, and do nothing.
    expect(new KeyInput(new HelmInput(), new SheetInput()).down('KeyR')).toBe(true);
  });

  test('a level is a whole number the wire carries', () => {
    const r = new ReefInput();
    r.set(1.4);
    expect(r.level).toBe(1);
    r.set(7);
    expect(r.level).toBe(2);
    r.set(-1);
    expect(r.level).toBe(0);
    expect([reefLevel(Number.NaN), reefLevel(0.5), reefLevel(1.5), reefLevel(2)]).toEqual([
      0, 1, 2, 2,
    ]);
  });
});

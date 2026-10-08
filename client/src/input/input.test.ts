// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { DOUBLE_TAP_MS, HELM_TRAVEL, HelmInput } from './helm';
import { HELM_KEY_TIME, KeyInput, SHEET_KEY_TIME } from './keys';
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
    expect(k.down('KeyQ')).toBe(false);
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
});

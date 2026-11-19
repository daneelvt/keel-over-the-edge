// SPDX-License-Identifier: AGPL-3.0-only

// The sound's words, as the player reads them.

import { describe, expect, test } from 'vitest';
import { percentText, SEA_AND_WIND, SOUND, SOUNDS, soundNotice, VOLUME } from './soundwords';

describe('the sound’s words', () => {
  test('name the switch and the sliders plainly', () => {
    expect([SOUND, VOLUME, SEA_AND_WIND, SOUNDS]).toEqual([
      'Sound',
      'Volume',
      'Sea and wind',
      'Sounds',
    ]);
  });

  test('read a slider as a whole percentage', () => {
    expect(percentText(0.7)).toBe('70%');
    expect(percentText(0)).toBe('0%');
    expect(percentText(1)).toBe('100%');
    expect(percentText(0.333)).toBe('33%');
  });

  test('say what the M key did', () => {
    expect(soundNotice(false)).toBe('Sound off');
    expect(soundNotice(true)).toBe('Sound on');
  });
});

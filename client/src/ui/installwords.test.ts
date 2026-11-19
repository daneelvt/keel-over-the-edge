// SPDX-License-Identifier: AGPL-3.0-only

// The home screen's words, as the player reads them.

import { describe, expect, test } from 'vitest';
import { ADD_KEEL, INSTALL, NOT_NOW, PLAY_FROM_HOME_SCREEN } from './installwords';

describe('the home screen’s words', () => {
  test('offer it in one short line, with two plain keys', () => {
    expect(PLAY_FROM_HOME_SCREEN).toBe('Play from your home screen, without the browser’s bars.');
    expect([ADD_KEEL, NOT_NOW]).toEqual(['Add Keel', 'Not now']);
    expect(PLAY_FROM_HOME_SCREEN.split(' ').length).toBeLessThanOrEqual(10);
  });

  test('name the menu’s key as the browser does', () => {
    expect(INSTALL).toBe('Install');
  });
});

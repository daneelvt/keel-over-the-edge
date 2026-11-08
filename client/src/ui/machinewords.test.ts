// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { linkOf } from '../account/comeaboardwords';
import { plain } from './deckwords';
import {
  cantSendText,
  comeAboardText,
  machineAsksWords,
  machineKnockingWords,
  sailWithMeFor,
  sendAboardText,
} from './machinewords';

describe('machine sailors together, in words', () => {
  test('another player’s machine sailor knocking, its owner named, its names player text', () => {
    const w = machineAsksWords('Rover', 'Bob Read', 'Iron Mary');
    expect(plain(w)).toBe(
      'Rover ⚙, Bob Read’s machine sailor, asks to come aboard Iron Mary’s boat',
    );
    expect(w.filter((x) => typeof x !== 'string')).toEqual([
      { player: 'Rover' },
      { player: 'Bob Read' },
      { player: 'Iron Mary' },
    ]);
  });

  test('the player’s machine sailor’s knock as it stands', () => {
    const said = (s: Parameters<typeof machineKnockingWords>[0]) =>
      plain(machineKnockingWords(s, 'Rover', 'Iron Mary', '', 'Keelboat'));
    expect(said('waiting')).toBe('Sending Rover aboard Iron Mary’s boat: its owner chooses…');
    expect(said('let')).toBe('Rover is coming aboard Iron Mary’s boat.');
    expect(said('lapsed')).toBe('Iron Mary’s owner didn’t answer.');
    expect(said('away')).toBe('Rover isn’t in the water: its AI app sails it there first.');
    expect(said('full')).toBe('Iron Mary’s boat has no room aboard.');
  });

  test('the keys', () => {
    expect(comeAboardText('Iron Mary')).toBe('Come aboard Iron Mary’s boat');
    expect(sailWithMeFor('Iron Mary')).toBe('Sail with me for Iron Mary');
    expect(sendAboardText('Rover')).toBe('Send Rover aboard');
    expect(cantSendText('ok', 'Rover', 'Iron Mary')).toBe('');
    expect(cantSendText('away', 'Rover', 'Iron Mary')).toBe(
      'Rover isn’t in the water: its AI app sails it there first.',
    );
    expect(cantSendText('closed', 'Rover', 'Iron Mary')).toBe(
      'Iron Mary isn’t taking Rover aboard now.',
    );
  });

  test('a machine sailor’s link read, with the player’s machine sailors to send', () => {
    const read = linkOf(200, {
      skipper: 'Iron Mary',
      look: 3,
      kind: 1,
      boat: '',
      can: 'closed',
      machine: true,
      send: [{ name: 'Rover', can: 'ok' }, { name: 7 }],
    });
    expect(read).toEqual({
      kind: 'link',
      link: {
        skipper: 'Iron Mary',
        look: 3,
        kind: 1,
        boat: '',
        can: 'closed',
        machine: true,
        send: [{ name: 'Rover', can: 'ok' }],
      },
    });
  });
});

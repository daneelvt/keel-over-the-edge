// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together's words, each as the player reads it, a player's text
// kept apart from the words around it.

import { describe, expect, test } from 'vitest';
import type { KnockStateTold } from '../net/messages';
import {
  aboardCountText,
  aboardWords,
  actionName,
  asksWords,
  endsText,
  handedWords,
  knockingWords,
  moreWaitingText,
  plain,
  putAshoreWords,
  secondsText,
  whoseBoatWords,
} from './deckwords';

describe('sailing together’s words', () => {
  test('a player’s text stands apart, and reads whole', () => {
    expect(asksWords('Iron Mary')).toEqual([{ player: 'Iron Mary' }, ' asks to come aboard']);
    expect(plain(asksWords('Iron Mary'))).toBe('Iron Mary asks to come aboard');
  });

  test('how long a link has left', () => {
    const h = 3_600_000;
    expect(endsText(24 * h, 0)).toBe('Ends in 24 hours');
    expect(endsText(23 * h + 10 * 60_000, 0)).toBe('Ends in 23 hours');
    expect(endsText(h, 0)).toBe('Ends in 1 hour');
    expect(endsText(59 * 60_000 + 1, 0)).toBe('Ends in 1 hour');
    expect(endsText(5 * 60_000, 0)).toBe('Ends in 5 minutes');
    expect(endsText(30_000, 0)).toBe('Ends in 1 minute');
    expect(endsText(7 * 24 * h, 0)).toBe('Ends in 7 days');
    expect(endsText(1000, 1000)).toBe('This link has ended.');
  });

  test('the knocks waiting behind the one shown', () => {
    expect(moreWaitingText(0)).toBe('');
    expect(moreWaitingText(1)).toBe('1 more waiting');
    expect(moreWaitingText(4)).toBe('4 more waiting');
  });

  test('the knocker’s own knock, in every state', () => {
    const words: Record<KnockStateTold, string> = {
      waiting: 'Asking to come aboard Iron Mary’s keelboat…',
      let: 'Coming aboard Iron Mary’s keelboat…',
      'not-now': 'Iron Mary can’t take you aboard now.',
      lapsed: 'The skipper didn’t answer.',
      ended: 'This link has ended.',
      'not-at-sea': 'Iron Mary’s boat isn’t in the water now.',
      full: 'Iron Mary’s boat has no room aboard.',
      closed: 'Iron Mary isn’t taking crew now.',
      busy: 'The skipper has knocks waiting; try again soon.',
      often: 'You’ve knocked a lot; try again later.',
      crowded: 'Many are sailing together just now; try again soon.',
      own: 'That is your own boat.',
      first: 'Answer the questions before your first knock, then try again.',
      'try-again': 'That knock didn’t reach the skipper; try again.',
      withdrawn: 'Your knock was withdrawn.',
      away: 'Your machine sailor isn’t in the water now.',
      other: 'You can’t come aboard now.',
    };
    for (const [state, text] of Object.entries(words)) {
      expect(plain(knockingWords(state as KnockStateTold, 'Iron Mary', '', 'Keelboat'))).toBe(text);
    }
  });

  test('a boat by its name, a player’s, or by its kind', () => {
    expect(knockingWords('waiting', 'Iron Mary', 'Saltpeter', 'Keelboat')).toEqual([
      'Asking to come aboard ',
      { player: 'Iron Mary' },
      '’s «',
      { player: 'Saltpeter' },
      '»',
      '…',
    ]);
    expect(plain(whoseBoatWords('Iron Mary', '', 'Jolly boat'))).toBe('Iron Mary’s jolly boat');
    expect(plain(aboardWords('Iron Mary', 'Saltpeter', 'Keelboat'))).toBe(
      'Aboard Iron Mary’s «Saltpeter»',
    );
  });

  test('aboard, and the controls', () => {
    expect(aboardCountText(3)).toBe('3 aboard');
    expect(plain(putAshoreWords('Bosun Bly'))).toBe('Put Bosun Bly ashore?');
    expect(actionName('Put ashore', 'Bosun Bly')).toBe('Put ashore: Bosun Bly');
    expect(plain(handedWords('Iron Mary'))).toBe('Iron Mary hands you the controls');
    expect(secondsText(15)).toBe('15 s');
    expect(secondsText(11.2)).toBe('12 s');
    expect(secondsText(-1)).toBe('0 s');
  });
});

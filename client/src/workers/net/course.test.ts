// SPDX-License-Identifier: AGPL-3.0-only

import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { ChartSubject, CourseKind, CourseSchema } from '../../net/gen/keel/v1/game_pb';
import { courseOpen } from './session';

describe('an island course from the server', () => {
  test('reads as the page holds it: its way in points, its kind and rounds by name', () => {
    const c = courseOpen(
      create(CourseSchema, {
        number: 4,
        kind: CourseKind.LIGHT,
        name: 'Round the Gull Light',
        way: [10, -20, 300, 400, 10, -20],
        length: 1234,
        rounds: [{ subject: ChartSubject.PLACE, number: 88, starboard: false }],
        boats: [{ kind: 3, seconds: 1500 }],
      }),
    );
    expect(c).toEqual({
      number: 4,
      kind: 'light',
      name: 'Round the Gull Light',
      way: [
        [10, -20],
        [300, 400],
        [10, -20],
      ],
      length: 1234,
      rounds: [{ subject: 'place', number: 88, starboard: false }],
      boats: [{ kind: 3, seconds: 1500 }],
    });
  });
});

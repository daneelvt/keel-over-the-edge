// SPDX-License-Identifier: AGPL-3.0-only

// The sound room's page (sounds.html, reached as dev.html#sounds): the
// game's sound engine, every voice in its scene (dev/soundroom.ts).

import './policy';
import { openSoundRoom } from '../dev/soundroom';
import { sendViolations } from './report';

sendViolations();

void openSoundRoom();

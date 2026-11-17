// SPDX-License-Identifier: AGPL-3.0-only

// The dressing room's page (sailors.html, reached as dev.html#sailors): the
// sailors drawn by the game's renderer (dev/dressing.ts).

import './policy';
import './styles.css';
import { openDressingRoom } from '../dev/dressing';
import { sendViolations } from './report';

sendViolations();

void openDressingRoom();

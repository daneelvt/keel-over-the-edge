// SPDX-License-Identifier: AGPL-3.0-only

// The approval page's entry, built apart from the game into approve.html,
// which keel serves at /oauth/authorize under a strict Content Security
// Policy: its own scripts and styles alone, no inline script or style.

import '../src/account/start.css';
import './approve.css';
import { render } from 'preact';
import { ApprovePage } from './page';

const root = document.createElement('div');
document.body.append(root);
render(<ApprovePage />, root);

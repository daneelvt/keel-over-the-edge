// SPDX-License-Identifier: AGPL-3.0-only

// The notice page: its form sent to the game's owner, the answer said
// under it, the form put away once the notice is received.

import { type Notice, noticeOf, noticeProblem, SENT, sendNotice } from './notice';

const form = document.querySelector<HTMLFormElement>('#notice');
const problem = document.querySelector<HTMLElement>('#notice-problem');
const sent = document.querySelector<HTMLElement>('#notice-sent');

if (form !== null && problem !== null && sent !== null) {
  let busy = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    const data = new FormData(form);
    const n = noticeOf((k: keyof Notice) => {
      const v = data.get(k);
      return typeof v === 'string' ? v : '';
    });
    const wrong = noticeProblem(n);
    problem.textContent = wrong;
    if (wrong !== '') {
      return;
    }
    busy = true;
    const button = form.querySelector('button');
    button?.setAttribute('disabled', '');
    void sendNotice(n).then((why) => {
      busy = false;
      button?.removeAttribute('disabled');
      problem.textContent = why;
      if (why === '') {
        form.hidden = true;
        sent.textContent = SENT;
        sent.hidden = false;
        sent.focus();
      }
    });
  });
}

// Entry point of session.html. Live by default; "?demo" replays the recorded session (used for screenshots and the landing page).
import { el } from './dom.js';
import { mountSession } from './session-ui.js';
import { connectLive, replay } from './transports.js';

const root = document.getElementById('session');
const conn = document.getElementById('conn');
const demo = new URLSearchParams(location.search).has('demo');
const setPill = (state, text) => {
  conn.className = 'pill ' + ({ live: 'pill--ok', connecting: 'pill--warn', reconnecting: 'pill--warn', refused: 'pill--bad' }[state] ?? '');
  conn.textContent = text ?? ({ live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', refused: 'Not connected' }[state]);
};

if (demo) {
  const ui = mountSession(root, { readOnlyNote: 'This is a recorded session. Nothing you type here is sent.' });
  setPill('live', 'Recording');
  ui.setConn('live');
  const data = await (await fetch('/data/demo-session.json')).json();
  replay(data, { onMessage: ui.handle, onStart: ui.reset });
} else if (!location.hash.slice(1)) {
  const ui = mountSession(root, { readOnlyNote: 'Open your invite link to join.' });
  setPill('refused', 'No invite');
  ui.note('You need an invite link to join a session. Ask the host for one, or open the link they sent you.');
} else {
  // a name is needed once; it is kept in this browser
  let name = localStorage.getItem('sandwich-name') || '';
  if (!name) {
    const dlg = el('dialog', { class: 'dlg' },
      el('form', { method: 'dialog', class: 'dlg-form' },
        el('h2', { class: 'h3', text: 'What should we call you?' }),
        el('p', { class: 'muted', text: 'The host and everyone in the session will see this name next to what you type.' }),
        el('div', { class: 'notice' }, el('b', { text: 'Who can see this' }), el('ul', {}, el('li', { text: 'Everyone in the session can read everything typed here, including the host.' }), el('li', { text: 'The agent can read the project files.' }), el('li', { text: 'What you ask the agent to do runs on the host’s account, and the host pays for it.' }))),
        el('label', { class: 'field' }, el('span', { text: 'Your name' }), el('input', { class: 'input', name: 'n', maxlength: 20, required: true, autocomplete: 'nickname' })),
        el('div', { class: 'sx-abtns' }, el('button', { class: 'btn', type: 'submit', text: 'Join the session' }))));
    document.body.append(dlg);
    dlg.showModal();
    name = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.querySelector('input').value.trim() || 'Guest')));
    localStorage.setItem('sandwich-name', name);
  }
  const ui = mountSession(root, { send: (o) => live.send(o) });
  const live = connectLive({
    name,
    onMessage: ui.handle,
    onState: (state, text) => {
      setPill(state, state === 'refused' ? 'Not connected' : undefined);
      ui.setConn(state);
      if (state === 'refused') ui.note(text);
    },
  });
}

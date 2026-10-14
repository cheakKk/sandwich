// The live session view. One component, used by the real session page (fed by a WebSocket) and by the landing page demo
// (fed by a recorded real session), so the demo is the real thing and not a mock. It only ever receives the worker's
// messages through handle(msg) and only ever acts through send(obj).
import { age, avatar, clock, el, icon, kfmt, markdown, money, tidy, toolLabel } from './dom.js';

const MODE_NOTE = {
  guarded: 'Guarded: anything the agent wants to do beyond reading needs an op to approve it.',
  trusted: 'Trusted: the agent runs tools without per-command approval inside an isolated sandbox. Guests have a daily token cap and the session has a budget.',
};

export function mountSession(root, { send = () => {}, layout = 'full', readOnlyNote = '' } = {}) {
  const S = { role: '', name: '', mode: 'guarded', busy: false, working: null, workingAt: 0, people: [], typers: {}, approvals: new Map(), ticket: 0, readOnly: !!readOnlyNote, conn: 'connecting' };
  const compact = layout === 'compact';
  root.replaceChildren();
  root.classList.add('sx', `sx--${layout}`);
  root.dataset.view = 'feed';

  // ---- structure
  const peopleList = el('ul', { class: 'sx-people' });
  const inviteOut = el('div', { class: 'sx-invite-out', hidden: true });
  const inviteBtn = el('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: () => send({ text: '/invite' }) }, icon('invite'), 'Invite someone');
  const modeInputs = {};
  const modeSeg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Trust setting' },
    ...['guarded', 'trusted'].flatMap((m) => {
      const input = el('input', { type: 'radio', name: 'mode', id: `mode-${m}`, value: m, onchange: () => { send({ text: `/trust ${m}` }); renderMode(); } });
      modeInputs[m] = input;
      return [input, el('label', { for: `mode-${m}` }, icon(m), m[0].toUpperCase() + m.slice(1))];
    }));
  const modeNote = el('p', { class: 'sx-note muted' });
  const memoryBox = el('div', { class: 'sx-memory' }, el('div', { class: 'skel skel--line' }), el('div', { class: 'skel skel--line' }), el('div', { class: 'skel skel--block' }));
  const usageBox = el('div', { class: 'sx-usage' }, el('div', { class: 'skel skel--line' }), el('div', { class: 'skel skel--line' }));

  const section = (title, ico, ...kids) => el('section', { class: 'sx-sec' }, el('h2', { class: 'label sx-h' }, icon(ico), title), ...kids);

  const nowBar = el('div', { class: 'sx-now', role: 'status' });
  const feed = el('div', { class: 'sx-feed scroll', role: 'log', 'aria-live': 'polite', 'aria-label': 'Session' });
  const jump = el('button', { class: 'btn btn--ink btn--sm sx-jump', type: 'button', hidden: true, onclick: () => { feed.scrollTop = feed.scrollHeight; jump.hidden = true; } }, 'Jump to latest');
  const typing = el('div', { class: 'sx-typing muted', 'aria-live': 'polite' });
  const approvals = el('div', { class: 'sx-approvals' });
  const input = el('textarea', { class: 'input sx-input', rows: 1, placeholder: readOnlyNote || 'Steer the agent, or type / for commands', 'aria-label': 'Message', disabled: !!readOnlyNote });
  const sendBtn = el('button', { class: 'btn', type: 'submit', 'aria-label': 'Send', disabled: !!readOnlyNote }, icon('send'));
  let lastTyped = 0;
  const composer = el('form', { class: 'sx-composer', onsubmit: (e) => { e.preventDefault(); submit(); } }, input, sendBtn);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    if (Date.now() - lastTyped > 1500 && input.value.trim()) { lastTyped = Date.now(); send({ type: 'typing' }); }
  });
  function submit() {
    const text = input.value.trim();
    if (!text || S.conn !== 'live' || S.readOnly) return;
    send({ text });
    input.value = '';
    input.style.height = 'auto';
  }
  feed.addEventListener('scroll', () => { if (atBottom()) jump.hidden = true; });
  const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;

  const strip = el('ul', { class: 'sx-strip', 'aria-label': 'People in this session' });
  const main = el('div', { class: 'sx-main' }, compact ? strip : null, nowBar, el('div', { class: 'sx-feedwrap' }, feed, jump), typing, approvals, compact ? null : composer);
  const rail = el('aside', { class: 'sx-rail', 'aria-label': 'People and settings' },
    section('People', 'people', peopleList, inviteBtn, inviteOut),
    section('Trust setting', 'guarded', modeSeg, modeNote));
  const side = el('aside', { class: 'sx-side', 'aria-label': 'Memory and usage' },
    section('Memory', 'memory', memoryBox),
    section('Usage', 'usage', usageBox));
  const tabs = el('div', { class: 'sx-tabs', role: 'tablist' },
    ...[['feed', 'Session'], ['rail', 'People'], ['side', 'Memory and usage']].map(([id, label]) =>
      el('button', { class: 'sx-tab', type: 'button', role: 'tab', 'aria-selected': id === 'feed' ? 'true' : 'false', dataset: { view: id }, onclick: () => setView(id) }, label)));
  function setView(id) {
    root.dataset.view = id;
    for (const t of tabs.children) t.setAttribute('aria-selected', t.dataset.view === id ? 'true' : 'false');
  }
  if (compact) root.append(main);
  else root.append(rail, main, side, tabs);

  // ---- rendering
  const canManage = () => S.role === 'owner' || S.role === 'op';

  function renderNow() {
    nowBar.replaceChildren();
    if (S.busy) {
      const w = S.working;
      nowBar.className = 'sx-now sx-now--busy';
      nowBar.append(icon('busy'), el('span', { class: 'sx-now-text' },
        w ? el('b', { text: `The kitchen is on ${w.name}'s order` }) : el('b', { text: 'The agent is working' }),
        w ? el('span', { class: 'muted', text: ` “${tidy(w.snippet, 60)}”` }) : null),
        w ? el('span', { class: 'meta', text: `${age(w.ageMs + Date.now() - S.workingAt)}${w.tools ? ` · ${w.tools} tool call${w.tools === 1 ? '' : 's'}` : ''}` }) : null);
    } else {
      nowBar.className = 'sx-now';
      nowBar.append(el('span', { class: 'pill pill--ok', text: 'Free' }), el('span', { class: 'muted', text: S.conn === 'live' || compact ? 'The kitchen is free. Send an order.' : connText() }));
    }
  }
  const connText = () => ({ connecting: 'Connecting...', reconnecting: 'Connection lost, reconnecting...', closed: 'Disconnected.' }[S.conn] ?? '');

  function renderMode() {
    for (const m of ['guarded', 'trusted']) { modeInputs[m].checked = S.mode === m; modeInputs[m].disabled = S.role !== 'owner'; }
    modeNote.textContent = MODE_NOTE[S.mode] + (S.role === 'owner' ? '' : ' Only the owner can change this.');
  }

  function renderPeople() {
    peopleList.replaceChildren(...S.people.map((p) => {
      const mine = p.name === S.name;
      const acts = canManage() && !mine && p.role !== 'owner' ? [
        p.online ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: `Hand the session to ${p.name}`, 'aria-label': `Hand the session to ${p.name}`, onclick: () => send({ text: `/handoff ${p.name}` }) }, icon('handoff')) : null,
        S.role === 'owner' ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => send({ text: `/${p.role === 'op' ? 'deop' : 'op'} ${p.name}` }) }, p.role === 'op' ? 'Remove op' : 'Make op') : null,
        p.role !== 'op' || S.role === 'owner' ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`, onclick: () => send({ text: `/revoke ${p.name}` }) }, icon('kick')) : null,
      ] : [];
      return el('li', { class: 'sx-person' + (p.online ? '' : ' is-off') },
        avatar(p.name),
        el('span', { class: 'sx-pname' }, el('b', { text: p.name }), mine ? el('span', { class: 'muted', text: ' (you)' }) : null),
        el('span', { class: 'sx-tags' }, el('span', { class: 'pill', text: p.role }), p.driver ? el('span', { class: 'pill pill--live', text: 'driving' }) : null, p.online ? null : el('span', { class: 'muted sx-off', text: 'offline' })),
        acts.some(Boolean) ? el('span', { class: 'sx-acts' }, acts) : null);
    }));
    strip.replaceChildren(...S.people.filter((p) => p.online).map((p) => el('li', { class: 'sx-stripp' }, avatar(p.name), el('span', { text: p.name }), el('span', { class: 'pill', text: p.role }))));
    inviteBtn.hidden = !canManage();
    renderMode();
  }

  const renderUsage = (u) => usageBox.replaceChildren(...usageView(u));
  const renderMemory = (m) => memoryBox.replaceChildren(...memoryView(m));

  function renderTyping() {
    const now = Date.now();
    const who = Object.keys(S.typers).filter((n) => S.typers[n] > now);
    typing.textContent = who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing...` : '';
  }

  // ---- feed
  function push(node) {
    const stick = compact || atBottom(); // the landing demo always follows the newest line
    feed.append(node);
    if (stick) feed.scrollTop = feed.scrollHeight;
    else jump.hidden = false;
  }
  function appendEvent(ev) {
    const { user, text } = ev;
    if (user === 'system') { push(el('div', { class: 'sx-sys' }, text)); return; }
    if (user === 'agent') {
      const t = /^\[tool\]\s+(\S+)\s*(.*)$/s.exec(text);
      if (t) { push(el('div', { class: 'tool' }, icon('tool'), el('b', { text: t[1] }), el('span', { text: toolLabel(t[1], t[2]) }))); return; }
      push(el('div', { class: 'sx-agent' }, avatar('agent', true), el('div', { class: 'sx-body' }, ...markdown(text))));
      return;
    }
    S.ticket++;
    push(el('div', { class: 'ticket' + (user === S.name ? ' ticket--mine' : '') },
      el('div', { class: 'head' }, el('span', { class: 'who' }, avatar(user), ' ', user), el('span', { class: 'meta', text: `Order ${S.ticket}${ev.ts ? ' · ' + clock(ev.ts) : ''}` })),
      el('p', { class: 'sx-order', text: text })));
  }

  function addApproval(m) {
    if (S.approvals.has(m.id)) return;
    const card = el('div', { class: 'sx-approval', role: 'group', 'aria-label': `Approval needed for ${m.tool}` },
      el('div', { class: 'row-between' }, el('span', { class: 'sx-ahead' }, icon('approve'), el('b', { text: `The agent wants to use ${m.tool}` })), el('span', { class: 'pill pill--warn', text: 'Needs an op' })),
      el('pre', { class: 'sx-code scroll', text: JSON.stringify(m.input, null, 2) }),
      el('div', { class: 'sx-abtns' },
        el('button', { class: 'btn btn--ink btn--sm', type: 'button', onclick: () => decide(m.id, true) }, 'Allow'),
        el('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: () => decide(m.id, false) }, 'Deny')));
    S.approvals.set(m.id, card);
    approvals.append(card);
  }
  function decide(id, allow) {
    send({ type: 'decide', id, allow });
    for (const b of S.approvals.get(id)?.querySelectorAll('button') ?? []) b.disabled = true;
  }

  // ---- messages from the worker
  function handle(m) {
    switch (m.type) {
      case 'role': S.role = m.role; S.name = m.name; renderPeople(); renderMode(); break;
      case 'mode': S.mode = m.mode; renderMode(); break;
      case 'status': S.busy = m.busy; S.working = m.working; S.workingAt = Date.now(); renderNow(); break;
      case 'typing': S.typers[m.name] = Date.now() + 3000; renderTyping(); setTimeout(renderTyping, 3100); break;
      case 'people': S.people = m.people; renderPeople(); break;
      case 'usage': renderUsage(m); break;
      case 'memory': renderMemory(m); break;
      case 'approval': addApproval(m); break;
      case 'resolved': S.approvals.get(m.id)?.remove(); S.approvals.delete(m.id); break;
      case 'invite':
        inviteOut.hidden = false;
        inviteOut.replaceChildren(el('label', { class: 'field' }, el('span', { text: `Single-use link, ${m.ttl}` }),
          el('input', { class: 'input mono', readonly: true, value: m.url, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() })),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(m.url); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; } } }, icon('link'), 'Copy link'));
        break;
      default: if (m.user) appendEvent(m);
    }
  }

  setInterval(() => { if (S.busy && S.working) renderNow(); }, 1000);
  renderNow(); renderMode();

  return {
    handle,
    setConn(state) { S.conn = state; sendBtn.disabled = S.readOnly || state !== 'live'; if (!S.busy) renderNow(); },
    reset() { feed.replaceChildren(); approvals.replaceChildren(); S.approvals.clear(); S.ticket = 0; S.busy = false; S.working = null; S.people = []; peopleList.replaceChildren(); strip.replaceChildren(); renderNow(); },
    note(text) { feed.replaceChildren(el('div', { class: 'sx-empty' }, text)); },
    focus() { input.focus(); },
  };
}

// The usage and memory panels as plain DOM, so the landing page can show them with the very same code.
export function usageView(u) {
  const out = [];
  const rows = u.rows ?? [];
  if (!rows.length) out.push(el('p', { class: 'muted', text: 'No turns yet.' }));
  else {
    const receipt = el('div', { class: 'receipt' });
    let total = 0, any$ = false;
    for (const r of rows) {
      if (r.costUsd != null) { total += r.costUsd; any$ = true; }
      receipt.append(el('div', { class: 'row' }, el('span', { text: r.name }), el('span', { class: 'dots' }), el('span', { text: `${r.turns} turn${r.turns === 1 ? '' : 's'} · ${kfmt(r.tokensIn + r.tokensOut)}${r.costUsd != null ? ' · ' + money(r.costUsd) : ''}` })));
    }
    if (rows.length > 1 && any$) receipt.append(el('div', { class: 'row total' }, el('span', { text: 'Total' }), el('span', { class: 'dots' }), el('span', { text: money(total) })));
    out.push(receipt, el('p', { class: 'muted sx-fine', text: "Dollar figures are the SDK's estimates, not a bill." }));
  }
  const meter = (label, used, of, fmt) => {
    const pct = Math.min(100, Math.round((used / of) * 100));
    // the bar width is set from data after it is in the page, not as an inline style attribute (the page's CSP forbids those)
    const fill = el('i');
    queueMicrotask(() => { fill.style.width = pct + '%'; });
    return el('div', { class: 'sx-meter' }, el('div', { class: 'row-between' }, el('span', { class: 'label', text: label }), el('span', { class: 'mono sx-fine', text: `${fmt(used)} of ${fmt(of)}` })),
      el('div', { class: `bar${pct >= 100 ? ' bar--bad' : pct >= 80 ? ' bar--warn' : ''}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label }, fill));
  };
  if (u.budget != null) out.push(meter('Session budget', u.spent ?? 0, u.budget, money));
  if (u.me?.cap != null) out.push(meter('Your daily cap', u.me.usedToday ?? 0, u.me.cap, (n) => `${kfmt(n)} tokens`));
  return out;
}

export function memoryView(m) {
  if (!m.summary && !m.entries) return [el('p', { class: 'muted', text: 'Nothing saved yet. /save writes a summary, and the agent can add notes.' })];
  const group = (title, items) => items?.length ? el('div', { class: 'sx-mgroup' }, el('h3', { class: 'label', text: title }), el('ul', {}, ...items.map((e) => el('li', {}, el('b', { text: e.author }), ' ', e.text)))) : null;
  return [m.summary ? el('div', { class: 'sx-summary scroll' }, ...markdown(m.summary)) : null, group('Done', m.done), group('Decisions', m.decisions), group('Open tasks', m.tasks), m.handoff ? group('Last handoff', [m.handoff]) : null].filter(Boolean);
}

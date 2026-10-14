// Where the session view gets its messages from.

// Live: the worker's WebSocket. The token is sent as the first message, never in the URL (URLs end up in logs).
// After an invite is redeemed the worker sends a session token; keeping it in the address bar fragment lets a refresh work.
export function connectLive({ name, onMessage, onState }) {
  let ws, closed = false;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';
  function open() {
    onState('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: location.hash.slice(1), name }));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'session') { history.replaceState(null, '', '#' + m.token); return; } // the invite is burned; keep our own session
      if (m.type === 'role') onState('live');
      onMessage(m);
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code === 4401) return onState('refused', 'This link does not work (anymore). Invite links work once and expire. Ask the host for a new one.');
      if (e.code === 4403) return onState('refused', e.reason || 'You were removed from this session.');
      if (e.code === 4408) return onState('refused', 'Too many tabs are open for this person.');
      onState('reconnecting');
      setTimeout(open, 2000);
    };
  }
  open();
  return { send: (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj)), close() { closed = true; ws?.close(); } };
}

// Replay: a recorded real session, played back through the same view. Long gaps are shortened so the demo stays watchable.
export function replay(data, { onMessage, onStart, onEnd, maxGap = 1400, loopAfter = 5000 } = {}) {
  let timers = [], stopped = false;
  function play() {
    onStart?.();
    let clock = 0, prev = 0;
    for (const { t, msg } of data.events) {
      clock += Math.min(t - prev, maxGap);
      prev = t;
      timers.push(setTimeout(() => onMessage(msg), clock));
    }
    timers.push(setTimeout(() => { onEnd?.(); if (!stopped && loopAfter) timers.push(setTimeout(play, loopAfter)); }, clock + 600));
  }
  play();
  return { stop() { stopped = true; timers.forEach(clearTimeout); timers = []; } };
}

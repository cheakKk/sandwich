// Drives the real session page in headless Edge over the DevTools protocol and checks the live DOM, including that the
// strict Content Security Policy does not break anything (no script errors, no "Refused to ..." console errors).
// Skipped if Edge is not installed (set EDGE to its path to run it elsewhere).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import WebSocket from 'ws';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!existsSync(EDGE)) { console.log('ok (skipped: Edge not found)'); process.exit(0); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = process.env.HOST_TOKEN;
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sandwich-edge-'))}`, '--remote-debugging-port=9333', 'about:blank'], { stdio: 'ignore' });
let cdp, bot;
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { await wait(250); } }
  assert(targets, 'Edge started');
  cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r));
  let id = 0;
  const waiting = new Map();
  const problems = [];
  cdp.on('message', (m) => {
    const e = JSON.parse(m);
    if (e.id && waiting.has(e.id)) waiting.get(e.id)(e.result);
    else if (e.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text));
    else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') problems.push('console: ' + e.params.entry.text + ' ' + (e.params.entry.url ?? ''));
  });
  const call = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const read = async (js) => (await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })).result.value;
  const text = (sel) => read(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Log.enable');
  // a saved name (so no dialog) and a hook that remembers the page's sockets, so the test can drop one
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('sandwich-name','uitest'); (() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (...a) { const s = new W(...a); window.__ws.push(s); return s; }; window.WebSocket.prototype = W.prototype; })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:3000/#${T}` });
  await wait(2500);

  assert.equal(await read('document.title'), 'Session | Sandwich');
  assert.equal((await text('#conn')).trim(), 'Live');
  assert.match(await text('.sx-feed'), /uitest joined/, 'history replayed');
  assert.match(await text('.sx-feed'), /Quick review|This session is new/, 'recap shown to the joiner');
  assert.match(await text('.sx-people'), /uitest[\s\S]*owner/, 'people list shows me as owner');
  assert.match(await text('.sx-rail'), /Guarded/, 'trust setting is visible');
  assert(await read("document.querySelector('#mode-guarded').checked"), 'Guarded is selected');
  assert(await read("document.querySelector('.sx-rail .seg input:disabled') === null"), 'the owner can change the setting');
  assert.match(await text('.sx-side'), /Nothing saved yet|Done|Decisions/, 'memory panel is filled in');

  bot = new WebSocket('ws://127.0.0.1:3000/');
  await new Promise((r) => bot.on('open', r));
  bot.send(JSON.stringify({ type: 'auth', token: T, name: 'bot' }));
  await wait(500);
  bot.send(JSON.stringify({ text: 'run: ls' }));
  await wait(1200);
  assert.match(await text('.sx-now'), /The kitchen is on bot's order/, 'busy line names who the agent is working for');
  assert.match(await text('.sx-approval'), /Bash[\s\S]*ls/, 'approval card shows the full tool input');
  assert(await read("document.querySelectorAll('.ticket').length >= 1"), 'the order is shown as a ticket');
  bot.send(JSON.stringify({ type: 'typing' }));
  await wait(600);
  assert.match(await text('.sx-typing'), /is typing/);

  // the page reconnects on its own after a dropped connection
  await call('Runtime.evaluate', { expression: 'window.__ws.at(-1).close(3000)' });
  await wait(300);
  assert.match(await text('.sx-now'), /reconnecting|The kitchen/i);
  await wait(3000);
  assert.equal((await text('#conn')).trim(), 'Live', 'reconnected');
  assert.match(await text('.sx-feed'), /uitest joined/, 'history replayed again after reconnect');

  // the recorded real session replays through the same component
  await call('Page.navigate', { url: 'http://127.0.0.1:3000/?demo' });
  await wait(9000);
  assert.equal((await text('#conn')).trim(), 'Recording');
  assert.match(await text('.sx-feed'), /Read src\/auth\.js/, 'the recorded session plays');
  assert.match(await text('.sx-people'), /Maya[\s\S]*Jon/, 'recorded people are shown');

  // fonts and the icon sprite load from our own server only
  const external = await read(`performance.getEntriesByType('resource').filter((r) => !r.name.startsWith(location.origin)).map((r) => r.name)`);
  assert.deepEqual(external, [], 'the page loads nothing from other sites');
  assert.deepEqual(problems, [], 'no script errors and no CSP violations');
  console.log('ok');
} finally {
  bot?.close();
  cdp?.close();
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); // Edge leaves child processes behind otherwise
  else edge.kill();
  await wait(800);
}

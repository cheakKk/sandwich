// Drives the real page in headless Edge over the DevTools protocol and checks the live DOM.
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
  const errors = [];
  cdp.on('message', (m) => {
    const e = JSON.parse(m);
    if (e.id && waiting.has(e.id)) waiting.get(e.id)(e.result);
    else if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
  });
  const call = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const read = async (js) => (await call('Runtime.evaluate', { expression: js, returnByValue: true })).result.value;
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('u','uitest')" });
  await call('Page.navigate', { url: `http://127.0.0.1:3000/#${T}` });
  await wait(2500);

  assert.equal(await read('document.title'), 'Sandwich (owner)');
  assert(await read("document.getElementById('log').textContent.includes('uitest joined')"), 'history replayed');
  assert(await read("/Quick review|This session is new/.test(document.getElementById('log').textContent)"), 'recap shown to the joiner');

  bot = new WebSocket(`ws://127.0.0.1:3000/?t=${T}&n=bot`);
  await new Promise((r) => bot.on('open', r));
  bot.send(JSON.stringify({ text: 'run: ls' }));
  await wait(1200);
  assert.equal(await read("document.getElementById('status').textContent"), 'agent is working');
  assert(await read("!!document.querySelector('.ask') && document.querySelector('.ask pre').textContent.includes('ls')"), 'approval card shows the full tool input');
  bot.send(JSON.stringify({ type: 'typing' }));
  await wait(600);
  assert.match(await read("document.getElementById('status').textContent"), /bot is typing/);

  await call('Runtime.evaluate', { expression: 'ws.close(3000)' });
  await wait(300);
  assert.match(await read("document.getElementById('status').textContent"), /reconnecting/);
  await wait(2800);
  assert(await read('ws.readyState === 1'), 'page reconnected on its own');
  assert(await read("document.getElementById('log').textContent.includes('uitest joined')"), 'history replayed again after reconnect');
  assert.deepEqual(errors, [], 'no script errors (this also proves the CSP does not break the page)');
  console.log('ok');
} finally {
  bot?.close();
  cdp?.close();
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); // Edge leaves child processes behind otherwise
  else edge.kill();
  await wait(800);
}

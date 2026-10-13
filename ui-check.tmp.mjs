// Temporary: drive the real page in headless Edge over the DevTools protocol and read the live DOM.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = process.env.T;
const edgeDir = mkdtempSync(join(tmpdir(), 'sandwich-edge-'));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--user-data-dir=${edgeDir}`, '--remote-debugging-port=9333', 'about:blank'], { stdio: 'ignore' });
edge.on('error', (e) => { console.log('edge failed to start:', e.message); process.exit(1); });
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { await wait(250); } }
  const page = targets.find((t) => t.type === 'page');
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r));
  let id = 0; const pendingCalls = new Map(); const errors = [];
  cdp.on('message', (m) => { const e = JSON.parse(m); if (e.id && pendingCalls.has(e.id)) pendingCalls.get(e.id)(e.result); else if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text); });
  const call = (method, params = {}) => new Promise((r) => { pendingCalls.set(++id, r); cdp.send(JSON.stringify({ id, method, params })); });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('u','uitest')" });
  await call('Page.navigate', { url: `http://127.0.0.1:3000/#${T}` });
  await wait(2500);
  const read = async (js) => (await call('Runtime.evaluate', { expression: js, returnByValue: true })).result.value;
  console.log('title:', await read('document.title'));
  console.log('log has "uitest joined":', await read("document.getElementById('log').textContent.includes('uitest joined')"));
  console.log('recap shown:', await read("/Quick review|This session is new/.test(document.getElementById('log').textContent)"));
  console.log('status line (idle):', JSON.stringify(await read("document.getElementById('status').textContent")));
  const bot = new WebSocket(`ws://127.0.0.1:3000/?t=${T}&n=bot`); await new Promise((r) => bot.on('open', r));
  bot.send(JSON.stringify({ text: 'run: ls' })); await wait(1200);
  console.log('status line (busy):', JSON.stringify(await read("document.getElementById('status').textContent")));
  console.log('approval card shown:', await read("!!document.querySelector('.ask') && document.querySelector('.ask pre').textContent.includes('ls')"));
  bot.send(JSON.stringify({ type: 'typing' })); await wait(600);
  console.log('status line (typing):', JSON.stringify(await read("document.getElementById('status').textContent")));
  await call('Runtime.evaluate', { expression: 'ws.close(3000)' }); await wait(300);
  console.log('status while reconnecting:', JSON.stringify(await read("document.getElementById('status').textContent")));
  await wait(2800);
  console.log('reconnected (socket open):', await read('ws.readyState === 1'), '| log refilled:', await read("document.getElementById('log').textContent.includes('uitest joined')"));
  console.log('script errors:', JSON.stringify(errors));
  bot.close();
} finally { edge.kill(); }
process.exit(0);

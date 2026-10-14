// Screenshots a page at several scroll positions through headless Edge (DevTools protocol), for design review.
// node tools/shoot.mjs <url> <out-prefix> [width=1440] [height=900] [steps=1] [first-wait-ms=1500]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const [url, prefix, w = '1440', h = '900', steps = '1', firstWait = '1500'] = process.argv.slice(2);
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shoot-'))}`, '--remote-debugging-port=9444', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9444/json')).json(); } catch { await wait(250); } }
  const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r));
  let id = 0; const waiting = new Map();
  cdp.on('message', (m) => { const e = JSON.parse(m); if (e.id && waiting.has(e.id)) waiting.get(e.id)(e.result); });
  const call = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); cdp.send(JSON.stringify({ id, method, params })); });
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 600 });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('sandwich-name','Guest')" });
  await call('Page.navigate', { url });
  await wait(+firstWait);
  const total = (await call('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true })).result.value;
  const ov = (await call('Runtime.evaluate', { expression: "JSON.stringify({scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((e) => e.tagName + '.' + e.className)})", returnByValue: true })).result.value;
  console.log('page height', total, ov);
  for (let i = 0; i < +steps; i++) {
    const y = i * (+h - 80);
    await call('Runtime.evaluate', { expression: `window.scrollTo(0, ${y})` });
    await wait(i ? 900 : 100);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${prefix}-${i + 1}.png`, Buffer.from(shot.data, 'base64'));
  }
  cdp.close();
} finally {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); else edge.kill();
  await wait(500);
}

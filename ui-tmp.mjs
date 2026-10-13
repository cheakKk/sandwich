import WebSocket from 'ws';
const w = new WebSocket('ws://127.0.0.1:3000/?t=' + process.env.T + '&n=bot');
w.on('open', () => { w.send(JSON.stringify({ text: 'run: ls' })); setTimeout(() => process.exit(0), 300); });

// Answers what the Daytona docs leave open, on a free Tier 1 account:
// can we lock a sandbox's network down per sandbox, and what gets out by default?
// Run: node --env-file=secrets.env tools/daytona-probe.mjs
// Each sandbox is tiny (1 vCPU, 1 GiB), ephemeral, and deleted at the end even on error.
const KEY = process.env.DAYTONA_API_KEY;
if (!KEY) throw new Error('DAYTONA_API_KEY is empty in secrets.env');
const API = 'https://app.daytona.io/api';
const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: auth, body: body && JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.replace(API, '')} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ponytail: fixed 2 minute poll, enough for a small default snapshot
async function waitStarted(id) {
  for (let i = 0; i < 60; i++) {
    const s = await call('GET', `${API}/sandbox/${id}`);
    if (s.state === 'started') return s;
    if (/error|failed/i.test(s.state)) throw new Error(`sandbox ${id} state ${s.state}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`sandbox ${id} never started`);
}

const exec = (s, command) => call('POST', `${s.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox'}/${s.id}/process/execute`, { command, timeout: 15 })
  .then((r) => `${r.exitCode}: ${String(r.result).trim().slice(0, 120)}`, (e) => `error: ${e.message}`);

const targets = {
  'allowed domain (api.anthropic.com)': 'https://api.anthropic.com',
  'github.com': 'https://github.com',
  'example.com (not essential)': 'https://example.com',
  'cloud metadata 169.254.169.254': 'http://169.254.169.254/',
  'private 10.0.0.1': 'http://10.0.0.1/',
};
const curl = (u) => `sh -c "curl -s -o /dev/null -w %{http_code} --max-time 5 ${u} || echo blocked"`;

const variants = {
  default: {},
  domainAllowList: { domainAllowList: 'api.anthropic.com' },
  networkBlockAll: { networkBlockAll: true },
};

for (const [name, net] of Object.entries(variants)) {
  console.log(`\n== ${name}`);
  let s;
  try {
    s = await call('POST', `${API}/sandbox`, { cpu: 1, memory: 1, disk: 3, ephemeral: true, autoDeleteInterval: 0, labels: { purpose: 'probe' }, ...net });
    s = await waitStarted(s.id);
    console.log('whoami ->', await exec(s, 'id'));
    for (const [label, url] of Object.entries(targets)) console.log(`${label} ->`, await exec(s, curl(url)));
  } catch (e) {
    console.log('failed:', e.message);
  } finally {
    if (s?.id) await call('DELETE', `${API}/sandbox/${s.id}`).then(() => console.log('deleted', s.id), (e) => console.log('DELETE FAILED, remove by hand:', s.id, e.message));
  }
}

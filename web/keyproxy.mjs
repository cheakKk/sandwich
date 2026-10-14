// The credential proxy: the only place a host's real API key is ever opened. The sandbox gets a token (not the key) and a
// base URL that points here. Every request is checked (token, exact path, model), costed before it is sent, and the
// response is passed through with provider error text replaced. Spend is recorded here, so this is the truth about cost.
import http from 'node:http';
import { Readable } from 'node:stream';
import { unbox } from './crypto.mjs';

// $ per million tokens, deliberately on the high side so the budget errs toward stopping early. The provider's dashboard is the real bill.
const PRICES = { opus: [15, 75], sonnet: [3, 15], haiku: [1, 5], fable: [15, 75] };
const MODEL = /^claude-(opus|sonnet|haiku|fable)-[\w.-]{1,40}$/;
const PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const PASS_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta']; // never auth headers, host, cookies or forwarding headers
const KNOWN_ERRORS = new Set(['invalid_request_error', 'rate_limit_error', 'overloaded_error', 'not_found_error', 'request_too_large', 'api_error']);
const MAX_BODY = 8 * 1024 * 1024;

export const priceOf = (model) => PRICES[MODEL.exec(model)?.[1]];
export const costUsd = (model, u) => {
  const [pin, pout] = priceOf(model);
  return (((u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) * pin + (u.output_tokens ?? 0) * pout) / 1e6;
};

export function createKeyProxy({ store, privateKey, upstream = 'https://api.anthropic.com', defaultBudgetUsd = 10, fetchFn = fetch, log = () => {} }) {
  const reserved = new Map(); // sessionId -> dollars promised to requests still in flight
  const held = (sid) => reserved.get(sid) ?? 0;

  const fail = (res, code, type, message) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const parts = []; let n = 0, over = false;
    req.on('data', (d) => { if (over) return; n += d.length; if (n > MAX_BODY) { over = true; parts.length = 0; reject(Object.assign(new Error('too large'), { code: 413 })); } else parts.push(d); });
    req.on('end', () => !over && resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const token = req.headers['x-api-key'] || String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.method !== 'POST' || !PATHS.has(url.pathname)) return fail(res, 404, 'not_found_error', 'not found');
    const session = store.sessionByProxyToken(token);
    if (!session || !session.key_sealed) return fail(res, 401, 'authentication_error', 'invalid credentials');

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return fail(res, e.code === 413 ? 413 : 400, 'invalid_request_error', e.code === 413 ? 'request too large' : 'bad request'); }
    if (!body || typeof body.model !== 'string' || !MODEL.test(body.model)) return fail(res, 400, 'invalid_request_error', 'model not allowed');
    const counting = url.pathname.endsWith('/count_tokens');
    if (!counting && !(Number.isInteger(body.max_tokens) && body.max_tokens > 0)) return fail(res, 400, 'invalid_request_error', 'max_tokens is required');

    // Reserve the worst case before sending, in one synchronous step, so parallel requests cannot all pass the same check.
    let reserve = 0;
    if (!counting) {
      const [pin, pout] = priceOf(body.model);
      const inputCost = (Math.ceil(JSON.stringify(body).length / 3) * 1.25 * pin) / 1e6;
      const remaining = (session.budget_usd ?? defaultBudgetUsd) - store.spentUsd(session.id) - held(session.id);
      const room = Math.floor(((remaining - inputCost) / pout) * 1e6); // output tokens the budget can still pay for
      if (room < 1) return fail(res, 402, 'invalid_request_error', 'the session budget is used up');
      body.max_tokens = Math.min(body.max_tokens, room); // the reply cannot cost more than what is left
      reserve = inputCost + (body.max_tokens * pout) / 1e6;
      reserved.set(session.id, held(session.id) + reserve);
    }
    let settled = false;
    const settle = (usd, tin = 0, tout = 0) => { // exactly once: release the reservation, write what was actually spent
      if (settled) return; settled = true;
      if (reserve) { reserved.set(session.id, Math.max(0, held(session.id) - reserve)); store.addLedger(session.id, tin, tout, usd); }
    };

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const key = unbox(privateKey, session.key_sealed, session.id);
      const headers = { 'x-api-key': key };
      for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = String(req.headers[h]);
      headers['content-type'] = 'application/json';
      const r = await fetchFn(upstream + url.pathname + (url.searchParams.get('beta') === 'true' ? '?beta=true' : ''), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60 * 1000)]) });

      if (!r.ok) { // never pass the provider's error text on: it can name the account or the key
        let type = 'api_error';
        try { const e = JSON.parse((await r.text()).slice(0, 65536)); if (KNOWN_ERRORS.has(e?.error?.type)) type = e.error.type; } catch { /* generic */ }
        settle(0);
        if (r.status === 401 || r.status === 403) return fail(res, 502, 'api_error', "the provider rejected the host's API key");
        return fail(res, [400, 404, 413, 429, 500, 529].includes(r.status) ? r.status : 502, type, 'the provider could not complete the request');
      }

      const stream = /text\/event-stream/.test(r.headers.get('content-type') ?? '');
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
      const usage = {}; let sawEnd = false, tail = '';
      const note = (u) => { if (u) for (const k of Object.keys(u)) if (typeof u[k] === 'number') usage[k] = u[k]; };
      if (!stream) {
        const text = await r.text();
        try { note(JSON.parse(text).usage); sawEnd = true; } catch { /* not json: charged in full below */ }
        res.end(text);
      } else {
        for await (const chunk of Readable.fromWeb(r.body)) {
          res.write(chunk);
          tail += chunk.toString('utf8');
          const lines = tail.split('\n'); tail = lines.pop();
          for (const l of lines) {
            if (!l.startsWith('data: ')) continue;
            try { const e = JSON.parse(l.slice(6)); if (e.type === 'message_start') note(e.message?.usage); if (e.type === 'message_delta') { note(e.usage); sawEnd = true; } } catch { /* partial or non-json line */ }
          }
        }
        res.end();
      }
      // a reply we could not read a usage figure from is charged what was reserved, never less
      if (counting) return settle(0);
      settle(sawEnd ? costUsd(body.model, usage) : reserve, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
    } catch (e) {
      log('proxy error:', e.name === 'AbortError' ? 'client went away' : e.message);
      settle(reserve); // an interrupted stream is charged in full: we cannot know how much was generated
      fail(res, 502, 'api_error', 'the provider could not be reached');
    }
  };
}

export function listen(handler, port, host = '127.0.0.1') {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

// Sign-in providers. Each gives authorizeUrl() and exchange(); exchange returns only {subject, name}: a stable provider id and a
// display name. We never ask for or store email. The "dev" provider exists for local runs and tests and refuses to exist in production.
import { pkceChallenge } from './crypto.mjs';

const form = (o) => new URLSearchParams(o).toString();
const post = async (fetchFn, url, body) => {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  return r.json();
};

export function google({ clientId, clientSecret, fetchFn = fetch }) {
  return {
    id: 'google',
    authorizeUrl: ({ redirectUri, state, challenge, nonce }) => 'https://accounts.google.com/o/oauth2/v2/auth?' + form({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }),
    async exchange({ code, redirectUri, verifier, nonce }) {
      // the id_token arrives straight from Google's token endpoint over TLS, which OIDC allows us to trust without checking its signature; the claims are still checked
      const t = await post(fetchFn, 'https://oauth2.googleapis.com/token', { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
      const c = JSON.parse(Buffer.from(String(t.id_token).split('.')[1] ?? '', 'base64url'));
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== clientId || !(c.exp * 1000 > Date.now()) || c.nonce !== nonce || !c.sub) throw new Error('bad id_token');
      return { subject: String(c.sub), name: c.given_name || c.name || 'host' };
    },
  };
}

export function github({ clientId, clientSecret, fetchFn = fetch }) {
  return {
    id: 'github',
    authorizeUrl: ({ redirectUri, state, challenge }) => 'https://github.com/login/oauth/authorize?' + form({ client_id: clientId, redirect_uri: redirectUri, scope: 'read:user', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'true' }),
    async exchange({ code, redirectUri, verifier }) {
      const t = await post(fetchFn, 'https://github.com/login/oauth/access_token', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier });
      if (!t.access_token) throw new Error('no access token');
      const r = await fetchFn('https://api.github.com/user', { headers: { authorization: 'Bearer ' + t.access_token, accept: 'application/vnd.github+json', 'user-agent': 'sandwich' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      const u = await r.json();
      if (!r.ok || !Number.isInteger(u.id)) throw new Error('bad github user');
      return { subject: String(u.id), name: u.login || 'host' }; // the numeric id is the identity; logins can be renamed and reused
    },
  };
}

// A fake identity provider: "consent" is instant, and the code carries the name and the PKCE challenge so exchange() can check them.
export function dev() {
  return {
    id: 'dev',
    authorizeUrl: ({ redirectUri, state, challenge, who = 'dev' }) => `${redirectUri}?` + form({ state, code: `${encodeURIComponent(who)}:${challenge}` }),
    async exchange({ code, verifier }) {
      const [who, challenge] = String(code).split(':');
      if (!challenge || pkceChallenge(verifier) !== challenge) throw new Error('PKCE check failed');
      return { subject: 'dev-' + decodeURIComponent(who), name: decodeURIComponent(who) };
    },
  };
}

export function fromEnv(env, fetchFn) {
  const list = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) list.push(google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, fetchFn }));
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) list.push(github({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, fetchFn }));
  if (env.SANDWICH_DEV_AUTH === '1') {
    if (env.NODE_ENV === 'production') throw new Error('SANDWICH_DEV_AUTH must not be set in production');
    list.push(dev());
  }
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

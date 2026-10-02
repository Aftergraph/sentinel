#!/usr/bin/env node
// Rotate the Sentinel GitHub App webhook secret on the host, so the secret is
// generated, stored and registered without ever leaving the machine.
//
//   node bin/sentinel-github-webhook-secret.mjs check  <env-file>
//   node bin/sentinel-github-webhook-secret.mjs rotate <env-file> [https://<name>.aftergraph.org/webhooks/github]
//
// Run as root through /usr/local/sbin/sentinel-deploy. `check` reads the App's
// webhook config (host only, never the secret). `rotate` writes a new secret to
// a temp file next to <env-file>, PATCHes /app/hook/config with it, and only
// then renames the temp file into place. A failed PATCH leaves the env untouched.
// The secret is never printed.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chownSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createAppJwt } from '../apps/github/platform.js';

const API = 'https://api.github.com';

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function setEnvValue(text, key, value) {
  const lines = String(text).split('\n');
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, `${key}=${value}`);
    else next.push(`${key}=${value}`);
  }
  return next.join('\n');
}

async function hookReq(fetchFn, jwt, method, body) {
  const res = await fetchFn(`${API}/app/hook/config`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'aftergraph-sentinel-webhook-secret',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} /app/hook/config -> ${res.status}`);
  return data;
}

export const WEBHOOK_URL_RE = /^https:\/\/[a-z0-9-]+\.aftergraph\.org\/webhooks\/github$/;

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export async function run(mode, envPath, { fetchImpl, randomHex, fs: fsi, url } = {}) {
  const fetchFn = fetchImpl || fetch;
  const f = fsi || { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chownSync, openSync, fsyncSync, closeSync };
  if (mode !== 'check' && mode !== 'rotate') throw new Error('mode must be check or rotate');
  if (url && mode !== 'rotate') throw new Error('a webhook URL can only be set with rotate');
  if (url && !WEBHOOK_URL_RE.test(url)) throw new Error('webhook URL must be https://<name>.aftergraph.org/webhooks/github');
  const envText = f.readFileSync(envPath, 'utf8');
  const env = parseEnv(envText);
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_KEY_FILE) throw new Error('env lacks GITHUB_APP_ID or GITHUB_APP_KEY_FILE');
  const jwt = createAppJwt({ appId: env.GITHUB_APP_ID, privateKeyPem: f.readFileSync(env.GITHUB_APP_KEY_FILE, 'utf8') });
  const config = await hookReq(fetchFn, jwt, 'GET');
  const summary = {
    mode,
    webhook_host: hostOf(config.url),
    content_type: config.content_type || '',
    local_secret_set: Boolean(env.GITHUB_WEBHOOK_SECRET),
  };
  if (mode === 'check') return summary;
  if (!config.url && !url) throw new Error('the App has no webhook URL; set one before rotating');

  const secret = randomHex ? randomHex() : randomBytes(32).toString('hex');
  const st = f.statSync(envPath);
  const tmp = `${envPath}.rotate-${process.pid}`;
  f.writeFileSync(tmp, setEnvValue(envText, 'GITHUB_WEBHOOK_SECRET', secret), { mode: st.mode & 0o777 });
  try {
    f.chownSync(tmp, st.uid, st.gid);
    const fd = f.openSync(tmp, 'r'); f.fsyncSync(fd); f.closeSync(fd);
    await hookReq(fetchFn, jwt, 'PATCH', url ? { secret, url, content_type: 'json' } : { secret });
  } catch (err) {
    try { f.unlinkSync(tmp); } catch {}
    throw err;
  }
  f.renameSync(tmp, envPath);
  return { ...summary, ...(url ? { webhook_host: hostOf(url), url_changed: hostOf(url) !== summary.webhook_host } : {}), rotated: true, local_secret_set: true };
}

const invoked = process.argv[1] && process.argv[1].endsWith('sentinel-github-webhook-secret.mjs');
if (invoked) {
  const [mode, envPath, url] = process.argv.slice(2);
  run(mode, envPath || '/etc/sentinel/github-app.env', { url: url || undefined })
    .then((r) => { console.log(JSON.stringify(r)); })
    .catch((err) => { console.error(`sentinel-github-webhook-secret: ${err.message}`); process.exit(1); });
}

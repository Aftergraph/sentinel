import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { parseEnv, setEnvValue, run } from '../bin/sentinel-github-webhook-secret.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

function memFs(files) {
  const store = { ...files };
  return {
    store,
    readFileSync: (p) => { if (!(p in store)) throw new Error(`ENOENT ${p}`); return store[p]; },
    writeFileSync: (p, d) => { store[p] = d; },
    renameSync: (a, b) => { store[b] = store[a]; delete store[a]; },
    unlinkSync: (p) => { delete store[p]; },
    statSync: () => ({ mode: 0o100640, uid: 0, gid: 999 }),
    chownSync: () => {}, openSync: () => 3, fsyncSync: () => {}, closeSync: () => {},
  };
}
const ENV = '# c\nGITHUB_WEBHOOK_SECRET=\nGITHUB_APP_ID=5144112\nGITHUB_APP_KEY_FILE=/k.pem\nPORT=8787\n';

function fakeFetch({ patchStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ url: 'https://hook.example.org/webhooks/github', content_type: 'json' }) };
    return { ok: patchStatus < 300, status: patchStatus, json: async () => ({}) };
  };
  return { fn, calls };
}

test('setEnvValue replaces in place and appends when absent', () => {
  assert.equal(setEnvValue('A=1\nB=2\n', 'B', 'x'), 'A=1\nB=x\n');
  assert.equal(setEnvValue('A=1\n', 'B', 'x'), 'A=1\nB=x\n');
  assert.equal(parseEnv(ENV).GITHUB_APP_ID, '5144112');
});

test('check reads hook host only and changes nothing', async () => {
  const fs = memFs({ '/e.env': ENV, '/k.pem': pem });
  const { fn, calls } = fakeFetch();
  const r = await run('check', '/e.env', { fetchImpl: fn, fs });
  assert.deepEqual(r, { mode: 'check', webhook_host: 'hook.example.org', content_type: 'json', local_secret_set: false });
  assert.equal(calls.length, 1);
  assert.equal(fs.store['/e.env'], ENV);
});

test('rotate PATCHes GitHub, then swaps the env; secret never in the summary', async () => {
  const fs = memFs({ '/e.env': ENV, '/k.pem': pem });
  const { fn, calls } = fakeFetch();
  const r = await run('rotate', '/e.env', { fetchImpl: fn, fs, randomHex: () => 'ab'.repeat(32) });
  assert.equal(r.rotated, true);
  assert.ok(!JSON.stringify(r).includes('abab'));
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body), { secret: 'ab'.repeat(32) });
  assert.match(fs.store['/e.env'], /^GITHUB_WEBHOOK_SECRET=(ab){32}$/m);
  assert.deepEqual(Object.keys(fs.store).sort(), ['/e.env', '/k.pem']);
});

test('a failed PATCH leaves the env untouched and removes the temp file', async () => {
  const fs = memFs({ '/e.env': ENV, '/k.pem': pem });
  const { fn } = fakeFetch({ patchStatus: 403 });
  await assert.rejects(run('rotate', '/e.env', { fetchImpl: fn, fs }), /PATCH \/app\/hook\/config -> 403/);
  assert.equal(fs.store['/e.env'], ENV);
  assert.deepEqual(Object.keys(fs.store).sort(), ['/e.env', '/k.pem']);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { check as strictEquality } from '../lib/rules/require-strict-equality.js';
import { check as cicdSecrets } from '../lib/rules/no-secrets-in-cicd-config.js';
import { check as localhost } from '../lib/rules/no-hardcoded-localhost-url-in-diff.js';
import { check as nestedFetch } from '../lib/rules/require-dataloader-or-eager-load-for-nested-fetches.js';
import { check as nPlusOne } from '../lib/rules/no-n-plus-one-queries-in-api-resolvers.js';

function diff(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 111..222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,' + (lines.length + 1) + ' @@',
    ' keep();',
    ...lines.map((line) => '+' + line),
    ''
  ].join('\n');
}

test('strict equality rule ignores operator-like text inside string and template literals', () => {
  const d=diff('src/contracts.js',[
    "const invariants=['execution != verification','approval != execution'];",
    "const msg=`preview != approval`;"
  ]);
  assert.deepEqual(strictEquality(d),[]);
});

test('strict equality rule still catches live loose operators outside literals', () => {
  const d=diff('src/contracts.js',["if (a != b || c == d) return true;"]);
  assert.ok(strictEquality(d).length>=1);
});

test('CI secret rule ignores command names such as secret:scan', () => {
  const d=diff('.github/workflows/ci.yml',[
    '      - run: npm run secret:scan',
    '      - name: Secret scan'
  ]);
  assert.deepEqual(cicdSecrets(d),[]);
});

test('CI secret rule still catches literal credential-shaped keys', () => {
  const d=diff('.github/workflows/deploy.yml',[
    '      password: literal-password-value'
  ]);
  assert.equal(cicdSecrets(d).length,1);
});

test('localhost rule ignores docs and explicit conformance/smoke/acceptance harnesses', () => {
  const cases=[
    diff('docs/local.md',['http://127.0.0.1:4173/api']),
    diff('scripts/operator-official-mcp-conformance.mjs',["const u=new URL('http://127.0.0.1:4173/api');"]),
    diff('scripts/operator-runtime-smoke.mjs',["const u='http://localhost:4173';"]),
    diff('scripts/operator-vds-active-service-acceptance.mjs',["const u='http://127.0.0.1:4173';"])
  ];
  for(const d of cases) assert.deepEqual(localhost(d),[]);
});

test('localhost rule still catches production source literals', () => {
  const d=diff('src/client.mjs',["const api='http://127.0.0.1:4173/api';"]);
  assert.equal(localhost(d).length,1);
});

test('nested-fetch rule ignores generic protocol getters', () => {
  const d=diff('src/operator.mjs',[
    'const resolveTool = async () => {',
    "  assert.equal(client.getProtocolEra(),'modern');",
    '};'
  ]);
  assert.deepEqual(nestedFetch(d),[]);
});

test('nested-fetch rule still catches nested repository query shapes', () => {
  const d=diff('src/operator.mjs',[
    'const resolver = async () => {',
    '  return repo.findOne({ id });',
    '};'
  ]);
  assert.equal(nestedFetch(d).length,1);
});

test('N+1 rule ignores Array.find inside a map loop', () => {
  const d=diff('src/operator.mjs',[
    'const rows = tools.map((tool) => {',
    '  const live = listed.tools.find((item) => item.name === tool.name);',
    '  return live;',
    '});'
  ]);
  assert.deepEqual(nPlusOne(d),[]);
});

test('N+1 rule still catches DB find inside a loop', () => {
  const d=diff('src/operator.mjs',[
    'const rows = ids.map((id) => {',
    '  return db.users.find({ id });',
    '});'
  ]);
  assert.equal(nPlusOne(d).length,1);
});

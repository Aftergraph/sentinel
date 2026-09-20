import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const script=join(here,'..','scripts','ops','activate-production-simplification-verifier.sh');
const source=readFileSync(script,'utf8');

test('production activation script is valid bash',()=>{
  execFileSync('bash',['-n',script],{stdio:'pipe'});
});

test('activation pins the exact production host and reviewed Sentinel revision',()=>{
  for(const fragment of [
    'vmi3517816',
    '3189785fc8ce866244c51f9611f93d19c191331c',
    'WORKS_ROOT="/root/works-venture"',
    'WORKS_HELPER="$WORKS_ROOT/scripts/ops/works-verifier-credential.sh"',
    '/etc/works/works.env',
    'works-api.service',
    'http://127.0.0.1:18191',
    '/opt/aftergraph/sentinel',
    '/etc/sentinel/sentinel.env',
    'aftergraph-sentinel.service',
    'http://127.0.0.1:8787',
  ]){
    assert.ok(source.includes(fragment),`missing canonical production pin: ${fragment}`);
  }
});

test('activation preserves the root boundary instead of weakening the runner',()=>{
  for(const fragment of [
    '[[ "${EUID:-$(id -u)}" -eq 0 ]]',
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'User=sentinel',
    'Group=sentinel',
    'ReadWritePaths=$SENTINEL_STATE',
  ]){
    assert.ok(source.includes(fragment),`missing service boundary: ${fragment}`);
  }
  for(const forbidden of [
    'chmod 777',
    'NOPASSWD:',
    'set -x',
    'NoNewPrivileges=false',
    'ProtectSystem=false',
  ]){
    assert.equal(source.includes(forbidden),false,`forbidden privilege weakening: ${forbidden}`);
  }
});

test('activation uses canonical WORKS helper and fail-closed 503 to 401 proof',()=>{
  assert.ok(source.includes('"$WORKS_HELPER" enable'));
  assert.ok(source.includes('"verification_ingest":"unconfigured"'));
  assert.ok(source.includes('"verification_ingest":"configured"'));
  assert.ok(source.includes('WRONG_TOKEN_STATUS'));
  assert.ok(source.includes('[[ "$WRONG_TOKEN_STATUS" == "401" ]]'));
});

test('activation never prints either shared credential',()=>{
  for(const forbidden of [
    'echo "$WORKS_VERIFIER_TOKEN"',
    'echo "$WORKS_ENROLL_SECRET"',
    'printf \'%s\\n\' "$WORKS_VERIFIER_TOKEN"',
    'printf \'%s\\n\' "$WORKS_ENROLL_SECRET"',
    'credential":"$WORKS_VERIFIER_TOKEN"',
  ]){
    assert.equal(source.includes(forbidden),false,`credential output pattern present: ${forbidden}`);
  }
  assert.ok(source.includes('"credential_value_exposed":false'));
});

test('live proof uses a real terminal WORKS execution before semantic ingest',()=>{
  const create=source.indexOf('"queue": true');
  const succeeded=source.indexOf('[[ "$WORK_STATE" == "SUCCEEDED" ]]');
  const verify=source.indexOf('/api/simplification/verify');
  assert.ok(create>=0&&succeeded>create&&verify>succeeded);
  assert.ok(source.includes('"run": "true"'));
  assert.ok(source.includes('"production_access": false'));
});

test('live simplification claim is exact-revision and obligation bound',()=>{
  for(const fragment of [
    '5c0baed576dda766560d2b471cd303c2b02d847a',
    '720283d58fcd9fea99df444ade2d6a2b06bff0a7',
    '35478850558#proof=exact-revision-evidence',
    '35478852092#proof=repository-native-gates-pass',
    '35478850558#proof=behavior-preserved&step=Canonical%20%2B%20semantic%20equivalence',
    '35478852092#proof=canonical-owner-preserved',
    'Aftergraph/war-room:desktop/web/app.js',
    'aftergraph.code-simplification-output/1.1',
  ]){
    assert.ok(source.includes(fragment),`missing evidence binding: ${fragment}`);
  }
});

test('activation proves the same Sentinel receipt persisted into WORKS projection',()=>{
  const sentinelReadback=source.indexOf('/api/domain/verification/$RECEIPT_ID');
  const worksReadback=source.indexOf('/v1/works/$WORK_ID/evidence');
  assert.ok(sentinelReadback>=0&&worksReadback>sentinelReadback);
  assert.ok(source.includes('v.get("evidence_ref")==expected'));
  assert.ok(source.includes('v.get("verifier_id")=="sentinel:simplification"'));
  assert.ok(source.includes('v.get("status")=="passed"'));
});

test('activation has rollback for source, env, unit and newly activated WORKS credential',()=>{
  for(const fragment of [
    'trap rollback ERR INT TERM HUP',
    'cp -a -- "$BACKUP_ROOT/works.env" "$WORKS_ENV"',
    'systemctl restart "$WORKS_SERVICE"',
    'cp -a -- "$BACKUP_ROOT/sentinel.env" "$SENTINEL_ENV"',
    'cp -a -- "$BACKUP_ROOT/aftergraph-sentinel.service" "$SENTINEL_UNIT"',
    'mv -- "$BACKUP_ROOT/source" "$SENTINEL_ROOT"',
  ]){
    assert.ok(source.includes(fragment),`missing rollback invariant: ${fragment}`);
  }
});

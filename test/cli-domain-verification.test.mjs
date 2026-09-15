import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(args,env={}){
  return spawnSync(process.execPath,['bin/sentinel.js',...args],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,...env}});
}

test('serve help documents domain verification persistence flags',()=>{
  const out=run(['--help']);
  assert.equal(out.status,0);
  assert.match(out.stdout,/--domain-verification-store <p>/);
  assert.match(out.stdout,/--domain-verifier-ref <id>/);
});

test('serve fails closed on partial domain verification config',()=>{
  const onlyStore=run(['serve','--domain-verification-store','/tmp/domain.json']);
  assert.equal(onlyStore.status,1);
  assert.match(onlyStore.stderr,/requires both store path and verifier ref/);
  const onlyRef=run(['serve','--domain-verifier-ref','sentinel:test']);
  assert.equal(onlyRef.status,1);
  assert.match(onlyRef.stderr,/requires both store path and verifier ref/);
});
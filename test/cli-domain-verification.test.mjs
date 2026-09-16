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
});test('serve help documents bounded domain runtime wiring without secret flags',()=>{
  const out=run(['--help']);
  assert.equal(out.status,0);
  assert.match(out.stdout,/--domain-observer-url <url>/);
  assert.match(out.stdout,/--domain-observer-ref <id>/);
  assert.match(out.stdout,/--domain-works-url <url>/);
  assert.match(out.stdout,/SENTINEL_DOMAIN_OBSERVER_TOKEN/);
  assert.match(out.stdout,/SENTINEL_WORKS_VERIFIER_TOKEN/);
  assert.doesNotMatch(out.stdout,/--domain-observer-token/);
  assert.doesNotMatch(out.stdout,/--domain-works-verifier-token/);
});

test('serve fails closed on partial observer runtime config',()=>{
  const out=run(['serve','--domain-verification-store','/tmp/domain.json','--domain-verifier-ref','sentinel:test','--domain-observer-url','http://127.0.0.1:9','--domain-observer-ref','sentinel:observer:test'],{SENTINEL_DOMAIN_OBSERVER_TOKEN:''});
  assert.equal(out.status,1);
  assert.match(out.stderr,/domain observer requires url, ref and token/);
});
test('serve fails closed on partial WORKS publisher config',()=>{
  const out=run(['serve','--domain-verification-store','/tmp/domain.json','--domain-verifier-ref','sentinel:test','--domain-works-url','http://127.0.0.1:9'],{SENTINEL_WORKS_VERIFIER_TOKEN:''});
  assert.equal(out.status,1);
  assert.match(out.stderr,/domain WORKS publisher requires url and verifier token/);
});

test('serve refuses observer or publisher wiring without durable domain verification base config',()=>{
  const observer=run(['serve','--domain-observer-url','http://127.0.0.1:9','--domain-observer-ref','sentinel:observer:test'],{SENTINEL_DOMAIN_OBSERVER_TOKEN:'o'.repeat(32)});
  assert.equal(observer.status,1);
  assert.match(observer.stderr,/domain runtime wiring requires verification store and verifier ref/);
  const publisher=run(['serve','--domain-works-url','http://127.0.0.1:9'],{SENTINEL_WORKS_VERIFIER_TOKEN:'w'.repeat(32)});
  assert.equal(publisher.status,1);
  assert.match(publisher.stderr,/domain runtime wiring requires verification store and verifier ref/);
});

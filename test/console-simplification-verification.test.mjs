import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConsoleServer } from '../console/server.js';

const REQUIRED=[
  'exact-revision-evidence',
  'repository-native-gates-pass',
  'behavior-preserved',
  'canonical-owner-preserved',
];

function claim(overrides={}){
  const obligations=REQUIRED.map((id,index)=>({
    id,
    claim_status:'pass',
    evidence_refs:[`ev:simplification:${index+1}`],
  }));
  return {
    schema:'aftergraph.code-simplification-output/1.1',
    repository:'Aftergraph/runtime',
    baseline_revision:'a'.repeat(40),
    final_revision:'b'.repeat(40),
    skill_digest_sha256:`sha256:${'c'.repeat(64)}`,
    canonical_owner:'Aftergraph/runtime:packages/mission-routing',
    execution_status:'completed',
    changed_paths:['packages/mission-routing/src/placement-resolver.ts'],
    obligations,
    evidence_refs:obligations.flatMap(x=>x.evidence_refs),
    ...overrides,
  };
}

function requestBody(overrides={}){
  return {
    claim:claim(),
    missionId:'wrk_0123456789abcdef0123456789abcdef',
    executorRef:'runtime:simplifier-1',
    observedAt:'2026-09-20T09:10:00.000Z',
    ...overrides,
  };
}

async function boot(opts={}){
  const dir=mkdtempSync(join(tmpdir(),'sentinel-simplification-api-'));
  const handler=createConsoleServer({
    ledgerPath:join(dir,'ledger.jsonl'),
    memoryPath:join(dir,'mem.jsonl'),
    configPath:join(dir,'config.json'),
    ...opts,
  });
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    async call(method,path,body){
      const res=await fetch(`${base}${path}`,{
        method,
        headers:body===undefined?{}:{'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),
      });
      return {status:res.status,json:await res.json()};
    },
    async close(){
      await new Promise(resolve=>server.close(resolve));
      rmSync(dir,{recursive:true,force:true});
    },
  };
}

function passObserver(){
  return async({evidenceRefs})=>({
    status:'PASS',
    observerRef:'continuum:simplification-observer',
    evidenceRefs,
  });
}

test('simplification verify requires the canonical durable verification store',async()=>{
  const c=await boot({
    domainVerifierRef:'sentinel:simplification',
    simplificationIndependentCheck:passObserver(),
  });
  try{
    const out=await c.call('POST','/api/simplification/verify',requestBody());
    assert.equal(out.status,503);
    assert.equal(out.json.error,'simplification verification unavailable');
  }finally{await c.close();}
});

test('producer self-verification is rejected before independent verification',async()=>{
  let observerCalls=0;
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-simplification-store-')),'verification.json');
  const c=await boot({
    domainVerificationStorePath:storePath,
    domainVerifierRef:'sentinel:simplification',
    simplificationIndependentCheck:async()=>{observerCalls++;return {status:'PASS',observerRef:'continuum:observer',evidenceRefs:[]};},
  });
  try{
    const body=requestBody({claim:claim({verdict:'verified'})});
    const out=await c.call('POST','/api/simplification/verify',body);
    assert.equal(out.status,400);
    assert.equal(out.json.error,'producer self-verification forbidden');
    assert.equal(observerCalls,0);
  }finally{
    await c.close();
    rmSync(join(storePath,'..'),{recursive:true,force:true});
  }
});

test('independent PASS verifies, persists, publishes and reads back exact receipt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sentinel-simplification-store-'));
  const storePath=join(root,'verification.json');
  const published=[];
  const c=await boot({
    domainVerificationStorePath:storePath,
    domainVerifierRef:'sentinel:simplification',
    simplificationIndependentCheck:passObserver(),
    domainVerificationPublisher:async payload=>{published.push(payload);},
  });
  try{
    const out=await c.call('POST','/api/simplification/verify',requestBody());
    assert.equal(out.status,200);
    assert.equal(out.json.verdict,'VERIFIED');
    assert.match(out.json.receipt.receiptId,/^dvr_[a-f0-9]{64}$/u);
    assert.equal(out.json.receipt.profile,'code-simplification-evidence/1.0');
    assert.equal(published.length,1);
    assert.equal(published[0].receipt.receiptId,out.json.receipt.receiptId);
    assert.equal(published[0].envelope.subject.missionId,requestBody().missionId);

    const got=await c.call('GET',`/api/domain/verification/${out.json.receipt.receiptId}`);
    assert.equal(got.status,200);
    assert.equal(got.json.receiptId,out.json.receipt.receiptId);

    const raw=JSON.parse(readFileSync(storePath,'utf8'));
    assert.equal(raw.receipts.length,1);
    assert.equal(raw.receipts[0].receiptId,out.json.receipt.receiptId);
  }finally{
    await c.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('independent FAIL produces REJECTED and publishes failed terminal receipt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sentinel-simplification-store-'));
  const storePath=join(root,'verification.json');
  const published=[];
  const c=await boot({
    domainVerificationStorePath:storePath,
    domainVerifierRef:'sentinel:simplification',
    simplificationIndependentCheck:async({evidenceRefs})=>({
      status:'FAIL',
      observerRef:'continuum:simplification-observer',
      evidenceRefs,
    }),
    domainVerificationPublisher:async payload=>{published.push(payload);},
  });
  try{
    const out=await c.call('POST','/api/simplification/verify',requestBody());
    assert.equal(out.status,200);
    assert.equal(out.json.verdict,'REJECTED');
    assert.equal(published.length,1);
    assert.equal(published[0].receipt.verdict,'REJECTED');
  }finally{
    await c.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('missing independent observer stays INDETERMINATE, persists, and never publishes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sentinel-simplification-store-'));
  const storePath=join(root,'verification.json');
  let publishes=0;
  const c=await boot({
    domainVerificationStorePath:storePath,
    domainVerifierRef:'sentinel:simplification',
    domainVerificationPublisher:async()=>{publishes++;},
  });
  try{
    const out=await c.call('POST','/api/simplification/verify',requestBody());
    assert.equal(out.status,200);
    assert.equal(out.json.verdict,'INDETERMINATE');
    assert.equal(out.json.reason,'independent_check_required');
    assert.equal(publishes,0);
    assert.equal(JSON.parse(readFileSync(storePath,'utf8')).receipts.length,1);
  }finally{
    await c.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('partial producer execution cannot be promoted by a passing observer',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sentinel-simplification-store-'));
  const storePath=join(root,'verification.json');
  let publishes=0;
  const c=await boot({
    domainVerificationStorePath:storePath,
    domainVerifierRef:'sentinel:simplification',
    simplificationIndependentCheck:passObserver(),
    domainVerificationPublisher:async()=>{publishes++;},
  });
  try{
    const out=await c.call('POST','/api/simplification/verify',requestBody({
      claim:claim({execution_status:'partial'}),
    }));
    assert.equal(out.status,200);
    assert.equal(out.json.verdict,'INDETERMINATE');
    assert.equal(out.json.reason,'execution_not_completed');
    assert.equal(publishes,0);
  }finally{
    await c.close();
    rmSync(root,{recursive:true,force:true});
  }
});

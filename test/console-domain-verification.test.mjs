import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConsoleServer } from '../console/server.js';
import { hashBody } from '../lib/evidence.js';

function envelope(){
  const body={schema:'rendetalje.provider-effect-reconciliation/1.0',tenantId:'tenant:rendetalje',subjectRef:'customer:c1',missionId:'mission:1',worksExecutionId:'works:1',effectId:'effect:1',idempotencyKey:'idem:1',receipt:{receiptId:'provider:1'},readback:'MATCH',reconciliation:{status:'RECONCILED'}};
  return {schema:'aftergraph.domain-evidence/1.0',subject:{tenantId:body.tenantId,missionId:body.missionId,effectId:body.effectId,idempotencyKey:body.idempotencyKey,subjectRef:body.subjectRef,executorRef:body.worksExecutionId},evidence:{type:'provider-effect-reconciliation',sourceRef:'provider-receipt:provider:1',digestSha256:hashBody(body),observedAt:'2026-09-16T00:00:00.000Z',body},claims:{reconciliationStatus:'RECONCILED',readback:'MATCH',eligibleForVerification:true}};
}

async function boot(opts={}){
  const dir=mkdtempSync(join(tmpdir(),'sentinel-domain-api-'));
  const handler=createConsoleServer({ledgerPath:join(dir,'ledger.jsonl'),memoryPath:join(dir,'mem.jsonl'),configPath:join(dir,'config.json'),...opts});
  const server=createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {dir,async call(method,path,body,headers={}){const res=await fetch(`${base}${path}`,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};},async close(){await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}};
}test('domain verify requires a configured durable store',async()=>{
  const c=await boot({domainVerifierRef:'sentinel:test',domainIndependentCheck:async()=>({status:'PASS',observerRef:'observer:1',evidenceRefs:['obs:auth']})});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(out.status,503);
    assert.equal(out.json.error,'domain verification unavailable');
  }finally{await c.close();}
});

test('server-owned checker verifies, persists and serves receipt by id',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-'));
  const storePath=join(dir,'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainIndependentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:1',evidenceRefs:['obs:1']})});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(out.status,200); assert.equal(out.json.verdict,'VERIFIED');
    assert.match(out.json.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
    const got=await c.call('GET',`/api/domain/verification/${out.json.receipt.receiptId}`);
    assert.equal(got.status,200); assert.equal(got.json.receiptId,out.json.receipt.receiptId);
    const raw=JSON.parse(readFileSync(storePath,'utf8'));
    assert.equal(raw.receipts.length,1);
  }finally{await c.close();rmSync(dir,{recursive:true,force:true});}
});test('caller cannot inject verifier, observer, verdict or checks',async()=>{
  let calls=0;
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainIndependentCheck:async()=>{calls++;return {status:'PASS',observerRef:'sentinel:observer:1',evidenceRefs:[]};}});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope(),verdict:'VERIFIED',observerRef:'attacker',verifierRef:'attacker',checks:[]});
    assert.equal(out.status,400); assert.equal(calls,0);
  }finally{await c.close();}
});

test('missing server checker persists INDETERMINATE rather than VERIFIED',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service'});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(out.status,200); assert.equal(out.json.verdict,'INDETERMINATE');
    assert.equal(out.json.receipt.verdict,'INDETERMINATE');
    assert.equal(JSON.parse(readFileSync(storePath,'utf8')).receipts.length,1);
  }finally{await c.close();}
});

test('token gate runs before domain verification persistence',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({token:'tok',domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainIndependentCheck:async()=>({status:'PASS',observerRef:'observer:1',evidenceRefs:['obs:auth']})});
  try{
    assert.equal((await c.call('POST','/api/domain/verify',{envelope:envelope()})).status,401);
    const authed=await c.call('POST','/api/domain/verify',{envelope:envelope()},{authorization:'Bearer tok'});
    assert.equal(authed.status,200); assert.equal(authed.json.verdict,'VERIFIED');
    assert.equal((await c.call('GET',`/api/domain/verification/${authed.json.receipt.receiptId}`)).status,401);
    assert.equal((await c.call('GET',`/api/domain/verification/${authed.json.receipt.receiptId}`,undefined,{authorization:'Bearer tok'})).status,200);
  }finally{await c.close();}
});

test('domain verify is covered by the global API rate limiter',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',noExemptLoopback:true,rateLimit:{windowMs:60000,max:1}});
  try{
    assert.equal((await c.call('POST','/api/domain/verify',{envelope:envelope()})).status,200);
    assert.equal((await c.call('POST','/api/domain/verify',{envelope:envelope()})).status,429);
  }finally{await c.close();}
});

test('unbound malformed envelope cannot create a durable receipt',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service'});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:{schema:'aftergraph.domain-evidence/1.0'}});
    assert.equal(out.status,422);
    assert.equal(out.json.error,'domain evidence not bindable');
    assert.equal(existsSync(storePath),false);
  }finally{await c.close();}
});
test('terminal verification publishes the first persisted receipt metadata',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const published=[]; let tick=0;
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainIndependentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:1',evidenceRefs:['obs:1']}),domainVerificationPublisher:async(payload)=>{published.push(payload);}});
  try{
    const first=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(first.status,200); assert.equal(published.length,1);
    assert.equal(published[0].receipt.receiptId,first.json.receipt.receiptId);
    assert.equal(published[0].receipt.verifiedAt,first.json.receipt.verifiedAt);
    tick++;
    const second=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(second.status,200); assert.equal(published.length,2);
    assert.equal(second.json.receipt.verifiedAt,first.json.receipt.verifiedAt);
    assert.equal(published[1].receipt.verifiedAt,first.json.receipt.verifiedAt);
  }finally{await c.close();}
});

test('INDETERMINATE is persisted but never published to WORKS',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  let publishes=0;
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainVerificationPublisher:async()=>{publishes++;}});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(out.status,200); assert.equal(out.json.verdict,'INDETERMINATE'); assert.equal(publishes,0);
  }finally{await c.close();}
});
test('publisher failure returns 502 but keeps durable receipt for safe retry',async()=>{
  const storePath=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-root-')),'domain.json');
  const c=await boot({domainVerificationStorePath:storePath,domainVerifierRef:'sentinel:service',domainIndependentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:1',evidenceRefs:['obs:1']}),domainVerificationPublisher:async()=>{throw new Error('upstream secret');}});
  try{
    const out=await c.call('POST','/api/domain/verify',{envelope:envelope()});
    assert.equal(out.status,502); assert.equal(out.json.error,'domain verification publish failed');
    const raw=JSON.parse(readFileSync(storePath,'utf8'));
    assert.equal(raw.receipts.length,1);
    assert.equal(JSON.stringify(out.json).includes('upstream secret'),false);
  }finally{await c.close();}
});

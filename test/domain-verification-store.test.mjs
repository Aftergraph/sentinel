import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashBody } from '../lib/evidence.js';
import { verifyDomainEvidence } from '../lib/domain-verification.js';
import { createDomainVerificationStore } from '../lib/domain-verification-store.js';

function envelope(){
  const body={schema:'rendetalje.provider-effect-reconciliation/1.0',tenantId:'tenant:rendetalje',subjectRef:'customer:c1',missionId:'mission:1',worksExecutionId:'works:1',effectId:'effect:1',idempotencyKey:'idem:1',receipt:{receiptId:'provider:1'},readback:'MATCH',reconciliation:{status:'RECONCILED'}};
  return {schema:'aftergraph.domain-evidence/1.0',subject:{tenantId:body.tenantId,missionId:body.missionId,effectId:body.effectId,idempotencyKey:body.idempotencyKey,subjectRef:body.subjectRef,executorRef:body.worksExecutionId},evidence:{type:'provider-effect-reconciliation',sourceRef:'provider-receipt:provider:1',digestSha256:hashBody(body),observedAt:'2026-09-16T00:00:00.000Z',body},claims:{reconciliationStatus:'RECONCILED',readback:'MATCH',eligibleForVerification:true}};
}

async function receipt(at='2026-09-16T00:01:00.000Z'){
  const result=await verifyDomainEvidence({envelope:envelope(),verifierRef:'sentinel:test',now:()=>at,independentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:1',evidenceRefs:['obs:1']})});
  return result.receipt;
}test('store persists and reloads a content-addressed receipt',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sentinel-domain-store-'));
  const file=join(dir,'store.json');
  const first=await receipt();
  const store=createDomainVerificationStore(file);
  const stored=store.put(first);
  assert.equal(stored.receiptId,first.receiptId);
  assert.equal(store.get(first.receiptId).receiptId,first.receiptId);
  assert.equal(store.listBySubject(first.subjectId).length,1);
  const reloaded=createDomainVerificationStore(file);
  assert.equal(reloaded.get(first.receiptId).receiptDigestSha256,first.receiptDigestSha256);
});

test('duplicate stable receipt keeps the first observed metadata',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-')),'store.json');
  const store=createDomainVerificationStore(file);
  const first=await receipt('2026-09-16T00:01:00.000Z');
  const replay=await receipt('2026-09-16T00:02:00.000Z');
  assert.equal(first.receiptId,replay.receiptId);
  store.put(first); const stored=store.put(replay);
  assert.equal(stored.verifiedAt,first.verifiedAt);
  assert.equal(store.listBySubject(first.subjectId).length,1);
});test('tampered receipt is rejected and not persisted',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-')),'store.json');
  const store=createDomainVerificationStore(file);
  const good=await receipt();
  const bad=Object.freeze({...good,verdict:'REJECTED'});
  assert.throws(()=>store.put(bad),/tampered|digest|receipt/i);
  assert.equal(store.get(good.receiptId),null);
});

test('verifyAll reports hand-corrupted persisted receipts',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-')),'store.json');
  const good=await receipt();
  createDomainVerificationStore(file).put(good);
  const raw=JSON.parse(readFileSync(file,'utf8'));
  raw.receipts[0].verdict='REJECTED';
  writeFileSync(file,JSON.stringify(raw));
  const store=createDomainVerificationStore(file);
  const inventory=store.verifyAll();
  assert.equal(inventory.ok,false);
  assert.deepEqual(inventory.bad,[good.receiptId]);
});

test('corrupt store file fails closed instead of resetting',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'sentinel-domain-store-')),'store.json');
  writeFileSync(file,'{broken');
  assert.throws(()=>createDomainVerificationStore(file),/corrupt/i);
});
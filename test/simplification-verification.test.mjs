import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBody } from '../lib/evidence.js';
import {
  verifySimplificationEvidence,
  verifySimplificationVerificationReceipt,
  VERIFIED,
  REJECTED,
  INDETERMINATE,
} from '../lib/simplification-verification.js';
import { createWorksVerificationPublisher } from '../lib/domain-works-publisher.js';

const REQUIRED=[
  'exact-revision-evidence',
  'repository-native-gates-pass',
  'behavior-preserved',
  'canonical-owner-preserved',
];

function envelope(){
  const refs=Object.fromEntries(REQUIRED.map((id,i)=>[id,[`evb_ref_${i+1}`]]));
  const body={
    repository:'Aftergraph/war-room',
    baselineRevision:'a'.repeat(40),
    finalRevision:'b'.repeat(40),
    skillDigestSha256:'c'.repeat(64),
    changedPaths:['desktop/web/app.js'],
    canonicalOwner:'Aftergraph/war-room:desktop/web/app.js',
    obligations:REQUIRED.map(id=>({id,status:'PASS',evidenceRefs:refs[id]})),
  };
  return {
    schema:'aftergraph.simplification-evidence/1.0',
    subject:{
      missionId:'wrk_0123456789abcdef0123456789abcdef',
      repository:body.repository,
      baselineRevision:body.baselineRevision,
      finalRevision:body.finalRevision,
      skillDigestSha256:body.skillDigestSha256,
      executorRef:'runtime:simplifier-1',
    },
    evidence:{
      digestSha256:hashBody(body),
      observedAt:'2026-09-20T05:00:00.000Z',
      body,
    },
  };
}

function passCheck(extra={}){
  return async({evidenceRefs})=>({
    status:'PASS',
    observerRef:'sentinel:observer:simplification-1',
    evidenceRefs,
    ...extra,
  });
}

test('independent evidence over every required obligation produces VERIFIED dvr receipt',async()=>{
  const out=await verifySimplificationEvidence({
    envelope:envelope(),
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
    now:()=> '2026-09-20T05:01:00.000Z',
  });
  assert.equal(out.verdict,VERIFIED);
  assert.equal(out.checks.length,4);
  assert.match(out.receipt.receiptId,/^dvr_[a-f0-9]{64}$/u);
  assert.equal(verifySimplificationVerificationReceipt(out.receipt),true);
  assert.equal(out.receipt.observerRef,'sentinel:observer:simplification-1');
  assert.deepEqual(out.receipt.resolvedEvidenceRefs,['evb_ref_1','evb_ref_2','evb_ref_3','evb_ref_4']);
});

test('a valid self-claim without independent evidence stays INDETERMINATE',async()=>{
  const out=await verifySimplificationEvidence({
    envelope:envelope(),
    verifierRef:'sentinel:simplification',
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'independent_check_required');
});

test('tampered evidence body is REJECTED',async()=>{
  const e=envelope();
  e.evidence.body.changedPaths.push('tampered.js');
  const out=await verifySimplificationEvidence({
    envelope:e,
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'evidence_integrity_failed');
});

test('same baseline and final revision cannot be verified',async()=>{
  const e=envelope();
  e.subject.finalRevision=e.subject.baselineRevision;
  e.evidence.body.finalRevision=e.subject.finalRevision;
  e.evidence.digestSha256=hashBody(e.evidence.body);
  const out=await verifySimplificationEvidence({
    envelope:e,
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'revision_binding_failed');
});

test('missing required obligation is REJECTED',async()=>{
  const e=envelope();
  e.evidence.body.obligations=e.evidence.body.obligations.filter(x=>x.id!=='behavior-preserved');
  e.evidence.digestSha256=hashBody(e.evidence.body);
  const out=await verifySimplificationEvidence({
    envelope:e,
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'obligation_contract_failed');
});

test('resolver PASS that does not resolve every claimed ref is INDETERMINATE',async()=>{
  const out=await verifySimplificationEvidence({
    envelope:envelope(),
    verifierRef:'sentinel:simplification',
    independentCheck:async()=>({
      status:'PASS',
      observerRef:'sentinel:observer:simplification-1',
      evidenceRefs:['evb_ref_1'],
    }),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'evidence_ref_unresolved');
});

test('independent FAIL rejects a superficially passing simplification package',async()=>{
  const out=await verifySimplificationEvidence({
    envelope:envelope(),
    verifierRef:'sentinel:simplification',
    independentCheck:async({evidenceRefs})=>({
      status:'FAIL',
      observerRef:'sentinel:observer:simplification-1',
      evidenceRefs,
    }),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'independent_evidence_failed');
});

test('executor cannot also be the independent verifier',async()=>{
  const e=envelope();
  e.subject.executorRef='sentinel:simplification';
  const out=await verifySimplificationEvidence({
    envelope:e,
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'verifier_not_independent');
});

test('receipt identity excludes verifiedAt but includes verification evidence',async()=>{
  const opts={
    envelope:envelope(),
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
  };
  const a=await verifySimplificationEvidence({...opts,now:()=> '2026-09-20T05:01:00Z'});
  const b=await verifySimplificationEvidence({...opts,now:()=> '2026-09-20T05:02:00Z'});
  assert.equal(a.receipt.receiptId,b.receipt.receiptId);
  assert.notEqual(a.receipt.verifiedAt,b.receipt.verifiedAt);
});

test('VERIFIED simplification receipt is compatible with existing WORKS verification ingest publisher',async()=>{
  const e=envelope();
  const verified=await verifySimplificationEvidence({
    envelope:e,
    verifierRef:'sentinel:simplification',
    independentCheck:passCheck(),
    now:()=> '2026-09-20T05:01:00Z',
  });
  let seen;
  const publish=createWorksVerificationPublisher({
    baseUrl:'http://127.0.0.1:8080',
    token:'x'.repeat(32),
    fetchImpl:async(url,init)=>{
      seen={url:String(url),headers:init.headers,body:JSON.parse(init.body)};
      return {ok:true};
    },
  });
  const result=await publish({receipt:verified.receipt,envelope:e});
  assert.equal(result.published,true);
  assert.match(seen.url,/\/v1\/works\/wrk_0123456789abcdef0123456789abcdef\/verification$/u);
  assert.deepEqual(seen.body,{
    result:'passed',
    verifier_id:'sentinel:simplification',
    evidence_ref:verified.receipt.receiptId,
    verified_at:'2026-09-20T05:01:00Z',
  });
});

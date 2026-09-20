import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptSimplificationProducerClaim,
  SIMPLIFICATION_PRODUCER_SCHEMA,
  SIMPLIFICATION_EVIDENCE_SCHEMA,
} from '../lib/simplification-producer-claim.js';
import {
  verifySimplificationEvidence,
  VERIFIED,
  INDETERMINATE,
} from '../lib/simplification-verification.js';

const REQUIRED=[
  'exact-revision-evidence',
  'repository-native-gates-pass',
  'behavior-preserved',
  'canonical-owner-preserved',
];

function claim({executionStatus='completed'}={}){
  const obligations=REQUIRED.map((id,index)=>({
    id,
    claim_status:'pass',
    evidence_refs:[`works:evidence:${index+1}`],
  }));
  return {
    schema:SIMPLIFICATION_PRODUCER_SCHEMA,
    repository:'Aftergraph/runtime',
    baseline_revision:'a'.repeat(40),
    final_revision:'b'.repeat(40),
    skill_digest_sha256:`sha256:${'c'.repeat(64)}`,
    canonical_owner:'Aftergraph/runtime:packages/mission-routing',
    execution_status:executionStatus,
    changed_paths:['packages/mission-routing/src/placement-resolver.ts'],
    obligations,
    evidence_refs:obligations.flatMap(x=>x.evidence_refs),
  };
}

function adapt(value=claim()){
  return adaptSimplificationProducerClaim({
    claim:value,
    missionId:'wrk_0123456789abcdef0123456789abcdef',
    executorRef:'runtime:simplifier-1',
    observedAt:'2026-09-20T08:20:00.000Z',
  });
}

test('producer claim adapts to the existing Sentinel evidence profile without self-verification',async()=>{
  const envelope=adapt();
  assert.equal(envelope.schema,SIMPLIFICATION_EVIDENCE_SCHEMA);
  assert.equal(envelope.subject.skillDigestSha256,'c'.repeat(64));
  assert.equal(envelope.evidence.body.executionStatus,'completed');

  const out=await verifySimplificationEvidence({
    envelope,
    verifierRef:'sentinel:simplification',
    independentCheck:async({evidenceRefs})=>({
      status:'PASS',
      observerRef:'continuum:observer:producer-claim',
      evidenceRefs,
    }),
    now:()=> '2026-09-20T08:21:00.000Z',
  });
  assert.equal(out.verdict,VERIFIED);
  assert.equal(out.receipt.executorRef,undefined);
  assert.equal(out.receipt.verifierRef,'sentinel:simplification');
});

test('partial producer execution cannot be promoted to VERIFIED',async()=>{
  const envelope=adapt(claim({executionStatus:'partial'}));
  const out=await verifySimplificationEvidence({
    envelope,
    verifierRef:'sentinel:simplification',
    independentCheck:async({evidenceRefs})=>({
      status:'PASS',
      observerRef:'continuum:observer:producer-claim',
      evidenceRefs,
    }),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'execution_not_completed');
});

test('producer self-verification fields are rejected at the Sentinel seam',()=>{
  assert.throws(
    ()=>adapt({...claim(),verdict:'verified'}),
    /producer_self_verification_forbidden/u,
  );
  assert.throws(
    ()=>adapt({...claim(),verified:true}),
    /producer_self_verification_forbidden/u,
  );
});

test('every required verification obligation must be declared',()=>{
  const value=claim();
  value.obligations=value.obligations.filter(x=>x.id!=='behavior-preserved');
  value.evidence_refs=value.obligations.flatMap(x=>x.evidence_refs);
  assert.throws(
    ()=>adapt(value),
    /missing_required_simplification_obligation/u,
  );
});

test('obligation evidence must be declared by the producer output',()=>{
  const value=claim();
  value.evidence_refs=value.evidence_refs.filter(x=>x!=='works:evidence:4');
  assert.throws(
    ()=>adapt(value),
    /obligation_evidence_ref_not_declared/u,
  );
});

test('producer execution status remains evidence, not verification authority',()=>{
  const envelope=adapt(claim({executionStatus:'rejected'}));
  assert.equal(envelope.evidence.body.executionStatus,'rejected');
  assert.equal(envelope.evidence.body.obligations[0].status,'PASS');
  assert.equal(Object.hasOwn(envelope.evidence.body,'verdict'),false);
});

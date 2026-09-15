import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBody } from '../lib/evidence.js';
import {
  verifyDomainEvidence,
  VERIFIED,
  REJECTED,
  INDETERMINATE,
} from '../lib/domain-verification.js';

function baseEnvelope() {
  const body = {
    schema:'rendetalje.provider-effect-reconciliation/1.0',
    tenantId:'tenant:rendetalje',
    subjectRef:'legacy-renos:customer:c1',
    missionId:'wrk_0123456789abcdef0123456789abcdef',
    worksExecutionId:'exec_sandbox_1',
    effectId:'effect_sandbox_1',
    idempotencyKey:'idem_sandbox_1',
    receipt:{receiptId:'receipt_sandbox_1',provider:'sandbox',effectId:'effect_sandbox_1',idempotencyKey:'idem_sandbox_1',receivedAt:'2026-09-16T00:00:00.000Z'},
    readback:'MATCH',
    reconciliation:{status:'RECONCILED',receipt:true,readback:'MATCH'},
  };
  return {
    schema:'aftergraph.domain-evidence/1.0',
    subject:{
      tenantId:body.tenantId,
      missionId:body.missionId,
      effectId:body.effectId,
      idempotencyKey:body.idempotencyKey,
      subjectRef:body.subjectRef,
      executorRef:body.worksExecutionId,
    },
    evidence:{
      type:'provider-effect-reconciliation',
      sourceRef:`provider-receipt:${body.receipt.receiptId}`,
      digestSha256:hashBody(body),
      observedAt:'2026-09-16T00:00:01.000Z',
      body,
    },
    claims:{
      reconciliationStatus:'RECONCILED',
      readback:'MATCH',
      eligibleForVerification:true,
    },
  };
}
test('valid reconciled evidence without an independent checker is indeterminate', async () => {
  const out=await verifyDomainEvidence({envelope:baseEnvelope(),verifierRef:'sentinel:test'});
  assert.equal(out.verdict,INDETERMINATE);
  assert.deepEqual(out.checks.map(c=>[c.type,c.status]),[
    ['EVIDENCE_INTEGRITY','PASS'],
    ['SUBJECT_CORRELATION','PASS'],
    ['INDEPENDENT_READBACK','INDETERMINATE'],
  ]);
});

test('tampered evidence digest is rejected', async () => {
  const envelope=baseEnvelope();
  envelope.evidence.digestSha256='0'.repeat(64);
  const out=await verifyDomainEvidence({envelope,verifierRef:'sentinel:test'});
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.checks[0].status,'FAIL');
  assert.equal(out.checks[0].reason,'evidence_digest_mismatch');
});
test('subject correlation mismatch is rejected', async () => {
  const envelope=baseEnvelope();
  envelope.subject.effectId='effect_spoofed';
  const out=await verifyDomainEvidence({envelope,verifierRef:'sentinel:test'});
  assert.equal(out.verdict,REJECTED);
  const correlation=out.checks.find(c=>c.type==='SUBJECT_CORRELATION');
  assert.equal(correlation.status,'FAIL');
  assert.equal(correlation.reason,'subject_correlation_mismatch');
});

test('unsupported envelope schema is rejected fail closed', async () => {
  const envelope=baseEnvelope();
  envelope.schema='aftergraph.domain-evidence/0.9';
  const out=await verifyDomainEvidence({envelope,verifierRef:'sentinel:test'});
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'unsupported_domain_evidence_schema');
});
test('independent PASS produces VERIFIED receipt bound to a distinct observer', async () => {
  const out=await verifyDomainEvidence({
    envelope:baseEnvelope(),
    verifierRef:'sentinel:sandbox',
    now:()=> '2026-09-16T00:01:00.000Z',
    independentCheck:async()=>({
      status:'PASS',observerRef:'sentinel:observer:readback-1',evidenceRefs:['obs:1'],
    }),
  });
  assert.equal(out.verdict,VERIFIED);
  assert.equal(out.receipt.schema,'aftergraph.domain-verification.receipt/1.0');
  assert.match(out.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
  assert.equal(out.receipt.verifierRef,'sentinel:sandbox');
  assert.equal(out.receipt.checks.at(-1).observerRef,'sentinel:observer:readback-1');
  assert.equal(out.receipt.verifiedAt,'2026-09-16T00:01:00.000Z');
  const {receiptId,receiptDigestSha256,verificationId,verifiedAt,...stableBody}=out.receipt;
  assert.equal(receiptDigestSha256,hashBody(stableBody));
  assert.equal(receiptId,`dvr_${receiptDigestSha256}`);
  assert.equal(verificationId,`dv_${receiptDigestSha256}`);
  assert.equal(verifiedAt,'2026-09-16T00:01:00.000Z');
});

test('independent FAIL rejects the domain evidence', async () => {
  const out=await verifyDomainEvidence({
    envelope:baseEnvelope(),verifierRef:'sentinel:sandbox',
    independentCheck:async()=>({status:'FAIL',observerRef:'sentinel:observer:readback-1',evidenceRefs:['obs:fail']}),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.checks.at(-1).status,'FAIL');
});
test('same observer and executor can never produce VERIFIED', async () => {
  const envelope=baseEnvelope();
  const out=await verifyDomainEvidence({
    envelope,verifierRef:'sentinel:sandbox',
    independentCheck:async()=>({status:'PASS',observerRef:envelope.subject.executorRef,evidenceRefs:[]}),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.checks.at(-1).reason,'observer_not_independent');
});

test('independent checker failure is INDETERMINATE without leaking internals', async () => {
  const out=await verifyDomainEvidence({
    envelope:baseEnvelope(),verifierRef:'sentinel:sandbox',
    independentCheck:async()=>{throw new Error('secret-provider-detail');},
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.checks.at(-1).reason,'independent_check_error');
  assert.equal(JSON.stringify(out).includes('secret-provider-detail'),false);
});

test('missing verifier identity stays fail closed', async () => {
  const out=await verifyDomainEvidence({
    envelope:baseEnvelope(),
    independentCheck:async()=>({status:'PASS',observerRef:'observer:1',evidenceRefs:[]}),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'verifier_ref_required');
});


test('receipt id is content-addressed and independent of verifiedAt', async () => {
  const opts={
    envelope:baseEnvelope(),verifierRef:'sentinel:sandbox',
    independentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:readback-1',evidenceRefs:['obs:1']}),
  };
  const a=await verifyDomainEvidence({...opts,now:()=> '2026-09-16T00:01:00.000Z'});
  const b=await verifyDomainEvidence({...opts,now:()=> '2026-09-16T00:02:00.000Z'});
  assert.equal(a.receipt.receiptId,b.receipt.receiptId);
  assert.equal(a.receipt.receiptDigestSha256,b.receipt.receiptDigestSha256);
  assert.notEqual(a.receipt.verifiedAt,b.receipt.verifiedAt);
});

test('missing verifier on a bindable envelope still emits an auditable receipt', async () => {
  const out=await verifyDomainEvidence({envelope:baseEnvelope()});
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.receipt.verifierRef,'sentinel:unattributed');
  assert.match(out.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
  assert.equal(out.receipt.verdict,INDETERMINATE);
});

test('unsupported schema on a bindable envelope emits a rejected receipt', async () => {
  const envelope=baseEnvelope();
  envelope.schema='aftergraph.domain-evidence/0.9';
  const out=await verifyDomainEvidence({envelope,verifierRef:'sentinel:test'});
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.receipt.verdict,REJECTED);
  assert.equal(out.receipt.reason,'unsupported_domain_evidence_schema');
});


test('independent PASS without observation evidence cannot produce VERIFIED', async () => {
  const out=await verifyDomainEvidence({
    envelope:baseEnvelope(),verifierRef:'sentinel:sandbox',
    independentCheck:async()=>({status:'PASS',observerRef:'sentinel:observer:readback-1',evidenceRefs:[]}),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.checks.at(-1).reason,'independent_evidence_required');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBody } from '../lib/evidence.js';
import {
  verifyDomainEvidence,
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

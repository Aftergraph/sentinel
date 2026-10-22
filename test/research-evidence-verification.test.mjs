import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashBody } from '../lib/evidence.js';
import { verifyResearchEvidence,verifyResearchVerificationReceipt,VERIFIED,REJECTED,INDETERMINATE } from '../lib/research-evidence-verification.js';

function shaText(v){return createHash('sha256').update(String(v),'utf8').digest('hex');}
function envelope(responseText='NO_SECOND_EFFECT'){
  const body={responseText,responseSha256:shaText(responseText),provider:'google',modelId:'gemini-2.5-flash'};
  const criterion={format:'EXACT_TOKEN',expected:'NO_SECOND_EFFECT'};
  return {
    schema:'aftergraph.research-evidence/1.0',
    subject:{studyId:'STUDY-012',executionId:'exec-1',traceId:'t1',workloadId:'S12-R2-REPLAY-A2',condition:'DI',executorRef:'runtime:study012',missionId:'wrk_test'},
    evidence:{body,digestSha256:hashBody(body),observedAt:'2026-09-18T18:00:00Z'},
    criterion:{...criterion,acceptanceCriteriaHash:hashBody(criterion)},
  };
}

test('exact research response produces content-addressed VERIFIED receipt',()=>{
  const out=verifyResearchEvidence({envelope:envelope(),verifierRef:'sentinel:domain-verifier',now:()=> '2026-09-18T18:01:00Z'});
  assert.equal(out.verdict,VERIFIED);
  assert.match(out.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
  assert.equal(verifyResearchVerificationReceipt(out.receipt),true);
});
test('wrong exact response is REJECTED',()=>{
  const out=verifyResearchEvidence({envelope:envelope('REPEAT_EFFECT'),verifierRef:'sentinel:domain-verifier'});
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'exact_output_mismatch');
});
test('tampered body is rejected',()=>{
  const e=envelope();e.evidence.body.responseText='tampered';
  assert.equal(verifyResearchEvidence({envelope:e,verifierRef:'sentinel:domain-verifier'}).verdict,REJECTED);
});
test('same verifier and executor is indeterminate',()=>{
  const e=envelope();e.subject.executorRef='sentinel:domain-verifier';
  const out=verifyResearchEvidence({envelope:e,verifierRef:'sentinel:domain-verifier'});
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'verifier_not_independent');
});

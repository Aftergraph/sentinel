import { createHash } from 'node:crypto';
import { hashBody } from './evidence.js';

export const VERIFIED='VERIFIED';
export const REJECTED='REJECTED';
export const INDETERMINATE='INDETERMINATE';

const SCHEMA='aftergraph.research-evidence/1.0';
const RESULT_SCHEMA='aftergraph.research-verification.result/1.0';
const RECEIPT_SCHEMA='aftergraph.research-verification.receipt/1.0';
const PROFILE='research-exact-output/1.0';

function text(v){return typeof v==='string'&&v.trim()?v.trim():null;}
function shaText(v){return createHash('sha256').update(String(v),'utf8').digest('hex');}

function structurallyValid(envelope){
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return false;
  const {subject,evidence,criterion}=envelope;
  if(!subject||!evidence||!criterion)return false;
  return [
    subject.studyId,subject.executionId,subject.traceId,subject.workloadId,
    subject.condition,subject.executorRef,subject.missionId,
    evidence.digestSha256,evidence.observedAt,criterion.format,criterion.expected
  ].every(text)
    && evidence.body&&typeof evidence.body==='object'&&!Array.isArray(evidence.body);
}

function stableReceiptBody(receipt){
  return {
    schema:receipt.schema,
    profile:receipt.profile,
    studyId:receipt.studyId,
    executionId:receipt.executionId,
    traceId:receipt.traceId,
    workloadId:receipt.workloadId,
    missionId:receipt.missionId,
    condition:receipt.condition,
    verdict:receipt.verdict,
    reason:receipt.reason??null,
    evidenceDigestSha256:receipt.evidenceDigestSha256,
    responseSha256:receipt.responseSha256,
    acceptanceCriteriaHash:receipt.acceptanceCriteriaHash,
    verifierRef:receipt.verifierRef,
  };
}
export function verifyResearchVerificationReceipt(receipt){
  const digest=hashBody(stableReceiptBody(receipt));
  return receipt?.schema===RECEIPT_SCHEMA
    && receipt?.receiptDigestSha256===digest
    && receipt?.receiptId===`dvr_${digest}`
    && receipt?.verificationId===`dv_${digest}`;
}

function makeReceipt({envelope,verdict,reason,verifierRef,verifiedAt}){
  const body=envelope.evidence.body;
  const stable={
    schema:RECEIPT_SCHEMA,
    profile:PROFILE,
    studyId:envelope.subject.studyId,
    executionId:envelope.subject.executionId,
    traceId:envelope.subject.traceId,
    workloadId:envelope.subject.workloadId,
    missionId:envelope.subject.missionId,
    condition:envelope.subject.condition,
    verdict,
    reason:reason??null,
    evidenceDigestSha256:envelope.evidence.digestSha256,
    responseSha256:shaText(body.responseText??''),
    acceptanceCriteriaHash:envelope.criterion.acceptanceCriteriaHash,
    verifierRef,
  };
  const digest=hashBody(stable);
  return Object.freeze({...stable,verificationId:`dv_${digest}`,verifiedAt,receiptDigestSha256:digest,receiptId:`dvr_${digest}`});
}

export function verifyResearchEvidence({envelope,verifierRef,now=()=>new Date().toISOString()}={}){
  const verifier=text(verifierRef);
  if(!verifier||!verifier.startsWith('sentinel:')){
    return Object.freeze({schema:RESULT_SCHEMA,verdict:INDETERMINATE,reason:'sentinel_verifier_ref_required'});
  }
  if(!envelope||envelope.schema!==SCHEMA||!structurallyValid(envelope)){
    return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason:'invalid_research_evidence_envelope'});
  }
  if(envelope.subject.executorRef===verifier){
    return Object.freeze({schema:RESULT_SCHEMA,verdict:INDETERMINATE,reason:'verifier_not_independent'});
  }
  if(hashBody(envelope.evidence.body)!==envelope.evidence.digestSha256){
    const receipt=makeReceipt({envelope,verdict:REJECTED,reason:'evidence_digest_mismatch',verifierRef:verifier,verifiedAt:now()});
    return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason:'evidence_digest_mismatch',receipt});
  }
  const responseText=String(envelope.evidence.body.responseText??'');
  if(envelope.evidence.body.responseSha256!==shaText(responseText)){
    const receipt=makeReceipt({envelope,verdict:REJECTED,reason:'response_hash_mismatch',verifierRef:verifier,verifiedAt:now()});
    return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason:'response_hash_mismatch',receipt});
  }
  if(envelope.criterion.format!=='EXACT_TOKEN'){
    const receipt=makeReceipt({envelope,verdict:REJECTED,reason:'unsupported_criterion_format',verifierRef:verifier,verifiedAt:now()});
    return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason:'unsupported_criterion_format',receipt});
  }
  const criterionHash=hashBody({format:envelope.criterion.format,expected:envelope.criterion.expected});
  if(criterionHash!==envelope.criterion.acceptanceCriteriaHash){
    const receipt=makeReceipt({envelope,verdict:REJECTED,reason:'acceptance_criteria_hash_mismatch',verifierRef:verifier,verifiedAt:now()});
    return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason:'acceptance_criteria_hash_mismatch',receipt});
  }
  const pass=responseText.trim()===envelope.criterion.expected.trim();
  const verdict=pass?VERIFIED:REJECTED;
  const reason=pass?null:'exact_output_mismatch';
  const receipt=makeReceipt({envelope,verdict,reason,verifierRef:verifier,verifiedAt:now()});
  return Object.freeze({schema:RESULT_SCHEMA,verdict,...(reason?{reason}:{}),receipt});
}

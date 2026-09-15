import { hashBody } from './evidence.js';

export const VERIFIED='VERIFIED';
export const REJECTED='REJECTED';
export const INDETERMINATE='INDETERMINATE';

const SCHEMA='aftergraph.domain-evidence/1.0';
const RESULT_SCHEMA='aftergraph.domain-verification.result/1.0';
const RECEIPT_SCHEMA='aftergraph.domain-verification.receipt/1.0';
const PROFILE='provider-effect-reconciliation/1.0';
const CHECK_INTEGRITY='EVIDENCE_INTEGRITY';
const CHECK_CORRELATION='SUBJECT_CORRELATION';
const CHECK_READBACK='INDEPENDENT_READBACK';

function pass(type,extra={}){return Object.freeze({type,status:'PASS',...extra});}
function fail(type,reason,extra={}){return Object.freeze({type,status:'FAIL',reason,...extra});}
function unknown(type,reason,extra={}){return Object.freeze({type,status:'INDETERMINATE',reason,...extra});}
function text(value){return typeof value==='string'&&value.trim()?value.trim():null;}
function refs(value){return Object.freeze(Array.isArray(value)?value.filter(text):[]);}

function structurallyValid(envelope){
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return false;
  const {subject,evidence,claims}=envelope;
  if(!subject||!evidence||!claims)return false;
  return [subject.tenantId,subject.missionId,subject.effectId,subject.idempotencyKey,
    subject.subjectRef,subject.executorRef,evidence.type,evidence.sourceRef,
    evidence.digestSha256,evidence.observedAt].every(text)
    && evidence.body&&typeof evidence.body==='object'&&!Array.isArray(evidence.body);
}
function correlationMatches(envelope){
  const {subject,evidence,claims}=envelope;
  const body=evidence.body;
  return body.tenantId===subject.tenantId
    && body.missionId===subject.missionId
    && body.effectId===subject.effectId
    && body.idempotencyKey===subject.idempotencyKey
    && body.subjectRef===subject.subjectRef
    && body.worksExecutionId===subject.executorRef
    && body.reconciliation?.status===claims.reconciliationStatus
    && body.readback===claims.readback;
}

function subjectIdFor(envelope){
  return hashBody({
    tenantId:envelope.subject.tenantId,
    missionId:envelope.subject.missionId,
    effectId:envelope.subject.effectId,
    idempotencyKey:envelope.subject.idempotencyKey,
    evidenceDigestSha256:envelope.evidence.digestSha256,
  });
}

function rejected(reason,checks=[]){
  return Object.freeze({schema:RESULT_SCHEMA,verdict:REJECTED,reason,checks:Object.freeze([...checks])});
}
function bindableEnvelope(envelope){
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return false;
  const subject=envelope.subject;
  const evidence=envelope.evidence;
  return !!subject&&!!evidence
    && [subject.tenantId,subject.missionId,subject.effectId,subject.idempotencyKey,evidence.digestSha256].every(text);
}
export function domainVerificationReceiptStableBody(receipt){
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('invalid_domain_verification_receipt');
  return {
    schema:receipt.schema,
    subjectId:receipt.subjectId,
    tenantId:receipt.tenantId,
    missionId:receipt.missionId,
    effectId:receipt.effectId,
    idempotencyKey:receipt.idempotencyKey,
    verdict:receipt.verdict,
    reason:receipt.reason??null,
    profile:receipt.profile,
    evidenceDigestSha256:receipt.evidenceDigestSha256,
    checks:receipt.checks,
    verifierRef:receipt.verifierRef,
    observerRef:receipt.observerRef??null,
  };
}

export function verifyDomainVerificationReceipt(receipt){
  const digest=hashBody(domainVerificationReceiptStableBody(receipt));
  return receipt?.schema===RECEIPT_SCHEMA
    && receipt?.receiptDigestSha256===digest
    && receipt?.receiptId===`dvr_${digest}`
    && receipt?.verificationId===`dv_${digest}`;
}

function makeReceipt({envelope,verdict,reason,checks,verifierRef,verifiedAt}){
  const subjectId=subjectIdFor(envelope);
  const readback=checks.find(check=>check.type===CHECK_READBACK);
  const stableBody={
    schema:RECEIPT_SCHEMA,
    subjectId,
    tenantId:envelope.subject.tenantId,
    missionId:envelope.subject.missionId,
    effectId:envelope.subject.effectId,
    idempotencyKey:envelope.subject.idempotencyKey,
    verdict,
    reason:reason??null,
    profile:PROFILE,
    evidenceDigestSha256:envelope.evidence.digestSha256,
    checks:Object.freeze([...checks]),
    verifierRef,
    observerRef:readback?.observerRef??null,
  };
  const receiptDigestSha256=hashBody(stableBody);
  return Object.freeze({
    ...stableBody,
    verificationId:`dv_${receiptDigestSha256}`,
    verifiedAt,
    receiptDigestSha256,
    receiptId:`dvr_${receiptDigestSha256}`,
  });
}

function result({envelope,verdict,reason,checks,verifierRef,verifiedAt}){
  const receipt=makeReceipt({envelope,verdict,reason,checks,verifierRef,verifiedAt});
  return Object.freeze({
    schema:RESULT_SCHEMA,
    verdict,
    ...(reason?{reason}:{}),
    subjectId:receipt.subjectId,
    checks:Object.freeze([...checks]),
    receipt,
  });
}
async function runIndependentCheck({independentCheck,envelope}){
  if(typeof independentCheck!=='function'){
    return unknown(CHECK_READBACK,'independent_check_required');
  }
  let observed;
  try{
    observed=await independentCheck({subject:envelope.subject,evidence:envelope.evidence});
  }catch{
    return unknown(CHECK_READBACK,'independent_check_error');
  }
  if(!observed||typeof observed!=='object'||Array.isArray(observed)){
    return unknown(CHECK_READBACK,'independent_check_invalid');
  }
  const observerRef=text(observed.observerRef);
  if(!observerRef)return unknown(CHECK_READBACK,'observer_ref_required');
  const extra={observerRef,evidenceRefs:refs(observed.evidenceRefs)};
  if(observerRef===envelope.subject.executorRef){
    return unknown(CHECK_READBACK,'observer_not_independent',extra);
  }
  if(observed.status==='PASS'&&extra.evidenceRefs.length===0){
    return unknown(CHECK_READBACK,'independent_evidence_required',extra);
  }
  if(observed.status==='PASS')return pass(CHECK_READBACK,extra);
  if(observed.status==='FAIL')return fail(CHECK_READBACK,'independent_readback_failed',extra);
  return unknown(CHECK_READBACK,'independent_readback_indeterminate',extra);
}

export async function verifyDomainEvidence({envelope,independentCheck,verifierRef,now=()=>new Date().toISOString()}={}){
  const verifier=text(verifierRef)||'sentinel:unattributed';
  const canBind=bindableEnvelope(envelope);
  const emit=(verdict,reason,checks=[])=>result({
    envelope,verdict,reason,checks,verifierRef:verifier,verifiedAt:now(),
  });

  if(!envelope||envelope.schema!==SCHEMA){
    return canBind?emit(REJECTED,'unsupported_domain_evidence_schema'):rejected('unsupported_domain_evidence_schema');
  }
  if(!structurallyValid(envelope)){
    return canBind?emit(REJECTED,'invalid_domain_evidence_envelope'):rejected('invalid_domain_evidence_envelope');
  }
  const checks=[];
  const recomputed=hashBody(envelope.evidence.body);
  if(recomputed!==envelope.evidence.digestSha256){
    checks.push(fail(CHECK_INTEGRITY,'evidence_digest_mismatch'));
    return emit(REJECTED,'evidence_integrity_failed',checks);
  }
  checks.push(pass(CHECK_INTEGRITY));

  if(!correlationMatches(envelope)){
    checks.push(fail(CHECK_CORRELATION,'subject_correlation_mismatch'));
    return emit(REJECTED,'subject_correlation_failed',checks);
  }
  checks.push(pass(CHECK_CORRELATION));

  if(!text(verifierRef)){
    checks.push(unknown(CHECK_READBACK,'verifier_ref_required'));
    return emit(INDETERMINATE,'verifier_ref_required',checks);
  }

  const readback=await runIndependentCheck({independentCheck,envelope});
  checks.push(readback);
  const verdict=readback.status==='FAIL'?REJECTED
    :readback.status==='INDETERMINATE'?INDETERMINATE
      :VERIFIED;
  const reason=verdict===REJECTED?'independent_readback_failed'
    :verdict===INDETERMINATE?readback.reason:null;
  return emit(verdict,reason,checks);
}

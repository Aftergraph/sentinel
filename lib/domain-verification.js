import { hashBody } from './evidence.js';

export const VERIFIED='VERIFIED';
export const REJECTED='REJECTED';
export const INDETERMINATE='INDETERMINATE';

const SCHEMA='aftergraph.domain-evidence/1.0';
const CHECK_INTEGRITY='EVIDENCE_INTEGRITY';
const CHECK_CORRELATION='SUBJECT_CORRELATION';
const CHECK_READBACK='INDEPENDENT_READBACK';

function pass(type){return Object.freeze({type,status:'PASS'});}
function fail(type,reason){return Object.freeze({type,status:'FAIL',reason});}
function unknown(type,reason){return Object.freeze({type,status:'INDETERMINATE',reason});}
function text(value){return typeof value==='string'&&value.trim()?value.trim():null;}

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

function rejected(reason,checks=[]){
  return Object.freeze({
    schema:'aftergraph.domain-verification.result/1.0',
    verdict:REJECTED,
    reason,
    checks:Object.freeze([...checks]),
  });
}

export async function verifyDomainEvidence({envelope}={}){
  if(!envelope||envelope.schema!==SCHEMA){
    return rejected('unsupported_domain_evidence_schema');
  }
  if(!structurallyValid(envelope)){
    return rejected('invalid_domain_evidence_envelope');
  }
  const checks=[];
  const recomputed=hashBody(envelope.evidence.body);
  if(recomputed!==envelope.evidence.digestSha256){
    checks.push(fail(CHECK_INTEGRITY,'evidence_digest_mismatch'));
    return rejected('evidence_integrity_failed',checks);
  }
  checks.push(pass(CHECK_INTEGRITY));

  if(!correlationMatches(envelope)){
    checks.push(fail(CHECK_CORRELATION,'subject_correlation_mismatch'));
    return rejected('subject_correlation_failed',checks);
  }
  checks.push(pass(CHECK_CORRELATION));
  checks.push(unknown(CHECK_READBACK,'independent_check_required'));

  return Object.freeze({
    schema:'aftergraph.domain-verification.result/1.0',
    verdict:INDETERMINATE,
    reason:'independent_verification_required',
    checks:Object.freeze(checks),
  });
}

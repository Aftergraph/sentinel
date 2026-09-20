import { hashBody } from './evidence.js';

export const SIMPLIFICATION_PRODUCER_SCHEMA='aftergraph.code-simplification-output/1.1';
export const SIMPLIFICATION_EVIDENCE_SCHEMA='aftergraph.simplification-evidence/1.0';

const REQUIRED_OBLIGATIONS=Object.freeze([
  'exact-revision-evidence',
  'repository-native-gates-pass',
  'behavior-preserved',
  'canonical-owner-preserved',
]);

function nonEmpty(value){
  return typeof value==='string'&&value.trim()!==''?value.trim():null;
}
function shaRevision(value){
  return typeof value==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(value);
}
function sha256Uri(value){
  return typeof value==='string'&&/^sha256:[a-f0-9]{64}$/u.test(value);
}
function uniqueRefs(value){
  if(!Array.isArray(value))return null;
  const refs=value.map(nonEmpty);
  if(refs.some(v=>v===null))return null;
  return [...new Set(refs)];
}
function normalizeClaimObligations(value){
  if(!Array.isArray(value))return null;
  const out=[];
  const seen=new Set();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item))return null;
    const id=nonEmpty(item.id);
    const status=nonEmpty(item.claim_status);
    const evidenceRefs=uniqueRefs(item.evidence_refs);
    if(!id||seen.has(id)||!evidenceRefs)return null;
    if(!['pass','fail','indeterminate'].includes(status))return null;
    seen.add(id);
    out.push(Object.freeze({
      id,
      status:status.toUpperCase(),
      evidenceRefs:Object.freeze(evidenceRefs),
    }));
  }
  return Object.freeze(out);
}

export function adaptSimplificationProducerClaim({
  claim,
  missionId,
  executorRef,
  observedAt,
}={}){
  if(!claim||typeof claim!=='object'||Array.isArray(claim)){
    throw new Error('invalid_simplification_producer_claim');
  }
  if(claim.schema!==SIMPLIFICATION_PRODUCER_SCHEMA){
    throw new Error('unsupported_simplification_producer_schema');
  }
  if(Object.prototype.hasOwnProperty.call(claim,'verdict')||
     Object.prototype.hasOwnProperty.call(claim,'verified')||
     Object.prototype.hasOwnProperty.call(claim,'verification')){
    throw new Error('producer_self_verification_forbidden');
  }
  const mission=nonEmpty(missionId);
  const executor=nonEmpty(executorRef);
  const observed=nonEmpty(observedAt);
  const repository=nonEmpty(claim.repository);
  const owner=nonEmpty(claim.canonical_owner);
  const changedPaths=uniqueRefs(claim.changed_paths);
  const allEvidenceRefs=uniqueRefs(claim.evidence_refs);
  const obligations=normalizeClaimObligations(claim.obligations);
  if(!mission||!executor||!observed||!repository||!owner||!changedPaths||changedPaths.length===0||
     !allEvidenceRefs||allEvidenceRefs.length===0||!obligations||
     !shaRevision(claim.baseline_revision)||!shaRevision(claim.final_revision)||
     !sha256Uri(claim.skill_digest_sha256)||
     !['completed','partial','rejected'].includes(claim.execution_status)){
    throw new Error('invalid_simplification_producer_claim');
  }

  const obligationIds=new Set(obligations.map(x=>x.id));
  for(const required of REQUIRED_OBLIGATIONS){
    if(!obligationIds.has(required))throw new Error('missing_required_simplification_obligation');
  }

  const topRefs=new Set(allEvidenceRefs);
  for(const obligation of obligations){
    for(const ref of obligation.evidenceRefs){
      if(!topRefs.has(ref))throw new Error('obligation_evidence_ref_not_declared');
    }
  }

  const skillDigestSha256=claim.skill_digest_sha256.slice('sha256:'.length);
  const body=Object.freeze({
    repository,
    baselineRevision:claim.baseline_revision,
    finalRevision:claim.final_revision,
    skillDigestSha256,
    canonicalOwner:owner,
    executionStatus:claim.execution_status,
    changedPaths:Object.freeze([...changedPaths]),
    evidenceRefs:Object.freeze([...allEvidenceRefs]),
    obligations,
  });

  return Object.freeze({
    schema:SIMPLIFICATION_EVIDENCE_SCHEMA,
    subject:Object.freeze({
      missionId:mission,
      repository,
      baselineRevision:claim.baseline_revision,
      finalRevision:claim.final_revision,
      skillDigestSha256,
      executorRef:executor,
    }),
    evidence:Object.freeze({
      digestSha256:hashBody(body),
      observedAt:observed,
      body,
    }),
  });
}

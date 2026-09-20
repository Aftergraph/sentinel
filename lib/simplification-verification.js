import { hashBody } from './evidence.js';

export const VERIFIED='VERIFIED';
export const REJECTED='REJECTED';
export const INDETERMINATE='INDETERMINATE';

const SCHEMA='aftergraph.simplification-evidence/1.0';
const RESULT_SCHEMA='aftergraph.simplification-verification.result/1.0';
const RECEIPT_SCHEMA='aftergraph.simplification-verification.receipt/1.0';
const PROFILE='code-simplification-evidence/1.0';

const REQUIRED_OBLIGATIONS=Object.freeze([
  'exact-revision-evidence',
  'repository-native-gates-pass',
  'behavior-preserved',
  'canonical-owner-preserved',
]);

function text(v){return typeof v==='string'&&v.trim()?v.trim():null;}
function shaRevision(v){return typeof v==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(v);}
function sha256(v){return typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);}
function refs(v){return Array.isArray(v)?[...new Set(v.filter(text))]:[];}
function check(type,status,reason=null,extra={}) {
  return Object.freeze({type,status,...(reason?{reason}:{}),...extra});
}

function structural(envelope){
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return false;
  const {subject,evidence}=envelope;
  if(!subject||!evidence||typeof evidence.body!=='object'||Array.isArray(evidence.body))return false;
  return [
    subject.missionId,subject.repository,subject.skillDigestSha256,subject.executorRef,
    evidence.digestSha256,evidence.observedAt,
  ].every(text)
    && shaRevision(subject.baselineRevision)
    && shaRevision(subject.finalRevision)
    && sha256(subject.skillDigestSha256)
    && sha256(evidence.digestSha256);
}

function bodyCorrelates(envelope){
  const {subject}=envelope;
  const body=envelope.evidence.body;
  return body.repository===subject.repository
    && body.baselineRevision===subject.baselineRevision
    && body.finalRevision===subject.finalRevision
    && body.skillDigestSha256===subject.skillDigestSha256;
}

function normalizeObligations(body){
  if(!Array.isArray(body.obligations))return null;
  const out=new Map();
  for(const item of body.obligations){
    if(!item||typeof item!=='object'||Array.isArray(item))return null;
    const id=text(item.id);
    const status=text(item.status);
    const evidenceRefs=refs(item.evidenceRefs);
    if(!id||out.has(id)||!['PASS','FAIL','INDETERMINATE'].includes(status))return null;
    out.set(id,Object.freeze({id,status,evidenceRefs}));
  }
  return out;
}

function stableReceiptBody(receipt){
  return {
    schema:receipt.schema,
    profile:receipt.profile,
    missionId:receipt.missionId,
    repository:receipt.repository,
    baselineRevision:receipt.baselineRevision,
    finalRevision:receipt.finalRevision,
    skillDigestSha256:receipt.skillDigestSha256,
    verdict:receipt.verdict,
    reason:receipt.reason??null,
    evidenceDigestSha256:receipt.evidenceDigestSha256,
    checks:receipt.checks,
    verifierRef:receipt.verifierRef,
    observerRef:receipt.observerRef??null,
    resolvedEvidenceRefs:receipt.resolvedEvidenceRefs??[],
  };
}

export function verifySimplificationVerificationReceipt(receipt){
  if(!receipt||receipt.schema!==RECEIPT_SCHEMA)return false;
  const digest=hashBody(stableReceiptBody(receipt));
  return receipt.receiptDigestSha256===digest
    && receipt.receiptId===`dvr_${digest}`
    && receipt.verificationId===`dv_${digest}`;
}

function makeReceipt({envelope,verdict,reason,checks,verifierRef,verifiedAt,observerRef=null,resolvedEvidenceRefs=[]}){
  const stable={
    schema:RECEIPT_SCHEMA,
    profile:PROFILE,
    missionId:envelope.subject.missionId,
    repository:envelope.subject.repository,
    baselineRevision:envelope.subject.baselineRevision,
    finalRevision:envelope.subject.finalRevision,
    skillDigestSha256:envelope.subject.skillDigestSha256,
    verdict,
    reason:reason??null,
    evidenceDigestSha256:envelope.evidence.digestSha256,
    checks:Object.freeze([...checks]),
    verifierRef,
    observerRef,
    resolvedEvidenceRefs:Object.freeze([...resolvedEvidenceRefs].sort()),
  };
  const digest=hashBody(stable);
  return Object.freeze({
    ...stable,
    verificationId:`dv_${digest}`,
    verifiedAt,
    receiptDigestSha256:digest,
    receiptId:`dvr_${digest}`,
  });
}

function bare(verdict,reason,checks=[]){
  return Object.freeze({schema:RESULT_SCHEMA,verdict,reason,checks:Object.freeze([...checks])});
}

export async function verifySimplificationEvidence({
  envelope,
  independentCheck,
  verifierRef,
  now=()=>new Date().toISOString(),
}={}){
  const verifier=text(verifierRef);
  if(!verifier||!verifier.startsWith('sentinel:')){
    return bare(INDETERMINATE,'sentinel_verifier_ref_required');
  }
  if(!structural(envelope)||envelope.schema!==SCHEMA){
    return bare(REJECTED,'invalid_simplification_evidence_envelope');
  }

  const emit=(verdict,reason,checks,extra={})=>{
    const receipt=makeReceipt({
      envelope,verdict,reason,checks,verifierRef:verifier,verifiedAt:now(),...extra,
    });
    return Object.freeze({
      schema:RESULT_SCHEMA,verdict,...(reason?{reason}:{}),
      checks:Object.freeze([...checks]),receipt,
    });
  };

  const checks=[];
  if(hashBody(envelope.evidence.body)!==envelope.evidence.digestSha256){
    checks.push(check('EVIDENCE_INTEGRITY','FAIL','evidence_digest_mismatch'));
    return emit(REJECTED,'evidence_integrity_failed',checks);
  }
  checks.push(check('EVIDENCE_INTEGRITY','PASS'));

  if(!bodyCorrelates(envelope)||envelope.subject.baselineRevision===envelope.subject.finalRevision){
    checks.push(check('REVISION_BINDING','FAIL','revision_binding_mismatch'));
    return emit(REJECTED,'revision_binding_failed',checks);
  }
  checks.push(check('REVISION_BINDING','PASS'));

  const owner=text(envelope.evidence.body.canonicalOwner);
  const changedPaths=Array.isArray(envelope.evidence.body.changedPaths)
    ? envelope.evidence.body.changedPaths.filter(text):null;
  const obligations=normalizeObligations(envelope.evidence.body);
  if(!owner||!changedPaths||changedPaths.length===0||!obligations){
    checks.push(check('OBLIGATIONS','FAIL','invalid_simplification_claims'));
    return emit(REJECTED,'obligation_contract_failed',checks);
  }

  const allClaimedRefs=[];
  for(const id of REQUIRED_OBLIGATIONS){
    const item=obligations.get(id);
    if(!item||item.status!=='PASS'||item.evidenceRefs.length===0){
      checks.push(check('OBLIGATIONS','FAIL','required_obligation_not_proven',{obligation:id}));
      return emit(REJECTED,'obligation_contract_failed',checks);
    }
    allClaimedRefs.push(...item.evidenceRefs);
  }
  const claimedRefs=[...new Set(allClaimedRefs)].sort();
  checks.push(check('OBLIGATIONS','PASS',null,{canonicalOwner:owner,evidenceRefs:claimedRefs}));

  if(verifier===envelope.subject.executorRef){
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE','verifier_not_independent'));
    return emit(INDETERMINATE,'verifier_not_independent',checks);
  }
  if(typeof independentCheck!=='function'){
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE','independent_check_required'));
    return emit(INDETERMINATE,'independent_check_required',checks);
  }

  let observed;
  try{
    observed=await independentCheck({
      subject:envelope.subject,
      evidence:envelope.evidence,
      obligationIds:[...REQUIRED_OBLIGATIONS],
      evidenceRefs:claimedRefs,
    });
  }catch{
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE','independent_check_error'));
    return emit(INDETERMINATE,'independent_check_error',checks);
  }

  const observerRef=text(observed?.observerRef);
  const resolved=refs(observed?.evidenceRefs).sort();
  if(!observerRef||observerRef===envelope.subject.executorRef){
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE',observerRef?'observer_not_independent':'observer_ref_required'));
    return emit(INDETERMINATE,observerRef?'observer_not_independent':'observer_ref_required',checks);
  }
  if(observed?.status==='FAIL'){
    checks.push(check('INDEPENDENT_EVIDENCE','FAIL','independent_evidence_failed',{observerRef,evidenceRefs:resolved}));
    return emit(REJECTED,'independent_evidence_failed',checks,{observerRef,resolvedEvidenceRefs:resolved});
  }
  if(observed?.status!=='PASS'){
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE','independent_evidence_indeterminate',{observerRef,evidenceRefs:resolved}));
    return emit(INDETERMINATE,'independent_evidence_indeterminate',checks,{observerRef,resolvedEvidenceRefs:resolved});
  }
  const resolvedSet=new Set(resolved);
  if(claimedRefs.some(ref=>!resolvedSet.has(ref))){
    checks.push(check('INDEPENDENT_EVIDENCE','INDETERMINATE','evidence_ref_unresolved',{observerRef,evidenceRefs:resolved}));
    return emit(INDETERMINATE,'evidence_ref_unresolved',checks,{observerRef,resolvedEvidenceRefs:resolved});
  }

  checks.push(check('INDEPENDENT_EVIDENCE','PASS',null,{observerRef,evidenceRefs:resolved}));
  return emit(VERIFIED,null,checks,{observerRef,resolvedEvidenceRefs:resolved});
}

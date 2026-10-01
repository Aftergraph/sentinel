import { createHash } from 'node:crypto';
import { hashBody } from './evidence.js';

export const FIHIM_OPERATOR_DEPLOYMENT_RESULT_SCHEMA =
  'aftergraph.fihim-operator-deployment-verification.result/1.0';
export const FIHIM_OPERATOR_DEPLOYMENT_RECEIPT_SCHEMA =
  'aftergraph.fihim-operator-deployment-verification.receipt/1.0';

export const VERIFIED='VERIFIED';
export const REJECTED='REJECTED';
export const INDETERMINATE='INDETERMINATE';

function canonicalize(value){
  if(Array.isArray(value)) return value.map(canonicalize);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])]));
  }
  return value;
}
function sha256Buffer(buffer){
  return 'sha256:'+createHash('sha256').update(buffer).digest('hex');
}
function sha256Object(value){
  return sha256Buffer(Buffer.from(JSON.stringify(canonicalize(value)),'utf8'));
}
function text(value){return typeof value==='string'&&value.trim()?value.trim():null;}
function refs(value){return Array.isArray(value)?value.filter(text):[];}
function pass(type,extra={}){return Object.freeze({type,status:'PASS',...extra});}
function fail(type,reason,extra={}){return Object.freeze({type,status:'FAIL',reason,...extra});}
function unknown(type,reason,extra={}){return Object.freeze({type,status:'INDETERMINATE',reason,...extra});}

function verifyReleasePlan(plan){
  if(!plan||plan.version!=='operator-vds-release-plan/0.56-frontier'){
    return fail('RELEASE_PLAN_INTEGRITY','unsupported_release_plan');
  }
  const body={...plan};
  delete body.planHash;
  const computed=sha256Object(body);
  return computed===plan.planHash
    ? pass('RELEASE_PLAN_INTEGRITY',{planHash:computed})
    : fail('RELEASE_PLAN_INTEGRITY','release_plan_hash_mismatch',{computed,declared:plan.planHash||null});
}

function verifyExecutionReceipt(receipt,plan){
  if(!receipt||receipt.version!=='operator-vds-release-executor/0.57-frontier'){
    return fail('EXECUTION_RECEIPT_INTEGRITY','unsupported_execution_receipt');
  }
  const expectedTarget=plan?.paths?.releaseDir||null;
  const ok=receipt.status==='ACTIVATED'
    && receipt.mode==='APPLY'
    && receipt.mutationPerformed===true
    && receipt.staged===true
    && receipt.dependenciesInstalled===true
    && receipt.stagedVerificationPassed===true
    && receipt.rolledBack===false
    && receipt.planHash===plan?.planHash
    && receipt.releaseId===plan?.releaseId
    && receipt.sourceRevision===plan?.sourceRevision
    && receipt.activatedTarget===expectedTarget
    && receipt.truth?.sourceArtifactsVerified===true
    && receipt.truth?.executionGrantsAuthority===false
    && receipt.truth?.executionIsIndependentVerification===false
    && receipt.truth?.deploymentMaySelfPromoteVerified===false;
  return ok
    ? pass('EXECUTION_RECEIPT_INTEGRITY')
    : fail('EXECUTION_RECEIPT_INTEGRITY','execution_receipt_mismatch');
}

function deploymentReceiptBody(receipt){
  const body={...receipt};
  delete body.receiptHash;
  return body;
}
function verifyDeploymentReceipt(receipt,{pluginBytes,mcpManifestBytes,mcpManifest}={}){
  if(!receipt||receipt.version!=='operator-public-deployment-receipt/0.54-frontier'){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','unsupported_public_deployment_receipt');
  }
  const computed=sha256Object(deploymentReceiptBody(receipt));
  if(computed!==receipt.receiptHash){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','deployment_receipt_hash_mismatch');
  }
  if(pluginBytes&&receipt.artifacts?.plugin?.sha256!==sha256Buffer(pluginBytes)){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','plugin_digest_mismatch');
  }
  if(mcpManifestBytes&&receipt.artifacts?.mcpManifest?.sha256!==sha256Buffer(mcpManifestBytes)){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','mcp_manifest_digest_mismatch');
  }
  const endpoint=mcpManifest?.mcpServers?.fihim_operator?.url;
  if(endpoint&&endpoint!==receipt.target?.mcpEndpoint){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','mcp_endpoint_mismatch');
  }
  if(
    receipt.truth?.bearerTokenIncluded!==false ||
    receipt.truth?.receiptGrantsAuthority!==false ||
    receipt.truth?.receiptIsIndependentVerification!==false ||
    receipt.truth?.receiptMaySelfPromoteVerified!==false
  ){
    return fail('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','deployment_receipt_truth_boundary_failed');
  }
  return pass('PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY');
}

function correlationCheck({releasePlan,executionReceipt,deploymentReceipt,mcpManifest}={}){
  const endpoint=mcpManifest?.mcpServers?.fihim_operator?.url||null;
  const origin=endpoint?new URL(endpoint).origin:null;
  const ok=Boolean(
    releasePlan &&
    executionReceipt &&
    deploymentReceipt &&
    releasePlan.sourceRevision===executionReceipt.sourceRevision &&
    releasePlan.sourceRevision===deploymentReceipt.sourceRevision &&
    deploymentReceipt.target?.mcpEndpoint===endpoint &&
    deploymentReceipt.target?.origin===origin &&
    deploymentReceipt.observations?.publicHttps===true &&
    deploymentReceipt.observations?.remoteIdentityReady===true
  );
  return ok
    ? pass('DEPLOYMENT_CORRELATION',{origin,endpoint,sourceRevision:releasePlan.sourceRevision})
    : fail('DEPLOYMENT_CORRELATION','deployment_subject_mismatch');
}

async function independentReadback({independentCheck,subject,executorRef}={}){
  if(typeof independentCheck!=='function'){
    return unknown('INDEPENDENT_READBACK','independent_check_required');
  }
  let observed;
  try{
    observed=await independentCheck(subject);
  }catch{
    return unknown('INDEPENDENT_READBACK','independent_check_error');
  }
  if(!observed||typeof observed!=='object'||Array.isArray(observed)){
    return unknown('INDEPENDENT_READBACK','independent_check_invalid');
  }
  const observerRef=text(observed.observerRef);
  const evidenceRefs=refs(observed.evidenceRefs);
  if(!observerRef) return unknown('INDEPENDENT_READBACK','observer_ref_required');
  if(observerRef===executorRef) return unknown('INDEPENDENT_READBACK','observer_not_independent',{observerRef,evidenceRefs});
  if(observed.status==='PASS'&&evidenceRefs.length===0){
    return unknown('INDEPENDENT_READBACK','independent_evidence_required',{observerRef,evidenceRefs});
  }
  if(observed.status==='PASS'){
    const matches=observed.origin===subject.origin
      && observed.mcpEndpoint===subject.mcpEndpoint
      && observed.protocolEra==='modern'
      && observed.readOnlyOnly===true;
    return matches
      ? pass('INDEPENDENT_READBACK',{observerRef,evidenceRefs})
      : fail('INDEPENDENT_READBACK','independent_readback_subject_mismatch',{observerRef,evidenceRefs});
  }
  if(observed.status==='FAIL') return fail('INDEPENDENT_READBACK','independent_readback_failed',{observerRef,evidenceRefs});
  return unknown('INDEPENDENT_READBACK','independent_readback_indeterminate',{observerRef,evidenceRefs});
}

function makeReceipt({subject,verdict,reason,checks,verifierRef,executorRef,now}){
  const stableBody={
    schema:FIHIM_OPERATOR_DEPLOYMENT_RECEIPT_SCHEMA,
    subject,
    verdict,
    reason:reason??null,
    checks,
    verifierRef,
    executorRef,
  };
  const receiptDigestSha256=hashBody(stableBody);
  return Object.freeze({
    ...stableBody,
    receiptDigestSha256,
    receiptId:`fodvr_${receiptDigestSha256}`,
    verifiedAt:now(),
  });
}

export function verifyFihimOperatorDeploymentReceipt(receipt){
  if(!receipt||receipt.schema!==FIHIM_OPERATOR_DEPLOYMENT_RECEIPT_SCHEMA) return false;
  const {receiptDigestSha256,receiptId,verifiedAt:_,...stableBody}=receipt;
  const digest=hashBody(stableBody);
  return receiptDigestSha256===digest&&receiptId===`fodvr_${digest}`;
}

export async function verifyFihimOperatorDeployment({
  releasePlan,
  executionReceipt,
  deploymentReceipt,
  pluginBytes=null,
  mcpManifestBytes=null,
  mcpManifest=null,
  independentCheck=null,
  verifierRef='sentinel:fihim-operator-deployment',
  executorRef=null,
  now=()=>new Date().toISOString(),
}={}){
  const checks=[
    verifyReleasePlan(releasePlan),
    verifyExecutionReceipt(executionReceipt,releasePlan),
    verifyDeploymentReceipt(deploymentReceipt,{pluginBytes,mcpManifestBytes,mcpManifest}),
  ];
  const integrityFailure=checks.find((check)=>check.status==='FAIL');
  const derivedExecutorRef=text(executorRef)||`fihim-vds:${releasePlan?.sourceRevision||'unknown'}`;

  let subject={
    sourceRevision:releasePlan?.sourceRevision||null,
    releaseId:releasePlan?.releaseId||null,
    origin:deploymentReceipt?.target?.origin||null,
    mcpEndpoint:deploymentReceipt?.target?.mcpEndpoint||null,
    identityMode:deploymentReceipt?.target?.identityMode||null,
    pluginVersion:deploymentReceipt?.product?.pluginVersion||null,
    planHash:releasePlan?.planHash||null,
    executionReceiptVersion:executionReceipt?.version||null,
    deploymentReceiptHash:deploymentReceipt?.receiptHash||null,
  };

  if(integrityFailure){
    const receipt=makeReceipt({
      subject,verdict:REJECTED,reason:integrityFailure.reason,checks,
      verifierRef,executorRef:derivedExecutorRef,now,
    });
    return Object.freeze({
      schema:FIHIM_OPERATOR_DEPLOYMENT_RESULT_SCHEMA,
      verdict:REJECTED,
      reason:integrityFailure.reason,
      checks:Object.freeze(checks),
      receipt,
    });
  }

  const correlation=correlationCheck({releasePlan,executionReceipt,deploymentReceipt,mcpManifest});
  checks.push(correlation);
  if(correlation.status==='FAIL'){
    const receipt=makeReceipt({
      subject,verdict:REJECTED,reason:correlation.reason,checks,
      verifierRef,executorRef:derivedExecutorRef,now,
    });
    return Object.freeze({
      schema:FIHIM_OPERATOR_DEPLOYMENT_RESULT_SCHEMA,
      verdict:REJECTED,
      reason:correlation.reason,
      checks:Object.freeze(checks),
      receipt,
    });
  }

  const readback=await independentReadback({independentCheck,subject,executorRef:derivedExecutorRef});
  checks.push(readback);
  const verdict=readback.status==='PASS'?VERIFIED
    :readback.status==='FAIL'?REJECTED
      :INDETERMINATE;
  const reason=verdict===VERIFIED?null:readback.reason;

  const receipt=makeReceipt({
    subject,verdict,reason,checks,
    verifierRef,executorRef:derivedExecutorRef,now,
  });
  return Object.freeze({
    schema:FIHIM_OPERATOR_DEPLOYMENT_RESULT_SCHEMA,
    verdict,
    ...(reason?{reason}:{}),
    checks:Object.freeze(checks),
    receipt,
  });
}

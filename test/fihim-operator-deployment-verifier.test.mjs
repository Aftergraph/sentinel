import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  verifyFihimOperatorDeployment,
  verifyFihimOperatorDeploymentReceipt,
  VERIFIED,
  REJECTED,
  INDETERMINATE,
} from '../lib/fihim-operator-deployment-verifier.mjs';

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

function fixture(){
  const sourceRevision='a'.repeat(40);
  const origin='https://fihim.example.com';
  const mcpManifest={
    $schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers:{fihim_operator:{type:'streamable-http',url:origin+'/api/v1/operator/mcp'}},
  };
  const plugin={name:'fihim-operator',version:'0.11.0'};
  const pluginBytes=Buffer.from(JSON.stringify(plugin,null,2)+'\n');
  const mcpManifestBytes=Buffer.from(JSON.stringify(mcpManifest,null,2)+'\n');
  const releasePlan={
    version:'operator-vds-release-plan/0.56-frontier',
    sourceRevision,
    releaseId:sourceRevision.slice(0,12),
    paths:{
      releaseRoot:'/opt/fihim/releases',
      releaseDir:'/opt/fihim/releases/'+sourceRevision.slice(0,12),
      currentLink:'/opt/fihim/current',
    },
    artifacts:[],
    phases:[],
    invariants:[],
    truth:{
      planOnly:true,
      mutationPerformed:false,
      authorityGranted:false,
      publicReachabilityProven:false,
      independentlyVerified:false,
    },
  };
  releasePlan.planHash=sha256Object(releasePlan);

  const executionReceipt={
    version:'operator-vds-release-executor/0.57-frontier',
    mode:'APPLY',
    planHash:releasePlan.planHash,
    releaseId:releasePlan.releaseId,
    sourceRevision,
    previousTarget:'/opt/fihim/releases/previous1234',
    activatedTarget:releasePlan.paths.releaseDir,
    rolledBack:false,
    staged:true,
    dependenciesInstalled:true,
    stagedVerificationPassed:true,
    status:'ACTIVATED',
    mutationPerformed:true,
    truth:{
      sourceArtifactsVerified:true,
      executionGrantsAuthority:false,
      executionIsIndependentVerification:false,
      deploymentMaySelfPromoteVerified:false,
    },
  };

  const deploymentReceipt={
    version:'operator-public-deployment-receipt/0.54-frontier',
    generatedAt:'2026-10-01T20:00:00.000Z',
    sourceRevision,
    workflow:{runId:'123',provider:'github-actions'},
    target:{
      origin,
      mcpEndpoint:mcpManifest.mcpServers.fihim_operator.url,
      identityMode:'session-token',
    },
    product:{
      pluginVersion:plugin.version,
      operatorApi:'operator-api/0.42-frontier',
      stableProtocols:{operatorMcp:'mcp-operator/0.45-frontier'},
    },
    artifacts:{
      plugin:{path:'plugins/fihim-operator/plugin.json',sha256:sha256Buffer(pluginBytes)},
      mcpManifest:{path:'plugins/fihim-operator/mcp.json',sha256:sha256Buffer(mcpManifestBytes)},
    },
    observations:{
      readinessVersion:'operator-readiness/0.42-frontier',
      publicHttps:true,
      remoteIdentityReady:true,
    },
    truth:{
      bearerTokenIncluded:false,
      publicEndpointObserved:true,
      hostAcceptanceWorkflowPrerequisite:true,
      receiptGrantsAuthority:false,
      receiptIsIndependentVerification:false,
      receiptMaySelfPromoteVerified:false,
    },
  };
  deploymentReceipt.receiptHash=sha256Object(deploymentReceipt);

  return {sourceRevision,origin,mcpManifest,pluginBytes,mcpManifestBytes,releasePlan,executionReceipt,deploymentReceipt};
}

test('valid deployment evidence without independent readback is INDETERMINATE', async()=>{
  const fx=fixture();
  const out=await verifyFihimOperatorDeployment(fx);
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'independent_check_required');
  assert.equal(verifyFihimOperatorDeploymentReceipt(out.receipt),true);
  assert.deepEqual(out.checks.map((check)=>[check.type,check.status]),[
    ['RELEASE_PLAN_INTEGRITY','PASS'],
    ['EXECUTION_RECEIPT_INTEGRITY','PASS'],
    ['PUBLIC_DEPLOYMENT_RECEIPT_INTEGRITY','PASS'],
    ['DEPLOYMENT_CORRELATION','PASS'],
    ['INDEPENDENT_READBACK','INDETERMINATE'],
  ]);
});

test('independent matching readback produces VERIFIED', async()=>{
  const fx=fixture();
  const out=await verifyFihimOperatorDeployment({
    ...fx,
    verifierRef:'sentinel:test',
    independentCheck:async(subject)=>({
      status:'PASS',
      observerRef:'sentinel:observer:public-readback',
      evidenceRefs:['https-readback:1'],
      origin:subject.origin,
      mcpEndpoint:subject.mcpEndpoint,
      protocolEra:'modern',
      readOnlyOnly:true,
    }),
  });
  assert.equal(out.verdict,VERIFIED);
  assert.equal(out.receipt.verdict,VERIFIED);
  assert.equal(verifyFihimOperatorDeploymentReceipt(out.receipt),true);
});

test('same observer as executor can never produce VERIFIED', async()=>{
  const fx=fixture();
  const executorRef='fihim-vds:'+fx.sourceRevision;
  const out=await verifyFihimOperatorDeployment({
    ...fx,
    executorRef,
    independentCheck:async(subject)=>({
      status:'PASS',
      observerRef:executorRef,
      evidenceRefs:['self:1'],
      origin:subject.origin,
      mcpEndpoint:subject.mcpEndpoint,
      protocolEra:'modern',
      readOnlyOnly:true,
    }),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'observer_not_independent');
});

test('independent PASS without evidence refs stays INDETERMINATE', async()=>{
  const fx=fixture();
  const out=await verifyFihimOperatorDeployment({
    ...fx,
    independentCheck:async(subject)=>({
      status:'PASS',
      observerRef:'sentinel:observer:1',
      evidenceRefs:[],
      origin:subject.origin,
      mcpEndpoint:subject.mcpEndpoint,
      protocolEra:'modern',
      readOnlyOnly:true,
    }),
  });
  assert.equal(out.verdict,INDETERMINATE);
  assert.equal(out.reason,'independent_evidence_required');
});

test('tampered release plan is REJECTED before readback', async()=>{
  const fx=fixture();
  fx.releasePlan.releaseId='tampered';
  let called=false;
  const out=await verifyFihimOperatorDeployment({
    ...fx,
    independentCheck:async()=>{called=true;return {status:'PASS'};},
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'release_plan_hash_mismatch');
  assert.equal(called,false);
});

test('execution receipt without staged verification is REJECTED', async()=>{
  const fx=fixture();
  fx.executionReceipt.stagedVerificationPassed=false;
  const out=await verifyFihimOperatorDeployment(fx);
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'execution_receipt_mismatch');
});

test('tampered mcp manifest bytes are REJECTED', async()=>{
  const fx=fixture();
  fx.mcpManifestBytes=Buffer.from('{}\n');
  const out=await verifyFihimOperatorDeployment(fx);
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'mcp_manifest_digest_mismatch');
});

test('independent subject mismatch is REJECTED', async()=>{
  const fx=fixture();
  const out=await verifyFihimOperatorDeployment({
    ...fx,
    independentCheck:async(subject)=>({
      status:'PASS',
      observerRef:'sentinel:observer:1',
      evidenceRefs:['obs:1'],
      origin:'https://other.example.com',
      mcpEndpoint:subject.mcpEndpoint,
      protocolEra:'modern',
      readOnlyOnly:true,
    }),
  });
  assert.equal(out.verdict,REJECTED);
  assert.equal(out.reason,'independent_readback_subject_mismatch');
});

test('receipt tampering is detected offline', async()=>{
  const fx=fixture();
  const out=await verifyFihimOperatorDeployment(fx);
  assert.equal(verifyFihimOperatorDeploymentReceipt(out.receipt),true);
  const tampered={...out.receipt,subject:{...out.receipt.subject,origin:'https://tampered.example'}};
  assert.equal(verifyFihimOperatorDeploymentReceipt(tampered),false);
});

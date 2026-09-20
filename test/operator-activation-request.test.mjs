import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const requestPath=join(here,'..','ops','requests','sentinel-simplification-verifier-production-v1.json');
const request=JSON.parse(readFileSync(requestPath,'utf8'));

test('operator activation request is exact and waiting for legitimate root authority',()=>{
  assert.equal(request.schema,'aftergraph.operator-activation-request/1.0');
  assert.equal(request.status,'WAITING_HUMAN');
  assert.equal(request.authority.required_principal,'root');
  assert.equal(request.authority.required_host,'vmi3517816');
  assert.equal(request.authority.generic_runner_principal,'agci');
  assert.equal(request.authority.generic_runner_must_remain_unprivileged,true);
});

test('operator request pins reviewed activation and independent readback revisions',()=>{
  assert.equal(request.source.repository,'Aftergraph/sentinel');
  assert.equal(request.source.activation_commit,'6bf1de6845b4a0606d3017a99851206beff860e2');
  assert.equal(request.source.activation_script,'scripts/ops/activate-production-simplification-verifier.sh');
  assert.equal(request.source.readback_commit,'e446592182e24c81b204b65e59baeda28dde52ea');
  assert.equal(request.source.readback_workflow,'.github/workflows/production-simplification-verifier-readback.yml');
  assert.equal(request.source.tracking_issue,'https://github.com/Aftergraph/sentinel/issues/29');
});

test('operator request cannot authorize runner privilege widening or secret logging',()=>{
  assert.equal(request.execution.privilege_widening_forbidden,true);
  assert.equal(request.execution.secret_values_must_not_be_logged,true);
  const command=request.execution.command.join('\n');
  for(const forbidden of ['NOPASSWD','chmod 777','setcap','sudoers','NoNewPrivileges=false']){
    assert.equal(command.includes(forbidden),false,`forbidden authority expansion: ${forbidden}`);
  }
});

test('operator request acceptance contract is machine-checkable and terminal',()=>{
  assert.deepEqual(request.acceptance,{
    sentinel_service_active:true,
    works_health:true,
    works_verifier_ingest_configured:true,
    independent_observer:'sentinel:observer:github-actions',
    simplification_verdict:'VERIFIED',
    work_id_pattern:'^wrk_[a-f0-9]{32}$',
    receipt_id_pattern:'^dvr_[a-f0-9]{64}$',
    works_projection:'passed',
    wrong_token_status:401,
    credential_value_exposed:false,
  });
  assert.equal(request.post_activation.run_non_mutating_readback,true);
  assert.equal(request.post_activation.close_tracking_issue_only_after_all_acceptance_proven,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashBody } from '../lib/evidence.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI=path.join(ROOT,'bin','sentinel-research-verify.js');
function shaText(v){return createHash('sha256').update(String(v),'utf8').digest('hex');}
function envelope(){
 const responseText='NO_SECOND_EFFECT';
 const body={responseText,responseSha256:shaText(responseText),provider:'google',modelId:'gemini-2.5-flash'};
 const criterion={format:'EXACT_TOKEN',expected:'NO_SECOND_EFFECT'};
 return {schema:'aftergraph.research-evidence/1.0',subject:{studyId:'STUDY-012',executionId:'exec-1',traceId:'t1',workloadId:'S12-R2-REPLAY-A2',condition:'DI',executorRef:'runtime:study012',missionId:'wrk_test'},evidence:{body,digestSha256:hashBody(body),observedAt:'2026-09-18T18:00:00Z'},criterion:{...criterion,acceptanceCriteriaHash:hashBody(criterion)}};
}
test('research verifier CLI emits VERIFIED dvr receipt',()=>{
 const out=spawnSync(process.execPath,[CLI,'--verifier-ref','sentinel:domain-verifier'],{cwd:ROOT,input:JSON.stringify(envelope()),encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);
 const parsed=JSON.parse(out.stdout);
 assert.equal(parsed.verdict,'VERIFIED');
 assert.match(parsed.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
});
test('research verifier CLI fails closed without verifier ref',()=>{
 const out=spawnSync(process.execPath,[CLI],{cwd:ROOT,input:JSON.stringify(envelope()),encoding:'utf8'});
 assert.equal(out.status,2);
 assert.equal(JSON.parse(out.stdout).verdict,'INDETERMINATE');
});

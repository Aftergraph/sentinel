import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBody } from '../lib/evidence.js';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI=path.join(ROOT,'bin','sentinel.js');
const consoleToken='c'.repeat(32);
const observerToken='o'.repeat(32);
const worksToken='w'.repeat(32);

function envelope(){
  const body={schema:'rendetalje.provider-effect-reconciliation/1.0',tenantId:'tenant:rendetalje',subjectRef:'customer:c1',missionId:'mission:1',worksExecutionId:'works:1',effectId:'effect:1',idempotencyKey:'idem:1',receipt:{receiptId:'provider:1'},readback:'MATCH',reconciliation:{status:'RECONCILED'}};
  return {schema:'aftergraph.domain-evidence/1.0',subject:{tenantId:body.tenantId,missionId:body.missionId,effectId:body.effectId,idempotencyKey:body.idempotencyKey,subjectRef:body.subjectRef,executorRef:body.worksExecutionId},evidence:{type:'provider-effect-reconciliation',sourceRef:'provider-receipt:provider:1',digestSha256:hashBody(body),observedAt:'2026-09-16T00:00:00.000Z',body},claims:{reconciliationStatus:'RECONCILED',readback:'MATCH',eligibleForVerification:true}};
}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
function scratch(t){const dir=mkdtempSync(path.join(os.tmpdir(),'sentinel-domain-runtime-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function readJson(req){let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw);}

async function waitHealthy(base,child){
  const deadline=Date.now()+15000;
  for(;;){
    if(child.exitCode!==null)throw new Error(`sentinel exited early: ${child.exitCode}`);
    try{const res=await fetch(`${base}/api/healthz`);if(res.ok)return;}
    catch{}
    if(Date.now()>deadline)throw new Error('sentinel serve did not become healthy');
    await new Promise(r=>setTimeout(r,100));
  }
}
test('sentinel serve wires trusted readback and WORKS publisher from bounded runtime config',async t=>{
  const dir=scratch(t);let observed=null;let published=null;
  const observer=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/domain/readback')return json(res,404,{error:'not_found'});
    observed={auth:req.headers.authorization,body:await readJson(req)};
    return json(res,200,{status:'MATCH',evidenceRef:'obs:cli-runtime:1'});
  });
  const works=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||!req.url.endsWith('/verification'))return json(res,404,{error:'not_found'});
    published={url:req.url,token:req.headers['x-works-verifier-token'],body:await readJson(req)};
    return json(res,200,{ok:true});
  });
  const observerBase=await listen(observer),worksBase=await listen(works);
  t.after(async()=>{observer.close();works.close();await Promise.all([once(observer,'close'),once(works,'close')]);});
  const port=await freePort();const storePath=path.join(dir,'domain.json');
  const child=spawn(process.execPath,[CLI,'serve','--host','127.0.0.1','--port',String(port),'--token',consoleToken,'--domain-verification-store',storePath,'--domain-verifier-ref','sentinel:service:cli','--domain-observer-url',observerBase,'--domain-observer-ref','sentinel:observer:cli','--domain-works-url',worksBase],{cwd:ROOT,env:{...process.env,SENTINEL_DOMAIN_OBSERVER_TOKEN:observerToken,SENTINEL_WORKS_VERIFIER_TOKEN:worksToken},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>{stderr+=d;});t.after(()=>child.kill('SIGKILL'));
  const base=`http://127.0.0.1:${port}`;await waitHealthy(base,child);
  const response=await fetch(`${base}/api/domain/verify`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${consoleToken}`},body:JSON.stringify({envelope:envelope()})});
  assert.equal(response.status,200,stderr);const out=await response.json();
  assert.equal(out.verdict,'VERIFIED');assert.match(out.receipt.receiptId,/^dvr_[a-f0-9]{64}$/);
  assert.equal(observed.auth,`Bearer ${observerToken}`);
  assert.deepEqual(observed.body,{subject:envelope().subject});
  assert.equal(JSON.stringify(observed).includes('receiptId'),false,'observer must receive subject only');
  assert.equal(published.token,worksToken);
  assert.match(published.url,/\/v1\/works\/mission%3A1\/verification$/);
  assert.deepEqual(published.body,{result:'passed',verifier_id:'sentinel:service:cli',evidence_ref:out.receipt.receiptId,verified_at:out.receipt.verifiedAt});
  const persisted=JSON.parse(readFileSync(storePath,'utf8'));
  assert.equal(persisted.receipts.length,1);assert.equal(persisted.receipts[0].receiptId,out.receipt.receiptId);
});

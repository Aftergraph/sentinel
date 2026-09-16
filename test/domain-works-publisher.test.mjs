import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWorksVerificationPublisher } from '../lib/domain-works-publisher.js';

const receipt={
  schema:'aftergraph.domain-verification.receipt/1.0',receiptId:'dvr_'+ 'a'.repeat(64),
  verdict:'VERIFIED',verifierRef:'sentinel:domain-verifier',verifiedAt:'2026-09-16T00:30:00Z',
};
const envelope={subject:{missionId:'wrk_0123456789abcdef0123456789abcdef'}};

async function server(handler){
  const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');
  return {s,base:`http://127.0.0.1:${s.address().port}`};
}

test('VERIFIED publishes passed receipt through dedicated verifier token',async()=>{
  let seen;
  const {s,base}=await server(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    seen={url:req.url,token:req.headers['x-works-verifier-token'],body:JSON.parse(body)};
    res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });
  try{
    const publish=createWorksVerificationPublisher({baseUrl:base,token:'x'.repeat(32)});
    await publish({receipt,envelope});
    assert.equal(seen.url,'/v1/works/wrk_0123456789abcdef0123456789abcdef/verification');
    assert.equal(seen.token,'x'.repeat(32));
    assert.deepEqual(seen.body,{result:'passed',verifier_id:'sentinel:domain-verifier',evidence_ref:receipt.receiptId,verified_at:receipt.verifiedAt});
  }finally{s.close();await once(s,'close');}
});
test('REJECTED publishes failed; INDETERMINATE is never published',async()=>{
  let calls=0,last;
  const {s,base}=await server(async(req,res)=>{calls++;let body='';for await(const c of req)body+=c;last=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
  try{
    const publish=createWorksVerificationPublisher({baseUrl:base,token:'y'.repeat(32)});
    await publish({receipt:{...receipt,verdict:'REJECTED'},envelope});
    assert.equal(last.result,'failed');
    await publish({receipt:{...receipt,verdict:'INDETERMINATE'},envelope});
    assert.equal(calls,1);
  }finally{s.close();await once(s,'close');}
});

test('publisher fails closed on weak config and upstream failure',async()=>{
  assert.throws(()=>createWorksVerificationPublisher({baseUrl:'https://works.example',token:'short'}),/token_min_32_bytes/);
  assert.throws(()=>createWorksVerificationPublisher({baseUrl:'http://works.example',token:'x'.repeat(32)}),/works_https_required/);
  const {s,base}=await server((_req,res)=>{res.writeHead(503);res.end('no');});
  try{
    const publish=createWorksVerificationPublisher({baseUrl:base,token:'z'.repeat(32)});
    await assert.rejects(()=>publish({receipt,envelope}),/works_verification_publish_failed/);
  }finally{s.close();await once(s,'close');}
});

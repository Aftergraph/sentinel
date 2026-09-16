import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDomainHttpReadback } from '../lib/domain-http-readback.js';

const token='r'.repeat(32);
const subject=Object.freeze({
  tenantId:'tenant:rendetalje',missionId:'wrk_123',effectId:'effect/abc',
  idempotencyKey:'idem 123',subjectRef:'customer:1',executorRef:'works_exec:1',
});

async function withServer(handler,fn){
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{return await fn(`http://127.0.0.1:${server.address().port}`);}
  finally{server.close();await once(server,'close');}
}

function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
test('HTTP readback sends only immutable subject with bearer auth',async()=>{
  let seen;
  await withServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    seen={method:req.method,url:req.url,auth:req.headers.authorization,body:JSON.parse(raw)};
    json(res,200,{status:'MATCH',evidenceRef:'obs:provider:1'});
  },async base=>{
    const observe=createDomainHttpReadback({baseUrl:base,token});
    const out=await observe({subject,evidence:{secret:'must-not-leave-sentinel'}});
    assert.deepEqual(out,{status:'MATCH',evidenceRef:'obs:provider:1'});
  });
  assert.equal(seen.method,'POST');
  assert.equal(seen.url,'/v1/domain/readback');
  assert.equal(seen.auth,`Bearer ${token}`);
  assert.deepEqual(seen.body,{subject});
  assert.equal(JSON.stringify(seen).includes('must-not-leave-sentinel'),false);
});

test('HTTP readback rejects weak credentials and plaintext non-loopback',()=>{
  assert.throws(()=>createDomainHttpReadback({baseUrl:'https://observer.example',token:'short'}),/token_min_32_bytes/);
  assert.throws(()=>createDomainHttpReadback({baseUrl:'http://observer.example',token}),/observer_https_required/);
});
test('HTTP readback fails closed without leaking upstream bodies',async()=>{
  await withServer((req,res)=>{res.writeHead(500,{'content-type':'text/plain'});res.end('provider-secret-detail');},async base=>{
    const observe=createDomainHttpReadback({baseUrl:base,token});
    await assert.rejects(()=>observe({subject}),error=>{
      assert.equal(error.message,'domain_readback_failed');
      assert.equal(String(error).includes('provider-secret-detail'),false);
      return true;
    });
  });
});

test('HTTP readback treats malformed observations as a safe failure',async()=>{
  await withServer((req,res)=>json(res,200,{status:'MATCH',secret:'not-evidence'}),async base=>{
    const observe=createDomainHttpReadback({baseUrl:base,token});
    await assert.rejects(()=>observe({subject}),/domain_readback_failed/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainReadbackObserver } from '../lib/domain-readback-observer.js';

const input={
  subject:{tenantId:'tenant:rendetalje',missionId:'wrk_0123456789abcdef0123456789abcdef',effectId:'effect_1',idempotencyKey:'idem_1',subjectRef:'customer:c1',executorRef:'works_exec_1'},
  evidence:{digestSha256:'a'.repeat(64),body:{readback:'MATCH'}},
};

test('matching independent readback becomes PASS with evidence reference',async()=>{
  const observer=createDomainReadbackObserver({observerRef:'sentinel:observer:provider-readback',observe:async()=>({status:'MATCH',evidenceRef:'obs:readback:1'})});
  assert.deepEqual(await observer(input),{status:'PASS',observerRef:'sentinel:observer:provider-readback',evidenceRefs:['obs:readback:1']});
});

test('mismatch becomes FAIL and retains observation evidence',async()=>{
  const observer=createDomainReadbackObserver({observerRef:'sentinel:observer:provider-readback',observe:async()=>({status:'MISMATCH',evidenceRef:'obs:readback:2'})});
  assert.deepEqual(await observer(input),{status:'FAIL',observerRef:'sentinel:observer:provider-readback',evidenceRefs:['obs:readback:2']});
});
test('missing timeout or evidence-less observation stays INDETERMINATE',async()=>{
  for(const observed of [
    {status:'MISSING',evidenceRef:'obs:missing:1'},
    {status:'TIMEOUT',evidenceRef:'obs:timeout:1'},
    {status:'MATCH'},
  ]){
    const observer=createDomainReadbackObserver({observerRef:'sentinel:observer:provider-readback',observe:async()=>observed});
    const out=await observer(input);
    assert.equal(out.status,'INDETERMINATE');
    assert.equal(out.observerRef,'sentinel:observer:provider-readback');
  }
});

test('observer configuration fails closed',async()=>{
  assert.throws(()=>createDomainReadbackObserver({observerRef:'',observe:async()=>({})}),/observer_ref_required/);
  assert.throws(()=>createDomainReadbackObserver({observerRef:'sentinel:observer:x'}),/observe_required/);
  const observer=createDomainReadbackObserver({observerRef:'sentinel:observer:x',observe:async()=>{throw new Error('provider secret');}});
  const out=await observer(input);
  assert.equal(out.status,'INDETERMINATE');
  assert.equal(JSON.stringify(out).includes('provider secret'),false);
});

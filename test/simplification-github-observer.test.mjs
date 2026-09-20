import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSimplificationObserver } from '../lib/simplification-github-observer.js';

const repository='Aftergraph/war-room';
const baseline='a'.repeat(40);
const final='b'.repeat(40);
const refs={
  exact:`https://github.com/Aftergraph/war-room/actions/runs/101#proof=exact-revision-evidence`,
  native:`https://github.com/Aftergraph/war-room/actions/runs/102#proof=repository-native-gates-pass`,
  behavior:`https://github.com/Aftergraph/war-room/actions/runs/103#proof=behavior-preserved&step=Canonical%20%2B%20semantic%20equivalence`,
  owner:`https://github.com/Aftergraph/war-room/actions/runs/104#proof=canonical-owner-preserved`,
};

function input(overrides={}){
  const obligations=[
    {id:'exact-revision-evidence',evidenceRefs:[refs.exact]},
    {id:'repository-native-gates-pass',evidenceRefs:[refs.native]},
    {id:'behavior-preserved',evidenceRefs:[refs.behavior]},
    {id:'canonical-owner-preserved',evidenceRefs:[refs.owner]},
  ];
  return {
    subject:{repository,baselineRevision:baseline,finalRevision:final,executorRef:'runtime:simplifier'},
    evidence:{body:{canonicalOwner:'Aftergraph/war-room:desktop/web/app.js',changedPaths:['desktop/web/app.js'],obligations}},
    obligationIds:obligations.map(x=>x.id),
    evidenceRefs:obligations.flatMap(x=>x.evidenceRefs),
    ...overrides,
  };
}

function jsonResponse(value,status=200){
  return {ok:status>=200&&status<300,status,async json(){return value;}};
}

function fetchFixture({runConclusion='success',headSha=final,behaviorStep='success',missingCommit=false}={}){
  return async urlLike=>{
    const url=new URL(String(urlLike));
    if(url.pathname.includes('/commits/')){
      return missingCommit?jsonResponse({message:'not found'},404):jsonResponse({sha:url.pathname.split('/').at(-1)});
    }
    const jobs=url.pathname.match(/\/actions\/runs\/([0-9]+)\/jobs$/u);
    if(jobs){
      const id=jobs[1];
      return jsonResponse({jobs:[{name:`job-${id}`,steps:id==='103'
        ?[{name:'Canonical + semantic equivalence',status:'completed',conclusion:behaviorStep}]
        :[{name:'Test',status:'completed',conclusion:'success'}]}]});
    }
    const run=url.pathname.match(/\/actions\/runs\/([0-9]+)$/u);
    if(run){
      return jsonResponse({id:Number(run[1]),head_sha:headSha,status:'completed',conclusion:runConclusion});
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('GitHub observer independently resolves all four simplification obligations',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture()});
  const out=await observe(input());
  assert.equal(out.status,'PASS');
  assert.equal(out.observerRef,'sentinel:observer:github-actions');
  assert.deepEqual(out.evidenceRefs,Object.values(refs).sort());
});

test('behavior proof requires the exact declared successful step',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture({behaviorStep:'failure'})});
  const out=await observe(input());
  assert.equal(out.status,'FAIL');
});

test('workflow evidence must be bound to the exact final revision',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture({headSha:'c'.repeat(40)})});
  const out=await observe(input());
  assert.equal(out.status,'FAIL');
});

test('canonical owner must cover every changed path',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture()});
  const value=input();
  value.evidence.body.changedPaths.push('outside/owner.js');
  const out=await observe(value);
  assert.equal(out.status,'FAIL');
});

test('missing exact baseline or final commit is independent FAIL',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture({missingCommit:true})});
  const out=await observe(input());
  assert.equal(out.status,'FAIL');
});

test('transport failure is INDETERMINATE, never fabricated PASS',async()=>{
  const observe=createGitHubSimplificationObserver({
    token:'x'.repeat(32),
    fetchImpl:async()=>{throw new Error('network secret detail');},
  });
  const out=await observe(input());
  assert.equal(out.status,'INDETERMINATE');
  assert.equal(JSON.stringify(out).includes('network secret detail'),false);
});

test('evidence ref proof tag must match the obligation that claims it',async()=>{
  const observe=createGitHubSimplificationObserver({token:'x'.repeat(32),fetchImpl:fetchFixture()});
  const value=input();
  value.evidence.body.obligations[0].evidenceRefs=[refs.native];
  value.evidenceRefs=[refs.native,refs.behavior,refs.owner];
  const out=await observe(value);
  assert.equal(out.status,'FAIL');
});

test('public GitHub evidence can verify without a token',async()=>{
  const observe=createGitHubSimplificationObserver({fetchImpl:fetchFixture()});
  const out=await observe(input());
  assert.equal(out.status,'PASS');
});

test('unauthenticated 404 stays INDETERMINATE because the repository may be private',async()=>{
  const observe=createGitHubSimplificationObserver({
    fetchImpl:async()=>jsonResponse({message:'not found'},404),
  });
  const out=await observe(input());
  assert.equal(out.status,'INDETERMINATE');
});

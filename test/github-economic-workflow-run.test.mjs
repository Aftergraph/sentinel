import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeEvent } from '../apps/github/app.js';

const H1='a'.repeat(40);
const H2='b'.repeat(40);
const B='c'.repeat(40);

const ECON_DIFF=[
  'diff --git a/lib/economic-evidence-pack.js b/lib/economic-evidence-pack.js',
  'index 1111111..2222222 100644',
  '--- a/lib/economic-evidence-pack.js',
  '+++ b/lib/economic-evidence-pack.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

function payload(headSha=H1){
  return {
    action:'completed',
    repository:{full_name:'Aftergraph/sentinel'},
    workflow_run:{
      id:500,
      name:'Economic Evidence Pack',
      head_sha:headSha,
      status:'completed',
      conclusion:'success',
      pull_requests:[{number:77}],
    }
  };
}

function platform({headSha=H1,runs=[]}={}){
  const calls=[];
  return {
    calls,
    async getPR(){calls.push('getPR');return {head:{sha:headSha},base:{sha:B}};},
    async getDiff(){calls.push('getDiff');return ECON_DIFF;},
    async listWorkflowRunsForHead(repo,sha){calls.push(['runs',repo,sha]);return runs;},
  };
}

test('github app economic workflow_run posts success only after every required run succeeds',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sentinel-gh-econ-'));
  try{
    const p=platform({runs:[
      {id:1,name:'test',head_sha:H1,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:00:00Z'},
      {id:2,name:'Economic Evidence Pack',head_sha:H1,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:01:00Z'},
    ]});
    const checks=[];
    const out=await routeEvent({
      event:'workflow_run',payload:payload(),platform:p,
      opts:{
        storePath:join(dir,'store.json'),
        economicChecksPath:join(dir,'economic-checks.json'),
        checksApi:{
          async createCheckRun(params){checks.push(params);return {id:900};},
          async updateCheckRun(){throw new Error('unexpected update');},
        }
      }
    });
    assert.equal(out.action,'economic-evidence-check');
    assert.equal(out.aggregate.success,true);
    assert.equal(out.check.conclusion,'success');
    assert.equal(checks.length,1);
    assert.equal(checks[0].name,'sentinel/economic-evidence');
    assert.equal(checks[0].head_sha,H1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('github app economic workflow_run posts failure when required verifier fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sentinel-gh-econ-'));
  try{
    const p=platform({runs:[
      {id:1,name:'test',head_sha:H1,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:00:00Z'},
      {id:2,name:'Economic Evidence Pack',head_sha:H1,status:'completed',conclusion:'failure',updated_at:'2026-10-01T20:01:00Z'},
    ]});
    let conclusion=null;
    const out=await routeEvent({
      event:'workflow_run',payload:payload(),platform:p,
      opts:{
        economicChecksPath:join(dir,'economic-checks.json'),
        checksApi:{
          async createCheckRun(params){conclusion=params.conclusion;return {id:901};},
          async updateCheckRun(){throw new Error('unexpected update');},
        }
      }
    });
    assert.equal(out.aggregate.failed,true);
    assert.equal(conclusion,'failure');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('github app economic workflow_run remains pending if full suite is missing',async()=>{
  const p=platform({runs:[
    {id:2,name:'Economic Evidence Pack',head_sha:H1,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:01:00Z'},
  ]});
  let creates=0;
  const out=await routeEvent({
    event:'workflow_run',payload:payload(),platform:p,
    opts:{checksApi:{async createCheckRun(){creates++;return {id:1};},async updateCheckRun(){}}}
  });
  assert.equal(out.action,'economic-evidence-pending');
  assert.equal(out.aggregate.ready,false);
  assert.equal(creates,0);
});

test('github app ignores completed workflow from superseded PR head',async()=>{
  const p=platform({headSha:H2,runs:[]});
  const out=await routeEvent({event:'workflow_run',payload:payload(H1),platform:p,opts:{}});
  assert.equal(out.action,'ignored:workflow_run:stale-head');
  assert.equal(out.headSha,H1);
  assert.ok(!p.calls.includes('getDiff'));
});

test('github app ignores workflow_run without a pull request',async()=>{
  const x=payload();
  x.workflow_run.pull_requests=[];
  const out=await routeEvent({event:'workflow_run',payload:x,platform:platform(),opts:{}});
  assert.equal(out.handled,false);
  assert.equal(out.action,'ignored:workflow_run:no-pr');
});

test('github app ignores non-completed workflow_run actions',async()=>{
  const x=payload();
  x.action='requested';
  const out=await routeEvent({event:'workflow_run',payload:x,platform:platform(),opts:{}});
  assert.equal(out.handled,false);
  assert.equal(out.action,'ignored:workflow_run:requested');
});

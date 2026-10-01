import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ECONOMIC_CHECK_NAME,
  requiredEconomicWorkflows,
  aggregateEconomicWorkflowRuns,
  postEconomicEvidenceCheck,
} from '../apps/github/economic-checks.js';

const H='a'.repeat(40);

const diff=(paths)=>paths.map((p)=>[
  'diff --git a/'+p+' b/'+p,
  'index 1111111..2222222 100644',
  '--- a/'+p,
  '+++ b/'+p,
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n')).join('\n');

test('economic checks: non-economic diff requires no aggregator',()=>{
  assert.deepEqual(requiredEconomicWorkflows(diff(['README.md'])),[]);
});

test('economic checks: evidence-pack change requires full suite and focused workflow',()=>{
  assert.deepEqual(
    requiredEconomicWorkflows(diff(['lib/economic-evidence-pack.js'])),
    ['Economic Evidence Pack','test']
  );
});

test('economic checks: v11-v13 changes map to their focused workflows',()=>{
  const required=requiredEconomicWorkflows(diff([
    'lib/economic-evidence-campaign.js',
    'lib/economic-source-capture.js',
    'lib/economic-source-generation-ledger.js',
  ]));
  assert.deepEqual(required,[
    'Economic Evidence Campaign',
    'Economic Source Capture',
    'Economic Source Generation Ledger',
    'test',
  ]);
});

test('economic checks: missing required run remains pending, never green',()=>{
  const out=aggregateEconomicWorkflowRuns({
    required:['test','Economic Evidence Pack'],
    headSha:H,
    workflowRuns:[
      {id:1,name:'test',head_sha:H,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:00:00Z'}
    ]
  });
  assert.equal(out.ready,false);
  assert.equal(out.success,false);
  assert.equal(out.failed,false);
  assert.equal(out.rows.find(x=>x.name==='Economic Evidence Pack').state,'missing');
});

test('economic checks: any required failure blocks exact head',()=>{
  const out=aggregateEconomicWorkflowRuns({
    required:['test','Economic Evidence Pack'],
    headSha:H,
    workflowRuns:[
      {id:1,name:'test',head_sha:H,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:00:00Z'},
      {id:2,name:'Economic Evidence Pack',head_sha:H,status:'completed',conclusion:'failure',updated_at:'2026-10-01T20:01:00Z'},
      {id:3,name:'Economic Evidence Pack',head_sha:'b'.repeat(40),status:'completed',conclusion:'success',updated_at:'2026-10-01T20:02:00Z'},
    ]
  });
  assert.equal(out.ready,true);
  assert.equal(out.success,false);
  assert.equal(out.failed,true);
});

test('economic checks: all required exact-head workflows must pass',()=>{
  const out=aggregateEconomicWorkflowRuns({
    required:['test','Economic Evidence Pack'],
    headSha:H,
    workflowRuns:[
      {id:1,name:'test',head_sha:H,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:00:00Z'},
      {id:2,name:'Economic Evidence Pack',head_sha:H,status:'completed',conclusion:'success',updated_at:'2026-10-01T20:01:00Z'},
    ]
  });
  assert.equal(out.ready,true);
  assert.equal(out.success,true);
  assert.equal(out.failed,false);
});

test('economic checks: post is idempotent per repo/pr/head',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sentinel-economic-check-'));
  try{
    const calls=[];
    const api={
      async createCheckRun(params){calls.push(['create',params]);return {id:77};},
      async updateCheckRun(id,params){calls.push(['update',id,params]);return {id};},
    };
    const aggregate={
      ready:true,success:true,failed:false,
      rows:[
        {name:'test',state:'completed',conclusion:'success',runId:1},
        {name:'Economic Evidence Pack',state:'completed',conclusion:'success',runId:2},
      ],
    };
    const opts={economicChecksPath:join(dir,'checks.json')};
    const one=await postEconomicEvidenceCheck({api,repo:'Aftergraph/sentinel',prNumber:99,headSha:H,aggregate,opts});
    const two=await postEconomicEvidenceCheck({api,repo:'Aftergraph/sentinel',prNumber:99,headSha:H,aggregate,opts});
    assert.equal(one.id,77);
    assert.equal(two.id,77);
    assert.equal(calls[0][0],'create');
    assert.equal(calls[0][1].name,ECONOMIC_CHECK_NAME);
    assert.equal(calls[1][0],'update');
    assert.equal(calls[1][1],77);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('economic checks: pending aggregate posts no misleading check',async()=>{
  const calls=[];
  const out=await postEconomicEvidenceCheck({
    api:{
      async createCheckRun(x){calls.push(x);return {id:1};},
      async updateCheckRun(){throw new Error('unexpected');},
    },
    repo:'Aftergraph/sentinel',prNumber:1,headSha:H,
    aggregate:{ready:false,success:false,failed:false,rows:[{name:'test',state:'missing'}]},
  });
  assert.equal(out.pending,true);
  assert.equal(out.posted,false);
  assert.equal(calls.length,0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollGitHubInstallationOnce } from "../apps/github/poller.js";

const H="a".repeat(40);
const B="b".repeat(40);

function basicPlatform({economic=false}={}){
  const calls={create:0,update:0};
  const diff=economic
    ? "diff --git a/lib/economic-evidence-pack.js b/lib/economic-evidence-pack.js\n"
    : "diff --git a/README.md b/README.md\n";
  return {
    calls,
    async listInstallationRepositories(){
      return [{full_name:"Aftergraph/sentinel"},{full_name:"Aftergraph/other"}];
    },
    async listOpenPRs(repo){
      return repo==="Aftergraph/sentinel"
        ? [{number:7,head:{sha:H},base:{sha:B}}]
        : [{number:9,head:{sha:H},base:{sha:B}}];
    },
    async getDiff(){return diff;},
    async listWorkflowRunsForHead(){
      return [
        {id:1,name:"test",head_sha:H,status:"completed",conclusion:"success",updated_at:"2026-10-01T00:00:00Z"},
        {id:2,name:"Economic Evidence Pack",head_sha:H,status:"completed",conclusion:"success",updated_at:"2026-10-01T00:00:01Z"},
      ];
    },
    async createCheckRun(){calls.create+=1;return {id:100};},
    async updateCheckRun(){calls.update+=1;return {id:100};},
  };
}

test("poller reviews a head once and persists idempotent state",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const platform=basicPlatform();
    let reviews=0;
    const opts={pollStatePath:join(dir,"poll.json"),pollRepos:["Aftergraph/sentinel"]};
    const routePullRequest=async()=>{reviews+=1;return {handled:true};};
    const first=await pollGitHubInstallationOnce({platform,opts,routePullRequest});
    const second=await pollGitHubInstallationOnce({platform,opts,routePullRequest});
    assert.equal(first.repositories,1);
    assert.equal(first.prs,1);
    assert.equal(first.reviewed,1);
    assert.equal(second.reviewed,0);
    assert.equal(reviews,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("poller posts economic evidence check only when fingerprint changes",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const platform=basicPlatform({economic:true});
    const opts={
      pollStatePath:join(dir,"poll.json"),
      economicChecksPath:join(dir,"economic-checks.json"),
      pollRepos:["Aftergraph/sentinel"],
    };
    const routePullRequest=async()=>({handled:true});
    const first=await pollGitHubInstallationOnce({platform,opts,routePullRequest});
    const second=await pollGitHubInstallationOnce({platform,opts,routePullRequest});
    assert.equal(first.evidenceChecks,1);
    assert.equal(second.evidenceChecks,0);
    assert.equal(platform.calls.create,1);
    assert.equal(platform.calls.update,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("poller allowlist prevents writes to non-selected repositories",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const platform=basicPlatform();
    const seen=[];
    const out=await pollGitHubInstallationOnce({
      platform,
      opts:{pollStatePath:join(dir,"poll.json"),pollRepos:["Aftergraph/sentinel"]},
      routePullRequest:async({payload})=>{seen.push(payload.repository.full_name);return {handled:true};},
    });
    assert.deepEqual(seen,["Aftergraph/sentinel"]);
    assert.equal(out.repositories,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("poller fails closed on corrupt persisted state",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const path=join(dir,"poll.json");
    await import("node:fs").then(({writeFileSync})=>writeFileSync(path,"{bad"));
    await assert.rejects(
      ()=>pollGitHubInstallationOnce({
        platform:basicPlatform(),
        opts:{pollStatePath:path,pollRepos:["Aftergraph/sentinel"]},
        routePullRequest:async()=>({handled:true}),
      }),
      /github poll state invalid/
    );
  }finally{rmSync(dir,{recursive:true,force:true});}
});

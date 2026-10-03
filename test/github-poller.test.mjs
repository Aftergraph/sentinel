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

test("poller routes new @sentinel comments once, never replays history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-poller-"));
  try {
    const platform = basicPlatform();
    let comments = [
      { id: 10, body: "@sentinel review", author_association: "OWNER", user: { login: "jonas", type: "User" } },
    ];
    platform.listComments = async () => comments;
    const routed = [];
    const routePullRequest = async (ev) => { routed.push(ev.event + ":" + (ev.payload.comment?.id ?? "")); return { handled: true }; };
    const opts = { pollStatePath: join(dir, "poll.json"), pollRepos: ["Aftergraph/sentinel"] };
    await pollGitHubInstallationOnce({ platform, opts, routePullRequest });
    assert.deepEqual(routed, ["pull_request:"], "first sighting: review only, old command is baseline");
    comments = [...comments,
      { id: 11, body: "lgtm", author_association: "OWNER", user: { login: "jonas", type: "User" } },
      { id: 12, body: "@sentinel why x", author_association: "MEMBER", user: { login: "jonas", type: "User" } }];
    const s2 = await pollGitHubInstallationOnce({ platform, opts, routePullRequest });
    assert.deepEqual(routed, ["pull_request:", "issue_comment:12"]);
    assert.equal(s2.commands, 1);
    await pollGitHubInstallationOnce({ platform, opts, routePullRequest });
    assert.equal(routed.length, 2, "same comment never routed twice");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("poll repos file widens a non-empty env allowlist",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const platform={...basicPlatform(),async getFileContent(repo,path,ref){
      assert.equal(repo,"Aftergraph/sentinel");assert.equal(path,"ops/deploy/poll-repos.json");assert.equal(ref,"main");
      return JSON.stringify({repos:["Aftergraph/other","not a repo"]});
    }};
    const seen=[];
    const opts={pollStatePath:join(dir,"poll.json"),pollRepos:["Aftergraph/sentinel"],pollReposFile:"Aftergraph/sentinel:ops/deploy/poll-repos.json@main"};
    const res=await pollGitHubInstallationOnce({platform,opts,routePullRequest:async(e)=>{seen.push(e);return {handled:true};}});
    assert.equal(res.repositories,2);
    assert.deepEqual(res.extraPollRepos,["Aftergraph/other"]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("unreadable poll repos file falls back to the env allowlist only",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    const platform={...basicPlatform(),async getFileContent(){throw new Error("404");}};
    const opts={pollStatePath:join(dir,"poll.json"),pollRepos:["Aftergraph/sentinel"],pollReposFile:"Aftergraph/sentinel:ops/deploy/poll-repos.json@main"};
    const res=await pollGitHubInstallationOnce({platform,opts,routePullRequest:async()=>({handled:true})});
    assert.equal(res.repositories,1);
    assert.deepEqual(res.extraPollRepos,[]);
    assert.match(res.extraPollReposReason,/env allowlist only/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("poll repos file is ignored when the env allowlist is empty",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sentinel-poller-"));
  try{
    let reads=0;
    const platform={...basicPlatform(),async getFileContent(){reads+=1;return "{}";}};
    const opts={pollStatePath:join(dir,"poll.json"),pollRepos:[],pollReposFile:"Aftergraph/sentinel:ops/deploy/poll-repos.json@main"};
    const res=await pollGitHubInstallationOnce({platform,opts,routePullRequest:async()=>({handled:true})});
    assert.equal(res.repositories,2);
    assert.equal(reads,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

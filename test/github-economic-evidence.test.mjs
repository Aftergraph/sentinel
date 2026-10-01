import test from "node:test";
import assert from "node:assert/strict";
import { economicEvidenceEnvelopePaths, verifyEconomicEvidenceEnvelope } from "../apps/github/economic-evidence.js";

const H="a".repeat(40);

test("discovers exactly the canonical campaign evidence-pack path",()=>{
  const diff=[
    "diff --git a/docs/evidence/economic-campaigns/c1/evidence-pack.json b/docs/evidence/economic-campaigns/c1/evidence-pack.json",
    "diff --git a/README.md b/README.md"
  ].join("\n");
  assert.deepEqual(economicEvidenceEnvelopePaths(diff),["docs/evidence/economic-campaigns/c1/evidence-pack.json"]);
});

test("fails closed when envelope is missing",async()=>{
  const out=await verifyEconomicEvidenceEnvelope({
    repo:"Aftergraph/sentinel",headSha:H,diffText:"diff --git a/x b/x",platform:{}
  });
  assert.equal(out.valid,false);
  assert.equal(out.state,"EVIDENCE_ENVELOPE_REQUIRED");
  assert.ok(out.reasons.includes("envelope_missing"));
});

test("fails closed on multiple evidence envelopes",async()=>{
  const diff=[
    "diff --git a/docs/evidence/economic-campaigns/c1/evidence-pack.json b/docs/evidence/economic-campaigns/c1/evidence-pack.json",
    "diff --git a/docs/evidence/economic-campaigns/c2/evidence-pack.json b/docs/evidence/economic-campaigns/c2/evidence-pack.json"
  ].join("\n");
  const out=await verifyEconomicEvidenceEnvelope({repo:"Aftergraph/sentinel",headSha:H,diffText:diff,platform:{}});
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("multiple_envelopes"));
});

test("rejects envelope whose head or repository binding is wrong before authority can be inferred",async()=>{
  const path="docs/evidence/economic-campaigns/c1/evidence-pack.json";
  const diff="diff --git a/"+path+" b/"+path;
  const platform={
    async getFileContent(){
      return JSON.stringify({
        schema:"aftergraph.economic-github-evidence-envelope/v1",
        headSha:"b".repeat(40),
        repository:"other/repo",
        executionAuthority:false,liveValueEnabled:false,externalEffects:0,final:false,
        campaign:{},evidencePack:{}
      });
    }
  };
  const out=await verifyEconomicEvidenceEnvelope({repo:"Aftergraph/sentinel",headSha:H,diffText:diff,platform});
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("head_sha_binding"));
  assert.ok(out.reasons.includes("repository_binding"));
});

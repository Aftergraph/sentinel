import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEconomicRightCapture, verifyEconomicRightCaptureSet } from "../lib/economic-source-capture.js";

const H=c=>"sha256:"+c.repeat(64);
const canonical=v=>{
  if(v===null||typeof v==="string"||typeof v==="boolean"||typeof v==="number") return v;
  if(Array.isArray(v)) return v.map(canonical);
  const o={}; for(const k of Object.keys(v).sort()) o[k]=canonical(v[k]); return o;
};
const hash=v=>"sha256:"+createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");

function makeCapture(sourceClass){
  const observedAt={
    registry:"2026-10-01T03:00:00Z",
    custody:"2026-10-01T03:00:10Z",
    representation:"2026-10-01T03:00:20Z"
  }[sourceClass];
  const record=sourceClass==="registry"
    ? {schema:"aftergraph.authoritative-asset-registry-record/v1",registryId:"registry_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),recordHash:H("3"),evidenceHash:H("6"),status:"ACTIVE",observedAt,externalEffects:0,final:false}
    : sourceClass==="custody"
      ? {schema:"aftergraph.custodial-right-record/v1",custodianId:"custodian_1",custodyRef:"cust_123456789012",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),accountFingerprint:H("9"),recordHash:H("4"),evidenceHash:H("7"),status:"ACTIVE",observedAt,externalEffects:0,final:false}
      : {schema:"aftergraph.ledger-asset-representation-record/v1",network:"ledger_1",representationId:"token_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),representationHash:H("5"),evidenceHash:H("8"),status:"ACTIVE",observedAt,externalEffects:0,final:false};

  const sourceId=sourceClass==="registry"?"registry_1":sourceClass==="custody"?"custodian_1":"ledger_1";
  const generation=sourceClass==="registry"?11:sourceClass==="custody"?21:31;
  const cursor={kind:sourceClass==="registry"?"version":sourceClass==="custody"?"sequence":"offset",value:String(generation)};
  const observedAtUnix=Math.floor(Date.parse(observedAt)/1000);
  const recordDigest=hash(record);
  const body={schema:"aftergraph.economic-right-capture/v1",sourceClass,sourceId,generation,cursor,observedAtUnix,evidenceHash:record.evidenceHash,recordDigest,record,sourceTransport:"READ_ONLY",immutable:true,final:false,externalEffects:0};
  return {...body,captureHash:hash(body)};
}

test("independently verifies a Runtime source capture",()=>{
  const out=verifyEconomicRightCapture(makeCapture("registry"));
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_READ_ONLY_SOURCE_CAPTURE");
  assert.deepEqual(out.sourceCapture,{
    sourceClass:"registry",sourceId:"registry_1",evidenceHash:H("6"),generation:11,observedAtUnix:1790823600
  });
  assert.equal(out.executionAuthority,false);
  assert.equal(out.final,false);
  assert.equal(out.externalEffects,0);
});

test("verifies exactly one capture per required source class",()=>{
  const out=verifyEconomicRightCaptureSet([
    makeCapture("representation"),
    makeCapture("registry"),
    makeCapture("custody")
  ]);
  assert.equal(out.valid,true);
  assert.deepEqual(out.sourceCaptures.map(x=>x.sourceClass),["custody","registry","representation"]);
});

for(const [name,mutate] of [
  ["record digest",x=>x.recordDigest=H("a")],
  ["capture hash",x=>x.captureHash=H("b")],
  ["source identity",x=>x.sourceId="other"],
  ["generation",x=>x.generation=0],
  ["cursor",x=>x.cursor={kind:"opaque",value:"1"}],
  ["observation time",x=>x.observedAtUnix+=1],
  ["transport",x=>x.sourceTransport="READ_WRITE"],
  ["finality",x=>x.final=true],
  ["external effects",x=>x.externalEffects=1]
]){
  test("rejects tampered "+name,()=>{
    const x=makeCapture("registry"); mutate(x);
    const out=verifyEconomicRightCapture(x);
    assert.equal(out.valid,false);
  });
}

test("capture set rejects duplicate source class and reused evidence",()=>{
  const a=makeCapture("registry");
  const b=makeCapture("registry");
  const c=makeCapture("representation");
  const out=verifyEconomicRightCaptureSet([a,b,c]);
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("duplicate_source_class"));
  assert.ok(out.reasons.includes("missing_custody"));
});

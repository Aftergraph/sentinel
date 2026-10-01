import { createHash } from "node:crypto";

const HASH=/^sha256:[a-f0-9]{64}$/;
const CURSOR_KINDS=new Set(["version","sequence","block","offset","etag"]);

function canonicalize(value){
  if(value===null||typeof value==="string"||typeof value==="boolean") return value;
  if(typeof value==="number"){
    if(!Number.isFinite(value)) throw new Error("nonfinite_number");
    return value;
  }
  if(Array.isArray(value)) return value.map(canonicalize);
  if(typeof value==="object"){
    const out={};
    for(const key of Object.keys(value).sort()){
      const child=value[key];
      if(child===undefined) throw new Error("undefined_value");
      out[key]=canonicalize(child);
    }
    return out;
  }
  throw new Error("non_json_value");
}

function hash(value){
  return "sha256:"+createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function identityForRecord(record){
  switch(record?.schema){
    case "aftergraph.authoritative-asset-registry-record/v1":
      return {sourceClass:"registry",sourceId:record.registryId};
    case "aftergraph.custodial-right-record/v1":
      return {sourceClass:"custody",sourceId:record.custodianId};
    case "aftergraph.ledger-asset-representation-record/v1":
      return {sourceClass:"representation",sourceId:record.network};
    default:
      return null;
  }
}

export function verifyEconomicRightCapture(capture){
  const reasons=[];
  if(capture?.schema!=="aftergraph.economic-right-capture/v1") reasons.push("schema");

  const identity=identityForRecord(capture?.record);
  if(!identity) reasons.push("record_schema");
  if(identity && capture?.sourceClass!==identity.sourceClass) reasons.push("source_class_binding");
  if(identity && capture?.sourceId!==identity.sourceId) reasons.push("source_id_binding");

  if(!Number.isInteger(capture?.generation)||capture.generation<=0) reasons.push("generation");
  if(!CURSOR_KINDS.has(capture?.cursor?.kind)||!String(capture?.cursor?.value||"")) reasons.push("cursor");
  if(!Number.isInteger(capture?.observedAtUnix)||capture.observedAtUnix<=0) reasons.push("observed_at");
  if(!HASH.test(String(capture?.evidenceHash||""))) reasons.push("evidence_hash");
  if(!HASH.test(String(capture?.recordDigest||""))) reasons.push("record_digest");
  if(!HASH.test(String(capture?.captureHash||""))) reasons.push("capture_hash");
  if(capture?.sourceTransport!=="READ_ONLY") reasons.push("source_transport");
  if(capture?.immutable!==true) reasons.push("immutable");
  if(capture?.final!==false) reasons.push("finality");
  if(capture?.externalEffects!==0) reasons.push("external_effects");

  if(capture?.record?.evidenceHash!==capture?.evidenceHash) reasons.push("record_evidence_binding");
  if(capture?.record?.final!==false) reasons.push("record_finality");
  if(capture?.record?.externalEffects!==0) reasons.push("record_external_effects");

  const observedMs=Date.parse(String(capture?.record?.observedAt||""));
  if(!Number.isFinite(observedMs)||observedMs<=0) reasons.push("record_observed_at");
  else if(Math.floor(observedMs/1000)!==capture?.observedAtUnix) reasons.push("observed_at_binding");

  try{
    if(capture?.recordDigest!==hash(capture?.record)) reasons.push("record_digest_binding");
    const body={
      schema:"aftergraph.economic-right-capture/v1",
      sourceClass:capture?.sourceClass,
      sourceId:capture?.sourceId,
      generation:capture?.generation,
      cursor:capture?.cursor,
      observedAtUnix:capture?.observedAtUnix,
      evidenceHash:capture?.evidenceHash,
      recordDigest:capture?.recordDigest,
      record:capture?.record,
      sourceTransport:"READ_ONLY",
      immutable:true,
      final:false,
      externalEffects:0
    };
    if(capture?.captureHash!==hash(body)) reasons.push("capture_hash_binding");
  }catch{
    reasons.push("canonicalization");
  }

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-right-capture-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_READ_ONLY_SOURCE_CAPTURE":"INVALID",
    sourceCapture: unique.length===0 ? {
      sourceClass:capture.sourceClass,
      sourceId:capture.sourceId,
      evidenceHash:capture.evidenceHash,
      generation:capture.generation,
      observedAtUnix:capture.observedAtUnix
    } : null,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}

export function verifyEconomicRightCaptureSet(captures){
  const reasons=[];
  if(!Array.isArray(captures)||captures.length!==3) reasons.push("capture_count");

  const expected=new Set(["registry","custody","representation"]);
  const seenClass=new Set();
  const seenEvidence=new Set();
  const sourceCaptures=[];

  for(const capture of Array.isArray(captures)?captures:[]){
    const verification=verifyEconomicRightCapture(capture);
    if(!verification.valid){
      reasons.push(String(capture?.sourceClass||"unknown")+":invalid");
      continue;
    }
    const projected=verification.sourceCapture;
    if(!expected.has(projected.sourceClass)) reasons.push("source_class");
    if(seenClass.has(projected.sourceClass)) reasons.push("duplicate_source_class");
    seenClass.add(projected.sourceClass);
    if(seenEvidence.has(projected.evidenceHash)) reasons.push("evidence_reused");
    seenEvidence.add(projected.evidenceHash);
    sourceCaptures.push(projected);
  }
  for(const cls of expected) if(!seenClass.has(cls)) reasons.push("missing_"+cls);

  sourceCaptures.sort((a,b)=>a.sourceClass.localeCompare(b.sourceClass));
  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-right-capture-set-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_SOURCE_CAPTURE_SET":"INVALID",
    sourceCaptures,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}

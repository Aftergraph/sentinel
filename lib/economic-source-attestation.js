import { createHash, createPublicKey, verify } from "node:crypto";

const HASH=/^sha256:[a-f0-9]{64}$/;

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

function publicKeyFingerprint(publicKeyPem){
  const key=createPublicKey(publicKeyPem);
  const der=key.export({type:"spki",format:"der"});
  return "sha256:"+createHash("sha256").update(der).digest("hex");
}

export function verifyEconomicSourceAttestation(attestation, trustRoot, nowUnix){
  const reasons=[];
  if(attestation?.schema!=="aftergraph.economic-source-attestation/v1") reasons.push("attestation_schema");
  if(trustRoot?.schema!=="aftergraph.economic-source-trust-root/v1") reasons.push("trust_root_schema");
  if(trustRoot?.status!=="ACTIVE") reasons.push("trust_root_inactive");
  if(attestation?.sourceTransport!=="READ_ONLY") reasons.push("source_transport");
  if(attestation?.executionAuthority!==false) reasons.push("execution_authority");
  if(attestation?.final!==false) reasons.push("finality");
  if(attestation?.promotionAuthority!==false) reasons.push("promotion_authority");
  if(attestation?.externalEffects!==0) reasons.push("external_effects");

  if(!["registry","custody","representation"].includes(attestation?.sourceClass)) reasons.push("source_class");
  if(!String(attestation?.sourceId||"")) reasons.push("source_id");
  if(!HASH.test(String(attestation?.captureHash||""))) reasons.push("capture_hash");
  if(!HASH.test(String(attestation?.evidenceHash||""))) reasons.push("evidence_hash");
  if(!HASH.test(String(attestation?.publicKeyFingerprint||""))) reasons.push("public_key_fingerprint");
  if(!HASH.test(String(attestation?.payloadHash||""))) reasons.push("payload_hash");
  if(!Number.isInteger(attestation?.attestationGeneration)||attestation.attestationGeneration<=0) reasons.push("attestation_generation");

  if(attestation?.trustRootId!==trustRoot?.trustRootId) reasons.push("trust_root_id_binding");
  if(attestation?.sourceClass!==trustRoot?.sourceClass) reasons.push("trust_root_source_class_binding");
  if(attestation?.sourceId!==trustRoot?.sourceId) reasons.push("trust_root_source_id_binding");
  if(attestation?.publicKeyFingerprint!==trustRoot?.publicKeyFingerprint) reasons.push("trust_root_key_binding");

  if(!Number.isInteger(nowUnix)||nowUnix<=0) reasons.push("now");
  if(!Number.isInteger(attestation?.validFromUnix)||!Number.isInteger(attestation?.validUntilUnix)||attestation.validUntilUnix<=attestation.validFromUnix) reasons.push("attestation_validity");
  if(Number.isInteger(nowUnix)&&Number.isInteger(attestation?.validFromUnix)&&nowUnix<attestation.validFromUnix) reasons.push("attestation_not_yet_valid");
  if(Number.isInteger(nowUnix)&&Number.isInteger(attestation?.validUntilUnix)&&nowUnix>attestation.validUntilUnix) reasons.push("attestation_expired");
  if(Number.isInteger(nowUnix)&&Number.isInteger(trustRoot?.validFromUnix)&&nowUnix<trustRoot.validFromUnix) reasons.push("trust_root_not_yet_valid");
  if(Number.isInteger(nowUnix)&&Number.isInteger(trustRoot?.validUntilUnix)&&nowUnix>trustRoot.validUntilUnix) reasons.push("trust_root_expired");
  if(Number.isInteger(trustRoot?.minAttestationGeneration)&&Number.isInteger(attestation?.attestationGeneration)&&attestation.attestationGeneration<trustRoot.minAttestationGeneration) reasons.push("attestation_generation_revoked");

  const payload={
    domain:"aftergraph/economic-source-attestation/v1",
    purpose:"READ_ONLY_SOURCE_ATTESTATION",
    sourceClass:attestation?.sourceClass,
    sourceId:attestation?.sourceId,
    captureHash:attestation?.captureHash,
    evidenceHash:attestation?.evidenceHash,
    providerId:attestation?.providerId,
    trustRootId:attestation?.trustRootId,
    publicKeyFingerprint:attestation?.publicKeyFingerprint,
    attestationGeneration:attestation?.attestationGeneration,
    validFromUnix:attestation?.validFromUnix,
    validUntilUnix:attestation?.validUntilUnix,
  };

  try{
    if(attestation?.payloadHash!==hash(payload)) reasons.push("payload_hash_binding");
    const computed=publicKeyFingerprint(attestation?.publicKeyPem);
    if(computed!==attestation?.publicKeyFingerprint) reasons.push("public_key_fingerprint_binding");
  }catch{
    reasons.push("public_key");
  }

  let signatureValid=false;
  if(reasons.length===0){
    try{
      signatureValid=verify(
        null,
        Buffer.from(attestation.payloadHash),
        createPublicKey(attestation.publicKeyPem),
        Buffer.from(attestation.signatureBase64,"base64")
      );
    }catch{
      signatureValid=false;
    }
    if(!signatureValid) reasons.push("signature");
  }

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-source-attestation-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_GOVERNANCE_PINNED_SOURCE":"INVALID",
    sourceTrusted:unique.length===0,
    signatureValid,
    trustRootPinned:unique.length===0,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}

export function verifyEconomicSourceAttestationSet(attestations, trustRoots, nowUnix){
  const reasons=[];
  const expected=new Set(["registry","custody","representation"]);
  const seen=new Set();
  const roots=new Map((Array.isArray(trustRoots)?trustRoots:[]).map(r=>[r.sourceClass+":"+r.sourceId,r]));
  const verifications=[];

  for(const a of Array.isArray(attestations)?attestations:[]){
    const key=a?.sourceClass+":"+a?.sourceId;
    const root=roots.get(key);
    if(!root){
      reasons.push(String(a?.sourceClass||"unknown")+":trust_root_missing");
      continue;
    }
    const v=verifyEconomicSourceAttestation(a,root,nowUnix);
    verifications.push(v);
    if(!v.valid) reasons.push(String(a?.sourceClass||"unknown")+":invalid");
    if(seen.has(a?.sourceClass)) reasons.push("duplicate_source_class");
    seen.add(a?.sourceClass);
  }
  for(const cls of expected) if(!seen.has(cls)) reasons.push("missing_"+cls);

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-source-attestation-set-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_SOURCE_TRUST_SET":"INVALID",
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique,
    verifications
  };
}

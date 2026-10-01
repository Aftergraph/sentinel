import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyEconomicSourceAttestation, verifyEconomicSourceAttestationSet } from "../lib/economic-source-attestation.js";

const H=c=>"sha256:"+c.repeat(64);
const canonicalize=value=>{
  if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number") return value;
  if(Array.isArray(value)) return value.map(canonicalize);
  const out={}; for(const k of Object.keys(value).sort()) out[k]=canonicalize(value[k]); return out;
};
const hash=value=>"sha256:"+createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

function fixture(sourceClass="registry",sourceId="registry_1"){
  const {publicKey,privateKey}=generateKeyPairSync("ed25519");
  const publicKeyPem=publicKey.export({type:"spki",format:"pem"}).toString();
  const der=publicKey.export({type:"spki",format:"der"});
  const fp="sha256:"+createHash("sha256").update(der).digest("hex");
  const payload={
    domain:"aftergraph/economic-source-attestation/v1",
    purpose:"READ_ONLY_SOURCE_ATTESTATION",
    sourceClass,sourceId,captureHash:H("a"),evidenceHash:H("b"),
    providerId:"provider_"+sourceClass+"_1",trustRootId:"root_"+sourceClass+"_1",
    publicKeyFingerprint:fp,attestationGeneration:3,
    validFromUnix:1_900_000,validUntilUnix:2_100_000
  };
  const payloadHash=hash(payload);
  const attestation={
    schema:"aftergraph.economic-source-attestation/v1",
    sourceClass,sourceId,captureHash:H("a"),evidenceHash:H("b"),
    providerId:payload.providerId,trustRootId:payload.trustRootId,
    publicKeyPem,publicKeyFingerprint:fp,attestationGeneration:3,
    validFromUnix:1_900_000,validUntilUnix:2_100_000,
    payloadHash,signatureBase64:sign(null,Buffer.from(payloadHash),privateKey).toString("base64"),
    sourceTransport:"READ_ONLY",executionAuthority:false,final:false,promotionAuthority:false,externalEffects:0
  };
  const root={
    schema:"aftergraph.economic-source-trust-root/v1",
    trustRootId:payload.trustRootId,sourceClass,sourceId,publicKeyFingerprint:fp,
    status:"ACTIVE",validFromUnix:1_800_000,validUntilUnix:2_200_000,minAttestationGeneration:1
  };
  return {attestation,root};
}

test("verifies governance-pinned source attestation",()=>{
  const {attestation,root}=fixture();
  const out=verifyEconomicSourceAttestation(attestation,root,2_000_000);
  assert.equal(out.valid,true);
  assert.equal(out.sourceTrusted,true);
  assert.equal(out.signatureValid,true);
  assert.equal(out.trustRootPinned,true);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.final,false);
});

for(const [name,mutate] of [
  ["wrong source",({attestation})=>attestation.sourceId="registry_other"],
  ["wrong root fingerprint",({root})=>root.publicKeyFingerprint=H("f")],
  ["expired attestation",({attestation})=>attestation.validUntilUnix=1_999_999],
  ["revoked generation",({root})=>root.minAttestationGeneration=4],
  ["inactive root",({root})=>root.status="REVOKED"],
  ["tampered capture",({attestation})=>attestation.captureHash=H("c")],
  ["tampered signature",({attestation})=>attestation.signatureBase64=Buffer.alloc(64,1).toString("base64")],
  ["authority overclaim",({attestation})=>attestation.executionAuthority=true]
]){
  test("rejects "+name,()=>{
    const f=fixture(); mutate(f);
    const out=verifyEconomicSourceAttestation(f.attestation,f.root,2_000_000);
    assert.equal(out.valid,false);
    assert.equal(out.sourceTrusted,false);
  });
}

test("requires registry custody and representation trust set",()=>{
  const a=fixture("registry","registry_1");
  const b=fixture("custody","custodian_1");
  const c=fixture("representation","ledger_1");
  const out=verifyEconomicSourceAttestationSet(
    [a.attestation,b.attestation,c.attestation],
    [a.root,b.root,c.root],
    2_000_000
  );
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_SOURCE_TRUST_SET");
  assert.equal(out.executionAuthority,false);
});

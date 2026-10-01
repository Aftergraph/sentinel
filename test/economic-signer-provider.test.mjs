import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { publicKeyFingerprint } from "../lib/economic-signer-canary.js";
import { verifySignerProviderReceipt, verifyKeyRotation, verifyKeyRevocation } from "../lib/economic-signer-provider.js";

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type:"spki", format:"pem" }).toString();
  const fp = publicKeyFingerprint(publicKeyPem);
  const request = {
    schema:"aftergraph.economic-signer-canary-request/v1",
    payload:{
      domain:"aftergraph/economic-signer-canary/v1",
      purpose:"NON_ECONOMIC_CANARY",
      nonce:"canary_provider_123456",
      authorityLeaseId:"auth_1234567890123456",
      approvalProofId:"apr_1234567890123456",
      keyHandle:"keyref_provider_canary_0001",
      publicKeyFingerprint:fp,
      expiresAt:1_900_000_000_000
    },
    challengeDigest:"sha256:"+createHash("sha256").update("provider-canary").digest("hex"),
    algorithm:"Ed25519",
    signatureRequested:true,
    transactionPayloadPresent:false,
    canBroadcast:false,
    externalEffects:0
  };
  const signature = sign(null, Buffer.from(request.challengeDigest), privateKey);
  const receipt = {
    schema:"aftergraph.external-signer-receipt/v1",
    providerId:"signer_test_hsm_01",
    challengeDigest:request.challengeDigest,
    keyHandle:request.payload.keyHandle,
    keyGeneration:2,
    keyStateAtSigning:"ACTIVE",
    publicKeyFingerprint:fp,
    publicKeyPem,
    algorithm:"Ed25519",
    signatureBase64:signature.toString("base64"),
    signingMaterialExposed:false,
    transactionPayloadSigned:false,
    canBroadcast:false,
    externalEffects:0
  };
  return { request, receipt, fp };
}

test("independently verifies opaque provider receipt", () => {
  const {request,receipt}=fixture();
  const out=verifySignerProviderReceipt(request,receipt,1_800_000_000_000);
  assert.equal(out.valid,true);
  assert.equal(out.signatureValid,true);
  assert.equal(out.providerBound,true);
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
});

for (const [name,mut] of [
  ["missing provider",r=>({...r,providerId:""})],
  ["bad generation",r=>({...r,keyGeneration:0})],
  ["non-active key",r=>({...r,keyStateAtSigning:"RETIRED"})],
  ["broadcast overclaim",r=>({...r,canBroadcast:true})]
]) {
  test("rejects "+name,()=>{
    const {request,receipt}=fixture();
    assert.equal(verifySignerProviderReceipt(request,mut(receipt),1_800_000_000_000).valid,false);
  });
}

test("verifies key rotation chain without private-key transfer", () => {
  const a="sha256:"+"a".repeat(64), b="sha256:"+"b".repeat(64);
  const out=verifyKeyRotation({
    schema:"aftergraph.signer-key-rotation/v1",
    providerId:"signer_test_hsm_01",
    oldKeyHandle:"keyref_rotation_old_0001",
    oldKeyFingerprint:a,
    oldGeneration:1,
    newKeyHandle:"keyref_rotation_new_0002",
    newKeyFingerprint:b,
    newGeneration:2,
    oldState:"RETIRED",
    newState:"ACTIVE",
    privateKeyMaterialTransferred:false,
    externalEffects:0
  });
  assert.equal(out.valid,true);
  assert.equal(out.promotionAuthority,false);
});

test("rotation rejects generation skips or private-key transfer", () => {
  const base={
    schema:"aftergraph.signer-key-rotation/v1",
    providerId:"signer_test_hsm_01",
    oldKeyHandle:"keyref_rotation_old_0001",
    oldKeyFingerprint:"sha256:"+"a".repeat(64),
    oldGeneration:1,
    newKeyHandle:"keyref_rotation_new_0002",
    newKeyFingerprint:"sha256:"+"b".repeat(64),
    newGeneration:2,
    oldState:"RETIRED",
    newState:"ACTIVE",
    privateKeyMaterialTransferred:false,
    externalEffects:0
  };
  assert.equal(verifyKeyRotation({...base,newGeneration:4}).valid,false);
  assert.equal(verifyKeyRotation({...base,privateKeyMaterialTransferred:true}).valid,false);
});

test("verifies revocation evidence and rejects effectful revocation", () => {
  const base={
    schema:"aftergraph.signer-key-revocation/v1",
    providerId:"signer_test_hsm_01",
    keyHandle:"keyref_revoke_key_0001",
    publicKeyFingerprint:"sha256:"+"c".repeat(64),
    generation:3,
    reason:"operator_kill_switch",
    state:"REVOKED",
    externalEffects:0
  };
  assert.equal(verifyKeyRevocation(base).valid,true);
  assert.equal(verifyKeyRevocation({...base,externalEffects:1}).valid,false);
});

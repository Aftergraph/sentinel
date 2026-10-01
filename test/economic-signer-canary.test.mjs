import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { publicKeyFingerprint, verifyExternalSignerCanary } from "../lib/economic-signer-canary.js";

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fp = publicKeyFingerprint(publicKeyPem);
  const request = {
    schema:"aftergraph.economic-signer-canary-request/v1",
    payload:{
      domain:"aftergraph/economic-signer-canary/v1",
      purpose:"NON_ECONOMIC_CANARY",
      nonce:"canary_1234567890123456",
      authorityLeaseId:"auth_1234567890123456",
      approvalProofId:"apr_1234567890123456",
      keyHandle:"keyref_ephemeral_hsm_canary_01",
      publicKeyFingerprint:fp,
      expiresAt:1_900_000_000_000
    },
    challengeDigest:"sha256:"+createHash("sha256").update("independent-canary-challenge").digest("hex"),
    algorithm:"Ed25519",
    signatureRequested:true,
    transactionPayloadPresent:false,
    canBroadcast:false,
    externalEffects:0
  };
  const signature = sign(null, Buffer.from(request.challengeDigest), privateKey);
  const receipt = {
    schema:"aftergraph.external-signer-receipt/v1",
    challengeDigest:request.challengeDigest,
    keyHandle:request.payload.keyHandle,
    publicKeyFingerprint:fp,
    publicKeyPem,
    algorithm:"Ed25519",
    signatureBase64:signature.toString("base64"),
    signingMaterialExposed:false,
    transactionPayloadSigned:false,
    canBroadcast:false,
    externalEffects:0
  };
  return { request, receipt };
}

test("independently verifies detached non-economic signer receipt", () => {
  const { request, receipt } = fixture();
  const out = verifyExternalSignerCanary(request, receipt, 1_800_000_000_000);
  assert.equal(out.valid, true);
  assert.equal(out.signatureValid, true);
  assert.equal(out.final, false);
  assert.equal(out.promotionAuthority, false);
  assert.equal(out.canBroadcast, false);
  assert.equal(out.externalEffects, 0);
});

for (const [name, mutate] of [
  ["signature tamper", r => ({ ...r, signatureBase64: Buffer.alloc(64, 1).toString("base64") })],
  ["key fingerprint mismatch", r => ({ ...r, publicKeyFingerprint:"sha256:"+"0".repeat(64) })],
  ["transaction signed overclaim", r => ({ ...r, transactionPayloadSigned:true })],
  ["signing material exposure", r => ({ ...r, signingMaterialExposed:true })],
  ["broadcast capability", r => ({ ...r, canBroadcast:true })],
  ["external effect", r => ({ ...r, externalEffects:1 })]
]) {
  test("rejects "+name, () => {
    const { request, receipt } = fixture();
    const out = verifyExternalSignerCanary(request, mutate(receipt), 1_800_000_000_000);
    assert.equal(out.valid, false);
  });
}

test("rejects expired signer canary", () => {
  const { request, receipt } = fixture();
  const out = verifyExternalSignerCanary(request, receipt, 2_000_000_000_000);
  assert.equal(out.valid, false);
  assert.ok(out.reasons.includes("expired"));
});

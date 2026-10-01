import { createHash, createPublicKey, verify } from "node:crypto";

export function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return "sha256:" + createHash("sha256").update(der).digest("hex");
}

export function verifyExternalSignerCanary(request, receipt, now = Date.now()) {
  const reasons = [];

  if (request?.schema !== "aftergraph.economic-signer-canary-request/v1") reasons.push("request_schema");
  if (receipt?.schema !== "aftergraph.external-signer-receipt/v1") reasons.push("receipt_schema");
  if (request?.payload?.purpose !== "NON_ECONOMIC_CANARY") reasons.push("purpose");
  if (request?.transactionPayloadPresent !== false) reasons.push("transaction_payload_present");
  if (request?.canBroadcast !== false) reasons.push("request_broadcast_capability");
  if (request?.externalEffects !== 0) reasons.push("request_external_effects");
  if (receipt?.canBroadcast !== false) reasons.push("receipt_broadcast_capability");
  if (receipt?.externalEffects !== 0) reasons.push("receipt_external_effects");
  if (receipt?.signingMaterialExposed !== false) reasons.push("signing_material_exposed");
  if (receipt?.transactionPayloadSigned !== false) reasons.push("transaction_payload_signed");
  if (receipt?.algorithm !== "Ed25519") reasons.push("algorithm");
  if (request?.payload?.expiresAt <= now) reasons.push("expired");
  if (receipt?.challengeDigest !== request?.challengeDigest) reasons.push("digest_binding");
  if (receipt?.keyHandle !== request?.payload?.keyHandle) reasons.push("key_handle_binding");

  let computedFingerprint = null;
  try {
    computedFingerprint = publicKeyFingerprint(receipt?.publicKeyPem);
  } catch {
    reasons.push("public_key");
  }

  if (computedFingerprint && computedFingerprint !== request?.payload?.publicKeyFingerprint) {
    reasons.push("request_public_key_fingerprint");
  }
  if (computedFingerprint && computedFingerprint !== String(receipt?.publicKeyFingerprint || "").toLowerCase()) {
    reasons.push("receipt_public_key_fingerprint");
  }

  let signatureValid = false;
  if (reasons.length === 0) {
    try {
      signatureValid = verify(
        null,
        Buffer.from(request.challengeDigest),
        createPublicKey(receipt.publicKeyPem),
        Buffer.from(receipt.signatureBase64, "base64")
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) reasons.push("signature");
  }

  return {
    schema: "aftergraph.external-signer-canary-verification/v1",
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "CRYPTOGRAPHICALLY_VERIFIED_NON_ECONOMIC_CANARY" : "INVALID",
    signatureValid,
    final: false,
    promotionAuthority: false,
    canBroadcast: false,
    externalEffects: 0,
    reasons
  };
}

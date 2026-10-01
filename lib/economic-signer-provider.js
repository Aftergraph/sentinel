import { verifyExternalSignerCanary, publicKeyFingerprint } from "./economic-signer-canary.js";

export function verifySignerProviderReceipt(request, receipt, now = Date.now()) {
  const canary = verifyExternalSignerCanary(request, receipt, now);
  const reasons = [...canary.reasons];

  if (!/^signer_[A-Za-z0-9_-]{8,}$/.test(String(receipt?.providerId || ""))) reasons.push("provider_id");
  if (!Number.isInteger(receipt?.keyGeneration) || receipt.keyGeneration < 1) reasons.push("key_generation");
  if (receipt?.keyStateAtSigning !== "ACTIVE") reasons.push("key_state_at_signing");

  return {
    schema: "aftergraph.signer-provider-receipt-verification/v1",
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "VERIFIED_OPAQUE_SIGNER_CANARY" : "INVALID",
    signatureValid: canary.signatureValid && reasons.length === 0,
    providerBound: reasons.length === 0,
    keyGeneration: receipt?.keyGeneration ?? null,
    final: false,
    promotionAuthority: false,
    canBroadcast: false,
    externalEffects: 0,
    reasons
  };
}

export function verifyKeyRotation(rotation) {
  const reasons = [];
  if (rotation?.schema !== "aftergraph.signer-key-rotation/v1") reasons.push("schema");
  if (!/^signer_[A-Za-z0-9_-]{8,}$/.test(String(rotation?.providerId || ""))) reasons.push("provider_id");
  if (!/^keyref_[A-Za-z0-9_-]{12,}$/.test(String(rotation?.oldKeyHandle || ""))) reasons.push("old_key_handle");
  if (!/^keyref_[A-Za-z0-9_-]{12,}$/.test(String(rotation?.newKeyHandle || ""))) reasons.push("new_key_handle");
  if (!Number.isInteger(rotation?.oldGeneration) || !Number.isInteger(rotation?.newGeneration)) reasons.push("generation");
  if (Number.isInteger(rotation?.oldGeneration) && Number.isInteger(rotation?.newGeneration) && rotation.newGeneration !== rotation.oldGeneration + 1) reasons.push("generation_chain");
  if (rotation?.oldState !== "RETIRED") reasons.push("old_state");
  if (rotation?.newState !== "ACTIVE") reasons.push("new_state");
  if (rotation?.privateKeyMaterialTransferred !== false) reasons.push("private_key_transfer");
  if (rotation?.externalEffects !== 0) reasons.push("external_effects");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(rotation?.oldKeyFingerprint || ""))) reasons.push("old_fingerprint");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(rotation?.newKeyFingerprint || ""))) reasons.push("new_fingerprint");
  if (rotation?.oldKeyFingerprint === rotation?.newKeyFingerprint) reasons.push("rotation_did_not_change_key");

  return {
    schema: "aftergraph.signer-key-rotation-verification/v1",
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "VERIFIED_KEY_ROTATION" : "INVALID",
    final: false,
    promotionAuthority: false,
    externalEffects: 0,
    reasons
  };
}

export function verifyKeyRevocation(revocation) {
  const reasons = [];
  if (revocation?.schema !== "aftergraph.signer-key-revocation/v1") reasons.push("schema");
  if (!/^signer_[A-Za-z0-9_-]{8,}$/.test(String(revocation?.providerId || ""))) reasons.push("provider_id");
  if (!/^keyref_[A-Za-z0-9_-]{12,}$/.test(String(revocation?.keyHandle || ""))) reasons.push("key_handle");
  if (!Number.isInteger(revocation?.generation) || revocation.generation < 1) reasons.push("generation");
  if (revocation?.state !== "REVOKED") reasons.push("state");
  if (!String(revocation?.reason || "")) reasons.push("reason");
  if (revocation?.externalEffects !== 0) reasons.push("external_effects");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(revocation?.publicKeyFingerprint || ""))) reasons.push("fingerprint");

  return {
    schema: "aftergraph.signer-key-revocation-verification/v1",
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "VERIFIED_KEY_REVOCATION" : "INVALID",
    final: false,
    promotionAuthority: false,
    externalEffects: 0,
    reasons
  };
}

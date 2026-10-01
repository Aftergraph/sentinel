import { verifySettlementCorrelation } from "./economic-settlement-correlation.js";
import { verifyLegalAssetReconciliation } from "./economic-legal-reconciliation.js";
import { verifyEvidenceCoherence } from "./economic-evidence-coherence.js";
import { verifySignerProviderReceipt } from "./economic-signer-provider.js";
import { verifyCustodyObservation, verifyCustodyRecoveryCanary } from "./economic-custody-provider.js";

export function verifyLiveCanaryAssurance(input) {
  const now = input?.now ?? Date.now();
  const expected = input?.expected ?? {};

  const correlation = verifySettlementCorrelation(input?.settlementCorrelation);
  const legal = verifyLegalAssetReconciliation(input?.legalReconciliation);
  const coherence = verifyEvidenceCoherence(input?.evidenceCoherence);
  const signer = verifySignerProviderReceipt(input?.signer?.request, input?.signer?.receipt, now);
  const custodyObservation = verifyCustodyObservation(input?.custody?.observation);
  const custodyRecovery = verifyCustodyRecoveryCanary(input?.custody?.recovery, now);

  const reasons = [];
  const component = (name, result) => {
    if (!result?.valid) reasons.push(name + ":invalid");
    if (result?.final !== false) reasons.push(name + ":finality");
    if (result?.promotionAuthority !== false) reasons.push(name + ":promotion_authority");
    if (result?.externalEffects !== 0) reasons.push(name + ":external_effects");
  };

  component("correlation", correlation);
  component("legal", legal);
  component("coherence", coherence);
  component("signer", signer);
  component("custody_observation", custodyObservation);
  component("custody_recovery", custodyRecovery);

  const c = input?.settlementCorrelation ?? {};
  const l = input?.legalReconciliation ?? {};
  const e = input?.evidenceCoherence ?? {};
  const custodyRecord = l?.custody ?? {};
  const registryRecord = l?.registry ?? {};
  const representationRecord = l?.representation ?? {};
  const observations = Array.isArray(e?.observations) ? e.observations : [];
  const byClass = new Map(observations.map(x => [x?.sourceClass, x]));

  if (!expected?.economicTransactionId || c?.economicTransactionId !== expected.economicTransactionId) {
    reasons.push("binding:economic_transaction_id");
  }
  if (!expected?.legalBindingHash || c?.legalBindingHash !== expected.legalBindingHash) {
    reasons.push("binding:legal_binding_hash");
  }
  if (!expected?.assetId || l?.canonical?.assetId !== expected.assetId) reasons.push("binding:asset_id");
  if (!expected?.rightId || l?.canonical?.rightId !== expected.rightId) reasons.push("binding:right_id");
  if (!expected?.legalInstrumentHash || l?.canonical?.legalInstrumentHash !== expected.legalInstrumentHash) {
    reasons.push("binding:legal_instrument_hash");
  }
  if (!expected?.rightsHash || l?.canonical?.rightsHash !== expected.rightsHash) reasons.push("binding:rights_hash");
  if (!expected?.custodyRef || custodyRecord?.custodyRef !== expected.custodyRef) reasons.push("binding:custody_ref");

  if (input?.custody?.observation?.custodyRef !== custodyRecord?.custodyRef) reasons.push("binding:custody_observation_ref");
  if (input?.custody?.observation?.accountFingerprint !== custodyRecord?.accountFingerprint) {
    reasons.push("binding:custody_account_fingerprint");
  }
  if (input?.custody?.recovery?.challenge?.custodyRef !== custodyRecord?.custodyRef) {
    reasons.push("binding:custody_recovery_ref");
  }

  const registryMeta = byClass.get("registry");
  const custodyMeta = byClass.get("custody");
  const representationMeta = byClass.get("representation");
  if (registryMeta?.evidenceHash !== registryRecord?.evidenceHash) reasons.push("binding:registry_evidence_hash");
  if (custodyMeta?.evidenceHash !== custodyRecord?.evidenceHash) reasons.push("binding:custody_evidence_hash");
  if (representationMeta?.evidenceHash !== representationRecord?.evidenceHash) reasons.push("binding:representation_evidence_hash");
  if (registryMeta?.sourceId !== registryRecord?.registryId) reasons.push("binding:registry_source_id");
  if (custodyMeta?.sourceId !== custodyRecord?.custodianId) reasons.push("binding:custody_source_id");
  if (representationMeta?.sourceId !== representationRecord?.network) reasons.push("binding:representation_source_id");

  const uniqueReasons = [...new Set(reasons)].sort();
  const ready = uniqueReasons.length === 0;

  return {
    schema: "aftergraph.economic-live-canary-assurance/v1",
    state: ready ? "READY_FOR_LIVE_CANARY_REVIEW" : "NOT_READY",
    readyForLiveCanaryReview: ready,
    executionAuthority: false,
    liveValueEnabled: false,
    maxLiveValue: 0,
    final: false,
    promotionAuthority: false,
    externalEffects: 0,
    components: {
      correlation: correlation.state,
      legal: legal.state,
      coherence: coherence.state,
      signer: signer.state,
      custodyObservation: custodyObservation.state,
      custodyRecovery: custodyRecovery.state
    },
    reasons: uniqueReasons
  };
}

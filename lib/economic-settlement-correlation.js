function isSha256Ref(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ""));
}

export function verifySettlementCorrelation(input) {
  const reasons = [];
  const {
    economicTransactionId,
    intentHash,
    legalBindingHash,
    obligations = [],
    receipts = [],
    correlation = {}
  } = input || {};

  if (!economicTransactionId) reasons.push("transaction_id");
  if (!isSha256Ref(intentHash)) reasons.push("intent_hash");
  if (!isSha256Ref(legalBindingHash)) reasons.push("legal_binding_hash");
  if (!Array.isArray(obligations) || obligations.length < 2) reasons.push("obligations");
  if (!Array.isArray(receipts)) reasons.push("receipts");

  const expected = new Map();
  let hasAsset = false;
  let hasCash = false;

  for (const o of obligations) {
    if (!o?.legId || !o?.rail) reasons.push("obligation_identity");
    if (!isSha256Ref(o?.obligationHash)) reasons.push("obligation_hash");
    if (o?.legalBindingHash !== legalBindingHash) reasons.push("obligation_legal_binding");
    if (expected.has(o?.legId)) reasons.push("duplicate_obligation_leg");
    if (o?.kind === "asset") hasAsset = true;
    else if (o?.kind === "cash") hasCash = true;
    else if (o?.kind !== "fee") reasons.push("obligation_kind");
    expected.set(o?.legId, o);
  }

  if (!hasAsset || !hasCash) reasons.push("asset_cash_pair");

  const seenLegs = new Set();
  const seenEvidence = new Set();
  const matchedLegs = [];

  for (const r of receipts) {
    const leg = r?.legId || "unknown";
    if (r?.schema !== "aftergraph.rail-settlement-receipt/v1") {
      reasons.push(leg + ":receipt_schema");
      continue;
    }
    if (r?.economicTransactionId !== economicTransactionId) {
      reasons.push(leg + ":transaction_id");
      continue;
    }
    if (r?.externalEffects !== 0 || r?.final !== false) {
      reasons.push(leg + ":receipt_overclaim");
      continue;
    }

    const o = expected.get(r?.legId);
    if (!o) {
      reasons.push(leg + ":unexpected_leg");
      continue;
    }
    if (seenLegs.has(r.legId)) {
      reasons.push(leg + ":duplicate_receipt");
      continue;
    }
    seenLegs.add(r.legId);

    if (!isSha256Ref(r?.sourceEvidenceHash)) {
      reasons.push(leg + ":source_evidence");
      continue;
    }
    if (seenEvidence.has(r.sourceEvidenceHash)) {
      reasons.push(leg + ":source_evidence_reused");
      continue;
    }
    seenEvidence.add(r.sourceEvidenceHash);

    if (
      r?.kind !== o.kind ||
      r?.rail !== o.rail ||
      r?.obligationHash !== o.obligationHash ||
      r?.legalBindingHash !== o.legalBindingHash
    ) {
      reasons.push(leg + ":obligation_binding");
      continue;
    }
    if (r?.outcome !== "COMMITTED") {
      reasons.push(leg + ":not_committed");
      continue;
    }
    matchedLegs.push(r.legId);
  }

  for (const legId of expected.keys()) {
    if (!seenLegs.has(legId)) reasons.push(legId + ":missing_receipt");
  }

  const expectedState = reasons.length === 0 ? "CORRELATED" : "UNCERTAIN";
  const expectedReconciliation = reasons.length !== 0;
  const normalizedMatched = [...matchedLegs].sort();

  if (correlation?.schema !== "aftergraph.economic-settlement-correlation/v1") reasons.push("correlation_schema");
  if (correlation?.economicTransactionId !== economicTransactionId) reasons.push("correlation_transaction_id");
  if (correlation?.intentHash !== intentHash) reasons.push("correlation_intent_hash");
  if (correlation?.legalBindingHash !== legalBindingHash) reasons.push("correlation_legal_binding");
  if (correlation?.final !== false) reasons.push("correlation_finality");
  if (correlation?.externalEffects !== 0) reasons.push("correlation_external_effects");

  if (reasons.length === 0) {
    if (correlation?.state !== expectedState) reasons.push("correlation_state");
    if (correlation?.reconciliationRequired !== expectedReconciliation) reasons.push("correlation_reconciliation");
    const claimed = Array.isArray(correlation?.matchedLegs) ? [...correlation.matchedLegs].sort() : [];
    if (JSON.stringify(claimed) !== JSON.stringify(normalizedMatched)) reasons.push("correlation_matched_legs");
  } else {
    if (correlation?.state === "CORRELATED") reasons.push("correlation_overclaims_success");
    if (correlation?.reconciliationRequired !== true) reasons.push("correlation_missing_reconciliation");
  }

  return {
    schema: "aftergraph.economic-settlement-correlation-verification/v1",
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "VERIFIED_SAME_ECONOMIC_TRANSACTION" : "RECONCILIATION_REQUIRED",
    sameEconomicTransactionVerified: reasons.length === 0,
    matchedLegs: normalizedMatched,
    final: false,
    promotionAuthority: false,
    externalEffects: 0,
    reasons: [...new Set(reasons)].sort()
  };
}

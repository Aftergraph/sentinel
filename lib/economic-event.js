export function validateEconomicEvent(event) {
  const reasons = [];
  if (event?.schema !== "aftergraph.sentinel-economic-event/v1") reasons.push("schema");
  if (!event?.transactionId) reasons.push("transaction_id");
  if (!event?.evidenceHash || !/^[a-f0-9]{64}$/i.test(event.evidenceHash)) reasons.push("evidence_hash");
  if (event?.type !== "economic.staged" && !event?.executionContextId) reasons.push("execution_context_id");
  if (event?.type === "economic.reconcile.required" && event?.final === true) reasons.push("uncertain_cannot_be_final");
  return { valid: reasons.length === 0, reasons };
}

export function economicVerificationState(event) {
  const checked = validateEconomicEvent(event);
  if (!checked.valid) return { state: "INVALID", final: false, reasons: checked.reasons };
  if (event.type === "economic.reconcile.required") return { state: "UNCERTAIN", final: false, reasons: ["reconciliation_required"] };
  if (event.type === "economic.finalized") return { state: "OBSERVED_FINAL", final: true, reasons: [] };
  return { state: "OBSERVED", final: false, reasons: [] };
}

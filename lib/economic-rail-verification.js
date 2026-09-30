export function verifyRailObservation(observation) {
  const reasons = [];
  if (observation?.schema !== "aftergraph.rail-observation/v1") reasons.push("schema");
  if (!["evm","canton"].includes(observation?.rail)) reasons.push("rail");
  if (observation?.externalEffects !== 0) reasons.push("external_effects");
  if (!observation?.subject) reasons.push("subject");

  if (observation?.rail === "evm") {
    if (observation?.finalityClass !== "CONSENSUS_FINALIZED") reasons.push("evm_finality_class");
    if (observation?.observedState !== "EVM_FINALIZED_HEAD_OBSERVED") reasons.push("evm_state");
  }

  if (observation?.rail === "canton") {
    if (observation?.finalityClass !== "PARTICIPANT_LEDGER_OBSERVED") reasons.push("canton_finality_class");
    if (observation?.observedState !== "CANTON_LEDGER_OFFSET_OBSERVED") reasons.push("canton_state");
  }

  return { valid: reasons.length === 0, reasons };
}

export function reconcileRailObservations(observations) {
  if (!Array.isArray(observations) || observations.length < 2) {
    return { state: "INSUFFICIENT_EVIDENCE", final: false, reasons: ["two_independent_rails_required"] };
  }

  const checked = observations.map(verifyRailObservation);
  if (checked.some((x) => !x.valid)) {
    return { state: "INVALID", final: false, reasons: checked.flatMap((x) => x.reasons) };
  }

  const rails = new Set(observations.map((x) => x.rail));
  if (rails.size < 2) {
    return { state: "INSUFFICIENT_EVIDENCE", final: false, reasons: ["independent_rail_diversity_required"] };
  }

  const subjects = new Set(observations.map((x) => x.correlationSubject ?? x.transactionId ?? x.subject));
  if (subjects.size > 1) {
    return { state: "UNCERTAIN", final: false, reasons: ["rail_subject_disagreement"] };
  }

  // Cross-rail agreement is observation evidence only. It never upgrades the
  // settlement capability to live execution or legal finality.
  return { state: "CORROBORATED_OBSERVATION", final: false, reasons: [] };
}

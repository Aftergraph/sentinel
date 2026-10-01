const ALLOWED_OUTCOMES = new Set(["completed", "partial", "failed", "denied", "not_executed"]);
const ALLOWED_VERIFICATION = new Set(["not_run", "pending", "passed", "failed", "needs_review"]);

export function verifyWorkReceipt(receipt, { verifierRef } = {}) {
  const findings = [];

  if (!receipt || typeof receipt !== "object") {
    return { verdict: "fail", findings: [{ code: "receipt_missing", message: "receipt must be an object" }] };
  }

  if (receipt.schema !== "aftergraph.work-receipt/v1") {
    findings.push({ code: "schema_mismatch", message: "unsupported work receipt schema" });
  }
  if (!String(receipt.work_id || receipt.workId || "").trim()) {
    findings.push({ code: "missing_work_id", message: "work id is required" });
  }
  if (!String(receipt.authority_ref || receipt.authorityRef || "").trim()) {
    findings.push({ code: "missing_authority_ref", message: "authority reference is required" });
  }

  const outcome = receipt.outcome;
  if (!ALLOWED_OUTCOMES.has(outcome)) {
    findings.push({ code: "invalid_outcome", message: "outcome is not recognized" });
  }

  const evidenceRefs = receipt.evidence_refs || receipt.evidenceRefs || [];
  if (outcome === "completed" && (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0)) {
    findings.push({ code: "completed_without_evidence", message: "completed work requires evidence references" });
  }

  const verification = receipt.verification || {};
  if (!ALLOWED_VERIFICATION.has(verification.state)) {
    findings.push({ code: "invalid_verification_state", message: "verification state is not recognized" });
  }

  const claimedVerifier = verification.verifier_ref || verification.verifierRef || "";
  const executor = receipt.executor || {};
  const executorRef = String(executor.agent || executor.session_ref || executor.sessionRef || "");

  if (verification.state === "passed") {
    if (!String(claimedVerifier).trim()) {
      findings.push({ code: "passed_without_verifier", message: "passed verification requires verifier reference" });
    }
    if (executorRef && claimedVerifier === executorRef) {
      findings.push({ code: "self_verification", message: "executor cannot independently verify its own work" });
    }
    if (verifierRef && claimedVerifier !== verifierRef) {
      findings.push({ code: "verifier_binding_mismatch", message: "receipt verifier does not match the active verifier" });
    }
  }

  const critical = findings.some((finding) =>
    ["schema_mismatch", "missing_work_id", "missing_authority_ref", "invalid_outcome",
     "completed_without_evidence", "invalid_verification_state", "passed_without_verifier",
     "self_verification", "verifier_binding_mismatch"].includes(finding.code)
  );

  return {
    verdict: critical ? "fail" : "pass",
    findings,
    verificationAuthorityGranted: false,
    executionAuthorityGranted: false,
  };
}

const ALLOWED_OUTCOMES = new Set(["completed", "partial", "failed", "denied", "not_executed"]);
const ALLOWED_VERIFICATION = new Set(["not_run", "pending", "passed", "failed", "needs_review"]);
const ALLOWED_STEP_KINDS = new Set([
  "plan", "tool", "file", "command", "network", "approval",
  "test", "build", "commit", "deploy", "human",
]);
const ALLOWED_STEP_STATUS = new Set(["attempted", "succeeded", "failed", "denied", "skipped"]);

const CANONICAL_INVARIANTS = [
  "receipt presence does not prove correctness",
  "execution success does not establish verified outcome",
  "authority is referenced, never inferred from tool possession",
  "evidence references must remain distinguishable from executor assertions",
];

const REQUIRED_FIELDS = [
  "schema",
  "work_id",
  "recorded_at",
  "executor",
  "intent",
  "authority_ref",
  "steps",
  "artifacts",
  "evidence_refs",
  "verification",
  "outcome",
  "invariants",
];

function sameStrings(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length;
}

export function verifyWorkReceipt(receipt, { verifierRef } = {}) {
  const findings = [];

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return {
      verdict: "fail",
      findings: [{ code: "receipt_missing", message: "receipt must be an object" }],
      verificationAuthorityGranted: false,
      executionAuthorityGranted: false,
    };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
      findings.push({
        code: "missing_required_field",
        field,
        message: `required governance field ${field} is missing`,
      });
    }
  }

  if (receipt.schema !== "aftergraph.work-receipt/v1") {
    findings.push({ code: "schema_mismatch", message: "unsupported work receipt schema" });
  }
  if (!nonEmptyString(receipt.work_id)) {
    findings.push({ code: "missing_work_id", message: "work_id is required" });
  }
  if (!nonEmptyString(receipt.intent)) {
    findings.push({ code: "missing_intent", message: "intent is required" });
  }
  if (!nonEmptyString(receipt.authority_ref)) {
    findings.push({ code: "missing_authority_ref", message: "authority_ref is required" });
  }
  if (!nonEmptyString(receipt.recorded_at) || Number.isNaN(Date.parse(receipt.recorded_at))) {
    findings.push({ code: "invalid_recorded_at", message: "recorded_at must be an ISO date-time" });
  }

  const executor = receipt.executor;
  if (!executor || typeof executor !== "object" || !nonEmptyString(executor.agent)) {
    findings.push({ code: "invalid_executor", message: "executor.agent is required" });
  }

  if (!Array.isArray(receipt.steps)) {
    findings.push({ code: "invalid_steps", message: "steps must be an array" });
  } else {
    receipt.steps.forEach((step, index) => {
      if (!step || typeof step !== "object" || !ALLOWED_STEP_KINDS.has(step.kind)) {
        findings.push({ code: "invalid_step_kind", index, message: "step kind is not recognized" });
      }
      if (!step || typeof step !== "object" || !ALLOWED_STEP_STATUS.has(step.status)) {
        findings.push({ code: "invalid_step_status", index, message: "step status is not recognized" });
      }
    });
  }

  if (!uniqueStrings(receipt.artifacts)) {
    findings.push({ code: "invalid_artifacts", message: "artifacts must be unique strings" });
  }
  if (!uniqueStrings(receipt.evidence_refs)) {
    findings.push({ code: "invalid_evidence_refs", message: "evidence_refs must be unique strings" });
  }

  if (!sameStrings(receipt.invariants, CANONICAL_INVARIANTS)) {
    findings.push({
      code: "invariant_mismatch",
      message: "receipt truth-boundary invariants do not match governance",
    });
  }

  const outcome = receipt.outcome;
  if (!ALLOWED_OUTCOMES.has(outcome)) {
    findings.push({ code: "invalid_outcome", message: "outcome is not recognized" });
  }
  if (outcome === "completed" && (!Array.isArray(receipt.evidence_refs) || receipt.evidence_refs.length === 0)) {
    findings.push({
      code: "completed_without_evidence",
      message: "completed work requires evidence references",
    });
  }

  const verification = receipt.verification;
  if (!verification || typeof verification !== "object" || !ALLOWED_VERIFICATION.has(verification.state)) {
    findings.push({
      code: "invalid_verification_state",
      message: "verification state is not recognized",
    });
  } else {
    if (!uniqueStrings(verification.evaluations)) {
      findings.push({
        code: "invalid_evaluations",
        message: "verification.evaluations must be unique strings",
      });
    }

    const claimedVerifier = verification.verifier_ref || "";
    const executorRef = String(executor?.agent || executor?.session_ref || "");

    if (verification.state === "passed") {
      if (!nonEmptyString(claimedVerifier)) {
        findings.push({
          code: "passed_without_verifier",
          message: "passed verification requires verifier reference",
        });
      }
      if (executorRef && claimedVerifier === executorRef) {
        findings.push({
          code: "self_verification",
          message: "executor cannot independently verify its own work",
        });
      }
      if (verifierRef && claimedVerifier !== verifierRef) {
        findings.push({
          code: "verifier_binding_mismatch",
          message: "receipt verifier does not match the active verifier",
        });
      }
    }
  }

  return {
    verdict: findings.length > 0 ? "fail" : "pass",
    findings,
    verificationAuthorityGranted: false,
    executionAuthorityGranted: false,
  };
}

export { CANONICAL_INVARIANTS };

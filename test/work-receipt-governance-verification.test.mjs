import test from "node:test";
import assert from "node:assert/strict";
import { verifyWorkReceipt } from "../lib/work-receipt-verification.js";

const INVARIANTS = [
  "receipt presence does not prove correctness",
  "execution success does not establish verified outcome",
  "authority is referenced, never inferred from tool possession",
  "evidence references must remain distinguishable from executor assertions",
];

function baseReceipt() {
  return {
    schema: "aftergraph.work-receipt/v1",
    work_id: "wrk_1",
    recorded_at: "2026-10-01T22:00:00.000Z",
    executor: { agent: "codex" },
    intent: "change source",
    authority_ref: "grant://1",
    steps: [{ kind: "tool", status: "succeeded", ref: "tool://example" }],
    artifacts: [],
    evidence_refs: ["evidence://diff/1"],
    verification: { state: "pending", evaluations: [] },
    outcome: "completed",
    invariants: [...INVARIANTS],
  };
}

test("accepts canonical completed execution that is still verification-pending", () => {
  const result = verifyWorkReceipt(baseReceipt(), { verifierRef: "sentinel://run/1" });
  assert.equal(result.verdict, "pass");
  assert.equal(result.executionAuthorityGranted, false);
  assert.equal(result.verificationAuthorityGranted, false);
});

test("rejects receipts missing canonical truth-boundary invariants", () => {
  const receipt = baseReceipt();
  receipt.invariants = [];
  const result = verifyWorkReceipt(receipt);
  assert.equal(result.verdict, "fail");
  assert.ok(result.findings.some((finding) => finding.code === "invariant_mismatch"));
});

test("rejects receipts missing required governance fields", () => {
  for (const field of ["recorded_at", "intent", "steps", "artifacts"]) {
    const receipt = baseReceipt();
    delete receipt[field];
    const result = verifyWorkReceipt(receipt);
    assert.equal(result.verdict, "fail", field);
    assert.ok(result.findings.some((finding) => finding.code === "missing_required_field"), field);
  }
});

test("rejects completed work without evidence", () => {
  const receipt = baseReceipt();
  receipt.evidence_refs = [];
  const result = verifyWorkReceipt(receipt);
  assert.equal(result.verdict, "fail");
  assert.ok(result.findings.some((finding) => finding.code === "completed_without_evidence"));
});

test("rejects executor self-verification", () => {
  const receipt = baseReceipt();
  receipt.verification = { state: "passed", verifier_ref: "codex", evaluations: [] };
  const result = verifyWorkReceipt(receipt, { verifierRef: "codex" });
  assert.equal(result.verdict, "fail");
  assert.ok(result.findings.some((finding) => finding.code === "self_verification"));
});

test("binds passed verification to the active Sentinel verifier", () => {
  const receipt = baseReceipt();
  receipt.verification = { state: "passed", verifier_ref: "sentinel://run/2", evaluations: [] };
  const result = verifyWorkReceipt(receipt, { verifierRef: "sentinel://run/1" });
  assert.equal(result.verdict, "fail");
  assert.ok(result.findings.some((finding) => finding.code === "verifier_binding_mismatch"));
});

test("rejects invalid step enums", () => {
  const receipt = baseReceipt();
  receipt.steps[0].status = "verified";
  const result = verifyWorkReceipt(receipt);
  assert.equal(result.verdict, "fail");
  assert.ok(result.findings.some((finding) => finding.code === "invalid_step_status"));
});

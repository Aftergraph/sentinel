import test from "node:test";
import assert from "node:assert/strict";
import { verifyWorkReceipt } from "../lib/work-receipt-verification.js";

function baseReceipt() {
  return {
    schema: "aftergraph.work-receipt/v1",
    work_id: "wrk_1",
    authority_ref: "grant://1",
    executor: { agent: "codex" },
    outcome: "completed",
    evidence_refs: ["evidence://diff/1"],
    verification: { state: "pending", evaluations: [] },
  };
}

test("accepts completed execution that is still verification-pending", () => {
  const result = verifyWorkReceipt(baseReceipt(), { verifierRef: "sentinel://run/1" });
  assert.equal(result.verdict, "pass");
  assert.equal(result.executionAuthorityGranted, false);
  assert.equal(result.verificationAuthorityGranted, false);
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

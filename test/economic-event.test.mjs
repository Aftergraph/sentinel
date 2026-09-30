import test from "node:test";
import assert from "node:assert/strict";
import { economicVerificationState, validateEconomicEvent } from "../lib/economic-event.js";

const base = {
  schema: "aftergraph.sentinel-economic-event/v1",
  type: "economic.runtime.observed",
  transactionId: "econ_1",
  executionContextId: "ctx_33333333333333333333333333333333",
  evidenceHash: "a".repeat(64),
};

test("economic event requires lineage-bound evidence", () => {
  assert.deepEqual(validateEconomicEvent(base), { valid: true, reasons: [] });
  assert.equal(validateEconomicEvent({ ...base, executionContextId: "" }).valid, false);
});

test("reconciliation requirement can never be final", () => {
  const out = economicVerificationState({ ...base, type: "economic.reconcile.required" });
  assert.equal(out.state, "UNCERTAIN");
  assert.equal(out.final, false);
});

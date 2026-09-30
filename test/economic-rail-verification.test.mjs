import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRailObservations, verifyRailObservation } from "../lib/economic-rail-verification.js";

const evm = {
  schema: "aftergraph.rail-observation/v1",
  rail: "evm",
  subject: "0xabc",
  correlationSubject: "econ_1",
  observedState: "EVM_FINALIZED_HEAD_OBSERVED",
  finalityClass: "CONSENSUS_FINALIZED",
  externalEffects: 0,
};

const canton = {
  schema: "aftergraph.rail-observation/v1",
  rail: "canton",
  subject: "40",
  correlationSubject: "econ_1",
  observedState: "CANTON_LEDGER_OFFSET_OBSERVED",
  finalityClass: "PARTICIPANT_LEDGER_OBSERVED",
  externalEffects: 0,
};

test("validates rail-specific finality semantics", () => {
  assert.equal(verifyRailObservation(evm).valid, true);
  assert.equal(verifyRailObservation(canton).valid, true);
  assert.equal(verifyRailObservation({ ...canton, finalityClass: "CONSENSUS_FINALIZED" }).valid, false);
});

test("two independent rail observations corroborate but do not become FINAL", () => {
  const out = reconcileRailObservations([evm, canton]);
  assert.equal(out.state, "CORROBORATED_OBSERVATION");
  assert.equal(out.final, false);
});

test("cross-rail subject disagreement becomes UNCERTAIN", () => {
  const out = reconcileRailObservations([evm, { ...canton, correlationSubject: "econ_2" }]);
  assert.equal(out.state, "UNCERTAIN");
  assert.equal(out.final, false);
});

test("same-rail duplication is insufficient independent evidence", () => {
  const out = reconcileRailObservations([evm, { ...evm }]);
  assert.equal(out.state, "INSUFFICIENT_EVIDENCE");
  assert.equal(out.final, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex, verifyLabsPreflight } from "../lib/labs-preflight-verifier.js";

const seal = (doc, field) => ({ ...doc, [field]: sha256Hex(canonicalJson(doc)) });

const observation = (adapterId, revision = "a".repeat(40)) => seal({
  schemaVersion: "aftergraph.labs-observation/v1",
  adapterId,
  capability: `${adapterId}.health`,
  observedAt: "2026-10-01T00:00:00.000Z",
  state: "healthy",
  subjectRevision: revision,
  evidenceRefs: [`${adapterId}.json`],
  details: { sourceKind: "test" },
  authorityGranted: false,
  maximumClaim: "OBSERVED"
}, "observationDigest");

const fixture = () => {
  const httpBundle = seal({
    schemaVersion: "aftergraph.federated-evidence-bundle/v1",
    generatedAt: "2026-10-01T00:00:00.000Z",
    planDigest: "b".repeat(64),
    layers: [{ plane: "evaluation", observations: [observation("fihim-eval-lab", "c".repeat(40))] }],
    unresolvedTargets: [],
    authorityGranted: false,
    verificationGranted: false,
    scientificValidityGranted: false,
    maximumClaim: "OBSERVED"
  }, "bundleDigest");

  const sutBinding = seal({
    schemaVersion: "aftergraph.labs-sut-binding/v1",
    sutId: "fihim-vnext:v0.31",
    repository: "Aftergraph/fihim-vnext",
    requestedVersion: "v0.31",
    packageVersion: "0.31.0-frontier.1",
    directoryName: "fihim-vnext-v0.31",
    sourceRevision: "d".repeat(40),
    contentDigest: "e".repeat(64),
    observedAt: "2026-10-01T00:00:00.000Z",
    immutableSubject: true,
    authorityGranted: false,
    maximumClaim: "OBSERVED"
  }, "bindingDigest");

  return seal({
    schemaVersion: "aftergraph.labs-preflight/v1",
    generatedAt: "2026-10-01T00:00:00.000Z",
    state: "OBSERVED",
    requiredAdapterIds: ["fihim-eval-lab", "runtime", "fihim-vnext"],
    observedAdapterIds: ["fihim-eval-lab", "runtime", "fihim-vnext"],
    missingAdapterIds: [],
    httpBundle,
    artifactObservations: [observation("runtime", "f".repeat(40))],
    sutBinding,
    authorityGranted: false,
    verificationGranted: false,
    scientificValidityGranted: false,
    maximumClaim: "OBSERVED"
  }, "receiptDigest");
};

test("independently verifies a sealed observational preflight", () => {
  const out = verifyLabsPreflight(fixture());
  assert.equal(out.valid, true);
  assert.equal(out.state, "VERIFIED_OBSERVATIONAL_PREFLIGHT");
  assert.equal(out.coverageComplete, true);
  assert.equal(out.authorityGranted, false);
  assert.equal(out.promotionAuthority, false);
  assert.equal(out.scientificValidityGranted, false);
  assert.match(out.verificationDigest, /^[a-f0-9]{64}$/);
});

test("rejects tampered receipt digest", () => {
  const receipt = fixture();
  receipt.observedAdapterIds = ["runtime"];
  const out = verifyLabsPreflight(receipt);
  assert.equal(out.valid, false);
  assert.ok(out.reasons.includes("receipt:digest"));
  assert.ok(out.reasons.includes("receipt:coverage_mismatch"));
});

test("rejects nested verification escalation", () => {
  const receipt = fixture();
  receipt.httpBundle.verificationGranted = true;
  receipt.httpBundle.bundleDigest = sha256Hex(canonicalJson(
    Object.fromEntries(Object.entries(receipt.httpBundle).filter(([key]) => key !== "bundleDigest"))
  ));
  const base = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptDigest"));
  receipt.receiptDigest = sha256Hex(canonicalJson(base));
  const out = verifyLabsPreflight(receipt);
  assert.equal(out.valid, false);
  assert.ok(out.reasons.includes("http_bundle:verification_escalation"));
});

test("rejects false OBSERVED state when required coverage is absent", () => {
  const receipt = fixture();
  receipt.observedAdapterIds = ["fihim-eval-lab", "runtime"];
  receipt.missingAdapterIds = ["fihim-vnext"];
  receipt.sutBinding = null;
  const base = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptDigest"));
  receipt.receiptDigest = sha256Hex(canonicalJson(base));
  const out = verifyLabsPreflight(receipt);
  assert.equal(out.valid, false);
  assert.ok(out.reasons.some((reason) => reason.startsWith("receipt:state_mismatch:INCOMPLETE")));
});

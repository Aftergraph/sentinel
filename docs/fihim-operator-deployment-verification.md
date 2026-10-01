# FIHIM Operator deployment verification

Status: frontier integration contract.

Sentinel can verify the integrity and independent readback requirements of a FIHIM Operator deployment without treating FIHIM's own deployment receipts as independent verification.

## Inputs

`verifyFihimOperatorDeployment()` accepts the FIHIM release plan, VDS execution receipt, public deployment receipt, public `mcp.json`, and the bytes of the published plugin/manifest artifacts.

The verifier checks:

- `operator-vds-release-plan/0.56-frontier` plan hash integrity;
- `operator-vds-release-executor/0.57-frontier` is ACTIVATED and bound to the exact plan/revision/release target;
- live staged dependency installation and staged verification were recorded;
- `operator-public-deployment-receipt/0.54-frontier` is content-addressed and binds the plugin + MCP manifest digests;
- public origin/MCP endpoint/source revision agree across the evidence set;
- authority and self-verification truth boundaries remain false.

## Verdicts

Integrity or correlation failure produces `REJECTED`.

A completely consistent FIHIM evidence bundle without an independent observer produces `INDETERMINATE`, not VERIFIED.

`VERIFIED` requires an independent callback with:

- a distinct `observerRef` from the VDS executor;
- at least one independent `evidenceRef`;
- an observed origin and MCP endpoint matching the bound deployment subject;
- modern MCP protocol negotiation;
- a read-only exposed tool surface.

An observer failure produces `REJECTED`; missing/invalid/insufficient independent evidence remains `INDETERMINATE`.

## Receipt

Sentinel emits `aftergraph.fihim-operator-deployment-verification.receipt/1.0`.

The receipt is content-addressed with `hashBody` and binds the subject, verdict, checks, verifier reference, and executor reference. `verifiedAt` is excluded from the stable hash, matching Sentinel's existing domain verification receipt pattern.

`verifyFihimOperatorDeploymentReceipt()` recomputes the receipt digest offline.

## Evidence-layer boundary

FIHIM deployment receipts prove what the deployment system recorded. Sentinel does not upgrade them merely because their hashes are valid.

The independent readback requirement is the boundary between deployment provenance and an independently observed deployment claim. Even a Sentinel VERIFIED receipt does not grant runtime authority, approve actions, or change AIE / Trust Gateway policy.

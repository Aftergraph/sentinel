# Production activation — Sentinel simplification verifier

Target host: `vmi3517816`.

This runbook closes the production path:

```text
code-simplification producer claim
        ↓
Sentinel independent GitHub evidence observer
        ↓
Sentinel VERIFIED / REJECTED receipt
        ↓
WORKS /v1/works/{id}/verification
        ↓
durable outcome_verification projection
```

## Preconditions

The activation intentionally requires an explicit root session on the target host. The generic `aftergraph-ci` runner remains non-root and is not widened.

Required existing production state:

- `works-api.service` active and healthy on `127.0.0.1:18191`;
- canonical WORKS checkout at `/root/works-venture`;
- root-owned `/etc/works/works.env`;
- canonical WORKS helper `scripts/ops/works-verifier-credential.sh`;
- worker enrollment already configured.

## Activate

Run from a trusted checkout of this repository:

```bash
sudo bash scripts/ops/activate-production-simplification-verifier.sh
```

The script installs exact Sentinel revision
`3189785fc8ce866244c51f9611f93d19c191331c`, runs its full native test suite
before cutover, activates the dedicated WORKS verifier credential using the
WORKS-owned helper, installs the hardened `aftergraph-sentinel.service`, and
executes a real production proof.

The proof creates a harmless one-node WORKS execution (`true`), waits for
`SUCCEEDED`, independently resolves the exact public GitHub evidence for the
war-room simplification benchmark, requires Sentinel `VERIFIED`, publishes the
content-addressed `dvr_…` receipt to WORKS, and reads the same receipt back
through the WORKS evidence projection.

Success emits one non-secret JSON object containing:

- exact Sentinel revision;
- generated WORKS id;
- content-addressed Sentinel receipt id;
- `simplification_verdict: VERIFIED`;
- `works_projection: passed`;
- wrong-token status `401`;
- `credential_value_exposed: false`.

No credential value is printed.

## Rollback

Any failed postcondition restores the previous Sentinel source, environment and
systemd unit. If this activation created the WORKS verifier credential, the
pre-activation WORKS environment is restored and `works-api.service` is
restarted.

A pre-existing verifier credential is never rotated merely by rerunning the
activation.

## Truth boundary

The GitHub observer independently verifies exact revisions, exact successful
Actions runs, the semantic-equivalence step and canonical changed-path
ownership. The deployment does not turn the producing agent into its own
verifier.

The code-simplification skill digest is pinned to the SABI v1.1 provenance
already consumed by Runtime. Credential provisioning and service installation
remain root-authority operations and are never delegated to the generic CI
runner.

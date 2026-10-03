# Lume Frontier Testing Environment

Frontier (live-fire) testing environment for **Aftergraph/Lume** — the
ChatGPT-style streaming chat client with a self-hosted backend proxy.

This directory is the canonical frontier test pack for Lume's highest-risk
surface: the **streaming backend proxy** (SSE chat streams, upstream model
credentials, browser-facing CORS, upstream failure handling). It is portable:
copy `ops/frontier/lume/` into the Lume repository unchanged and run
`node harness/run-frontier.mjs` there. Sentinel hosts it because Sentinel owns
live-fire testing patterns and already live-reviews Lume
(`ops/deploy/poll-repos.json`); Lume remains the canonical owner of the product.

## Layout

- `record/frontier-lifecycle.record.json` — Lume frontier record conforming to
  `after-graph-governance/docs/contracts/frontier-lifecycle/1.0.json`.
  `self_promoted: false`, `carries_authority: false`.
- `scenarios/*.json` — scenario fixtures. Each names a risk class, the probe
  request, a replayed upstream response, and fail-closed expectations.
- `harness/run-frontier.mjs` — zero-dependency runner. Starts a loopback-only
  mock upstream, drives the proxy under test, applies assertions, emits a
  verdict document, exits non-zero on any FAIL or inconclusive scenario.
- `harness/reference-proxy.mjs` — reference implementation of a compliant
  streaming proxy used to prove the harness accepts good behavior.
  `--sabotage` flags inject each violation class to prove it detects bad
  behavior. It is a test double, not a product component.

## Usage

```sh
# Against a Lume proxy running locally on the loopback only
node harness/run-frontier.mjs --target http://127.0.0.1:8787

# Self-proof: the harness's reference proxy passes, and fails when sabotaged
node harness/run-frontier.mjs --self-test
node harness/run-frontier.mjs --self-test --sabotage
```

The runner binds **loopback only** (`127.0.0.1`). It never binds a public
interface and never makes outbound calls beyond the loopback upstream.

## Scenario risk classes

| class | guarded invariant |
| --- | --- |
| `secret-leak` | upstream/model credentials must never reach the client stream, headers, or error bodies |
| `sse-integrity` | streams must terminate cleanly on truncation; no silent partial deltas |
| `cors-boundary` | no wildcard origin reflection with credentials; explicit allowlist |
| `upstream-failure` | upstream 5xx/timeouts surface as explicit errors, not empty 200 streams |
| `content-type` | chat stream responses declare an event-stream/JSON content type |

Fail-closed: any scenario that cannot reach a conclusion (connection refused,
ambiguous bytes) is recorded INCONCLUSIVE and the run exits non-zero.

## Record maintenance

The frontier record must be updated only by the canonical owner with
independent verification; `self_promoted` must remain `false` until
promotion per `frontier-lifecycle/1.0`.

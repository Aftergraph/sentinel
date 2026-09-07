import { parseDiff } from './_diff-parse.js';

// Provider-prefixed API tokens are binary signals: a fixed provider prefix
// plus a fixed token shape. Generic entropy scanners are excluded by design
// (rulepack header) — this rule fires ONLY on exact provider grammars, so a
// random hex string or a bare `password = '...'` never matches.
//
// Scope notes:
// - `sk-test-*` (Stripe test mode) is OUT: low blast radius, high FP rate in
//   test suites. Only `sk-live-*` fires.
// - Example/placeholder markers are the escape hatch: official docs use
//   `AKIAIOSFODNN7EXAMPLE`, Stripe docs use `sk_test_4eC39Hq...`; both hit
//   the hatch (EXAMPLE marker / sk-test prefix).
// - PEM blocks stay with no-private-key-in-diff (different material class).
const TOKEN_RES = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[0-9A-Za-z]{36}\b/, // GitHub classic personal access token
  /\bgho_[0-9A-Za-z]{36}\b/, // GitHub OAuth access token
  /\bgithub_pat_[0-9A-Za-z_]{82}\b/, // GitHub fine-grained personal access token
  /\bsk-live-[0-9A-Za-z]{16,}\b/, // Stripe live secret key
  /\bxox[baprs]-[0-9A-Za-z-]+\b/, // Slack token (bot/app/user/refresh)
  /\bAIza[0-9A-Za-z-_]{35}\b/, // Google API key
];

// Official example values and obvious placeholders must never fire.
const EXAMPLE_RE = /example|sample|fake|dummy|placeholder|your[_-]?key|test[_-]?key|xxx+|\.\.\.|<[^>]*>/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    for (const added of f.addedLines) {
      const text = added.text;
      if (EXAMPLE_RE.test(text)) continue;
      for (const re of TOKEN_RES) {
        if (re.test(text)) {
          findings.push({
            ruleId: 'no-hardcoded-api-token-in-diff',
            file: f.path,
            line: added.line,
            evidence: `provider-prefixed API token added (${re.source.slice(0, 24)}…)`
          });
          break;
        }
      }
    }
  }
  return findings;
}

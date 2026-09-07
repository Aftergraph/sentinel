import { parseDiff } from './_diff-parse.js';

// Containers shipping without a readiness or liveness probe receive
// production traffic (or stay in rotation) before they can serve it —
// new instances must prove health before the traffic shift
// (precision-audit gap #10).
//
// Lockfile-shaped same-diff check (not cross-repo absence): a workload
// manifest that ADDS a container image but adds NO probe key in the same
// file's added lines fires. Probes defined in the same change are the
// escape hatch. Scoped out: test/spec/fixture files, Helm templates and
// charts (values-templated probes are invisible to a diff regex), and
// non-serving kinds (Job/CronJob never take traffic).
const YAML_PATH_RE = /\.(ya?ml)$/i;
const SKIP_PATH_RE = /test|spec|__tests__|fixture|template|chart|values\.ya?ml$|compose|\.github\/workflows/i;
const NON_SERVING_KIND_RE = /kind:\s*(Job|CronJob)\s*(#.*)?$/;
const IMAGE_RE = /image:\s*\S+/;
const PROBE_RE = /(readinessProbe|livenessProbe)\s*:/;
// Full-line YAML comments are neither code nor evidence: a commented
// `image:` must not fire, and a commented probe must not silence
// (adversarial wave-20: `# readinessProbe: TODO` is not a probe).
const COMMENT_RE = /^\s*#/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!YAML_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    if (f.addedLines.length === 0) continue;
    const code = f.addedLines.filter((l) => !COMMENT_RE.test(l.text));
    if (code.some((l) => NON_SERVING_KIND_RE.test(l.text))) continue;
    if (code.some((l) => PROBE_RE.test(l.text))) continue;
    for (const added of code) {
      if (!IMAGE_RE.test(added.text)) continue;
      findings.push({
        ruleId: 'require-health-check-before-traffic-shift',
        file: f.path,
        line: added.line,
        evidence: added.text.trim()
      });
    }
  }
  return findings;
}

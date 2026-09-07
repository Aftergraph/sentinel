import { parseDiff } from './_diff-parse.js';

// A Deployment that runs a single replica with a Recreate strategy takes
// guaranteed downtime on every rollout: the lone pod is killed before its
// replacement starts. Either setting alone is legitimate (singletons,
// queues, dev cost-saving — precision-audit gap #9 stays out for each in
// isolation), but the COMBINATION in one manifest is a binary downtime
// signal: no replicas to absorb the kill, no rolling update to overlap it.
//
// Same-file added-lines formulation (not cross-repo absence): a workload
// manifest that ADDS `replicas: 1` and ADDS a Recreate strategy in the same
// file's added lines fires. Either key already present before the diff is
// the escape hatch (pre-existing topology, not this change). Scoped out:
// test/spec/fixture files, dev/staging-named paths, Helm templates and
// charts (values-templated replicas are invisible to a diff regex),
// non-serving kinds (Job/CronJob never roll), and full-line YAML comments
// (a commented `replicas: 1` is not a replica).
const YAML_PATH_RE = /\.(ya?ml)$/i;
const SKIP_PATH_RE = /test|spec|__tests__|fixture|template|chart|values\.ya?ml$|compose|\.github\/workflows|dev[-_./]|staging[-_./]/i;
const NON_SERVING_KIND_RE = /kind\s*:\s*(Job|CronJob)\s*(#.*)?$/;
const REPLICAS_ONE_RE = /replicas\s*:\s*1\s*(#.*)?$/;
const RECREATE_TYPE_RE = /type\s*:\s*Recreate\s*(#.*)?$/;
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
    const hasReplicasOne = code.some((l) => REPLICAS_ONE_RE.test(l.text));
    const hasRecreate = code.some((l) => RECREATE_TYPE_RE.test(l.text));
    if (!hasReplicasOne || !hasRecreate) continue;
    for (const added of code) {
      if (!RECREATE_TYPE_RE.test(added.text)) continue;
      findings.push({
        ruleId: 'no-recreate-single-replica-deployment',
        file: f.path,
        line: added.line,
        evidence: added.text.trim()
      });
    }
  }
  return findings;
}

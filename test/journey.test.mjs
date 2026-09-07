// Full-journey E2E: finding → plan → run → evidence → CONFIRMED →
// policy → verdict → check-run wiring (zero-dep, no network).
//
// Uses a real fixture git repo in a tmpdir (one committed file containing
// `eval(`) and tiny `node -e` probes that genuinely PASS on that fixture.
// Field-compatibility spine asserted throughout: finding.id, targetSha /
// headSha, and the pinned policyVersion must flow through every module
// unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { createFinding, setAiConfidence, transition } from '../lib/finding.js';
import { CHECK_TYPES, planChecks } from '../lib/verify.js';
import { executePipeline } from '../lib/pipeline.js';
import { evaluatePolicy, parsePolicy, policyVersion } from '../lib/policy.js';
import { computeVerdict } from '../lib/review.js';
import { postCheck } from '../apps/github/checks.js';
import { handleInstallation, selectRepo } from '../apps/github/store.js';

const RULE_ID = 'no-eval-with-dynamic-input';
const REPO = 'acme/web';
const KNOWN_CHECKS = new Set(CHECK_TYPES);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Two-commit fixture: base commit + head commit carrying the eval( sink.
// Returns real git SHAs so head/base below are genuine 40-hex SHAs.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-journey-repo-'));
  git(['init'], dir);
  git(['config', 'user.email', 'journey@test.t'], dir);
  git(['config', 'user.name', 'journey'], dir);
  writeFileSync(join(dir, 'README.md'), '# journey fixture\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'base'], dir);
  const baseSha = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'app.js'), 'const result = eval(userInput);\nmodule.exports = result;\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'add eval sink'], dir);
  const headSha = git(['rev-parse', 'HEAD'], dir);
  assert.match(headSha, /^[0-9a-f]{40}$/);
  return { dir, baseSha, headSha, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

function baseEnv(extra = {}) {
  return { PATH: process.env.PATH, ...extra };
}

// Real tiny probes executed inside the runner's isolated repo copy
// (cwd = workDir): each must genuinely PASS on the fixture above.
function probeFor(type) {
  switch (type) {
    case 'STATIC_ANALYSIS':
      return [process.execPath, '-e', "const s=require('fs').readFileSync('app.js','utf8');if(!s.includes('eval('))process.exit(1);"];
    case 'SECRET_SCAN':
      return [process.execPath, '-e', "const s=require('fs').readFileSync('app.js','utf8');if(s.includes('PRIVATE KEY'))process.exit(1);"];
    default:
      return [process.execPath, '-e', 'process.exit(0)'];
  }
}

// Repo-wide policy doc (scope.repo set, empty paths = whole repo).
function policyYaml(name, required) {
  return [
    'apiVersion: sentinel.aftergraph/v1',
    'kind: VerificationPolicy',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  scope:',
    `    repo: ${REPO}`,
    '    paths: []',
    '  required:',
    ...required.map((r) => `    - ${r}`),
    '  blocking_severity:',
    '    - security',
    '  approvals:',
    '    required: []',
    '',
  ].join('\n');
}

function setupInstall(dir) {
  const storePath = join(dir, 'installations.json');
  handleInstallation(
    { action: 'created', installation: { id: 4242, account: { login: 'acme' } }, repositories: [] },
    { storePath },
  );
  selectRepo(4242, REPO, { storePath });
  return { storePath };
}

function makeFakeApi() {
  const calls = { creates: [], updates: [] };
  let nextId = 500;
  return {
    calls,
    async createCheckRun(params) {
      calls.creates.push(params);
      return { id: nextId++ };
    },
    async updateCheckRun(id, params) {
      calls.updates.push({ id, params });
      return { id };
    },
  };
}

function mkFinding(headSha) {
  return createFinding({
    ruleId: RULE_ID,
    file: 'app.js',
    line: 1,
    evidence: 'eval(userInput) reaches eval sink',
    targetSha: headSha,
  });
}

test('journey: finding → plan → run → evidence → CONFIRMED → policy → verdict → check-run (SHIP)', async () => {
  const repo = makeRepo();
  const storeDir = mkdtempSync(join(tmpdir(), 'sentinel-journey-store-'));
  const { storePath } = setupInstall(storeDir);
  clear(); // isolate the journey audit chain (install events predate it)
  try {
    // finding: HYPOTHESIS; aiConfidence set by the 'ai' actor changes
    // confidence only — never verification_state.
    const finding = mkFinding(repo.headSha);
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.equal(finding.targetSha, repo.headSha);
    setAiConfidence(finding, 0.85, 'ai');
    assert.equal(finding.aiConfidence, 0.85);
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.throws(() => transition(finding, 'VERIFYING', { actor: 'ai' }), /actor 'ai'/);

    // plan: deterministic table, non-empty.
    const plan = planChecks(finding);
    assert.ok(Array.isArray(plan) && plan.length > 0, 'plan must be non-empty');
    for (const t of plan) assert.ok(KNOWN_CHECKS.has(t), `planned check ${t} must be a known check type`);
    assert.ok(plan.includes('STATIC_ANALYSIS'), 'eval rule must plan STATIC_ANALYSIS');

    // run: every planned check executes a real probe and PASSes.
    const commands = Object.fromEntries(plan.map((t) => [t, { command: probeFor(t) }]));
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.headSha,
      commands,
      env: baseEnv(),
      policy: null,
    });
    assert.equal(out.run.status, 'PASS');
    assert.deepEqual(out.run.checks.map((c) => c.type), plan);
    assert.equal(out.run.findingId, finding.id); // id flows run-ward unchanged
    assert.equal(out.run.targetSha, repo.headSha); // SHA flows run-ward unchanged
    assert.equal(finding.verification_state, 'CONFIRMED');

    // evidence: sealed, content-addressed, pinned to the same SHA.
    assert.equal(out.evidence.length, plan.length);
    for (const ev of out.evidence) {
      assert.ok(Object.isFrozen(ev));
      assert.match(ev.id, /^[0-9a-f]{64}$/);
      assert.equal(ev.id, ev.outputHash);
      assert.equal(ev.targetSha, repo.headSha);
      assert.equal(ev.targetSha, finding.targetSha);
    }
    assert.deepEqual(finding.evidenceRefs, out.evidence.map((e) => e.id));

    // policy: repo-wide gate whose required set IS the verify plan, fed
    // the run's own check list — SHIP with a pinned version.
    const policy = parsePolicy(policyYaml('journey-default', plan));
    assert.match(policy.policyVersion, /^journey-default@[0-9a-f]{16}$/);
    const evalRes = evaluatePolicy(
      policy,
      { findings: [], checks: out.run.checks, headSha: repo.headSha },
    );
    assert.equal(evalRes.verdict, 'SHIP');
    assert.equal(evalRes.allowed, true);
    assert.equal(evalRes.policyVersion, policy.policyVersion);
    assert.equal(evalRes.policyVersion, policyVersion(policy));

    // verdict: rule SHIP + policy SHIP → SHIP, evaluation attached.
    const meta = {
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      policy: { policies: [policy], repo: REPO, path: 'app.js', checks: out.run.checks },
    };
    const result = computeVerdict([], new Set(), meta);
    assert.equal(result.verdict, 'SHIP');
    assert.equal(result.headSha, repo.headSha);
    assert.equal(result.policyEvaluation.verdict, 'SHIP');
    assert.equal(result.policyEvaluation.policyVersion, policy.policyVersion);
    assert.ok(Array.isArray(result.policyEvaluation.reasons) && result.policyEvaluation.reasons.length > 0);

    // check-run: one createCheckRun, conclusion success, exact head_sha.
    const api = makeFakeApi();
    const posted = await postCheck(
      {
        api,
        repo: REPO,
        prNumber: 7,
        headSha: repo.headSha,
        verdict: result.verdict,
        findings: [{ ruleId: finding.ruleId, file: finding.file, line: finding.line, evidence: finding.evidence }],
      },
      { storePath },
    );
    assert.equal(posted.action, 'created');
    assert.equal(posted.conclusion, 'success');
    assert.equal(api.calls.creates.length, 1);
    assert.equal(api.calls.updates.length, 0);
    const created = api.calls.creates[0];
    assert.equal(created.name, 'sentinel/review');
    assert.equal(created.head_sha, repo.headSha);
    assert.equal(created.head_sha, finding.targetSha);
    assert.equal(created.status, 'completed');
    assert.equal(created.conclusion, 'success');
    assert.ok(created.output.text.includes(RULE_ID));

    // audit: ordered chain across every module.
    const types = list().map((e) => e.type);
    const chain = ['create', 'verify_plan', 'verify_start', 'runner_start', 'runner_complete', 'verify_complete', 'policy.evaluated', 'check.created'];
    let cursor = -1;
    for (const t of chain) {
      const idx = types.indexOf(t, cursor + 1);
      assert.ok(idx > cursor, `expected audit ${t} after position ${cursor} (got ${types.join(',')})`);
      cursor = idx;
    }
    for (const t of ['transition', 'evidence', 'runner_check']) {
      assert.ok(types.includes(t), `missing audit event ${t}`);
    }
    const seqs = list().map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'audit seq must be strictly increasing');
    const createdEv = list().find((e) => e.type === 'create');
    assert.equal(createdEv.findingId, finding.id);
    const done = list().find((e) => e.type === 'verify_complete');
    assert.equal(done.findingId, finding.id);
    assert.equal(done.to, 'PASS');
    assert.equal(done.reason, 'CONFIRMED');
    const checkEv = list().find((e) => e.type === 'check.created');
    assert.equal(checkEv.to, repo.headSha);
  } finally {
    repo.cleanup();
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('journey: omitted required check → BLOCKED (not SHIP)', async () => {
  const repo = makeRepo();
  clear();
  try {
    const finding = mkFinding(repo.headSha);
    const plan = planChecks(finding);
    assert.ok(plan.length > 0);
    const commands = Object.fromEntries(plan.map((t) => [t, { command: probeFor(t) }]));
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.headSha,
      commands,
      env: baseEnv(),
      policy: null,
    });
    assert.equal(out.run.status, 'PASS');
    assert.equal(finding.verification_state, 'CONFIRMED');

    // Gate demands CONTRACT_TEST, which the run deliberately never produced.
    const gated = parsePolicy(policyYaml('journey-gated', [...plan, 'CONTRACT_TEST']));
    const res = evaluatePolicy(
      gated,
      {
        findings: [{ ruleId: finding.ruleId, file: finding.file, line: finding.line, evidence: finding.evidence }],
        checks: out.run.checks,
        headSha: repo.headSha,
      },
    );
    assert.equal(res.verdict, 'BLOCKED');
    assert.equal(res.allowed, false);
    assert.notEqual(res.verdict, 'SHIP');
    assert.ok(res.reasons.some((r) => r.includes('CONTRACT_TEST')), JSON.stringify(res.reasons));
    assert.equal(res.policyVersion, gated.policyVersion);

    // The BLOCKED gate escalates through computeVerdict as well.
    const result = computeVerdict([], new Set(), {
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      policy: { policies: [gated], repo: REPO, path: 'app.js', checks: out.run.checks },
    });
    assert.equal(result.policyEvaluation.verdict, 'BLOCKED');
    assert.equal(result.policyEvaluation.policyVersion, gated.policyVersion);
    assert.equal(result.verdict, 'BLOCKED');
    assert.notEqual(result.verdict, 'SHIP');
  } finally {
    repo.cleanup();
  }
});

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clear } from '../lib/audit.js';
import { createFinding } from '../lib/finding.js';
import { executePipeline } from '../lib/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-study015-'));
  git(['init'], dir);
  git(['config', 'user.email', 'study015@aftergraph.dev'], dir);
  git(['config', 'user.name', 'STUDY-015'], dir);
  writeFileSync(path.join(dir, 'proof.txt'), 'study015\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'study015 fixture'], dir);
  return {
    dir,
    sha: git(['rev-parse', 'HEAD'], dir),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function nodeEval(js) {
  return [process.execPath, '-e', js];
}

async function runProbe() {
  clear();
  const repo = makeRepo();
  const marker = path.join(os.tmpdir(), `sentinel-study015-mismatch-${process.pid}.txt`);
  try {
    const finding = createFinding({
      ruleId: 'study015-exact-head',
      file: 'proof.txt',
      line: 1,
      evidence: 'study015',
      targetSha: repo.sha,
    });
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands: {
        BUILD: { command: nodeEval('process.exit(0)') },
        TEST: { command: nodeEval('process.exit(0)') },
      },
      env: { PATH: process.env.PATH },
      policy: { checks: ['BUILD', 'TEST'] },
    });
    if (out.run.status !== 'PASS' || finding.verification_state !== 'CONFIRMED') {
      throw new Error('happy-path verification did not confirm');
    }
    if (out.evidence.length !== 2 || out.evidence.some((ev) => ev.targetSha !== repo.sha)) {
      throw new Error('sealed evidence was not bound to exact target SHA');
    }

    const wrongSha = 'f'.repeat(40);
    const mismatchFinding = createFinding({
      ruleId: 'study015-exact-head',
      file: 'proof.txt',
      line: 1,
      evidence: 'mismatch must not execute',
      targetSha: wrongSha,
    });
    let mismatchCode = null;
    try {
      await executePipeline({
        finding: mismatchFinding,
        repoDir: repo.dir,
        targetSha: wrongSha,
        commands: {
          TEST: {
            command: nodeEval(
              `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
            ),
          },
        },
        env: { PATH: process.env.PATH },
        policy: { checks: ['TEST'] },
      });
    } catch (error) {
      mismatchCode = error?.code ?? null;
    }
    if (mismatchCode !== 'INVALID_VERIFICATION') {
      throw new Error(`SHA mismatch did not fail with INVALID_VERIFICATION: ${mismatchCode}`);
    }
    if (existsSync(marker)) {
      throw new Error('verification command executed despite target SHA mismatch');
    }
    if (mismatchFinding.verification_state !== 'HYPOTHESIS') {
      throw new Error('SHA mismatch mutated finding state');
    }

    let zeroEvidenceBlocked = false;
    try {
      await executePipeline({
        finding: createFinding({
          ruleId: 'study015-zero-evidence',
          file: 'proof.txt',
          targetSha: repo.sha,
        }),
        repoDir: repo.dir,
        targetSha: repo.sha,
        commands: { BUILD: { command: nodeEval('process.exit(0)') } },
        env: { PATH: process.env.PATH },
        policy: { checks: [] },
      });
    } catch (error) {
      zeroEvidenceBlocked = /non-empty|empty verification plan/.test(String(error?.message ?? error));
    }
    if (!zeroEvidenceBlocked) {
      throw new Error('zero-evidence verification was not blocked');
    }

    return {
      schema: 'study015.probe/1.0',
      component: 'sentinel',
      source_head: git(['rev-parse', 'HEAD']),
      execution_class: 'LOCAL_IMPLEMENTATION_PROBE',
      network_used: false,
      mechanisms: {
        independent_verification_pipeline: true,
        exact_subject_sha_binding: true,
        sealed_evidence: true,
        sha_mismatch_fails_before_execution: true,
        zero_evidence_cannot_confirm: true,
      },
      observations: {
        verified_target_sha: repo.sha,
        verification_state: finding.verification_state,
        evidence_count: out.evidence.length,
        mismatch_error_code: mismatchCode,
        mismatch_command_executed: existsSync(marker),
        zero_evidence_blocked: zeroEvidenceBlocked,
      },
    };
  } finally {
    if (existsSync(marker)) rmSync(marker, { force: true });
    repo.cleanup();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProbe()
    .then((receipt) => process.stdout.write(JSON.stringify(receipt) + '\n'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export { runProbe };

import crypto from 'node:crypto';

const TASK_IDS = ['instruction', 'code', 'json', 'constraints', 'tool'];

function parseToolArguments(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

function scoreObservation(observation) {
  const text = String(observation.outputText ?? '');
  if (observation.id === 'instruction') return text.trim() === 'AFTERGRAPH_OK';
  if (observation.id === 'code') return text.trim() === '14';
  if (observation.id === 'json') {
    try {
      const value = JSON.parse(text.trim());
      return value && value.status === 'ok' && value.count === 3 && Object.keys(value).length === 2;
    } catch { return false; }
  }
  if (observation.id === 'constraints') {
    const normalized = text.trim();
    return normalized.includes('ALPHA') && normalized.includes('BETA') && normalized.includes('GAMMA') && !normalized.includes('\n');
  }
  if (observation.id === 'tool') {
    const call = observation.toolCalls?.[0];
    const args = parseToolArguments(call);
    const name = call?.function?.name ?? call?.name;
    return name === 'lookup' && args?.repo === 'Aftergraph/model-registry' && args?.issue === 19;
  }
  throw new Error(`unknown task id: ${observation.id}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function verifyCapturedCampaign(document) {
  if (document?.campaign !== 'ling-openrouter-qualification-001') throw new Error('unexpected campaign');
  if (document?.model !== 'inclusionai/ling-3.0-flash-vl:free') throw new Error('unexpected model route');
  if (!Array.isArray(document.trials) || document.trials.length < 1) throw new Error('trials required');

  const rescored = [];
  let mismatches = 0;
  for (const [trialIndex, trial] of document.trials.entries()) {
    if (!Array.isArray(trial.results) || trial.results.length !== TASK_IDS.length) throw new Error(`trial ${trialIndex + 1}: expected five results`);
    const ids = trial.results.map((result) => result.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...TASK_IDS].sort())) throw new Error(`trial ${trialIndex + 1}: task set mismatch`);
    for (const result of trial.results) {
      const independentlyPassed = scoreObservation(result);
      if (typeof result.passed !== 'boolean') throw new Error('runner pass claim must be boolean');
      if (result.passed !== independentlyPassed) mismatches += 1;
      rescored.push({ trial: trialIndex + 1, task_id: result.id, runner_passed: result.passed, independently_passed: independentlyPassed });
    }
  }

  const independentlyPassed = rescored.filter((item) => item.independently_passed).length;
  const aggregatePassRate = independentlyPassed / rescored.length;
  const verified = mismatches === 0;
  const attestationCore = {
    verifier: 'sentinel:model-evidence-verifier:v1',
    campaign: document.campaign,
    model: document.model,
    observations: rescored.length,
    independently_passed: independentlyPassed,
    aggregate_pass_rate: aggregatePassRate,
    score_mismatches: mismatches,
    verdict: verified ? 'PASS' : 'FAIL',
    rescored,
  };
  return {
    ...attestationCore,
    attestation_sha256: crypto.createHash('sha256').update(canonicalJson(attestationCore)).digest('hex'),
  };
}
